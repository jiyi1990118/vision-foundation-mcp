# 07 - 模型管理（Model Management）

> Model Manager 负责模型的下载、校验、缓存、版本与升级。让用户「首次调用自动就绪」，无需手动下载模型。

> ⚠️ **实现状态**：本文档混合了「规划形态」与「已实现」。`src/core/model-manager.ts` 导出三个 ensure 函数：`ensureGGUFModel()` / `ensureSmolVLM2Model()` / `ensureMiniCPMModel()`，从 HuggingFace 下载 GGUF 文件到 `~/.vision-mcp/models/`。**已实现**：HTTP Range 断点续传、SHA-256 校验（`VISION_VERIFY_CHECKSUMS=1`）、原子 `.tmp-<pid>` -> rename、`.meta.json` sidecar、`LLAMA_DOWNLOAD_MIRROR` 镜像降级、孤立 `.tmp-*` 清理。**未实现（仍为规划）**：`manifest.json` 清单、分片并发下载、版本管理/多版本共存/升级、`config/providers.yaml`、通用 `ModelManager` / `CacheManager` 接口。下文对未实现部分标注「（规划，未实现）」。
>
> 实际 provider 列表：`gguf-smolvlm2`（默认）/ `gguf-smolvlm` / `minicpm-v`（高质量），外加 `smolvlm`（ONNX 遗留）与 `ppu-paddle-ocr`（OCR-only）。模型路径见下方 §2。

---

## 1. 设计目标

| 目标 | 说明 | 状态 |
|------|------|------|
| 自动就绪 | 首次调用自动下载，无需手动操作 | ✅ 已实现 |
| 完整性校验 | SHA256 校验，防损坏/篡改 | ✅ 已实现（`VISION_VERIFY_CHECKSUMS=1`） |
| 本地缓存 | 下载一次，反复使用 | ✅ 已实现 |
| 版本管理 | 支持多版本共存与切换 | 🔲 规划，未实现 |
| 断点续传 | 大模型下载支持断点续传 | ✅ 已实现（HTTP Range） |

---

## 2. 模型目录结构

实际目录结构（GGUF 模型按 `<org>/<repo>-GGUF/` 组织，配 `.meta.json` sidecar）：

```
~/.vision-mcp/
└── models/
    ├── ggml-org/
    │   ├── SmolVLM-500M-Instruct-GGUF/
    │   │   ├── SmolVLM-500M-Instruct-Q8_0.gguf       模型文件（gguf-smolvlm）
    │   │   ├── mmproj-SmolVLM-500M-Instruct-Q8_0.gguf 视觉投影
    │   │   └── SmolVLM-500M-Instruct-Q8_0.gguf.meta.json  sidecar
    │   └── SmolVLM2-500M-Video-Instruct-GGUF/
    │       ├── SmolVLM2-500M-Video-Instruct-Q4_K_M.gguf      模型文件（gguf-smolvlm2，默认）
    │       ├── mmproj-SmolVLM2-500M-Video-Instruct-Q8_0.gguf 视觉投影
    │       └── *.meta.json                                    sidecar
    └── bartowski/
        └── MiniCPM-V-2_6-GGUF/
            ├── MiniCPM-V-2_6-Q4_K_M.gguf       模型文件（minicpm-v）
            ├── mmproj-*.gguf                   视觉投影
            └── *.meta.json                      sidecar
```

> SmolVLM2 / MiniCPM 需同时具备主模型与 `mmproj` 投影文件，缺失时 `ensureSmolVLM2Model()` / `ensureMiniCPMModel()` 可按需下载。

### .meta.json（sidecar，已实现）

每个下载完成的模型文件附带同名 `.meta.json`，记录校验信息：

```json
{
  "sha256": "a1b2c3d4...",
  "size": 417000000,
  "url": "https://huggingface.co/ggml-org/SmolVLM-500M-Instruct-GGUF/resolve/main/SmolVLM-500M-Instruct-Q8_0.gguf",
  "downloadedAt": "2025-07-16T00:00:00Z"
}
```

`VISION_VERIFY_CHECKSUMS=1` 时，load 前比对 `.meta.json` 中的 `sha256`；不匹配则删除并重新下载（自动修复损坏）。

---

## 3. 模型注册表（规划，未实现）

> 当前模型源 URL 与 sha256 硬编码于 `src/core/model-manager.ts` 各 ensure 函数内，**没有** `config/providers.yaml`。以下为规划形态。

所有可用模型在配置中声明：

