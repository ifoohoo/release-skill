import { readFile, lstat, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import { canonicalJson, sha256Hex } from '../core/digest.mjs';
import {
  ReleaseError,
  GATE_FAILED,
  PLAN_DIGEST_MISMATCH,
  CONSUMER_VERIFICATION_DEFERRED,
} from '../core/errors.mjs';

async function writeJsonAtomic(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
  const { stateDigest: _oldDigest, ...body } = value;
  const sealed = {
    ...body,
    stateDigest: sha256Hex(canonicalJson(body)),
  };
  try {
    await writeFile(temp, `${JSON.stringify(sealed, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
    });
    await rename(temp, path);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => {});
    throw error;
  }
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
    transportModule,
    metadataModule,
  ] = await Promise.all([
    import('../core/config.mjs'),
    import('./prepare.mjs'),
    import('./approve.mjs'),
    import('./publish.mjs'),
    import('./reconcile.mjs'),
    import('./verify.mjs'),
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

  if (state.status === 'PUBLISHED' || state.status === 'NEEDS_MANUAL_ATTESTATIONS') {
    try {
      const verified = await deps.verifyRelease({
        planPath: state.planPath,
        sourceRunPath: state.sourceRunPath,
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
  }

  return publicState(state);
}
