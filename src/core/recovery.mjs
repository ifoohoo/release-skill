/**
 * Table-driven recovery action codes (R-08, WP-4).
 *
 * A failure summary must carry a STABLE machine-readable recovery action
 * code so operators and tooling can react without parsing prose. The code is
 * derived from a small decision table over:
 * - command, errorCode, phase (the failing stage),
 * - checkpoint outcome (whether external steps already succeeded),
 * - evidence availability and producer generation.
 *
 * Fail-closed rules:
 * - no evidence, or a legacy (v1) producer, resolves to "unknown" — the
 *   failure cannot be attributed to a known stage, so no action is suggested;
 * - counts and diagnostic errors alone never establish a recovery stage;
 * - readRunRecovery loads existing run/plan/approval authorities and reuses
 *   their validators to distinguish publication, distribution and verification;
 * - conflicts and unknown authority require human diagnosis;
 * - config errors resolve to FIX_CONFIG, missing auth to FIX_AUTH, hook
 *   failures to FIX_HOOK, lock conflicts to RESOLVE_LOCK;
 * - everything else resolves to RETRY_COMMAND.
 *
 * The persisted summary carries ONLY the code. The CLI renders the concrete
 * argv at display time via `renderRecoveryCommand`; nothing is persisted as
 * an executable command.
 *
 * @module core/recovery
 */

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { loadRun, validateRunLineage, validateRunPlanDigest, validateRunCheckpointMapping } from './run.mjs';
import { validatePlan, computePlanDigest, assertImmutablePlanAuthority } from './plan.mjs';
import { validateApproval, validateApprovalRecordSchema, assertImmutableApprovalAuthority, computeApprovalDigest } from './approval.mjs';
import { isMarketplaceAction } from './checkpoints.mjs';
import { ReleaseError, GATE_FAILED } from './errors.mjs';
import {
  effectiveHookRequiresApproval,
  normalizePostPublishView,
  postPublishActionId,
  requiresPostPublishDistribution,
} from './postpublish.mjs';
import { assertPostPublishApprovalAuthority, validatePostPublishApproval } from './postpublish-approval.mjs';

/** Remote errors alone are insufficient to select a safe recovery phase. */
const REMOTE_DIAGNOSTIC_CODES = new Set([
  'REMOTE_CONFLICT',
  'REMOTE_UNAVAILABLE',
  'REMOTE_TAG_MISSING',
  'REMOTE_TAG_DRIFT',
  'NPM_VERSION_CONFLICT',
  'NPM_VERSION_CHECK_FAILED',
  'GIT_REMOTE_EMPTY',
  'GIT_REMOTE_MISSING',
  'ORIGIN_AHEAD',
  'VERSION_SEQUENCE_GAP',
  'PARTIAL_RELEASE',
  'POST_PUBLISH_VERIFY_FAILED',
]);

/** Error-code families that mean "fix the configuration, then retry". */
const FIX_CONFIG_CODES = new Set([
  'CONFIG_ERROR',
  'CONFIG_INVALID',
  'CONFIG_MISSING',
  'RECOMMENDED_CONFIG_SCHEMA_INVALID',
  'PUBLIC_FILE_BOUNDARY_EMPTY',
  'PUBLIC_FILE_MAPPING_CONFLICT',
  'PUBLIC_REPO_AMBIGUOUS',
  'PUBLIC_REPO_AUTHORITY_CONFLICT',
]);

/** Error-code families that mean "fix the declared hook, then retry". */
const FIX_HOOK_CODES = new Set([
  'HOOK_TIMEOUT',
  'POSTPUBLISH_HOOK_INVALID',
]);

/** Error-code families that mean "restore credentials, then retry". */
const FIX_AUTH_CODES = new Set([
  'AUTH_MISSING',
]);

