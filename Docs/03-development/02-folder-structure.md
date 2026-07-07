# 02 - 目录结构（Folder Structure）

> 本文档定义项目目录组织。目录结构反映架构分层，新增文件必须放对位置。

---

## 1. 完整目录树

```
vision-foundation-mcp/
│
├── src/                        源码
│   ├── core/                   L1-L2 核心引擎
│   │   ├── request-normalizer.ts
│   │   ├── metadata-extractor.ts
│   │   ├── execution-planner.ts
│   │   ├── policy-engine.ts
│   │   ├── skill-pipeline.ts
│   │   ├── response-validator.ts
│   │   ├── result-composer.ts
│   │   ├── lifecycle-manager.ts
│   │   └── cache-manager.ts
│   │
│   ├── skills/                 L3 Skill 插件（每个子目录一个 Skill）
│   │   ├── classify/
│   │   │   ├── skill.json
│   │   │   ├── prompt.md
│   │   │   ├── schema.json
│   │   │   ├── validator.ts
│   │   │   └── postprocess.ts
│   │   ├── ocr/
│   │   ├── ui/
│   │   ├── chart/
│   │   ├── color/
│   │   ├── summary/
│   │   └── ...
│   │
│   ├── providers/              L4 Provider 插件
│   │   ├── smolvlm2/          （默认，SmolVLM2-500M-Video）
│   │   │   └── provider.ts
│   │   ├── gguf/              （SmolVLM-500M fast 候选）
│   │   ├── minicpm/          （高质量，MiniCPM-V 2.6）
│   │   ├── smolvlm/          （遗留，ONNX/Transformers.js）
│   │   └── llama-server/     （共享 LlamaServerProcess）
│   │
│   ├── runtime/                L5 Runtime 插件
│   │   ├── onnx/
│   │   ├── llamacpp/
│   │   ├── mlx/
│   │   └── transformers/
│   │
│   ├── models/                 L6 模型管理
│   │   ├── manager.ts
│   │   ├── registry.ts
│   │   └── downloader.ts
│   │
│   ├── tools/                  L0 MCP Tool
│   │   └── vision.analyze.ts
│   │
│   ├── types/                  全局类型定义（契约）
│   │   ├── domain.ts           领域模型实体
│   │   ├── api.ts              API 契约
│   │   └── config.ts           配置类型
│   │
│   └── utils/                  工具函数（无业务逻辑）
│       ├── image.ts            图片处理工具
│       ├── hash.ts             哈希工具
│       └── logger.ts           日志工具
│
├── prompts/                    Prompt Registry（Skill 共享）
│   ├── classify.md
│   ├── ui.md
│   └── ...
│
├── schemas/                    Schema Registry（Skill 共享）
│   ├── classify.schema.json
│   ├── ui.schema.json
│   └── ...
│
├── config/                     配置文件
│   ├── policy.yaml             策略配置
│   ├── providers.yaml          Provider 注册表
│   ├── runtime.yaml            Runtime 配置
│   ├── lifecycle.yaml          生命周期配置
│   └── cache.yaml              缓存配置
│
├── tests/                      测试
│   ├── unit/                   单元测试
│   ├── integration/            集成测试
│   └── fixtures/               测试图片等
│
├── Docs/                       设计文档（本目录）
├── examples/                   使用示例
├── scripts/                    构建脚本
│
├── package.json
├── tsconfig.json
├── .eslintrc.json
├── .prettierrc
└── README.md
```

---

## 2. 目录职责说明

### 2.1 src/core/（核心引擎）
放置 L1-L2 的核心模块。这些模块**稳定**，不随 Skill/Provider 增减而改动。

```
request-normalizer     L1 输入归一化
metadata-extractor     L1 元数据提取
execution-planner      L2 执行规划器（大脑）
policy-engine          L2 策略引擎
skill-pipeline         L3 Skill 编排器
response-validator     L3 响应校验器
result-composer        L3 结果组合器
lifecycle-manager      L6 生命周期管理
cache-manager          L6 缓存管理
```

### 2.2 src/skills/（Skill 插件）
每个 Skill 一个子目录。**新增 Skill = 新增目录**，不改 core。

### 2.3 src/providers/（Provider 插件）
每个 Provider 一个子目录。**新增模型 = 新增目录**。

### 2.4 src/runtime/（Runtime 插件）
每个 Runtime 一个子目录。**新增引擎 = 新增目录**。

