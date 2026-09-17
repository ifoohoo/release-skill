import { access, readFile, mkdir, mkdtemp, cp, rename, rm, lstat, realpath, chmod } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, relative, isAbsolute, normalize } from 'node:path';

import {
  readFileContained,
  readFileStrict,
  resolveContained,
  superviseProcess,
  withTemporaryWorkspace,
  createTemporaryWorkspace,
  createFilesystemRootBinding,
  observeFilesystemTree,
  createFixedSetPublicationManifest,
  publishFixedSet,
  replaceFixedSetAtomic,
} from 'skill-family-harness-node';

import { getPlatform } from '../platforms/registry.mjs';
import { resolveCodeBuddyMarketplace } from '../platforms/codebuddy.mjs';
import { verifyInstalledMarketplacePayload } from '../adapters/plugin-marketplace.mjs';
import { normalizePostPublishView, postPublishActionId } from '../core/postpublish.mjs';
import { loadRun, validateRunLineage } from '../core/run.mjs';
import { verifyFrozenSnapshot } from '../snapshot/frozen.mjs';

const HOSTS_BY_ACTION = Object.freeze({
  'claude-marketplace-install': ['claude'],
  'codex-marketplace-install': ['codex'],
  'kimi-marketplace-install': ['kimi'],
  'codebuddy-marketplace-install': ['codebuddy', 'workbuddy'],
});

const DISTRIBUTION_BY_ACTION = Object.freeze({
  'claude-marketplace-install': 'claude-plugin',
  'codex-marketplace-install': 'codex-plugin',
  'kimi-marketplace-install': 'kimi-plugin',
  'codebuddy-marketplace-install': 'codebuddy-plugin',
});

const BRANCH_ACTION_INCLUDED = new Set(['advance-existing-branch', 'initialize-default-branch']);
const CODEBUDDY_MACOS_PATH = '/Applications/WorkBuddy.app/Contents/Resources/app.asar.unpacked/cli/bin/codebuddy';
const SAFE_ENV_KEYS = Object.freeze([
  'PATH', 'HOME', 'USER', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TERM', 'TMPDIR',
  'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy',
  'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS',
  'CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'KIMI_CODE_HOME',
  'CODEBUDDY_CONFIG_DIR', 'WORKBUDDY_CONFIG_DIR',
]);
const CODEBUDDY_PLUGIN_LIST_ARGS = Object.freeze(['plugin', 'list', '--json']);
const CODEBUDDY_MARKETPLACE_LIST_ARGS = Object.freeze(['plugin', 'marketplace', 'list']);
const QODER_PLUGIN_LIST_ARGS = Object.freeze(['plugins', 'list', '--json']);
const QODER_MARKETPLACE_LIST_ARGS = Object.freeze(['plugins', 'marketplace', 'list', '--json']);
const QODER_PAYLOAD_CONTRACT = 'external-marketplace-v1';

function attachFoundationFailure(error, { envelope, stdout, stderr }) {
  Object.defineProperties(error, {
    foundationEnvelope: { value: envelope, enumerable: false },
    foundationStdout: { value: stdout, enumerable: false },
    foundationStderr: { value: stderr, enumerable: false },
  });
  return error;
}

function actionTarget(plan, action, host) {
  const parameters = action.parameters ?? {};
  const sourceDescriptor = parameters.sourceDescriptor ?? {};
  const unit = (plan.units ?? []).find((candidate) => candidate.id === action.unitId);
  if (!unit) throw new Error(`post-release action ${action.id} references an unknown unit`);
  const distributionType = DISTRIBUTION_BY_ACTION[action.type];
  const distribution = (unit.distributions ?? []).find((candidate) => (
    candidate.type === distributionType && candidate.plugin === parameters.plugin
  ));
  if (!distribution) {
    throw new Error(`post-release action ${action.id} is not backed by its unit distribution`);
  }
  if (unit.targetVersion !== parameters.version) {
    throw new Error(`post-release action ${action.id} disagrees with its frozen unit identity`);
  }
  const pluginRepo = sourceDescriptor.form === 'standalone-index'
    ? sourceDescriptor.pluginRepo
    : sourceDescriptor.repo;
  const marketplaceRepo = sourceDescriptor.form === 'standalone-index'
    ? sourceDescriptor.marketplaceRepo
    : sourceDescriptor.repo;
  const pluginCommit = parameters.sourceCommit;
  const marketplaceCommit = sourceDescriptor.form === 'standalone-index'
    ? parameters.marketplaceCommitSha
    : pluginCommit;
  const tagAction = (plan.externalActions ?? []).find((candidate) => (
    candidate.type === 'create-tag' && candidate.unitId === action.unitId
  ));
  const pushAction = (plan.externalActions ?? []).find((candidate) => (
    candidate.type === 'push-snapshot' && candidate.unitId === action.unitId
  ));
  const pluginTag = tagAction?.parameters?.tag;
  if (
    pluginRepo !== unit.publicRepo
    || marketplaceRepo !== parameters.repo
    || sourceDescriptor.marketplaceEntry !== parameters.plugin
    || tagAction?.parameters?.repo !== pluginRepo
    || tagAction?.parameters?.commit !== pluginCommit
    || tagAction?.parameters?.version !== parameters.version
  ) {
    throw new Error(`post-release action ${action.id} disagrees with its frozen source identities`);
  }
  if (sourceDescriptor.form === 'standalone-index') {
    if (
      sourceDescriptor.marketplaceCommitSha !== marketplaceCommit
      || sourceDescriptor.ref !== parameters.ref
    ) {
      throw new Error(`post-release action ${action.id} disagrees with its standalone marketplace identity`);
    }
  } else if (sourceDescriptor.form !== 'bundled-family' || sourceDescriptor.commit !== pluginCommit) {
    throw new Error(`post-release action ${action.id} has no single frozen source commit`);
  }
  const codeBuddyFamily = host === 'codebuddy' || host === 'workbuddy';
  if (
    codeBuddyFamily
    && sourceDescriptor.form === 'bundled-family'
    && (
      pushAction?.parameters?.repo !== pluginRepo
      || pushAction?.parameters?.commit !== pluginCommit
      || typeof pushAction?.parameters?.branch !== 'string'
      || pushAction.parameters.branch.length === 0
      || (
        pushAction.parameters.branch.startsWith('refs/')
        && !pushAction.parameters.branch.startsWith('refs/heads/')
      )
    )
  ) {
    throw new Error(`post-release action ${action.id} has no matching frozen mutable branch identity`);
  }
  const marketplaceRef = codeBuddyFamily && sourceDescriptor.form === 'bundled-family'
    ? (pushAction.parameters.branch.startsWith('refs/heads/')
      ? pushAction.parameters.branch
      : `refs/heads/${pushAction.parameters.branch}`)
    : parameters.ref;
  return {
    host,
    actionId: action.id,
    actionType: action.type,
    unitId: action.unitId,
    plugin: parameters.plugin,
    marketplace: host === 'codebuddy' || host === 'workbuddy'
      ? resolveCodeBuddyMarketplace(parameters)
      : parameters.marketplace ?? sourceDescriptor.marketplaceEntry ?? parameters.plugin,
    version: parameters.version,
    pluginRepo,
    githubHost: tagAction?.parameters?.githubHost ?? pushAction?.parameters?.githubHost ?? 'github.com',
    pluginTag,
    pluginCommit,
    marketplaceRepo,
    marketplaceRef,
    marketplaceCommit,
    sourceForm: sourceDescriptor.form,
    timeoutMs: parameters.timeoutMs ?? 300_000,
  };
}

function pluginTargets(plan) {
  const targets = [];
  for (const action of plan.externalActions ?? []) {
    const hosts = HOSTS_BY_ACTION[action.type];
    if (!hosts) continue;
    for (const host of hosts) targets.push(actionTarget(plan, action, host));
  }
  return targets.sort((left, right) => (
    left.host.localeCompare(right.host) || left.unitId.localeCompare(right.unitId)
  ));
}

function hubTargets(plan) {
  if (plan?.planVersion === undefined) return [];
  return normalizePostPublishView(plan).flatMap((declaration) => {
    const local = declaration.localHostUpdate;
    if (!local) return [];
    const hub = { ...local.hub, githubHost: local.hub.githubHost ?? 'github.com' };
    const unit = (plan.units ?? []).find((candidate) => candidate.id === declaration.unitId);
    const tagActions = (plan.externalActions ?? []).filter((action) => action.type === 'create-tag' && action.unitId === declaration.unitId);
    const tagIdentity = tagActions[0]?.parameters;
    const tag = tagIdentity?.tag;
    return local.hosts.map((host) => {
      if (host === 'cursor') {
        return {
          targetKind: 'cursor-local', executionMode: 'executable',
          unitId: declaration.unitId, host, plugin: local.plugin,
          version: unit?.targetVersion,
          snapshotPath: unit?.frozenSnapshot?.path,
          manifestDigest: unit?.frozenSnapshot?.manifestDigest,
          cursor: local.cursor, timeoutMs: 300_000,
          message: `Install or replace the complete frozen ${local.plugin} Cursor Local plugin; quit Cursor first and restart it afterwards.`,
        };
      }
      if (host === 'qoder') {
        return {
          targetKind: 'hub-backed',
          executionMode: 'executable',
          unitId: declaration.unitId,
          host,
          plugin: local.plugin,
          marketplace: hub.name,
          hub,
          version: unit?.targetVersion,
          pluginRepo: unit?.publicRepo,
          pluginCommit: unit?.frozenSnapshot?.commit,
          snapshotPath: unit?.frozenSnapshot?.path,
          manifestDigest: unit?.frozenSnapshot?.manifestDigest,
          timeoutMs: 300_000,
          message: `Update ${local.plugin} from Qoder Hub ${hub.name}; a new session or /plugins reload is required before treating the updated plugin as loaded.`,
          ...(tag ? { frozenTag: tag } : {}),
        };
      }
      return {
        targetKind: 'hub-backed',
        executionMode: 'executable',
        unitId: declaration.unitId,
        host,
        plugin: local.plugin,
        version: unit?.targetVersion,
        hub,
        marketplace: hub.name,
        marketplaceRepo: hub.repo,
        marketplaceRef: hub.ref,
        githubHost: tagIdentity?.githubHost ?? 'github.com',
        pluginRepo: unit?.publicRepo,
        pluginCommit: unit?.frozenSnapshot?.commit,
        pluginTag: tag,
        frozenTag: tag,
        snapshotPath: unit?.frozenSnapshot?.path,
        manifestDigest: unit?.frozenSnapshot?.manifestDigest,
        timeoutMs: 300_000,
        message: host === 'kimi'
          ? `Install the frozen GitHub Release ${tag} through Kimi's controlled terminal interface.`
          : `Update ${local.plugin} from the existing ${hub.name} marketplace and verify the frozen payload.`,
        ...(tagActions.length !== 1 || tagIdentity?.repo !== unit?.publicRepo
          || tagIdentity?.commit !== unit?.frozenSnapshot?.commit
          || tagIdentity?.version !== unit?.targetVersion
          ? { invalidFrozenIdentity: true } : {}),
      };
    });
  });
}

function mergePostReleaseTargets(executableTargets, manualTargets) {
  const byIdentity = new Map();
  for (const target of [...executableTargets, ...manualTargets]) {
    const key = `${target.unitId}\u0000${target.host}\u0000${target.plugin}`;
    const existing = byIdentity.get(key);
    if (existing && existing.targetKind === 'hub-backed' && target.targetKind === 'hub-backed') {
      const sameHub = ['name', 'githubHost', 'repo', 'ref'].every((field) => existing.hub[field] === target.hub[field]);
      const samePlugin = ['version', 'pluginRepo', 'pluginTag', 'pluginCommit', 'snapshotPath', 'manifestDigest']
        .every((field) => existing[field] === target[field]);
      if (!sameHub || !samePlugin) throw new Error(`post-release target identity conflict for ${target.unitId}/${target.host}/${target.plugin}`);
      continue;
    }
    const hubMatchesExecutable = (hub, executable, hubTarget) => executable.marketplace === hub.name
      && executable.marketplaceRepo === hub.repo
      && executable.marketplaceRef === hub.ref
      && executable.githubHost === hub.githubHost
      && executable.pluginRepo === hubTarget.pluginRepo
      && executable.pluginTag === hubTarget.pluginTag
      && executable.pluginCommit === hubTarget.pluginCommit;
    // When the same frozen plugin is available through both sources, the
    // executable action wins only when both frozen source identities agree.
    if (existing && existing.targetKind !== 'hub-backed' && target.targetKind === 'hub-backed') {
      if (!hubMatchesExecutable(target.hub, existing, target)) {
        throw new Error(`post-release target identity conflict for ${target.unitId}/${target.host}/${target.plugin}`);
      }
      continue;
    }
    if (existing && existing.targetKind === 'hub-backed' && target.targetKind !== 'hub-backed') {
      if (!hubMatchesExecutable(existing.hub, target, existing)) {
        throw new Error(`post-release target identity conflict for ${target.unitId}/${target.host}/${target.plugin}`);
      }
      byIdentity.set(key, target);
      continue;
    }
    if (existing && existing.actionId !== target.actionId) {
      throw new Error(`post-release target identity conflict for ${target.unitId}/${target.host}/${target.plugin}`);
    }
    if (!existing) byIdentity.set(key, target);
  }
  return [...byIdentity.values()].sort((left, right) => (
    left.host.localeCompare(right.host) || left.unitId.localeCompare(right.unitId) || left.plugin.localeCompare(right.plugin)
  ));
}

