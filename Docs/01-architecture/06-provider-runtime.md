# 06 - Provider 与 Runtime（模型层与运行时层）

> Provider 是「模型」的抽象，Runtime 是「推理引擎」的抽象。两层分离，让模型与引擎各自独立演进。

---

## 1. 为什么要分两层

```
┌───────────────────┐     ┌───────────────┐
│     Provider       │     │    Runtime    │
│   （模型抽象）     │     │ （推理引擎）   │
├───────────────────┤     ├───────────────┤
│ gguf-smolvlm       │     │ llama-cpp     │
│ gguf-smolvlm2      │     │ onnx          │
│ minicpm-v          │     │ native-ocr    │
│ smolvlm  (ONNX遗留)│     └───────────────┘
│ ppu-paddle-ocr     │
└───────────────────┘
```

> **实现状态**：M5 之后，`llama-cpp` runtime（基于 llama.cpp 的 `llama-server` 子进程）是默认且主要的推理引擎。三个 GGUF-backed provider（`gguf-smolvlm` / `gguf-smolvlm2` / `minicpm-v`）都继承共享的 `BaseLlamaCppProvider`（`src/providers/llama-server/base-provider.ts`），后者委托 `LlamaServerProcess` 管理子进程。`onnx` runtime 仅作为遗留 Transformers.js 路径保留（`smolvlm` provider），不再推荐。v0.2 新增 `ppu-paddle-ocr` OCR-only provider，runtime 标记为 `native-ocr`，**默认注册**（`VISION_OCR_PROVIDER` 默认 `'ppu-paddle-ocr'`），用于密集 OCR 和目标区域文本提取。

**问题**：如果 Provider 直接调 ONNX，会发生：
- 想换 llama.cpp -> 改 Provider 代码
- 想换 MLX -> 又改一次
- 模型与引擎耦合死

**方案**：Provider 只定义「用哪个模型、怎么预处理输入、怎么解析输出」，Runtime 只负责「把模型跑起来」。新增引擎 = 加 Runtime 插件，不改 Provider。

> **注意**：当前实现没有独立的 `RuntimeAdapter` 抽象层（§3.2 的接口为规划形态）。GGUF-backed provider 直接通过 `BaseLlamaCppProvider -> LlamaServerProcess` 与 `llama-server` 交互；`onnx` runtime 内联于 `SmolVLMProvider`。

---

## 2. VisionProvider（模型层）

### 2.1 职责
- 声明使用哪个模型文件
- 定义输入预处理（图片转张量/编码）
- 定义输出解析（原始输出 -> 文本）
- 调用 Runtime 执行推理
- **不关心**业务语义、Skill、Prompt

### 2.2 接口定义
```typescript
interface VisionProvider {
  /** Provider 标识 */
  readonly name: string;        // "gguf-smolvlm" | "gguf-smolvlm2" | "minicpm-v" | "smolvlm" | "ppu-paddle-ocr"

  /** Runtime 标识 */
  readonly runtime: string;    // "llama-cpp" | "onnx" | "native-ocr"

  /** 加载模型 */
  load(): Promise<void>;

  /** 推理 */
  infer(req: InferenceRequest): Promise<InferenceResponse>;

  /** 卸载模型，释放内存 */
  unload(): Promise<void>;

  /** 是否已加载 */
  isLoaded(): boolean;

  /** 声明支持的 Runtime */
  readonly supportedRuntimes: string[];

  /** 声明支持的 Skill */
  readonly supportedSkills: string[];

  /** 资源需求 */
  readonly requirements: {
    minMemoryMB: number;
    gpuRequired: boolean;
    modelSizeMB: number;
  };
}
```

### 2.3 InferenceRequest / InferenceResponse
```typescript
interface InferenceRequest {
  image: ImageInput;        // 归一化后的图片
  prompt: string;           // 已编译的 Prompt
  maxTokens: number;        // 输出长度限制
  temperature: number;      // 温度
  cache?: boolean;          // 是否命中 Provider 推理缓存
  signal?: AbortSignal;     // 取消信号，在途推理可被取消
}

interface InferenceResponse {
  text: string;             // 模型原始文本输出
  duration: number;         // 推理耗时
}
```

