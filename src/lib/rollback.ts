/**
 * Rollout undo (B34b): which ReplicaSet revision a Deployment's rollback action
 * applies to. Pure, so the "the current revision gets no action" rule is
 * testable without a component or a provider.
 */

/**
 * Whether a ReplicaSets table can offer a rollback to `revision`: the table must
 * name at least one revision, the target must be a real revision, and it must
 * not be the *current* one. The current revision is the highest — the one the
 * controller is rolling to — and rolling back to it would be a no-op that reads
 * as a mistake.
 */
export function rollbackable(revisions: number[], revision: number): boolean {
  if (revisions.length === 0 || !Number.isFinite(revision)) return false;
  return revision !== Math.max(...revisions);
}