function assertExecutableTarget(target) {
  if (target.targetKind === 'hub-backed') {
    assertQoderExecutableTarget(target);
    if (target.invalidFrozenIdentity || typeof target.pluginTag !== 'string' || !target.pluginTag
      || !/^[\w.-]+\/[\w.-]+$/u.test(target.pluginRepo)
      || !/^[\w.-]+\/[\w.-]+$/u.test(target.hub.repo)
      || !target.hub.ref?.startsWith('refs/heads/')) {
      throw new Error(`local host update target has inconsistent frozen source identity for ${target.unitId}`);
    }
    return;
  }
  for (const field of [
    'actionId', 'unitId', 'plugin', 'version',
    'pluginRepo', 'pluginTag', 'pluginCommit',
    'marketplaceRepo', 'marketplaceRef', 'marketplaceCommit',
  ]) {
    if (typeof target[field] !== 'string' || target[field].length === 0) {
      throw new Error(`local host update target is missing ${field}`);
    }
  }
  if (!/^[a-f0-9]{40}$/u.test(target.pluginCommit) || !/^[a-f0-9]{40}$/u.test(target.marketplaceCommit)) {
    throw new Error(`local host update requires the frozen public commit for unit ${target.unitId}`);
  }
}

function assertQoderExecutableTarget(target) {
  for (const field of [
    'unitId', 'plugin', 'marketplace', 'version', 'pluginRepo',
    'pluginCommit', 'snapshotPath', 'manifestDigest',
  ]) {
    if (typeof target[field] !== 'string' || target[field].length === 0) {
      throw new Error(`Qoder local host update target is missing ${field}`);
    }
  }
  if (!/^[a-f0-9]{40}$/u.test(target.pluginCommit)) {
    throw new Error(`Qoder local host update requires the frozen public commit for unit ${target.unitId}`);
  }
  if (!/^[a-f0-9]{64}$/u.test(target.manifestDigest)) {
    throw new Error(`Qoder local host update requires the frozen snapshot digest for unit ${target.unitId}`);
  }
}

function buildShipNextStep({ root, statePath, unitIds }) {
  const argv = ['release-skill', 'ship'];
  if (typeof root === 'string' && root.length > 0) argv.push('--root', root);
  if (typeof statePath === 'string' && statePath.length > 0) argv.push('--state', statePath);
  if (Array.isArray(unitIds) && unitIds.length > 0) {
    for (const unitId of unitIds) argv.push('--unit', unitId);
  }
  return {
    code: 'COMPLETE_POST_VERIFY',
    message: 'Complete the postVerify phase with ship before running post-release.',
    argv,
  };
}

function buildFinishCommand({ root, planPath, runPath }) {
  if (![root, planPath, runPath].every((value) => typeof value === 'string' && value.length > 0)) return undefined;
  return {
    argv: [
      'release-skill', 'post-release',
      '--root', root,
      '--plan', planPath,
      '--run', runPath,
      '--finish',
    ],
  };
}

export function derivePostReleaseChecklist(plan, {
  runPath,
  root,
  planPath,
  statePath,
  unitIds,
  postVerifyComplete = false,
} = {}) {
  if (!plan || typeof plan !== 'object' || typeof plan.digest !== 'string') {
    throw new Error('a frozen release plan with digest is required');
  }
  const units = plan.units ?? [];
  const uncovered = units.filter((unit) => (
    !BRANCH_ACTION_INCLUDED.has(unit.productionConfig?.branchStrategy)
  ));
  const declaredHubTargets = hubTargets(plan);
  for (const target of declaredHubTargets) {
    if (target.targetKind === 'hub-backed' && target.host !== 'qoder') assertExecutableTarget(target);
  }
  const executableTargets = [
    ...pluginTargets(plan),
    ...declaredHubTargets.filter((target) => target.executionMode === 'executable'),
  ];
  const manualTargets = declaredHubTargets.filter((target) => target.executionMode === 'manual');
  const targets = mergePostReleaseTargets(executableTargets, manualTargets);
  const hasPendingPostVerify = postVerifyHooks(plan).length > 0 && !postVerifyComplete && targets.length > 0;
  const hasStatePath = typeof statePath === 'string' && statePath.length > 0;
  const selectedUnitIds = Array.isArray(unitIds) ? unitIds : undefined;
  const finishCommand = hasPendingPostVerify ? undefined : buildFinishCommand({ root, planPath, runPath });
  return {
    command: 'post-release',
    status: 'AWAITING_USER_DECISION',
    planDigest: plan.digest,
    ...(finishCommand ? { finishCommand } : {}),
    merge: {
      promptRequired: uncovered.length > 0,
      alreadyHandledByRelease: uncovered.length === 0,
      executionIncluded: false,
      units: uncovered.map((unit) => ({
        unitId: unit.id,
        branchStrategy: unit.productionConfig?.branchStrategy ?? null,
        publishedBranch: unit.frozenSnapshot?.branch ?? null,
      })),
    },
    localHostUpdate: {
      promptRequired: targets.length > 0 && !hasPendingPostVerify,
      available: executableTargets.length > 0 && !hasPendingPostVerify,
      ...(!hasPendingPostVerify && runPath ? { runPath } : {}),
      ...(hasPendingPostVerify ? {
        ...(hasStatePath ? { nextSteps: [buildShipNextStep({ root, statePath, unitIds: selectedUnitIds })] } : {}),
      } : {}),
      hosts: [...new Set(targets.map((target) => target.host))].sort(),
      targets,
    },
  };
}

function postVerifyHooks(plan) {
  if (plan?.planVersion === undefined) return [];
  return normalizePostPublishView(plan).flatMap((declaration) => (
    (declaration.hooks ?? [])
      .filter((hook) => hook.phase === 'postVerify')
      .map((hook) => ({
        actionId: postPublishActionId({ planVersion: plan.planVersion, unitId: declaration.unitId, localId: hook.id }),
        hook,
        unitId: declaration.unitId,
      }))
  ));
}

function localFinishEvidenceError(message, { cause, root, statePath, unitIds } = {}) {
  const error = new Error(`local host update evidence is not ready: ${message}; next step: obtain approval if required, then complete the postVerify phase with ship before rerunning post-release`);
  error.code = 'LOCAL_FINISH_EVIDENCE_NOT_READY';
  const hasStatePath = typeof statePath === 'string' && statePath.length > 0;
  error.details = {
    cause: {
      code: cause?.code ?? 'LOCAL_FINISH_EVIDENCE_NOT_READY',
      message: cause?.message ?? message,
    },
    ...(hasStatePath ? {
      nextSteps: [buildShipNextStep({ root, statePath, unitIds })],
    } : {}),
  };
  return error;
}

/**
 * Validate the frozen run authority before allowing any local host command.
 * This is the only exported entry that can perform local host writes.
 */
export async function updateLocalHostPlugins({
  plan: _suppliedPlan,
  planPath,
  runPath,
  runRecord: _suppliedRunRecord,
  production: _suppliedProduction,
  root = process.cwd(),
  statePath,
  unitIds,
  ...options
} = {}) {
  if (!planPath || !runPath) {
    throw localFinishEvidenceError(
      'planPath and runPath are required before local host updates',
      { root, statePath, unitIds },
    );
  }
  let plan;
  let runRecord;
  try {
    plan = JSON.parse(await readFile(planPath, 'utf8'));
    runRecord = await loadRun(runPath, {
      requireDigest: true,
      authorityPlanPath: planPath,
    });
  } catch (cause) {
    throw localFinishEvidenceError(cause.message, { cause, root, statePath, unitIds });
  }
  await assertLocalFinishRun({
    plan,
    planPath,
    runPath,
    runRecord,
    production: Boolean(plan.production),
    root,
    statePath,
    unitIds,
  });
  return updateLocalHostPluginsInternal({
    plan,
    root,
    ...options,
  });
}

/** Validate the explicit run supplied to local-finish before any host probe. */
export async function assertLocalFinishRun({
  plan,
  planPath,
  runPath,
  runRecord,
  production = false,
  root,
  statePath,
  unitIds,
} = {}) {
  const hooks = postVerifyHooks(plan);
  if (hooks.length === 0) {
    try {
      await validateRunLineage(runRecord, { plan, planPath, runPath, production });
      assertVerifiedReleaseRun(plan, runRecord);
    } catch (cause) {
      throw localFinishEvidenceError(cause.message, { cause, root, statePath, unitIds, plan });
    }
    return { runPath, phase: 'verify' };
  }
  if (runRecord?.command !== 'postverify' || runRecord?.status !== 'DISTRIBUTED') {
    throw localFinishEvidenceError('the plan declares postVerify hooks, so the supplied verify run cannot authorize local-finish', { root, statePath, unitIds, plan });
  }
  if (runRecord.planDigest !== plan?.digest) {
    throw localFinishEvidenceError('postVerify run is not bound to the frozen plan', { root, statePath, unitIds, plan });
  }
  if (typeof runRecord.sourceRunPath !== 'string' || typeof runRecord.sourceRunId !== 'string' || typeof runRecord.sourceRunDigest !== 'string') {
    throw localFinishEvidenceError('completed postVerify run has incomplete verify-run lineage', { root, statePath, unitIds, plan });
  }
  const checkpoints = Array.isArray(runRecord.checkpoints) ? runRecord.checkpoints : null;
  const expectedIds = hooks.map(({ actionId }) => actionId);
  const actualIds = checkpoints?.map((checkpoint) => checkpoint?.actionId) ?? [];
  if (
    !checkpoints
    || actualIds.length !== expectedIds.length
    || new Set(actualIds).size !== actualIds.length
    || actualIds.some((id) => !expectedIds.includes(id))
    || expectedIds.some((id) => !actualIds.includes(id))
    || checkpoints.some((checkpoint) => (
      checkpoint.actionType !== 'postpublish-hook'
      || !['succeeded', 'NO_CHANGE'].includes(checkpoint.status)
    ))
  ) {
    throw localFinishEvidenceError('postVerify checkpoints must match each declared hook exactly and be succeeded or NO_CHANGE', { root, statePath, unitIds, plan });
  }
  let sourceRun;
  try {
    sourceRun = await loadRun(runRecord.sourceRunPath, {
      requireDigest: true,
      authorityPlanPath: planPath,
    });
  } catch (cause) {
    throw localFinishEvidenceError(cause.message, { cause, root, statePath, unitIds, plan });
  }
  if (
    sourceRun.command !== 'verify'
    || sourceRun.status !== 'VERIFIED'
    || sourceRun.runId !== runRecord.sourceRunId
    || sourceRun.runDigest !== runRecord.sourceRunDigest
    || sourceRun.planDigest !== plan.digest
  ) {
    throw localFinishEvidenceError('postVerify lineage does not point to the same-plan VERIFIED run', { root, statePath, unitIds, plan });
  }
  try {
    await validateRunLineage(sourceRun, {
      plan,
      planPath,
      runPath: runRecord.sourceRunPath,
      production,
    });
  } catch (cause) {
    throw localFinishEvidenceError(cause.message, { cause, root, statePath, unitIds, plan });
  }
  return { runPath, sourceRunPath: runRecord.sourceRunPath, phase: 'postverify' };
}