```yaml
# config/providers.yaml （规划，当前不存在）
providers:
  - name: smolvlm
    models:
      - quantization: Q4_K_M
        version: "1.0.0"
        url: "https://models.vision-mcp.org/smolvlm/Q4_K_M/"
        size: 800MB
        sha256: "a1b2c3d4..."
        default: true            # 默认使用此量化
      - quantization: FP16
        version: "1.0.0"
        url: "https://models.vision-mcp.org/smolvlm/FP16/"
        size: 1.8GB
        sha256: "i9j0k1l2..."

  - name: qwen2.5-vl
    models:
      - quantization: Q4_K_M
        version: "1.0.0"
        url: "https://models.vision-mcp.org/qwen2.5-vl/Q4_K_M/"
        size: 4.2GB
        sha256: "m3n4o5p6..."
```

---

## 4. 下载流程

```
首次调用 gguf-smolvlm2
       │
       ▼
ensureSmolVLM2Model()
       │
       ▼
┌─────────────────────┐
│ 1. 检查本地缓存      │
│    ~/.vision-mcp/   │
└─────────┬───────────┘
          │
     ┌────┴────┐
     ▼         ▼
   已存在    不存在
     │         │
     ▼         ▼
┌─────────┐ ┌─────────────────┐
│meta校验 │ │ 2. streamDownload│
│(可选SHA)│ │    断点续传      │
└────┬────┘ └────────┬────────┘
     │               │
  ┌──┴──┐            ▼
  ▼     ▼      ┌─────────────┐
 通过  损坏     │ 3. 写.meta.json│
  │     │      │  + 原子rename │
  │     ▼      └──────┬──────┘
  │  重新下载          │
  │              ┌─────┴────┐
  │              ▼          ▼
  │           就绪      (VISION_VERIFY_CHECKSUMS=1 时再校验)
  │              │          │
  │              ▼          ▼
  │           就绪      删除重下
  │
  ▼
就绪（返回模型路径）
```

### 4.1 断点续传（已实现）
```typescript
// streamDownload 使用 HTTP Range header
// 下载到 <file>.tmp-<pid>，中断后重试从已下载字节继续
// 完成后原子 rename 为最终文件名
```

### 4.2 并发分片下载（规划，未实现）
> 当前为单流式下载（`streamDownload`），无分片/并发。以下为规划形态：

大模型文件分片并发下载，提升速度：
```
800MB 文件 → 4 个分片并行 → 各 200MB
```

### 4.3 下载进度
首次加载时通过日志/MCP 通知反馈进度：
```
[vision-mcp] Downloading smolvlm Q4_K_M... 45% (360MB/800MB)
```

---

## 5. 校验机制

> 实际实现见 `src/core/model-manager.ts`：下载完成后写入 `.meta.json` sidecar（`sha256`/`size`/`url`/`downloadedAt`）。校验默认关闭，`VISION_VERIFY_CHECKSUMS=1` 时启用。

### 5.1 下载后校验（已实现）
```typescript
// VISION_VERIFY_CHECKSUMS=1 时
// 比对 computeSHA256(modelPath) 与 .meta.json.sha256
// 不匹配 -> 删除文件 -> 重新下载 -> 再校验
```

### 5.2 加载前校验（轻量，已实现）
每次 load 前用 `.meta.json` 中的 `size` + 文件存在性做轻量校验，避免每次全量 SHA256；`VISION_VERIFY_CHECKSUMS=1` 时才做全量哈希校验。

### 5.3 校验失败处理（已实现）
```
SHA256 不匹配 -> 删除文件 -> 重新下载 -> 再校验
（损坏文件自动修复；孤立 .tmp-* 也会被清理）
```

---

## 6. 版本管理（规划，未实现）

> 当前每个 provider 只维护单一量化版本的模型文件，无多版本共存/升级/清理机制。以下为规划形态。

### 6.1 多版本共存
```
~/.vision-mcp/models/smolvlm/
├── Q4_K_M/          v1.0.0
└── Q4_K_M_v1.1.0/   v1.1.0（升级后保留旧版）
```

### 6.2 升级流程
```
1. 下载新版本到独立目录
2. 校验完整性
3. 更新 config/providers.yaml 的 default 指向
4. 旧版本保留（可回滚）
5. 手动或自动清理旧版本（按策略）
```

### 6.3 清理策略
```yaml
# config/lifecycle.yaml
modelCleanup:
  keepVersions: 2        # 保留最近 2 个版本
  autoClean: false       # 是否自动清理
  diskThreshold: 10240   # 磁盘低于此(MB)触发清理
```

---

## 7. 缓存管理

> **实现状态**：跨请求的推理结果缓存（独立 `CacheManager`）**未实现**，`cache` 当前硬编码为 `false`。本节为规划形态。注意：**Provider 级**推理缓存**已实现**（见 [06 - Provider 与 Runtime](./06-provider-runtime.md) §5.1，`BaseLlamaCppProvider` 内 `Map` + TTL 1h + LRU 100），与本文档描述的跨请求结果缓存不同。

