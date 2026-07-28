# 标注工作台画布编辑能力设计

> 日期：2026-07-28
> 主题：为审核画布添加平移手型工具、框选新增元素、遮盖层元素类型

## 背景

当前工作台画布（`static/app.js`）交互模型为"点元素=选中+拖动移动，拖空白=平移"。
`fixes.css` 把 `.box`/`.box-hit` 都设了 `pointer-events:none`，实际命中靠 JS `hitTest`，
画布光标恒为 `default`（箭头），审核员无法发现"可拖动平移"，也无法手动补标漏检元素，
更没有用于标记浮层遮罩（scrim）的元素类型。

本次为画布编辑区新增三项能力：

1. 鼠标放在画布上默认展示小手状态，可拖动平移画布位置。
2. 框选新增元素，用于手动补漏。
3. 遮盖层（mask）元素类型，合理设计其语义与视觉。

## 设计决策（已与用户确认）

- **交互模型**：工具栏三工具切换（手型 / 选择 / 框选），默认手型。
- **框选触发**：工具栏"框选"按钮 + 快捷键 `N`；新元素默认 `type=unknown`，画完自动切回选择工具。
- **遮盖层语义**：浮层遮罩 scrim（dialog/drawer/bottomSheet 背后的半透明遮罩层）。

## 工具系统

### 状态

新增 `state.tool: 'hand' | 'select' | 'draw'`，默认 `'hand'`。
画布容器 `canvasWrap.dataset.tool` 同步当前工具，供 CSS 区分光标。

### 工具行为

| 工具 | 快捷键 | 光标 | pointerdown 行为 |
|---|---|---|---|
| 手型 `hand`（默认） | `H` | `grab`，平移时 `grabbing` | 命中元素→仅选中（检视，不启动移动手势）；未命中→`startPan` |
| 选择 `select` | `V` | `default` | 命中元素→选中并启动移动手势；未命中→`startPan`；选中元素显示 resize 手柄 |
| 框选 `draw`（一次性） | `N` | `crosshair` | 任意位置→开始绘制矩形；松开≥5×5px→创建 `unknown` 元素并切到 `select`；`Esc`/右键取消→`select` |

**手型模式单击元素仍选中**：保留"点元素看右侧详情"的审核习惯，只是拖动=平移而非移动元素。
resize 手柄仅在 `select` 工具下渲染并响应。

### 框选新增元素

- 拖动期间渲染临时 `.box.drawing` 预览矩形（虚线轮廓，无填充）。
- 松开时若 `w>=5 && h>=5`，创建元素：
  ```js
  { id: `manual-${crypto.randomUUID()}`, type: 'unknown', bbox: {x,y,w,h}, render: 'native' }
  ```
- 创建后：自动选中、切换到 `select` 工具、推入 undo 历史（`changed(before)`）。
- 小于 5×5px 视为误触，取消绘制，不创建元素，仍切回 `select`。
- `draw` 为一次性工具：绘制一次后自动切 `select`；`Esc`/右键取消也切 `select`。

### 工具切换入口

- 画布工具栏左侧新增 3 个按钮（手型/选择/框选），复用现有 zoom 按钮视觉风格，激活态高亮。
- 全局键盘：`H`/`V`/`N` 切换工具，`Esc` 退出 `draw`→`select`。
- 编辑控件（INPUT/TEXTAREA/SELECT）聚焦时保留原生按键，不触发工具切换。

## 遮盖层 mask 元素类型

### 数据

- `TYPE_NAMES.mask = '遮盖层'`。
- `COMPONENT_TYPE_GROUPS` 浮层组追加 `mask`：`['dialog','drawer','bottomSheet','mask']`。
- `COLORS.mask = '#334155'`（slate-700，scrim 深色调）。
- `type` 为字符串字段，工作台校验器不限制取值，新增 `mask` 无需改契约。

### 画布视觉

```css
.box.mask {
  fill: rgba(15, 23, 42, 0.35);
  stroke: #7A5BC7;
  stroke-dasharray: 4 3;
}
```

半透明深色填充表达 scrim 遮罩质感，紫色虚线边框与 AI 建议色系一致。
选中态仍由 `.box.selected` 统一覆盖为红色虚线。

