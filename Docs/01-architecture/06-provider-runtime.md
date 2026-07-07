# 06 - Provider 与 Runtime（模型层与运行时层）

> Provider 是「模型」的抽象，Runtime 是「推理引擎」的抽象。两层分离，让模型与引擎各自独立演进。

---

## 1. 为什么要分两层

```
┌───────────────┐     ┌───────────────┐
│   Provider    │     │    Runtime    │
│  （模型抽象）  │     │ （推理引擎）   │
├───────────────┤     ├───────────────┤
│ gguf          │     │ gguf          │
│ smolvlm2      │     │ onnx          │
│ minicpm       │     │ mlx (规划中)  │
│ onnx (遗留)   │     └───────────────┘
└───────────────┘
```

> **实现状态**：M5 之后，`gguf` runtime（基于 llama.cpp 的 `llama-server` 子进程）是默认且主要的推理引擎。所有三个生产 provider（`gguf` / `smolvlm2` / `minicpm`）都委托给共享的 `LlamaServerProcess`（见 `src/providers/llama-server/process.ts`）。`onnx` runtime 仅作为遗留 Transformers.js 路径保留，不再推荐。`mlx` runtime 仍在规划中。

**问题**：如果 Provider 直接调 ONNX，会发生：
- 想换 MLX 跑 SmolVLM → 改 Provider 代码
- 想换 llama.cpp → 又改一次
- 模型与引擎耦合死

**方案**：Provider 只定义「用哪个模型、怎么预处理输入、怎么解析输出」，Runtime 只负责「把模型跑起来」。新增引擎 = 加 Runtime 插件，不改 Provider。

**当前实现**：三个 GGUF-backed provider 共享 `LlamaServerProcess`，该类封装了 `llama-server` 子进程的启动、健康检查、HTTP 推理调用、进程复用（通过 `ps` 发现已存在的实例）、以及精细化停止逻辑（自有进程 SIGTERM+SIGKILL，外部进程温和 SIGTERM）。

---

## 2. VisionProvider（模型层）

### 2.1 职责
- 声明使用哪个模型文件
- 定义输入预处理（图片转张量/编码）
- 定义输出解析（原始输出 → 文本）
- 调用 Runtime 执行推理
- **不关心**业务语义、Skill、Prompt

### 2.2 接口定义
```typescript
interface VisionProvider {
  /** Provider 标识 */
  readonly name: string;        // "gguf" | "smolvlm2" | "minicpm" | "onnx"

  /** 加载模型（由 Lifecycle Manager 调度） */
  load(): Promise<void>;

  /** 推理 */
  infer(req: InferenceRequest): Promise<InferenceResponse>;

  /** 卸载模型，释放内存 */
  unload(): Promise<void>;

  /** 是否已加载 */
  isLoaded(): boolean;

  /** 声明支持的 Runtime */
  supportedRuntimes: string[];  // ["onnx", "mlx"]

  /** 声明支持的 Skill */
  supportedSkills: string[];    // ["classify","ocr","ui"...]

  /** 资源需求 */
  requirements: {
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
}

interface InferenceResponse {
  text: string;             // 模型原始文本输出
  raw?: any;                // 原始输出（调试用）
  duration: number;         // 推理耗时
}
```

> 注意：Provider 返回的是**原始文本**，JSON 解析与 Schema 校验由 Skill 层的 Validator 负责。Provider 不做业务解析。

### 2.4 Provider 实现：SmolVLM

```
providers/gguf/
├── provider.ts         GGUFProvider — 默认 provider，委托给 LlamaServerProcess
providers/smolvlm2/
├── provider.ts         SmolVLM2Provider — 快速候选，委托给 LlamaServerProcess
providers/minicpm/
├── provider.ts         MiniCPMProvider — 高质量 provider，委托给 LlamaServerProcess
providers/llama-server/
├── process.ts          LlamaServerProcess — 共享的 llama-server 子进程管理
├── process-registry.ts 进程发现、端口分配、ps 解析
providers/onnx/         （遗留）Transformers.js provider
├── provider.ts         SmolVLMProvider（onnx runtime 版本）
```

```typescript
// providers/gguf/provider.ts （伪代码示意）
class GGUFProvider implements VisionProvider {
  readonly name = "gguf";
  readonly runtime = "gguf";
  supportedRuntimes = ["gguf"];
  supportedSkills = ["classify","ocr","ui","summary","color","moderation"];
  requirements = { minMemoryMB: 1024, gpuRequired: false, modelSizeMB: 800 };

  private server: LlamaServerProcess;

  async load() {
    const modelPath = await ensureGGUFModel();  // ~/.vision-mcp/models/ggml-org/SmolVLM-500M-Instruct-GGUF/
    this.server = new LlamaServerProcess({ modelPath, ... });
    await this.server.start();  // 复用已存在的健康实例，或启动新进程
  }

  async infer(req: InferenceRequest): Promise<InferenceResponse> {
    const res = await this.server.infer(req.image, req.prompt, req.maxTokens, req.temperature);
    return { text: res.text, duration: res.duration };
  }
}
```

