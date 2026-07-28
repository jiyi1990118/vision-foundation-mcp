import type { ReviewStatus } from '../benchmark/annotation-loader.js';

export type ReviewSubjectKind = 'prediction-difference' | 'ai-proposal' | 'structure-finding';
export type ReviewActionType = 'accepted' | 'rejected' | 'confirmed' | 'overridden' | 'suppressed';

export interface ReviewAction {
  id: string;
  subjectKind: ReviewSubjectKind;
  subjectId: string;
  action: ReviewActionType;
  signature?: string;
  original?: unknown;
  patch?: unknown;
  note?: string;
  createdAt: string;
}

export interface ReviewSession {
  actions: ReviewAction[];
}

export function emptyReviewSession(): ReviewSession {
  return { actions: [] };
}

export function applyReviewAction(session: ReviewSession, action: ReviewAction): ReviewSession {
  const filtered = session.actions.filter((existing) => existing.subjectKind !== action.subjectKind || existing.subjectId !== action.subjectId);
  return { actions: [...filtered, action] };
}

export function reviewStatusFor(session: ReviewSession, subjectKind: ReviewSubjectKind, subjectId: string, signature?: string): ReviewStatus | undefined {
  const action = session.actions.find((existing) => existing.subjectKind === subjectKind && existing.subjectId === subjectId);
  if (!action) return undefined;
  if (signature && action.signature && action.signature !== signature) return undefined;
  if (action.action === 'confirmed' || action.action === 'accepted') return 'confirmed';
  if (action.action === 'overridden') return 'overridden';
  if (action.action === 'suppressed' || action.action === 'rejected') return 'suppressed';
  return 'auto';
}
