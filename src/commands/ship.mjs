import { readFile, lstat, mkdir } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { publishFileOrReplace } from 'skill-family-harness-node';

import { canonicalJson, sha256Hex } from '../core/digest.mjs';
import { effectiveHookRequiresApproval } from '../core/postpublish.mjs';
import {
  ReleaseError,
  GATE_FAILED,
  PLAN_DIGEST_MISMATCH,
  CONSUMER_VERIFICATION_DEFERRED,
} from '../core/errors.mjs';

async function writeJsonAtomic(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const { stateDigest: _oldDigest, ...body } = value;
  const sealed = {
    ...body,
    stateDigest: sha256Hex(canonicalJson(body)),
  };
  await publishFileOrReplace(dirname(path), basename(path), `${JSON.stringify(sealed, null, 2)}\n`, {
    mode: 0o600,
  });
}

async function readState(path) {
  try {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error('ship state must be a regular non-symlink file');
    }
    const state = JSON.parse(await readFile(path, 'utf8'));
    const { stateDigest, ...body } = state;
    if (
      typeof stateDigest !== 'string'
      || stateDigest !== sha256Hex(canonicalJson(body))
      || body.statePath !== path
    ) {
      throw new Error('ship state digest or authority path does not match');
    }
    return state;
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw new ReleaseError(GATE_FAILED, `cannot read ship state: ${error.message}`, { statePath: path });
  }
}

async function defaultDependencies() {
  const [
    configModule,
    prepareModule,
    approveModule,
    publishModule,
    reconcileModule,
    verifyModule,
    distributeModule,
    postverifyModule,
    transportModule,
    metadataModule,
  ] = await Promise.all([
    import('../core/config.mjs'),
    import('./prepare.mjs'),
    import('./approve.mjs'),
    import('./publish.mjs'),
    import('./reconcile.mjs'),
    import('./verify.mjs'),
    import('./distribute.mjs'),
    import('./postverify.mjs'),
    import('../core/git-transport.mjs'),
    import('../core/release-metadata.mjs'),
  ]);
  return {
    loadProjectConfig: configModule.loadProjectConfig,
    prepareRelease: prepareModule.prepareRelease,
    approvePlan: approveModule.approvePlan,
    publishRelease: publishModule.publishRelease,
    reconcileRelease: reconcileModule.reconcileRelease,
    verifyRelease: verifyModule.verifyRelease,
    distributeRelease: distributeModule.distributeRelease,
    postVerifyRelease: postverifyModule.postVerifyRelease,
    preflightGitTransports: transportModule.preflightGitTransports,
    updatePreviousPublicBaselines: metadataModule.updatePreviousPublicBaselines,
  };
}

function publicState(state) {
  return {
    command: 'ship',
    status: state.status,
    statePath: state.statePath,
    targetVersion: state.targetVersion,
    ...(state.hooks && state.hooks.length > 0 ? {
      hooks: state.hooks,
    } : {}),
    ...(state.planPath ? {
      planPath: state.planPath,
      planDigest: state.planDigest,
      evidenceDir: state.evidenceDir,
      warnings: state.warnings ?? [],
    } : {}),
    ...(state.approvalSummary ? { approvalSummary: state.approvalSummary } : {}),
    ...(state.approvalPath ? { approvalPath: state.approvalPath } : {}),
    ...(state.sourceRunPath ? { sourceRunPath: state.sourceRunPath } : {}),
    ...(state.distributeRunPath ? { distributeRunPath: state.distributeRunPath } : {}),
    ...(state.postVerify ? { postVerify: state.postVerify } : {}),
    ...(state.requirements ? { requirements: state.requirements } : {}),
    ...(state.manualFollowUps ? { manualFollowUps: state.manualFollowUps } : {}),
    ...(state.metadataUpdate ? { metadataUpdate: state.metadataUpdate } : {}),
    verificationGateAuthorizationIncludedInPlanApproval: true,
    postVerifyMetadataUpdateIncludedInPlanApproval: true,
  };
}

