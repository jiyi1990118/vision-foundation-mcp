# ADR-004: 为什么 Provider 不直接调 Runtime

- **状态**：Accepted
- **日期**：2025-06-30

## 背景

Provider（模型抽象）需要执行推理。是否可以让 Provider 直接 `import onnxruntime` 调用推理引擎，而省去 RuntimeAdapter 这一层？

## 决策

**Provider 不直接调用推理引擎，必须经过 RuntimeAdapter 抽象层。**

```
Provider（模型） ──► RuntimeAdapter（引擎） ──► 实际引擎（ONNX/MLX/llama.cpp）
```

## 理由

### 1. 模型与引擎独立演进
同一个模型（如 SmolVLM）可在不同引擎上跑：
- ONNX Runtime（跨平台，CPU）
- MLX（Apple Silicon 加速）
- llama.cpp（GGUF 生态）

如果 Provider 直接调 ONNX，想换 MLX 就要改 Provider 代码。分离后，只需换 RuntimeAdapter。

### 2. 引擎检测与回退
启动时自动检测可用引擎：
```
有 Apple Silicon → MLX
有 CUDA → ONNX-GPU
否则 → ONNX-CPU（兜底）
```

这个检测逻辑属于 Runtime 层，不应散落在各 Provider 里。

### 3. 资源管理统一
Runtime 层统一管理：
- 模型加载/卸载
- 内存占用统计
- 并发控制
- GPU 内存分配

如果每个 Provider 各自管理，会重复且不一致。

### 4. 新增引擎不影响 Provider
未来新增推理引擎（如 Transformers.js、TensorRT），只需新增 RuntimeAdapter，所有 Provider 自动支持。若 Provider 直接调引擎，新增引擎需改所有 Provider。

### 5. 测试隔离
Mock RuntimeAdapter 即可测试 Provider 逻辑，无需真实引擎。如果 Provider 耦合引擎，测试需真实引擎或复杂 Mock。

## 替代方案

### 方案 B：Provider 直接调引擎
```typescript
// providers/smolvlm/provider.ts （遗留路径示例）
import * as ort from "onnxruntime-node";  // 直接依赖
```
- 优点：少一层抽象，代码少
- 缺点：换引擎需改 Provider；引擎检测散落；资源管理不统一；测试难
- **否决**

### 方案 C：Provider 内置多引擎分支
```typescript
if (runtime === "onnx") { ... }
else if (runtime === "mlx") { ... }
```
- 缺点：Provider 臃肿；新增引擎仍需改 Provider；违反单一职责
- **否决**

## 边界澄清

| 职责 | Provider | Runtime |
|------|----------|---------|
| 声明模型文件 | ✅ | ❌ |
| 输入预处理（图片编码） | ✅ | ❌ |
| 输出解析（原始→文本） | ✅ | ❌ |
| 加载模型到内存 | ❌ | ✅ |
| 执行推理计算 | ❌ | ✅ |
| 引擎检测与选择 | ❌ | ✅ |
| 内存占用统计 | ❌ | ✅ |
| 知道 Skill/Prompt | ❌ | ❌ |

## 影响

- Provider 通过依赖注入获得 RuntimeAdapter
- RuntimeAdapter 实现 `RuntimeAdapter` 接口
- 新增引擎 = 新增 Runtime 目录，不改 Provider
- Provider 声明 `supportedRuntimes`，Planner 匹配

## 相关
- [01-architecture/06-provider-runtime.md](../01-architecture/06-provider-runtime.md)
- [02-contracts/03-layer-rules.md](../02-contracts/03-layer-rules.md)
