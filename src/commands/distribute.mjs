/**
 * Distribute command: post-publish distribution saga (R1–R4).
 *
 * After publish has pushed the frozen tag, `distributeRelease` mirrors the
 * release payload to the consumer-declared postPublish targets (append-only
 * git mirrors + marketplace indexes) through the distribute-git adapter.
 *
 * Timing contract (R1): the payload may ONLY ever come from a detached git
 * worktree checked out at the frozen `postPublish.tagCommit` — never from
 * the live workspace, which has already moved ahead. Since F-06 / T6 the
 * frozen plan selects exactly one of two staging routes:
 * - a consumer materialize hook (when declared): it runs inside that
 *   worktree and announces the isolated payload directory through its
 *   `outputMarker` line;
 * - the Foundation managed projection (when the plan declares no materialize
 *   hook): the frozen `postPublish.executionBundle.publicFiles` mapping is
 *   staged from the tag worktree into a fresh `hub-payload` root through the
 *   Engineering Kit `compileProjectionPlan`/`runProjection` contract —
 *   never by live project configuration and never by a parent-workspace
 *   script.
 *
 * Private execution bundle (F-01 / T1): consumer-declared hook commands
 * (materialize, steps, custom distribute-phase hooks) may reference scripts
 * by workspace-relative paths that the frozen tag tree never contains —
 * parent-workspace tooling never leaks into the public surface. prepare
 * freezes those files (closed-world `executionFiles` manifest) into the
 * plan's `postPublish.executionBundle` and publishes the bytes
 * digest-addressed under the plan's `.release-skill`. Before ANY hook runs,
 * distribute strictly re-reads the bundle bytes, recomputes the closure
 * through Foundation, and installs ONLY the verified bytes into the tag
 * worktree (never overwriting tag files). Live-workspace copying and the
 * RELEASE_SKILL_WORKSPACE_ROOT injection are gone: after the freeze, the
 * workspace copies are never read back. The payload timing contract is
 * untouched: payload content must still be produced from the frozen
 * checkout and the announced payload directory must stay inside the
 * worktree.
 *
 * Safety gates (all verified before any adapter execute):
 *  1. plan schema validation
 *  2. plan digest verification (computePlanDigest vs plan.digest)
 *  3. approval record validation (core/approval.mjs)
 *  4. source run lineage: publish|reconcile run at PUBLISHED|VERIFIED whose
 *     planDigest matches the frozen plan (loadRun requireDigest)
 *  5. tag identity (R-01): the frozen create-tag action + same-lineage
 *     PUBLISHED source run checkpoint + frozen git objects + PUBLIC remote
 *     observation are the authority; the live local tag is diagnostic only
 *  5b. optional assertMainVersionAhead (public main line moved past the tag)
 *  6. postPublish declaration re-validation (core/postpublish.mjs)
 *  7. per-target reachability preflight (DISTRIBUTE_PROBE)
 *
 * Reconcile equivalence: a rerun IS the reconcile. Every target is observed
 * BEFORE any write; a remote whose tag exists and whose branch tip equals
 * the tag oid is SKIPPED (CONSISTENT) without executing. distribute never
 * forces: NO_CHANGE is reported honestly, existing-tag conflicts fail closed.
 *
 * Failure semantics:
 * - Gate failures THROW ReleaseError. From the source-run gate on (lineage
 *   known) a BLOCKED run record is persisted before rethrowing.
 * - Target failures RETURN: PARTIAL when at least one push succeeded,
 *   BLOCKED when zero writes landed. Targets after a failure are skipped.
 *
 * @module commands/distribute
 */

import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { realpath, lstat, mkdir, readFile, rm } from 'node:fs/promises';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';

import { assertImmutablePlanAuthority, computePlanDigest, validatePlan } from '../core/plan.mjs';
import {
  assertImmutableApprovalAuthority,
  computeApprovalDigest,
  validateApproval,
  validateApprovalRecordSchema,
} from '../core/approval.mjs';
import {
  appendRunState,
  createProductionRunDir,
  loadRun,
  resolveDefaultRunDir,
  validateRunPlanDigest,
  validateRunLineage,
  validateRunCheckpointMapping,
  writeRunAtomic,
} from '../core/run.mjs';
import { asError, createEvidenceWriter } from '../core/evidence.mjs';
import {
  resolveFrozenTagAuthority,
  createFrozenTagWorktree,
  assertMainLineAhead,
} from '../core/tag-authority.mjs';
import { runHook } from '../core/hooks.mjs';
import { boundedOutputTail } from '../core/bounded-output.mjs';
import {
  orderTargetsByDependency,
  validatePostPublishDeclaration,
  buildPostPublishContext,
  normalizePostPublishDeclaration,
  normalizePostPublishView,
  orderNormalizedHooks,
  effectiveHookRequiresApproval,
  postPublishActionId,
  validatePostPublishHookIdUniqueness,
  POSTPUBLISH_CONTEXT_ENV,
  PAYLOAD_SOURCE_TAG_WORKTREE,
} from '../core/postpublish.mjs';
import { verifyAndInstallExecutionBundle, verifyExecutionBundle } from '../core/postpublish-bundle.mjs';
import { projectPublicPayload, PROJECTION_MECHANISM, PUBLIC_PAYLOAD_DIRNAME } from '../core/postpublish-projection.mjs';
import { assertPostPublishApprovalAuthority, validatePostPublishApproval } from '../core/postpublish-approval.mjs';
import { readRunRecovery } from '../core/recovery.mjs';
import { executePresetHook, preflightPresetHook } from '../core/preset-executor.mjs';
import {
  ReleaseError,
  GATE_FAILED,
  POST_PUBLISH_VERIFY_FAILED,
  REMOTE_CONFLICT,
  REMOTE_UNAVAILABLE,
} from '../core/errors.mjs';
import { ActionType } from '../adapters/contract.mjs';

const execFileAsync = promisify(execFileCb);

/** Executor identity recorded in every distribute checkpoint trace. */
const EXECUTOR = 'release-skill distribute';

/** Full 40-hex commit sha. */
const SHA_RE = /^[a-f0-9]{40}$/;

/** Checkpoint error codes accepted by the release-run schema enum. */
const SCHEMA_ERROR_CODES = new Set([
  'CONFIG_INVALID',
  'BASELINE_CHANGED',
  'DIRTY_SCOPE_CONFLICT',
  'GATE_FAILED',
  'AUTH_MISSING',
  'REMOTE_CONFLICT',
  'REMOTE_UNAVAILABLE',
  'HOOK_TIMEOUT',
  'PARTIAL_RELEASE',
  'POST_PUBLISH_VERIFY_FAILED',
]);

/** Run statuses. */
const DISTRIBUTING = 'DISTRIBUTING';
const DISTRIBUTED = 'DISTRIBUTED';
const PARTIAL = 'PARTIAL';
const BLOCKED = 'BLOCKED';
const NEEDS_INPUT = 'NEEDS_INPUT';

function defaultClock() {
  return new Date().toISOString();
}

function defaultExec(command, args, options = {}) {
  return execFileAsync(command, args, { shell: false, encoding: 'utf8', timeout: 120_000, ...options });
}

/** Map an adapter/details error code onto the run-schema checkpoint enum. */
function mapToSchemaCode(code) {
  return SCHEMA_ERROR_CODES.has(code) ? code : GATE_FAILED;
}

/**
 * Parse the first JSON object line from hook stdout
 * (`requireReport.parse: "stdout-first-json"`).
 *
 * @param {string} stdout
 * @returns {Object|null} The first line that parses to a plain object.
 */
export function parseFirstJsonObject(stdout) {
  for (const line of `${stdout ?? ''}`.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    try {
      const value = JSON.parse(trimmed);
      if (value && typeof value === 'object' && !Array.isArray(value)) return value;
    } catch {
      // Not JSON: keep scanning (hooks may print brace-prefixed noise).
    }
  }
  return null;
}

/**
 * Resolve the LAST stdout line containing the output marker to the text
 * after the marker (the announced payload directory).
 *
 * @param {string} stdout
 * @param {string} marker
 * @returns {string|null}
 */
export function parseOutputMarker(stdout, marker) {
  const lines = `${stdout ?? ''}`.split('\n');
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const markerIndex = lines[index].indexOf(marker);
    if (markerIndex >= 0) {
      return lines[index].slice(markerIndex + marker.length).trim();
    }
  }
  return null;
}

/** Assert `candidate` is a real directory contained inside `container`. */
async function assertContainedDirectory(container, candidate, label) {
  let real;
  try {
    real = await realpath(candidate);
  } catch {
    throw new ReleaseError(
      POST_PUBLISH_VERIFY_FAILED,
      `${label} does not resolve to an existing path`,
      { candidate },
    );
  }
  const containerReal = await realpath(container);
  const rel = relative(containerReal, real);
  if (rel === '' || isAbsolute(rel) || rel === '..'
    || rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)) {
    throw new ReleaseError(
      POST_PUBLISH_VERIFY_FAILED,
      `${label} escapes the tag worktree; payload must stay inside the frozen checkout`,
      { candidate },
    );
  }
  const stats = await lstat(real).catch(() => null);
  if (!stats || !stats.isDirectory()) {
    throw new ReleaseError(
      POST_PUBLISH_VERIFY_FAILED,
      `${label} is not a directory`,
      { candidate },
    );
  }
  return real;
}

/**
 * Resolve the marketplace pluginName from the frozen plan unit's
 * distributions: claude-plugin first, codex-plugin as fallback.
 */