/**
 * Build a human-readable approval summary from the frozen plan.
 * Lists each unit's version and every external action's id/type/unitId.
 * Returns an empty summary when the plan file is not yet available (e.g., in tests).
 *
 * @param {string} planPath - Path to the frozen release plan.
 * @returns {Promise<object>} The approval summary.
 */
async function buildApprovalSummary(planPath) {
  try {
    const plan = JSON.parse(await readFile(planPath, 'utf8'));
    const units = (plan.units ?? []).map((unit) => ({
      id: unit.id,
      targetVersion: unit.targetVersion ?? unit.version,
    }));
    const actions = (plan.externalActions ?? []).map((action) => ({
      id: action.id,
      type: action.type,
      unitId: action.unitId,
    }));
    return { units, actions };
  } catch {
    return { units: [], actions: [] };
  }
}

/**
 * Re-entry gate helper (R4 review followup 8): true when EVERY unclosed
 * postVerify hook is ungated (effective requiresApproval false), so a failed
 * non-gated hook (e.g. notify-handoff) can be retried without any
 * --hook-approval file. The unclosed set comes from the last postVerify run
 * record when readable (checkpoints not succeeded/NO_CHANGE); an unreadable
 * or missing record falls back to ALL declared hooks — fail-safe, because a
 * gated hook in doubt keeps the gate shut.
 *
 * @param {object} state - Ship state (postVerify.runPath inspected).
 * @param {object[]} postVerifyHooks - Declared phase:postVerify hooks.
 * @returns {Promise<boolean>}
 */
async function allUnclosedPostVerifyHooksUngated(state, postVerifyHooks) {
  if (!Array.isArray(postVerifyHooks) || postVerifyHooks.length === 0) return false;
  let candidates = postVerifyHooks;
  if (state.postVerify?.runPath) {
    try {
      const record = JSON.parse(await readFile(state.postVerify.runPath, 'utf8'));
      const checkpoints = Array.isArray(record.checkpoints) ? record.checkpoints : [];
      const closedIds = new Set(
        checkpoints
          .filter((cp) => cp?.actionType === 'postpublish-hook'
            && (cp.status === 'succeeded' || cp.status === 'NO_CHANGE'))
          .map((cp) => cp.actionId),
      );
      candidates = postVerifyHooks.filter((hook) => !closedIds.has(hook.id));
    } catch {
      candidates = postVerifyHooks; // unreadable record: fail safe
    }
  }
  if (candidates.length === 0) return false;
  return candidates.every((hook) => effectiveHookRequiresApproval(hook) === false);
}

/**
 * Advance one durable production release. Re-running is safe: the state file
 * carries the immutable plan, approval and source-run paths so the command
 * resumes instead of reconstructing authority from terminal/chat output.
 *
 * New flow (v0.4+): ship directly runs configured hooks and verification gates
 * without a separate hook authorization step. The only human gate is plan
 * approval. Kimi/CodeBuddy installations are non-blocking manual follow-up
 * tasks when the plan declares humanConsumersStrategy: 'manualFollowUps'.
 */
