# UI 复原基准标注规范

> 本文档定义高保真 UI 截图复原基准的标注格式，用于量化验收 UI 重建准确率。

## 1. 标注目标

为 UI 截图复原工具提供 ground truth，使以下指标可量化度量：

- 关键可见元素召回率（IoU≥0.5）
- 清晰文字行召回率
- 文字字符准确率
- 核心组件类型 macro-F1
- checkbox/radio/switch family + 状态准确率
- 父子及 label 关系 F1
- 可编辑元素比例
- flattened asset 兜底面积比例
- 重要区域未解释率

## 2. 数据集规模

| 集合 | 最少张数 | 分布 | 用途 |
|---|---|---|---|
| 开发集 | 60 | App/Web/桌面各 20 | 开发调试 |
| 发布锁定集 | 150 | App/Web/桌面各 50 | 发布门槛 |

强制覆盖维度：中英文、明暗主题、高 DPI、小图标、含字 Banner、自定义 checkbox/radio/switch、弹窗、长列表、密集工具栏。

## 3. 标注文件格式

每张截图对应一个 JSON 标注文件，文件名与截图同名，扩展名 `.json`。

```json
{
  "image": "screenshot_001.png",
  "imageSize": { "width": 375, "height": 812 },
  "platform": "app",
  "theme": "light",
  "language": "zh",
  "dpi": "high",
  "elements": [
    {
      "id": "e1",
      "type": "section",
      "semanticRole": "banner",
      "bbox": { "x": 0, "y": 0, "w": 375, "h": 120 },
      "render": "hybrid",
      "backgroundAsset": true,
      "children": ["e2", "e3", "e4"]
    },
    {
      "id": "e2",
      "type": "title",
      "bbox": { "x": 10, "y": 10, "w": 200, "h": 30 },
      "render": "native",
      "text": "夏日会员节"
    },
    {
      "id": "e3",
      "type": "button",
      "bbox": { "x": 10, "y": 75, "w": 100, "h": 36 },
      "render": "native",
      "text": "立即领取",
      "variant": "primary"
    },
    {
      "id": "e4",
      "type": "image",
      "semanticRole": "decoration",
      "bbox": { "x": 280, "y": 20, "w": 80, "h": 80 },
      "render": "asset",
      "assetRegion": { "kind": "decoration", "allowFallback": true }
    },
    {
      "id": "e5",
      "type": "checkbox",
      "bbox": { "x": 10, "y": 200, "w": 20, "h": 20 },
      "render": "native",
      "control": {
        "family": "checkbox",
        "state": "checked",
        "shape": "square"
      },
      "labelNodeId": "e6"
    },
    {
      "id": "e6",
      "type": "text",
      "bbox": { "x": 35, "y": 200, "w": 100, "h": 20 },
      "render": "native",
      "text": "同意条款",
      "semanticRole": "label"
    }
  ],
  "relations": [
    { "from": "e1", "to": "e2", "type": "contains" },
    { "from": "e1", "to": "e3", "type": "contains" },
    { "from": "e1", "to": "e4", "type": "contains" },
    { "from": "e5", "to": "e6", "type": "labels" }
  ],
  "zOrder": [
    { "id": "e1", "z": 0 },
    { "id": "e5", "z": 1 }
  ],
  "warnings": []
}
```

## 4. 字段说明

### 4.1 截图元信息

| 字段 | 类型 | 说明 |
|---|---|---|
| `image` | string | 截图文件名 |
| `imageSize` | { width, height } | 像素尺寸 |
| `platform` | 'app' \| 'web' \| 'desktop' | 平台分类 |
| `theme` | 'light' \| 'dark' | 主题模式 |
| `language` | 'zh' \| 'en' \| 'mixed' | 主要语言 |
| `dpi` | 'standard' \| 'high' | DPI 级别 |

### 4.2 元素标注

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `id` | string | 是 | 元素唯一 ID（同截图内稳定） |
| `type` | string | 是 | 组件类型（page/section/button/title/text/checkbox/radio/switch/icon/image/avatar/card/list/listItem/input/textarea/select/dialog/drawer/bottomSheet/tab/badge/tag/divider/progress/navbar/header/footer/sidebar/toolbar/container/unknown） |
| `semanticRole` | string | 否 | 复合用途（banner/hero/formField/controlItem/menuItem/cardMedia/decoration/label） |
| `bbox` | { x, y, w, h } | 是 | 原图像素坐标 |
| `render` | string | 是 | 期望渲染策略（native/hybrid/asset/semantic-only） |
| `text` | string | 否 | 文字内容（文字元素必填） |
| `variant` | string | 否 | 按钮变体（primary/secondary/success/danger/ghost/default） |
| `control` | object | 否 | 控件信息（checkbox/radio/switch 必填） |
| `control.family` | string | 是 | checkbox/radio/switch |
| `control.state` | string | 是 | checked/unchecked/indeterminate/disabled/focused |
| `control.shape` | string | 否 | square/circle/pill/custom |
| `labelNodeId` | string | 否 | 关联的 label 元素 ID |
| `children` | string[] | 否 | 子元素 ID 列表 |
| `backgroundAsset` | boolean | 否 | 是否有背景资产层 |
| `assetRegion` | object | 否 | 资产区域信息 |
| `assetRegion.kind` | string | 是 | icon/logo/photo/illustration/background/decoration/control-skin/composite |
| `assetRegion.allowFallback` | boolean | 否 | 是否允许整体 crop 兜底 |

### 4.3 关系标注

| 字段 | 类型 | 说明 |
|---|---|---|
| `from` | string | 起始元素 ID |
| `to` | string | 目标元素 ID |
| `type` | string | contains/overlaps/alignedWith/labels/decorates/occludes/backgroundOf |

### 4.4 Z-Order

按绘制顺序排列，z 值越大越在上层。仅标注浮层（dialog/drawer/bottomSheet）和遮挡关系。

## 5. 标注规则

1. **bbox 使用原图像素坐标**，不归一化。
2. **每个可见元素必须标注**，包括装饰性图标和分割线。不可见元素（如隐藏菜单）不标注。
3. **文字元素**：标注 OCR 可识别的文字行，不拆分到单字。占位符文字标注 `text` 并在 `semanticRole` 标 `placeholder`。
4. **复合组件**：标注外层容器和内部子元素，通过 `children` 和 `relations` 表达层级。
5. **Banner**：如果背景可分离，标 `render=hybrid` + `backgroundAsset=true`；如果不可分离，标 `render=asset` + `assetRegion.allowFallback=true`。
6. **控件状态**：只标注截图中当前可见的状态，不推断其他状态。
7. **遮挡**：被浮层遮挡的元素仍标注，但在 `zOrder` 中标低 z 值。
8. **允许的 fallback**：标注 `render=asset` 的元素表示允许工具用整体 crop 兜底；标注 `render=native` 的元素表示必须输出可编辑组件。
9. **争议项**：无法确定类型或关系的元素标 `type=unknown` 并加入 `warnings`。

## 6. 发布门槛

按平台分别达标（不能用移动端高分掩盖桌面退化）：

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

所有资产引用必须有效，Banner 不发生文字双重渲染。

## 7. 参考渲染器

使用 `src/ui-analysis/render/reference-renderer.ts` 的 `renderAstToSvg` 将工具输出的 AST 重绘为 SVG，与原图叠图比较，计算 SSIM 和差异热图。该渲染器仅用于验收，不改变"MCP 不生成业务代码"的边界。