> 注意：Provider 返回的是**原始文本**，JSON 解析与 Schema 校验由 Skill 层负责。Provider 不做业务解析。`InferenceResponse` **没有** `raw` 字段；`cache?` / `signal?` 已存在于 `InferenceRequest`（见 `src/types/domain.ts`）。

### 2.4 Provider 实现

```
providers/gguf/
├── provider.ts            GGUFProvider (name='gguf-smolvlm') - fast legacy，继承 BaseLlamaCppProvider
providers/smolvlm2/
├── provider.ts            SmolVLM2Provider (name='gguf-smolvlm2') - 默认 provider，继承 BaseLlamaCppProvider
providers/minicpm/
├── provider.ts            MiniCPMProvider (name='minicpm-v') - 高质量 provider，继承 BaseLlamaCppProvider
providers/smolvlm/
├── provider.ts            SmolVLMProvider (name='smolvlm', runtime='onnx') - 遗留 Transformers.js
providers/ppu-paddle-ocr/
├── provider.ts            PpuPaddleOcrProvider (name='ppu-paddle-ocr') - OCR-only，native-ocr
├── types.ts               PaddleOCR 输出归一化类型
providers/llama-server/
├── base-provider.ts       BaseLlamaCppProvider - 共享基类（引用计数/空闲回收/内存监控/推理缓存/图像优化/流式推理/崩溃重启）
├── process.ts             LlamaServerProcess - llama-server 子进程管理 + resolveLlamaServerPath()
├── process-registry.ts    进程发现、端口分配、ps 解析
├── resolver.ts            llama-server 二进制检测候选（resolveLlamaServerCandidates）
├── downloader.ts          llama-server 自动下载/安装（GitHub releases + 镜像降级）
└── platform-detector.ts   平台/架构探测
```

```typescript
// providers/gguf/provider.ts （伪代码示意）
class GGUFProvider extends BaseLlamaCppProvider {
  constructor() {
    super({
      name: 'gguf-smolvlm',
      requirements: { minMemoryMB: 256, gpuRequired: false, modelSizeMB: 417 },
      // modelPath 由 ensureGGUFModel() 提供
    });
  }
  // load()/infer()/unload() 继承自 BaseLlamaCppProvider
}
```

#### Provider 一览

| name | class | runtime | 默认 | supportedSkills | requirements |
|------|-------|---------|------|-----------------|--------------|
| `gguf-smolvlm2` | SmolVLM2Provider | llama-cpp | **是** | 8 all | {256MB, noGPU, 500MB} |
| `gguf-smolvlm` | GGUFProvider | llama-cpp | 否 | 8 all | {256MB, noGPU, 417MB} |
| `minicpm-v` | MiniCPMProvider | llama-cpp | `VISION_HIGH_QUALITY=1` | 8 all | {4096MB, GPU, 2048MB} |
| `smolvlm` | SmolVLMProvider | onnx | 否（遗留） | classify,ocr,summary,moderation | {1024MB, noGPU, 800MB} |
| `ppu-paddle-ocr` | PpuPaddleOcrProvider | native-ocr | 默认 OCR | ocr only | native |

> 8 all = `classify, ocr, summary, table, document, poster, moderation, layout`。

---

## 3. RuntimeAdapter（运行时层，规划形态）

### 3.1 职责（规划）
- 加载模型文件到内存
- 执行推理计算
- 隔离不同引擎的 API 差异（ONNX/llama.cpp/MLX/Transformers.js）
- **不关心**模型业务语义、Skill、Prompt

### 3.2 接口定义（规划，尚未独立实现）
```typescript
interface RuntimeAdapter {
  readonly name: string;        // "onnx" | "llama-cpp" | "native-ocr"
  isAvailable(): Promise<boolean>;
  load(modelPath: string, options?: RuntimeOptions): Promise<void>;
  infer(input: RuntimeInput): Promise<RuntimeOutput>;
  unload(): Promise<void>;
  isLoaded(): boolean;
  getMemoryUsage(): number;
}
```

