# uiReconstruction 字段契约

> `vision.analyze` 在 UI / screenshot / poster 场景（或 `scene` 含 `ui`/`prototype`）返回 `result.uiReconstruction`：
> 一个供下游 agent（Claude Code / Cursor）一次读完即可复原原 UI 的结构化规格。
> **MCP 不生成代码**；本字段是"看见"层的完整输出，"理解与生成"交给 agent。

---

## 1. 顶层字段

| 字段 | 类型 | 必需 | 说明 |
|------|------|------|------|
| `version` | string | 是 | IR 版本（当前 `1.0.0`），源于 SemanticAST。 |
| `page` | `{ type:'page', layoutType, bbox }` | 是 | 页面根：布局类型（grid/columns/sidebar/centered/split-pane/stack）+ 页面 bbox。 |
| `semantics` | `{ pageType, confidence, summary }` | 否 | 页面语义：pageType（login/list/detail/dashboard/form/setting/table/navigation/unknown）+ 置信度 + 摘要。 |
| `theme` | `{ palette, primary, background, textColor, isDarkMode, contrastRatio }` | 否 | 主题令牌（detect_theme 默认开）。palette 为 `{hex,role}[]`。 |
| `tree` | `ASTNode` | 是 | 组件树根节点（嵌套 children）。**复原结构的核心**。 |
| `constraints` | `CodegenConstraint[]` | 是 | 布局约束：每节点 `{targetId, direction, gap, align}`（detect_layout 默认开）。 |
| `responsive` | `CodegenResponsiveRule[]` | 否 | 响应式断点提示：`{breakpoint, layout}`。 |
| `repeats` | `CodegenRepeat[]` | 否 | 重复项：`{targetId(容器), count, templateId(首项), templateType}`。agent 可据此生成 `.map()`。 |
| `slots` | `CodegenSlot[]` | 否 | 可复用模板：`{id(=templateId), name}`。标出哪些节点是列表项母本。 |
| `images` | `ImageContentInfo[]` | 是 | 图标/图片/Logo 内容：`{index, type, bbox, crop, altText, description?, dataUrl?}`。 |
| `stats` | `{ nodeCount, componentCounts }` | 是 | 规模统计：总节点数 + 各类型计数。 |
| `diagnostics` | `{ skipped: string[] }` | 否 | 降级诊断：列出被跳过的富化阶段（见 §5）。无降级时省略。 |

> `repeats`/`slots`/`responsive` 在默认路径（不传 `export_codegen`）下也会计算并填入，因为 pipeline 内部总会构建 CodegenIR 供 reconstruction 复用。
> UI `detect_*` 选项同时作用于 `result.uiReconstruction`、显式 exporters、`result.uiLayout` 和 `result.parse.uiLayout/design`；它们不删除调用方明确请求的通用 OCR/layout skill 结果。`result.layout` 若来自显式 layout skill 则优先于同名的 OCR 派生布局。

### images 检测语义

- 默认路径先在 400px 工作坐标中做完整边缘扫描，再结合 OCR 覆盖、重复行图标、二维纹理和状态栏位置过滤；输出 bbox/crop 始终恢复为原图坐标。
- OCR 锚定用于拆分“左侧图标 + 右侧标签”的重复菜单；大图片允许包含内嵌 OCR 文案，但不会把邻近文字误写为图片 `altText`。
- 候选不会在像素过滤前提前截断。`mediaAreaFilter` 先按原图颜色实体和二维前景形状剔除边框/文字碎片，再取最多 20 个最终媒体项。
- `type` 的后分类是保守的：明确品牌文字可成为 `logo`，占页面面积至少 2% 且双边至少 96px 的候选可成为 `image`，其余保持 `icon`。
- `detect_text=false` 时不使用 OCR veto，且 `nearbyText` 会清空；因此 CV-only 路径的媒体候选通常多于默认 OCR 路径。

---

## 2. tree 节点结构（ASTNode）

```ts
interface ASTNode {
  id: string;              // 稳定节点 id（repeats/constraints/slots 引用它）
  type: ComponentType;     // 38 类（见 §3）
  bbox: { x, y, w, h };    // 像素坐标（原图坐标系）
  props: Record<string, unknown>;  // 见下
  text?: string;           // 文本内容（文本节点 / 带文字的控件）
  children: ASTNode[];     // 嵌套子节点（包含关系）
}
```

