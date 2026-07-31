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
    ...(state.hookAuthorizationDigest ? {
      hookAuthorizationDigest: state.hookAuthorizationDigest,
      hooks: state.hooks,
    } : {}),
    ...(state.planPath ? {
      planPath: state.planPath,
      planDigest: state.planDigest,
      evidenceDir: state.evidenceDir,
      warnings: state.warnings ?? [],
    } : {}),
    ...(state.approvalPath ? { approvalPath: state.approvalPath } : {}),
    ...(state.sourceRunPath ? { sourceRunPath: state.sourceRunPath } : {}),
    ...(state.requirements ? { requirements: state.requirements } : {}),
    ...(state.metadataUpdate ? { metadataUpdate: state.metadataUpdate } : {}),
    verificationGateAuthorizationIncludedInPlanApproval:
      state.status !== 'NEEDS_HOOK_AUTHORIZATION',
    postVerifyMetadataUpdateIncludedInPlanApproval:
      state.status !== 'NEEDS_HOOK_AUTHORIZATION',
  };
}

function hookAuthority(loaded, targetVersion) {
  const hooks = Object.keys(loaded.config.hooks ?? {}).sort();
  return {
    hooks,
    digest: sha256Hex(canonicalJson({
      kind: 'release-skill-hook-authorization/v1',
      configDigest: loaded.configDigest,
      hooks: loaded.config.hooks ?? {},
      targetVersion: targetVersion ?? null,
    })),
  };
}

/**
 * Advance one durable production release. Re-running is safe: the state file
 * carries the immutable plan, approval and source-run paths so the command
 * resumes instead of reconstructing authority from terminal/chat output.
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
    const authority = hookAuthority(loaded, options.targetVersion);
    const hooks = authority.hooks;
    const hookAuthorizationDigest = authority.digest;
    state = {
      schemaVersion: 1,
      root,
      statePath,
      targetVersion: options.targetVersion ?? null,
      configDigest: loaded.configDigest,
      hooks,
      hookAuthorizationDigest,
      status: hooks.length > 0 ? 'NEEDS_HOOK_AUTHORIZATION' : 'NEW',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await writeJsonAtomic(statePath, state);
    if (hooks.length > 0 && options.hookAuthorizationDigest !== hookAuthorizationDigest) {
      return publicState(state);
    }
  }

  if (state.status === 'NEEDS_HOOK_AUTHORIZATION') {
    const loaded = await deps.loadProjectConfig({ root });
    const current = hookAuthority(loaded, state.targetVersion);
    if (
      loaded.configDigest !== state.configDigest
      || current.digest !== state.hookAuthorizationDigest
    ) {
      state = {
        ...state,
        configDigest: loaded.configDigest,
        hooks: current.hooks,
        hookAuthorizationDigest: current.digest,
        updatedAt: new Date().toISOString(),
      };
      await writeJsonAtomic(statePath, state);
      if (verified.status === 'VERIFIED' && deps.updatePreviousPublicBaselines) {
        try {
          state.metadataUpdate = await deps.updatePreviousPublicBaselines({
            root,
            planPath: state.planPath,
          });
        } catch (error) {
          state.metadataUpdate = {
            status: 'FAILED',
            error: error.message,
          };
        }
        state.updatedAt = new Date().toISOString();
        await writeJsonAtomic(statePath, state);
      }
      return publicState(state);
    }
    if (options.hookAuthorizationDigest !== state.hookAuthorizationDigest) {
      if (options.hookAuthorizationDigest) {
        throw new ReleaseError(
          PLAN_DIGEST_MISMATCH,
          'hook authorization digest does not match the current config, hooks and target version',
        );
      }
      return publicState(state);
    }
    state.hookAuthorizedBy = options.actor ?? null;
    state.status = 'NEW';
    state.updatedAt = new Date().toISOString();
    await writeJsonAtomic(statePath, state);
  }

  if (state.status === 'NEW') {
    const loaded = await deps.loadProjectConfig({ root });
    if (loaded.configDigest !== state.configDigest) {
      const current = hookAuthority(loaded, state.targetVersion);
      state = {
        ...state,
        configDigest: loaded.configDigest,
        hooks: current.hooks,
        hookAuthorizationDigest: current.digest,
        status: current.hooks.length > 0 ? 'NEEDS_HOOK_AUTHORIZATION' : 'NEW',
        updatedAt: new Date().toISOString(),
      };
      await writeJsonAtomic(statePath, state);
      if (state.status === 'NEEDS_HOOK_AUTHORIZATION') return publicState(state);
    }
    const prepared = await deps.prepareRelease({
      root,
      version: state.targetVersion ?? undefined,
      offline: false,
      production: true,
      hooksAuthorized: true,
      verificationGatesAuthorized: false,
      hookCache: true,
    });
    let transportPreflight = null;
    if (deps.preflightGitTransports) {
      const frozenPlan = JSON.parse(await readFile(prepared.planPath, 'utf8'));
      transportPreflight = await deps.preflightGitTransports(frozenPlan);
      process.env.RELEASE_SKILL_GIT_TRANSPORT = transportPreflight.transport;
    }
    state = {
      ...state,
      status: 'NEEDS_PLAN_APPROVAL',
      planPath: prepared.planPath,
      planDigest: prepared.planDigest,
      evidenceDir: prepared.evidenceDir,
      warnings: prepared.warnings,
      ...(transportPreflight ? {
        gitTransport: transportPreflight.transport,
        gitTransportPreflight: transportPreflight.repositories,
      } : {}),
      updatedAt: new Date().toISOString(),
    };
    await writeJsonAtomic(statePath, state);
  }

  if (state.status === 'NEEDS_PLAN_APPROVAL') {
    if (!options.planApprovalDigest) return publicState(state);
    if (options.planApprovalDigest !== state.planDigest) {
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
      productionConfirmation: state.planDigest,
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
      productionConfirmation: state.planDigest,
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
