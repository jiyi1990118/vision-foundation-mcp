/**
 * Policy Engine — validates and optionally overrides the Planner's draft plan.
 *
 * @see Docs/01-architecture/04-policy-engine.md
 * @see Docs/04-decisions/ADR-003-policy-engine.md
 */
import type {
  ExecutionPlan,
  PolicyContext,
  PolicyRule,
} from '../types/skills.js';
import { logger } from '../utils/logger.js';

// ── Default policy rules ────────────────────────────────

const DEFAULT_RULES: PolicyRule[] = [
  {
    name: 'large-image-resize',
    priority: 20,
    when: { 'image.width': '> 3000' },
    override: { preprocess: ['resize'] },
    action: 'allow',
  },
  {
    name: 'memory-guard',
    priority: 90,
    when: { 'memory.availableMB': '< 1024' },
    override: {},
    action: 'warn',
  },
  {
    name: 'reject-huge',
    priority: 95,
    when: { 'image.size': '> 52428800' }, // 50MB
    action: 'deny',
  },
];

// ── Policy evaluation ───────────────────────────────────

export class PolicyDeniedError extends Error {
  constructor(
    public ruleName: string,
    message: string,
  ) {
    super(message);
    this.name = 'PolicyDeniedError';
  }
}

/**
 * Evaluate policy rules against the context.
 * Returns the final (possibly overridden) ExecutionPlan.
 * @throws PolicyDeniedError if a deny rule matches
 */
export async function evaluatePolicy(
  ctx: PolicyContext,
  rules: PolicyRule[] = DEFAULT_RULES,
): Promise<ExecutionPlan> {
  // Sort by priority descending (highest priority first)
  const sorted = [...rules].sort((a, b) => b.priority - a.priority);

  // Build the flat context for condition matching
  const flat: Record<string, unknown> = {
    'image.width': ctx.metadata.width,
    'image.height': ctx.metadata.height,
    'image.size': ctx.metadata.fileSize,
    'image.complexity': ctx.metadata.complexity,
    'image.estimatedType': ctx.metadata.estimatedType ?? '',
    'memory.availableMB': ctx.resources.memoryAvailableMB,
    'intent': ctx.intent,
    'quality': ctx.options.quality ?? 'fast',
    'provider': ctx.plan.provider,
  };

  for (const rule of sorted) {
    if (matchesConditions(rule.when, flat)) {
      // First match wins
      if (rule.action === 'deny') {
        logger.warn('Policy denied', { rule: rule.name });
        throw new PolicyDeniedError(rule.name, `Request denied by policy: ${rule.name}`);
      }

      if (rule.action === 'warn') {
        logger.warn('Policy warning', { rule: rule.name });
      }

      if (rule.override) {
        const overridden = applyOverride(ctx.plan, rule.override);
        logger.info('Policy override applied', {
          rule: rule.name,
          overrides: Object.keys(rule.override),
        });
        return overridden;
      }

      // Matched but no override — return as-is
      return ctx.plan;
    }
  }

  // No rule matched — return original plan
  return ctx.plan;
}

/**
 * Check if all conditions in `when` match the flat context.
 * Supports operators: ==, !=, >, <, >=, <=
 */
function matchesConditions(
  when: Record<string, unknown>,
  flat: Record<string, unknown>,
): boolean {
  for (const [key, condition] of Object.entries(when)) {
    const actual = flat[key];
    if (actual === undefined) return false;

    const condStr = String(condition).trim();
    const numActual = typeof actual === 'number' ? actual : NaN;

    // Parse operator + value
    const match = condStr.match(/^(>=|<=|>|<|==|!=)\s*(.+)$/);
    if (match && match[1] && match[2]) {
      const op = match[1];
      const valueStr = match[2];
      const condValue = parseFloat(valueStr);

      switch (op) {
        case '>':
          if (!(numActual > condValue)) return false;
          break;
        case '<':
          if (!(numActual < condValue)) return false;
          break;
        case '>=':
          if (!(numActual >= condValue)) return false;
          break;
        case '<=':
          if (!(numActual <= condValue)) return false;
          break;
        case '==':
          if (String(actual) !== valueStr.trim() && numActual !== condValue) return false;
          break;
        case '!=':
          if (String(actual) === valueStr.trim() || numActual === condValue) return false;
          break;
      }
    } else {
      // Exact match (string)
      if (String(actual) !== condStr) return false;
    }
  }

  return true; // All conditions matched
}

/**
 * Apply override fields to the plan (immutable — returns a new plan).
 */
function applyOverride(
  plan: ExecutionPlan,
  override: Record<string, unknown>,
): ExecutionPlan {
  const result = { ...plan };

  for (const [key, value] of Object.entries(override)) {
    switch (key) {
      case 'provider':
        result.provider = String(value);
        break;
      case 'preprocess':
        result.preprocess = value as string[];
        break;
      case 'timeout':
        result.timeout = Number(value);
        break;
      case 'retry':
        result.retry = value as ExecutionPlan['retry'];
        break;
    }
  }

  return result;
}