---

## 3. RuntimeAdapter（运行时层）

### 3.1 职责
- 加载模型文件到内存
- 执行推理计算
- 隔离不同引擎的 API 差异（ONNX/llama.cpp/MLX/Transformers.js）
- **不关心**模型业务语义、Skill、Prompt

### 3.2 接口定义
```typescript
interface RuntimeAdapter {
  /** Runtime 标识 */
  readonly name: string;        // "onnx" | "mlx" | "llamacpp"

  /** 检测当前环境是否可用 */
  isAvailable(): Promise<boolean>;

  /** 加载模型 */
  load(modelPath: string, options?: RuntimeOptions): Promise<void>;

  /** 执行推理 */
  infer(input: RuntimeInput): Promise<RuntimeOutput>;

  /** 卸载 */
  unload(): Promise<void>;

  /** 是否已加载 */
  isLoaded(): boolean;

  /** 资源占用 */
  getMemoryUsage(): number;    // 当前占用 MB
}
```

### 3.3 Runtime 检测与选择

> **实现状态**：当前实现没有独立的 `RuntimeAdapter` 抽象层。三个 GGUF-backed provider 直接委托给共享的 `LlamaServerProcess`，它封装了 `llama-server` 子进程的所有交互。`onnx` runtime 仅作为遗留路径存在于 `SmolVLMProvider`（Transformers.js）。`MLX` runtime 尚未实现。

`llama-server` 二进制的检测顺序（见 `resolveLlamaServerPath()`）：
```
1. LLAMA_SERVER_PATH 环境变量
2. ~/.vision-mcp/bin/llama-server(.exe)
3. /opt/homebrew/bin/llama-server
4. /usr/local/bin/llama-server
5. /usr/bin/llama-server
6. PATH 中的 llama-server / llama-server.exe
```

进程复用策略：
```
启动前：
  1. findExistingLlamaServerProcess(modelPath) — 通过 ps -axo pid,command 匹配模型路径
  2. 若找到 → 检查 /health 端点 → 复用该进程的端口
  3. 若未找到 → allocateRandomFreePort() → 启动新子进程
```

> 不写入 `ports.json` 或任何持久化端口文件。端口通过进程发现管理。

### 3.4 Runtime 对比

| Runtime | 平台 | GPU | 适用 | 状态 |
|---------|------|-----|------|------|
| gguf (llama.cpp) | 全平台 | CUDA/Metal | GGUF 模型 | ✅ 默认推荐 |
| onnx (Transformers.js) | 全平台 | 无 | 遗留路径 | ⚠️ 不再推荐 |
| mlx | macOS (Apple Silicon) | Metal | 规划中 | 🔲 未实现 |

---

## 4. Provider ↔ Runtime 匹配

Provider 声明 `supportedRuntimes`，Planner/Pipeline 选择时确保匹配：

```
gguf       支持 [gguf]             — SmolVLM-500M-Instruct-Q8_0
smolvlm2   支持 [gguf]             — SmolVLM2-500M-Video-Instruct-Q8_0
minicpm    支持 [gguf]             — MiniCPM-V-2_6-Q4_K_M
onnx       支持 [onnx]（遗留）     — SmolVLM Q4_K_M (Transformers.js)

匹配规则：
  1. ProviderRouter 取 Provider.supportedRuntimes ∩ 当前可用 runtime
  2. 若多个可用，按 config/runtime.yaml preferred 选择
  3. 若都不可用 → 该 Provider 不可用 → Planner 降级
```

---

## 5. Lifecycle Manager（生命周期与资源释放）

SmolVLM-500M 加载后占用约 800MB-1GB 内存，资源释放机制是 V1 的核心保障。本节为概要，**完整设计见 [08-lifecycle-manager.md](./08-lifecycle-manager.md)**。

### 5.1 核心策略（概要）

```
启动时：       不加载任何模型（零内存占用）
首次调用：     按需 load() + 预热 warmup
空闲超时：     unload() 释放内存（默认 10 分钟）
并发请求：     引用计数，推理中不卸载
内存压力：     主动 unload 空闲模型（每 30 秒检测）
进程退出：     SIGTERM/SIGINT hook 清理全部
防抖动：       最小驻留 60 秒 + 频繁重载退避
```