export function unavailablePostReleaseChecklist(plan, error) {
  return {
    command: 'post-release',
    status: 'UNAVAILABLE',
    planDigest: plan?.digest ?? null,
    releaseStatusChanged: false,
    diagnostic: {
      code: 'POST_RELEASE_CHECKLIST_UNAVAILABLE',
      message: error?.message ?? String(error),
    },
  };
}

export function assertVerifiedReleaseRun(plan, runRecord) {
  if (
    runRecord?.command !== 'verify'
    || runRecord?.status !== 'VERIFIED'
    || runRecord?.planDigest !== plan?.digest
  ) {
    throw new Error('post-release local work requires a VERIFIED run bound to the frozen plan');
  }
}

function hostEnvironment(host, { kimiHome } = {}) {
  const env = {};
  for (const key of SAFE_ENV_KEYS) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  env.HOME ??= homedir();
  env.PATH ??= '/usr/bin:/bin';
  env.GIT_TERMINAL_PROMPT = '0';
  if (host === 'codebuddy') env.CODEBUDDY_CONFIG_DIR = join(env.HOME, '.codebuddy');
  if (host === 'workbuddy') {
    env.CODEBUDDY_CONFIG_DIR = join(env.HOME, '.workbuddy');
    env.WORKBUDDY_CONFIG_DIR = join(env.HOME, '.workbuddy');
  }
  if (host === 'kimi' && kimiHome) env.KIMI_CODE_HOME = kimiHome;
  return env;
}

async function defaultRun(command, args, options = {}) {
  return withTemporaryWorkspace(async (workspace) => {
    const stdoutFile = 'stdout.log';
    const stderrFile = 'stderr.log';
    const envelope = await superviseProcess({
      command,
      args,
      cwd: options.cwd ?? process.cwd(),
      env: options.env ?? hostEnvironment('generic'),
      timeoutPolicy: {
        maxSeconds: Math.max(1, Math.ceil((options.timeout ?? 120_000) / 1000)),
        killGraceSeconds: 5,
      },
      rawSink: { root: workspace.root, stdoutFile, stderrFile },
      outputByteLimits: { stdout: 8 * 1024 * 1024, stderr: 8 * 1024 * 1024 },
    });
    const [stdout, stderr] = await Promise.all([
      workspace.readFile(stdoutFile, { encoding: 'utf8' }),
      workspace.readFile(stderrFile, { encoding: 'utf8' }),
    ]);
    if (!envelope.ok) {
      const error = new Error(
        `${command} exited ${envelope.exitStatus}${stderr.trim() ? `: ${stderr.trim()}` : ''}`,
      );
      error.exitStatus = envelope.exitStatus;
      error.hostCommandUnavailable = envelope.processStatus === 'FAILED_TO_START';
      error.details = {
        processStatus: envelope.processStatus,
        terminationReason: envelope.terminationReason,
        watchdogReason: envelope.watchdogReason,
        ...(envelope.evidence?.spawnError ? { spawnError: envelope.evidence.spawnError } : {}),
      };
      throw attachFoundationFailure(error, { envelope, stdout, stderr });
    }
    return { stdout, stderr };
  }, { prefix: 'release-skill-host-command-' });
}

export { defaultRun as runLocalFinishCommand };

async function commandAvailable(command, host, run) {
  try {
    await run(command, ['--version'], { timeout: 10_000, env: hostEnvironment(host) });
    return true;
  } catch (error) {
    if (error?.hostCommandUnavailable === true) return false;
    throw error;
  }
}

async function defaultDetect(host, run = defaultRun) {
  if (host === 'codebuddy') {
    for (const command of ['codebuddy', 'cbc']) {
      if (await commandAvailable(command, host, run)) return { available: true, command };
    }
    return { available: false, reason: 'CodeBuddy/WorkBuddy CLI not found' };
  }
  if (host === 'workbuddy') {
    if (process.platform !== 'darwin') return { available: false, status: 'SKIPPED_UNSUPPORTED_PLATFORM', reason: 'WorkBuddy local update is supported only on macOS' };
    if (await commandAvailable(CODEBUDDY_MACOS_PATH, host, run)) return { available: true, command: CODEBUDDY_MACOS_PATH };
    return { available: false, reason: 'WorkBuddy embedded CLI not found' };
  }
  if (host === 'kimi') {
    if (!await commandAvailable('kimi', host, run)) return { available: false, reason: 'kimi CLI not found' };
    try {
      await access('/usr/bin/expect');
    } catch {
      return { available: false, reason: '/usr/bin/expect not found' };
    }
    return { available: true, command: 'kimi', expectCommand: '/usr/bin/expect' };
  }
  if (!await commandAvailable(host, host, run)) return { available: false, reason: `${host} CLI not found` };
  return { available: true, command: host };
}

function parseJson(stdout, label) {
  try {
    return JSON.parse(stdout);
  } catch {
    throw new Error(`${label} did not return JSON`);
  }
}

function foundationEnvelopeFromError(error) {
  return error?.foundationEnvelope ?? null;
}

function foundationStdoutFromError(error) {
  return error?.foundationStdout ?? null;
}

function isCodeBuddyResidualEnvelope(error) {
  const envelope = foundationEnvelopeFromError(error);
  const evidence = envelope?.evidence;
  const signals = evidence?.signalSequence;
  const signal = signals?.[0];
  return envelope?.ok === false
    && envelope.exitStatus === 124
    && envelope.processStatus === 'TERMINATED'
    && envelope.terminationReason === 'child_exit'
    && envelope.watchdogReason === 'residual_process_group'
    && evidence?.childExitCode === 0
    && (evidence.childSignal === null || evidence.childSignal === undefined)
    && evidence.residualGroupCleanupCompleted === true
    && evidence.forcedKill === false
    && evidence.outputLimitExceeded === null
    && Array.isArray(signals)
    && signals.length === 1
    && signal?.signal === 'SIGTERM'
    && signal.requestedMode === 'process_group'
    && signal.successfulMode === 'process_group';
}

function isCodeBuddyReadCommand(target, command, args) {
  return target.host === 'codebuddy'
    && (command === 'codebuddy' || command === 'cbc' || command === CODEBUDDY_MACOS_PATH)
    && Array.isArray(args)
    && (
      args.every((value, index) => value === CODEBUDDY_PLUGIN_LIST_ARGS[index])
      && args.length === CODEBUDDY_PLUGIN_LIST_ARGS.length
      || args.every((value, index) => value === CODEBUDDY_MARKETPLACE_LIST_ARGS[index])
      && args.length === CODEBUDDY_MARKETPLACE_LIST_ARGS.length
    );
}

function isCodeBuddyWriteCommand(target, command, args, kind) {
  if (target.host !== 'codebuddy' || !['codebuddy', 'cbc', CODEBUDDY_MACOS_PATH].includes(command)) return false;
  const expected = kind === 'marketplace-update'
    ? ['plugin', 'marketplace', 'update', target.marketplace]
    : ['plugin', 'update', `${target.plugin}@${target.marketplace}`, '--scope', 'user'];
  return Array.isArray(args) && args.length === expected.length && args.every((value, index) => value === expected[index]);
}

async function runCodeBuddyRead(target, command, args, label, env, run) {
  try {
    return { output: await run(command, [...args], { env }), recovered: false };
  } catch (error) {
    if (!isCodeBuddyReadCommand(target, command, args) || !isCodeBuddyResidualEnvelope(error)) throw error;
    const residualStdout = foundationStdoutFromError(error);
    if (typeof residualStdout !== 'string') throw error;
    parseJson(residualStdout, label);
    return {
      output: { stdout: residualStdout, stderr: '' },
      recovered: true,
    };
  }
}

function exactCodeBuddyMarketplaceObservation(target, stdout) {
  const parsed = parseJson(stdout, `${target.host} marketplace list`);
  if (!Array.isArray(parsed)) throw new Error(`${target.host} marketplace list did not return an array`);
  const matches = parsed.filter((entry) => entry?.name === target.marketplace);
  if (matches.length !== 1) {
    throw new Error(`${target.host} marketplace list did not contain exactly one ${target.marketplace}`);
  }
  if (matches[0].type !== 'git') {
    throw new Error(`${target.host} marketplace ${target.marketplace} is not a git marketplace`);
  }
  return { installed: true, exact: true, found: matches[0] };
}

async function observeCodeBuddyMarketplaceAfterResidual(target, command, env, run) {
  const observed = await runCodeBuddyRead(
    target,
    command,
    CODEBUDDY_MARKETPLACE_LIST_ARGS,
    `${target.host} marketplace list`,
    env,
    run,
  );
  return exactCodeBuddyMarketplaceObservation(target, observed.output.stdout);
}

function exactPluginObservation(target, stdout) {
  const selector = `${target.plugin}@${target.marketplace}`;
  const parsed = parseJson(stdout, `${target.host} plugin list`);
  if (target.host === 'claude' || target.host === 'codex') {
    const platform = getPlatform(target.host);
    const observed = platform.strategy.parseListOutput(parsed, selector);
    if (!observed.ok) {
      if (observed.error.includes('not found')) return { installed: false };
      throw new Error(observed.error);
    }
    const identity = platform.strategy.extractListIdentity(observed.found);
    if (
      identity.plugin !== target.plugin
      || identity.marketplace !== target.marketplace
      || identity.version !== target.version
    ) {
      return { installed: true, exact: false, found: observed.found };
    }
    if (platform.strategy.crossValidateListEntry) {
      const cross = platform.strategy.crossValidateListEntry(observed.found, target);
      if (!cross.ok) return { installed: true, exact: false, found: observed.found };
    }
    return {
      installed: true,
      exact: true,
      found: observed.found,
      ...(observed.installPath ? { installPath: observed.installPath } : {}),
    };
  }
  if (!Array.isArray(parsed)) throw new Error(`${target.host} plugin list did not return an array`);
  const matches = parsed.filter((entry) => entry?.id === selector);
  if (matches.length === 0) return { installed: false };
  if (matches.length !== 1) throw new Error(`${target.host} plugin list returned conflicting entries for ${selector}`);
  const [found] = matches;
  return {
    installed: true,
    exact: found.version === target.version && found.gitCommitSha === target.pluginCommit,
    found,
  };
}

function normalizeGitSource(source) {
  return String(source ?? '')
    .replace(/^git\+/, '')
    .replace(/^https:\/\/github\.com\//, '')
    .replace(/^git@github\.com:/, '')
    .replace(/\.git$/u, '')
    .replace(/\/$/u, '');
}

function normalizeHubGitSource(source, githubHost) {
  return String(source ?? '')
    .replace(/^git\+/, '')
    .replace(new RegExp(`^https://${String(githubHost).replaceAll('.', '\\.').replaceAll('-', '\\-')}/`), '')
    .replace(new RegExp(`^git@${String(githubHost).replaceAll('.', '\\.').replaceAll('-', '\\-')}:`), '')
    .replace(/\.git$/u, '')
    .replace(/\/$/u, '');
}

async function observeQoderMarketplace(target, command, env, run) {
  const listed = await run(command, [...QODER_MARKETPLACE_LIST_ARGS], {
    env,
    timeout: target.timeoutMs,
  });
  const parsed = parseJson(listed.stdout, 'qoder marketplace list');
  if (!Array.isArray(parsed)) throw new Error('qoder marketplace list did not return an array');
  const matches = parsed.filter((entry) => entry?.name === target.marketplace);
  if (matches.length === 0) return { installed: false };
  if (matches.length !== 1) {
    throw new Error(`qoder marketplace list returned conflicting entries for ${target.marketplace}`);
  }
  const [found] = matches;
  if (
    found.source?.source !== 'git'
    || normalizeHubGitSource(found.source.url, target.hub.githubHost) !== target.hub.repo
  ) {
    throw new Error(`qoder marketplace ${target.marketplace} does not point to ${target.hub.repo}`);
  }
  if (typeof found.installLocation !== 'string' || found.installLocation.length === 0) {
    throw new Error(`qoder marketplace ${target.marketplace} has no observable checkout root`);
  }
  const [remote, branch] = await Promise.all([
    run('git', ['-C', found.installLocation, 'remote', 'get-url', 'origin'], {
      env,
      timeout: 30_000,
    }),
    run('git', ['-C', found.installLocation, 'symbolic-ref', '-q', 'HEAD'], {
      env,
      timeout: 30_000,
    }),
  ]);
  if (
    normalizeHubGitSource(remote.stdout.trim(), target.hub.githubHost) !== target.hub.repo
    || branch.stdout.trim() !== target.hub.ref
  ) {
    throw new Error(`qoder marketplace ${target.marketplace} checkout does not match the frozen Hub source`);
  }
  return { installed: true, root: found.installLocation, found };
}

async function observeQoderPlugin(target, command, env, run) {
  const listed = await run(command, [...QODER_PLUGIN_LIST_ARGS], {
    env,
    timeout: target.timeoutMs,
  });
  const parsed = parseJson(listed.stdout, 'qoder plugin list');
  if (!Array.isArray(parsed)) throw new Error('qoder plugin list did not return an array');
  const selector = `${target.plugin}@${target.marketplace}`;
  const matches = parsed.filter((entry) => entry?.id === selector);
  if (matches.length === 0) return { installed: false };
  if (matches.length !== 1) {
    throw new Error(`qoder plugin list returned conflicting entries for ${selector}`);
  }
  const [found] = matches;
  if (
    found.name !== target.plugin
    || found.source !== selector
    || found.scope !== 'user'
    || typeof found.installPath !== 'string'
    || found.installPath.length === 0
  ) {
    throw new Error(`qoder plugin ${selector} does not match its frozen user-scope identity`);
  }
  return {
    installed: true,
    exact: found.version === target.version,
    installPath: found.installPath,
    found,
  };
}

async function readQoderManifest(root, label) {
  const manifest = parseJson(
    await readFileContained(root, '.qoder-plugin/plugin.json', { encoding: 'utf8' }),
    label,
  );
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new Error(`${label} did not return an object`);
  }
  return manifest;
}