export async function advanceShip(options = {}, injected = {}) {
  const root = resolve(options.root ?? process.cwd());
  const statePath = resolve(
    options.statePath ?? resolve(root, '.release-skill', 'ships', 'current.json'),
  );
  const deps = Object.keys(injected).length > 0
    ? injected
    : await defaultDependencies();
  let state = await readState(statePath);
  if (state?.gitTransport) {
    process.env.RELEASE_SKILL_GIT_TRANSPORT = state.gitTransport;
  }

  if (!state) {
    const loaded = await deps.loadProjectConfig({ root });
    const hooks = Object.keys(loaded.config.hooks ?? {}).sort();
    state = {
      schemaVersion: 2,
      root,
      statePath,
      targetVersion: options.targetVersion ?? null,
      configDigest: loaded.configDigest,
      hooks,
      status: 'NEW',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await writeJsonAtomic(statePath, state);
  }

  // Backward compatibility: auto-recover from legacy NEEDS_HOOK_AUTHORIZATION
  // state. Old state files may have this status from the previous two-gate
  // flow; the new flow runs hooks directly so we advance to NEW immediately.
  if (state.status === 'NEEDS_HOOK_AUTHORIZATION') {
    state.status = 'NEW';
    state.updatedAt = new Date().toISOString();
    await writeJsonAtomic(statePath, state);
  }

  if (state.status === 'NEW') {
    const loaded = await deps.loadProjectConfig({ root });
    if (loaded.configDigest !== state.configDigest) {
      const hooks = Object.keys(loaded.config.hooks ?? {}).sort();
      state = {
        ...state,
        configDigest: loaded.configDigest,
        hooks,
        status: 'NEW',
        updatedAt: new Date().toISOString(),
      };
      await writeJsonAtomic(statePath, state);
    }
    const prepared = await deps.prepareRelease({
      root,
      version: state.targetVersion ?? undefined,
      offline: false,
      production: true,
      hooksAuthorized: true,
      verificationGatesAuthorized: true,
      hookCache: true,
    });
    let transportPreflight = null;
    if (deps.preflightGitTransports) {
      const frozenPlan = JSON.parse(await readFile(prepared.planPath, 'utf8'));
      transportPreflight = await deps.preflightGitTransports(frozenPlan);
      process.env.RELEASE_SKILL_GIT_TRANSPORT = transportPreflight.transport;
    }
    const approvalSummary = await buildApprovalSummary(prepared.planPath);
    state = {
      ...state,
      status: 'NEEDS_PLAN_APPROVAL',
      planPath: prepared.planPath,
      planDigest: prepared.planDigest,
      evidenceDir: prepared.evidenceDir,
      warnings: prepared.warnings,
      approvalSummary,
      ...(transportPreflight ? {
        gitTransport: transportPreflight.transport,
        gitTransportPreflight: transportPreflight.repositories,
      } : {}),
      updatedAt: new Date().toISOString(),
    };
    await writeJsonAtomic(statePath, state);
  }

  if (state.status === 'NEEDS_PLAN_APPROVAL') {
    // Boolean --approve: auto-use the stored planDigest (no user digest input needed).
    // Legacy --approve-plan <digest>: explicit digest must match.
    const approveRequested = options.approve === true
      || (typeof options.planApprovalDigest === 'string' && options.planApprovalDigest.length > 0);
    if (!approveRequested) return publicState(state);
    if (options.approve === true) {
      // Boolean approve: no digest input; the stored planDigest is authoritative.
    } else if (options.planApprovalDigest !== state.planDigest) {
      throw new ReleaseError(PLAN_DIGEST_MISMATCH, 'ship plan approval digest does not match the frozen plan');
    }
    if (!options.actor) {
      throw new ReleaseError(GATE_FAILED, 'ship plan approval requires --actor <person>');
    }
    const approval = await deps.approvePlan({
      planPath: state.planPath,
      expectedDigest: state.planDigest,
      actor: options.actor,
    });
    state = {
      ...state,
      status: 'APPROVED',
      approvalPath: approval.approvalPath,
      verificationGatesAuthorized: true,
      approvedBy: options.actor,
      updatedAt: new Date().toISOString(),
    };
    await writeJsonAtomic(statePath, state);
  }

  if (state.status === 'APPROVED' || state.status === 'PUBLISHING') {
    if (!options.adapterRegistry) {
      throw new ReleaseError(GATE_FAILED, 'ship requires an adapter registry to publish');
    }
    state.status = 'PUBLISHING';
    await writeJsonAtomic(statePath, state);
    const published = await deps.publishRelease({
      planPath: state.planPath,
      approvalPath: state.approvalPath,
      adapterRegistry: options.adapterRegistry,
      root,
      productionMode: true,
    });
    state = {
      ...state,
      status: published.status,
      sourceRunPath: published.runPath,
      updatedAt: new Date().toISOString(),
    };
    await writeJsonAtomic(statePath, state);
  }

  if (state.status === 'PARTIAL') {
    const reconciled = await deps.reconcileRelease({
      planPath: state.planPath,
      sourceRunPath: state.sourceRunPath,
      approvalPath: state.approvalPath,
      adapterRegistry: options.adapterRegistry,
      root,
    });
    state = {
      ...state,
      status: reconciled.status,
      sourceRunPath: reconciled.runPath,
      updatedAt: new Date().toISOString(),
    };
    await writeJsonAtomic(statePath, state);
  }

  // Double-run guard (R4 review followup 5): when the PUBLISHED block's
  // step 3 executes postVerify inside this very call, the re-entry block
  // after the lifecycle must NOT immediately re-run it.
  let postVerifyRanThisCall = false;

  if (state.status === 'PUBLISHED' || state.status === 'NEEDS_MANUAL_ATTESTATIONS') {
    // Step 1: Check if postPublish requires distribution.
    // Hooks-only declarations (no targets) still route through distribute.
    const plan = JSON.parse(await readFile(state.planPath, 'utf8'));
    const hasDistributeWork = (plan.postPublish?.targets?.length ?? 0) > 0
      || (plan.postPublish?.hooks?.length ?? 0) > 0;
    const needsDistribution = Boolean(plan.postPublish) && hasDistributeWork;
    if (needsDistribution && deps.distributeRelease) {
      state.status = 'DISTRIBUTING';
      await writeJsonAtomic(statePath, state);
      
      try {
        const distributed = await deps.distributeRelease({
          sourceRunPath: state.sourceRunPath,
          approvalPath: state.approvalPath,
          adapterRegistry: options.adapterRegistry,
          root,
          dryRun: false,
          planPath: state.planPath,
          // Checkpoint approvals for requiresApproval distribute-phase hooks
          // (review major-1: same seam the distribute CLI already uses).
          ...(options.postpublishApprovalPaths ? { postpublishApprovalPaths: options.postpublishApprovalPaths } : {}),
        });
        
        state = {
          ...state,
          status: distributed.status,
          distributeRunPath: distributed.distributeRunPath ?? distributed.runPath,
          updatedAt: new Date().toISOString(),
        };
        await writeJsonAtomic(statePath, state);
        
        // In-memory saga checkpoints carry UPPERCASE statuses ('FAILED');
        // the persisted run record is the lowercase projection. Comparing
        // against 'failed' here was dead code until v0.6.3 (review note-5).
        if (!distributed.checkpoints || distributed.checkpoints.some((cp) => cp.status === 'FAILED')) {
          state.status = 'PARTIAL';
          await writeJsonAtomic(statePath, state);
          return publicState(state);
        }
      } catch (error) {
        state.status = 'PARTIAL';
        await writeJsonAtomic(statePath, state);
        throw error;
      }
    }
    
    // Step 2: Verify (this will check for distributed run if distribution was required)
    try {
      const verified = await deps.verifyRelease({
        planPath: state.planPath,
        sourceRunPath: needsDistribution ? state.distributeRunPath : state.sourceRunPath,
        adapterRegistry: options.adapterRegistry,
        root,
        verificationGatesAuthorized: state.verificationGatesAuthorized === true,
      });
      state = {
        ...state,
        status: verified.status,
        verifyRunPath: verified.runPath,
        requirements: undefined,
        manualFollowUps: verified.manualFollowUps ?? undefined,
        baselineAdvance: verified.baselineAdvance ?? undefined,
        updatedAt: new Date().toISOString(),
      };
      await writeJsonAtomic(statePath, state);
    } catch (error) {
      if (error?.code !== CONSUMER_VERIFICATION_DEFERRED) throw error;
      state = {
        ...state,
        status: 'NEEDS_MANUAL_ATTESTATIONS',
        requirements: error.details?.requirements ?? [],
        updatedAt: new Date().toISOString(),
      };
      await writeJsonAtomic(statePath, state);
    }

    // Step 3: postVerify phase (design §2.4). phase:postVerify hooks run in an
    // independent run after the main run is VERIFIED, with the verify run as
    // lineage source. A PARTIAL postVerify run or a postVerify gate failure
    // NEVER demotes VERIFIED — the outcome is recorded on the ship state.
    const postVerifyHooks = (plan.postPublish?.hooks ?? [])
      .filter((hook) => hook.phase === 'postVerify');
    if (state.status === 'VERIFIED' && postVerifyHooks.length > 0 && deps.postVerifyRelease) {
      postVerifyRanThisCall = true;
      let postVerifyOutcome;
      try {
        const postVerified = await deps.postVerifyRelease({
          planPath: state.planPath,
          approvalPath: state.approvalPath,
          sourceRunPath: state.verifyRunPath,
          root,
          postpublishApprovalPaths: options.postpublishApprovalPaths,
        });
        postVerifyOutcome = {
          status: postVerified.status,
          runPath: postVerified.runPath,
        };
      } catch (error) {
        postVerifyOutcome = {
          status: 'FAILED',
          error: {
            code: error?.code ?? GATE_FAILED,
            message: error?.message ?? String(error),
          },
        };
      }
      state = {
        ...state,
        postVerify: postVerifyOutcome,
        updatedAt: new Date().toISOString(),
      };
      await writeJsonAtomic(statePath, state);
    }
  }

  // postVerify re-entry (design §2.4; review major-1). Once the main run is
  // VERIFIED, ship no longer enters the PUBLISHED block, so a postVerify
  // outcome parked at AWAITING_APPROVAL (run status NEEDS_INPUT) could never
  // complete through the CLI. The gate opens when a checkpoint approval is
  // provided OR every unclosed postVerify hook is ungated (R4 review
  // followup 8: a failed requiresApproval:false hook retries without any
  // approval file; a gated hook still unclosed keeps the gate shut).
  // Re-entry re-runs the phase — rerun IS the reconcile: approved hooks
  // execute, already-delivered hooks stay idempotent, the verify run remains
  // the lineage source, and the main VERIFIED status never changes. When the
  // gate stays shut this block is a no-op: zero postVerify work, no writes.
  const reentryApprovalPaths = options.postpublishApprovalPaths ?? [];
  if (
    state.status === 'VERIFIED'
    && deps.postVerifyRelease
    && !postVerifyRanThisCall
    && (!state.postVerify || state.postVerify.status !== 'DISTRIBUTED')
  ) {
    const reentryPlan = JSON.parse(await readFile(state.planPath, 'utf8'));
    const reentryPostVerifyHooks = (reentryPlan.postPublish?.hooks ?? [])
      .filter((hook) => hook.phase === 'postVerify');
    const approvallessRetryAllowed = reentryApprovalPaths.length === 0
      && await allUnclosedPostVerifyHooksUngated(state, reentryPostVerifyHooks);
    if (reentryPostVerifyHooks.length > 0
      && (reentryApprovalPaths.length > 0 || approvallessRetryAllowed)) {
      let postVerifyOutcome;
      try {
        const postVerified = await deps.postVerifyRelease({
          planPath: state.planPath,
          approvalPath: state.approvalPath,
          sourceRunPath: state.verifyRunPath,
          root,
          postpublishApprovalPaths: reentryApprovalPaths,
        });
        postVerifyOutcome = {
          status: postVerified.status,
          runPath: postVerified.runPath,
        };
      } catch (error) {
        postVerifyOutcome = {
          status: 'FAILED',
          error: {
            code: error?.code ?? GATE_FAILED,
            message: error?.message ?? String(error),
          },
        };
      }
      state = {
        ...state,
        postVerify: postVerifyOutcome,
        updatedAt: new Date().toISOString(),
      };
      await writeJsonAtomic(statePath, state);
    }
  }

  return publicState(state);
}
