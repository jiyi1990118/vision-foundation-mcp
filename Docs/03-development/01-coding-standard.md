# 01 - 编码规范（Coding Standard）

> 本文档定义代码风格、命名、错误处理、日志等规范。所有代码必须遵守。

---

## 1. 语言与工具链

| 项 | 选择 | 理由 |
|----|------|------|
| 语言 | TypeScript (strict) | 类型安全，MCP 生态主流 |
| 运行时 | Node.js (LTS) | MCP SDK 支持 |
| 包管理 | pnpm | 快、省磁盘 |
| Lint | ESLint + @typescript-eslint | 类型感知 lint |
| 格式化 | Prettier | 统一格式 |
| 测试 | Vitest | 快、TS 原生 |

### tsconfig 关键配置
```json
{
  "compilerOptions": {
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "noImplicitOverride": true,
    "forceConsistentCasingInFileNames": true
  }
}
```

---

## 2. 命名规范

### 2.1 文件命名
```
kebab-case: execution-planner.ts, policy-engine.ts, vision-analyze.ts
```

### 2.2 标识符命名

| 类型 | 风格 | 示例 |
|------|------|------|
| 类 / 接口 | PascalCase | `ExecutionPlanner`, `VisionProvider` |
| 函数 / 变量 | camelCase | `planExecution`, `cacheKey` |
| 常量 | UPPER_SNAKE | `DEFAULT_TIMEOUT`, `MAX_RETRY` |
| 类型别名 | PascalCase | `SkillState`, `ProviderState` |
| 枚举值 | PascalCase | `"Loaded"`, `"Idle"` |
| 私有成员 | camelCase + _ 前缀（可选） | `this._runtime` |
| 布尔变量 | is/has/can 前缀 | `isLoaded`, `hasGPU` |

### 2.3 术语一致性
**必须**使用 [领域模型术语表](../02-contracts/01-domain-model.md) 中的术语。禁止 Job/Action/Worker/Backend 等。

---

## 3. 类型规范

### 3.1 接口优先
```typescript
// ✅ 定义接口
interface VisionProvider {
  infer(req: InferenceRequest): Promise<InferenceResponse>;
}

// ✅ 实现类
class SmolVLMProvider implements VisionProvider { ... }
```

### 3.2 禁止 any
```typescript
// ❌ 禁止
function process(data: any) {}

// ✅ 用 unknown + 类型守卫，或定义具体类型
function process(data: unknown) {
  if (isImageInput(data)) { ... }
}
```

### 3.3 错误处理用自定义错误类
```typescript
// ✅ 自定义错误
class VisionError extends Error {
  constructor(
    public code: string,      // 错误码见术语表
    message: string,
    public retryable: boolean = false
  ) {
    super(message);
    this.name = this.constructor.name;
  }
}

class ModelDownloadError extends VisionError { ... }
```

---

## 4. 错误处理规范

### 4.1 错误分类
```typescript
// 可重试错误（网络/超时/资源）
throw new VisionError("MODEL_DOWNLOAD_FAILED", "...", true);

// 不可重试错误（输入无效/策略拒绝）
throw new VisionError("NORMALIZE_INVALID_INPUT", "...", false);
```

### 4.2 边界处捕获
```typescript
// Tool 层是最终捕获边界
async function visionAnalyze(req) {
  try {
    return await pipeline.execute(req);
  } catch (e) {
    if (e instanceof VisionError) {
      return toErrorResponse(e);
    }
    return toErrorResponse(new VisionError("INTERNAL_ERROR", "...", true));
  }
}
```

### 4.3 不吞错误
```typescript
// ❌ 禁止吞错误
try { await infer(); } catch (e) {}

// ✅ 至少记录日志
try { await infer(); } catch (e) {
  logger.warn("infer failed", { error: e });
}
```

---

## 5. 日志规范

### 5.1 日志级别
```typescript
logger.error("模型下载失败", { provider, error });   // 影响功能的错误
logger.warn("内存紧张，降级到小模型", { available });  // 可继续的异常
logger.info("推理完成", { provider, duration });      // 关键流程节点
logger.debug("校验通过", { skill, fields });          // 调试细节
```