function assertQoderPluginManifest(target, manifest, label) {
  if (
    manifest.name !== target.plugin
    || manifest.version !== target.version
    || manifest.skills !== './adapters/qoder/skills/'
  ) {
    throw new Error(`${label} does not match the frozen Qoder plugin identity and projection path`);
  }
}

async function assertFrozenQoderManifest(target, root) {
  const { snapshotDir: snapshotRoot } = await verifyFrozenSnapshot({
    root,
    snapshotPath: target.snapshotPath,
    expectedDigest: target.manifestDigest,
  });
  const manifest = await readQoderManifest(snapshotRoot, 'frozen Qoder plugin manifest');
  assertQoderPluginManifest(target, manifest, 'frozen Qoder plugin manifest');
}

async function assertQoderHubEntry(target, marketplaceRoot) {
  const marketplace = parseJson(
    await readFileContained(marketplaceRoot, 'marketplace.json', { encoding: 'utf8' }),
    'Qoder Hub marketplace manifest',
  );
  if (marketplace?.name !== target.marketplace || !Array.isArray(marketplace.plugins)) {
    throw new Error('Qoder Hub marketplace manifest does not match the frozen marketplace');
  }
  const matches = marketplace.plugins.filter((entry) => entry?.name === target.plugin);
  if (matches.length !== 1) {
    throw new Error(`Qoder Hub marketplace manifest must contain exactly one ${target.plugin} entry`);
  }
  const source = matches[0]?.source;
  if (
    source?.source !== 'url'
    || normalizeHubGitSource(source.url, target.hub.githubHost) !== target.pluginRepo
    || source.sha !== target.pluginCommit
  ) {
    throw new Error('Qoder Hub entry does not match the frozen public source identity');
  }
}

async function verifyQoderInstalledPayload({
  target,
  root,
  installPath,
  verifyInstalledPayload,
}) {
  const manifest = await readQoderManifest(installPath, 'installed Qoder plugin manifest');
  assertQoderPluginManifest(target, manifest, 'installed Qoder plugin manifest');
  await verifyInstalledPayload({
    snapshotPath: target.snapshotPath,
    manifestDigest: target.manifestDigest,
    payloadContract: QODER_PAYLOAD_CONTRACT,
    marketplaceLocation: 'external',
  }, { root }, installPath, 'qoder');
}

async function runQoderUpdate(target, detected, run, {
  root,
  verifyInstalledPayload,
}) {
  const env = hostEnvironment('qoder');
  await assertFrozenQoderManifest(target, root);
  const marketplace = await observeQoderMarketplace(target, detected.command, env, run);
  if (!marketplace.installed) {
    return {
      status: 'MANUAL_REQUIRED',
      reason: `qoder marketplace ${target.marketplace} is not installed; no marketplace was added`,
    };
  }
  const before = await observeQoderPlugin(target, detected.command, env, run);
  if (!before.installed) {
    return {
      status: 'MANUAL_REQUIRED',
      reason: 'qoder target plugin is not installed; no initial installation was performed',
    };
  }
  if (before.exact) {
    await assertQoderHubEntry(target, marketplace.root);
    await verifyQoderInstalledPayload({
      target,
      root,
      installPath: before.installPath,
      verifyInstalledPayload,
    });
    return { status: 'ALREADY_CURRENT', version: target.version };
  }

  await run(detected.command, ['plugins', 'marketplace', 'update', target.marketplace], {
    env,
    timeout: target.timeoutMs,
  });
  const refreshed = await observeQoderMarketplace(target, detected.command, env, run);
  if (!refreshed.installed) {
    throw new Error(`qoder marketplace ${target.marketplace} disappeared after refresh`);
  }
  await assertQoderHubEntry(target, refreshed.root);
  await run(detected.command, [
    'plugins', 'update', `${target.plugin}@${target.marketplace}`, '--scope', 'user',
  ], { env, timeout: target.timeoutMs });
  const after = await observeQoderPlugin(target, detected.command, env, run);
  if (!after.exact) throw new Error('qoder did not update to the frozen plugin version');
  await verifyQoderInstalledPayload({
    target,
    root,
    installPath: after.installPath,
    verifyInstalledPayload,
  });
  return {
    status: 'UPDATED',
    version: target.version,
    restartRequired: true,
    reloadInstruction: 'Start a new Qoder session or run /plugins reload before checking the loaded version.',
  };
}

function parseFrozenRemoteRef(target, stdout) {
  const directRefs = new Map();
  const peeledRefs = new Map();
  const expected = target.marketplaceRef;
  const allowedDirect = expected.startsWith('refs/')
    ? new Set([expected])
    : new Set([`refs/heads/${expected}`, `refs/tags/${expected}`]);
  for (const line of String(stdout ?? '').split(/\r?\n/u)) {
    if (line.length === 0) continue;
    const match = /^([a-f0-9]{40})\t([^\s]+)$/u.exec(line);
    if (!match) throw new Error('git ls-remote returned an invalid line');
    const [, commit, remoteRef] = match;
    const peeled = remoteRef.endsWith('^{}');
    const direct = peeled ? remoteRef.slice(0, -3) : remoteRef;
    if (!allowedDirect.has(direct)) {
      throw new Error(`git ls-remote returned an unexpected ref ${remoteRef}`);
    }
    const destination = peeled ? peeledRefs : directRefs;
    const previous = destination.get(direct);
    if (previous && previous !== commit) {
      throw new Error(`git ls-remote returned conflicting values for ${remoteRef}`);
    }
    destination.set(direct, commit);
  }
  const resolved = [...allowedDirect]
    .filter((remoteRef) => directRefs.has(remoteRef) || peeledRefs.has(remoteRef))
    .map((remoteRef) => peeledRefs.get(remoteRef) ?? directRefs.get(remoteRef));
  return {
    found: resolved.length > 0,
    exact: resolved.length > 0 && resolved.every((commit) => commit === target.marketplaceCommit),
  };
}

async function preflightStructuredMarketplace(target, env, run) {
  try {
    const observed = await run('git', [
      'ls-remote', '--exit-code', `https://${target.githubHost}/${target.marketplaceRepo}.git`,
      target.marketplaceRef, `${target.marketplaceRef}^{}`,
    ], { env, timeout: 30_000 });
    const remote = parseFrozenRemoteRef(target, observed.stdout);
    if (!remote.found) {
      return {
        ok: false,
        reason: `${target.host} frozen marketplace ref ${target.marketplaceRef} is missing`,
      };
    }
    if (!remote.exact) {
      return {
        ok: false,
        reason: `${target.host} frozen marketplace ref ${target.marketplaceRef} does not resolve to ${target.marketplaceCommit}`,
      };
    }
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      reason: `${target.host} could not prove the frozen marketplace ref: ${error?.message ?? String(error)}`,
    };
  }
}

async function observeMarketplace(target, command, env, run) {
  const listed = await run(command, ['plugin', 'marketplace', 'list', '--json'], { env });
  const parsed = parseJson(listed.stdout, `${target.host} marketplace list`);
  const entries = target.host === 'claude' ? parsed : parsed?.marketplaces;
  if (!Array.isArray(entries)) throw new Error(`${target.host} marketplace list has an invalid shape`);
  const matches = entries.filter((entry) => entry?.name === target.marketplace);
  if (target.targetKind === 'hub-backed' && matches.length > 1) {
    throw new Error(`${target.host} marketplace list returned conflicting entries for ${target.marketplace}`);
  }
  const found = matches[0];
  if (!found) return { installed: false };
  const source = target.host === 'claude' ? found.repo : found.marketplaceSource?.source;
  const observedSource = target.targetKind === 'hub-backed'
    ? normalizeHubGitSource(source, target.hub.githubHost) : normalizeGitSource(source);
  if (observedSource !== normalizeGitSource(target.marketplaceRepo)) {
    throw new Error(`${target.host} marketplace ${target.marketplace} does not point to ${target.marketplaceRepo}`);
  }
  const root = target.host === 'claude' ? found.installLocation : found.root;
  if (typeof root !== 'string' || root.length === 0) {
    throw new Error(`${target.host} marketplace ${target.marketplace} has no observable checkout root`);
  }
  const head = await run('git', ['-C', root, 'rev-parse', 'HEAD'], { env, timeout: 30_000 });
  return { installed: true, exact: head.stdout.trim() === target.marketplaceCommit, root, found };
}

async function observeStructuredTarget(target, command, env, run) {
  const listed = await run(command, getPlatform(target.host).cli.list(), { env });
  const plugin = exactPluginObservation(target, listed.stdout);
  const marketplace = await observeMarketplace(target, command, env, run);
  if (plugin.installed && !marketplace.installed) {
    throw new Error(`${target.host} reports the plugin but not its frozen marketplace`);
  }
  return { plugin, marketplace, exact: plugin.exact === true && marketplace.exact === true };
}

async function bindStructuredMarketplace(target, command, env, run, observed) {
  if (observed.marketplace.installed && observed.marketplace.exact) return false;
  if (observed.marketplace.installed) {
    await run(command, [
      'plugin', 'marketplace', 'remove', target.marketplace,
      ...(target.host === 'codex' ? ['--json'] : []),
    ], { env });
  }
  const platform = getPlatform(target.host);
  const frozenRef = target.host === 'codex' ? target.marketplaceCommit : target.marketplaceRef;
  await run(command, platform.cli.marketplaceAdd(target.marketplaceRepo, frozenRef), { env });
  const rebound = await observeMarketplace(target, command, env, run);
  if (!rebound.installed || !rebound.exact) {
    throw new Error(`${target.host} marketplace did not bind to frozen commit ${target.marketplaceCommit}`);
  }
  return true;
}

function actionParametersForTarget(plan, target) {
  if (target.targetKind === 'hub-backed') {
    return {
      snapshotPath: target.snapshotPath,
      manifestDigest: target.manifestDigest,
      payloadContract: 'external-marketplace-v1',
      marketplaceLocation: 'external',
    };
  }
  const action = (plan.externalActions ?? []).find((candidate) => candidate.id === target.actionId);
  if (!action || action.type !== target.actionType || action.unitId !== target.unitId) {
    throw new Error(`local host update target ${target.actionId} has no matching frozen action`);
  }
  return action.parameters;
}

async function verifyStructuredInstalledPayload({
  plan,
  root,
  target,
  installPath,
  verifyInstalledPayload,
}) {
  if (typeof installPath !== 'string' || installPath.length === 0) {
    throw new Error(`${target.host} did not provide an authoritative installed plugin root`);
  }
  await verifyInstalledPayload(
    actionParametersForTarget(plan, target),
    { root },
    installPath,
    target.host,
  );
}

