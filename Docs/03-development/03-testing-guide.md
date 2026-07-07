# 03 - 测试指南（Testing Guide）

> 本文档定义测试策略、分层与规范。质量靠测试保障，不靠运气。

---

## 1. 测试金字塔

```
        ┌───────────┐
        │  E2E (少)  │   真实模型端到端，慢，少量
        └─────┬─────┘
       ┌──────┴──────┐
       │Integration(中)│  模块间协作，Mock 模型
       └──────┬──────┘
      ┌────────┴────────┐
      │  Unit (多，快)   │  单模块逻辑，全 Mock
      └─────────────────┘
```

| 层级 | 占比 | 速度 | 是否调真实模型 |
|------|------|------|--------------|
| Unit | 70% | 毫秒级 | 否（Mock） |
| Integration | 25% | 秒级 | 否（Mock） |
| E2E | 5% | 分钟级 | 是（可选） |

---

## 2. 测试工具

| 用途 | 工具 |
|------|------|
| 测试框架 | Vitest |
| 断言 | Vitest 内置 expect |
| Mock | vi.mock / vi.fn |
| 覆盖率 | Vitest coverage (v8) |
| Fixture | tests/fixtures/ |

---

## 3. 分层测试策略

### 3.1 Unit Test（单元测试）

**目标**：验证单模块逻辑，全 Mock 依赖。

**测试对象**：
```
core/execution-planner      决策逻辑
core/policy-engine          策略匹配
core/response-validator     校验/修复逻辑
core/result-composer        组合逻辑
core/request-normalizer     归一化逻辑
utils/*                     工具函数
```

**示例：ExecutionPlanner 测试**
```typescript
describe("ExecutionPlanner", () => {
  it("意图「提取文字」→ skills 含 ocr", async () => {
    const planner = new ExecutionPlanner(mockIntentMapper);
    const plan = await planner.plan({
      intent: "提取文字",
      image: mockImage,
      metadata: mockMetadata,
      options: {},
      resources: mockResources,
    });
    expect(plan.skills.map(s => s.skill)).toContain("ocr");
  });

  it("图片 width>3000 → preprocess 含 resize", async () => {
    const plan = await planner.plan({
      ...baseInput,
      metadata: { ...mockMetadata, width: 4000 },
    });
    expect(plan.preprocess).toContain("resize");
  });
});
```

**示例：ResponseValidator 测试**
```typescript
describe("ResponseValidator", () => {
  it("输出带 Markdown 标记 → 修复后解析成功", () => {
    const raw = "```json\n{\"category\":\"ui\"}\n```";
    const result = validator.validate(raw, uiSchema);
    expect(result.valid).toBe(true);
    expect(result.data.category).toBe("ui");
  });

  it("必填字段缺失 → 触发重试", () => {
    const raw = '{"theme":"dark"}';  // 缺 layout, components
    const result = validator.validate(raw, uiSchema);
    expect(result.valid).toBe(false);
    expect(result.shouldRetry).toBe(true);
  });
});
```

### 3.2 Integration Test（集成测试）

**目标**：验证模块间协作，Mock 模型推理。

**测试对象**：
```
完整请求流程（Tool → Normalize → Planner → Policy → Pipeline → Provider(Mock)）
Skill Pipeline 编排（串行/并行/条件）
Cache 命中/未命中
Lifecycle 加载/卸载
```

**示例：完整流程集成测试**
```typescript
describe("vision.analyze 集成", () => {
  it("完整流程返回 structuredContent", async () => {
    // Mock Provider 返回合法 JSON
    mockProvider.infer.mockResolvedValue({
      text: '{"category":"dashboard","confidence":0.9}',
      duration: 100,
    });

    const result = await visionAnalyze({
      image: testImageBuffer,
      intent: "auto",
    });

    expect(result.structuredContent.category).toBe("dashboard");
    expect(result.structuredContent.skills.length).toBeGreaterThan(0);
  });

  it("部分 Skill 失败 → 返回 PartialResult", async () => {
    mockProvider.infer
      .mockResolvedValueOnce({ text: '{"category":"document"}' })  // classify 成功
      .mockRejectedValueOnce(new Error("timeout"));                 // ocr 失败

    const result = await visionAnalyze({ image, intent: "extract text" });
    expect(result.structuredContent.result.ocr.partial).toBe(true);
  });
});
```

### 3.3 E2E Test（端到端测试，可选）

**目标**：真实模型推理，验证整体效果。

**特点**：
- 需要真实下载模型（首次较慢）
- 标记为 `@slow`，CI 中可选跳过
- 用固定 fixture 图片，断言关键字段

```typescript
describe("E2E: 真实 SmolVLM 推理", { timeout: 60000 }, () => {
  it("分析 dashboard.png", async () => {
    const result = await visionAnalyze({
      image: "tests/fixtures/dashboard.png",
      intent: "auto",
    });
    expect(result.structuredContent.category).toBe("dashboard");
  });
});
```

---

## 4. Mock 策略

### 4.1 什么该 Mock
```
Provider.infer()       → Mock 返回预设 JSON
Runtime.infer()        → Mock 返回预设输出
ModelManager.ensure()  → Mock 返回假路径
CacheManager.get()     → Mock 命中/未命中
```

### 4.2 什么不该 Mock
```
ExecutionPlanner      → 测试目标本身
PolicyEngine          → 测试目标本身
ResponseValidator     → 测试目标本身
```

### 4.3 Mock Provider 工具
```typescript
// tests/helpers/mock-provider.ts
export function createMockProvider(overrides = {}) {
  return {
    name: "mock",
    load: vi.fn().mockResolvedValue(undefined),
    infer: vi.fn().mockResolvedValue({ text: "{}", duration: 10 }),
    unload: vi.fn().mockResolvedValue(undefined),
    isLoaded: vi.fn().mockReturnValue(true),
    supportedRuntimes: ["onnx"],
    supportedSkills: ["classify"],
    requirements: { minMemoryMB: 0, gpuRequired: false, modelSizeMB: 0 },
    ...overrides,
  };
}
```

---

## 5. Fixture 管理

```
tests/fixtures/
├── images/
│   ├── dashboard.png       仪表盘
│   ├── document.jpg         文档
│   ├── ui-screenshot.png    UI截图
│   ├── chart.png            图表
│   ├── photo.jpg            照片
│   ├── logo.png             Logo
│   └── large-image.png      大图（测试 resize）
├── outputs/
│   ├── dashboard.expected.json    预期输出
│   └── ...
```

**Fixture 命名**：`<类型>-<场景>.<ext>`，如 `ui-dark-theme.png`。

---

## 6. 测试覆盖率要求

| 模块 | 覆盖率要求 |
|------|-----------|
| core/ | ≥ 90% |
| skills/ | ≥ 80% |
| providers/ | ≥ 70% |
| utils/ | ≥ 90% |
| 整体 | ≥ 80% |

```json
// vitest.config.ts
{
  "coverage": {
    "thresholds": {
      "lines": 80,
      "functions": 80,
      "branches": 75
    }
  }
}
```

---

## 7. 测试命名规范

```
describe("模块名")
  it("条件 → 预期行为")