function resolvePluginName(plan, unitId) {
  const unit = (plan.units ?? []).find((entry) => entry.id === unitId);
  const distributions = unit?.distributions ?? [];
  const pluginDistribution = distributions.find((entry) => entry.type === 'claude-plugin')
    ?? distributions.find((entry) => entry.type === 'codex-plugin');
  if (!pluginDistribution || typeof pluginDistribution.plugin !== 'string' || pluginDistribution.plugin.length === 0) {
    throw new ReleaseError(
      GATE_FAILED,
      `marketplace-index targets require a claude-plugin or codex-plugin distribution with a plugin name on unit "${unitId}"`,
      { unitId },
    );
  }
  return pluginDistribution.plugin;
}

/**
 * Execute the post-publish distribution saga for a frozen, approved plan.
 *
 * @param {Object} options
 * @param {string} options.planPath - Absolute path to the frozen release plan.
 * @param {string} options.approvalPath - Absolute path to the approval record.
 * @param {string} options.sourceRunPath - Absolute path to the sealed publish/reconcile run.
 * @param {Object} options.adapterRegistry - Registry carrying the distribute adapter.
 * @param {string} [options.root] - Project root (git repository). Defaults to cwd.
 * @param {string} [options.runDir] - Evidence directory override.
 * @param {boolean} [options.dryRun] - Stop before remote pushes (adapter-level).
 * @param {() => string} [options.clock] - Clock function returning ISO-8601 strings.
 * @param {Function} [options.execFn] - Injectable git exec (tests).
 * @param {Function} [options.runHookFn] - Injectable hook runner (tests).
 * @param {string[]} [options.postpublishApprovalPaths] - Checkpoint approval
 *   records for requiresApproval postPublish hooks (v0.6.3 R1); each record
 *   binds (planDigest, hookId), must be consumed from the immutable
 *   digest-addressed authority minted by approvePostPublishHook (F-02), and
 *   is validated fail-closed before any write.
 *
 * @returns {Promise<{ planPath: string, runPath: string, status: string, checkpoints: Object[] }>}
 *
 * @throws {ReleaseError} on any safety-gate failure (BLOCKED record persisted
 *   once the source-run lineage is known).
 */
