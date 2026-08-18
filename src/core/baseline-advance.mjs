/**
 * Baseline advance: after a release reaches VERIFIED, the project config's
 * per-unit `previousPublicBaseline` must be advanced from the previous
 * public commit to the commit that was just published. Doing this by hand
 * is the most error-prone step in the release loop, so it is derived from
 * the frozen plan (never recomputed from workspace state) and written back
 * into `.release-skill/project.yaml` with comment preservation.
 *
 * Fail-safe by construction: any unit whose plan data is missing or
 * malformed is skipped rather than guessed.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import YAML from 'yaml';
import { ReleaseError, GATE_FAILED } from './errors.mjs';

const execFileAsync = promisify(execFileCb);

function defaultExec(command, args, options = {}) {
  return execFileAsync(command, args, { shell: false, encoding: 'utf8', timeout: 120_000, ...options });
}

const SHA_RE = /^[a-f0-9]{40}$/;
const DIGEST_RE = /^[a-f0-9]{64}$/;

/**
 * Derive the baseline advances that a VERIFIED plan implies.
 *
 * For each unit with a `mode: bound` previousPublicBaseline, the published
 * commit/tree/manifestDigest come from the unit's frozen push-snapshot
 * action — the same values that were pushed to the public repo.
 *
 * @param {{ units?: Array<Record<string, unknown>>, externalActions?: Array<Record<string, unknown>> }} plan
 *   The frozen release plan.
 * @returns {Array<{ unitId: string, repo: string, previousCommit: string, commit: string, tree: string, manifestDigest: string }>}
 *   One advance per unit that is behind its published commit. Units already
 *   at the published commit (idempotent re-runs) produce no advance.
 */
export function deriveBaselineAdvances(plan) {
  const advances = [];
  for (const unit of plan?.units ?? []) {
    const baseline = unit?.previousPublicBaseline;
    if (!baseline || baseline.mode !== 'bound') continue;

    const action = (plan?.externalActions ?? []).find((a) => (
      a?.type === 'push-snapshot'
      && a?.parameters?.publicRepo === unit.publicRepo
    ));
    const { commit, tree, manifestDigest } = action?.parameters ?? {};

    if (!SHA_RE.test(commit ?? '') || !SHA_RE.test(tree ?? '') || !DIGEST_RE.test(manifestDigest ?? '')) {
      continue;
    }
    if (baseline.commit === commit) continue;

    advances.push({
      unitId: unit.id,
      repo: baseline.repo,
      previousCommit: baseline.commit,
      commit,
      tree,
      manifestDigest,
    });
  }
  return advances;
}

/**
 * Apply derived advances to the project config file, preserving comments and
 * unrelated content by editing the YAML AST in place. When a `validateFn` is
 * provided, the rewritten file is re-validated and the original content is
 * restored if validation fails (the advance must never corrupt the config).
 *
 * @param {{ configPath: string, advances: Array<Record<string, unknown>>, validateFn?: (configPath: string) => Promise<void> }} opts
 * @returns {Promise<{ changed: boolean, updatedUnits: string[] }>}
 */
export async function applyBaselineAdvances({ configPath, advances, validateFn }) {
  if (!advances || advances.length === 0) {
    return { changed: false, updatedUnits: [] };
  }

  let content;
  try {
    content = await readFile(configPath, 'utf8');
  } catch (err) {
    throw new ReleaseError(
      GATE_FAILED,
      `baseline advance cannot read project config: ${err.message}`,
      { configPath, cause: err.code },
    );
  }

  const doc = YAML.parseDocument(content);
  const releaseUnits = doc.get('releaseUnits', true);
  if (!YAML.isSeq(releaseUnits)) {
    throw new ReleaseError(
      GATE_FAILED,
      'baseline advance requires a releaseUnits sequence in the project config',
      { configPath },
    );
  }

  const updatedUnits = [];
  for (const advance of advances) {
    const unitNode = releaseUnits.items.find((item) => (
      YAML.isMap(item) && item.get('id') === advance.unitId
    ));
    if (!unitNode) continue;

    let baselineNode = unitNode.get('previousPublicBaseline', true);
    if (!YAML.isMap(baselineNode)) {
      baselineNode = new YAML.YAMLMap();
      unitNode.set('previousPublicBaseline', baselineNode);
    }

    let changed = false;
    const setField = (key, value) => {
      if (baselineNode.get(key) !== value) {
        baselineNode.set(key, value);
        changed = true;
      }
    };
    setField('commit', advance.commit);
    setField('tree', advance.tree);
    setField('manifestDigest', advance.manifestDigest);

    if (changed) updatedUnits.push(advance.unitId);
  }

  if (updatedUnits.length === 0) {
    return { changed: false, updatedUnits: [] };
  }

  const next = doc.toString();
  await writeFile(configPath, next, 'utf8');

  if (typeof validateFn === 'function') {
    try {
      await validateFn(configPath);
    } catch (err) {
      // Restore the original content so a bad advance never corrupts config.
      await writeFile(configPath, content, 'utf8');
      throw new ReleaseError(
        GATE_FAILED,
        `baseline advance reverted: rewritten config failed validation: ${err.message}`,
        { configPath, cause: err.message },
      );
    }
  }

  return { changed: true, updatedUnits };
}

/**
 * Report whether a single file is clean in the git worktree (no staged or
 * unstaged changes). Fails safe to `false` on any git error so that a
 * non-repository or a broken git never authorizes an automatic commit.
 *
 * @param {{ root: string, filePath: string, execFn?: Function }} opts
 * @returns {Promise<boolean>}
 */
export async function isWorktreeFileClean({ root, filePath, execFn }) {
  const exec = typeof execFn === 'function' ? execFn : defaultExec;
  try {
    const { stdout } = await exec('git', ['status', '--porcelain', '--', filePath], { cwd: root });
    return stdout.trim() === '';
  } catch {
    return false;
  }
}

/**
 * Stage and commit only the config file. The caller is responsible for
 * checking `isWorktreeFileClean` *before* writing so that this commit never
 * sweeps in unrelated in-flight work.
 *
 * @param {{ root: string, filePath: string, message: string, execFn?: Function }} opts
 * @returns {Promise<void>}
 */
export async function commitBaselineAdvance({ root, filePath, message, execFn }) {
  const exec = typeof execFn === 'function' ? execFn : defaultExec;
  await exec('git', ['add', '--', filePath], { cwd: root });
  await exec('git', ['commit', '-m', message, '--', filePath], { cwd: root });
}
