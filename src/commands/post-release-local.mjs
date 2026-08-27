import { access } from 'node:fs/promises';
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
]);

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
    pluginTag,
    pluginCommit,
    marketplaceRepo,
    marketplaceRef: parameters.ref,
    marketplaceCommit,
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

export function derivePostReleaseChecklist(plan) {
  if (!plan || typeof plan !== 'object' || typeof plan.digest !== 'string') {
    throw new Error('a frozen release plan with digest is required');
  }
  const units = plan.units ?? [];
  const uncovered = units.filter((unit) => (
    !BRANCH_ACTION_INCLUDED.has(unit.productionConfig?.branchStrategy)
  ));
  const targets = pluginTargets(plan);
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
      promptRequired: targets.length > 0,
      available: targets.length > 0,
      hosts: [...new Set(targets.map((target) => target.host))].sort(),
      targets,
    },
  };
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
  if (host === 'workbuddy') env.CODEBUDDY_CONFIG_DIR = join(env.HOME, '.workbuddy');
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
      throw error;
    }
    return { stdout, stderr };
  }, { prefix: 'release-skill-host-command-' });
}

async function commandAvailable(command, host, run) {
  try {
    await run(command, ['--version'], { timeout: 10_000, env: hostEnvironment(host) });
    return true;
  } catch {
    return false;
  }
}

async function defaultDetect(host, run = defaultRun) {
  if (host === 'codebuddy' || host === 'workbuddy') {
    for (const command of ['codebuddy', 'cbc', CODEBUDDY_MACOS_PATH]) {
      if (await commandAvailable(command, host, run)) return { available: true, command };
    }
    return { available: false, reason: 'CodeBuddy/WorkBuddy CLI not found' };
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
  const found = parsed.find((entry) => entry?.id === selector);
  if (!found) return { installed: false };
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
  if (observed.marketplace.installed && observed.marketplace.exact) return;
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
    const listed = await run(detected.command, ['plugin', 'list', '--json'], { env });
    const observed = exactPluginObservation(target, listed.stdout);
    if (observed.exact) return { status: 'ALREADY_CURRENT', version: target.version };
    return {
      status: 'MANUAL_REQUIRED',
      reason: `${target.host} CLI cannot pin an install to frozen ref ${target.pluginTag}; no local mutation was performed`,
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

  await bindStructuredMarketplace(target, command, env, run, before);
  const platform = getPlatform(target.host);
  const selector = `${target.plugin}@${target.marketplace}`;
  let installPath;
  if (target.host === 'claude') {
    const installArgs = before.plugin.installed
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

function kimiExpectProgram(kimiCommand, installUrl) {
  const quotedCommand = JSON.stringify(kimiCommand);
  const quotedUrl = JSON.stringify(installUrl);
  return `set timeout 180\nspawn -- ${quotedCommand}\nexpect -re {> $}\nsend -- "/plugins install ${quotedUrl}\\r"\nexpect {\n  -re {Trust and install} { send -- "\\033\\[B\\r" }\n  timeout { exit 91 }\n  eof { exit 92 }\n}\nexpect -re {> $}\nsend -- "/reload\\r"\nexpect -re {> $}\nsend -- "/exit\\r"\nexpect eof\n`;
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
  const managedRoot = join(pluginsRoot, 'managed');
  const pluginRoot = await resolveContained(managedRoot, target.plugin);
  const declaredRoot = await resolveContained(managedRoot, relative(managedRoot, entry.root));
  if (declaredRoot !== pluginRoot) throw new Error('Kimi installed plugin root does not match its managed root');
  const packageJson = parseJson(
    await readFileContained(pluginRoot, 'package.json', { encoding: 'utf8' }),
    'Kimi installed package manifest',
  );
  let refName;
  let revision;
  if (entry.github) {
    refName = entry.github.ref?.kind === 'tag' ? entry.github.ref.value : undefined;
    revision = entry.github.installedSha;
  } else {
    const metadata = parseJson(
      await readFileContained(pluginRoot, '.codex-marketplace-install.json', { encoding: 'utf8' }),
      'Kimi installed source binding',
    );
    refName = metadata.ref_name;
    revision = metadata.revision;
  }
  const head = await run('git', ['-C', pluginRoot, 'rev-parse', 'HEAD'], {
    env: hostEnvironment('kimi'),
    timeout: 30_000,
  });
  const exact = packageJson.name === target.plugin
    && packageJson.version === target.version
    && refName === target.pluginTag
    && revision === target.pluginCommit
    && head.stdout.trim() === target.pluginCommit;
  return { installed: true, exact, entry, packageJson, refName, revision, pluginRoot };
}

async function runKimiUpdate(target, detected, run, kimiHome) {
  const env = hostEnvironment('kimi', { kimiHome });
  const before = await observeKimiTarget(target, kimiHome, run);
  if (before.exact) return { status: 'ALREADY_CURRENT', version: target.version };
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
    await run(detected.expectCommand, ['-c', kimiExpectProgram(detected.command, installUrl)], {
      timeout: 240_000,
      env,
    });
  }, { prefix: 'release-skill-kimi-update-' });
  const after = await observeKimiTarget(target, kimiHome, run);
  if (!after.exact) throw new Error('Kimi did not report the frozen plugin identity after TUI installation');
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

export async function updateLocalHostPlugins({
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
  const checklist = derivePostReleaseChecklist(plan);
  if (confirmPlanDigest !== plan.digest) {
    throw new Error('plan digest confirmation does not match the frozen release plan');
  }
  const selected = selectedHosts?.length > 0
    ? new Set(selectedHosts)
    : new Set(checklist.localHostUpdate.hosts);
  const unknown = [...selected].filter((host) => !checklist.localHostUpdate.hosts.includes(host));
  if (unknown.length > 0) throw new Error(`selected hosts are not declared by the plan: ${unknown.join(', ')}`);
  const targets = checklist.localHostUpdate.targets.filter((item) => selected.has(item.host));
  for (const target of targets) assertExecutableTarget(target);

  const results = [];
  for (const target of targets) {
    const detected = await detect(target.host);
    if (!detected?.available) {
      results.push({
        host: target.host,
        unitId: target.unitId,
        status: 'SKIPPED_NOT_INSTALLED',
        reason: detected?.reason ?? 'host unavailable',
      });
      continue;
    }
    try {
      const outcome = target.host === 'kimi'
        ? await runKimiUpdate(target, detected, run, effectiveKimiHome)
        : await runStructuredUpdate(target, detected, run, {
          plan,
          root,
          verifyInstalledPayload,
        });
      results.push({ host: target.host, unitId: target.unitId, ...outcome });
    } catch (error) {
      results.push({
        host: target.host,
        unitId: target.unitId,
        status: 'FAILED',
        error: error?.message ?? String(error),
      });
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
