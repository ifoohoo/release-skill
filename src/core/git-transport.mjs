import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';

import { ReleaseError, REMOTE_UNAVAILABLE, REMOTE_CONFLICT } from './errors.mjs';

const execFile = promisify(execFileCb);

function urls(repo, host) {
  if (typeof repo !== 'string' || !/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(repo)) {
    throw new ReleaseError(REMOTE_UNAVAILABLE, 'git transport preflight requires owner/name repositories');
  }
  const safeHost = host ?? 'github.com';
  if (!/^[A-Za-z0-9.-]+$/.test(safeHost)) {
    throw new ReleaseError(REMOTE_UNAVAILABLE, 'git transport preflight requires a safe GitHub hostname');
  }
  return {
    https: `https://${safeHost}/${repo}.git`,
    ssh: `git@${safeHost}:${repo}.git`,
  };
}

function identity(stdout) {
  const lines = String(stdout).trim().split('\n').filter(Boolean);
  const head = lines.find((line) => /^[a-f0-9]{40,64}\s+HEAD$/.test(line.trim()));
  const symref = lines.find((line) => line.startsWith('ref: '));
  return `${symref ?? ''}\n${head ?? ''}`;
}

export async function preflightGitTransports(plan, options = {}) {
  const exec = options.exec ?? ((command, args, execOptions) => execFile(command, args, execOptions));
  const repositories = new Map();
  for (const action of plan.externalActions ?? []) {
    const repo = action.parameters?.repo;
    if (!repo) continue;
    const host = action.parameters?.githubHost ?? 'github.com';
    repositories.set(`${host}/${repo}`, { repo, host });
  }
  const observations = [];
  for (const { repo, host } of repositories.values()) {
    const candidates = urls(repo, host);
    const observation = { repo, host };
    for (const transport of ['https', 'ssh']) {
      try {
        const { stdout } = await exec(
          'git',
          ['ls-remote', '--symref', candidates[transport], 'HEAD'],
          { shell: false, encoding: 'utf8', timeout: 30_000 },
        );
        observation[transport] = {
          status: 'available',
          identity: identity(stdout),
        };
      } catch (error) {
        observation[transport] = {
          status: 'unavailable',
          error: error.message,
        };
      }
    }
    if (observation.https.status === 'unavailable' && observation.ssh.status === 'unavailable') {
      throw new ReleaseError(
        REMOTE_UNAVAILABLE,
        `neither HTTPS nor SSH can read ${repo}`,
        { repository: repo, transports: observation },
      );
    }
    if (
      observation.https.status === 'available'
      && observation.ssh.status === 'available'
      && observation.https.identity !== observation.ssh.identity
    ) {
      throw new ReleaseError(
        REMOTE_CONFLICT,
        `HTTPS and SSH resolve different remote identities for ${repo}`,
        { repository: repo },
      );
    }
    observations.push(observation);
  }
  const transport = observations.some((entry) => entry.https.status === 'unavailable')
    ? 'ssh'
    : 'https';
  if (
    transport === 'ssh'
    && observations.some((entry) => entry.ssh.status !== 'available')
  ) {
    throw new ReleaseError(
      REMOTE_UNAVAILABLE,
      'no single safe Git transport is available for every release repository',
    );
  }
  return { transport, repositories: observations };
}
