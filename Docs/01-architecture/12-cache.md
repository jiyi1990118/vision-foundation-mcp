# 12 - 缓存设计（Cache Design）

> 缓存是性能优化的第一手段。本文档定义推理结果缓存的策略、结构与一致性。

---

## 1. 设计目标

| 目标 | 说明 |
|------|------|
| 减少重复推理 | 相同图片+意图的请求直接返回缓存 |
| 透明无感 | 调用方无需感知缓存，结果结构一致 |
| 可控可禁 | 通过参数禁用缓存，配置控制 TTL/容量 |
| 安全 | 缓存不泄漏跨用户数据（单机模式不涉及） |

## 非目标
- ❌ 不缓存原始图片（只缓存推理结果）
- ❌ 不做分布式缓存（V1 单进程内存缓存）
- ❌ 不缓存中间过程（只缓存最终 structuredContent）

---

## 2. 缓存层次

```
请求进入
  │
  ▼
┌──────────────────┐
│ 结果缓存 (Result) │  推理结果缓存（本文档重点）
│  key = img+intent │
└──────────────────┘
  │ 未命中
  ▼
┌──────────────────┐
│ 模型缓存 (Model)  │  模型文件缓存（见 07-model-management）
│  ~/.vision-mcp/  │  已在模型管理文档定义
└──────────────────┘
```

本文档聚焦**推理结果缓存**。

---

## 3. 缓存键设计

### 3.1 键公式

```
cacheKey = SHA256(imageBuffer) + ":" + hash(intent + skills + options)
```

### 3.2 键组成

| 组成 | 说明 | 影响 |
|------|------|------|
| `SHA256(imageBuffer)` | 图片内容哈希 | 相同图片命中 |
| `hash(intent)` | 意图哈希 | 不同意图不命中 |
| `hash(skills)` | Skill 列表哈希 | 不同 Skill 组合不命中 |
| `hash(options)` | 选项哈希 | quality/provider 不同不命中 |

### 3.3 示例

```
图片 A + intent="auto" + skills=[classify,summary] + quality=fast
  → key = "a1b2c3...:d4e5f6..."

图片 A + intent="extract text" + skills=[ocr]
  → key = "a1b2c3...:g7h8i9..."  （同图不同意图，不命中）

图片 B + intent="auto"
  → key = "j0k1l2...:d4e5f6..."  （不同图，不命中）
```

### 3.4 options 影响缓存

```typescript
function buildCacheKey(image: Buffer, intent: string, skills: string[], options: Options): string {
  const imageHash = sha256(image);
  const configHash = sha256(JSON.stringify({
    intent,
    skills: skills.sort(),         // 排序保证顺序无关
    quality: options.quality,
    // provider 不计入 key：同图同意图不同 provider 结果应一致（理想情况）
    // 若 provider 影响结果质量，则需计入
  }));
  return `${imageHash}:${configHash}`;
}
```

---

## 4. 缓存策略

### 4.1 淘汰策略：LRU

```
容量达到上限时，淘汰最久未访问的条目
```

### 4.2 失效策略

| 触发条件 | 行为 |
|----------|------|
| TTL 过期 | 自动失效 |
| LRU 容量满 | 淘汰最久未用 |
| 模型版本变更 | 清空全部缓存（避免旧模型结果污染） |
| 用户禁用 | 该请求跳过缓存读写 |
| 手动清除 | `cacheManager.clear()` |

### 4.3 配置

```yaml
# config/cache.yaml
cache:
  enabled: true
  ttl: 86400000              # 24 小时（毫秒）
  maxSize: 512               # 最大 512MB
  maxEntries: 1000           # 最多 1000 条
  strategy: lru              # 淘汰策略
  invalidateOnModelUpdate: true  # 模型更新时清空
```

---

## 5. 缓存读写流程

### 5.1 读取流程

```
请求进入
  │
  ▼
构建 cacheKey
  │
  ▼
cacheManager.get(cacheKey)
  │
  ├─ 命中且未过期
  │    │
  │    ▼
  │  返回缓存结果（cached: true）
  │
  └─ 未命中 / 已过期
       │
       ▼
     执行推理流程
       │
       ▼
     写入缓存（异步，不阻塞返回）
       │
       ▼
     返回结果（cached: false）
```

