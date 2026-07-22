# 高保真 UI 截图复原设计

> 目标：把 UI 截图（App / Web / 桌面软件）解析成可供 Claude Code / Cursor 一次读完即复原的结构化规格，覆盖 icon、含文字 Banner、自定义 checkbox/radio/switch 等复合元素。MCP 不生成业务代码。

## 1. 背景与现状

当前 `vision.analyze` 对 UI 截图已能输出 `result.uiReconstruction`（见 `Docs/02-contracts/04-ui-reconstruction-spec.md`），包含 SemanticAST、布局约束、主题、重复项、浮层、OCR、媒体区域和 Codegen/Figma/Markdown 导出。最近一轮重构补齐了：组件类型富化、浮层检测、重复模板、strict mode、图片描述与嵌入、OCR-aware 媒体过滤。

仍未解决、且直接阻塞"完整复原"的缺口：

1. **检测源单一**：只有 Sharp CV + OCR 启发式，无训练型 UI 检测器；小图标、异形控件、桌面密集工具栏召回有上限。`Detector` 插件接口存在但运行时未真正接入。
2. **AST 父子关系过弱**：`ast-builder.ts` 只允许 region 作为父节点（`containerCount = 1 + regionNodes.length`），detection / media / control 都不能成为父节点。因此 Banner 内文字、IconButton 内 icon、Checkbox + label 等复合关系无法稳定表达。
3. **Banner 整块当图片**：含文字 Banner 常被整体当作不可编辑图片，或文字与背景混在一起，Agent 无法分层复原。
4. **控件状态靠 OCR 关键词**：`type-enricher.ts` 用"多选/checkbox/□"等关键词判断 radio/checkbox，几何形状和像素皮肤完全未读取；switch、indeterminate、disabled、品牌色均未建模。
5. **资产表达不足**：`ImageContentInfo` 只有 bbox + crop + 可选 dataUrl/description，无遮罩、背景层、装饰层、内容寻址、资产清单；大资产无法外部化。
6. **无置信度与兜底决策**：节点没有类型/边界/文字/样式/状态的分项置信度；低置信区域要么静默丢、要么当普通节点，没有明确的 native/hybrid/asset 策略。
7. **无量化验收基准**：现有 16 张真实图只验证"流程不报错 + 可视化叠框"，无标注 bbox/类型/状态/父子关系的发布集，无法度量复原准确率。

## 2. 目标与非目标

### 目标

- 支持单张 UI 截图高保真复原，覆盖 App / Web / 桌面软件。
- 高置信区域输出可编辑组件（结构 + 文字 + 样式 + 状态）；低置信复杂区域保留裁剪资产，但文字、坐标、候选语义、兜底原因仍结构化输出。
- 正确处理三类典型难点：含文字 Banner、Icon / IconButton、自定义 checkbox/radio/switch。
- 完全本地推理（截图不上传）；模型按需下载、SHA-256 校验、离线可降级。
- 量化验收：标注基准 + 分平台准确率门槛。

### 非目标（第一阶段）

- 不生成 React/Vue/HTML 业务代码（MCP 输出规格，Agent 生成代码）。
- 不做生成式 inpainting 伪造资产（单截图无法恢复被文字遮挡的背景像素，整体 crop 兜底）。
- 不承诺识别截图中未出现的交互态（hover/pressed 等），只识别当前可见状态。
- 不做精确字体家族识别或 SVG 自动向量化（留作后续增强）。
- 不做多截图联合分析（单截图优先）。

## 3. 架构路线：混合证据融合

```text
截图
  ├─ PPU Paddle OCR        文字、置信度、原图 bbox
  ├─ Sharp CV              区域、边缘、纹理、颜色（现有 Level-B）
  ├─ UI 专用检测器（按需） button/input/card/banner/control/icon...
  └─ OmniParser sidecar（可选） 小图标、交互热点、icon caption
        ↓
  EvidenceFusionEngine     坐标归一化 + 按类 WBF/NMS + OCR 对齐
        ↓
  CompositionGraphBuilder  contains/overlaps/aligned/labels/decorates/occludes/backgroundOf
        ↓
  ControlAppearanceAnalyzer + StyleExtractor + AssetPipeline
        ↓
  ReconstructionPolicy     per-subtree: native | hybrid | asset | semantic-only
        ↓
  uiReconstruction + assets + quality
```