### props 子字段（按需出现）

| 字段 | 类型 | 何时出现 | 说明 |
|------|------|---------|------|
| `style` | `NodeStyle` | 样式采样成功时 | 每节点视觉样式（见下）。 |
| `interactive` | `{ placeholder?, disabled?, link? }` | 检测到交互态时 | input 灰色文字->placeholder；button 灰底->disabled；蓝色文本->link。 |
| `overlay` | `true` | dialog/drawer/bottomSheet | 标记该节点是模态浮层。 |
| `zIndex` | `number` | overlay 节点 | 层叠顺序（当前固定 1000）。 |
| `mask` | `{x,y,w,h}` | dialog | 遮罩层 bbox（drawer/bottomSheet 无 mask）。 |

### NodeStyle

```ts
interface NodeStyle {
  backgroundColor?: string;  // #rrggbb 主色
  borderColor?: string;      // 与背景显著不同时才有
  textColor?: string;        // 文本节点才有
  fontSize?: number;         // 文本节点（≈bbox.h）
  fontWeight?: number;       // 400/700（笔画密度启发式）
  borderRadius?: number;     // 圆角像素（角点切角检测）
  boxShadow?: string;        // CSS shadow 串（外环暗带检测）
}
```
> `borderRadius`/`boxShadow` 是 best-effort 像素启发式，信号缺失时省略（不会给假值）。

---

## 3. ComponentType（38 类）

```
page container header footer navbar sidebar toolbar card section
list listItem table row column grid button iconButton
text title subtitle input textarea checkbox radio switch select dropdown
image avatar icon divider progress badge tag tab
dialog drawer bottomSheet unknown
```

- ast-builder 产出基础类型；type-enricher 二次提升（container->list/toolbar、input->select/textarea、button->iconButton、text->title/subtitle、tag->badge、input->radio/checkbox）。
- overlay-detector 把浮层节点改写为 dialog/drawer/bottomSheet。
- drawer/bottomSheet 除贴边几何外，还必须在扁平 CV region 事实中与另一结构层发生面积重叠；AST 父子包含本身不算层叠证据，相邻的 sidebar/columns/split-pane 也不会仅因贴边而被改写为浮层。dialog 仍要求暗遮罩 + 居中亮卡证据。

---

## 4. 选项对输出的影响

| 选项 | 默认 | 影响 |
|------|------|------|
| `build_tree` | true(scene=ui) | false 时不公开 `result.ui`/`uiReconstruction`；若显式请求 exporter，内部仍保留 AST 完成全部富化后再导出。 |
| `detect_layout` | true | false 时 `result.uiLayout`/`parse.uiLayout` 的 regions 为空，reconstruction 与公开 CodegenIR 的 constraints/responsive 也清空。tree 仍可用作 `build_tree` 的结构骨架。 |
| `detect_component` | true | false 时各公开 UI 分支移除基础组件，并禁用后处理组件/overlay 再推断；同样隐藏依赖 OCR 组件语义的派生 `result.layout/parse.layout`。 |
| `detect_text` | true | false 时各公开 UI 分支移除 UI OCR、component text 和 media nearbyText，并隐藏 OCR 派生 `result.layout/parse.layout`；独立 OCR skill 输出不受影响。 |
| `detect_icon` | true | false 时跳过新媒体检测，且各公开 UI 分支无 mediaAreas/images。 |
| `detect_theme` | true | false 时跳过 design token 提取，且各公开 UI 分支省略 theme/design。 |
| `export_codegen` | false | true 时额外暴露 `result.codegenIr`（reconstruction 内部总会算）。每个 CodegenNode 保留 `bbox` 和可选 `text`，不会丢失 AST 的事实坐标/文案。 |
| `export_figma` / `export_markdown` | false | 额外暴露 `result.figmaJson` / `result.uiMarkdown`。 |
| `use_llm` | false | true 时对 image/icon 区域做 VLM 内容描述（写入 `images[].description`）。 |
| `embed_images` | false | true 时嵌入小图 crop 为 base64 `dataUrl`（≤16KB/张，≤12 张）。 |
| `strict_mode` | false | UI 场景 `build_tree=true` 时校验 uiReconstruction，缺字段或 full-tree stats 不匹配会抛错；summary 模式显式按 root-only 规则校验。UI 场景 `build_tree=false` 时必须至少请求一个 exporter。任意场景只要显式请求 exporter，strict mode 都校验该导出确实生成。 |
| `summary_only` | false | true 时 tree 截断为 root-only（children=[]），清空 constraints/images/repeats/slots/responsive，仅保留 page+semantics+theme+stats+diagnostics 概览；同时不公开 `ui/uiSemantics/codegenIr/figmaJson/uiMarkdown/imageContents/uiLayout/design` 等详细 UI 同级分支。通用 skill 结果保持不变。 |

