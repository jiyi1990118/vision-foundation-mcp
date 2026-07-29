import type { AnnotationElement, AnnotationFile, AnnotationRelation } from '../benchmark/annotation-loader.js';
import type { RelationSource } from '../benchmark/annotation-loader.js';

export type StructureIssueCode = 'isolated-content' | 'child-outside-parent' | 'sibling-size-inconsistent';

export interface StructureIssue {
  code: StructureIssueCode;
  elementId: string;
  parentId?: string;
  severity: 'medium' | 'low';
  message: string;
  version: number;
  confidence: number;
  bboxHash: string;
  type: string;
  evidence?: string;
}

export interface StructureRule {
  code: StructureIssueCode;
  version: number;
  severity: 'medium' | 'low';
  confidence: number;
  description: string;
  advisoryOnly: boolean;
  evaluate(annotation: AnnotationFile): StructureIssue[];
}

export function bboxHash(bbox: { x: number; y: number; w: number; h: number }): string {
  return `${Math.round(bbox.x)},${Math.round(bbox.y)},${Math.round(bbox.w)},${Math.round(bbox.h)}`;
}

export function findingSubjectId(finding: StructureIssue): string {
  return `${finding.code}:${finding.elementId}`;
}

export function findingSignature(finding: StructureIssue): string {
  return `${finding.version}:${finding.code}:${finding.elementId}:${finding.bboxHash}:${finding.type}`;
}

function area(element: AnnotationElement): number {
  return element.bbox.w * element.bbox.h;
}

function contains(parent: AnnotationElement, child: AnnotationElement): boolean {
  const a = parent.bbox;
  const b = child.bbox;
  return parent.id !== child.id && b.x >= a.x && b.y >= a.y
    && b.x + b.w <= a.x + a.w && b.y + b.h <= a.y + a.h && area(parent) > area(child);
}

export function buildContainmentCandidates(annotation: AnnotationFile): Map<string, string> {
  const candidates = new Map<string, string>();
  for (const child of annotation.elements) {
    const parent = annotation.elements
      .filter((candidate) => contains(candidate, child))
      .sort((a, b) => area(a) - area(b) || a.id.localeCompare(b.id))[0];
    if (parent) candidates.set(child.id, parent.id);
  }
  return candidates;
}

function isHumanConfirmed(relation: AnnotationRelation): boolean {
  return relation.source === 'human' && (relation.reviewStatus === 'confirmed' || relation.reviewStatus === undefined);
}

export function normalizeAnnotationTree(annotation: AnnotationFile): AnnotationFile {
  const elements = annotation.elements.map((element) => {
    const copy = { ...element };
    delete copy.children;
    return copy;
  });
  const byId = new Map(elements.map((element) => [element.id, element]));
  const geometricCandidates = buildContainmentCandidates(annotation);

  const humanParents = new Map<string, string>();
  for (const relation of annotation.relations) {
    if (relation.type === 'contains' && byId.has(relation.from) && byId.has(relation.to) && isHumanConfirmed(relation)) {
      humanParents.set(relation.to, relation.from);
    }
  }

  const finalParents = new Map<string, string>();
  for (const child of elements) {
    const humanParent = humanParents.get(child.id);
    if (humanParent) {
      finalParents.set(child.id, humanParent);
    } else {
      const candidate = geometricCandidates.get(child.id);
      if (candidate) finalParents.set(child.id, candidate);
    }
  }

  for (const [childId, parentId] of finalParents) {
    const parent = byId.get(parentId);
    if (parent) parent.children = [...(parent.children ?? []), childId].sort();
  }

  const humanContainsRelations = annotation.relations.filter(
    (relation) => relation.type === 'contains' && isHumanConfirmed(relation),
  );
  const derivedRelations: AnnotationRelation[] = [];
  for (const [childId, parentId] of finalParents) {
    if (!humanParents.has(childId)) {
      derivedRelations.push({ from: parentId, to: childId, type: 'contains', source: 'derived' as RelationSource });
    }
  }

  const nonContainsRelations = annotation.relations.filter((relation) => relation.type !== 'contains');
  const containsRelations = [...humanContainsRelations, ...derivedRelations].sort(
    (a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to),
  );

  return {
    ...annotation,
    elements,
    relations: [...nonContainsRelations, ...containsRelations],
  };
}

function isContent(element: AnnotationElement): boolean {
  return ['text', 'title', 'subtitle', 'icon', 'image', 'avatar', 'button', 'input', 'textarea', 'select', 'checkbox', 'radio', 'switch'].includes(element.type);
}

function outside(parent: AnnotationElement, child: AnnotationElement): boolean {
  const a = parent.bbox;
  const b = child.bbox;
  return b.x < a.x || b.y < a.y || b.x + b.w > a.x + a.w || b.y + b.h > a.y + a.h;
}