### 7.1 推理结果缓存（规划，未实现）

不同于模型文件缓存（也不同于 Provider 级推理缓存），这里缓存的是**跨请求的最终结果**：

```typescript
// 缓存 key
const cacheKey = SHA256(image) + ":" + hash(intent + skills + options);

// 命中 -> 直接返回 structuredContent
// 未命中 -> 执行推理 -> 写入缓存
```

### 7.2 缓存配置
```yaml
# config/cache.yaml
cache:
  enabled: true
  ttl: 86400000           # 24 小时
  maxSize: 512            # 最大 512MB
  strategy: lru           # 淘汰策略
```

### 7.3 缓存失效
```
- TTL 过期自动失效
- LRU 容量满时淘汰最久未用
- 模型版本变更时清空（避免旧模型结果污染）
- 手动清空：vision.analyze({ cache: false })
```

---

## 8. 接口定义（规划，未实现）

> 当前没有通用 `ModelManager` / `CacheManager` 类。`src/core/model-manager.ts` 仅导出三个具体函数：`ensureGGUFModel` / `ensureSmolVLM2Model` / `ensureMiniCPMModel`（无 `isCached`/`remove`/`list`/`upgrade`）。以下接口为规划形态。

### ModelManager
```typescript
interface ModelManager {
  /**
   * 确保模型已下载并校验
   * 返回模型本地路径
   */
  ensure(
    name: string,
    quantization: string
  ): Promise<string>;

  /** 检查模型是否已缓存 */
  isCached(name: string, quantization: string): boolean;

  /** 删除模型 */
  remove(name: string, quantization: string): Promise<void>;

  /** 列出已缓存模型 */
  list(): ModelInfo[];

  /** 升级模型 */
  upgrade(name: string): Promise<void>;
}
```

### CacheManager（规划，未实现）
```typescript
interface CacheManager {
  get(key: string): Promise<VisionResult | null>;
  set(key: string, result: VisionResult): Promise<void>;
  clear(): Promise<void>;
  stats(): { size: number; entries: number; hitRate: number };
}
```

---

## 9. 磁盘与内存预算

各 provider 模型文件大小（与 `requirements.modelSizeMB` 一致）：

### 默认模型
```
gguf-smolvlm2（默认）：  ~500MB 磁盘   SmolVLM2-500M-Video-Instruct-Q4_K_M (+ mmproj)
gguf-smolvlm：           ~417MB 磁盘   SmolVLM-500M-Instruct-Q8_0
minicpm-v（高质量）：     ~2048MB 磁盘  MiniCPM-V-2_6-Q4_K_M (+ mmproj)，需 GPU
smolvlm（ONNX 遗留）：    ~800MB 磁盘   SmolVLM (Transformers.js)
─────────────────────────
最小磁盘占用（仅默认）：  ~500MB
```

> 模型加载内存峰值约等于模型文件大小（SmolVLM ~500MB，MiniCPM ~2GB）。Provider 级推理缓存为进程内 `Map`（LRU 100 条），不占额外磁盘。

### 扩展模型（未来）
```
qwen2.5-vl Q4：    ~4.2GB 磁盘（规划）
```

---

## 10. 测试要点

| 测试场景 | 预期 |
|----------|------|
| 首次调用 | 自动下载 + 写入 `.meta.json` + 加载 |
| 二次调用 | 命中本地文件，跳过下载 |
| 下载中断 | 断点续传（HTTP Range + `.tmp-<pid>`） |
| `VISION_VERIFY_CHECKSUMS=1` 且 SHA256 不匹配 | 删除重下并修复 `.meta.json` |
| 损坏/孤立的 `.tmp-*` | 启动时清理 |
| llama-server 二进制缺失 | 自动下载（`LLAMA_DOWNLOAD_MIRROR` 降级） |
| 模型版本升级 | 规划中，暂不支持 |

---

## 11. 本文小结

模型管理核心要点：

1. **自动就绪** -- 首次调用自动下载，用户无感
2. **完整性校验** -- `.meta.json` sidecar + SHA256（`VISION_VERIFY_CHECKSUMS=1`）
3. **断点续传** -- HTTP Range + 原子 `.tmp-<pid>` -> rename
4. **镜像降级** -- `LLAMA_DOWNLOAD_MIRROR`（llama-server 二进制）
5. **版本管理** -- 规划中，当前单版本
6. **缓存分层** -- 模型文件缓存（磁盘，已实现）+ Provider 级推理缓存（进程内 Map，已实现）；跨请求结果缓存（规划，未实现）
7. **资源预算** -- 默认 gguf-smolvlm2 约 500MB 磁盘

> 架构设计部分完结。下一篇进入：[02-contracts/01-domain-model.md](../02-contracts/01-domain-model.md)