> 当前实现没有独立的 `RuntimeAdapter` 抽象层。三个 GGUF-backed provider 直接继承 `BaseLlamaCppProvider` 并委托 `LlamaServerProcess`，后者封装了 `llama-server` 子进程的所有交互（启动、健康检查、HTTP 推理调用、进程复用、精细化停止逻辑）。`onnx` runtime 内联于 `SmolVLMProvider`。`mlx` runtime 尚未实现。

### 3.3 llama-server 检测与选择

`llama-server` 二进制的检测顺序（`resolveLlamaServerCandidates()`，见 `src/providers/llama-server/resolver.ts:41`）：

```
1. LLAMA_SERVER_PATH 环境变量
2. <packageRoot>/bin/llama-server        ← 项目内 bin/
3. ~/.vision-mcp/bin/llama-server(.exe)
4. 系统路径：/opt/homebrew/bin、/usr/local/bin、/usr/bin
   （Windows: %LOCALAPPDATA%\llama.cpp、Programs\llama.cpp）
5. PATH 查找 llama-server / llama-server.exe
```

> 若全部未命中，运行时通过 `downloader.ts` **自动安装**：从 llama.cpp GitHub releases 下载对应平台二进制，支持 `LLAMA_DOWNLOAD_MIRROR` 镜像站降级（详见 §5.2）。

进程复用策略：
```
启动前：
  1. findExistingLlamaServerProcess(modelPath) - 通过 ps -axo pid,command 匹配模型路径
  2. 若找到 -> 检查 /health 端点 -> 复用该进程的端口
  3. 若未找到 -> allocateRandomFreePort() -> 启动新子进程
```

> 不写入 `ports.json` 或任何持久化端口文件。端口通过进程发现管理。

### 3.4 Runtime 对比

| Runtime | 平台 | GPU | 适用 | 状态 |
|---------|------|-----|------|------|
| llama-cpp (llama.cpp) | 全平台 | CUDA/Metal | GGUF 模型 | ✅ 默认推荐 |
| native-ocr | macOS/Linux/Windows（随 ppu-paddle-ocr 支持） | 不要求 | OCR-only / 中文 UI 截图 / 目标区域 OCR | ✅ 默认 OCR |
| onnx (Transformers.js) | 全平台 | 无 | 遗留路径 | ⚠️ 不再推荐 |
| mlx | macOS (Apple Silicon) | Metal | 规划中 | 🔲 未实现 |

---

## 4. Provider ↔ Runtime 匹配

Provider 声明 `supportedRuntimes`，Planner/Pipeline 选择时确保匹配：

```
gguf-smolvlm   支持 [llama-cpp]   - SmolVLM-500M-Instruct-Q8_0
gguf-smolvlm2  支持 [llama-cpp]   - SmolVLM2-500M-Video-Instruct-Q4_K_M
minicpm-v      支持 [llama-cpp]   - MiniCPM-V-2_6-Q4_K_M
smolvlm        支持 [onnx]（遗留）- SmolVLM (Transformers.js)
ppu-paddle-ocr 支持 [native-ocr]  - OCR-only，默认注册（VISION_OCR_PROVIDER 默认 'ppu-paddle-ocr'）

匹配规则：
  1. ProviderRouter 根据 requestedSkills / quality / resources 过滤候选
  2. OCR-only 请求优先 exact skill fit，路由到 ppu-paddle-ocr
  3. mixed OCR 请求保持 VLM 主 Provider，OCR 通过 per-skill override 交给专用 OCR Provider
  4. 显式 options.provider 不可行时返回错误，不静默 fallback
```

### 4.1 Dedicated OCR Provider

`PpuPaddleOcrProvider` 的设计边界：