async function assertHubHostEntry(target, marketplaceRoot) {
  const codex = target.host === 'codex';
  const indexPath = codex ? '.agents/plugins/marketplace.json'
    : target.host === 'claude' ? '.claude-plugin/marketplace.json' : '.codebuddy-plugin/marketplace.json';
  const index = parseJson(await readFileContained(marketplaceRoot, indexPath, { encoding: 'utf8' }), `${target.host} Hub index`);
  const matches = index?.plugins?.filter((entry) => entry?.name === target.plugin);
  if (index?.name !== target.marketplace || !Array.isArray(matches) || matches.length !== 1) {
    throw new Error(`${target.host} Hub index must contain exactly one frozen plugin entry`);
  }
  const entry = matches[0];
  const source = entry.source;
  const repo = codex ? normalizeHubGitSource(source?.url, target.githubHost) : source?.repo;
  if (source?.source !== (codex ? 'url' : 'github') || repo !== target.pluginRepo
    || source?.sha !== target.pluginCommit
    || source?.ref !== (codex ? `refs/tags/${target.pluginTag}` : target.pluginTag)
    || (!codex && entry.version !== target.version)
    || (entry.version !== undefined && entry.version !== target.version)) {
    throw new Error(`${target.host} Hub entry does not match the frozen repository, tag, commit and version`);
  }
}

async function observeHubCheckout(target, checkout, env, run) {
  const remote = await run('git', ['-C', checkout, 'remote', 'get-url', 'origin'], { env, timeout: 30_000 });
  if (normalizeHubGitSource(remote.stdout.trim(), target.hub.githubHost) !== target.hub.repo) {
    throw new Error(`${target.host} marketplace checkout does not match the declared Hub repository`);
  }
  if (target.host !== 'codex') {
    const branch = await run('git', ['-C', checkout, 'symbolic-ref', 'HEAD'], { env, timeout: 30_000 });
    if (branch.stdout.trim() !== target.hub.ref) throw new Error(`${target.host} marketplace checkout does not match the declared Hub branch`);
  }
  const head = await run('git', ['-C', checkout, 'rev-parse', 'HEAD'], { env, timeout: 30_000 });
  const commit = head.stdout.trim();
  if (!/^[a-f0-9]{40}$/u.test(commit)) throw new Error(`${target.host} Hub checkout has no exact commit`);
  return commit;
}

async function observeHubMarketplace(target, command, env, run) {
  if (target.host === 'claude' || target.host === 'codex') {
    const observed = await observeMarketplace(target, command, env, run);
    if (!observed.installed) return observed;
    return { ...observed, commit: await observeHubCheckout(target, observed.root, env, run) };
  }
  const listed = target.host === 'codebuddy'
    ? (await runCodeBuddyRead(target, command, CODEBUDDY_MARKETPLACE_LIST_ARGS, 'codebuddy marketplace list', env, run)).output
    : await run(command, [...CODEBUDDY_MARKETPLACE_LIST_ARGS], { env });
  const entries = parseJson(listed.stdout, `${target.host} marketplace list`);
  if (!Array.isArray(entries)) throw new Error(`${target.host} marketplace list did not return an array`);
  if (!entries.some((entry) => entry?.name === target.marketplace)) return { installed: false };
  exactCodeBuddyMarketplaceObservation(target, listed.stdout);
  const root = await resolveContained(env.CODEBUDDY_CONFIG_DIR, `plugins/marketplaces/${target.marketplace}`);
  return { installed: true, root, commit: await observeHubCheckout(target, root, env, run) };
}

async function runHubStructuredUpdate(target, detected, run, { plan, root, verifyInstalledPayload }) {
  const env = hostEnvironment(target.host);
  const codeBuddy = target.host === 'codebuddy' || target.host === 'workbuddy';
  const readPlugin = async () => {
    const output = target.host === 'codebuddy'
      ? (await runCodeBuddyRead(target, detected.command, CODEBUDDY_PLUGIN_LIST_ARGS, 'codebuddy plugin list', env, run)).output
      : await run(detected.command, ['plugin', 'list', '--json'], { env });
    const listed = parseJson(output.stdout, `${target.host} plugin list`);
    const entries = target.host === 'codex' ? listed?.installed : listed;
    if (Array.isArray(entries) && entries.filter((entry) => (
      (target.host === 'codex' ? entry?.pluginId : entry?.id) === `${target.plugin}@${target.marketplace}`
    )).length > 1) throw new Error(`${target.host} plugin list returned conflicting entries`);
    const observed = exactPluginObservation(target, output.stdout);
    if (observed.installed) {
      if (codeBuddy && observed.exact) {
        observed.installPath = await resolveContained(env.CODEBUDDY_CONFIG_DIR, `plugins/cache/${target.marketplace}/${target.plugin}/${target.version}`);
      } else if (target.host === 'codex') {
        observed.installPath = observed.found.installedPath;
        const source = observed.found.source;
        if (source?.source !== 'git' || normalizeHubGitSource(source.url, target.githubHost) !== target.pluginRepo) {
          throw new Error('codex installed plugin does not point to the frozen public repository');
        }
        if (source.sha !== target.pluginCommit || source.ref !== `refs/tags/${target.pluginTag}`) observed.exact = false;
      }
      if (observed.found.gitCommitSha !== undefined && observed.found.gitCommitSha !== target.pluginCommit) observed.exact = false;
    }
    return observed;
  };
  const beforeMarket = await observeHubMarketplace(target, detected.command, env, run);
  if (!beforeMarket.installed) return { status: 'MANUAL_REQUIRED', reason: `${target.host} declared Hub marketplace is not installed; no marketplace was added` };
  const before = await readPlugin();
  if (before.exact && before.installPath) {
    await assertHubHostEntry(target, beforeMarket.root);
    await verifyStructuredInstalledPayload({ plan, root, target, installPath: before.installPath, verifyInstalledPayload });
    return { status: 'ALREADY_CURRENT', version: target.version };
  }
  if (codeBuddy && !before.installed) return { status: 'MANUAL_REQUIRED', reason: `${target.host} target plugin is not installed; no initial installation was performed` };

  // The observed Hub commit belongs to a different repository than pluginCommit.
  // Keep it local to this attempt; the frozen plan continues to bind plugin identity.
  const hubCommit = await withTemporaryWorkspace(async (workspace) => {
    const checkout = join(workspace.root, 'hub');
    await run('git', ['clone', '--depth', '1', '--branch', target.hub.ref.slice('refs/heads/'.length), '--single-branch',
      `https://${target.hub.githubHost}/${target.hub.repo}.git`, checkout], { env, timeout: target.timeoutMs });
    const commit = await observeHubCheckout(target, checkout, env, run);
    await assertHubHostEntry(target, checkout);
    return commit;
  }, { prefix: 'release-skill-hub-update-' });
  if (target.host === 'codex') {
    await bindStructuredMarketplace({ ...target, marketplaceCommit: hubCommit }, detected.command, env, run,
      { marketplace: { ...beforeMarket, exact: beforeMarket.commit === hubCommit } });
  } else {
    try {
      await run(detected.command, ['plugin', 'marketplace', 'update', target.marketplace], { env, timeout: target.timeoutMs });
    } catch (error) {
      if (!isCodeBuddyWriteCommand(target, detected.command, ['plugin', 'marketplace', 'update', target.marketplace], 'marketplace-update')
        || !isCodeBuddyResidualEnvelope(error)) throw error;
    }
  }
  const refreshed = await observeHubMarketplace(target, detected.command, env, run);
  if (!refreshed.installed || refreshed.commit !== hubCommit) throw new Error(`${target.host} Hub branch moved during marketplace refresh`);
  await assertHubHostEntry(target, refreshed.root);
  if (codeBuddy) {
    const remote = await run('git', ['ls-remote', '--exit-code', `https://${target.hub.githubHost}/${target.hub.repo}.git`, target.hub.ref], { env, timeout: 30_000 });
    if (!parseFrozenRemoteRef({ ...target, marketplaceCommit: hubCommit }, remote.stdout).exact) {
      throw new Error(`${target.host} Hub branch moved before plugin update`);
    }
  }
  const current = await readPlugin();
  const selector = `${target.plugin}@${target.marketplace}`;
  let installPath;
  if (target.host === 'codex') {
    if (current.installed) await run(detected.command, ['plugin', 'remove', selector, '--json'], { env });
    const installed = await run(detected.command, getPlatform('codex').cli.install(target.plugin, target.marketplace), { env, timeout: target.timeoutMs });
    const extracted = getPlatform('codex').strategy.extractInstallPath({ execEvidence: { installOutput: parseJson(installed.stdout, 'codex plugin install') } });
    if (!extracted.ok) throw new Error(extracted.error);
    installPath = extracted.installPath;
  } else {
    const args = codeBuddy || current.installed
      ? ['plugin', 'update', selector, '--scope', 'user', ...(target.host === 'claude' ? ['--yes'] : [])]
      : getPlatform('claude').cli.install(target.plugin, target.marketplace);
    try {
      await run(detected.command, args, { env, timeout: target.timeoutMs });
    } catch (error) {
      if (!isCodeBuddyWriteCommand(target, detected.command, args, 'plugin-update') || !isCodeBuddyResidualEnvelope(error)) throw error;
    }
  }
  const after = await readPlugin();
  if (!after.exact) throw new Error(`${target.host} did not install the frozen plugin identity`);
  const finalMarket = await observeHubMarketplace(target, detected.command, env, run);
  if (!finalMarket.installed || finalMarket.commit !== hubCommit) throw new Error(`${target.host} Hub checkout changed during plugin update`);
  await assertHubHostEntry(target, finalMarket.root);
  await verifyStructuredInstalledPayload({ plan, root, target, installPath: installPath ?? after.installPath, verifyInstalledPayload });
  return { status: 'UPDATED', version: target.version, restartRequired: true };
}

