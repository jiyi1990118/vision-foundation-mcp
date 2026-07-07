# 10 - 错误处理（Error Handling）

> 统一的错误码、错误结构与重试策略，是生产可用的底线。本文档定义全项目错误处理规范。

---

## 1. 设计目标

| 目标 | 说明 |
|------|------|
| 统一错误码 | 全项目用同一套错误码，不各模块自定义 |
| 结构化错误 | 错误对象有固定结构，Client 可程序化处理 |
| 可重试标记 | 每个错误明确标记是否可重试 |
| 分层捕获 | 各层处理自己能处理的，不能处理的向上抛 |
| 不吞错误 | 任何 catch 必须有处理或日志 |
| 用户友好 | 错误消息对人可读，错误码对程序可读 |

---

## 2. 错误分类

### 2.1 按可重试性分类

```
可重试错误（Retryable）：
  瞬时故障，重试可能成功
  ├─ 模型下载失败（网络抖动）
  ├─ 推理超时（偶发慢）
  ├─ 内存不足（等待释放后可重试）
  └─ Schema 校验失败（换 Prompt 重试）

不可重试错误（Non-Retryable）：
  持久故障，重试也不会成功
  ├─ 输入格式不支持
  ├─ 策略拒绝（超大图）
  ├─ Provider 不可用（未安装）
  └─ Runtime 不可用（无可用引擎）
```

### 2.2 按来源分类

| 来源 | 错误码前缀 | 示例 |
|------|-----------|------|
| 输入校验 | `NORMALIZE_*` | 输入格式不支持、文件损坏 |
| 模型管理 | `MODEL_*` | 下载失败、校验失败 |
| Provider | `PROVIDER_*` | 不可用、未加载 |
| Runtime | `RUNTIME_*` | 不可用、推理失败 |
| 策略 | `POLICY_*` | 拒绝 |
| Skill | `SKILL_*` | 校验失败、重试耗尽 |
| 资源 | `RESOURCE_*` | 内存不足、磁盘不足 |
| 超时 | `TIMEOUT` | 推理超时、加载超时 |
| 内部 | `INTERNAL_*` | 未知错误 |

---

## 3. 错误码总表

| 错误码 | 含义 | 可重试 | HTTP 类比 |
|--------|------|--------|----------|
| `NORMALIZE_INVALID_INPUT` | 输入格式不支持或文件损坏 | 否 | 400 |
| `NORMALIZE_FILE_NOT_FOUND` | 文件路径不存在 | 否 | 404 |
| `NORMALIZE_TOO_LARGE` | 图片超过大小限制 | 否 | 413 |
| `MODEL_DOWNLOAD_FAILED` | 模型下载失败 | 是 | 502 |
| `MODEL_CORRUPTED` | 模型文件校验失败 | 是 | 500 |
| `MODEL_NOT_FOUND` | 请求的模型不存在 | 否 | 404 |
| `PROVIDER_UNAVAILABLE` | 所需 Provider 不可用 | 否 | 503 |
| `PROVIDER_NOT_LOADED` | Provider 未加载且加载失败 | 是 | 503 |
| `RUNTIME_NOT_FOUND` | 无可用 Runtime | 否 | 503 |
| `RUNTIME_INFER_FAILED` | 推理引擎执行失败 | 是 | 500 |
| `POLICY_DENIED` | 策略拒绝执行 | 否 | 403 |
| `SKILL_VALIDATION_FAILED` | Skill 输出校验失败 | 是 | 422 |
| `SKILL_RETRY_EXHAUSTED` | Skill 重试次数耗尽 | 否 | 500 |
| `SKILL_NOT_FOUND` | 请求的 Skill 不存在 | 否 | 404 |
| `RESOURCE_INSUFFICIENT` | 内存/资源不足 | 是 | 503 |
| `RESOURCE_DISK_FULL` | 磁盘空间不足 | 否 | 507 |
| `TIMEOUT` | 操作超时 | 是 | 504 |
| `BUSY` | 并发已满，请求排队超时 | 是 | 503 |
| `INTERNAL_ERROR` | 未知内部错误 | 是 | 500 |

---

## 4. 错误对象结构