模型只提供候选事实，确定性引擎决定最终结构。这是与 OmniParser 的根本区别：OmniParser 输出扁平元素列表供 GUI Agent 点击定位；本工具输出层级组件树 + 样式 + 状态 + 资产供 Agent 复原 UI。

## 4. 新增处理模块

### 4.1 DetectorHub（多检测源管理）

- 默认运行现有 Sharp CV + PPU OCR。
- 高保真模式增加本地 UI 专用检测器（ONNX，约 20 类视觉原语：icon/image/logo/avatar/button/input/textarea/checkbox/radio/switch/select/tab/badge/card/list-item/banner-media-container/toolbar/dialog 等）。row/column/grid/formField/menuItem 继续由关系引擎推导。
- OmniParser 仅作为可选的小图标、交互热点和 icon caption 来源，不负责最终 AST。
- 全平台不能只用 Rico（纯 Android 移动端，Web/桌面有领域漂移）；训练与验证数据必须分层覆盖 App、Web、桌面。
- 统一 deadline、abort、内存预算；`Detector` 插件接口正式接入运行链路。
- 模型安装阶段显式下载 + SHA-256 校验；`offline=true` 时只允许本地缓存。

### 4.2 EvidenceFusionEngine（证据融合）

- 统一像素坐标、类别、置信度，采用按类别的 WBF/NMS，而非简单去重。
- 保留每个候选的来源、原始分数、候选类别、冲突原因。
- OCR 不再简单否决媒体区域，而是区分：
  - 媒体内部文字（如 Banner 标题）→ 组合关系引擎判断为可编辑前景文字；
  - 媒体旁边标签 → 绑定为 label；
  - 被误检成 icon 的文字碎片 → 形状 + OCR 覆盖 + 来源共同证明后删除。
- 输出 `EvidenceIR`（与 `VisionIR` 分离，避免污染既有契约）。

### 4.3 CompositionGraphBuilder（复合组件图）

- 先建立关系图，再投影为 AST。关系类型：`contains`、`overlaps`、`alignedWith`、`labels`、`decorates`、`occludes`、`backgroundOf`。
- **任意候选都可成为容器**，不再只有 region 能当父节点。这是解决 Banner/IconButton/FormField/ControlItem 复合关系的关键。
- 支持组合语法：
  - `Banner = backgroundAsset + title + subtitle + CTA + decoration`
  - `IconButton = button + icon`
  - `FormField = label + input/control + helper/error text`
  - `CheckboxItem = checkbox + label`
  - `MenuItem = icon + label + badge`
  - `Card = image + textGroup + action`
- 保留基础 `ComponentType`，用强类型 `semanticRole` 表示复合用途（banner/hero/formField/controlItem/menuItem/cardMedia/decoration/label），避免无限扩展类型枚举。
- AST 是最终树形投影；无法树化的交叠关系保留为引用。

### 4.4 ControlAppearanceAnalyzer（控件外观与状态）

- 不再依赖 OCR 关键词判断 radio/checkbox。
- 从检测框、轮廓和局部像素识别 checkbox/radio/switch 的 family、shape（square/circle/pill/custom）、indicator（check/dot/dash/asset）。
- 输出当前可见状态：`checked`/`unchecked`/`indeterminate`/`disabled`/`focused`。
- 提取品牌填充色、边框、圆角、勾选符号或圆点，并绑定旁边 label。
- 异形控件语义仍输出为原生 control，视觉可用局部资产兜底。

### 4.5 AssetPipeline（分层资产处理）

- 资产不再只有 bbox + 可选 Base64，而是内容寻址的资产清单。
- 资产 kind：`icon | logo | photo | illustration | background | decoration | control-skin | composite`。
- 资产字段：id、kind、bbox、mimeType、uri（本地内容寻址）、dataUrl（仅小资产）、sha256、maskUri、confidence。
- 大资产写入本地缓存并返回可读取 URI；小资产（≤16KB）可按选项内嵌。
- Banner 按复杂度选择：
  - 纯色/渐变背景 → 重建为 CSS + 可编辑文字；
  - 可分离图片背景 → 背景资产 + 可编辑文字；
  - 无法可靠分离 → 整体 Banner crop，内部 OCR 节点保留为 `semantic-only`，避免文字重复渲染。