### 5.2 完整状态机（6 状态）

```
Unloaded ──load()──► Loading ──成功──► Loaded
                      Loading ──失败──► Error
Loaded   ──refCount=0──► Idle
Idle     ──新请求──► Loaded（唤醒，无需重载）
Idle     ──超时/内存压力──► Unloading ──► Unloaded
```

> 竞态处理、多 Provider 释放优先级、泄漏检测等详见 [08-lifecycle-manager.md](./08-lifecycle-manager.md)

### 5.3 引用计数（概要）

```typescript
// Skill Pipeline 使用方式
const provider = await lifecycleManager.acquire(plan.provider);  // refCount++
try {
  const response = await provider.infer(req);
  return response;
} finally {
  lifecycleManager.release(plan.provider);  // refCount--，确保释放
}
```

### 5.4 配置（概要）

```yaml
# config/lifecycle.yaml  （完整配置见 08-lifecycle-manager.md §9）
lifecycle:
  idleTimeout: 600000           # 10 分钟空闲后卸载
  minDwellTime: 60000           # 加载后至少驻留 60 秒（防抖动）
  memoryThreshold: 2048         # 可用内存<2GB 时卸载空闲模型
  memoryCriticalThreshold: 1024 # 可用内存<1GB 时拒绝新请求
  memoryCheckInterval: 30000    # 内存检查间隔 30 秒
  maxConcurrent: 4              # 最大并发推理
  shutdownTimeout: 10000        # 进程退出最多等待 10 秒
  preloadOnStart: false         # 启动不预加载
```

> **决策记录**：[ADR-005](../04-decisions/ADR-005-lifecycle-strategy.md) —— 为什么选空闲超时释放而非常驻

---

## 6. 内存与资源管理

### 6.1 防止 OOM
```
推理前检查：
  if (availableMemory < provider.requirements.minMemoryMB) {
    lifecycleManager.unloadIdleProviders();   // 先释放空闲模型
    if (still not enough) throw ResourceError; // 仍不足则拒绝
  }
```

### 6.2 ONNX 原生资源释放
```typescript
// SmolVLM Provider 的 unload 必须显式释放 ONNX 会话
async unload() {
  if (this.session) {
    this.session.release();  // 必须调用，否则原生内存泄漏
    this.session = null;
  }
}
```

### 6.3 并发控制
```
maxConcurrent = 4
  → 超过并发数的请求排队等待
  → 超时则返回 BusyError
```

---

## 7. 接口契约总览

```
Skill Pipeline
     │
     ▼ InferenceRequest
┌─────────────┐
│  Provider   │  (模型抽象)
└──────┬──────┘
       │ RuntimeInput
       ▼
┌─────────────┐
│  Runtime    │  (引擎抽象)
└──────┬──────┘
       │ 执行
       ▼
    Model 文件
```

**关键不变量**：
- Provider 永远不直接 `import onnxruntime`，必须经 Runtime
- Runtime 永远不知道 Skill/Prompt 的存在
- Lifecycle Manager 管理 Provider 生命周期，但 Provider 不反向调用 Lifecycle

---

## 8. 测试要点

| 测试场景 | 预期 |
|----------|------|
| 首次调用 smolvlm2 | 自动 load，首次耗时含加载 |
| 空闲 10 分钟后调用 | 重新 load |
| 并发 5 个请求（max=4） | 4 个执行，1 个排队 |
| 内存不足 | 卸载空闲 Provider |
| Runtime 不可用 | 回退到 fallback Runtime |
| Provider 不支持该 Runtime | Planner 降级到其他 Provider |

---

## 9. 本文小结

Provider 与 Runtime 两层分离的核心要点：

1. **Provider = 模型抽象** —— 声明模型、预处理、解析，不含引擎细节
2. **Runtime = 引擎抽象** —— 加载与推理，不含业务语义
3. **Provider 不直接调引擎** —— 必须经 Runtime Adapter
4. **Lifecycle 按需加载** —— 启动零内存，首次加载，空闲回收
5. **引用计数** —— 并发复用，安全卸载
6. **资源感知** —— 防 OOM，内存不足自动降级

> **Lifecycle Manager 的完整设计（6 状态机、三种释放触发器、防抖动、泄漏检测等）详见 [08 - Lifecycle Manager](./08-lifecycle-manager.md)**
> 
> **资源释放策略决策见 [ADR-005](../04-decisions/ADR-005-lifecycle-strategy.md)**
>
> 下一篇：[07 - 模型管理](./07-model-management.md)
>
> 资源释放完整设计：[08 - Lifecycle Manager](./08-lifecycle-manager.md)