/**
 * Resolve the stable recovery action code for a failure summary.
 *
 * @param {Object} input
 * @param {string} [input.command] - The command that failed.
 * @param {string} [input.errorCode] - The stable ReleaseError code.
 * @param {string} [input.phase] - The evidence phase of the failure.
 * @param {number} [input.succeededCheckpointCount] - External checkpoints
 *   already succeeded before the failure (0 when unknown).
 * @param {boolean} [input.hasEvidence] - Whether any evidence event was
 *   written before the failure. Defaults to true.
 * @param {number} [input.producerVersion] - Evidence producer generation.
 *   v1 (legacy) runs have no producer identity and resolve to "unknown".
 *   Defaults to 2.
 * @returns {string} One of: unknown, DIAGNOSE, FIX_CONFIG, FIX_AUTH,
 *   FIX_HOOK, RESOLVE_LOCK, RETRY_COMMAND.
 */
export function recoveryActionCode({
  command,
  errorCode,
  phase,
  succeededCheckpointCount = 0,
  hasEvidence = true,
  producerVersion = 2,
} = {}) {
  // A failure with no evidence or a legacy producer cannot be attributed to
  // a known stage; no action is suggested ("未知").
  if (!hasEvidence || producerVersion < 2) {
    return 'unknown';
  }

  if (command && requiresDiagnosis(errorCode)) return 'DIAGNOSE';

  if (errorCode === 'TRANSACTION_INCOMPLETE') {
    return 'RESOLVE_LOCK';
  }
  if (FIX_CONFIG_CODES.has(errorCode) || phase === 'production-config') {
    return 'FIX_CONFIG';
  }
  if (FIX_AUTH_CODES.has(errorCode)) {
    return 'FIX_AUTH';
  }
  if (FIX_HOOK_CODES.has(errorCode)) {
    return 'FIX_HOOK';
  }
  if (REMOTE_DIAGNOSTIC_CODES.has(errorCode)) {
    return 'DIAGNOSE';
  }
  // Already-succeeded external steps must never be re-run from scratch.
  if (succeededCheckpointCount > 0) {
    return 'DIAGNOSE';
  }
  return 'RETRY_COMMAND';
}

function requiresDiagnosis(code) {
  return typeof code === 'string' && (
    /CONFLICT|AUTH|APPROVAL/.test(code)
    || ['REMOTE_TAG_DRIFT', 'ORIGIN_AHEAD', 'VERSION_SEQUENCE_GAP'].includes(code)
  );
}

const completed = (cp) => ['succeeded', 'skipped'].includes(cp.status);
const publicationComplete = (run) => run.checkpoints.every((cp) => completed(cp)
  || (isMarketplaceAction(cp.actionType) && ['failed', 'deferred'].includes(cp.status)));

/**
 * Read-only release-domain adapter over the existing authority validators.
 * Returned records are transient routing inputs, never an index or receipt.
 * A missing/legacy/corrupt authority is an explicit diagnostic, not "no run".
 * `command` only selects the failing caller's phase (e.g. verify consuming a
 * PUBLISHED source); it never changes the recorded command or status.
 */