async function runStructuredUpdate(target, detected, run, {
  plan,
  root,
  verifyInstalledPayload,
}) {
  if (target.targetKind === 'hub-backed') return runHubStructuredUpdate(target, detected, run, { plan, root, verifyInstalledPayload });
  if (target.host === 'codebuddy' || target.host === 'workbuddy') {
    const env = hostEnvironment(target.host);
    const listedObservation = target.host === 'codebuddy'
      ? await runCodeBuddyRead(target, detected.command, CODEBUDDY_PLUGIN_LIST_ARGS, `${target.host} plugin list`, env, run)
      : { output: await run(detected.command, [...CODEBUDDY_PLUGIN_LIST_ARGS], { env }), recovered: false };
    const listed = listedObservation.output;
    const observed = exactPluginObservation(target, listed.stdout);
    if (
      target.sourceForm !== 'bundled-family'
      || target.pluginRepo !== target.marketplaceRepo
      || target.pluginCommit !== target.marketplaceCommit
    ) {
      return {
        status: 'MANUAL_REQUIRED',
        reason: `${target.host} source identity is not eligible for a frozen bundled-family update`,
      };
    }
    if (observed.exact) {
      return {
        status: 'ALREADY_CURRENT',
        version: target.version,
        ...(listedObservation.recovered ? { residualRecovery: true } : {}),
      };
    }
    if (!observed.installed) {
      return {
        status: 'MANUAL_REQUIRED',
        reason: `${target.host} target plugin is not installed; no initial installation was performed`,
      };
    }
    let remote;
    try {
      const remoteObservation = await run('git', [
        'ls-remote', '--exit-code', `https://${target.githubHost}/${target.pluginRepo}.git`,
        target.pluginTag, `${target.pluginTag}^{}`, target.marketplaceRef,
      ], { env, timeout: 30_000 });
      remote = parseCodeBuddyRemoteObservation(target, remoteObservation.stdout);
    } catch (error) {
      return {
        status: 'MANUAL_REQUIRED',
        reason: `${target.host} could not prove the frozen remote refs: ${error?.message ?? String(error)}`,
      };
    }
    if (!remote.exact) {
      return {
        status: 'MANUAL_REQUIRED',
        reason: `${target.host} frozen tag and mutable ref do not both resolve to ${target.pluginCommit}`,
      };
    }
    let marketplaceRecovered = false;
    try {
      await run(detected.command, ['plugin', 'marketplace', 'update', target.marketplace], { env });
    } catch (error) {
      if (!isCodeBuddyWriteCommand(target, detected.command, ['plugin', 'marketplace', 'update', target.marketplace], 'marketplace-update')
        || !isCodeBuddyResidualEnvelope(error)) throw error;
      await observeCodeBuddyMarketplaceAfterResidual(target, detected.command, env, run);
      marketplaceRecovered = true;
    }
    let after;
    let pluginRecovered = false;
    try {
      await run(detected.command, [
        'plugin', 'update', `${target.plugin}@${target.marketplace}`, '--scope', 'user',
      ], { env });
    } catch (error) {
      if (!isCodeBuddyWriteCommand(target, detected.command, [
        'plugin', 'update', `${target.plugin}@${target.marketplace}`, '--scope', 'user',
      ], 'plugin-update') || !isCodeBuddyResidualEnvelope(error)) throw error;
      const afterList = await runCodeBuddyRead(
        target,
        detected.command,
        CODEBUDDY_PLUGIN_LIST_ARGS,
        `${target.host} plugin list`,
        env,
        run,
      );
      after = exactPluginObservation(target, afterList.output.stdout);
      pluginRecovered = true;
    }
    if (!pluginRecovered) {
      const afterList = target.host === 'codebuddy'
        ? await runCodeBuddyRead(target, detected.command, CODEBUDDY_PLUGIN_LIST_ARGS, `${target.host} plugin list`, env, run)
        : { output: await run(detected.command, [...CODEBUDDY_PLUGIN_LIST_ARGS], { env }), recovered: false };
      after = exactPluginObservation(target, afterList.output.stdout);
    }
    if (!after.exact) throw new Error(`${target.host} did not update to the frozen plugin identity`);
    return {
      status: 'UPDATED',
      version: target.version,
      restartRequired: true,
      ...(marketplaceRecovered || listedObservation.recovered || pluginRecovered
        ? { residualRecovery: true }
        : {}),
    };
  }

  const command = detected.command;
  const env = hostEnvironment(target.host);
  const before = await observeStructuredTarget(target, command, env, run);
  if (before.exact && before.plugin.installPath) {
    await verifyStructuredInstalledPayload({
      plan,
      root,
      target,
      installPath: before.plugin.installPath,
      verifyInstalledPayload,
    });
    return { status: 'ALREADY_CURRENT', version: target.version };
  }

  if (!before.marketplace.exact) {
    const preflight = await preflightStructuredMarketplace(target, env, run);
    if (!preflight.ok) return { status: 'MANUAL_REQUIRED', reason: preflight.reason };
  }

  const marketplaceRebound = await bindStructuredMarketplace(target, command, env, run, before);
  const current = target.host === 'claude' && marketplaceRebound
    ? await observeStructuredTarget(target, command, env, run)
    : before;
  const platform = getPlatform(target.host);
  const selector = `${target.plugin}@${target.marketplace}`;
  let installPath;
  if (target.host === 'claude') {
    const installArgs = current.plugin.installed
      ? ['plugin', 'update', selector, '--scope', 'user', '--yes']
      : platform.cli.install(target.plugin, target.marketplace);
    await run(command, installArgs, { env });
  } else {
    if (before.plugin.installed) {
      await run(command, ['plugin', 'remove', selector, '--json'], { env });
    }
    const installed = await run(command, platform.cli.install(target.plugin, target.marketplace), { env });
    const installOutput = parseJson(installed.stdout, `${target.host} plugin install`);
    const extracted = platform.strategy.extractInstallPath({ execEvidence: { installOutput } });
    if (!extracted.ok) throw new Error(extracted.error);
    installPath = extracted.installPath;
  }

  const after = await observeStructuredTarget(target, command, env, run);
  if (!after.exact) throw new Error(`${target.host} did not install the frozen plugin identity`);
  await verifyStructuredInstalledPayload({
    plan,
    root,
    target,
    installPath: installPath ?? after.plugin.installPath,
    verifyInstalledPayload,
  });
  return { status: 'UPDATED', version: target.version, restartRequired: true };
}

function parseCodeBuddyRemoteObservation(target, stdout) {
  const refs = new Map();
  const tagRef = target.pluginTag.startsWith('refs/')
    ? target.pluginTag
    : `refs/tags/${target.pluginTag}`;
  const allowedRefs = new Set([tagRef, `${tagRef}^{}`, target.marketplaceRef]);
  for (const line of String(stdout ?? '').split(/\r?\n/u)) {
    if (line.length === 0) continue;
    const match = /^([a-f0-9]{40})\t([^\s]+)$/u.exec(line);
    if (!match) throw new Error('git ls-remote returned an invalid line');
    const [, commit, ref] = match;
    if (!allowedRefs.has(ref)) throw new Error(`git ls-remote returned an unexpected ref ${ref}`);
    const existing = refs.get(ref);
    if (existing && existing !== commit) throw new Error(`git ls-remote returned conflicting values for ${ref}`);
    refs.set(ref, commit);
  }
  const peeledTag = refs.get(`${tagRef}^{}`);
  const tagCommit = peeledTag ?? refs.get(tagRef);
  const mutableCommit = refs.get(target.marketplaceRef);
  return {
    exact: tagCommit === target.pluginCommit && mutableCommit === target.pluginCommit,
    tagCommit: tagCommit ?? null,
    mutableCommit: mutableCommit ?? null,
  };
}

function kimiExpectProgram({ removePlugin } = {}) {
  const removeCommand = removePlugin
    ? `submitCommand "/plugins remove $removePlugin"
expect {
  -nocase -re {(remove|delete|uninstall).*(confirm|sure)|(confirm|sure).*(remove|delete|uninstall)} {
    expect {
      -ex $removePlugin {
        send -- "\\033\\[B"
        send -- "\\033\\[13u"
      }
      timeout { failTimeout remove-confirmation 125 127 }
      eof { failEof remove-confirmation 126 }
    }
    expect {
      -nocase -re {Trust this folder\\?} { unexpectedDirectoryTrust }
      -re $promptPattern {}
      timeout { failTimeout remove-prompt 128 130 }
      eof { failEof remove-prompt 129 }
    }
  }
  -re $promptPattern {}
  -nocase -re {Trust this folder\\?} { unexpectedDirectoryTrust }
  timeout { failTimeout remove-dialog 122 124 }
  eof { failEof remove-dialog 123 }
}
`
    : '';
  return `set timeout 240
foreach variable {RELEASE_SKILL_KIMI_COMMAND RELEASE_SKILL_KIMI_INSTALL_URL RELEASE_SKILL_KIMI_REMOVE_PLUGIN RELEASE_SKILL_KIMI_EXPECTED_REPO RELEASE_SKILL_KIMI_EXPECTED_TAG} {
  if {![info exists env($variable)]} { exit 90 }
}
set kimiCommand $env(RELEASE_SKILL_KIMI_COMMAND)
set installUrl $env(RELEASE_SKILL_KIMI_INSTALL_URL)
set removePlugin $env(RELEASE_SKILL_KIMI_REMOVE_PLUGIN)
set expectedRepo $env(RELEASE_SKILL_KIMI_EXPECTED_REPO)
set expectedTag $env(RELEASE_SKILL_KIMI_EXPECTED_TAG)
set promptPattern {(?:(?:^|\\r|\\n)> (?:\\r*\\n|$)|(?:^|\\r|\\n)(?:(?:\\033\\[[0-9;?]*[ -/]*[@-~])|\\033\\][^\\x07]*\\x07|[ \\t])*│[^\\r\\n]*>[^\\r\\n]*│(?:(?:\\033\\[[0-9;?]*[ -/]*[@-~])|\\033\\][^\\x07]*\\x07|[ \\t])*(?:\\r*\\n|$))}

proc cleanScreen {value} {
  regsub -all {\\033\\[[0-9;?]*[ -/]*[@-~]} $value {} value
  regsub -all {\\033\\][^\\x07]*\\x07} $value {} value
  regsub -all {\\r} $value {} value
  return $value
}

proc compactScreen {value} {
  set value [cleanScreen $value]
  regsub -all {[[:space:]]+} $value {} value
  return $value
}

proc extractPluginTrustDialog {value} {
  set cleaned [cleanScreen $value]
  set lowered [string tolower $cleaned]
  set dialogStart -1
  foreach marker {"install third-party plugin " "trust and install from "} {
    set markerStart [string last $marker $lowered]
    if {$markerStart > $dialogStart} { set dialogStart $markerStart }
  }
  if {$dialogStart < 0} { return "" }
  return [string range $cleaned $dialogStart end]
}

proc extractPluginTrustIdentity {value} {
  set cleaned [cleanScreen $value]
  set lowered [string tolower $cleaned]
  set identityStart -1
  foreach marker {"install third-party plugin " "trust and install from "} {
    set markerStart [string last $marker $lowered]
    if {$markerStart >= 0 && $markerStart + [string length $marker] > $identityStart} {
      set identityStart [expr {$markerStart + [string length $marker]}]
    }
  }
  if {$identityStart < 0} { return "" }
  set identityEnd [string first "?" $cleaned $identityStart]
  if {$identityEnd < 0} { return "" }
  return [string range $cleaned $identityStart [expr {$identityEnd - 1}]]
}

proc failTimeout {state timeoutCode unknownCode} {
  global expect_out
  set buffer ""
  if {[info exists expect_out(buffer)]} { set buffer [string trim [cleanScreen $expect_out(buffer)]] }
  if {$buffer ne ""} {
    puts stderr "KIMI_TUI_STATE:$state:unknown"
    exit $unknownCode
  }
  puts stderr "KIMI_TUI_STATE:$state:timeout"
  exit $timeoutCode
}

proc failEof {state code} {
  puts stderr "KIMI_TUI_STATE:$state:eof"
  exit $code
}

proc unexpectedDirectoryTrust {} {
  puts stderr "KIMI_TUI_STATE:directory-trust:unexpected"
  exit 147
}

proc readDirectoryTrustDialog {prefix state timeoutCode unknownCode eofCode} {
  global expect_out
  set dialogBuffer $prefix
  set cleanedPrefix [cleanScreen $dialogBuffer]
  if {![regexp -nocase {Trust this folder\\?} $cleanedPrefix]} {
    expect {
      -nocase -re {Trust this folder\\?} {
        append dialogBuffer $expect_out(buffer)
      }
      timeout { failTimeout $state $timeoutCode $unknownCode }
      eof { failEof $state $eofCode }
    }
    set cleanedPrefix [cleanScreen $dialogBuffer]
  }
  set framed [regexp -nocase {(^|\\n)[ \\t]*─{8,}[ \\t]*\\n[ \\t]*Trust this folder\\?} $cleanedPrefix]
  if {$framed} {
    expect {
      -re {(^|\\r|\\n)[ \\t]*─{8,}[ \\t]*\\r*\\n} {
        append dialogBuffer $expect_out(buffer)
      }
      timeout { failTimeout $state $timeoutCode $unknownCode }
      eof { failEof $state $eofCode }
    }
  } else {
    expect {
      -nocase -re {↑↓[^\\r\\n]*navigate[^\\r\\n]*(?:Esc[^\\r\\n]*)?\\r*\\n} {
        append dialogBuffer $expect_out(buffer)
      }
      timeout { failTimeout $state $timeoutCode $unknownCode }
      eof { failEof $state $eofCode }
    }
  }
  return [cleanScreen $dialogBuffer]
}

proc directoryTrustAction {dialog state unknownCode} {
  set inDialog 0
  set labels {}
  set selectedCount 0
  set selectedIndex -1
  set selectedLabel ""
  set trustCount 0
  set trustIndex -1
  foreach rawLine [split $dialog "\\n"] {
    set line [string trim $rawLine]
    if {[regexp -nocase {^Trust this folder\\?$} $line]} {
      set inDialog 1
      continue
    }
    if {!$inDialog} { continue }
    if {$line eq ""} { continue }
    set selected [regexp {^❯[ \\t]*} $line]
    if {$selected} {
      regsub {^❯[ \\t]*} $line {} label
      set label [string trim $label]
    } else {
      set label $line
    }
    set knownAction [expr {
      [string equal -nocase $label "Trust this folder"]
      || [string equal -nocase $label "No, exit"]
      || [string equal -nocase $label "Don't trust"]
    }]
    if {!$knownAction && $selected} {
      puts stderr "KIMI_TUI_STATE:$state:selection-unknown"
      exit $unknownCode
    }
    if {!$knownAction} { continue }
    set index [llength $labels]
    lappend labels $label
    if {[string equal -nocase $label "Trust this folder"]} {
      incr trustCount
      set trustIndex $index
    }
    if {$selected} {
      incr selectedCount
      set selectedIndex $index
      set selectedLabel $label
    }
  }
  if {[llength $labels] != 2 || $trustCount != 1 || $selectedCount != 1} {
    puts stderr "KIMI_TUI_STATE:$state:selection-unknown"
    exit $unknownCode
  }
  if {[string equal -nocase $selectedLabel "Trust this folder"]} {
    return selected-trust
  }
  if {![string equal -nocase $selectedLabel "No, exit"]
      && ![string equal -nocase $selectedLabel "Don't trust"]} {
    puts stderr "KIMI_TUI_STATE:$state:selection-unknown"
    exit $unknownCode
  }
  if {$selectedIndex + 1 == $trustIndex} { return move-down }
  if {$selectedIndex - 1 == $trustIndex} { return move-up }
  puts stderr "KIMI_TUI_STATE:$state:selection-unknown"
  exit $unknownCode
}

proc confirmInitialDirectoryTrust {} {
  global expect_out promptPattern
  set dialog [readDirectoryTrustDialog $expect_out(buffer) directory-trust-selected-row 140 143 141]
  set action [directoryTrustAction $dialog directory-trust 143]
  if {$action eq "move-down"} {
    send -- "\\033\\[B"
  } elseif {$action eq "move-up"} {
    send -- "\\033\\[A"
  }
  if {$action ne "selected-trust"} {
    set confirmedDialog [readDirectoryTrustDialog "" directory-trust-confirm-selection 144 146 145]
    set confirmedAction [directoryTrustAction $confirmedDialog directory-trust-confirm-selection 146]
    if {$confirmedAction ne "selected-trust"} {
      puts stderr "KIMI_TUI_STATE:directory-trust-confirm-selection:unknown"
      exit 146
    }
  }
  send -- "\\033\\[13u"
  expect {
    -nocase -re {Trust this folder\\?} { unexpectedDirectoryTrust }
    -re $promptPattern {}
    timeout { failTimeout directory-trust-prompt 151 153 }
    eof { failEof directory-trust-prompt 152 }
  }
}

proc submitCommand {command} {
  send -- "\\033\\[200~"
  send -- $command
  send -- "\\033\\[201~"
  send -- "\\033\\[13u"
}

spawn $kimiCommand
if {[catch {exec stty columns 240 rows 60 < $spawn_out(slave,name)} resizeError]} {
  puts stderr "KIMI_TUI_STATE:terminal-size:failed"
  exit 131
}
expect {
  -nocase -re {Trust this folder\\?} { confirmInitialDirectoryTrust }
  -re $promptPattern {}
  timeout { failTimeout initial-prompt 101 103 }
  eof { failEof initial-prompt 102 }
}
${removeCommand}submitCommand "/plugins install $installUrl"
set dialogBuffer ""
expect {
  -nocase -re {Trust this folder\\?} { unexpectedDirectoryTrust }
  -nocase -re {(?:Install third-party plugin|Trust and install from)[ \\t]} {
    append dialogBuffer $expect_out(buffer)
  }
  timeout { failTimeout plugin-trust-anchor 104 106 }
  eof { failEof plugin-trust-anchor 105 }
}
expect {
  -nocase -re {Trust this folder\\?} { unexpectedDirectoryTrust }
  -nocase -re {❯[^\\r\\n]*(?:Exit|Cancel|Trust and install)} {
    append dialogBuffer $expect_out(buffer)
  }
  -re {❯[^\\r\\n]*\\r*\\n} {
    puts stderr "KIMI_TUI_STATE:plugin-trust-selected-row:unknown"
    exit 134
  }
  timeout {
    puts stderr "KIMI_TUI_STATE:plugin-trust-selected-row:timeout"
    exit 132
  }
  eof { failEof plugin-trust-selected-row 133 }
}

set dialog [extractPluginTrustDialog $dialogBuffer]
if {$dialog eq ""} {
  puts stderr "KIMI_TUI_STATE:plugin-trust:dialog-unknown"
  exit 113
}
set identity [extractPluginTrustIdentity $dialog]
set compactIdentity [compactScreen $identity]
if {$identity eq "" || $compactIdentity ne [compactScreen $installUrl]} {
  set expectedRepoPrefix "[compactScreen $expectedRepo]/releases/tag/"
  if {[string first $expectedRepoPrefix $compactIdentity] != 0} {
    puts stderr "KIMI_TUI_STATE:plugin-trust:repo-mismatch"
    exit 111
  }
  puts stderr "KIMI_TUI_STATE:plugin-trust:tag-mismatch"
  exit 112
}
if {[regexp -nocase {(^|\\n)[^\\n]*❯[^\\n]*trust and install} $dialog]} {
  send -- "\\033\\[13u"
} elseif {[regexp -nocase {(^|\\n)[^\\n]*❯[^\\n]*(cancel|exit)} $dialog]} {
  send -- "\\033\\[B"
  expect {
    -nocase -re {Trust this folder\\?} { unexpectedDirectoryTrust }
    -nocase -re {❯[^\\r\\n]*Trust and install} {}
    -re {❯[^\\r\\n]*\\r*\\n} {
      puts stderr "KIMI_TUI_STATE:plugin-trust-confirm-selection:unknown"
      exit 109
    }
    timeout { failTimeout plugin-trust-confirm-selection 107 109 }
    eof { failEof plugin-trust-confirm-selection 108 }
  }
  send -- "\\033\\[13u"
} else {
  puts stderr "KIMI_TUI_STATE:plugin-trust:selection-unknown"
  exit 113
}

expect {
  -nocase -re {Trust this folder\\?} { unexpectedDirectoryTrust }
  -nocase -re {Install finished[^\\r\\n]*see details below\\.} {}
  -nocase -re {Installing plugin from[^\\r\\n]*(?:\\r|\\n)} {
    exp_continue -continue_timer
  }
  -nocase -re {Install failed:[^\\r\\n]*} {
    puts stderr "KIMI_TUI_STATE:install-result:failed"
    exit 135
  }
  -nocase -re {(^|\\r|\\n)Install[^\\r\\n]*\\r*\\n} {
    puts stderr "KIMI_TUI_STATE:install-result:unknown"
    exit 138
  }
  timeout {
    puts stderr "KIMI_TUI_STATE:install-result:timeout"
    exit 136
  }
  eof { failEof install-result 137 }
}
expect {
  -nocase -re {Trust this folder\\?} { unexpectedDirectoryTrust }
  -re $promptPattern {}
  timeout { failTimeout post-install-prompt 114 116 }
  eof { failEof post-install-prompt 115 }
}
submitCommand "/reload"
expect {
  -nocase -re {Trust this folder\\?} { unexpectedDirectoryTrust }
  -re $promptPattern {}
  timeout { failTimeout reload-prompt 117 119 }
  eof { failEof reload-prompt 118 }
}
submitCommand "/exit"
expect {
  eof { puts stderr "KIMI_TUI_STATE:exit-eof:eof" }
  timeout { failTimeout exit-eof 120 121 }
}
`;
}