```

```typescript
describe("PolicyEngine", () => {
  it("skill=moderation → provider 强制为本地 smolvlm2", () => { ... });
  it("memory<1GB → 路由器筛选，降级为 smolvlm2", () => { ... });
  it("无策略命中 → 采用草稿 Plan 原样", () => { ... });
});
```

---

## 8. 测试什么（Checklist）

### Planner
- [ ] 各意图 → 正确 Skill 映射
- [ ] auto 模式 → 含 classify
- [ ] 大图 → preprocess 含 resize
- [ ] quality=high + 大模型可用 → 选大模型
- [ ] quality=high + 大模型不可用 → 回退
- [ ] 用户指定 skills → 跳过意图推断
- [ ] 资源不足 → 降级

### PolicyEngine
- [ ] priority 高的先匹配
- [ ] 命中第一个即停
- [ ] deny → 抛 PolicyDeniedError
- [ ] override 覆盖草稿字段
- [ ] 无命中 → 原样返回

### ResponseValidator
- [ ] 合法 JSON → 通过
- [ ] 带 Markdown → 修复后通过
- [ ] 必填缺失 → 重试
- [ ] 可选缺失 → 默认值
- [ ] 重试耗尽 → 失败标记

### SkillPipeline
- [ ] 串行 Skill 按序执行
- [ ] 并行 Skill 同时执行
- [ ] 条件不满足 → 跳过
- [ ] 单 Skill 失败不阻断其他

### CacheManager
- [ ] 相同 key → 命中
- [ ] 不同 key → 未命中
- [ ] TTL 过期 → 失效
- [ ] LRU 满容量 → 淘汰

---

## 9. CI 集成

```yaml
# CI 流程
- pnpm install
- pnpm lint          # Lint 检查
- pnpm typecheck     # 类型检查
- pnpm test:unit     # 单元测试（必须通过）
- pnpm test:integration  # 集成测试（必须通过）
- pnpm test:e2e      # E2E（可选，标记 @slow）
```

---

## 10. 本文小结

测试指南核心：
1. **金字塔** —— Unit 70% / Integration 25% / E2E 5%
2. **Mock 模型** —— 单元/集成测试不依赖真实模型
3. **Fixture 固定** —— 用固定图片保证可复现
4. **覆盖率** —— core ≥90%，整体 ≥80%
5. **命名清晰** —— 「条件 → 预期行为」
6. **CI 强制** —— lint + typecheck + unit + integration 必须通过
