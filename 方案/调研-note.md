# 调研笔记 — Stream S6 外部可行性调研

> **产出方**：调研 Agent（S6）
> **日期**：2026-07-17
> **用途**：为后续导出层（S3 Figma 导出）与可选检测模型（UI-6 YOLO）提供决策输入
> **项目**：vision-foundation-mcp（TypeScript MCP，sharp + PaddleOCR）
> **关联方案**：`方案/02-开发实施方案.md`（S0 IR 契约 / S3 导出层 / UI-6 可选）

---

## 信息来源与时效说明

| 类别 | 来源 | 时效 |
|------|------|------|
| Figma 节点结构 | Figma 官方 Developer Docs：REST API `file-node-types`、Plugin API `FrameNode`/`TextNode`/`ComponentNode`/Shared Node Properties | 2026-07-17 抓取，反映当前线上文档 |
| Rico 数据集 | interactionmining.org/rico 官网、`google-research-datasets/rico_semantics` GitHub 仓库、原始论文 (UIST'17) | 2017 发布，至今未更新；本笔记采用最新公开页面数据 |
| Enrico | `userinterfaces.aalto.fi/enrico`、`luileito/enrico` GitHub | 2020 发布 |
| YOLO11 / RT-DETR | Ultralytics 官方文档 `docs.ultralytics.com/models/yolo11`、`/compare/rtdetr-vs-yolo11`、`/models/sam-2` | 2026-07-17，反映 YOLO11 当前 release |
| SAM2 / GroundingDINO | Ultralytics SAM2 文档、IDEA-Research/GroundingDINO 仓库、arXiv 2303.05499、NVIDIA NGC/TAO 卡 | 2024–2026 公开资料 |

> **标注约定**：✅ = 基于最新公开官方资料/文档；📖 = 通用知识 / 官方论文；⚠️ = 风险/未验证点。

---

# 主题 1：Figma JSON 节点规范

## 结论

✅ **推荐采纳 REST API 节点结构作为 `SemanticAST -> Figma JSON` 的导出目标**，理由：Figma REST API 的节点树是事实标准、字段稳定、可被 GET `/v1/files/:key` 校验。
⚠️ 关键约束：**Figma REST API 是只读的，不存在"导入整份文件 JSON"的端点**；导出层产出的 `Figma JSON` 用于 (a) 结构校验 + 下游消费/版本对比，(b) 由一个在 Figma 内运行的 **Plugin**（调用 `figma.createFrame()/createText()/createRectangle()`）逐节点重建。字段名在 REST 与 Plugin API 间大体一致，但有差异（见末尾"REST vs Plugin 差异表"），导出层应以 **REST API 形态**为契约目标。

## 详细发现

### 1.1 节点类型清单（REST API `type` 字符串）

| Figma `type` | 语义 | SemanticAST 对应（建议，D7 未冻结前为提案） |
|---|---|---|
| `FRAME` | 容器，类似 `<div>`；可挂自动布局 | screen / section / card / dialog / toolbar / navbar / sidebar / footer / button / input / tab / list-item |
| `RECTANGLE` | 矩形形状（含图片填充） | image / media / divider / 背景 / input 边框 |
| `TEXT` | 文本节点 | text / label / heading / paragraph / caption |
| `VECTOR` | 矢量路径 | icon（矢量图标）/ decorative-shape |
| `ELLIPSE` / `LINE` / `POLYGON` / `STAR` | 基本形状 | avatar（圆形）/ divider（水平线） |
| `GROUP` | 透明分组容器（无自身填充） | 无独立填充的语义分组 |
| `COMPONENT` | 可复用组件母版（结构与 Frame 相同） | 被标记为 reusable 的 button / icon-button / tab 等 |
| `COMPONENT_SET` | 组件变体容器 | 同一组件的尺寸/状态变体集合 |
| `INSTANCE` | 组件实例 | 引用某 COMPONENT 的复用实例 |

### 1.2 关键字段总览（按字段名）

| 字段 | 类型 | 适用节点 | 说明 |
|---|---|---|---|
| `id` | string（如 `1:3`） | 全部 | 唯一标识；Plugin 侧 readonly |
| `name` | string | 全部 | 图层名（面板显示） |
| `type` | string enum | 全部 | 节点类型（见 1.1） |
| `visible` | boolean | 全部 | 是否可见 |
| `opacity` | number (0–1) | 全部 | 透明度 |
| `blendMode` | enum (`PASS_THROUGH`/`NORMAL`/`MULTIPLY`...) | 全部 | 混合模式 |
| `absoluteBoundingBox` | `{x,y,width,height}` | 全部（绝对坐标） | **不含**阴影/描边的包围盒；不可见时为 `null` |
| `absoluteRenderBounds` | `{x,y,width,height}` | 全部 | 含阴影/粗描边的实际渲染边界；不可见时为 `null` |
| `relativeTransform` | `[[a,b,c],[d,e,f]]`（2×3 矩阵） | 全部 | 相对父节点的 2D 变换矩阵 |
| `constraints` | `{vertical,horizontal}` | 子节点 | 约束（见 1.6） |
| `fills` | `Paint[]`（默认 `[]`） | FRAME/RECTANGLE/TEXT/VECTOR/COMPONENT/INSTANCE | 填充数组（见 1.5） |
| `strokes` | `Paint[]` | 同 fills 可填充节点 | 描边填充 |
| `strokeWeight` | number | 同上 | 描边粗细 |
| `strokeAlign` | `INSIDE`/`OUTSIDE`/`CENTER` | 同上 | 描边对齐 |
| `cornerRadius` | number | FRAME/RECTANGLE/COMPONENT/INSTANCE | 统一圆角半径 |
| `rectangleCornerRadii` | `[tl,tr,br,bl]` | FRAME/RECTANGLE/COMPONENT/INSTANCE | 四角独立圆角（覆盖 cornerRadius） |
| `clipsContent` | boolean | FRAME | 是否裁剪超出边界的内容 |
| `overflowDirection` | `NONE`/`HORIZONTAL_SCROLLING`/`VERTICAL_SCROLLING`/`BOTH` | FRAME | 滚动溢出方向 |
| `children` | `Node[]` | FRAME/COMPONENT/INSTANCE/GROUP | 子节点数组 |
| `characters` | string | TEXT | 文本内容 |
| `style` | object | TEXT | 文本样式（见 1.4） |
| `componentId` | string | INSTANCE | 引用的 COMPONENT id |
| `componentProperties` | `{name:{type,value}}` | INSTANCE | 实例覆写属性 |
| `vectorData` | `{paths:[{path,windingRule}]}` | VECTOR | 矢量路径数据 |

### 1.3 Frame 自动布局字段（Flex/Grid 表达）✅

> 这是 SemanticAST 约束引擎输出 `{direction, gap, align}` 的直接落点。

| 字段 | 类型 / 枚举 | 对应 CSS/Flex 概念 |
|---|---|---|
| `layoutMode` | `NONE` / `HORIZONTAL` / `VERTICAL` | `flex-direction: row / column`；`NONE`=绝对定位（手摆） |
| `itemSpacing` | number | `gap` |
| `counterAxisSpacing` | number | 交叉轴 gap（wrap 换行时） |
| `primaryAxisAlignItems` | `MIN` / `CENTER` / `MAX` / `SPACE_BETWEEN` | `justify-content` |
| `counterAxisAlignItems` | `MIN` / `CENTER` / `MAX` / `BASELINE` | `align-items` |
| `primaryAxisSizingMode` | `FIXED` / `AUTO`（新版 `MAX`） | 主轴尺寸：固定 vs 拥抱内容 |
| `counterAxisSizingMode` | `FIXED` / `AUTO`（新版 `MAX`） | 交叉轴尺寸 |
| `layoutSizingHorizontal` | `FIXED` / `HUG` / `FILL` | 横向尺寸简写（`FILL`≈`flex:1`，`HUG`≈`fit-content`） |
| `layoutSizingVertical` | `FIXED` / `HUG` / `FILL` | 纵向尺寸简写 |
| `layoutWrap` | `NO_WRAP` / `WRAP` | `flex-wrap` |
| `paddingTop/Bottom/Left/Right` | number | `padding-*` |
| `itemPositioning` | `AUTO` / `ABSOLUTE` | 子项是参与流式布局还是绝对定位 |

**Grid 提示** ⚠️：Figma 的原生 Grid 是 `layoutGrids`（视觉栅格辅助线），**不是** CSS Grid 的行列自动布局。真正的"行列自适应"需用嵌套 FRAME + 自动布局模拟；SemanticAST 的 `layoutType=grid` 应映射为「父 FRAME(layoutMode=NONE 或 VERTICAL) + 每行一个子 FRAME(layoutMode=HORIZONTAL)」的嵌套结构，而非单一字段。

### 1.4 Text 节点 `style` 子对象（REST API 嵌套，Plugin API 平铺）✅

> Plugin API 中这些字段是 TextNode 的直接属性；REST API 把它们收进 `style` 对象。

| `style` 字段 | 类型 / 枚举 | 来源 |
|---|---|---|
| `fontFamily` | string | style.fontName.family |
| `fontPostScriptName` | string | — |
| `fontWeight` | number（如 400=Regular, 700=Bold） | ✅ 官方 |
| `fontSize` | number（最小 1） | ✅ 官方 |
| `textCase` | `ORIGINAL`/`UPPER`/`LOWER`/`TITLE`/`SMALL_CAPS`/`SMALL_CAPS_FORCED` | ✅ 官方 |
| `textDecoration` | `NONE`/`STRIKETHROUGH`/`UNDERLINE` | ✅ 官方 |
| `textAlignHorizontal` | `LEFT`/`CENTER`/`RIGHT`/`JUSTIFIED` | ✅ 官方 |
| `textAlignVertical` | `TOP`/`CENTER`/`BOTTOM` | ✅ 官方 |
| `lineHeightPx` | number | `lineHeight:{value,unit:'PIXELS'}` 的 value |
| `lineHeightPercent` | number | `unit:'PERCENT'` 的 value |
| `lineHeightUnit` | enum | `PIXELS`/`PERCENT`/`AUTO` |
| `letterSpacing` | number | `LetterSpacing.value` |
| `letterSpacingUnit` | enum | `PERCENT`/`PIXELS` |
| `paragraphSpacing` | number | 段间距 |
| `paragraphIndent` | number | 段首缩进 |
| `textAutoResize` | `NONE`/`WIDTH_AND_HEIGHT`/`HEIGHT`/`TRUNCATE` | 文本框自适应行为 |
| `maxLines` | number / null | 仅 `textTruncation='ENDING'` 时生效 |
| `fills`（顶层数组，非 style 内） | `Paint[]` | 文本颜色（取 solid） |

### 1.5 Paint（fills/strokes）结构 ✅

> ⚠️ **颜色通道是 0–1 浮点（`r,g,b,a ∈ [0,1]`），不是 0–255**。导出层必须做 `value/255` 换算。

```jsonc
// Solid（实色）— 最常用
{ "type": "SOLID", "color": { "r": 0.098, "g": 0.463, "b": 0.824, "a": 1 }, "opacity": 1, "visible": true }

// 线性渐变
{ "type": "GRADIENT_LINEAR",
  "gradientStops": [ { "position": 0, "color": {"r":0,"g":0,"b":0,"a":1} } ],
  "gradientHandlePositions": [ {"x":0,"y":0}, {"x":1,"y":0}, {"x":0,"y":0} ] }

// 图片填充（用于 image / 媒体节点）
{ "type": "IMAGE", "scaleMode": "FILL"|"FIT"|"CROP"|"TILE",
  "imageRef": "<figma image ref hash>" }
```

`Color` 类型恒为 `{ r: number, g: number, b: number, a: number }`（0–1）。

### 1.6 约束（LayoutConstraint）✅

子节点 `constraints`（非自动布局时生效）：

| 轴 | 枚举 | 语义 |
|---|---|---|
| `vertical` | `TOP`/`BOTTOM`/`CENTER`/`SCALE`/`TOP_BOTTOM` | 顶/底/中/缩放/两端 |
| `horizontal` | `LEFT`/`RIGHT`/`CENTER`/`SCALE`/`LEFT_RIGHT` | 左/右/中/缩放/两端 |

自动布局子节点的尺寸/拉伸用：
- `layoutGrow: number`（0=固定，1=沿主轴拉伸，≈ `flex-grow`）
- `layoutAlign: 'MIN'|'CENTER'|'MAX'|'STRETCH'|'INHERIT'`（交叉轴对齐，≈ `align-self`）
- `layoutPositioning: 'AUTO'|'ABSOLUTE'`

### 1.7 绝对定位 vs 自动布局（导出层关键决策）⚠️

SemanticAST 的 `bbox` 是**绝对像素坐标**。但 Figma 的"地道"表达是**自动布局**（layoutMode + 间距 + 对齐），由引擎重算子节点位置，而非手填每个子节点的 `x/y`。

**导出层建议**：
1. 容器优先用 `layoutMode=HORIZONTAL/VERTICAL` + `itemSpacing` + `primaryAxisAlignItems` + `counterAxisAlignItems`，把父子空间关系翻译成 Flex 语义（这正好匹配 S1 约束引擎输出的 `{direction, gap, align}`）。
2. 仅当语义上确实是"自由定位/重叠层"时，才用 `layoutMode=NONE` + 子节点 `absoluteBoundingBox`/`relativeTransform` 手填坐标（如 absolute 装饰、浮层、背景图）。
3. `absoluteBoundingBox` 在自动布局下是**派生值**（Figma 自动算），导出层写入会被忽略——所以自动布局容器内子节点**不要**写 `absoluteBoundingBox`，只写 `width/height`（经 `layoutSizingHorizontal/Vertical` 或 `constraints`）。

---

## 字段映射表（SemanticAST → Figma JSON）

> SemanticAST 节点形态（取自 `方案/02-开发实施方案.md` §Wave1 S0）：
> `{ id: string, type: ASTNodeType, bbox: {x,y,w,h}, props: {...}, children: ASTNode[] }`
> ASTNodeType 为 30+ 类枚举（D7，尚未冻结，下表 `→ Figma type` 列为导出层提案）。

### 表 A — 节点类型映射 + 通用字段

| SemanticAST `type`（提案） | → Figma `type` | 取 Figma 哪些字段 | 备注 |
|---|---|---|---|
| `screen` | `FRAME`（顶层） | bbox, fills(背景), layoutMode, clipsContent:true | 顶层画板，原点 (0,0) |
| `section` / `card` / `dialog` / `toolbar` / `navbar` / `sidebar` / `footer` / `list-item` | `FRAME` | bbox, fills, cornerRadius, strokes, layoutMode, padding*, itemSpacing | 容器语义；card 通常有 cornerRadius+阴影(effects) |
| `button` / `icon-button` / `tab` | `FRAME`（或 `COMPONENT` 若 reusable） | bbox, fills, cornerRadius, strokes, layoutMode=HORIZONTAL, primaryAxisAlignItems=CENTER, counterAxisAlignItems=CENTER, padding* | 按钮内文+图标横排居中 |
| `input` / `text-field` / `search-bar` | `FRAME` | bbox, fills, cornerRadius, strokes, layoutMode, padding* | 内含 1 个 TEXT 子节点 |
| `text` / `label` / `heading` / `paragraph` / `caption` | `TEXT` | bbox, characters, style{...}, fills(文字色) | 见表 C |
| `image` / `media` / `avatar`(矩形) | `RECTANGLE` | bbox, fills(IMAGE or SOLID), cornerRadius | 图片用 IMAGE paint |
| `avatar`(圆形) | `ELLIPSE` | bbox, fills | — |
| `divider` | `RECTANGLE`（或 `LINE`） | bbox, height≈1/2, fills | — |
| `icon`(矢量) | `VECTOR` | bbox, fills | 需 vectorData.paths（导出层可先填占位几何） |
| `background` / 装饰矩形 | `RECTANGLE` | bbox, fills, cornerRadius | — |
| 语义分组（无填充） | `GROUP` | bbox, children | 透明容器 |
| 可复用组件母版 | `COMPONENT` | 同 FRAME 字段集 | — |
| 组件实例 | `INSTANCE` | 同 FRAME + componentId + componentProperties | — |

> ⚠️ 所有节点的 `bbox.{x,y,w,h}` → 写入 `absoluteBoundingBox:{x,y,width,height}`（仅 `layoutMode=NONE` 时有意义；自动布局容器内子节点只写 `width/height`）。

### 表 B — 容器（FRAME）自动布局字段映射

| SemanticAST 约束引擎输出（S1）| → Figma 字段 | 取值规则 |
|---|---|---|
| `direction: 'row'` | `layoutMode: 'HORIZONTAL'` | — |
| `direction: 'column'` | `layoutMode: 'VERTICAL'` | — |
| 无方向 / 自由定位 | `layoutMode: 'NONE'` | 子节点走绝对坐标 |
| `gap` | `itemSpacing: <number>` | 主轴间距 px |
| `align.main: 'start/center/end/space-between'` | `primaryAxisAlignItems: 'MIN/CENTER/MAX/SPACE_BETWEEN'` | justify-content |
| `align.cross: 'start/center/end/baseline'` | `counterAxisAlignItems: 'MIN/CENTER/MAX/BASELINE'` | align-items |
| `padding: {top,right,bottom,left}` | `paddingTop/paddingRight/paddingBottom/paddingLeft` | — |
| `wrap: true` | `layoutWrap: 'WRAP'` + `counterAxisSpacing` | flex-wrap |
| 子节点 `flex-grow>0` | 子节点 `layoutGrow: 1` | 沿主轴拉伸 |
| 子节点 `align-self` | 子节点 `layoutAlign` | 交叉轴单点对齐 |
| `grid` 布局 | 父 `VERTICAL` + 每行子 `FRAME(HORIZONTAL)` | 嵌套模拟（见 1.7 提示） |

### 表 C — Text 节点映射

| SemanticAST `props`（OCR/排版引擎 S1）| → Figma `TEXT` 字段 | 路径 |
|---|---|---|
| `text` / `content` | `characters` | 顶层 |
| `fontSize` | `style.fontSize` | style 内 |
| `fontWeight`（400/700…） | `style.fontWeight` | style 内 |
| `fontFamily` | `style.fontFamily`（+`style.fontPostScriptName`） | style 内 |
| `lineHeight`（px） | `style.lineHeightPx` + `style.lineHeightUnit:'PIXELS'` | style 内 |
| `lineHeight`（%） | `style.lineHeightPercent` + `style.lineHeightUnit:'PERCENT'` | style 内 |
| `letterSpacing` | `style.letterSpacing` + `style.letterSpacingUnit` | style 内 |
| `textAlign`（left/center/right/justify）| `style.textAlignHorizontal` | style 内 |
| `color`（0–255 或 hex） | `fills:[{type:'SOLID',color:{r,g,b,a},opacity}]` | 顶层 fills（**非** style 内） |
| `textTransform` | `style.textCase` | style 内 |
| `textDecoration` | `style.textDecoration` | style 内 |
| bbox | `absoluteBoundingBox`（或 width/height + textAutoResize='HEIGHT'） | 顶层 |

### 表 D — 颜色/描边/效果映射

| SemanticAST 来源 | → Figma 字段 | 换算 |
|---|---|---|
| design-extractor 调色板色值（0–255 / hex） | `fills:[{type:'SOLID',color:{r,g,b,a}}]` | `r=ch/255`；`a=opacity` |
| 边框/描边色 + 宽度 | `strokes:[{type:'SOLID',color}]` + `strokeWeight` + `strokeAlign` | — |
| 阴影 | `effects:[{type:'DROP_SHADOW',color:{r,g,b,a},offset:{x,y},radius,spread,visible,blendMode}]` | 顶层 effects 数组 |
| 圆角（统一） | `cornerRadius` | — |
| 圆角（四角不同） | `rectangleCornerRadii:[tl,tr,br,bl]` | 覆盖 cornerRadius |

### 表 E — REST API vs Plugin API 差异（导出层对齐注意）⚠️

| 维度 | REST API（GET /files） | Plugin API（运行于 Figma 内） |
|---|---|---|
| 位置 | `absoluteBoundingBox` {x,y,width,height} | `x`/`y`/`width`/`height`（`absoluteBoundingBox` readonly） |
| 文本样式 | 收进 `style` 对象 | `fontSize`/`textAlignHorizontal` 等是节点直接属性 |
| 颜色 | `fills[].color`（0–1） | 同（0–1） |
| 写入 | ❌ 只读，无导入端点 | ✅ `createFrame()`/`createText()` 等 |
| 用途 | **导出层契约目标**（校验+消费） | **真正"导入"Figma 的执行器** |

> **导出层（S3）落地路径**：`figma-exporter.ts` 产出 REST-API 形态 JSON（契约/校验/版本对比）。若需真正写入 Figma 文件，另起一个最小 Plugin（browser 端），遍历该 JSON 调用 `create*` 重建——属 S3 后的可选交付，非 v1 必需。

---

# 主题 2：YOLO / Rico 数据集可行性

## 结论

✅ **有条件推荐纳入 UI-6（作为 GPU-gated 可选增强，默认关闭）**——理由：Rico 的 `rico_semantics` 子集提供 ~50 万带归一化坐标的人工标注框且 CC BY-SA 4.0 可用，YOLO11n/s 体积小（5–10MB）、推理快，可作为现有 Level-B 像素检测器的**精度增强项**；但 Rico 纯 Android/移动端，对 Web/桌面截图存在**领域漂移风险**，故仅作为可选而非默认。

## 详细发现

### 2.1 Rico 数据集

| 维度 | 数据 | 来源 |
|---|---|---|
| 规模 | 72,219 唯一 UI 屏 / 9,772 个 App / 27 个 Google Play 类别 / 10,811 交互轨迹 | ✅ interactionmining.org/rico + 原论文 |
| 截图 | PNG 1440×2560 | ✅ |
| 标注格式 | JSON view hierarchy：节点含 `bounds`(像素坐标)、`text`、`componentLabel`、`iconClass`、`clickable` | ✅ |
| 语义子集 | 66,261 屏，**25 类 componentLabel**（Text 34.9%、Image 16.7%、Icon 13.7%、List Item 11.7%、Text Button 10.7%、Toolbar 2.7%、Web View 2.4%、Input 1.6%、Card 1.3%、Advertisement 1.0%…） | ✅ scipublication JACS |
| 许可 | `rico_semantics`：**CC BY-SA 4.0**（可商用衍生，需相同协议共享）；原始 Rico：研究用途 | ✅ GitHub repo LICENSE |
| 下载 | 语义标注子集 150MB；截图+层级 6GB；`rico_semantics` GitHub 仓库直接取 train/val/test 拆分 | ✅ |
| 现成标注框 | `rico_semantics` ~500k 人工标注，**bounding box 为归一化 [0,1] 坐标**，已拆 train/val/test | ✅ |
| 已知缺陷 | 层级节点与截图存在错位噪声；2017 至今未更新（旧 Material Design 风格） | ⚠️ MUD 论文指出 |
| 清洁子集 Enrico | 1,460 屏 / 20 设计主题（**太小**，仅适合屏级分类，不适合组件检测微调） | ✅ |

### 2.2 YOLO11 微调

| 模型 | params | 体积 | mAP@50-95(COCO) | CPU ONNX(ms/im) | T4 TensorRT(ms/im) | 来源 |
|---|---|---|---|---|---|---|
| YOLO11n | 2.6M | ~5MB | 39.5 | 56.1 | 1.5 | ✅ Ultralytics |
| YOLO11s | 9.4M | ~18MB | 47.0 | 90.0 | 2.5 | ✅ |
| YOLO11m | 20.1M | ~40MB | 51.5 | 183.2 | 4.7 | ✅ |

- **标注量需求**：📖 通用经验，单类 ~1k–3k 标注即可收敛到可用精度；Rico 25 类 × 平均数千框，总量 50 万，**远超阈值**，无需额外标注。
- **微调成本**：YOLO11n/s 在单 GPU（如 RTX 4090/T4）上 100 epoch 约 2–6 小时；CPU 推理用 ONNX 导出后 56–90ms，满足端到端 < 500ms 目标（GPU 下 < 5ms）。
- **部署形态**：支持 ONNX / TensorRT / CoreML / OpenVINO 多后端导出。

### 2.3 RT-DETR 作为替代

| 维度 | RT-DETR (v2) | YOLO11 | 来源 |
|---|---|---|---|
| 架构 | Transformer，NMS-free 端到端 | CNN，NMS 后处理 | ✅ CVPR'24 / Ultralytics |
| mAP(COCO) | RTDETRv2-l 53.4 / x 54.3 | YOLO11l 53.4 / x 54.7 | ✅ |
| CPU ONNX(ms) | 20–76（l/x） | 56–463（n→x） | ✅ |
| T4 TensorRT(ms) | 42–76 | 1.5–11.3 | ✅ |
| 训练成本 | 显著更高（VRAM 大，时长长） | 低 | ✅ Ultralytics 对比页 |
| 精度增益 | 略高（~1–2 mAP） | 略低 | ✅ |

> ⚠️ RT-DETR 精度略高但训练/显存成本显著更高，且最小档也远比 YOLO11n 重；UI 组件检测是封闭小类别集（25 类），NMS-free 优势不突出。**不推荐 RT-DETR 替代 YOLO**，YOLO11n/s 性价比更优。

## 集成方式建议

| 项 | 建议 |
|---|---|
| 是否纳入 | UI-6 可选，`options.detector='yolo'` 或 `VISION_DETECTOR=yolo` 开启；默认 Level-B（现有 sharp 像素检测器）|
| 运行形态 | **Python sidecar 子进程**（`ultralytics` + ONNX 推理），**不**并入 TS 运行时 |
| 模型放置 | `~/.vision-mcp/models/yolo/uicomponents-yolo11s.onnx`，首用下载（仿现有 `ensureSmolVLM2Model` 模式） |
| 进程管理 | 仿 `LlamaServerProcess`（`src/providers/llama-server/process.ts`）：按需拉起、复用、空闲退出；GPU 不可用时回退 ONNX CPU 或直接回退 Level-B |
| 输出对接 | sidecar 吐 `{bbox, class, score}[]` → 适配器喂入 `VisionIR.detections`（S0 契约），不破坏现有 `result.parse.uiLayout` |
| 训练 | 离线脚本 `scripts/train-uicomponents-yolo.ts`（非运行时依赖），用 `rico_semantics` train split + YOLO 格式转换（归一化坐标 → YOLO txt） |
| 风险 | ⚠️ Rico 移动端领域漂移：若目标含 Web/桌面 UI，需补充 WebUI 等数据，否则 recall 下降；建议 UI-6 上线前对目标场景做小样本评测 |

---

# 主题 3：SAM2 / GroundingDINO 集成成本

## 结论

❌ **不推荐纳入 v1**——理由：SAM2 仅做无类别几何分割、且 UI 组件是矩形（bbox 已足够，像素掩码增益可忽略）却要 78–162MB + CPU 23 秒/图的代价；GroundingDINO 零样本文本检测虽诱人，但模型 ~670MB、GPU 强依赖，且训练于自然图像（COCO/O365），UI 截图属分布外，组件检测精度未经验证且大概率低于 Rico 微调的 YOLO，速度也远慢。

## 详细发现

### 3.1 SAM2（Segment Anything 2）

| 维度 | SAM2-t | SAM2-b | 来源 |
|---|---|---|---|
| 体积 | 78.1MB | 162MB | ✅ Ultralytics SAM2 文档 |
| 参数 | 38.9M | 80.8M | ✅ |
| CPU 速度 | **23,430 ms/im** | **28,867 ms/im** | ✅ |
| GPU 速度(RTX PRO 6000) | 668 ms/im | 857 ms/im | ✅ SAM3 文档对比表 |
| 能力 | 可提示分割（点/框/掩码提示），**零样本几何分割，无类别标签** | 同 | ✅ |
| 类比 | 比 YOLO11n-seg 大 ~12x、CPU 慢 ~960x | — | ✅ |

> ⚠️ SAM2 需要外部 prompt（点/框）——它不检测，只分割给定区域。要用于 UI 仍需先有检测器给框，再 SAM2 精修掩码。但 UI 控件几乎都是矩形/圆角矩形，**bbox 与真实掩码差异极小**，SAM2 的精分割能力对 UI 价值≈0，代价却极高（CPU 23 秒/图）。

### 3.2 GroundingDINO

| 维度 | GroundingDINO-T (Swin-T) | GroundingDINO-B (Swin-B) | 来源 |
|---|---|---|---|
| 参数 | 172M | ~697M（Swin-B+BERT） | ✅ arXiv 2303.05499 / IDEA-Research repo |
| 权重体积 | ~670MB | 更大 | ✅ NGC 卡 1.93GB(含 TAO 容器) |
| 训练 VRAM | 24GB+ 推荐（BERT 文本编码器加显著开销） | 更高 | ✅ NVIDIA TAO skill |
| 零样本能力 | 文本 prompt 直接检测任意类别 | 同 | ✅ |
| COCO 零样本 AP | 48.4 | 52.5 | ✅ |
| GPU 推理(NGC, FP16) | RTX 4090 ~84 FPS / T4 ~16 FPS | — | ✅ NGC 卡（3/2026 更新） |
| UI 适配 | ⚠️ 训练于自然图像(O365,GoldG,Cap4M)，**UI 截图为分布外**，组件 prompt("button/icon/input")精度未公开验证 | 同 | ⚠️ |

### 3.3 与 YOLO 微调对比

| 维度 | GroundingDINO-T | SAM2-b | Rico 微调 YOLO11s | 来源 |
|---|---|---|---|---|
| 体积 | ~670MB | 162MB | ~18MB | ✅ |
| GPU 依赖 | 强（训练 24GB+，推理 GPU 友好） | 强（CPU 23s 不可用） | 弱（ONNX CPU 90ms 可接受） | ✅ |
| UI 精度 | ⚠️ 分布外，未验证，预期低于微调 | N/A（无类别） | ✅ 域内微调，预期高 | — |
| 速度 | GPU ~12–84ms | GPU 857ms | GPU 2.5ms / CPU 90ms | ✅ |
| 集成成本 | Python sidecar + 大模型下载 + GPU | 同 | 同，但小得多 | — |

> 综上：零样本路径中 GroundingDINO 重而 UI 未必准；SAM2 对矩形 UI 无价值。若未来确有"开放词表零样本检测"硬需求，可关注更轻的 **YOLO-World**（开放词表 YOLO）或 **Grounding DINO 1.5 Edge**（EfficientViT 主干，10.7mm/图），但 v1 不纳入。

## 集成方式建议（若未来 reconsider）

| 项 | 建议 |
|---|---|
| 是否纳入 v1 | ❌ 不纳入 |
| 留作 | 未来研究项；仅当出现"未知组件类别需零样本识别"硬需求时评估 |
| 候选替代 | 优先 YOLO-World（开放词表）/ Grounding DINO 1.5 Edge，而非 SAM2 |
| 理由 | SAM2 对矩形 UI 增益≈0；GroundingDINO UI 精度未验证且重 |

---

# 附：三主题结论速览

| 主题 | 结论 | 一句话理由 |
|---|---|---|
| 1. Figma JSON 规范 | ✅ 推荐采纳 | REST API 节点结构是事实标准、字段稳定，可直接作为导出层契约；"导入"需另起 Plugin。 |
| 2. YOLO / Rico | ✅ 有条件推荐（UI-6 可选，默认关） | Rico 50 万现成标注框 + CC BY-SA 4.0 + YOLO11n/s 小而快；但纯 Android 移动端，Web/桌面有领域漂移风险。 |
| 3. SAM2 / GroundingDINO | ❌ 不推荐纳入 v1 | SAM2 对矩形 UI 增益≈0 且 CPU 23s/图；GroundingDINO 670MB、GPU 强依赖、UI 为分布外、精度未验证。 |

> 字段映射表（主题1 表 A–E）已完整产出，可直接交付 S3 导出层 Agent 使用。