### 5.2 写入策略

```typescript
async function visionAnalyze(req) {
  const cacheKey = buildCacheKey(req);

  // 1. 查缓存
  if (req.options?.cache !== false) {
    const cached = await cacheManager.get(cacheKey);
    if (cached) {
      return { ...cached, metadata: { ...cached.metadata, cached: true } };
    }
  }

  // 2. 执行推理
  const result = await pipeline.execute(req);

  // 3. 异步写缓存（不阻塞返回）
  if (req.options?.cache !== false && result.metadata.cached === false) {
    cacheManager.set(cacheKey, result).catch(e => {
      logger.warn("cache write failed", { error: e });  // 缓存失败不影响结果
    });
  }

  return result;
}
```

**关键**：缓存写入是异步的，不阻塞返回。写入失败只记日志，不影响结果。

### 5.3 缓存结果结构

缓存存储的是完整的 `VisionResult`，但**不包含图片**：

```typescript
interface CacheEntry {
  key: string;
  result: VisionResult;      // 结构化结果（不含原图）
  createdAt: number;
  expiresAt: number;
  size: number;              // 估算占用字节
}
```

---

## 6. 缓存与部分成功

当推理结果含部分失败的 Skill 时，是否缓存？

```
策略：不缓存部分成功的结果

理由：
  部分 Skill 失败可能是瞬时问题
  缓存部分成功结果会导致下次也拿到不完整结果
  应该让下次请求重新尝试
```

```typescript
// 只缓存全部成功的结果
const allSuccess = result.skills.every(
  s => !result.result[s]?.error
);
if (allSuccess) {
  await cacheManager.set(cacheKey, result);
}
```

---

## 7. 缓存统计

```typescript
interface CacheStats {
  size: number;              // 当前占用 MB
  entries: number;           // 条目数
  hitRate: number;           // 命中率
  hits: number;              // 命中次数
  misses: number;            // 未命中次数
  evictions: number;         // 淘汰次数
}

// 暴露为监控指标
cache_size_mb 412
cache_entries 856
cache_hit_rate 0.73
cache_hits 1245
cache_misses 456
cache_evictions 23
```

---

## 8. 接口定义

```typescript
interface CacheManager {
  /** 读取缓存 */
  get(key: string): Promise<VisionResult | null>;

  /** 写入缓存 */
  set(key: string, result: VisionResult): Promise<void>;

  /** 清空全部缓存 */
  clear(): Promise<void>;

  /** 删除指定条目 */
  delete(key: string): Promise<void>;

  /** 获取统计信息 */
  stats(): CacheStats;

  /** 模型更新时调用 */
  invalidateAll(): Promise<void>;
}
```

---

## 9. 测试要点

| 场景 | 预期 |
|------|------|
| 相同图片+意图第二次请求 | 命中缓存，cached=true |
| 同图不同意图 | 不命中 |
| 不同图同意图 | 不命中 |
| cache=false | 跳过缓存读写 |
| TTL 过期后请求 | 不命中，重新推理 |
| 容量满后写入 | 淘汰最久未用 |
| 部分成功结果 | 不缓存 |
| 模型版本变更 | 清空全部缓存 |
| 缓存写入失败 | 不影响结果返回 |
| 缓存统计 | hitRate/entries 正确 |

---

## 10. 本文小结

缓存设计核心要点：

1. **键 = 图片哈希 + 意图哈希 + 选项哈希** —— 精确区分不同请求
2. **LRU + TTL** —— 容量与时效双重控制
3. **写入异步** —— 不阻塞返回
4. **只缓存全成功结果** —— 部分成功不缓存
5. **模型更新清空** —— 避免旧结果污染
6. **可禁用** —— `cache: false` 跳过
7. **不存原图** —— 只存结构化结果

> 架构设计部分（01-architecture）至此完整。
> 
> 返回 [文档总索引](../README.md)