- `supportedSkills = ['ocr']`，不负责分类/摘要/视觉推理。
- `runtime = 'native-ocr'`，通过 `PaddleOcrService` 识别图片文字。
- 初始化与识别期间将第三方库的 stdout 日志重定向到 stderr，保持 MCP stdio JSON-RPC 干净。
- 并发 `load()` 使用 `loadPromise` 串行化，避免重复初始化 native OCR service。
- OCR 输出归一化为 `{ texts: [{ text, position, confidence }], language }`，供 `ocr` skill schema、UI composer 和 key-content extractor 复用。

---

## 5. 生命周期与资源释放

> **实现状态**：当前**没有独立的 `LifecycleManager` 类，也没有 `lifecycle.yaml`**。生命周期逻辑全部内嵌于 `BaseLlamaCppProvider`（`src/providers/llama-server/base-provider.ts`）。本节描述实际实现；§5.4 的 `RuntimeAdapter`/`LifecycleManager` 配置形态为规划，未落地。原始独立设计见 [08-lifecycle-manager.md](./08-lifecycle-manager.md)（已部分被内嵌实现取代）。

### 5.1 BaseLlamaCppProvider 核心能力

GGUF-backed provider 共享以下机制：

- **引用计数**（`refCount` acquire/release）：推理中不卸载，并发复用安全。
- **空闲定时器**（`idleTimer`）：`refCount=0` 后 600000ms（10 分钟）触发 `unload()`。
- **内存监控**（`memoryTimer`，30000ms 间隔）：低内存时卸载空闲 provider —— **仅 warn，不拒绝新请求**（无 reject-on-low-memory）。
- **load/spawn/unload 去重**：`loadPromise` / `spawnPromise` / `unloadPromise` 去重并发冷加载、崩溃重启、卸载，避免启动两个 llama-server。
- **Provider 级推理缓存**：`Map`，TTL 1 小时，LRU 100 条，key = `imgHash:promptHash:paramsHash`。
- **图像优化**：经 `sharp` 预处理（resize、JPEG quality）。
- **GPU 层/线程计算**：依据 `HardwareProfile` 调整 `--n-gpu-layers` / `--threads`。
- **流式推理**：`streamInfer` async generator。
- **崩溃重启**：`llama-server` 意外退出时自动 respawn。

```
启动时：       不加载任何模型（零内存占用）
首次调用：     按需 load() + spawn llama-server
空闲超时：     unload() 释放内存（硬编码 600000ms / 10 分钟）
并发请求：     引用计数，推理中不卸载
内存压力：     主动 unload 空闲 provider（每 30000ms 检测，仅告警）
进程退出：     SIGTERM/SIGKILL hook 清理
```

> 硬编码值：`idle=600000ms`、`memoryMonitor=30000ms`。**无** `minDwellTime`、**无** reject-on-low-memory、**无** `shutdownTimeout`、**无** `preloadOnStart`。`ProviderState` 类型存在于 `domain.ts`，但 base provider 不显式维护 state 字段。

### 5.2 llama-server 自动安装

首次运行时若检测不到 `llama-server`，`downloader.ts` 自动从 llama.cpp GitHub releases 下载对应平台二进制，并支持镜像站降级：

- 环境变量 `LLAMA_DOWNLOAD_MIRROR`：指定镜像 URL 前缀，GitHub 不可达时回退。
- `LLAMA_SERVER_PATH`：可显式指定已有二进制路径，跳过下载。
- `pnpm setup:llama`：显式触发检测/准备，依次检查 `LLAMA_SERVER_PATH`、`~/.vision-mcp/bin/llama-server`、系统/Homebrew 路径、PATH。

### 5.3 引用计数用法

```typescript
// Provider acquire/release 由 Skill Pipeline 驱动
provider.acquire?.();        // refCount++
try {
  const response = await provider.infer(req);
  return response;
} finally {
  provider.release?.();      // refCount--，归零后启动空闲定时器
}
```

### 5.4 配置形态（规划，未实现）

> 以下 `RuntimeAdapter` 抽象与 `lifecycle.yaml` 为规划形态，**当前未实现**。实际值硬编码于 `BaseLlamaCppProvider`（见 §5.1）。