export async function readRunRecovery(runPath, options = {}) {
  try {
    const run = runPath ? await loadRun(runPath, { requireDigest: true }) : null;
    const planPath = options.planPath ?? run?.planPath;
    const plan = JSON.parse(await readFile(planPath, 'utf8'));
    validatePlan(plan);
    if (!plan.digest || plan.digest !== computePlanDigest(plan)) {
      throw new ReleaseError(GATE_FAILED, 'recovery requires an intact frozen plan digest');
    }
    assertImmutablePlanAuthority(planPath, plan);
    if (!run) {
      // The publish caller can prove it has not entered checkpoint execution.
      // Even then, retry advice requires the actual plan and current approval.
      if (options.command !== 'publish' || options.beforeCheckpoints !== true || requiresDiagnosis(options.error?.code)) {
        throw new ReleaseError(GATE_FAILED, 'recovery has no validated run authority');
      }
      const raw = await readFile(options.approvalPath, 'utf8');
      const approval = JSON.parse(raw);
      validateApprovalRecordSchema(approval);
      assertImmutableApprovalAuthority(options.approvalPath, plan, raw);
      validateApproval(plan, approval, { clock: options.clock });
      return { recoveryActionCode: 'RETRY_COMMAND' };
    }
    validateRunPlanDigest(run, plan, { planPath });
    const production = Boolean(plan.production);
    const lineage = [];
    let publication = run;
    let publicationPath = runPath;
    if (run.command === 'distribute') {
      // The current lineage API validates publication state journals only.
      // Do not invent a second predecessor-chain validator for distribution.
      if (run.stateSequence !== undefined || run.previousStateDigest !== undefined) {
        throw new ReleaseError(GATE_FAILED, 'unfinished distribution journal requires diagnosis; no sealed run is available');
      }
      if (!run.sourceRunPath || !run.sourceRunId || !run.sourceRunDigest) {
        throw new ReleaseError(GATE_FAILED, 'distribute recovery requires complete publication lineage');
      }
      publicationPath = run.sourceRunPath;
      publication = await loadRun(publicationPath, {
        requireDigest: true, ...(production ? { authorityPlanPath: planPath } : {}),
      });
      if (publication.runId !== run.sourceRunId || publication.runDigest !== run.sourceRunDigest
        || !['publish', 'reconcile'].includes(publication.command) || publication.status !== 'PUBLISHED') {
        throw new ReleaseError(GATE_FAILED, 'distribute recovery requires its same-lineage PUBLISHED publication');
      }
      // Mapping only: the common 1:1 checkpoint validator remains authoritative.
      // §4.3 unified normalization: per-declaration mapping through the shared
      // action-id derivation so v3 checkpoint ids (unitId/localId) match the
      // executed records exactly; legacy plans resolve to the same bare ids.
      const actions = normalizePostPublishView(plan).flatMap((declaration) => [
        ...(declaration.targets ?? []).flatMap((target) => [
          { id: postPublishActionId({ planVersion: plan.planVersion, unitId: declaration.unitId, localId: `probe-${target.id}` }), type: 'distribute-probe' },
          { id: postPublishActionId({ planVersion: plan.planVersion, unitId: declaration.unitId, localId: target.id }), type: 'distribute-mirror' },
        ]),
        ...(declaration.hooks ?? [])
          .filter((hook) => hook.phase !== 'postVerify')
          .map((hook) => ({ id: postPublishActionId({ planVersion: plan.planVersion, unitId: declaration.unitId, localId: hook.id }), type: 'postpublish-hook' })),
      ]);
      // A preflight BLOCKED record may precede checkpoint initialization.
      if (!(run.status === 'BLOCKED' && run.checkpoints.length === 0)) {
        validateRunCheckpointMapping(run, actions);
      }
      await loadRun(runPath, { requireDigest: true, ...(production ? { authorityPlanPath: planPath } : {}) });
    }
    await validateRunLineage(publication, { plan, planPath, runPath: publicationPath, production });
    // The existing validator above proves every edge. Collect those edges for
    // route's ancestor comparison, also checking each plan/action mapping.
    let cursor = publication;
    let cursorPath = publicationPath;
    for (;;) {
      validateRunCheckpointMapping(cursor, plan.externalActions ?? []);
      if (cursor.status === 'PUBLISHED' && !publicationComplete(cursor)) {
        throw new ReleaseError(GATE_FAILED, 'PUBLISHED run has incomplete publication checkpoints');
      }
      if (cursor !== run) lineage.push({ run: cursor, runPath: cursorPath });
      if (cursor.command === 'publish') break;
      cursorPath = cursor.sourceRunPath;
      cursor = await loadRun(cursorPath, { requireDigest: true });
    }
    if (run.command === 'verify') {
      publication = lineage[0]?.run;
      publicationPath = lineage[0]?.runPath;
    }
    const approvalRecord = run.approvalPath ? run : publication;
    let approval = null;
    if (approvalRecord?.approvalPath) {
      const raw = await readFile(approvalRecord.approvalPath, 'utf8');
      approval = JSON.parse(raw);
      validateApprovalRecordSchema(approval);
      const digest = assertImmutableApprovalAuthority(approvalRecord.approvalPath, plan, raw) ?? computeApprovalDigest(raw);
      if (digest !== approvalRecord.approvalDigest) {
        throw new ReleaseError(GATE_FAILED, 'recovery approval digest does not match consumed authority');
      }
      validateApproval(plan, approval, { clock: options.clock, requireUnexpired: false });
    } else if (production) {
      throw new ReleaseError(GATE_FAILED, 'production recovery requires consumed approval authority');
    }
    const command = options.command ?? run.command;
    let code;
    if (requiresDiagnosis(options.error?.code)
      || run.checkpoints.some((cp) => requiresDiagnosis(cp.error?.code)
        || cp.preObserve === 'CONFLICTING' || cp.postObserve === 'CONFLICTING'
        || cp.status === 'AWAITING_APPROVAL')) {
      code = 'DIAGNOSE';
    } else if (command === 'reconcile' && run.command !== 'reconcile' && run.status !== 'PARTIAL') {
      code = 'DIAGNOSE';
    } else if (command === 'verify' && run.command !== 'verify') {
      code = ['publish', 'reconcile'].includes(run.command) && run.status === 'PUBLISHED'
        ? (options.error?.details?.requiredDistribution ? 'DISTRIBUTE' : 'VERIFY') : 'DIAGNOSE';
    } else if (run.command === 'verify') {
      code = run.status === 'VERIFIED' && run.checkpoints.every(completed) ? null : 'DIAGNOSE';
    } else if (command === 'distribute' || run.command === 'distribute') {
      if (publication?.status !== 'PUBLISHED') code = 'DIAGNOSE';
      else if (run.command === 'distribute' && run.status === 'DISTRIBUTED') {
        code = run.checkpoints.every((cp) => completed(cp) || cp.status === 'NO_CHANGE') ? 'VERIFY' : 'DIAGNOSE';
      } else if (run.command === 'distribute' && !['PARTIAL', 'BLOCKED'].includes(run.status)) code = 'DIAGNOSE';
      else {
        code = 'DISTRIBUTE';
        if (run.command === 'distribute' && run.status === 'PARTIAL') {
          // Keep the declared blocksVerified exemption in its existing owner.
          const { evaluateDistributeGateRun } = await import('../commands/verify.mjs');
          if (evaluateDistributeGateRun(run, plan).pass) code = 'VERIFY';
        }
      }
    } else if (['publish', 'reconcile'].includes(command)) {
      if (run.status === 'PUBLISHED') {
        // phase:postVerify hooks do not create an empty distribute predecessor.
        const needsDistribution = requiresPostPublishDistribution(plan);
        code = needsDistribution ? 'DISTRIBUTE' : 'VERIFY';
      } else if (run.status === 'PARTIAL') {
        code = 'RECONCILE';
      } else if (command === 'publish' && ['BLOCKED', 'PUBLISHING'].includes(run.status)
        && run.checkpoints.every((cp) => cp.status === 'pending' || cp.status === 'deferred')) {
        code = 'RETRY_COMMAND';
      } else code = 'DIAGNOSE';
    } else code = 'DIAGNOSE';

    if (code === 'DISTRIBUTE') {
      // §4.3 unified normalization: approval gating resolves declared hooks
      // across all declarations; checkpoint match uses the shared action-id
      // derivation so a v3 record (unitId/hookId) counts as completed.
      const pendingApprovals = normalizePostPublishView(plan).flatMap((declaration) =>
        (declaration.hooks ?? [])
          .filter((hook) => hook.phase !== 'postVerify' && effectiveHookRequiresApproval(hook))
          .filter((hook) => !(run.command === 'distribute' && run.checkpoints.some((cp) =>
            cp.actionId === postPublishActionId({ planVersion: plan.planVersion, unitId: declaration.unitId, localId: hook.id })
            && completed(cp)))));
      if (pendingApprovals.length > 0) {
        try {
          const approved = new Set();
          for (const approvalPath of options.postpublishApprovalPaths ?? []) {
            const raw = await readFile(approvalPath, 'utf8');
            await assertPostPublishApprovalAuthority(planPath, approvalPath, plan, raw);
            const hook = validatePostPublishApproval(plan, JSON.parse(raw), { clock: options.clock });
            approved.add(hook.id);
          }
          if (pendingApprovals.some((hook) => !approved.has(hook.id))) code = 'DIAGNOSE';
        } catch {
          code = 'DIAGNOSE';
        }
      }
    }

    // Reconcile can observe an already-complete publication after expiry;
    // incomplete remote writes still require the existing current approval.
    const needsCurrentApproval = code === 'RETRY_COMMAND' || (code === 'RECONCILE'
      && run.checkpoints.some((cp) => !isMarketplaceAction(cp.actionType) && !completed(cp)));
    if (needsCurrentApproval) {
      try {
        if (options.approvalPath) {
          const raw = await readFile(options.approvalPath, 'utf8');
          approval = JSON.parse(raw);
          validateApprovalRecordSchema(approval);
          assertImmutableApprovalAuthority(options.approvalPath, plan, raw);
        }
        validateApproval(plan, approval, { clock: options.clock });
      } catch (error) {
        return { runPath: resolve(runPath), run, plan, lineage, recoveryActionCode: 'DIAGNOSE',
          diagnostic: { code: error.code ?? GATE_FAILED, message: error.message } };
      }
    }
    return { runPath: resolve(runPath), run, plan, lineage, recoveryActionCode: code,
      recoveryRunPath: ['DISTRIBUTE', 'VERIFY'].includes(code) ? resolve(publicationPath) : resolve(runPath) };
  } catch (error) {
    return {
      runPath: runPath ? resolve(runPath) : null,
      recoveryActionCode: 'DIAGNOSE',
      diagnostic: { code: error.code ?? GATE_FAILED, message: error.message },
    };
  }
}

