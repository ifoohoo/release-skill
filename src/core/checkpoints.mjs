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
 * - Tier 2 `github-release` depends on Tier 1 `create-tag` (release `--verify-tag`).
 *
 * Marketplace actions (claude/codex/kimi/codebuddy-marketplace-install) are
 * included in the tier table for ADAPTER_ACTION_TYPE_MAP lookup but are
 * filtered out before tier grouping in both publish and reconcile. They are
 * recorded as DEFERRED with CONSUMER_VERIFICATION_DEFERRED reason and never
 * participate in tier execution. Their verification is handled exclusively
 * by the verify command.
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

/**
 * 远端写入动作类型集合。
 * 这些动作的结果决定 PUBLISHED 状态：全部一致后即可进入 PUBLISHED。
 */
export const REMOTE_WRITE_ACTION_TYPES = new Set([
  'push-commit',
  'push-snapshot',
  'set-default-branch',
  'create-tag',
  'npm-publish',
  'github-release',
]);

/**
 * 市场安装动作类型集合。
 * 这些动作的结果记录在 run 中，但不阻止 PUBLISHED 状态。
 */
export const MARKETPLACE_ACTION_TYPES = new Set([
  'claude-marketplace-install',
  'codex-marketplace-install',
  'kimi-marketplace-install',
  'codebuddy-marketplace-install',
]);

/**
 * 判断动作类型是否为远端写入动作。
 * @param {string} actionType - 计划中的动作类型
 * @returns {boolean}
 */
export function isRemoteWriteAction(actionType) {
  return REMOTE_WRITE_ACTION_TYPES.has(actionType);
}

/**
 * 判断动作类型是否为市场安装动作。
 * @param {string} actionType - 计划中的动作类型
 * @returns {boolean}
 */
export function isMarketplaceAction(actionType) {
  return MARKETPLACE_ACTION_TYPES.has(actionType);
}

/**
 * Post-publish distribution (distribute saga) checkpoint action types.
 *
 * These checkpoints are recorded in distribute run records; they never
 * appear in plan externalActions and intentionally stay OUT of
 * CHECKPOINT_ORDER / TIER_TABLE: the distribute saga schedules targets
 * strictly sequentially in dependsOn order (shared payload + sha backfill),
 * never through the publish/reconcile tier scheduler. If a distribute type
 * ever leaked into a publish plan, groupActionsByTier would fail closed on
 * it as an unknown type — exactly the desired behaviour.
 */
export const DISTRIBUTE_ACTION_TYPES = new Set([
  'distribute-probe',
  'distribute-mirror',
]);

/**
 * 判断动作类型是否为发布后分发（distribute）动作。
 * @param {string} actionType - 运行检查点中的动作类型
 * @returns {boolean}
 */
export function isDistributeAction(actionType) {
  return DISTRIBUTE_ACTION_TYPES.has(actionType);
}