```yaml
# config/lifecycle.yaml （规划，当前不存在）
lifecycle:
  idleTimeout: 600000           # 10 分钟空闲后卸载（实际硬编码）
  memoryCheckInterval: 30000    # 内存检查间隔 30 秒（实际硬编码）
  maxConcurrent: 4              # 最大并发推理（实际由 vision-analyze 的 Semaphore 实现）
```

> **决策记录**：[ADR-005](../04-decisions/ADR-005-lifecycle-strategy.md) -- 为什么选空闲超时释放而非常驻

---

## 6. 内存与资源管理

### 6.1 防止 OOM
```
推理前检查：
  if (availableMemory < provider.requirements.minMemoryMB) {
    baseProvider 内存监控会 unloadIdleProviders();   // 仅告警，不拒绝
  }
```

### 6.2 ONNX 原生资源释放
```typescript
// SmolVLMProvider (onnx) 的 unload 必须显式释放 ONNX 会话
async unload() {
  if (this.session) {
    this.session.release();  // 必须调用，否则原生内存泄漏
    this.session = null;
  }
}
```

### 6.3 并发控制
```
maxConcurrent = 4（Semaphore，见 vision-analyze.ts）
  -> 超过并发数的请求排队等待
  -> 不会返回 BusyError，请求会等待空位
```

---

## 7. 接口契约总览

```
Skill Pipeline
     │
     ▼ InferenceRequest (含 cache?/signal?)
┌─────────────┐
│  Provider   │  (模型抽象，含 runtime 标识)
└──────┬──────┘
       │ 委托 BaseLlamaCppProvider / LlamaServerProcess
       ▼
┌─────────────┐
│  Runtime    │  (llama-server 子进程 / ONNX / native-ocr)
└──────┬──────┘
       │ 执行
       ▼
     Model 文件
```

**关键不变量**：
- Provider 永远不直接 `import onnxruntime`，资源释放封装在 provider 内
- Runtime 层不知道 Skill/Prompt 的存在
- 生命周期由 `BaseLlamaCppProvider` 内嵌管理，Provider 不反向调用独立 LifecycleManager（不存在）

---

## 8. 测试要点

| 测试场景 | 预期 |
|----------|------|
| 首次调用 gguf-smolvlm2 | 自动 load + spawn llama-server（或复用已有实例），首次耗时含加载 |
| 空闲 10 分钟后调用 | 重新 load |
| 并发 5 个请求（max=4） | 4 个执行，1 个**排队等待**（不报错） |
| 内存不足 | 卸载空闲 Provider（仅告警，不拒绝） |
| llama-server 二进制缺失 | 自动下载安装（或 `LLAMA_DOWNLOAD_MIRROR` 降级） |
| Provider 不支持该 Skill | Router 筛选掉，降级到其他 Provider |

---

## 9. 本文小结

Provider 与 Runtime 两层分离的核心要点：

1. **Provider = 模型抽象** -- 声明模型、预处理、解析，含 `runtime` 标识
2. **Runtime = 引擎抽象** -- 加载与推理，不含业务语义（当前未独立成层，内嵌于 provider）
3. **GGUF provider 共享 `BaseLlamaCppProvider`** -- 引用计数/空闲回收/内存监控/推理缓存/崩溃重启
4. **生命周期内嵌** -- 无独立 LifecycleManager，硬编码于 BaseLlamaCppProvider
5. **引用计数** -- 并发复用，安全卸载
6. **资源感知** -- 防 OOM，内存不足仅告警；并发超限排队等待而非报错
7. **自动就绪** -- `llama-server` 缺失时自动下载（`LLAMA_DOWNLOAD_MIRROR` 降级）

> **独立 LifecycleManager 的原始设计见 [08 - Lifecycle Manager](./08-lifecycle-manager.md)（部分已被内嵌实现取代）**
>
> **资源释放策略决策见 [ADR-005](../04-decisions/ADR-005-lifecycle-strategy.md)**
>
> 下一篇：[07 - 模型管理](./07-model-management.md)
