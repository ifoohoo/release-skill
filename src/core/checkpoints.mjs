/**
 * Shared checkpoint ordering and dependency-tier constants for the publish
 * and reconcile sagas.
 *
 * These were previously duplicated byte-for-byte in `commands/publish.mjs`
 * and `commands/reconcile.mjs` (the reconcile copy carried a `Must match
 * publish.mjs` comment). They live here as the single source of truth so the
 * two commands cannot drift apart (T3.1 §4.7).
 *
 * The tier table is a HARD-CODED dependency layering. It is never derived at
 * runtime (no topological sort, no dynamic inference): every dependency it
 * encodes is backed by concrete code evidence (see t3-1-parallel-checkpoints.md
 * §3). Action types absent from every tier fail closed; they are never
 * silently appended to the last tier.
 *
 * @module core/checkpoints
 */

/**
 * Checkpoint order for the publish/reconcile sagas.
 *
 * Used to sort a plan's external actions into a deterministic execution
 * order. Action types not present here sort to the end (index 999), matching
 * the legacy inline comparator in publish.mjs.
 */
export const CHECKPOINT_ORDER = [
  'push-commit',
  'push-snapshot',
  'set-default-branch',
  'create-tag',
  'npm-publish',
  'github-release',
  'claude-marketplace-install',
  'codex-marketplace-install',
  'kimi-marketplace-install',
  'codebuddy-marketplace-install',
];

/**
 * Map plan action type to adapter ActionType.
 *
 * Plan uses `push-commit`, `push-snapshot`, `create-tag`, `npm-publish`,
 * `github-release`. The adapter contract uses `git-push`, `git-tag`,
 * `npm-publish`, `github-release`.
 */
export const ADAPTER_ACTION_TYPE_MAP = {
  'push-commit': 'git-push',
  'push-snapshot': 'push-snapshot',
  'set-default-branch': 'set-default-branch',
  'create-tag': 'git-tag',
  'npm-publish': 'npm-publish',
  'github-release': 'github-release',
  'claude-marketplace-install': 'claude-marketplace-install',
  'codex-marketplace-install': 'codex-marketplace-install',
  'kimi-marketplace-install': 'kimi-marketplace-install',
  'codebuddy-marketplace-install': 'codebuddy-marketplace-install',
};

/**
 * Hard-coded dependency tiers for parallel checkpoint execution (T3.1 §4.1).
 *
 * Tiers execute strictly serially (a whole tier completes before the next
 * begins); the actions within a tier are independent and run concurrently.
 * Each entry's dependency is backed by code evidence:
 * - Tier 1 `set-default-branch` / `create-tag` depend on Tier 0
 *   `push-snapshot` (the frozen commit must exist on the remote before a tag
 *   or branch tip can point at it). `npm-publish` has no git dependency and is
 *   placed in Tier 1 only for conservative scheduling.
 * - Tier 2 `github-release` and the claude/codex marketplace installs depend
 *   on Tier 1 `create-tag` (release `--verify-tag`; install ref is the tag).
 * - Tier 3 `kimi-marketplace-install` depends on Tier 2 `github-release`
 *   (its install URL points at the Release page). `codebuddy-marketplace-install`
 *   is also a non-automatable human-attestation closure and runs in Tier 3 after
 *   the automated writes (its install is from a unified marketplace, proven by a
 *   human attestation rather than an automated install checkpoint).
 *
 * Action types not listed in any tier are unknown to the scheduler and fail
 * closed (see groupActionsByTier); they are never silently scheduled.
 */
export const TIER_TABLE = [
  ['push-commit', 'push-snapshot'],                                              // Tier 0
  ['set-default-branch', 'create-tag', 'npm-publish'],                          // Tier 1
  ['github-release', 'claude-marketplace-install', 'codex-marketplace-install'], // Tier 2
  ['kimi-marketplace-install', 'codebuddy-marketplace-install'],                // Tier 3
];

/** Fast reverse lookup: action type -> tier index (-1 when unknown). */
const TIER_OF = new Map();
TIER_TABLE.forEach((tierTypes, tierIndex) => {
  for (const type of tierTypes) {
    TIER_OF.set(type, tierIndex);
  }
});

/**
 * Return the tier index for an action type, or -1 if the type is not present
 * in any tier (i.e. unknown to the scheduler and must fail closed).
 *
 * @param {string} actionType - The plan action type.
 * @returns {number} Tier index (0-based) or -1.
 */
export function tierOfActionType(actionType) {
  return TIER_OF.has(actionType) ? TIER_OF.get(actionType) : -1;
}

/**
 * Sort external actions by CHECKPOINT_ORDER.
 *
 * Action types not in CHECKPOINT_ORDER sort to the end (index 999), matching
 * the legacy inline comparator. Returns a new array; the input is not mutated.
 *
 * @param {Object[]} actions - External actions (each has a `type`).
 * @returns {Object[]} A new sorted array.
 */
export function sortActionsByCheckpointOrder(actions) {
  return (actions ?? []).slice().sort((a, b) => {
    const ai = CHECKPOINT_ORDER.indexOf(a.type);
    const bi = CHECKPOINT_ORDER.indexOf(b.type);
    return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
  });
}

/**
 * Group an ordered list of external actions into dependency tiers.
 *
 * Actions are bucketed by TIER_TABLE; within a tier the input order is
 * preserved (callers pass CHECKPOINT_ORDER-sorted actions). Actions whose type
 * is absent from every tier are collected in `unknown` so the caller can fail
 * closed instead of silently scheduling an unrecognized external write.
 *
 * @param {Object[]} orderedActions - CHECKPOINT_ORDER-sorted external actions.
 * @returns {{ tiers: Object[][], unknown: Object[] }}
 *   `tiers[i]` is the array of actions in tier i (possibly empty);
 *   `unknown` holds actions whose type is not in any tier.
 */
export function groupActionsByTier(orderedActions) {
  const tiers = TIER_TABLE.map(() => []);
  const unknown = [];
  for (const action of orderedActions ?? []) {
    const tierIndex = tierOfActionType(action.type);
    if (tierIndex === -1) {
      unknown.push(action);
    } else {
      tiers[tierIndex].push(action);
    }
  }
  return { tiers, unknown };
}
