import { access, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, relative } from 'node:path';

import {
  readFileContained,
  resolveContained,
  superviseProcess,
  withTemporaryWorkspace,
} from 'skill-family-harness-node';

import { getPlatform } from '../platforms/registry.mjs';
import { resolveCodeBuddyMarketplace } from '../platforms/codebuddy.mjs';
import { verifyInstalledMarketplacePayload } from '../adapters/plugin-marketplace.mjs';
import { normalizePostPublishView, postPublishActionId } from '../core/postpublish.mjs';
import { loadRun, validateRunLineage } from '../core/run.mjs';

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
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy',
  'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS',
  'CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'KIMI_CONFIG_DIR',
  'CODEBUDDY_CONFIG_DIR', 'WORKBUDDY_CONFIG_DIR',
]);
const CODEBUDDY_PLUGIN_LIST_ARGS = Object.freeze(['plugin', 'list', '--json']);
const CODEBUDDY_MARKETPLACE_LIST_ARGS = Object.freeze(['plugin', 'marketplace', 'list']);

function attachFoundationFailure(error, { envelope, stdout }) {
  Object.defineProperties(error, {
    foundationEnvelope: { value: envelope, enumerable: false },
    foundationStdout: { value: stdout, enumerable: false },
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

function assertExecutableTarget(target) {
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

export function derivePostReleaseChecklist(plan, {
  runPath,
  root,
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
  const targets = pluginTargets(plan);
  const hasPendingPostVerify = postVerifyHooks(plan).length > 0 && !postVerifyComplete && targets.length > 0;
  const hasStatePath = typeof statePath === 'string' && statePath.length > 0;
  const selectedUnitIds = Array.isArray(unitIds) ? unitIds : undefined;
  return {
    command: 'post-release',
    status: 'AWAITING_USER_DECISION',
    planDigest: plan.digest,
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
      available: targets.length > 0 && !hasPendingPostVerify,
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
  if (host === 'kimi' && kimiHome) env.KIMI_CONFIG_DIR = kimiHome;
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
      throw attachFoundationFailure(error, { envelope, stdout });
    }
    return { stdout, stderr };
  }, { prefix: 'release-skill-host-command-' });
}

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

async function observeMarketplace(target, command, env, run) {
  const listed = await run(command, ['plugin', 'marketplace', 'list', '--json'], { env });
  const parsed = parseJson(listed.stdout, `${target.host} marketplace list`);
  const entries = target.host === 'claude' ? parsed : parsed?.marketplaces;
  if (!Array.isArray(entries)) throw new Error(`${target.host} marketplace list has an invalid shape`);
  const found = entries.find((entry) => entry?.name === target.marketplace);
  if (!found) return { installed: false };
  const source = target.host === 'claude' ? found.repo : found.marketplaceSource?.source;
  if (normalizeGitSource(source) !== normalizeGitSource(target.marketplaceRepo)) {
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

async function runStructuredUpdate(target, detected, run, {
  plan,
  root,
  verifyInstalledPayload,
}) {
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
    ? `send -- "/plugins remove $removePlugin\\r"
expect {
  -nocase -re {(remove|delete|uninstall).*(confirm|sure)|(confirm|sure).*(remove|delete|uninstall)} {
    expect {
      -ex $removePlugin { send -- "\\033\\[B\\r" }
      timeout { exit 95 }
      eof { exit 96 }
    }
    expect -re $promptPattern
  }
  -re $promptPattern {}
  timeout { exit 93 }
  eof { exit 94 }
}
`
    : '';
  return `set timeout 180
foreach variable {RELEASE_SKILL_KIMI_COMMAND RELEASE_SKILL_KIMI_INSTALL_URL RELEASE_SKILL_KIMI_REMOVE_PLUGIN} {
  if {![info exists env($variable)]} { exit 90 }
}
set kimiCommand $env(RELEASE_SKILL_KIMI_COMMAND)
set installUrl $env(RELEASE_SKILL_KIMI_INSTALL_URL)
set removePlugin $env(RELEASE_SKILL_KIMI_REMOVE_PLUGIN)
set promptPattern {(?:(?:^|\\r|\\n)> |(?:^|\\r|\\n)(?:\\033\\[[0-9;?]*[ -/]*[@-~])*│[ \\t]*>[ \\t]*│(?:\\033\\[[0-9;?]*[ -/]*[@-~])*)(?![^\\n]|\\n)}
spawn $kimiCommand
expect -re $promptPattern
${removeCommand}send -- "/plugins install $installUrl\\r"
expect {
  -nocase -re {trust and install} {
    expect {
      -ex $installUrl { send -- "\\033\\[B\\r" }
      timeout { exit 97 }
      eof { exit 98 }
    }
  }
  timeout { exit 91 }
  eof { exit 92 }
}
expect -re $promptPattern
send -- "/reload\\r"
expect -re $promptPattern
send -- "/exit\\r"
expect eof
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
  await withTemporaryWorkspace(async (workspace) => {
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
      timeout: 240_000,
      env: {
        ...env,
        RELEASE_SKILL_KIMI_COMMAND: detected.command,
        RELEASE_SKILL_KIMI_INSTALL_URL: installUrl,
        RELEASE_SKILL_KIMI_REMOVE_PLUGIN: removePlugin,
      },
    });
  }, { prefix: 'release-skill-kimi-update-' });
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
  verifyInstalledPayload = verifyInstalledMarketplacePayload,
} = {}) {
  const effectiveKimiHome = kimiHome ?? process.env.KIMI_CONFIG_DIR ?? join(homedir(), '.kimi-code');
  const checklist = derivePostReleaseChecklist(plan, { postVerifyComplete: true });
  if (confirmPlanDigest !== plan.digest) {
    throw new Error('plan digest confirmation does not match the frozen release plan');
  }
  const selected = new Set(Array.isArray(selectedHosts) ? selectedHosts : []);
  const unknown = [...selected].filter((host) => !checklist.localHostUpdate.hosts.includes(host));
  if (unknown.length > 0) throw new Error(`selected hosts are not declared by the plan: ${unknown.join(', ')}`);
  const targets = checklist.localHostUpdate.targets.filter((item) => selected.has(item.host));
  for (const target of targets) assertExecutableTarget(target);

  const results = [];
  for (const target of targets) {
    try {
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
