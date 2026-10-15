/**
 * Shared local host process and list-observation helpers.
 *
 * Extracted so post-release local updates and host-coverage diagnosis reuse
 * one process runner and the platform registry list strategies. Callers pass
 * host/plugin/marketplace identity; command binaries and argv never come from
 * caller-controlled input.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';

import { superviseProcess, withTemporaryWorkspace } from 'skill-family-harness-node';

import { getPlatform, normalizeHostId } from '../platforms/registry.mjs';

export const OBSERVABLE_HOSTS = Object.freeze(['claude', 'codex']);

const SAFE_ENV_KEYS = Object.freeze([
  'PATH', 'HOME', 'USER', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TERM', 'TMPDIR',
  'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy',
  'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS',
  'CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'KIMI_CODE_HOME',
  'CODEBUDDY_CONFIG_DIR', 'WORKBUDDY_CONFIG_DIR',
]);

export function attachFoundationFailure(error, { envelope, stdout, stderr }) {
  Object.defineProperties(error, {
    foundationEnvelope: { value: envelope, enumerable: false },
    foundationStdout: { value: stdout, enumerable: false },
    foundationStderr: { value: stderr, enumerable: false },
  });
  return error;
}

export function hostEnvironment(host, { kimiHome } = {}) {
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
    env.CODEBUDDY_FORCE_LITE_WB_BUNDLE = '1';
  }
  if (host === 'kimi' && kimiHome) env.KIMI_CODE_HOME = kimiHome;
  return env;
}

export async function runLocalFinishCommand(command, args, options = {}) {
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

export function parseHostCommandJson(stdout, label) {
  try {
    return JSON.parse(stdout);
  } catch {
    throw new Error(`${label} did not return JSON`);
  }
}

export function interpretPluginListOutput(host, stdout, { plugin, marketplace } = {}) {
  if (typeof plugin !== 'string' || plugin.length === 0 || typeof marketplace !== 'string' || marketplace.length === 0) {
    return { state: 'unknown', reason: 'plugin identity is missing' };
  }
  let parsed;
  try {
    parsed = parseHostCommandJson(stdout, `${host} plugin list`);
  } catch (error) {
    return { state: 'unknown', reason: error.message };
  }
  let platform;
  try {
    platform = getPlatform(host);
  } catch (error) {
    return { state: 'unknown', reason: error.message };
  }
  if (typeof platform.strategy?.parseListOutput !== 'function') {
    return { state: 'unknown', reason: 'host observation is not implemented' };
  }
  const selector = `${plugin}@${marketplace}`;
  const observed = platform.strategy.parseListOutput(parsed, selector);
  if (!observed.ok) {
    if (String(observed.error ?? '').includes('not found')) {
      return { state: 'not-installed', reason: observed.error };
    }
    return { state: 'unknown', reason: observed.error };
  }
  const identity = typeof platform.strategy.extractListIdentity === 'function'
    ? platform.strategy.extractListIdentity(observed.found)
    : {};
  if (identity.plugin && identity.plugin !== plugin) {
    return {
      state: 'unknown',
      reason: 'list identity plugin does not match',
      identity,
      found: observed.found,
    };
  }
  if (identity.marketplace && identity.marketplace !== marketplace) {
    return {
      state: 'unknown',
      reason: 'list identity marketplace does not match',
      identity,
      found: observed.found,
    };
  }
  return {
    state: 'installed',
    identity,
    found: observed.found,
    ...(observed.installPath ? { installPath: observed.installPath } : {}),
  };
}

export async function observeHostPlugin({
  host,
  plugin,
  marketplace,
  run = runLocalFinishCommand,
  env,
  clock = () => new Date().toISOString(),
} = {}) {
  let canonical = host;
  try {
    canonical = await normalizeHostId(host);
  } catch {
    return {
      host,
      plugin,
      marketplace,
      state: 'unknown',
      source: 'setup --observe-hosts',
      observedAt: clock(),
      reason: 'host id could not be normalized',
    };
  }
  try {
    canonical = getPlatform(canonical).id;
  } catch {
    try {
      canonical = getPlatform(host).id;
    } catch {
      // Keep the Foundation identity when the local registry has no matching platform.
    }
  }
  if (!OBSERVABLE_HOSTS.includes(canonical)) {
    return {
      host: canonical,
      plugin,
      marketplace,
      state: 'unknown',
      source: 'setup --observe-hosts',
      observedAt: clock(),
      reason: 'host observation is not implemented',
    };
  }
  const platform = getPlatform(canonical);
  const command = platform.cli.binary;
  const args = platform.cli.list();
  try {
    const listed = await run(command, [...args], {
      env: env ?? hostEnvironment(canonical),
    });
    const interpreted = interpretPluginListOutput(canonical, listed.stdout, { plugin, marketplace });
    return {
      host: canonical,
      plugin,
      marketplace,
      state: interpreted.state,
      ...(interpreted.identity?.version ? { version: interpreted.identity.version } : {}),
      source: 'setup --observe-hosts',
      observedAt: clock(),
      ...(interpreted.reason ? { reason: interpreted.reason } : {}),
    };
  } catch (error) {
    return {
      host: canonical,
      plugin,
      marketplace,
      state: 'unknown',
      source: 'setup --observe-hosts',
      observedAt: clock(),
      reason: error?.message ?? 'host list failed',
    };
  }
}