async function observeKimiTarget(target, kimiHome, run) {
  const pluginsRoot = join(kimiHome, 'plugins');
  let installed;
  try {
    installed = parseJson(
      await readFileContained(pluginsRoot, 'installed.json', { encoding: 'utf8' }),
      'Kimi installed plugin registry',
    );
  } catch (error) {
    if (
      error?.code === 'ENOENT'
      || error?.details?.causeCode === 'ENOENT'
      || error?.details?.kind === 'missing-resource'
    ) return { installed: false };
    throw error;
  }
  const entry = installed?.plugins?.find((candidate) => candidate?.id === target.plugin);
  if (!entry) return { installed: false };
  if (!entry.github) return { installed: true, exact: false, source: 'legacy', entry };
  const managedRoot = join(pluginsRoot, 'managed');
  const pluginRoot = await resolveContained(managedRoot, target.plugin);
  const declaredRoot = await resolveContained(managedRoot, relative(managedRoot, entry.root));
  if (declaredRoot !== pluginRoot) throw new Error('Kimi installed plugin root does not match its managed root');
  const packageJson = parseJson(
    await readFileContained(pluginRoot, 'package.json', { encoding: 'utf8' }),
    'Kimi installed package manifest',
  );
  const refName = entry.github.ref?.kind === 'tag' ? entry.github.ref.value : undefined;
  const revision = entry.github.installedSha;
  let gitHeadExact = true;
  try {
    await access(join(pluginRoot, '.git'));
    const head = await run('git', ['-C', pluginRoot, 'rev-parse', 'HEAD'], {
      env: hostEnvironment('kimi', { kimiHome }),
      timeout: 30_000,
    });
    gitHeadExact = head.stdout.trim() === target.pluginCommit;
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  const exact = packageJson.name === target.plugin
    && packageJson.version === target.version
    && refName === target.pluginTag
    && revision === target.pluginCommit
    && gitHeadExact;
  return {
    installed: true,
    exact,
    source: 'github',
    entry,
    packageJson,
    refName,
    revision,
    pluginRoot,
  };
}

async function runKimiUpdate(target, detected, run, kimiHome, {
  plan,
  root,
  verifyInstalledPayload,
}) {
  const env = hostEnvironment('kimi', { kimiHome });
  const before = await observeKimiTarget(target, kimiHome, run);
  if (before.exact) {
    await verifyStructuredInstalledPayload({
      plan,
      root,
      target,
      installPath: before.pluginRoot,
      verifyInstalledPayload,
    });
    return { status: 'ALREADY_CURRENT', version: target.version };
  }
  const tuiOutcome = await withTemporaryWorkspace(async (workspace) => {
    const checkout = join(workspace.root, 'plugin');
    await run('git', [
      'clone', '--depth', '1', '--branch', target.pluginTag, '--single-branch',
      `https://github.com/${target.pluginRepo}.git`, checkout,
    ], { timeout: 180_000, env });
    const observed = await run('git', ['-C', checkout, 'rev-parse', 'HEAD'], {
      env,
      timeout: 30_000,
    });
    if (observed.stdout.trim() !== target.pluginCommit) {
      throw new Error(`Kimi checkout commit does not match frozen release commit ${target.pluginCommit}`);
    }
    const installUrl = `https://github.com/${target.pluginRepo}/releases/tag/${target.pluginTag}`;
    const removePlugin = before.source === 'legacy' ? target.plugin : '';
    await run(detected.expectCommand, ['-c', kimiExpectProgram({
      ...(removePlugin ? { removePlugin } : {}),
    })], {
      cwd: root,
      timeout: Math.max(300_000, target.timeoutMs),
      env: {
        ...env,
        RELEASE_SKILL_KIMI_COMMAND: detected.command,
        RELEASE_SKILL_KIMI_INSTALL_URL: installUrl,
        RELEASE_SKILL_KIMI_REMOVE_PLUGIN: removePlugin,
        RELEASE_SKILL_KIMI_EXPECTED_REPO: `https://github.com/${target.pluginRepo}`,
        RELEASE_SKILL_KIMI_EXPECTED_TAG: target.pluginTag,
      },
    });
  }, { prefix: 'release-skill-kimi-update-' });
  if (tuiOutcome) return tuiOutcome;
  const after = await observeKimiTarget(target, kimiHome, run);
  if (!after.exact) throw new Error('Kimi did not report the frozen plugin identity after TUI installation');
  await verifyStructuredInstalledPayload({
    plan,
    root,
    target,
    installPath: after.pluginRoot,
    verifyInstalledPayload,
  });
  return { status: 'UPDATED', version: target.version, restartRequired: true };
}

async function observeCursorClosure(root) {
  return observeFilesystemTree({ root, rootBinding: await createFilesystemRootBinding(root) });
}

async function cursorMainProcessRunning(run) {
  const result = await run('/bin/ps', ['-axo', 'comm='], { timeout: 30_000 });
  if (typeof result?.stdout !== 'string' || result.stdout.trim().length === 0) throw new Error('Cursor process observation is unavailable');
  return result.stdout.split('\n').some((line) => /(?:^|\/)Cursor$/u.test(line.trim()));
}

async function runCursorLocalUpdate(target, {
  root, run, cursorPluginsRoot, cursorPlatform = process.platform,
  cursorIsRunning = () => cursorMainProcessRunning(run),
  cursorPublication = { publishFixedSet, replaceFixedSetAtomic },
  cursorMoveBackup = rename,
}) {
  const frozen = await verifyFrozenSnapshot({ root, snapshotPath: target.snapshotPath, expectedDigest: target.manifestDigest });
  if (!target.cursor?.sourcePath) throw new Error('Cursor local update requires a frozen cursor.sourcePath');
  if (!/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/u.test(target.plugin)) throw new Error('Cursor plugin identity must use a valid Cursor plugin name');
  const source = await resolveContained(frozen.snapshotDir, target.cursor.sourcePath);
  const identity = JSON.parse(await readFileContained(source, '.cursor-plugin/plugin.json', { encoding: 'utf8' }));
  if (typeof identity.name !== 'string' || !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/u.test(identity.name)
    || identity.name !== target.plugin || identity.version !== target.version) throw new Error('Cursor frozen plugin manifest identity conflicts with the release unit');
  if (typeof cursorPluginsRoot !== 'string' || !isAbsolute(cursorPluginsRoot) || normalize(cursorPluginsRoot) !== cursorPluginsRoot) {
    throw new Error('Cursor local update requires --cursor-plugins-root <normalized-absolute-directory>');
  }
  if (cursorPlatform !== 'darwin') return { status: 'MANUAL_REQUIRED', reason: 'Cursor Local automatic installation currently supports macOS only' };
  try {
    if (await cursorIsRunning() !== false) return { status: 'MANUAL_REQUIRED', reason: 'Quit the Cursor main process before updating Local plugins' };
  } catch (cause) {
    return { status: 'MANUAL_REQUIRED', reason: `Cannot confirm Cursor has exited: ${cause.message}` };
  }
  // Bind the caller-selected root before creating any staging directory.
  await createFilesystemRootBinding(cursorPluginsRoot);
  const pluginsRoot = await realpath(cursorPluginsRoot);
  const sourceObservation = await observeCursorClosure(source);
  const workspace = await createTemporaryWorkspace({ prefix: 'release-skill-cursor-local-' });
  let sibling;
  let preserve = false;
  try {
    const candidate = join(workspace.root, 'plugin');
    await cp(source, candidate, { recursive: true, errorOnExist: true, force: false });
    if ((await observeCursorClosure(candidate)).membersDigest !== sourceObservation.membersDigest) throw new Error('Cursor candidate differs from the frozen source closure');
    await chmod(candidate, 0o700);
    if (target.cursor.dependencyInstall !== undefined) {
      if (target.cursor.dependencyInstall !== 'npm-ci-ignore-scripts') throw new Error('Unsupported Cursor dependency installation policy');
      await run('npm', ['ci', '--ignore-scripts', '--prefix', candidate], {
        cwd: candidate, timeout: target.timeoutMs, env: hostEnvironment('cursor'),
      });
      // npm may add dependencies, but must not mutate the frozen plugin inputs.
      for (const member of sourceObservation.members.filter((entry) => entry.type === 'file')) {
        await readFileStrict(candidate, member.path, { expectedSha256: member.sha256 });
      }
    }
    const prepared = await observeCursorClosure(candidate);
    await verifyFrozenSnapshot({ root, snapshotPath: target.snapshotPath, expectedDigest: target.manifestDigest });
    try {
      if (await cursorIsRunning() !== false) return { status: 'MANUAL_REQUIRED', reason: 'Cursor started while preparing the plugin; quit Cursor and rerun the update' };
    } catch (cause) {
      return { status: 'MANUAL_REQUIRED', reason: `Cannot confirm Cursor has exited before publication: ${cause.message}` };
    }
    const local = await resolveContained(pluginsRoot, 'local');
    await mkdir(local, { recursive: true });
    await createFilesystemRootBinding(local);
    const targetPath = await resolveContained(local, target.plugin);
    let installed = false;
    let previousClosure;
    try {
      await lstat(targetPath);
      installed = true;
    } catch (cause) { if (cause.code !== 'ENOENT') throw cause; }
    if (installed) {
      const current = JSON.parse(await readFileContained(targetPath, '.cursor-plugin/plugin.json', { encoding: 'utf8' }));
      if (current.name !== target.plugin || typeof current.version !== 'string') throw new Error('Cursor installed plugin manifest identity conflicts with the frozen plugin');
      const observed = await observeCursorClosure(targetPath);
      previousClosure = observed.membersDigest;
      if (current.version === target.version && observed.membersDigest === prepared.membersDigest) return { status: 'ALREADY_CURRENT', version: target.version, installPath: targetPath };
    }
    // Cursor is closed, so this same-parent candidate cannot be discovered by
    // a live scanner. Only this uniquely-created directory may be cleaned.
    sibling = await mkdtemp(join(local, `.${target.plugin}-stage-`));
    await cp(candidate, sibling, { recursive: true, errorOnExist: false, force: false });
    if ((await observeCursorClosure(sibling)).membersDigest !== prepared.membersDigest) throw new Error('Cursor publication candidate closure drift');
    const publication = { sourceRoot: sibling, targetParent: local, targetSegment: target.plugin };
    let backupPath;
    if (installed) {
      try {
        await cursorPublication.replaceFixedSetAtomic(publication);
      } catch (cause) {
        preserve = cause.details?.phase === 'post-commit' || cause.details?.publicationState === 'indeterminate' || cause.details?.commitState === 'indeterminate';
        throw cause;
      }
      // Foundation has proved the exchanged mapping. The old complete plugin
      // is now owned by the user and must leave the Local scanner namespace.
      preserve = true;
      try {
        const backups = await resolveContained(pluginsRoot, `backups/${target.plugin}`);
        await mkdir(backups, { recursive: true });
        await createFilesystemRootBinding(backups);
        const backupDirectory = await mkdtemp(join(backups, 'release-'));
        backupPath = join(backupDirectory, 'plugin');
        await cursorMoveBackup(sibling, backupPath);
        sibling = undefined;
        preserve = false;
      } catch (cause) {
        // One explicit reverse exchange is justified only by the verified
        // success above and an old directory still at the displaced path.
        if ((await observeCursorClosure(sibling)).membersDigest !== previousClosure
          || (await observeCursorClosure(targetPath)).membersDigest !== prepared.membersDigest) throw cause;
        await cursorPublication.replaceFixedSetAtomic(publication);
        preserve = false;
        throw new Error(`Cursor backup move failed; original plugin restored: ${cause.message}`);
      }
    } else {
      const manifest = await createFixedSetPublicationManifest(publication);
      const receipt = await cursorPublication.publishFixedSet({ ...publication, manifest });
      if (receipt.status !== 'succeeded') {
        preserve = receipt.status === 'indeterminate' || receipt.commitState !== 'not-committed';
        const error = new Error(`Cursor publication failed: ${receipt.error?.message ?? receipt.status}`);
        error.details = receipt;
        throw error;
      }
      sibling = undefined;
    }
    if ((await observeCursorClosure(targetPath)).membersDigest !== prepared.membersDigest) throw new Error('Cursor installed plugin closure drift after publication');
    return {
      status: 'UPDATED', version: target.version, installPath: targetPath,
      ...(backupPath ? { backupPath } : {}), restartRequired: true,
      reloadInstruction: 'Restart Cursor or run Reload Window, then verify the Local source, version and Skill invocation.',
    };
  } catch (error) {
    if (preserve) error.details = { ...error.details, candidatePath: sibling, workspacePath: workspace.root, manualAction: 'Keep both directories intact; inspect the Cursor Local publication mapping before retrying.' };
    throw error;
  } finally {
    if (!preserve) {
      // Sealed snapshots carry read-only directories. Restore owner access
      // only in this invocation's disposable copies before Foundation cleanup.
      for (const cleanupRoot of [sibling, workspace.root].filter(Boolean)) {
        const closure = await observeFilesystemTree({
          root: cleanupRoot,
          rootBinding: await createFilesystemRootBinding(cleanupRoot),
          symlinkPolicy: { mode: 'record' },
        });
        await chmod(cleanupRoot, 0o700);
        for (const member of closure.members.filter((entry) => entry.type === 'directory')) {
          await chmod(await resolveContained(cleanupRoot, member.path), member.statMode | 0o700);
        }
      }
      if (sibling) await rm(sibling, { recursive: true, force: false });
      await workspace.dispose();
    }
  }
}

function aggregateStatus(results) {
  const statuses = new Set(results.map((entry) => entry.status));
  const completed = results.some((entry) => ['UPDATED', 'ALREADY_CURRENT'].includes(entry.status));
  const incomplete = results.some((entry) => ['FAILED', 'MANUAL_REQUIRED'].includes(entry.status));
  if (completed && incomplete) return 'PARTIAL';
  if (statuses.has('FAILED')) return 'FAILED';
  if (statuses.has('MANUAL_REQUIRED')) return 'MANUAL_REQUIRED';
  if (statuses.has('UPDATED')) return 'UPDATED';
  if (statuses.has('ALREADY_CURRENT')) return 'ALREADY_CURRENT';
  return 'NO_APPLICABLE_HOSTS';
}

function failedHostResult(target, error) {
  const message = error?.message ?? String(error);
  const details = error?.details;
  const publicDetails = details && typeof details === 'object' && !Array.isArray(details)
    ? Object.fromEntries(Object.entries(details).filter(([key]) => (
      key !== 'foundationEnvelope' && key !== 'foundationStdout' && key !== 'foundationStderr'
    )))
    : details;
  return {
    host: target.host,
    unitId: target.unitId,
    status: 'FAILED',
    error: message,
    reason: typeof error?.reason === 'string' ? error.reason : message,
    ...(error?.code !== undefined ? { code: error.code } : {}),
    ...(publicDetails !== undefined ? { details: publicDetails } : {}),
  };
}

async function updateLocalHostPluginsInternal({
  plan,
  root = process.cwd(),
  confirmPlanDigest,
  selectedHosts,
  detect = (host) => defaultDetect(host, defaultRun),
  run = defaultRun,
  kimiHome,
  cursorPluginsRoot,
  cursorPlatform,
  cursorIsRunning,
  cursorPublication,
  cursorMoveBackup,
  verifyInstalledPayload = verifyInstalledMarketplacePayload,
} = {}) {
  const effectiveKimiHome = kimiHome ?? process.env.KIMI_CODE_HOME ?? join(homedir(), '.kimi-code');
  const checklist = derivePostReleaseChecklist(plan, { postVerifyComplete: true });
  if (confirmPlanDigest !== plan.digest) {
    throw new Error('plan digest confirmation does not match the frozen release plan');
  }
  const selected = new Set(Array.isArray(selectedHosts) ? selectedHosts : []);
  const unknown = [...selected].filter((host) => !checklist.localHostUpdate.hosts.includes(host));
  if (unknown.length > 0) throw new Error(`selected hosts are not declared by the plan: ${unknown.join(', ')}`);
  const targets = checklist.localHostUpdate.targets.filter((item) => (
    item.executionMode !== 'manual' && selected.has(item.host)
  ));
  for (const target of targets) {
    if (target.host === 'cursor') continue;
    if (target.host === 'qoder') assertQoderExecutableTarget(target);
    else assertExecutableTarget(target);
  }

  const results = [];
  for (const target of targets) {
    try {
      if (target.host === 'cursor') {
        const outcome = await runCursorLocalUpdate(target, {
          root, run, cursorPluginsRoot, cursorPlatform, cursorIsRunning, cursorPublication, cursorMoveBackup,
        });
        results.push({ host: target.host, unitId: target.unitId, ...outcome });
        continue;
      }
      if (target.targetKind === 'hub-backed' && target.host !== 'qoder') {
        await verifyFrozenSnapshot({ root, snapshotPath: target.snapshotPath, expectedDigest: target.manifestDigest });
      }
      const detected = await detect(target.host);
      if (!detected?.available) {
        results.push({
          host: target.host,
          unitId: target.unitId,
          status: detected?.status ?? 'SKIPPED_NOT_INSTALLED',
          reason: detected?.reason ?? 'host unavailable',
        });
        continue;
      }
      const outcome = target.host === 'kimi'
        ? await runKimiUpdate(target, detected, run, effectiveKimiHome, {
          plan,
          root,
          verifyInstalledPayload,
        })
        : target.host === 'qoder'
          ? await runQoderUpdate(target, detected, run, {
            root,
            verifyInstalledPayload,
          })
          : await runStructuredUpdate(target, detected, run, {
          plan,
          root,
          verifyInstalledPayload,
        });
      results.push({ host: target.host, unitId: target.unitId, ...outcome });
    } catch (error) {
      results.push(failedHostResult(target, error));
    }
  }
  return {
    command: 'post-release',
    operation: 'update-local-hosts',
    status: aggregateStatus(results),
    planDigest: plan.digest,
    results,
    releaseStatusChanged: false,
  };
}