- Icon 优先输出透明 PNG/精确 crop；高置信时可附图标库候选。

### 4.6 ReconstructionPolicy（置信度与兜底决策）

- 每个节点、属性、关系分别记录置信度及证据来源。
- 自底向上决定每个子树的 render mode：
  - `native`：结构、样式、内容足够可靠。
  - `hybrid`：资产背景 + 原生文字/控件。
  - `asset`：整体 crop 保证视觉完整。
  - `semantic-only`：信息用于理解和可访问性，但不得重复渲染。
- 输出页面覆盖指标：关键元素覆盖率、原生可编辑比例、资产兜底比例、未解释区域比例。
- 低置信区域自动变资产，不静默丢失；`strict_mode` 可按最大未解释面积或关键元素缺失直接失败。

## 5. 公开输出契约

保持现有 `page/tree/constraints/images` 兼容；IR 版本增量升级；新增字段全部可选，旧消费者仍可读取。

### 5.1 AST 节点扩展

```ts
interface ReconstructionNodeProps {
  semanticRole?: 'banner' | 'hero' | 'formField' | 'controlItem'
    | 'menuItem' | 'cardMedia' | 'decoration' | 'label';

  render?: {
    mode: 'native' | 'hybrid' | 'asset' | 'semantic-only';
    assetId?: string;
    reason?: string;
  };

  confidence?: {
    overall: number;
    type?: number;
    bounds?: number;
    text?: number;
    style?: number;
    state?: number;
  };

  evidence?: {
    sources: Array<'cv' | 'ocr' | 'ui-detector' | 'omniparser' | 'pixel' | 'vlm'>;
    ids?: string[]; // 仅 include_evidence 时公开
  };
}
```

组件类型继续描述渲染原语，`semanticRole` 描述复合用途。

### 5.2 控件扩展

```ts
control: {
  family: 'checkbox' | 'radio' | 'switch';
  state: 'checked' | 'unchecked' | 'indeterminate' | 'disabled' | 'focused';
  shape: 'square' | 'circle' | 'pill' | 'custom';
  indicator?: 'check' | 'dot' | 'dash' | 'asset';
  labelNodeId?: string;
  skinAssetId?: string;
}
```

### 5.3 资产清单

```ts
assets: {
  items: Array<{
    id: string;
    kind: 'icon' | 'logo' | 'photo' | 'illustration'
      | 'background' | 'decoration' | 'control-skin' | 'composite';
    bbox: BBox;
    mimeType: string;
    uri: string;       // 本地内容寻址资源
    dataUrl?: string;  // 仅小资产
    sha256: string;
    maskUri?: string;
    confidence: number;
  }>;
};
```

现有 `images[]` 保留为兼容视图。

### 5.4 质量报告

```ts
quality: {
  criticalElementCoverage: number;
  editableElementRatio: number;
  flattenedFallbackRatio: number;
  unexplainedAreaRatio: number;
  warnings: string[];
};
```

### 5.5 样式与布局扩展

- 背景：纯色、线性/径向渐变、图片。
- 边框：宽度、颜色、样式、分边。
- 圆角：四角分别记录。
- 阴影：支持多层。
- 文字：字号、字重、行高、字间距、对齐、装饰、字体候选。
- 布局：padding、gap、row/column/grid、align、justify、wrap、fixed/fill/hug、clip、z-order。
- 图标：caption、是否可交互、本地图标库候选；高置信匹配用矢量库引用，否则透明 crop。

### 5.6 Banner 渲染示例

可分离背景：

```text
section(role=banner, render=hybrid, backgroundAsset=banner-bg)
  title("夏日会员节", render=native)
  subtitle("全场最高立减 50 元", render=native)
  button("立即领取", render=native)
  image(role=decoration, asset=decoration-1)
```

无法分离背景（文字与背景粘连）：

```text
section(role=banner, render=asset, asset=banner-flat)
  title("夏日会员节", render=semantic-only)
  button("立即领取", render=semantic-only)
```

Agent 不会把截图文字和原生文字渲染两次，但仍知道 Banner 的语义与可访问文字。

## 6. 处理数据流