### 4.1 内部错误对象

```typescript
class VisionError extends Error {
  constructor(
    public code: string,           // 错误码（见总表）
    message: string,               // 人类可读消息
    public retryable: boolean,     // 是否可重试
    public details?: {             // 额外上下文
      skill?: string;
      provider?: string;
      retryCount?: number;
      [key: string]: any;
    }
  ) {
    super(message);
    this.name = this.constructor.name;
  }
}
```

### 4.2 具体错误子类

```typescript
class NormalizeError extends VisionError {}
class ModelError extends VisionError {}
class ProviderError extends VisionError {}
class RuntimeError extends VisionError {}
class PolicyError extends VisionError {}
class SkillError extends VisionError {}
class ResourceError extends VisionError {}
class TimeoutError extends VisionError {}
```

### 4.3 对外错误响应（MCP）

```json
{
  "content": [
    {
      "type": "text",
      "text": "Vision analysis failed: SKILL_RETRY_EXHAUSTED - OCR skill failed after 2 retries"
    }
  ],
  "isError": true,
  "structuredContent": {
    "error": {
      "code": "SKILL_RETRY_EXHAUSTED",
      "message": "OCR skill failed after 2 retries",
      "retryable": false,
      "details": {
        "skill": "ocr",
        "retryCount": 2,
        "lastError": "JSON parse failed"
      }
    }
  }
}
```

---

## 5. 分层错误处理策略

### 5.1 各层职责

```
L0 Tool        最终捕获边界，转换为 MCP 错误响应
L1 Request     输入校验错误，直接抛（不可重试）
L2 Decision    策略拒绝错误，直接抛（不可重试）
L3 Skill       校验失败重试，重试耗尽抛 SkillError
L4 Provider    加载/推理失败，抛 ProviderError
L5 Runtime     引擎错误，抛 RuntimeError
L6 Infra       资源/模型错误，抛 Resource/ModelError
```

### 5.2 错误传播规则

```
原则：能处理的在当前层处理，不能处理的向上抛

Runtime 推理失败
  → L5 抛 RuntimeError(retryable=true)
  → L4 Provider 不处理，向上抛
  → L3 Skill 检查 retryable，若 true 则重试
       重试成功 → 正常返回
       重试耗尽 → 抛 SkillError(RETRY_EXHAUSTED, retryable=false)
  → L0 Tool 捕获，转为 MCP 错误响应
```

### 5.3 禁止吞错误

```typescript
// ❌ 禁止：吞掉错误
try {
  await provider.infer(req);
} catch (e) {
  // 什么也不做
}

// ✅ 至少记录日志
try {
  await provider.infer(req);
} catch (e) {
  logger.warn("infer failed", { error: e });
  throw e;  // 向上抛
}

// ✅ 或者处理并降级
try {
  return await provider.infer(req);
} catch (e) {
  logger.warn("primary provider failed, falling back", { error: e });
  return await fallbackProvider.infer(req);
}
```

---

## 6. 重试策略

### 6.1 重试决策树

```
捕获错误
  │
  ├─ retryable == false → 不重试，直接抛
  │
  ├─ retryable == true
  │    │
  │    ├─ retryCount < maxRetries → 重试
  │    │    │
  │    │    ├─ strategy == "reprompt" → 强化 Prompt 重试
  │    │    ├─ strategy == "fallback" → 降级 Skill 重试
  │    │    └─ strategy == "none" → 不重试（如 moderation）
  │    │
  │    └─ retryCount >= maxRetries → 抛 SKILL_RETRY_EXHAUSTED
```

### 6.2 重试参数（按 Skill 类型）

| Skill 类型 | maxRetry | strategy | 说明 |
|-----------|----------|----------|------|
| classify | 1 | reprompt | 简单任务，1 次重试足够 |
| ocr | 2 | reprompt | OCR 易出错，多给 1 次 |
| ui | 1 | reprompt | |
| chart | 2 | reprompt | |
| summary | 1 | reprompt | |
| moderation | 0 | none | 审核不重试，避免偏见 |
| object | 1 | reprompt | |

### 6.3 重试时的 Prompt 强化