### 2.5 src/types/（类型契约）
全局共享的类型定义。各层通过 import 此处类型，**避免循环依赖**。

### 2.6 prompts/ 与 schemas/（注册表）
与 skills/ 目录下的 prompt.md/schema.json 的关系：

```
方案 A（推荐，V1 采用）：Skill 自带
  skills/ui/prompt.md
  skills/ui/schema.json
  → Skill 自包含，便于作为插件分发

方案 B（备选）：集中注册表
  prompts/ui.md
  schemas/ui.schema.json
  → 便于统一管理，但 Skill 不自包含
```

V1 采用方案 A（Skill 自包含），prompts/ 和 schemas/ 目录保留用于跨 Skill 共享的通用 Prompt/Schema。

---

## 3. 文件放置规则

### 3.1 「这个文件该放哪」决策树
```
是新 Skill 吗？           → src/skills/<name>/
是新 Provider 吗？        → src/providers/<name>/
是新 Runtime 吗？         → src/runtime/<name>/
是核心引擎模块吗？        → src/core/
是类型/接口定义吗？       → src/types/
是无业务逻辑的工具吗？    → src/utils/
是配置吗？               → config/
是测试吗？               → tests/
是文档吗？               → Docs/
```

### 3.2 禁止的放置
- ❌ Skill 的 prompt 放到 src/core/
- ❌ Provider 代码放到 src/skills/
- ❌ 业务逻辑放到 src/utils/
- ❌ 配置硬编码到 src/ 任意文件

---

## 4. 导入路径规则

### 4.1 相对路径
```typescript
// 同层
import { ImageInput } from "../types";

// 上层
import { VisionProvider } from "../../providers/types";
```

### 4.2 禁止跨层路径
ESLint 配置强制约束：

```javascript
// .eslintrc.js
{
  "no-restricted-imports": ["error", {
    "patterns": [
      // skills 禁止 import runtime
      { "group": ["*/runtime/*"], "message": "Skill 禁止直接依赖 Runtime，须经 Provider" }
    ]
  }]
}
```

详见 [分层规则](../02-contracts/03-layer-rules.md)。

---

## 5. 命名约定

### 5.1 目录命名
```
kebab-case:  skill-pipeline, response-validator
Skill/Provider/Runtime 名: lowercase: smolvlm2, gguf, minicpm
```

### 5.2 入口文件命名
```
index.ts       目录入口（Provider/Runtime）
provider.ts    Provider 实现
manager.ts     管理器
```

---

## 6. 新增模块流程

### 新增 Skill
```
1. mkdir src/skills/my-skill/
2. 创建 skill.json / prompt.md / schema.json
3. （可选）创建 validator.ts / postprocess.ts
4. 在 config/intents.yaml 添加意图映射
5. 写测试 tests/unit/skills/my-skill.test.ts
6. 不需要改 core/skill-pipeline.ts
```

### 新增 Provider
```
1. mkdir src/providers/my-provider/
2. 创建 provider.ts（实现 VisionProvider）
3. 创建 config.json（模型配置）
4. 在 config/providers.yaml 注册
5. 不需要改 core/execution-planner.ts
```

### 新增 Runtime
```
1. mkdir src/runtime/my-runtime/
2. 创建 index.ts（实现 RuntimeAdapter）
3. 在 config/runtime.yaml 注册
4. 在相关 Provider 的 supportedRuntimes 添加
```

---

## 7. 测试目录镜像

测试目录结构与 src 镜像，便于定位：

```
tests/
├── unit/
│   ├── core/
│   │   ├── execution-planner.test.ts
│   │   └── policy-engine.test.ts
│   ├── skills/
│   │   ├── classify.test.ts
│   │   └── ocr.test.ts
│   └── providers/
│       └── smolvlm2.test.ts
├── integration/
│   └── vision-analyze.test.ts
└── fixtures/
    ├── dashboard.png
    └── document.jpg
```

---

## 8. 本文小结

目录结构核心：
1. **目录反映分层** —— src/core / skills / providers / runtime 对应 L1-L5
2. **插件即目录** —— 新增能力 = 新增目录，不改 core
3. **类型集中** —— src/types 避免循环依赖
4. **配置分离** —— config/ 与代码分离
5. **测试镜像** —— tests 结构镜像 src
6. **Lint 强制** —— 跨层导入由 ESLint 拦截
