import { lstat, readFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import YAML from 'yaml';
import { replaceFileAtomic } from 'skill-family-harness-node';

import { ReleaseError, CONFIG_INVALID, GATE_FAILED } from './errors.mjs';

function assertOid(value, label) {
  if (typeof value !== 'string' || !/^[a-f0-9]{40,64}$/.test(value)) {
    throw new ReleaseError(GATE_FAILED, `${label} is not a full Git object id`);
  }
}

/**
 * After VERIFIED, advance the project-only previous-public baseline to the
 * exact public commit already frozen, published and verified. This prepares
 * the next release without asking maintainers to copy commits from terminal
 * output. It never edits public files or performs remote writes.
 */
export async function updatePreviousPublicBaselines(options = {}) {
  const root = resolve(options.root ?? process.cwd());
  const planPath = resolve(options.planPath ?? '');
  const configPath = isAbsolute(options.configPath ?? '')
    ? resolve(options.configPath)
    : resolve(root, options.configPath ?? '.release-skill/project.yaml');
  const configRelativePath = relative(root, configPath);
  if (
    configRelativePath === '..'
    || configRelativePath.startsWith(`..${sep}`)
    || isAbsolute(configRelativePath)
  ) {
    throw new ReleaseError(CONFIG_INVALID, 'project config must stay within the project root', {
      root,
      configPath,
    });
  }
  let plan;
  let configRaw;
  let configStat;
  try {
    [plan, configRaw, configStat] = await Promise.all([
      readFile(planPath, 'utf8').then(JSON.parse),
      readFile(configPath, 'utf8'),
      lstat(configPath),
    ]);
  } catch (error) {
    throw new ReleaseError(
      CONFIG_INVALID,
      `cannot load release metadata authorities: ${error.message}`,
    );
  }
  if (!configStat.isFile() || configStat.isSymbolicLink()) {
    throw new ReleaseError(CONFIG_INVALID, 'project config must be a regular non-symlink file');
  }

  const doc = YAML.parseDocument(configRaw, { uniqueKeys: true });
  if (doc.errors.length > 0) {
    throw new ReleaseError(CONFIG_INVALID, `project config YAML is invalid: ${doc.errors[0].message}`);
  }
  const releaseUnits = doc.get('releaseUnits', true);
  if (!YAML.isSeq(releaseUnits)) {
    throw new ReleaseError(CONFIG_INVALID, 'project config releaseUnits must be a sequence');
  }
  const configUnits = new Map();
  for (const node of releaseUnits.items) {
    const id = node?.get?.('id');
    if (typeof id === 'string') configUnits.set(id, node);
  }

  const updates = [];
  for (const unit of plan.units ?? []) {
    const configUnit = configUnits.get(unit.id);
    if (!configUnit) {
      throw new ReleaseError(CONFIG_INVALID, `frozen unit "${unit.id}" is absent from project config`);
    }
    const frozen = unit.frozenSnapshot;
    assertOid(frozen?.commit, `unit "${unit.id}" frozen commit`);
    assertOid(frozen?.tree, `unit "${unit.id}" frozen tree`);
    if (!/^[a-f0-9]{64}$/.test(frozen?.manifestDigest ?? '')) {
      throw new ReleaseError(GATE_FAILED, `unit "${unit.id}" frozen manifest digest is invalid`);
    }
    const old = configUnit.get('previousPublicBaseline', true)?.toJSON?.() ?? {};
    const next = {
      mode: 'bound',
      ...(typeof old.githubHost === 'string' ? { githubHost: old.githubHost } : {}),
      repo: old.repo ?? unit.publicRepo,
      ref: old.ref ?? `refs/heads/${frozen.branch}`,
      commit: frozen.commit,
      tree: frozen.tree,
      manifestDigest: frozen.manifestDigest,
    };
    if (!next.repo || !next.ref) {
      throw new ReleaseError(GATE_FAILED, `unit "${unit.id}" cannot derive its next public baseline identity`);
    }
    const changed = [
      'mode',
      'repo',
      'ref',
      'commit',
      'tree',
      'manifestDigest',
    ].some((field) => old[field] !== next[field]);
    if (!changed) continue;
    configUnit.set('previousPublicBaseline', next);
    updates.push({
      id: unit.id,
      previousCommit: old.commit ?? null,
      commit: frozen.commit,
    });
  }

  if (updates.length === 0) {
    return { status: 'UNCHANGED', configPath, units: [] };
  }
  const nextRaw = doc.toString();
  if (nextRaw === configRaw) {
    return { status: 'UNCHANGED', configPath, units: updates };
  }
  try {
    await replaceFileAtomic(root, configRelativePath, nextRaw, {
      mode: configStat.mode & 0o777,
    });
  } catch (error) {
    throw new ReleaseError(CONFIG_INVALID, `cannot update project release metadata: ${error.message}`, error.details);
  }
  if (typeof options.validateFn === 'function') {
    try {
      await options.validateFn(configPath);
    } catch (error) {
      try {
        await replaceFileAtomic(root, configRelativePath, configRaw, {
          mode: configStat.mode & 0o777,
        });
      } catch (restoreError) {
        throw new ReleaseError(
          CONFIG_INVALID,
          `cannot restore project release metadata after validation failed: ${restoreError.message}`,
          { validationError: error.message, restoreError: restoreError.details },
        );
      }
      throw new ReleaseError(
        GATE_FAILED,
        `baseline advance reverted: rewritten config failed validation: ${error.message}`,
        { configPath, cause: error.message },
      );
    }
  }
  return { status: 'UPDATED', configPath, units: updates };
}