export async function distributeRelease(options) {
  const {
    planPath,
    approvalPath,
    sourceRunPath,
    adapterRegistry,
    root = process.cwd(),
    runDir: runDirOpt,
    dryRun = false,
    clock: clockOpt,
    execFn,
    runHookFn,
    postpublishApprovalPaths,
    observeTagFn,
    observeBranchFn,
  } = options ?? {};

  const clockFn = typeof clockOpt === 'function' ? clockOpt : defaultClock;
  const exec = typeof execFn === 'function' ? execFn : defaultExec;
  const hookRunner = typeof runHookFn === 'function' ? runHookFn : runHook;

  // =========================================================================
  // Gate 1: load and validate the frozen plan (before any write — a rejected
  // plan must never allocate a run authority).
  // =========================================================================
  let planRaw;
  try {
    planRaw = await readFile(planPath, 'utf8');
  } catch (err) {
    throw new ReleaseError(GATE_FAILED, `cannot read release plan: ${err.message}`, { planPath, cause: err.code });
  }
  let plan;
  try {
    plan = JSON.parse(planRaw);
  } catch (err) {
    throw new ReleaseError(GATE_FAILED, `release plan is not valid JSON: ${err.message}`, { planPath });
  }
  validatePlan(plan);
  assertImmutablePlanAuthority(planPath, plan);

  const actualDigest = computePlanDigest(plan);
  if (plan.digest && plan.digest !== actualDigest) {
    throw new ReleaseError(
      GATE_FAILED,
      `plan digest mismatch: expected ${String(plan.digest).slice(0, 16)}..., computed ${actualDigest.slice(0, 16)}...`,
      { expected: plan.digest, actual: actualDigest },
    );
  }
  // v3 contract (§4.3): postPublish is a frozen declaration ARRAY. Every
  // downstream read goes through the single read-only normalization entry
  // normalizePostPublishView — never a direct single-object read. Legacy
  // (planVersion 1/2) absent stays fail-closed exactly as before; a v3 empty
  // array is legal and means "no post-release execution" (handled right after
  // the run authority is allocated, below).
  const declarations = normalizePostPublishView(plan);
  // Rework R-02: the single array-level explicit-hook-id uniqueness authority
  // (core/postpublish.mjs) re-asserts the frozen view here — a digest-correct,
  // schema-valid plan with duplicate hook ids across units must fail before
  // any run authority, approval consumption, or side effect.
  validatePostPublishHookIdUniqueness(declarations);
  if (declarations.length === 0 && plan.planVersion !== 3) {
    throw new ReleaseError(
      GATE_FAILED,
      'release plan has no postPublish declaration; nothing to distribute',
      { planPath },
    );
  }

  // =========================================================================
  // Run authority + evidence. Every subsequent gate failure is evidenced.
  // =========================================================================
  const runId = `distribute-${Date.now()}`;
  let runDir = runDirOpt ?? resolveDefaultRunDir(planPath, 'distribute', runId);
  if (plan.production?.mode === 'github-npm-v1') {
    runDir = await createProductionRunDir(runDir, planPath);
  } else {
    await mkdir(runDir, { recursive: true });
  }
  const runPath = join(runDir, 'release-run.json');
  const evidence = createEvidenceWriter({ runDir, command: 'distribute', clock: clockFn });

  // Lineage becomes known at gate 3; only then may a BLOCKED record persist.
  let lineageKnown = false;
  let sourceRunId = null;
  let sourceRunDigest = null;
  let finalRecordWritten = false;

  // Saga-level chain state (single run authority; §6 matrix classification).
  // Declared up here so every failBlocked/catch path can classify PARTIAL vs
  // BLOCKED from the external-success facts (rework R-01): an exception after
  // a successful external checkpoint must never be recorded BLOCKED.
  let stopped = false;
  let stopReason = null; // 'TARGET' | 'HOOK' — which failure stopped the saga (rework R-03).
  let failures = 0;
  let pushedWrites = 0;
  let awaitingApproval = 0;
  let hookSuccesses = 0;

  const startedAt = clockFn();
  let checkpoints = [];
  let stateSequence = -1;

  const buildPersistedState = (status, finishedAt) => ({
    runId,
    command: 'distribute',
    status,
    planDigest: plan.digest ?? actualDigest,
    planPath,
    ...(approvalDigestValue ? { approvalDigest: approvalDigestValue } : {}),
    ...(approvalPath ? { approvalPath } : {}),
    ...(sourceRunId ? { sourceRunId } : {}),
    ...(sourceRunDigest ? { sourceRunDigest } : {}),
    ...(sourceRunPath ? { sourceRunPath } : {}),
    startedAt,
    ...(finishedAt ? { finishedAt } : {}),
    checkpoints: checkpoints.map((cp) => ({
      actionId: cp.actionId,
      actionType: cp.actionType,
      status: cp.status === 'SUCCEEDED' ? 'succeeded'
        : cp.status === 'FAILED' ? 'failed'
        : cp.status === 'SKIPPED' ? 'skipped'
        : cp.status === 'UNCERTAIN' ? 'uncertain'
        : cp.status === 'PENDING' ? 'pending'
        : cp.status, // NO_CHANGE passes through as-is
      ...(cp.preObserve ? { preObserve: cp.preObserve } : {}),
      ...(cp.postObserve ? { postObserve: cp.postObserve } : {}),
      ...(cp.remoteUrl ? { remoteUrl: cp.remoteUrl } : {}),
      ...(cp.branch ? { branch: cp.branch } : {}),
      ...(cp.tag ? { tag: cp.tag } : {}),
      ...(cp.tagCommit ? { tagCommit: cp.tagCommit } : {}),
      ...(cp.previousHead ? { previousHead: cp.previousHead } : {}),
      ...(cp.pushedCommit ? { pushedCommit: cp.pushedCommit } : {}),
      ...(cp.mode ? { mode: cp.mode } : {}),
      ...(cp.executor ? { executor: cp.executor } : {}),
      ...(cp.payloadFileCount !== undefined ? { payloadFileCount: cp.payloadFileCount } : {}),
      ...(cp.startedAt ? { startedAt: cp.startedAt } : {}),
      ...(cp.finishedAt ? { finishedAt: cp.finishedAt } : {}),
      ...(cp.reason ? { reason: cp.reason } : {}),
      ...(cp.error ? { error: { code: cp.error.code, ...(cp.error.message ? { message: cp.error.message } : {}) } } : {}),
    })),
  });

  const snapshot = async (status) => {
    stateSequence += 1;
    return appendRunState(runDir, stateSequence, buildPersistedState(status));
  };

  /**
   * Persist the failure run record once lineage is known (idempotent).
   * Rework R-01: an exception after a successful external checkpoint enters
   * PARTIAL (the success checkpoint is retained — never rolled back); a
   * failure with zero external successes stays BLOCKED.
   */
  const recordFailure = async () => {
    if (finalRecordWritten || !lineageKnown) return;
    const externalCheckpointSuccesses = pushedWrites + hookSuccesses;
    const status = externalCheckpointSuccesses > 0 ? PARTIAL : BLOCKED;
    try {
      await writeRunAtomic(runPath, buildPersistedState(status, clockFn()));
      finalRecordWritten = true;
    } catch {
      // Persistence must never mask the primary failure.
    }
  };

  let approvalDigestValue = null;

  // Worktree cleanup: registered exactly once, idempotent, failure-tolerant.
  // R-01: the worktree is built from a COPY of the frozen bare repo and is
  // never registered in the source repo's worktree metadata, so removing the
  // scratch base is the complete cleanup (no `git worktree remove`).
  let worktreePath = null;
  let tmpBase = null;
  const cleanupWorktree = async () => {
    if (tmpBase) {
      await rm(tmpBase, { recursive: true, force: true }).catch(() => {});
      tmpBase = null;
      worktreePath = null;
    }
  };

  try {
    // =======================================================================
    // Gate 2: approval record validation.
    // =======================================================================
    await evidence.append({ phase: 'safety-gate', gate: 'approval-load', status: 'started' });

    let approvalRaw;
    try {
      approvalRaw = await readFile(approvalPath, 'utf8');
    } catch (err) {
      throw new ReleaseError(GATE_FAILED, `cannot read approval record: ${err.message}`, { approvalPath, cause: err.code });
    }
    let approval;
    try {
      approval = JSON.parse(approvalRaw);
    } catch (err) {
      throw new ReleaseError(GATE_FAILED, `approval record is not valid JSON: ${err.message}`, { approvalPath });
    }

    approvalDigestValue = assertImmutableApprovalAuthority(approvalPath, plan, approvalRaw)
      ?? computeApprovalDigest(approvalRaw);

    validateApprovalRecordSchema(approval);
    // distribute is a post-publish phase: like reconcile/verify it validates
    // the approval binding (planDigest/approvedActions/digest) without
    // requiring an unexpired window — distribution may legitimately happen
    // after the 24h publish-approval window. requiresApproval hook approvals
    // remain expiry-enforced by validatePostPublishApproval.
    // requireUnexpired: false aligns with reconcile.mjs:321 and
    // verify.mjs:1098; the binding checks (plan digest, approved actions,
    // approval digest) are NOT relaxed here — only the expiry window is
    // waived for the post-publish phase.
    validateApproval(plan, approval, { clock: clockFn, requireUnexpired: false });

    await evidence.append({ phase: 'safety-gate', gate: 'approval-validated', status: 'passed' });

    // =======================================================================
    // Gate 3: source run lineage (publish|reconcile at PUBLISHED|VERIFIED,
    // digest-bound to the same frozen plan).
    // =======================================================================
    await evidence.append({ phase: 'safety-gate', gate: 'source-run', status: 'started', sourceRunPath });

    const sourceRun = await loadRun(sourceRunPath, { requireDigest: true });
    if (!['publish', 'reconcile'].includes(sourceRun.command)) {
      throw new ReleaseError(
        GATE_FAILED,
        `source run command must be publish or reconcile, got "${sourceRun.command}"`,
        { sourceRunPath, command: sourceRun.command },
      );
    }
    if (!['PUBLISHED', 'VERIFIED'].includes(sourceRun.status)) {
      throw new ReleaseError(
        GATE_FAILED,
        `source run must be PUBLISHED or VERIFIED before distribute, got "${sourceRun.status}"`,
        { sourceRunPath, status: sourceRun.status },
      );
    }
    validateRunPlanDigest(sourceRun, plan, { planPath });
    await validateRunLineage(sourceRun, {
      plan, planPath, runPath: sourceRunPath, production: Boolean(plan.production),
    });

    sourceRunId = sourceRun.runId;
    sourceRunDigest = sourceRun.runDigest;
    lineageKnown = true;
    validateRunCheckpointMapping(sourceRun, plan.externalActions ?? []);

    await evidence.append({
      phase: 'safety-gate',
      gate: 'source-run',
      status: 'passed',
      sourceRunId,
      sourceRunStatus: sourceRun.status,
    });

    if (declarations.length === 0) {
      // v3 zero declarations (§6 matrix row 0): the post-release phase is
      // skipped — no adapter call, no hook, no external write. The run keeps
      // the full safety-gate chain (plan, approval, source-run lineage) and
      // records an honest DISTRIBUTED skip bound to the source run.
      await evidence.append({
        phase: 'postpublish',
        status: 'skipped',
        reason: 'ZERO_DECLARATIONS',
        planVersion: plan.planVersion,
      });
      await snapshot(DISTRIBUTED);
      await writeRunAtomic(runPath, buildPersistedState(DISTRIBUTED, clockFn()));
      finalRecordWritten = true;
      await evidence.append({
        phase: 'distribute',
        status: 'completed',
        overallStatus: DISTRIBUTED,
        checkpointStatuses: [],
      });
      await evidence.finish({ status: DISTRIBUTED, planPath, runPath, finishedAt: clockFn() });
      return { planPath, runPath, status: DISTRIBUTED, checkpoints: [], recoveryActionCode: null };
    }

    // =======================================================================
    // Phase A — full read-only preflight across ALL declarations (v3 contract
    // §4.3): structure, identity, remote pre-facts and provided approvals are
    // computed for every declaration BEFORE the first external write. A later
    // declaration failing preflight means NO declaration may have produced an
    // external write. Legacy plans present exactly one declaration (via
    // normalizePostPublishView) and keep their exact behavior.
    // =======================================================================
    const v3 = plan.planVersion === 3;
    // Checkpoint action ids are namespaced by the frozen unitId on v3 so a
    // checkpoint stays addressable across units; legacy ids are unchanged
    // (existing runs, tests and approvals pin the bare local ids). The
    // derivation is shared core/postpublish.mjs `postPublishActionId` so
    // recovery/verify mappings can never drift from the executed records.
    const unitActionId = (unitId, localId) => postPublishActionId({ planVersion: plan.planVersion, unitId, localId });

    /** Gate failure after lineage is known: persist the failure record
     * (BLOCKED at zero external successes, PARTIAL once one exists — rework
     * R-01), then rethrow. */
    const failBlocked = async (error) => {
      await recordFailure();
      throw error;
    };

    // --- Phase A1: declaration structure validation + normalization ---
    // R2: preset references resolve against the built-in preset registry
    // (core/presets.mjs); per-preset config validation (dual addressing,
    // marketplace/staticFiles shapes, secret scan) fails closed here — for
    // EVERY declaration, before any adapter call or external write.
    // R-01 (rework): the frozen execution bundle closure is re-verified for
    // EVERY declaration here too (store re-read + Foundation closure
    // recomputation, the exact implementation the Phase B install reuses) —
    // a later declaration's missing/drifted bundle must fail the whole saga
    // BEFORE unit A writes anything.
    const prepared = [];
    for (const declaration of declarations) {
      validatePostPublishDeclaration(declaration, { unitId: declaration.unitId });
      await verifyExecutionBundle({ planPath, postPublish: declaration });
      const orderedTargets = orderTargetsByDependency(declaration.targets ?? []);

      // Normalized hook table (design §2.2): every targets[] entry maps onto
      // a preset hook (payload-mirror -> git-mirror, marketplace-index ->
      // marketplace-index-render); the table is a deterministic projection of
      // the digest-bound declaration, ordered by dependency topology +
      // declaration order. Target execution below keeps the exact legacy
      // semantics; hooks[] preset execution dispatches in the hook loop
      // (proposal-inbox git-push is wired; other presets fail closed until
      // their behavior ships).
      const normalizedDeclaration = normalizePostPublishDeclaration(declaration);
      const orderedNormalizedHooks = orderNormalizedHooks(normalizedDeclaration.hooks);

      // postPublish hooks (v0.6.3 R1): distribute-phase hooks run in this
      // saga; postVerify-phase hooks belong to the independent postVerify run
      // (R3) and are only evidenced here — never executed, never silent.
      const declaredHooks = declaration.hooks ?? [];
      const distributeHooks = declaredHooks.filter((hook) => (hook.phase ?? 'distribute') === 'distribute');
      const deferredPostVerifyHooks = declaredHooks.length - distributeHooks.length;
      await evidence.append({
        phase: 'postpublish-normalization',
        status: 'passed',
        unitId: declaration.unitId,
        preGates: normalizedDeclaration.preGates.map((gate) => gate.gate),
        hookCount: orderedNormalizedHooks.length,
        hookIds: orderedNormalizedHooks.map((hook) => hook.id),
      });
      prepared.push({
        declaration,
        orderedTargets,
        normalizedDeclaration,
        orderedNormalizedHooks,
        distributeHooks,
        deferredPostVerifyHooks,
      });
    }

    // =======================================================================
    // Gate: checkpoint approvals for requiresApproval hooks. Every provided
    // record is validated fail-closed BEFORE any write: first the immutable
    // authority binding (F-02: the consumption path must BE the digest-
    // addressed authority minted by approvePostPublishHook — recomputed
    // planDigest directory, recomputed approvalDigest file name, strict
    // no-follow regular-file read, no symlinked ancestor), then the content
    // checks (schema, planDigest binding, declared hook, requiresApproval,
    // 24h window, expiry). A bad approval aborts the whole saga; a missing
    // one parks the hook at AWAITING_APPROVAL.
    // =======================================================================
    const approvedHookIds = new Set();
    const hookApprovalPaths = postpublishApprovalPaths ?? [];
    if (hookApprovalPaths.length > 0) {
      await evidence.append({
        phase: 'safety-gate',
        gate: 'postpublish-hook-approvals',
        status: 'started',
        approvalCount: hookApprovalPaths.length,
      });
      for (const hookApprovalPath of hookApprovalPaths) {
        let hookApprovalRaw;
        try {
          hookApprovalRaw = await readFile(hookApprovalPath, 'utf8');
        } catch (err) {
          await failBlocked(new ReleaseError(
            GATE_FAILED,
            `cannot read postpublish hook approval: ${err.message}`,
            { hookApprovalPath, cause: err.code },
          ));
        }
        let hookApproval;
        try {
          hookApproval = JSON.parse(hookApprovalRaw);
        } catch (err) {
          await failBlocked(new ReleaseError(
            GATE_FAILED,
            `postpublish hook approval is not valid JSON: ${err.message}`,
            { hookApprovalPath },
          ));
        }
        // F-02: identical bytes anywhere else are not an approval. The
        // authority assertion runs before content validation and before the
        // hook may enter approvedHookIds.
        try {
          await assertPostPublishApprovalAuthority(planPath, hookApprovalPath, plan, hookApprovalRaw);
        } catch (err) {
          await failBlocked(err instanceof ReleaseError ? err : new ReleaseError(
            GATE_FAILED,
            `postpublish hook approval authority check failed: ${err?.message ?? err}`,
            { hookApprovalPath },
          ));
        }
        validatePostPublishApproval(plan, hookApproval, { clock: clockFn });
        if (approvedHookIds.has(hookApproval.hookId)) {
          await failBlocked(new ReleaseError(
            GATE_FAILED,
            `duplicate postpublish hook approvals for hook "${hookApproval.hookId}"`,
            { hookId: hookApproval.hookId },
          ));
        }
        approvedHookIds.add(hookApproval.hookId);
      }
      await evidence.append({
        phase: 'safety-gate',
        gate: 'postpublish-hook-approvals',
        status: 'passed',
        approvedHookIds: [...approvedHookIds],
      });
    }

    // Hooks whose checkpoint approval is still missing (across ALL
    // declarations; hook ids are globally unique). While any exist, the
    // declared postPublish steps (unaudited project code) must not execute:
    // the run parks at NEEDS_INPUT/PARTIAL and the approved reconcile rerun
    // re-executes them. Targets remain plan-approval-authorized idempotent
    // remote-state convergence and are unaffected.
    const pendingHookApprovals = prepared.flatMap((prep) => prep.distributeHooks.filter(
      (hook) => effectiveHookRequiresApproval(hook) && !approvedHookIds.has(hook.id),
    ));

    // Checkpoint registry: per declaration, one probe + one mirror per target
    // (declared order), then one postpublish-hook checkpoint per distribute-
    // phase hook. Action ids are unit-namespaced on v3 (unitActionId).
    checkpoints = [];
    for (const prep of prepared) {
      const { declaration, orderedTargets, distributeHooks } = prep;
      for (const target of orderedTargets) {
        checkpoints.push({
          actionId: unitActionId(declaration.unitId, `probe-${target.id}`),
          actionType: ActionType.DISTRIBUTE_PROBE,
          status: 'PENDING',
          remoteUrl: target.remoteUrl,
          branch: target.branch,
          tag: declaration.tag,
          executor: EXECUTOR,
        });
      }
      for (const target of orderedTargets) {
        checkpoints.push({
          actionId: unitActionId(declaration.unitId, target.id),
          actionType: ActionType.DISTRIBUTE_MIRROR,
          status: 'PENDING',
          remoteUrl: target.remoteUrl,
          branch: target.branch,
          tag: declaration.tag,
          tagCommit: SHA_RE.test(declaration.tagCommit ?? '') ? declaration.tagCommit : undefined,
          executor: EXECUTOR,
        });
      }
      for (const hook of distributeHooks) {
        checkpoints.push({
          actionId: unitActionId(declaration.unitId, hook.id),
          actionType: 'postpublish-hook',
          status: 'PENDING',
          executor: EXECUTOR,
        });
      }
    }
    const checkpointById = new Map(checkpoints.map((cp) => [cp.actionId, cp]));

    // Durable pre-execute authority (seq 0).
    await snapshot(DISTRIBUTING);

    // =======================================================================
    // Gate 4: tag identity via the frozen authority chain (R-01). The frozen
    // plan binding + same-lineage PUBLISHED source-run checkpoint + frozen
    // git objects + PUBLIC remote observation are the authority; the live
    // local tag is diagnostic only (a fresh split source repo legitimately
    // has no local tag). Missing binding/objects/lineage fails closed as
    // GATE_FAILED; remote tag missing/drifted is a REMOTE_CONFLICT requiring
    // human decision. Runs per declaration, in frozen order, all read-only.
    // =======================================================================
    for (const prep of prepared) {
      const { declaration } = prep;
      await evidence.append({
        phase: 'safety-gate',
        gate: 'tag-identity',
        status: 'started',
        unitId: declaration.unitId,
      });

      if (declaration.payloadSource !== PAYLOAD_SOURCE_TAG_WORKTREE) {
        await failBlocked(new ReleaseError(
          GATE_FAILED,
          `postPublish.payloadSource must be "${PAYLOAD_SOURCE_TAG_WORKTREE}"`,
          { payloadSource: declaration.payloadSource, unitId: declaration.unitId },
        ));
      }
      if (typeof declaration.tagCommit !== 'string' || !SHA_RE.test(declaration.tagCommit)) {
        await failBlocked(new ReleaseError(
          GATE_FAILED,
          'postPublish is missing a frozen tagCommit binding; distribute fails closed',
          { tagCommit: declaration.tagCommit ?? null, unitId: declaration.unitId },
        ));
      }

      let tagAuthority;
      try {
        tagAuthority = await resolveFrozenTagAuthority({
          plan,
          unitId: declaration.unitId,
          sourceRun,
          root,
          exec,
          observeTagFn,
          observeBranchFn,
          // 裁决 15: the public main line is observed only for the explicit
          // optional gate; with it off, no branch observation happens at all.
          observeMainLine: declaration.assertMainVersionAhead === true,
        });
      } catch (err) {
        await evidence.append({
          phase: 'safety-gate',
          gate: 'tag-identity',
          status: 'failed',
          error: asError('TAG_IDENTITY_GATE_FAILED', boundedOutputTail(err?.message ?? String(err))),
          details: {
            code: err?.code ?? GATE_FAILED,
            reason: err?.details?.reason ?? null,
            unitId: declaration.unitId,
          },
        });
        await failBlocked(err instanceof ReleaseError ? err : new ReleaseError(
          GATE_FAILED,
          `tag identity cannot be verified: ${err?.message ?? err}`,
        ));
      }
      // Cross-section consistency: the declaration and the create-tag
      // external action must agree on the frozen tag identity.
      if (tagAuthority.tag !== declaration.tag || tagAuthority.commit !== declaration.tagCommit) {
        await failBlocked(new ReleaseError(
          GATE_FAILED,
          'frozen postPublish tag identity conflicts with the frozen create-tag binding',
          {
            postPublishTag: declaration.tag,
            postPublishTagCommit: declaration.tagCommit,
            bindingTag: tagAuthority.tag,
            bindingCommit: tagAuthority.commit,
            unitId: declaration.unitId,
          },
        ));
      }
      if (tagAuthority.localTagDrifted) {
        // R-01: the local tag is a diagnostic only — never a failure.
        await evidence.append({
          phase: 'safety-gate',
          gate: 'tag-identity',
          status: 'warning',
          detail: 'local tag drifted from the frozen commit; public remote stays authoritative',
          localTagCommit: tagAuthority.localTagCommit,
          frozenTagCommit: tagAuthority.commit,
          unitId: declaration.unitId,
        });
      }

      await evidence.append({
        phase: 'safety-gate',
        gate: 'tag-identity',
        status: 'passed',
        tagCommit: tagAuthority.commit,
        observedRemoteTag: tagAuthority.observedRemoteTag,
        localTagPresent: tagAuthority.localTagPresent,
        unitId: declaration.unitId,
      });

      // ===================================================================
      // Gate 5 (optional): the public main line must have moved ahead of the
      // tag (observed from the public remote, not the live workspace).
      // ===================================================================
      if (declaration.assertMainVersionAhead === true) {
        await evidence.append({
          phase: 'safety-gate',
          gate: 'main-version-ahead',
          status: 'started',
          unitId: declaration.unitId,
        });
        try {
          await assertMainLineAhead({
            tagCommit: tagAuthority.commit,
            branchCommit: tagAuthority.branchCommit,
            branch: tagAuthority.branch,
            gitDir: tagAuthority.gitDir,
            remoteUrl: tagAuthority.remoteUrl,
            exec,
          });
        } catch (err) {
          await evidence.append({
            phase: 'safety-gate',
            gate: 'main-version-ahead',
            status: 'failed',
            error: asError('MAIN_VERSION_AHEAD_FAILED', boundedOutputTail(err?.message ?? String(err))),
          });
          await failBlocked(err instanceof ReleaseError ? err : new ReleaseError(
            GATE_FAILED,
            `assertMainVersionAhead failed: ${err?.message ?? err}`,
          ));
        }
        // failBlocked always throws, so this line runs only when the check passed.
        await evidence.append({
          phase: 'safety-gate',
          gate: 'main-version-ahead',
          status: 'passed',
          branch: tagAuthority.branch,
          branchCommit: tagAuthority.branchCommit,
          unitId: declaration.unitId,
        });
      }

      prep.tagAuthority = tagAuthority;
    }

    // =======================================================================
    // Gate 6: adapter availability (once, saga-level) + per-target reachability
    // preflight (read-only) for EVERY declaration before any write.
    // =======================================================================
    let probeAdapter;
    let mirrorAdapter;
    try {
      probeAdapter = adapterRegistry.getAdapter(ActionType.DISTRIBUTE_PROBE);
      mirrorAdapter = adapterRegistry.getAdapter(ActionType.DISTRIBUTE_MIRROR);
    } catch (err) {
      await failBlocked(new ReleaseError(
        GATE_FAILED,
        `no distribute adapter registered: ${err.message}`,
      ));
    }

    for (const prep of prepared) {
      const { declaration, orderedTargets } = prep;
      const probeObservations = new Map();
      for (const target of orderedTargets) {
        const probeCheckpoint = checkpointById.get(unitActionId(declaration.unitId, `probe-${target.id}`));
        probeCheckpoint.startedAt = clockFn();
        await evidence.append({
          phase: 'safety-gate',
          gate: `probe-${target.id}`,
          status: 'started',
          remoteUrl: target.remoteUrl,
          unitId: declaration.unitId,
        });
        const probeAction = {
          actionType: ActionType.DISTRIBUTE_PROBE,
          targetId: target.id,
          remoteUrl: target.remoteUrl,
          tag: declaration.tag,
        };
        let probeResult;
        try {
          probeResult = await probeAdapter.preflight(probeAction, {
            externalWritesAuthorized: false,
            plan,
            root,
            runDir,
          });
        } catch (err) {
          probeResult = { status: 'PREFLIGHT_FAILED', error: err?.message ?? String(err), details: null };
        }
        probeCheckpoint.finishedAt = clockFn();
        if (probeResult.status !== 'PREFLIGHT_PASSED') {
          const code = [REMOTE_UNAVAILABLE, REMOTE_CONFLICT].includes(probeResult.details?.code)
            ? probeResult.details.code
            : GATE_FAILED;
          probeCheckpoint.status = 'FAILED';
          probeCheckpoint.error = { code, message: probeResult.error ?? 'distribute probe failed' };
          await evidence.append({
            phase: 'safety-gate',
            gate: `probe-${target.id}`,
            status: 'failed',
            error: asError('PROBE_FAILED', probeResult.error),
            details: { code },
          });
          await recordFailure();
          throw new ReleaseError(
            code,
            `distribute probe failed for target "${target.id}": ${probeResult.error ?? 'remote unreachable'}`,
            { targetId: target.id, remoteUrl: target.remoteUrl },
          );
        }
        probeCheckpoint.status = 'SUCCEEDED';
        probeObservations.set(target.id, probeResult.observation ?? {});
        await evidence.append({
          phase: 'safety-gate',
          gate: `probe-${target.id}`,
          status: 'passed',
          tagExists: probeResult.observation?.tagExists ?? false,
          unitId: declaration.unitId,
        });
      }
      prep.probeObservations = probeObservations;
    }

    // =======================================================================
    // R-01 (rework): preset deterministic-conflict preflight — the narrow
    // READ-ONLY entry (core/preset-executor.mjs preflightPresetHook) calls the
    // SAME observation implementation the execution-phase delivery uses, for
    // every preset hook that will actually execute this run. A deterministic
    // conflict (e.g. the proposal path already exists with different bytes)
    // fails the whole saga here, BEFORE the first external write. This is not
    // a lock: the execution phase re-observes every remote regardless. Hooks
    // parked at AWAITING_APPROVAL are not observed here — the approved
    // reconcile rerun observes them at execution time.
    // =======================================================================
    for (const prep of prepared) {
      for (const hook of prep.distributeHooks) {
        if (effectiveHookRequiresApproval(hook) && !approvedHookIds.has(hook.id)) continue;
        // Lineage-stable proposal identity: the SAME deterministic projection
        // the execution phase serializes (never the per-attempt runId).
        const proposalProjection = buildPostPublishContext({
          plan,
          postPublish: prep.declaration,
          runId: `distribute-${sourceRunId}`,
          sourceRun,
          payloadDir: undefined,
          phase: 'distribute',
        });
        const observation = await preflightPresetHook({
          hook,
          contextProjection: proposalProjection,
          exec,
        });
        if (observation !== null) {
          await evidence.append({
            phase: 'safety-gate',
            gate: 'preset-preflight',
            status: 'passed',
            hookId: hook.id,
            unitId: prep.declaration.unitId,
            verdict: observation.verdict,
          });
        }
      }
    }

    // =======================================================================
    // Phase B — serial execution in frozen declaration order. Each declaration
    // gets its own detached tag worktree, execution-bundle install, payload
    // staging, steps, target writes and distribute-phase hooks. The saga keeps
    // ONE run chain: a failure stops all later checkpoints (targets and hooks
    // of later declarations), and the first external success followed by a
    // failure enters PARTIAL (success checkpoints are retained — never rolled
    // back). Legacy plans iterate exactly one declaration (normalize view)
    // with byte-identical behavior.
    // =======================================================================

    // F-04 root split: the saga holds TWO distinct roots from here on —
    // - releaseWorkspaceRoot: the real project root the user releases from;
    //   only used to resolve preset target.workspace, compare the release-
    //   workspace write exclusion, and audit;
    // - executionWorktreeRoot (worktreePath): the detached worktree at the
    //   frozen tagCommit; only used as the hook runner context.root for
    //   materialize, steps and custom command hooks.
    // The two roots never fall back onto each other through defaults.
    let releaseWorkspaceRoot;
    try {
      releaseWorkspaceRoot = await realpath(root);
    } catch (err) {
      await failBlocked(new ReleaseError(
        GATE_FAILED,
        `release workspace root does not resolve to an existing directory: ${err.message}`,
        { root, cause: err.code },
      ));
    }

    const adapterContext = {
      externalWritesAuthorized: true, // dry-run side effects are adapter-guaranteed zero
      plan,
      root,
      runDir,
    };

    // Rework R-03: a stop propagates to the SAGA level — when a previous
    // declaration's distribute-phase preset or custom hook failed (timeout,
    // non-zero exit, execution failure), the remaining declaration's
    // materialize, steps, targets, presets and custom hooks must NOT execute;
    // its planned checkpoints are recorded SKIPPED.
    const skipReason = () => (stopReason === 'HOOK' ? 'EARLIER_HOOK_FAILED' : 'EARLIER_TARGET_FAILED');

    for (const prep of prepared) {
      const {
        declaration,
        orderedTargets,
        distributeHooks,
        deferredPostVerifyHooks,
        probeObservations,
        tagAuthority,
      } = prep;

      if (stopped) {
        for (const target of orderedTargets) {
          const cp = checkpointById.get(unitActionId(declaration.unitId, target.id));
          cp.status = 'SKIPPED';
          cp.reason = skipReason();
          cp.finishedAt = clockFn();
        }
        for (const hook of distributeHooks) {
          const cp = checkpointById.get(unitActionId(declaration.unitId, hook.id));
          cp.status = 'SKIPPED';
          cp.reason = skipReason();
          cp.finishedAt = clockFn();
        }
        await evidence.append({
          phase: 'postpublish-declaration',
          status: 'skipped',
          reason: skipReason(),
          unitId: declaration.unitId,
        });
        continue;
      }

      // R1 timing contract: detached worktree at the frozen tagCommit. The
      // payload may never come from the live workspace. R-01: the worktree is
      // materialized from a COPY of the frozen bare repo (never registered in
      // the source repo's worktree metadata, never touching its refs).
      await evidence.append({
        phase: 'worktree',
        status: 'started',
        tagCommit: tagAuthority.commit,
        unitId: declaration.unitId,
      });
      try {
        tmpBase = await mkdtemp(join(tmpdir(), 'release-skill-distribute-'));
        ({ worktreePath } = await createFrozenTagWorktree({
          gitDir: tagAuthority.gitDir,
          commit: tagAuthority.commit,
          tmpBase,
          exec,
        }));
      } catch (err) {
        await evidence.append({ phase: 'worktree', status: 'failed', error: asError('WORKTREE_FAILED', boundedOutputTail(err?.stderr ?? err?.message)) });
        await failBlocked(new ReleaseError(
          GATE_FAILED,
          `cannot create the detached tag worktree at ${tagAuthority.commit}: ${err?.message ?? err}`,
          { tagCommit: tagAuthority.commit },
        ));
      }
      await evidence.append({ phase: 'worktree', status: 'passed' });

      // =====================================================================
      // Private execution bundle (F-01 / T1): consumer-declared commands may
      // reference scripts that exist only in the parent workspace (tooling
      // never leaks into the frozen public surface). prepare froze those bytes
      // digest-addressed under the plan's .release-skill; re-verify them
      // through Foundation and install ONLY the verified bytes into the tag
      // worktree before any hook runs. Any mismatch fails closed here —
      // before any hook and before any external write.
      // =====================================================================
      let installedBundlePaths = [];
      try {
        ({ installed: installedBundlePaths } = await verifyAndInstallExecutionBundle({
          planPath,
          worktreePath,
          postPublish: declaration,
        }));
      } catch (err) {
        await evidence.append({
          phase: 'worktree',
          gate: 'execution-bundle',
          status: 'failed',
          error: asError('EXECUTION_BUNDLE_FAILED', boundedOutputTail(err?.message ?? String(err))),
        });
        await failBlocked(err instanceof ReleaseError ? err : new ReleaseError(
          GATE_FAILED,
          `cannot verify the frozen execution bundle: ${err?.message ?? err}`,
        ));
      }
      await evidence.append({
        phase: 'worktree',
        gate: 'execution-bundle',
        status: 'passed',
        installed: installedBundlePaths,
      });

    // =======================================================================
    // Payload staging (fail-closed). The frozen plan selects exactly one
    // route (schema anyOf + runtime re-check):
    // - consumer materialize hook: run it inside the tag worktree, verify
    //   its report, and bind the announced payload directory;
    // - Foundation managed projection (F-06 / T6): when the plan declares
    //   no materialize hook, the frozen executionBundle.publicFiles mapping
    //   is staged from the tag worktree into a fresh hub-payload root by
    //   the Engineering Kit compileProjectionPlan/runProjection contract.
    //   The saga supplies ONLY the release-domain parameters (what is
    //   projected, where the frozen bytes live, where the payload lands);
    //   every preflight, containment check, transactional write, and
    //   rollback belongs to Foundation and is never reimplemented here.
    // =======================================================================
    let payloadReal;
    const materialize = declaration.materialize;

    if (materialize !== undefined) {
      await evidence.append({ phase: 'materialize', status: 'started' });

      const hookResult = await hookRunner(
        {
          command: materialize.command,
          ...(materialize.cwd ? { cwd: materialize.cwd } : {}),
          ...(materialize.timeoutMs !== undefined ? { timeoutMs: materialize.timeoutMs } : {}),
          ...(materialize.envAllowlist ? { envAllowlist: materialize.envAllowlist } : {}),
        },
        {
          // F-04: materialize runs in the execution worktree, never in the
          // release workspace. Private workspace-side inputs reach the hook
          // exclusively through the frozen execution bundle installed above —
          // no live workspace root is announced anymore (F-01 / T1).
          root: worktreePath,
          env: process.env,
        },
      );

      if (hookResult.exitCode !== 0) {
        await evidence.append({
          phase: 'materialize',
          status: 'failed',
          exitCode: hookResult.exitCode,
          stdoutTail: boundedOutputTail(hookResult.stdout),
          stderrTail: boundedOutputTail(hookResult.stderr),
        });
        await failBlocked(new ReleaseError(
          POST_PUBLISH_VERIFY_FAILED,
          `materialize hook exited with code ${hookResult.exitCode}; payload cannot be trusted`,
          { exitCode: hookResult.exitCode, stdoutTail: boundedOutputTail(hookResult.stdout), stderrTail: boundedOutputTail(hookResult.stderr) },
        ));
      }

      // requireReport: stdout-first-json deep compare (declared equals subset).
      if (materialize.requireReport) {
        const report = parseFirstJsonObject(hookResult.stdout);
        if (!report) {
          await evidence.append({
            phase: 'materialize',
            status: 'failed',
            reason: 'report-missing',
            stdoutTail: boundedOutputTail(hookResult.stdout),
          });
          await failBlocked(new ReleaseError(
            POST_PUBLISH_VERIFY_FAILED,
            'materialize report missing: no JSON object found on stdout (requireReport.parse = stdout-first-json)',
            { stdoutTail: boundedOutputTail(hookResult.stdout) },
          ));
        }
        const equals = materialize.requireReport.equals ?? {};
        for (const [key, expectedValue] of Object.entries(equals)) {
          if (JSON.stringify(report[key]) !== JSON.stringify(expectedValue)) {
            await evidence.append({
              phase: 'materialize',
              status: 'failed',
              reason: 'report-mismatch',
              mismatchedKeys: Object.keys(equals).filter(
                (k) => JSON.stringify(report[k]) !== JSON.stringify(equals[k]),
              ),
            });
            await failBlocked(new ReleaseError(
              POST_PUBLISH_VERIFY_FAILED,
              `materialize report mismatch: "${key}" did not meet the frozen requireReport contract`,
              { mismatchedKey: key },
            ));
          }
        }
      }

      // outputMarker: the LAST line containing the marker announces the payload.
      const announced = parseOutputMarker(hookResult.stdout, materialize.outputMarker);
      if (!announced) {
        await evidence.append({
          phase: 'materialize',
          status: 'failed',
          reason: 'marker-missing',
          stdoutTail: boundedOutputTail(hookResult.stdout),
        });
        await failBlocked(new ReleaseError(
          POST_PUBLISH_VERIFY_FAILED,
          `materialize output marker "${materialize.outputMarker}" not found on stdout; payload directory unbound`,
          { stdoutTail: boundedOutputTail(hookResult.stdout) },
        ));
      }
      payloadReal = await assertContainedDirectory(
        worktreePath,
        resolve(worktreePath, announced),
        'materialized payload directory',
      );
      await evidence.append({ phase: 'materialize', status: 'passed', payloadDirAnnounced: announced });
    } else {
      await evidence.append({ phase: 'materialize', status: 'started', mechanism: PROJECTION_MECHANISM });

      // Release-domain parameter selection ONLY: the frozen mapping rides the
      // plan digest; live project configuration is never read here.
      const publicFiles = declaration.executionBundle?.publicFiles;
      if (!Array.isArray(publicFiles) || publicFiles.length === 0) {
        await evidence.append({
          phase: 'materialize',
          status: 'failed',
          mechanism: PROJECTION_MECHANISM,
          reason: 'public-files-missing',
        });
        await failBlocked(new ReleaseError(
          POST_PUBLISH_VERIFY_FAILED,
          'public payload projection: the frozen plan declares no materialize hook and carries no non-empty executionBundle.publicFiles mapping; the payload cannot be staged',
        ));
      }

      // Disposable candidate staging root, external to the payload root and
      // owned by the saga (cleaned up with tmpBase).
      const candidateRoot = join(tmpBase, 'projection-candidate');
      try {
        await mkdir(candidateRoot, { recursive: true });
        const projected = await projectPublicPayload({
          executionWorktreeRoot: worktreePath,
          candidateRoot,
          publicFiles,
        });
        payloadReal = projected.payloadRoot;
      } catch (err) {
        await evidence.append({
          phase: 'materialize',
          status: 'failed',
          mechanism: PROJECTION_MECHANISM,
          error: asError('MATERIALIZE_FAILED', boundedOutputTail(err?.message ?? String(err))),
        });
        await failBlocked(err instanceof ReleaseError ? err : new ReleaseError(
          POST_PUBLISH_VERIFY_FAILED,
          `public payload projection failed: ${err?.message ?? err}`,
        ));
      }
      await evidence.append({
        phase: 'materialize',
        status: 'passed',
        mechanism: PROJECTION_MECHANISM,
        payloadDir: PUBLIC_PAYLOAD_DIRNAME,
        fileCount: publicFiles.length,
      });
    }

    // =======================================================================
    // Declared postPublish steps, in order (fail-closed).
    // =======================================================================
    for (const step of declaration.steps ?? []) {
      if (dryRun === true) {
        // R1 dry-run contract: steps are arbitrary project code with
        // potentially remote side effects; they never execute in a rehearsal.
        await evidence.append({ phase: 'postpublish-step', step: step.name, status: 'skipped', reason: 'DRY_RUN' });
        continue;
      }
      if (pendingHookApprovals.length > 0) {
        // A requiresApproval hook is still unapproved: the step pipeline must
        // not execute before the checkpoint approval exists; the approved
        // reconcile rerun re-executes the steps (idempotence-by-default).
        await evidence.append({
          phase: 'postpublish-step',
          step: step.name,
          status: 'skipped',
          reason: 'AWAITING_CHECKPOINT_APPROVAL',
          pendingHookApprovals: pendingHookApprovals.map((hook) => hook.id),
        });
        continue;
      }
      await evidence.append({ phase: 'postpublish-step', step: step.name, status: 'started' });
      const stepResult = await hookRunner(
        {
          command: step.command,
          ...(step.cwd ? { cwd: step.cwd } : {}),
          ...(step.timeoutMs !== undefined ? { timeoutMs: step.timeoutMs } : {}),
          ...(step.envAllowlist ? { envAllowlist: step.envAllowlist } : {}),
        },
        {
          // F-04: steps run in the execution worktree (see materialize).
          // Private inputs arrive via the frozen execution bundle only.
          root: worktreePath,
          env: process.env,
        },
      );
      if (stepResult.exitCode !== 0) {
        await evidence.append({
          phase: 'postpublish-step',
          step: step.name,
          status: 'failed',
          exitCode: stepResult.exitCode,
          stdoutTail: boundedOutputTail(stepResult.stdout),
          stderrTail: boundedOutputTail(stepResult.stderr),
        });
        await failBlocked(new ReleaseError(
          GATE_FAILED,
          `postPublish step "${step.name}" exited with code ${stepResult.exitCode}`,
          { step: step.name, exitCode: stepResult.exitCode },
        ));
      }
      await evidence.append({ phase: 'postpublish-step', step: step.name, status: 'passed' });
    }

    // =======================================================================
    // Target distribution (per declaration): sequential, dependency-ordered,
    // observe-before-write (reconcile equivalence — never force).
    // =======================================================================
    await evidence.append({
      phase: 'distribute',
      status: 'started',
      unitId: declaration.unitId,
      targetCount: orderedTargets.length,
      dryRun: dryRun === true,
    });

    const mirrorResults = new Map(); // targetId -> { sha } for dependents (declaration-local)

    for (const target of orderedTargets) {
      const cp = checkpointById.get(unitActionId(declaration.unitId, target.id));
      cp.startedAt = clockFn();

      if (stopped) {
        cp.status = 'SKIPPED';
        cp.reason = 'EARLIER_TARGET_FAILED';
        cp.finishedAt = clockFn();
        await evidence.append({ phase: 'checkpoint', actionId: unitActionId(declaration.unitId, target.id), status: 'skipped', reason: 'EARLIER_TARGET_FAILED' });
        continue;
      }

      // --- Pre-observe: a remote already at the frozen tag is SKIPPED. ---
      await evidence.append({ phase: 'checkpoint', actionId: unitActionId(declaration.unitId, target.id), status: 'pre-observe' });
      let preObserved = {};
      try {
        const observeResult = await mirrorAdapter.observe(
          {
            actionType: ActionType.DISTRIBUTE_MIRROR,
            targetId: target.id,
            remoteUrl: target.remoteUrl,
            branch: target.branch,
            tag: declaration.tag,
          },
          adapterContext,
        );
        preObserved = observeResult?.observation ?? {};
      } catch (err) {
        preObserved = {};
        await evidence.append({
          phase: 'checkpoint',
          actionId: unitActionId(declaration.unitId, target.id),
          status: 'pre-observe-unobservable',
          error: asError('PRE_OBSERVE_FAILED', err?.message ?? String(err)),
        });
      }
      if (preObserved.tagOid && preObserved.branchTip === preObserved.tagOid) {
        cp.status = 'SKIPPED';
        cp.preObserve = 'CONSISTENT';
        cp.finishedAt = clockFn();
        mirrorResults.set(target.id, { sha: preObserved.tagOid });
        await evidence.append({
          phase: 'checkpoint',
          actionId: unitActionId(declaration.unitId, target.id),
          status: 'skipped',
          details: { preObserve: 'CONSISTENT', sha: preObserved.tagOid },
        });
        continue;
      }

      // --- UNCERTAIN-before-write snapshot (durable pre-execute authority). ---
      cp.status = 'UNCERTAIN';
      await snapshot(DISTRIBUTING);

      // --- Build the mirror action. ---
      const action = {
        actionType: ActionType.DISTRIBUTE_MIRROR,
        targetId: target.id,
        kind: target.kind,
        remoteUrl: target.remoteUrl,
        branch: target.branch,
        tag: declaration.tag,
        commitIdentity: declaration.commitIdentity,
        dryRun: dryRun === true,
      };
      if (target.kind === 'payload-mirror') {
        action.payloadDir = payloadReal;
      } else {
        action.marketplace = target.marketplace;
        action.pluginName = resolvePluginName(plan, declaration.unitId);
        const dependencyTarget = orderedTargets.find((entry) => entry.id === target.dependsOn);
        action.dependency = {
          remoteUrl: dependencyTarget.remoteUrl,
          sha: mirrorResults.get(target.dependsOn)?.sha ?? null,
        };
      }
      action.staticFiles = (target.staticFiles ?? []).map((file) => {
        const sourcePath = resolve(payloadReal, file.from);
        const rel = relative(payloadReal, sourcePath);
        if (rel === '' || isAbsolute(rel) || rel === '..'
          || rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)) {
          throw new ReleaseError(
            GATE_FAILED,
            `target "${target.id}" staticFiles entry escapes the payload directory`,
            { targetId: target.id, from: file.from },
          );
        }
        return { sourcePath, to: file.to };
      });

      // --- Execute (the adapter never throws; it returns EXECUTE_FAILED). ---
      await evidence.append({ phase: 'checkpoint', actionId: unitActionId(declaration.unitId, target.id), status: 'started' });
      let executeResult;
      try {
        executeResult = await mirrorAdapter.execute(action, adapterContext);
      } catch (err) {
        executeResult = {
          status: 'EXECUTE_FAILED',
          error: err?.message ?? String(err),
          details: { code: err?.code ?? GATE_FAILED },
        };
      }

      const observation = executeResult.observation ?? {};

      if (executeResult.status === 'EXECUTE_FAILED') {
        const code = mapToSchemaCode(executeResult.details?.code);
        cp.status = 'FAILED';
        cp.error = { code, message: executeResult.error ?? 'mirror execute failed' };
        cp.finishedAt = clockFn();
        failures += 1;
        stopped = true;
        stopReason = 'TARGET';
        await evidence.append({
          phase: 'checkpoint',
          actionId: unitActionId(declaration.unitId, target.id),
          status: 'failed',
          error: asError('EXECUTE_FAILED', executeResult.error),
          details: { code },
        });
        await snapshot(PARTIAL);
        continue;
      }

      if (executeResult.status === 'NO_CHANGE') {
        cp.status = 'NO_CHANGE';
        cp.mode = 'no-change';
        cp.previousHead = observation.previousHead ?? null;
        cp.payloadFileCount = observation.payloadFileCount;
        cp.finishedAt = clockFn();
        const sha = probeObservations.get(target.id)?.tagOid
          ?? observation.branchTip
          ?? observation.previousHead
          ?? null;
        mirrorResults.set(target.id, { sha });
        await evidence.append({ phase: 'checkpoint', actionId: unitActionId(declaration.unitId, target.id), status: 'no-change' });
        await snapshot(PARTIAL);
        continue;
      }

      // EXECUTED: pushed or dry-run.
      cp.mode = observation.mode;
      cp.previousHead = observation.previousHead ?? undefined;
      cp.payloadFileCount = observation.payloadFileCount;
      const pushed = observation.mode === 'pushed';
      if (pushed) {
        pushedWrites += 1;
        cp.pushedCommit = observation.pushedCommit;
        mirrorResults.set(target.id, { sha: observation.pushedCommit });
      } else {
        // Dry-run: no push result exists; dependents render without a sha.
        mirrorResults.set(target.id, { sha: null });
      }

      // --- Post-execute verify (observe cross-check; pushed only). ---
      let verifyResult;
      try {
        verifyResult = await mirrorAdapter.verify(
          {
            actionType: ActionType.DISTRIBUTE_MIRROR,
            targetId: target.id,
            remoteUrl: target.remoteUrl,
            branch: target.branch,
            tag: declaration.tag,
            ...(pushed ? { pushedCommit: observation.pushedCommit } : {}),
          },
          adapterContext,
        );
      } catch (err) {
        verifyResult = { status: 'VERIFY_FAILED', error: err?.message ?? String(err) };
      }

      if (verifyResult.status !== 'VERIFIED') {
        cp.status = 'FAILED';
        cp.postObserve = 'CONFLICTING';
        cp.error = {
          code: POST_PUBLISH_VERIFY_FAILED,
          message: verifyResult.error ?? 'post-execute verification failed',
        };
        cp.finishedAt = clockFn();
        failures += 1;
        stopped = true;
        stopReason = 'TARGET';
        await evidence.append({
          phase: 'checkpoint',
          actionId: unitActionId(declaration.unitId, target.id),
          status: 'verify-failed',
          error: asError('POST_PUBLISH_VERIFY_FAILED', verifyResult.error ?? null),
        });
        await snapshot(PARTIAL);
        continue;
      }

      cp.status = 'SUCCEEDED';
      cp.postObserve = pushed ? 'CONSISTENT' : cp.postObserve;
      cp.finishedAt = clockFn();
      await evidence.append({
        phase: 'checkpoint',
        actionId: unitActionId(declaration.unitId, target.id),
        status: 'completed',
        mode: observation.mode,
        pushedCommit: pushed ? observation.pushedCommit : null,
      });
      await snapshot(PARTIAL);
    }

    // =======================================================================
    // postPublish hooks (distribute phase), executed AFTER the target writes.
    // Contract (design §2.3): the read-only frozen-plan projection travels via
    // RELEASE_SKILL_POSTPUBLISH_CONTEXT; hooks run inside the frozen tag
    // worktree; a failure stops the hook chain; a requiresApproval hook
    // without a checkpoint approval parks at AWAITING_APPROVAL and never
    // executes; dry-run executes nothing; postVerify-phase hooks belong to
    // the independent postVerify run (R3) and are evidenced as deferred.
    // =======================================================================
    if (deferredPostVerifyHooks > 0) {
      await evidence.append({
        phase: 'postpublish-hooks',
        status: 'deferred',
        deferredPostVerifyHooks,
        unitId: declaration.unitId,
      });
    }

    // Per-declaration hook chain: a failure inside this declaration stops the
    // SAGA (rework R-03) — the remaining hooks of this declaration and every
    // later declaration's materialize, steps, targets, presets and custom
    // hooks are SKIPPED. `stopped`/`stopReason` are the single saga-level
    // chain state.
    const hookContextProjection = buildPostPublishContext({
      plan,
      postPublish: declaration,
      runId,
      sourceRun,
      payloadDir: payloadReal,
      phase: 'distribute',
    });

    // Proposal documents must stay byte-deterministic across redeliveries of
    // the SAME release event (NO_CHANGE idempotence on reconcile reruns):
    // they travel with the stable lineage-derived event identity, not the
    // per-attempt runId.
    const proposalContextProjection = {
      ...hookContextProjection,
      runId: `distribute-${sourceRunId}`,
    };

    for (const hook of distributeHooks) {
      const cp = checkpointById.get(unitActionId(declaration.unitId, hook.id));
      cp.startedAt = clockFn();

      if (stopped) {
        cp.status = 'SKIPPED';
        cp.reason = skipReason();
        cp.finishedAt = clockFn();
        await evidence.append({
          phase: 'postpublish-hook',
          hookId: hook.id,
          status: 'skipped',
          reason: skipReason(),
        });
        continue;
      }

      if (dryRun === true) {
        cp.status = 'SKIPPED';
        cp.reason = 'DRY_RUN';
        cp.finishedAt = clockFn();
        await evidence.append({ phase: 'postpublish-hook', hookId: hook.id, status: 'skipped', reason: 'DRY_RUN' });
        continue;
      }

      if (effectiveHookRequiresApproval(hook) && !approvedHookIds.has(hook.id)) {
        // No checkpoint approval: the hook must not execute. It parks (does
        // not stop the chain — later reconcile reruns retry it once approved).
        cp.status = 'AWAITING_APPROVAL';
        cp.finishedAt = clockFn();
        awaitingApproval += 1;
        await evidence.append({ phase: 'postpublish-hook', hookId: hook.id, status: 'awaiting-approval' });
        continue;
      }

      // -----------------------------------------------------------------
      // Preset hooks dispatch through the R4 preset executor (one seam for
      // every registered preset; fail-closed wording for presets registered
      // but not yet shipped).
      // -----------------------------------------------------------------
      if (hook.preset !== undefined) {
        await evidence.append({ phase: 'postpublish-hook', hookId: hook.id, status: 'started' });
        let delivery;
        try {
          delivery = await executePresetHook({
            hook,
            contextProjection: hookContextProjection,
            proposalContextProjection,
            commitIdentity: declaration.commitIdentity,
            // F-04: presets receive the RELEASE workspace root (target.workspace
            // resolution + release-workspace write exclusion). The detached
            // worktree is the execution worktree and never impersonates it.
            releaseWorkspaceRoot,
            evidencePath: join(runDir, 'evidence.jsonl'),
            payloadDir: hookContextProjection.payloadDir,
            exec,
            hookRunner,
          });
        } catch (err) {
          const code = mapToSchemaCode(err?.code);
          cp.status = 'FAILED';
          cp.error = { code, message: err?.message ?? String(err) };
          cp.finishedAt = clockFn();
          failures += 1;
          stopped = true;
          stopReason = 'HOOK';
          await evidence.append({
            phase: 'postpublish-hook',
            hookId: hook.id,
            status: 'failed',
            error: asError('POSTPUBLISH_HOOK_FAILED', err?.message ?? String(err)),
            details: { code },
          });
          await snapshot(PARTIAL);
          continue;
        }

        if (delivery.status === 'NO_CHANGE') {
          cp.status = 'NO_CHANGE';
          cp.mode = 'no-change';
          cp.finishedAt = clockFn();
          hookSuccesses += 1;
          await evidence.append({
            phase: 'postpublish-hook',
            hookId: hook.id,
            status: 'no-change',
            ...(delivery.manualSyncPrompt ? { manualSyncPrompt: delivery.manualSyncPrompt } : {}),
            // §2.6 execution realpath evidence (R4 review m-2).
            ...(delivery.observation?.workspaceRealpath
              ? { workspaceRealpath: delivery.observation.workspaceRealpath }
              : {}),
            ...(delivery.workspaceRealpath ? { workspaceRealpath: delivery.workspaceRealpath } : {}),
          });
          await snapshot(PARTIAL);
          continue;
        }

        cp.status = 'SUCCEEDED';
        if (delivery.observation?.mode === 'pushed' && delivery.observation?.pushedCommit) {
          cp.mode = 'pushed';
          cp.pushedCommit = delivery.observation.pushedCommit;
        }
        cp.finishedAt = clockFn();
        hookSuccesses += 1;
        await evidence.append({
          phase: 'postpublish-hook',
          hookId: hook.id,
          status: 'succeeded',
          preset: hook.preset,
          mode: delivery.mode ?? delivery.observation?.mode,
          ...(delivery.observation?.pushedCommit ? { pushedCommit: delivery.observation.pushedCommit } : {}),
          ...(delivery.manualSyncPrompt ? { manualSyncPrompt: delivery.manualSyncPrompt } : {}),
          ...(delivery.checklist ? { checklist: delivery.checklist } : {}),
          ...(delivery.degradedToNotifyHandoff === true ? { degradedToNotifyHandoff: true } : {}),
          ...(Array.isArray(delivery.observations) ? { targets: delivery.observations } : {}),
          // §2.6 execution realpath evidence (R4 review m-2) + explicit
          // cross-check skip note (R4 review m-4).
          ...(delivery.observation?.workspaceRealpath
            ? { workspaceRealpath: delivery.observation.workspaceRealpath }
            : {}),
          ...(delivery.workspaceRealpath ? { workspaceRealpath: delivery.workspaceRealpath } : {}),
          ...(delivery.observation?.crossCheck ? { crossCheck: delivery.observation.crossCheck } : {}),
        });
        await snapshot(PARTIAL);
        continue;
      }

      if (!Array.isArray(hook.command)) {
        // Fail-closed: a hook with no executable command stops the chain.
        cp.status = 'FAILED';
        cp.error = {
          code: POST_PUBLISH_VERIFY_FAILED,
          message: `hook "${hook.id}" has no executable command`,
        };
        cp.finishedAt = clockFn();
        failures += 1;
        stopped = true;
        stopReason = 'HOOK';
        await evidence.append({
          phase: 'postpublish-hook',
          hookId: hook.id,
          status: 'failed',
          reason: 'no-command',
        });
        await snapshot(PARTIAL);
        continue;
      }

      await evidence.append({ phase: 'postpublish-hook', hookId: hook.id, status: 'started' });
      let hookExecution;
      try {
        hookExecution = await hookRunner(
          {
            id: hook.id,
            command: hook.command,
            ...(hook.cwd ? { cwd: hook.cwd } : {}),
            ...(hook.timeoutMs !== undefined ? { timeoutMs: hook.timeoutMs } : {}),
            ...(hook.envAllowlist ? { envAllowlist: hook.envAllowlist } : {}),
          },
          {
            // F-04: custom command hooks keep running in the execution
            // worktree; the runner's cwd containment binds them there.
            root: worktreePath,
            env: process.env,
            injectEnv: {
              [POSTPUBLISH_CONTEXT_ENV]: JSON.stringify(hookContextProjection),
            },
          },
        );
      } catch (err) {
        // HOOK_TIMEOUT (or a runner defect): FAILED checkpoint, stop the chain.
        const code = err?.code === 'HOOK_TIMEOUT' ? 'HOOK_TIMEOUT' : POST_PUBLISH_VERIFY_FAILED;
        cp.status = 'FAILED';
        cp.error = { code, message: err?.message ?? String(err) };
        cp.finishedAt = clockFn();
        failures += 1;
        stopped = true;
        stopReason = 'HOOK';
        await evidence.append({
          phase: 'postpublish-hook',
          hookId: hook.id,
          status: 'failed',
          error: asError('POSTPUBLISH_HOOK_FAILED', err?.message ?? String(err)),
        });
        await snapshot(PARTIAL);
        continue;
      }

      if (hookExecution.exitCode !== 0) {
        cp.status = 'FAILED';
        cp.error = {
          code: POST_PUBLISH_VERIFY_FAILED,
          message: `postPublish hook "${hook.id}" exited with code ${hookExecution.exitCode}`,
        };
        cp.finishedAt = clockFn();
        failures += 1;
        stopped = true;
        stopReason = 'HOOK';
        await evidence.append({
          phase: 'postpublish-hook',
          hookId: hook.id,
          status: 'failed',
          exitCode: hookExecution.exitCode,
          stdoutTail: boundedOutputTail(hookExecution.stdout),
          stderrTail: boundedOutputTail(hookExecution.stderr),
        });
        await snapshot(PARTIAL);
        continue;
      }

      cp.status = 'SUCCEEDED';
      cp.finishedAt = clockFn();
      hookSuccesses += 1;
      await evidence.append({ phase: 'postpublish-hook', hookId: hook.id, status: 'succeeded' });
      await snapshot(PARTIAL);
    }

      // This declaration's scratch worktree is consumed; release it. The
      // outer finally keeps the safety net for a mid-declaration throw.
      await cleanupWorktree();
    }

    // =======================================================================
    // Classification (returned, not thrown):
    // - DISTRIBUTED: no failures and no awaiting-approval hooks;
    // - NEEDS_INPUT: only awaiting-approval checkpoints and zero external
    //   side effects so far (pure input-needed state, never PARTIAL);
    // - PARTIAL: at least one external success (pushed write or succeeded
    //   hook) alongside failures or awaiting-approval checkpoints;
    // - BLOCKED: failures with zero external side effects landed.
    // =======================================================================
    const externalCheckpointSuccesses = pushedWrites + hookSuccesses;
    let overallStatus;
    if (failures === 0 && awaitingApproval === 0) {
      overallStatus = DISTRIBUTED;
    } else if (failures === 0) {
      overallStatus = externalCheckpointSuccesses > 0 ? PARTIAL : NEEDS_INPUT;
    } else {
      overallStatus = externalCheckpointSuccesses > 0 ? PARTIAL : BLOCKED;
    }

    const finishedAt = clockFn();
    await snapshot(overallStatus);
    await writeRunAtomic(runPath, buildPersistedState(overallStatus, finishedAt));
    finalRecordWritten = true;

    const { recoveryActionCode } = await readRunRecovery(runPath, { planPath, clock: clockFn, postpublishApprovalPaths });
    await evidence.append({
      phase: 'distribute',
      status: 'completed',
      overallStatus,
      checkpointStatuses: checkpoints.map((cp) => cp.status),
    });
    await evidence.finish({
      status: overallStatus,
      recoveryActionCode,
      planPath,
      runPath,
      finishedAt: clockFn(),
    });

    return { planPath, runPath, status: overallStatus, checkpoints, recoveryActionCode };
  } catch (err) {
    // The happy path returns before this catch, so `evidence.finish` can never
    // double-run here: it must ALWAYS close the evidence stream and seal the
    // summary, even when failBlocked already persisted the failure record.
    // Rework R-01: the persisted status and the summary reflect the existing
    // success checkpoints — PARTIAL once one external checkpoint succeeded,
    // BLOCKED at zero external side effects.
    const catchStatus = !lineageKnown
      ? 'FAILED'
      : (pushedWrites + hookSuccesses) > 0 ? PARTIAL : BLOCKED;
    try {
      await evidence.append({
        phase: 'distribute',
        status: 'failed',
        error: { code: err.code, message: err.message },
      });
      if (lineageKnown && !finalRecordWritten) await recordFailure();
    } catch {
      // Persistence must never mask the primary failure.
    }
    const { recoveryActionCode } = await readRunRecovery(finalRecordWritten ? runPath : null, {
      planPath, clock: clockFn, command: 'distribute', error: err, postpublishApprovalPaths,
    });
    err.details = { ...err.details, recoveryActionCode };
    await evidence.finish({
      status: catchStatus,
      recoveryActionCode,
      error: { code: err.code, message: err.message, details: err.details },
      details: { recoveryActionCode },
      failedAt: clockFn(),
    }).catch(() => {});
    throw err;
  } finally {
    await cleanupWorktree();
  }
}