### 渲染策略

`mask` 是视觉效果而非可交互组件，但不在创建时强制 `render`。审核员在右侧编辑器
按场景选择 `semantic-only`（纯遮罩）或 `asset`（保留为图片素材）。

## 光标样式（CSS）

```css
.canvas-wrap[data-tool="hand"]  { cursor: grab; }
.canvas-wrap[data-tool="hand"].panning { cursor: grabbing; }
.canvas-wrap[data-tool="select"] { cursor: default; }
.canvas-wrap[data-tool="draw"]  { cursor: crosshair; }
```

## 涉及文件

- `src/ui-analysis/annotation-workbench/static/app.js`
  - `state.tool`、工具按钮渲染与切换、`H`/`V`/`N`/`Esc` 键绑定
  - `selectCanvasTarget` 按工具分流：hand=选中不移动 / select=选中+移动 / draw=开始绘制
  - 新增 `startDraw`/`moveDraw`/`endDraw` 手势与 `.box.drawing` 预览
  - `addResizeHandles` 仅在 `select` 工具下渲染
  - `createElement` 工厂与 undo 集成
- `src/ui-analysis/annotation-workbench/static/index.html`
  - canvas-toolbar 增加 3 个工具按钮（`#tool-hand`/`#tool-select`/`#tool-draw`）
- `src/ui-analysis/annotation-workbench/static/fixes.css`
  - `data-tool` 光标、`.box.mask`、`.box.drawing`、工具按钮样式
- 测试：`tests/ui-analysis/annotation-workbench-tools.test.ts`、`annotation-workbench-mask-type.test.ts`

## 非目标

- 不改动推理管线、`src/core/extractors/`、契约文件 `05-annotation-spec.md`。
- 不引入工具持久化（工具状态随会话，不写文件）。
- 不做框选批量选择（框选仅用于新增单个元素，不批量框选已有元素）。

## 验证

- `pnpm typecheck` / `pnpm lint` / `pnpm build` / `pnpm test:unit`
- 浏览器实测：手型拖动平移、H/V/N 切换、框选创建元素、mask 类型与 scrim 视觉

## 实现修订（反馈驱动）

首次实现后根据审核反馈调整：

- **光标**：手型默认 `grab`；悬停非 page 元素变 `move`；resize 手柄按方向变
  `nwse-resize`/`nesw-resize`（Photoshop 式）。page 背景仍为 `grab`（拖动 page = 平移）。
- **平移**：拖动 page 背景/空白 = 平移；**按住空格 + 拖动 = 任意位置平移**（标准设计工具交互）。
  手型与选择工具均支持元素移动/缩放，差异仅在空白区光标（grab vs default）。
- **工具按钮**：激活态 hover 不再变白（`.tool-btn.active:hover` 保持深蓝 `#1e3a5f`）。
- **标尺**：刻度按内容实际位置（`getBoundingClientRect`）定位，随缩放重排步长、随滚动
  重新渲染（`canvas-wrap` `scroll` 监听），不再"变短"或"不放大"。

## 遮盖层 mask：从编辑区类型升级为识别管线类型

`mask` 不只是工作台手动可选类型，而是**元素识别管线产出的一等类型**：

- `ComponentType`（`ir/types.ts`）新增 `'mask'`。
- `applyOverlays`（`overlay-detector.ts`）：当 dialog 检测到 mask 区域时，除在 dialog 节点
  存 `props.mask` 外，额外向 `ast.root.children` 追加一个 `type:'mask'` 节点（bbox = 遮罩区，
  `zIndex = dialogZ - 1`，`props.scrim = true`），供下游识别/标注/导出当作遮挡层处理。
- `assignRenderModes`：`mask` -> `semantic-only`（视觉层，非可交互组件）。
- `figmaNodeType`：`mask` -> `RECTANGLE`。
- 标注生成脚本 `collectNodes` 递归遍历 AST，mask 节点以 `type:'mask'` 写入标注 JSON。
- 工作台 `TYPE_NAMES`/`COMPONENT_TYPE_GROUPS` 已含 `mask`（浮层组）+ scrim 视觉样式。