### 5.2 结构化日志
```typescript
// ✅ 结构化
logger.info("skill completed", { skill: "ocr", duration: 1200, success: true });

// ❌ 字符串拼接
logger.info("skill ocr completed in " + duration + "ms");
```

### 5.3 不记录敏感数据
- 不记录完整图片 base64
- 不记录完整 Prompt（可能含用户输入）
- 记录 hash/长度即可

---

## 6. 异步规范

### 6.1 async/await 优先
```typescript
// ✅
async function load() {
  const model = await modelManager.ensure("smolvlm2");
  await runtime.load(model);
}

// ❌ 避免 .then 链
function load() {
  return modelManager.ensure("smolvlm2").then(m => runtime.load(m));
}
```

### 6.2 并发用 Promise.all
```typescript
// 独立 Skill 并行
const [classify, ocr] = await Promise.all([
  runSkill("classify", img),
  runSkill("ocr", img),
]);
```

### 6.3 超时控制
```typescript
async function inferWithTimeout(req, timeout) {
  return Promise.race([
    provider.infer(req),
    timeoutAfter(timeout, new VisionError("TIMEOUT", "...", true)),
  ]);
}
```

---

## 7. 配置规范

### 7.1 配置不硬编码
```typescript
// ❌ 禁止
const IDLE_TIMEOUT = 600000;

// ✅ 从配置读
const idleTimeout = config.get("lifecycle.idleTimeout");
```

### 7.2 配置有默认值
```typescript
const idleTimeout = config.get("lifecycle.idleTimeout") ?? 600000;
```

### 7.3 配置校验
启动时校验配置完整性，缺失关键配置直接报错而非运行时崩溃。

---

## 8. 注释规范

### 8.1 何时写注释
```typescript
// ✅ 解释「为什么」
// Policy 优先于 Planner，因为审核数据不能外发到云端
if (skill === "moderation") { ... }

// ✅ 解释非显而易见的逻辑
// 小模型输出可能带 ```json 标记，需先剥离
const cleaned = raw.replace(/```json?/g, "").replace(/```/g, "");

// ❌ 不解释「是什么」（代码已说明）
// 加载模型
await runtime.load(path);
```

### 8.2 接口文档注释
```typescript
interface ExecutionPlanner {
  /**
   * 制定执行计划（草稿）。
   * 只规划不执行，最终 Plan 由 PolicyEngine 评估。
   */
  plan(input: PlannerInput): Promise<ExecutionPlan>;
}
```

---

## 9. 导入规范

### 9.1 导入顺序
```typescript
// 1. Node 内置
import { promises as fs } from "fs";

// 2. 第三方
import sharp from "sharp";

// 3. 项目内（按分层从上到下）
import { ImageInput } from "../types";
import { VisionProvider } from "../providers/types";
```

### 9.2 禁止跨层导入
见 [分层规则](../02-contracts/03-layer-rules.md)。Lint 配置强制约束。

---

## 10. 文件规模

| 项 | 建议上限 | 理由 |
|----|---------|------|
| 单文件行数 | < 300 行 | 可读性 |
| 单函数行数 | < 50 行 | 单一职责 |
| 函数参数 | < 5 个 | 超过用对象封装 |
| 嵌套深度 | < 4 层 | 提前 return |

---

## 11. 提交前检查清单

- [ ] `pnpm lint` 无错误
- [ ] `pnpm typecheck` 无错误
- [ ] `pnpm test` 通过
- [ ] 无 `any` 类型
- [ ] 无跨层 import
- [ ] 无硬编码配置
- [ ] 无吞错误
- [ ] 日志结构化

---

## 12. 本文小结

编码规范核心：
1. **TypeScript strict** —— 类型安全是底线
2. **术语统一** —— 遵守领域模型术语表
3. **错误分类** —— 可重试/不可重试明确
4. **配置不硬编码** —— 全走 config
5. **结构化日志** —— 不拼接字符串
6. **分层不穿透** —— Lint 强制约束导入
