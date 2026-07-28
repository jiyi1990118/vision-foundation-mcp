import type { AnnotationFile, AnnotationElement } from '../benchmark/annotation-loader.js';

export interface ValidationError {
  code: string;
  elementId?: string;
  detail?: string;
  message: string;
}

export interface ValidationResult {
  errors: ValidationError[];
}

export function validateAnnotation(annotation: AnnotationFile): ValidationResult {
  const errors: ValidationError[] = [];
  const { width, height } = annotation.imageSize;
  const byId = new Map<string, AnnotationElement>();

  for (const element of annotation.elements) {
    if (byId.has(element.id)) {
      errors.push({ code: 'duplicate-id', elementId: element.id, message: `元素 ID 重复: ${element.id}` });
    }
    byId.set(element.id, element);
  }

  for (const element of annotation.elements) {
    const { x, y, w, h } = element.bbox;
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(w) || !Number.isFinite(h)) {
      errors.push({ code: 'bbox-invalid', elementId: element.id, message: `bbox 包含非有限值: ${element.id}` });
      continue;
    }
    if (w <= 0 || h <= 0) {
      errors.push({ code: 'bbox-invalid-size', elementId: element.id, message: `bbox 宽高必须大于 0: ${element.id}` });
    }
    if (x < 0 || y < 0 || x + w > width + 0.5 || y + h > height + 0.5) {
      errors.push({ code: 'bbox-out-of-bounds', elementId: element.id, message: `bbox 超出图像范围: ${element.id}` });
    }
  }

  const pageRoots = annotation.elements.filter((element) => element.type === 'page');
  if (pageRoots.length > 1) {
    errors.push({ code: 'multiple-page-roots', message: `存在多个 page 根节点: ${pageRoots.length}` });
  }

  for (const relation of annotation.relations) {
    if (!byId.has(relation.from) || !byId.has(relation.to)) {
      const missing = byId.has(relation.from) ? relation.to : relation.from;
      errors.push({ code: 'relation-endpoint-missing', detail: missing, message: `关系引用了不存在的元素: ${missing}` });
    }
  }

  const containsRelations = annotation.relations.filter((relation) => relation.type === 'contains');
  const parentByChild = new Map<string, string[]>();
  for (const relation of containsRelations) {
    if (!byId.has(relation.from) || !byId.has(relation.to)) continue;
    const parents = parentByChild.get(relation.to) ?? [];
    parents.push(relation.from);
    parentByChild.set(relation.to, parents);
  }

  for (const [childId, parents] of parentByChild) {
    if (parents.length > 1) {
      errors.push({ code: 'multiple-parents', elementId: childId, message: `元素有多个 contains 父节点: ${childId} -> ${parents.join(', ')}` });
    }
  }

  const visited = new Set<string>();
  const stack = new Set<string>();
  const hasCycle = (id: string): boolean => {
    if (stack.has(id)) {
      errors.push({ code: 'containment-cycle', message: `存在 containment 环: ${id}` });
      return true;
    }
    if (visited.has(id)) return false;
    stack.add(id);
    const parents = parentByChild.get(id) ?? [];
    for (const parent of parents) {
      if (hasCycle(parent)) return true;
    }
    stack.delete(id);
    visited.add(id);
    return false;
  };
  for (const element of annotation.elements) {
    hasCycle(element.id);
  }

  for (const element of annotation.elements) {
    const declaredChildren = element.children ?? [];
    const containsChildren = containsRelations
      .filter((relation) => relation.from === element.id)
      .map((relation) => relation.to);
    const childSet = new Set(containsChildren);
    for (const child of declaredChildren) {
      if (!childSet.has(child)) {
        errors.push({ code: 'child-not-in-contains', elementId: element.id, detail: child, message: `children 中存在但 contains 关系缺失: ${element.id} -> ${child}` });
      }
    }
    for (const child of containsChildren) {
      if (!declaredChildren.includes(child)) {
        errors.push({ code: 'contains-not-in-children', elementId: element.id, detail: child, message: `contains 关系存在但 children 缺失: ${element.id} -> ${child}` });
      }
    }
  }

  return { errors };
}