```text
Decode once
  -> multi-scale preprocessing
  -> OCR + CV + UI detector + optional OmniParser in parallel
  -> normalize evidence
  -> fuse boxes/classes/text
  -> build composition graph
  -> resolve component/control semantics
  -> sample styles + extract assets
  -> infer layout/constraints/repeats/overlay
  -> choose render strategy per subtree
  -> validate coverage/references
  -> publish uiReconstruction + assets + quality
```

执行规则：

1. `DetectorHub` 并行运行多来源，统一 deadline/abort/内存预算。
2. UI 检测器只预测视觉原语和控件族，不直接预测所有高阶结构。类别控制在约 20 类。
3. 全平台模型必须分层覆盖 App/Web/桌面，并专门增加小图标、含字 Banner、品牌化选择控件、深色模式、高 DPI。运行时用 ONNX，训练工具链不进 npm 包。
4. OmniParser 作为用户自行安装的本地 sidecar，通过稳定 JSON 协议交互。许可证与权重状态复杂，不把其代码或旧 AGPL detector 打包进当前 MIT 包。
5. 证据融合不采用"一票否决"；OCR 位于媒体内部时由组合关系引擎判断是前景文字还是图片纹理。
6. `CompositionGraph` 先于 AST 构建；AST 是树形投影，无法树化的关系保留为引用。
7. 样式和资产在最终 bbox 确定后提取；单截图无法恢复被遮挡背景像素，不使用生成式 inpainting 伪造资产。
8. `ReconstructionPolicy` 自底向上决定 render mode。

## 7. 运行模式

新增 `options.reconstruction_mode`（`fast` | `balanced` | `high_fidelity`），与现有 `quality` 正交：`quality` 控制 Provider 路由，`reconstruction_mode` 控制 UI 分析深度。

| 档位 | 执行内容 | 用途 |
|---|---|---|
| `fast` | 当前 CV + OCR + 规则 | 快速批处理、无模型环境（默认，向后兼容） |
| `balanced` | CV + OCR + UI ONNX detector | 默认推荐，兼顾部署和识别 |
| `high_fidelity` | balanced + OmniParser/icon caption + 完整资产分析 | 小图标密集、复杂 Banner、桌面软件 |

新增选项：

- `options.detector`: `'cv' | 'ui-onnx' | 'omniparser' | 'auto'`（显式指定检测后端）
- `options.asset_mode`: `'inline' | 'reference' | 'off'`（资产返回方式）
- `options.offline`: `boolean`（仅用本地缓存，无模型则降级或 strict 报错）
- `options.include_evidence`: `boolean`（公开 evidence.ids 用于调试）

完全本地：推理期间不上传截图；模型安装阶段可显式下载并校验。

## 8. 降级与安全

- UI detector 或 OmniParser 不可用时回退 CV/OCR，`diagnostics` 标记模型、原因、受影响能力。
- 多来源类别冲突时保留候选分布；融合层不能仅因模型分数高就覆盖 OCR/像素事实。
- 结构校验错误：bbox 越界、空 crop、引用不存在、asset hash 不匹配、文字被 native 与 asset 重复渲染。
- `strict_mode` 增加质量门槛：指定 detector 成功、关键元素覆盖达标、未解释区域不超阈值、所有资产可读取。
- 模型/资产文件：临时文件 + 原子 rename + SHA-256 校验 + 版本 manifest。
- 推理完全离线；日志不得记录截图、OCR 全文或 Base64。
- 内容寻址资产持久化到本地缓存；显式指定允许目录时才物化到项目目录，不能只返回进程结束后失效的临时路径。

## 9. 验收基准与门槛

### 9.1 数据集

- 开发集 ≥60 张：App/Web/桌面各 20 张。
- 发布锁定集 ≥150 张：三类各 50 张。
- 强制覆盖：中英文、明暗主题、高 DPI、小图标、含字 Banner、自定义 checkbox/radio/switch、弹窗、长列表、密集工具栏。
- 标注：bbox、文字、类型、父子关系、可见状态、资产区域、z-order、允许的 fallback 策略。

### 9.2 第一阶段发布门槛

| 指标 | 门槛 |
|---|---|
| 关键可见元素召回（IoU≥0.5） | ≥95% |
| 清晰文字行召回 | ≥95% |
| 文字字符准确率 | ≥97% |
| 核心组件类型 macro-F1 | ≥0.85 |
| checkbox/radio/switch family+状态准确率 | ≥90% |
| 父子及 label 关系 F1 | ≥0.90 |
| 可编辑元素比例 | ≥80% |
| flattened asset 兜底面积 | ≤20% |
| 重要区域未解释率 | ≤2% |