```typescript
function buildRetryPrompt(originalPrompt: string, lastError: string): string {
  const hints = {
    "JSON parse failed": "IMPORTANT: Your previous response was not valid JSON. Output ONLY raw JSON, no markdown, no explanation.",
    "missing required field: layout": "IMPORTANT: Your previous response was missing the 'layout' field. Include ALL required fields.",
    "invalid enum value": "IMPORTANT: Use only the allowed values for each field.",
  };

  const hint = matchHint(lastError, hints) || "IMPORTANT: Your previous response was invalid. Please output valid JSON only.";
  return originalPrompt + "\n\n" + hint;
}
```

### 6.4 退避策略

```
重试间隔（避免立即重试导致雪崩）：
  第 1 次重试：立即
  第 2 次重试：等待 500ms
  第 3 次重试：等待 1000ms（指数退避）
```

---

## 7. 部分成功策略

### 7.1 原则

> 多 Skill 场景下，单个 Skill 失败不应阻断整体返回。尽力而为，返回已成功部分。

### 7.2 处理逻辑

```typescript
async function executePipeline(skills: SkillTask[], image: ImageInput) {
  const results = {};

  for (const task of skills) {
    try {
      results[task.skill] = await executeSkill(task, image);
    } catch (e) {
      if (e instanceof VisionError) {
        // 记录失败，继续其他 Skill
        results[task.skill] = {
          error: e.code,
          message: e.message,
          partial: true,
        };
        logger.warn("skill failed, continuing", {
          skill: task.skill,
          error: e.code,
        });
      } else {
        // 未知错误也记录，不阻断
        results[task.skill] = {
          error: "INTERNAL_ERROR",
          message: "Unexpected error",
          partial: true,
        };
      }
    }
  }

  return results;  // 含成功和失败的混合结果
}
```

### 7.3 依赖 Skill 失败的处理

若 Skill A 是 Skill B 的前置依赖（如 classify → chart），A 失败时：
- B 标记为 `skipped`（跳过）
- 不尝试执行 B
- 其他独立 Skill 照常执行

```typescript
if (task.dependsOn) {
  const depFailed = task.dependsOn.some(dep => results[dep]?.error);
  if (depFailed) {
    results[task.skill] = { status: "skipped", reason: "dependency failed" };
    continue;
  }
}
```

---

## 8. 错误日志规范

```typescript
// 错误日志必须包含足够上下文
logger.error("skill execution failed", {
  skill: "ocr",
  provider: "smolvlm2",
  errorCode: e.code,
  retryCount: currentRetry,
  imageHash: hash(image),       // 不记录完整图片
  imageSize: image.size,
  duration: elapsed,
  stack: e.stack,
});
```

**不记录**：
- ❌ 完整图片 base64
- ❌ 完整 Prompt（可能含用户输入）
- ❌ 用户敏感信息

---

## 9. 错误处理测试要点

| 场景 | 预期 |
|------|------|
| 输入格式不支持 | 返回 NORMALIZE_INVALID_INPUT，retryable=false |
| 模型下载网络失败 | 返回 MODEL_DOWNLOAD_FAILED，retryable=true |
| 推理超时 | 重试，重试耗尽返回 TIMEOUT |
| Schema 校验失败 | reprompt 重试 |
| moderation Skill | 失败不重试 |
| 单 Skill 失败 | 其他 Skill 照常返回 |
| 依赖 Skill 失败 | 后续 Skill 标记 skipped |
| 未知异常 | 捕获为 INTERNAL_ERROR，retryable=true |
| 并发已满 | 返回 BUSY |

---

## 10. 本文小结

错误处理核心要点：

1. **统一错误码** —— 全项目一张错误码总表
2. **可重试标记** —— 每个错误明确 retryable
3. **分层捕获** —— 能处理的当前层处理，不能的向上抛
4. **不吞错误** —— 任何 catch 必须有处理或日志
5. **重试策略** —— reprompt / fallback / none，按 Skill 配置
6. **部分成功** —— 单 Skill 失败不阻断整体
7. **依赖失败跳过** —— 前置失败则后续跳过
8. **日志含上下文** —— 但不记录敏感数据

> 下一篇：[11 - 安全设计](./11-security.md)