/**
 * Render the suggested command argv for a recovery code (CLI display only).
 *
 * Nothing returned here is persisted; the summary carries only the code.
 * The argv array form is what surfaces inside lock-conflict diagnostics
 * (details.recovery.argv) so a human can run the exact break-lock command.
 *
 * @param {string} code - A code returned by `recoveryActionCode`.
 * @param {Object} context - Render context.
 * @param {Object} [context.owner] - Held-lock owner record (RESOLVE_LOCK).
 * @param {string} [context.planPath] - Frozen plan path (RECONCILE).
 * @param {string} [context.runPath] - Run record path (RECONCILE).
 * @returns {string[]|null} The argv array, or null when no command should be
 *   rendered for this code.
 */
export function renderRecoveryArgv(code, { owner, planPath, runPath } = {}) {
  switch (code) {
    case 'RESOLVE_LOCK': {
      const ownerJson = owner ? JSON.stringify(owner) : '{}';
      return ['release-skill', 'artifacts', 'break-lock', '--owner', ownerJson, '--reason', '<reason>'];
    }
    case 'RECONCILE':
    case 'DISTRIBUTE':
    case 'VERIFY': {
      const args = ['release-skill', code.toLowerCase()];
      if (planPath) args.push('--plan', planPath);
      if (runPath) args.push('--run', runPath);
      return args;
    }
    default:
      // unknown / FIX_CONFIG / FIX_AUTH / FIX_HOOK / RETRY_COMMAND have no
      // fixed argv: the operator fixes the input and re-runs the command.
      return null;
  }
}

/**
 * Render the suggested command as a shell-ready string (CLI display only).
 *
 * @param {string} code - A code returned by `recoveryActionCode`.
 * @param {Object} context - Render context (see `renderRecoveryArgv`).
 * @returns {string|null} The argv joined as a shell-ready string, or null
 *   when no command should be rendered for this code.
 */
export function renderRecoveryCommand(code, context = {}) {
  const argv = renderRecoveryArgv(code, context);
  return argv === null ? null : argv.join(' ');
}