---

## 5. 降级语义

各富化阶段失败时**不中断整体流程**，对应字段省略 + `diagnostics.skipped` 记录阶段名：

```
mediaAreaFilter | styleExtraction | typeEnrichment | interactivity |
overlayDetection | semanticReinference | imageDescription | imageEmbedding
```

agent 看到 `diagnostics.skipped` 含 `styleExtraction` 时，应预期 tree 节点无 `props.style`（样式采样失败）；含 `imageDescription` 时 `images[].description` 缺失。无 `diagnostics` 字段表示全部阶段成功。

> `strict_mode=true` 时降级不静默：公开 tree 模式缺失必需字段（page/tree/constraints/images/stats）会抛错；private-tree 模式缺失显式请求的 exporter 也会抛错。

---

## 6. agent 复原建议

1. **结构**：遍历 `tree` 的 children 还原嵌套；用 `bbox` 定位，`constraints` 决定排列（row/column/grid + gap）。
2. **列表**：`repeats` 标出的容器是列表，`slots` 标出的 templateId 是列表项母本 → 生成 `.map()` 而非重复节点。
3. **视觉**：每节点 `props.style` 给 bg/border/radius/shadow/text；全局 `theme` 给配色基调。
4. **浮层**：`props.overlay=true` 的节点是模态，`zIndex`/`mask` 还原层叠。
5. **交互态**：`props.interactive` 标 placeholder/disabled/link。
6. **图像**：`images[]` 的 `crop` 是原图坐标裁剪区；有 `dataUrl` 可直接用，有 `description` 是 VLM 描述，否则用 `altText`。

---

## 7. 示例（节选）

```jsonc
{
  "version": "1.0.0",
  "page": { "type": "page", "layoutType": "sidebar", "bbox": { "x":0, "y":0, "w":1280, "h":800 } },
  "semantics": { "pageType": "list", "confidence": 0.67, "summary": "列表页，含 3 个卡片..." },
  "theme": { "palette": [{"hex":"#1677ff","role":"primary"}], "primary":"#1677ff", "background":"#ffffff", "textColor":"#001529", "isDarkMode": false, "contrastRatio": 12.3 },
  "tree": {
    "id": "page", "type": "page", "bbox": {...}, "props": {}, "children": [
      { "id": "r0", "type": "header", "bbox": {...}, "props": { "style": { "backgroundColor":"#1677ff" } }, "children": [] },
      { "id": "list", "type": "list", "bbox": {...}, "props": {}, "children": [
        { "id": "card1", "type": "listItem", "bbox": {...}, "props": { "style": { "backgroundColor":"#ffffff", "borderRadius":9 } }, "text": "商品A", "children": [] }
      ] }
    ]
  },
  "constraints": [ { "targetId": "list", "direction": "column", "gap": 12 } ],
  "repeats": [ { "targetId": "list", "count": 3, "templateId": "card1", "templateType": "listItem" } ],
  "slots": [ { "id": "card1", "name": "listItemTemplate" } ],
  "images": [ { "index": 0, "type": "logo", "bbox": {...}, "crop": {...}, "altText": "Logo" } ],
  "stats": { "nodeCount": 12, "componentCounts": { "page":1, "header":1, "list":1, "listItem":3 } }
}
```