function buildParentMap(annotation: AnnotationFile): { parentByChild: Map<string, string>; byId: Map<string, AnnotationElement> } {
  const byId = new Map(annotation.elements.map((element) => [element.id, element]));
  const parentByChild = new Map<string, string>();
  for (const relation of annotation.relations.filter((relation) => relation.type === 'contains')) {
    if (byId.has(relation.from) && byId.has(relation.to)) parentByChild.set(relation.to, relation.from);
  }
  for (const parent of annotation.elements) {
    for (const childId of parent.children ?? []) {
      if (!parentByChild.has(childId)) parentByChild.set(childId, parent.id);
    }
  }
  return { parentByChild, byId };
}

const RULE_ISOLATED_CONTENT: StructureRule = {
  code: 'isolated-content',
  version: 1,
  severity: 'medium',
  confidence: 0.7,
  description: '内容元素缺少 contains 父节点，可能未被正确归入容器层级',
  advisoryOnly: true,
  evaluate(annotation: AnnotationFile): StructureIssue[] {
    const { parentByChild } = buildParentMap(annotation);
    const issues: StructureIssue[] = [];
    for (const element of annotation.elements) {
      if (!isContent(element) || element.type === 'page') continue;
      if (parentByChild.has(element.id)) continue;
      issues.push({
        code: 'isolated-content',
        elementId: element.id,
        severity: 'medium',
        message: `${element.type} 没有容器父节点`,
        version: 1,
        confidence: 0.7,
        bboxHash: bboxHash(element.bbox),
        type: element.type,
        evidence: `元素 ${element.id} (${element.type}) 在 contains 关系和 children 列表中均未找到父节点`,
      });
    }
    return issues;
  },
};

const RULE_CHILD_OUTSIDE_PARENT: StructureRule = {
  code: 'child-outside-parent',
  version: 1,
  severity: 'medium',
  confidence: 0.8,
  description: '子元素 bbox 超出非 page 父容器的边界',
  advisoryOnly: true,
  evaluate(annotation: AnnotationFile): StructureIssue[] {
    const { parentByChild, byId } = buildParentMap(annotation);
    const issues: StructureIssue[] = [];
    for (const element of annotation.elements) {
      const parentId = parentByChild.get(element.id);
      if (!parentId) continue;
      const parent = byId.get(parentId);
      if (!parent || parent.type === 'page') continue;
      if (!outside(parent, element)) continue;
      issues.push({
        code: 'child-outside-parent',
        elementId: element.id,
        parentId: parent.id,
        severity: 'medium',
        message: `${element.type} 超出父容器 ${parent.type}`,
        version: 1,
        confidence: 0.8,
        bboxHash: bboxHash(element.bbox),
        type: element.type,
        evidence: `元素 ${element.id} (${element.type}) 超出父元素 ${parent.id} (${parent.type}) 的 bbox`,
      });
    }
    return issues;
  },
};

const RULE_SIBLING_SIZE_INCONSISTENT: StructureRule = {
  code: 'sibling-size-inconsistent',
  version: 1,
  severity: 'low',
  confidence: 0.5,
  description: '同级同类型元素的尺寸与中位数差异超过 25%',
  advisoryOnly: false,
  evaluate(annotation: AnnotationFile): StructureIssue[] {
    const { byId } = buildParentMap(annotation);
    const issues: StructureIssue[] = [];
    for (const parent of annotation.elements) {
      const children = (parent.children ?? []).map((id) => byId.get(id)).filter((element): element is AnnotationElement => Boolean(element));
      const groups = new Map<string, AnnotationElement[]>();
      for (const child of children) groups.set(child.type, [...(groups.get(child.type) ?? []), child]);
      for (const siblings of groups.values()) {
        if (siblings.length < 2) continue;
        const widths = siblings.map((element) => element.bbox.w);
        const heights = siblings.map((element) => element.bbox.h);
        const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? 1;
        const medianWidth = median(widths);
        const medianHeight = median(heights);
        for (const child of siblings) {
          const widthDelta = Math.abs(child.bbox.w - medianWidth) / Math.max(1, medianWidth);
          const heightDelta = Math.abs(child.bbox.h - medianHeight) / Math.max(1, medianHeight);
          if (widthDelta > 0.25 || heightDelta > 0.25) {
            issues.push({
              code: 'sibling-size-inconsistent',
              elementId: child.id,
              parentId: parent.id,
              severity: 'low',
              message: `${child.type} 与同级元素的尺寸差异较大`,
              version: 1,
              confidence: 0.5,
              bboxHash: bboxHash(child.bbox),
              type: child.type,
              evidence: `元素 ${child.id} (${child.type}) 宽高偏差 > 25%（宽偏差 ${Math.round(widthDelta * 100)}%，高偏差 ${Math.round(heightDelta * 100)}%）`,
            });
          }
        }
      }
    }
    return issues;
  },
};

export const STRUCTURE_RULES: StructureRule[] = [
  RULE_ISOLATED_CONTENT,
  RULE_CHILD_OUTSIDE_PARENT,
  RULE_SIBLING_SIZE_INCONSISTENT,
];

export function analyzeAnnotationStructure(annotation: AnnotationFile): StructureIssue[] {
  return STRUCTURE_RULES.flatMap((rule) => rule.evaluate(annotation));
}
