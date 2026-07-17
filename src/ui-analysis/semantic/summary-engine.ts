/**
 * Summary Engine - builds a human-readable Chinese summary of a page from its
 * SemanticAST, inferred page type, component variants, and LayoutIR. The
 * shape is fixed: "{pageType}页，含 {组件统计}；{布局描述}。".
 *
 * Component stats are grouped by type (input -> 输入框, card -> 卡卡, ...);
 * buttons are further split by variant so a primary button reads "1 个主按钮".
 * Pure, deterministic, no IO, no model.
 *
 * @see src/ui-analysis/ir/types.ts  (SemanticAST / LayoutIR / ComponentType)
 * @see ./page-type-engine.ts  (PageType)
 * @see ./variant-engine.ts    (VariantInfo / Variant)
 */
import type {
  SemanticAST,
  ASTNode,
  ComponentType,
  LayoutIR,
  LayoutType,
} from '../ir/types.js';
import type { PageType } from './page-type-engine.js';
import type { Variant, VariantInfo } from './variant-engine.js';

export interface SummaryInput {
  ast: SemanticAST;
  pageType: PageType;
  variants: VariantInfo[];
  layout: LayoutIR;
}

const PAGE_TYPE_ZH: Record<PageType, string> = {
  login: '登录',
  form: '表单',
  list: '列表',
  table: '表格',
  detail: '详情',
  dashboard: '仪表盘',
  setting: '设置',
  navigation: '导航',
  unknown: '未知',
};

const LAYOUT_ZH: Record<LayoutType, string> = {
  grid: '网格',
  columns: '分栏',
  sidebar: '侧边栏',
  centered: '居中',
  'split-pane': '分屏',
  stack: '堆叠',
};

const COMPONENT_ZH: Array<{ type: ComponentType; zh: string }> = [
  { type: 'title', zh: '标题' },
  { type: 'subtitle', zh: '副标题' },
  { type: 'input', zh: '输入框' },
  { type: 'textarea', zh: '文本域' },
  { type: 'button', zh: '按钮' },
  { type: 'iconButton', zh: '图标按钮' },
  { type: 'checkbox', zh: '复选框' },
  { type: 'radio', zh: '单选框' },
  { type: 'switch', zh: '开关' },
  { type: 'select', zh: '下拉框' },
  { type: 'dropdown', zh: '下拉菜单' },
  { type: 'tab', zh: '标签页' },
  { type: 'table', zh: '表格' },
  { type: 'listItem', zh: '列表项' },
  { type: 'card', zh: '卡片' },
  { type: 'navbar', zh: '导航栏' },
  { type: 'sidebar', zh: '侧边栏' },
  { type: 'header', zh: '页眉' },
  { type: 'footer', zh: '页脚' },
  { type: 'dialog', zh: '对话框' },
  { type: 'drawer', zh: '抽屉' },
  { type: 'image', zh: '图片' },
  { type: 'avatar', zh: '头像' },
  { type: 'icon', zh: '图标' },
  { type: 'badge', zh: '徽章' },
  { type: 'tag', zh: '标签' },
  { type: 'progress', zh: '进度条' },
  { type: 'divider', zh: '分割线' },
  { type: 'section', zh: '区块' },
  { type: 'container', zh: '容器' },
  { type: 'text', zh: '文本' },
];

const VARIANT_BUTTON_ZH: Record<Variant, string> = {
  primary: '主按钮',
  secondary: '次按钮',
  success: '成功按钮',
  danger: '危险按钮',
  ghost: '幽灵按钮',
  default: '按钮',
};

const VARIANT_ORDER: Variant[] = [
  'primary', 'secondary', 'success', 'danger', 'ghost', 'default',
];

function flatten(node: ASTNode, out: ASTNode[] = []): ASTNode[] {
  out.push(node);
  for (const child of node.children) flatten(child, out);
  return out;
}

function buildComponentStats(ast: SemanticAST, variants: VariantInfo[]): string {
  const nodes = flatten(ast.root).filter((n) => n.type !== 'page');
  const byType = new Map<ComponentType, ASTNode[]>();
  for (const n of nodes) {
    const arr = byType.get(n.type) ?? [];
    arr.push(n);
    byType.set(n.type, arr);
  }
  const variantById = new Map<string, VariantInfo>(variants.map((v) => [v.nodeId, v]));
  const parts: string[] = [];
  for (const entry of COMPONENT_ZH) {
    const group = byType.get(entry.type);
    if (group === undefined || group.length === 0) continue;
    if (entry.type === 'button') {
      const counts = new Map<Variant, number>();
      for (const b of group) {
        const v = variantById.get(b.id)?.variant ?? 'default';
        counts.set(v, (counts.get(v) ?? 0) + 1);
      }
      for (const vv of VARIANT_ORDER) {
        const cnt = counts.get(vv) ?? 0;
        if (cnt > 0) parts.push(`${cnt} 个${VARIANT_BUTTON_ZH[vv]}`);
      }
    } else {
      parts.push(`${group.length} 个${entry.zh}`);
    }
  }
  return parts.join('、');
}

function buildLayoutDesc(layout: LayoutIR): string {
  const lt = LAYOUT_ZH[layout.layoutType] ?? layout.layoutType;
  const regionCount = layout.regions.length;
  if (regionCount > 0) return `${lt}布局，含 ${regionCount} 个区域`;
  return `${lt}布局`;
}

/** Build a human-readable Chinese summary string from the page understanding. */
export function buildSemanticSummary(input: SummaryInput): string {
  const pageZh = PAGE_TYPE_ZH[input.pageType] ?? '未知';
  const stats = buildComponentStats(input.ast, input.variants);
  const layoutDesc = buildLayoutDesc(input.layout);
  const statsPart = stats.length > 0 ? `，含 ${stats}` : '';
  return `${pageZh}页${statsPart}；${layoutDesc}。`;
}