指标按 App/Web/桌面分别达标，不能用移动端高分掩盖桌面退化。所有资产引用必须有效，Banner 不发生文字双重渲染。

### 9.3 验证层次

- 单元测试：坐标、融合、关系、状态、render policy。
- 合成像素测试：渐变 Banner、异形控件、遮挡、alpha。
- detector 离线 benchmark：每类 precision/recall、small-object AP。
- golden IR：同图输出确定、schema 和引用稳定。
- 固定参考 renderer：将 IR 重绘后做叠图、SSIM/差异热图；仅用于验收，不改变"MCP 不生成业务代码"边界。
- 现有 16 张真实图继续作为回归集，不能替代有标注的发布集。

## 10. 实施顺序

```text
P0  基准与新契约
    EvidenceIR / CompositionGraph / assets / confidence / quality schema
    + 标注规范和 reference renderer

P1  不依赖新模型的结构升级
    任意候选父子关系（修复 ast-builder containerCount 限制）
    + Banner/IconButton/FormField/ControlItem 复合语法
    + asset resource 和 native/hybrid/asset policy

P2  控件与视觉复原
    checkbox/radio/switch family+state
    + gradient/border/typography/padding/z-order/object-fit
    + Banner 分层与防重复渲染

P3  模型增强
    本地跨平台 UI ONNX detector
    + DetectorHub/EvidenceFusion
    + 可选 OmniParser sidecar/icon caption

P4  达标与发布
    150 张锁定集
    + 分平台阈值
    + 性能/内存/离线/许可证审计
```

关键原则：**先建融合、关系和兜底契约，再接 YOLO/OmniParser**。否则新模型只会向当前扁平 AST 塞更多互相冲突的框，并不能解决 Banner、IconButton 和选择控件的完整复原。

## 11. 备选方案与取舍

- **纯规则增强**：只补 Banner/控件状态/样式/资产切图规则，不引入训练模型。部署最轻，但极小图标、异形复选框、桌面密集控件仍有明显上限。不推荐。
- **像素分块优先**：复杂区域尽量整体裁剪，只抽少量文字和热点。视觉最稳，但不符合"Agent 能编辑和重组 UI"的长期目标。不推荐。
- **混合证据融合（推荐）**：保留 CV/OCR 快速路径，高保真模式增加本地检测器和可选 OmniParser，统一融合、复合解析、资产兜底。兼顾保真、可编辑、部署。

## 12. 与 OmniParser 的关系

OmniParser 是"屏幕操作定位器"，本工具是"UI 结构重建器"。OmniParser 的检测能力（小图标、交互热点、icon caption）可以补强本工具，但其扁平元素列表不足以替代本工具的层级组件树、布局约束、样式主题、重复模板、响应式、浮层、Codegen/Figma 导出。

集成边界：

1. 只接入 OmniParser detector/caption API，不接入 OmniTool。
2. 保留当前 PPU OCR，避免默认英文 OCR 退化。
3. OmniParser 归一化 `xyxy` 转换为原图像素 `xywh`。
4. 检测结果映射进 `EvidenceIR`，与 OCR 及现有媒体候选执行 IoU 去重。
5. 保留 source、置信度、interactivity、caption。
6. 继续由本工具 AST、布局、样式、约束、exporter 负责最终输出。
7. 许可证明确前，只作为用户自行部署的外部 sidecar，不把代码和权重打包进 npm。

## 13. 许可证考量

- 当前项目根许可证：MIT。
- OmniParser 仓库根 LICENSE 实际是 CC-BY-4.0（README badge 标 MIT，不一致）；旧 Ultralytics detector 权重为 AGPL-3.0；Florence caption 权重为 MIT；最新 `icon_detect_v3` 声明基于 MIT 许可的 YOLOv9，但截至 2026-07-21 仍通过 HF PR #37 提供，未正式合入主分支。
- 若自训练 UI 检测器，优先选用 MIT/Apache-2.0 许可的模型架构与数据集（Rico 为 CC-BY-SA 4.0，需确认衍生权重许可）。
- 重新分发任何第三方权重前，必须逐项确认文件级授权说明。
