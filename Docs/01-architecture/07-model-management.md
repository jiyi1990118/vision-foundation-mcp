# 07 - 模型管理（Model Management）

> Model Manager 负责模型的下载、校验、缓存、版本与升级。让用户「首次调用自动就绪」，无需手动下载模型。

> ⚠️ **实现状态**：本文档描述的是规划中的 ModelManager 系统（含 manifest.json、分片下载、版本升级）。
> 当前实现更简化：`src/core/model-manager.ts` 的 `ensureGGUFModel()` / `ensureSmolVLM2Model()` / `ensureMiniCPMModel()` 直接从 HuggingFace 下载 GGUF 文件到 `~/.vision-mcp/models/`，无 manifest.json、无分片、无版本管理。
> 实际 provider 列表：`smolvlm2`（默认）/ `gguf` / `minicpm`，模型路径见 `AGENTS.md`。

---

## 1. 设计目标

| 目标 | 说明 |
|------|------|
| 自动就绪 | 首次调用自动下载，无需手动操作 |
| 完整性校验 | SHA256 校验，防损坏/篡改 |
| 本地缓存 | 下载一次，反复使用 |
| 版本管理 | 支持多版本共存与切换 |
| 断点续传 | 大模型下载支持断点续传 |

---

## 2. 模型目录结构

```
~/.vision-mcp/
└── models/
    └── smolvlm/
        ├── Q4_K_M/
        │   ├── model.onnx           模型文件
        │   ├── config.json          模型配置
        │   ├── tokenizer.json       分词器
        │   └── manifest.json        清单（SHA256/版本/大小）
        └── FP16/
            └── ...
```

### manifest.json（模型清单）
```json
{
  "name": "smolvlm",
  "quantization": "Q4_K_M",
  "version": "1.0.0",
  "files": [
    {
      "path": "model.onnx",
      "size": 838860800,
      "sha256": "a1b2c3d4..."
    },
    {
      "path": "tokenizer.json",
      "size": 1048576,
      "sha256": "e5f6g7h8..."
    }
  ],
  "createdAt": "2025-01-01T00:00:00Z",
  "source": "https://models.vision-mcp.org/smolvlm/Q4_K_M/"
}
```

---

## 3. 模型注册表

所有可用模型在配置中声明：

```yaml
# config/providers.yaml
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
首次调用 smolvlm
       │
       ▼
ModelManager.ensure("smolvlm", "Q4_K_M")
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
│SHA256校验│ │ 2. 下载          │
│         │ │    支持断点续传   │
└────┬────┘ └────────┬────────┘
     │               │
  ┌──┴──┐            ▼
  ▼     ▼      ┌─────────────┐
通过  损坏     │ 3. SHA256校验 │
  │     │      └──────┬──────┘
  │     ▼             │
  │  重新下载    ┌─────┴────┐
  │              ▼          ▼
  │           通过        不匹配
  │              │          │
  │              ▼          ▼
  │           就绪      删除重下
  │
  ▼
就绪（返回模型路径）
```

### 4.1 断点续传
```typescript
// 下载时记录已下载字节
// 中断后重试时从断点继续
// 使用 HTTP Range header
```

### 4.2 并发下载
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

### 5.1 下载后校验
```typescript
async function verifyModel(modelPath: string, expectedSha256: string): Promise<boolean> {
  const actualSha256 = await computeSHA256(modelPath);
  return actualSha256 === expectedSha256;
}
```

### 5.2 加载前校验（轻量）
每次 load 前快速校验 manifest 完整性（文件存在 + 大小匹配），避免每次全量 SHA256。

### 5.3 校验失败处理
```
SHA256 不匹配 → 删除文件 → 重新下载 → 再校验
连续 3 次失败 → 抛出 ModelCorruptedError
```

---

## 6. 版本管理

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

### 7.1 推理结果缓存（Cache Manager）

不同于模型文件缓存，这里缓存的是**推理结果**：

```typescript
// 缓存 key
const cacheKey = SHA256(image) + ":" + hash(intent + skills + options);

// 命中 → 直接返回 structuredContent
// 未命中 → 执行推理 → 写入缓存
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

## 8. 接口定义

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

### CacheManager
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

### 默认模型（V1）
```
模型文件（磁盘）：  ~800MB（smolvlm Q4_K_M）
模型加载（内存）：  ~800MB-1GB
推理结果缓存：      可配（默认 512MB）
─────────────────────────
总磁盘占用：        ~800MB
峰值内存：          ~1.5GB
```

### 扩展模型（未来）
```
qwen2.5-vl Q4：    ~4.2GB 磁盘
minicpm Q4：       ~2.5GB 磁盘
```

---

## 10. 测试要点

| 测试场景 | 预期 |
|----------|------|
| 首次调用 | 自动下载 + 校验 + 加载 |
| 二次调用 | 命中缓存，跳过下载 |
| 下载中断 | 断点续传 |
| SHA256 不匹配 | 删除重下 |
| 磁盘不足 | 抛出 DiskFullError |
| 推理结果缓存命中 | 跳过推理直接返回 |
| 模型版本升级 | 新旧共存，可切换 |

---

## 11. 本文小结

模型管理核心要点：

1. **自动就绪** —— 首次调用自动下载，用户无感
2. **完整性校验** —— SHA256 防损坏/篡改
3. **断点续传** —— 大模型下载可中断恢复
4. **版本管理** —— 多版本共存，可回滚
5. **双层缓存** —— 模型文件缓存（磁盘）+ 推理结果缓存（内存/磁盘）
6. **资源预算** —— V1 默认约 800MB 磁盘 + 1.5GB 峰值内存

> 架构设计部分完结。下一篇进入：[02-contracts/01-domain-model.md](../02-contracts/01-domain-model.md)
