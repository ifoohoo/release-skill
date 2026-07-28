/**
 * Workspace source-authority content closure.
 *
 * The closure binds the workspace-relative source files that feed a public
 * release. Publish compares the frozen entries with the configured remote
 * default branch before any external write.
 */

import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { lstat, mkdtemp, readFile, readdir, realpath, rm } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';

import { canonicalJson, sha256Hex } from './digest.mjs';
import {
  CONFIG_INVALID,
  CONFIG_MISSING,
  CONTENT_MISMATCH,
  DIRTY_SOURCE_INPUT,
  NOT_DEFAULT,
  REF_MISSING,
  REMOTE_UNAVAILABLE,
  ReleaseError,
} from './errors.mjs';

const execFile = promisify(execFileCb);
const REPOSITORY_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/u;
const GIT_MODE_RE = /^(?:100644|100755)$/u;

export const SOURCE_INPUT_ALGORITHM_VERSION = 1;

/**
 * Compute the deterministic source-input closure for release units.
 *
 * `publicFiles.from` is workspace-root relative. `version.source` is relative
 * to its release unit. Directories are recursively expanded. Symlinks and
 * special files fail closed.
 */
export async function computeSourceInputClosure({ units, root }) {
  const realRoot = await realpath(resolve(root));
  const entriesByPath = new Map();

  for (const unit of units ?? []) {
    for (const mapping of unit.publicFiles ?? []) {
      if (typeof mapping?.from !== 'string' || mapping.from.length === 0) continue;
      await collectPath({
        absolutePath: resolveInside(realRoot, mapping.from),
        root: realRoot,
        entriesByPath,
      });
    }

    const versionSource = unit.version?.source;
    if (typeof versionSource === 'string' && versionSource.length > 0) {
      const unitRoot = resolveInside(realRoot, unit.source ?? '.');
      await collectPath({
        absolutePath: resolveInside(unitRoot, versionSource, realRoot),
        root: realRoot,
        entriesByPath,
      });
    }
  }

  const entries = [...entriesByPath.values()]
    .sort((left, right) => left.path.localeCompare(right.path));
  const digest = computeEntriesDigest(entries);
  return {
    algorithmVersion: SOURCE_INPUT_ALGORITHM_VERSION,
    entries,
    digest,
  };
}

function computeEntriesDigest(entries) {
  return sha256Hex(canonicalJson(entries.map(({ path, digest, mode }) => ({
    digest,
    mode,
    path,
  }))));
}

async function collectPath({ absolutePath, root, entriesByPath }) {
  let stat;
  try {
    stat = await lstat(absolutePath);
  } catch (error) {
    throw new ReleaseError(
      CONFIG_INVALID,
      `source-input closure cannot stat "${toRelative(root, absolutePath)}": ${error.message}`,
      { cause: error.code ?? 'UNKNOWN', path: toRelative(root, absolutePath) },
    );
  }

  const rel = toRelative(root, absolutePath);
  if (stat.isSymbolicLink()) {
    throw new ReleaseError(
      CONFIG_INVALID,
      `source-input closure rejects symlink "${rel}"`,
      { path: rel },
    );
  }
  const physicalPath = await realpath(absolutePath);
  if (physicalPath !== absolutePath) {
    throw new ReleaseError(
      CONFIG_INVALID,
      `source-input closure rejects symlinked ancestor for "${rel}"`,
      { path: rel },
    );
  }
  if (stat.isDirectory()) {
    const children = await readdir(absolutePath, { withFileTypes: true });
    children.sort((left, right) => left.name.localeCompare(right.name));
    for (const child of children) {
      await collectPath({
        absolutePath: join(absolutePath, child.name),
        root,
        entriesByPath,
      });
    }
    return;
  }
  if (!stat.isFile()) {
    throw new ReleaseError(
      CONFIG_INVALID,
      `source-input closure rejects non-regular file "${rel}"`,
      { path: rel },
    );
  }

  const content = await readFile(absolutePath);
  entriesByPath.set(rel, {
    path: rel,
    digest: sha256Hex(content),
    mode: normalizeLocalGitMode(stat.mode),
  });
}

function resolveInside(base, candidate, containmentRoot = base) {
  const resolved = resolve(base, candidate);
  const root = resolve(containmentRoot);
  if (resolved !== root && !resolved.startsWith(`${root}${sep}`)) {
    throw new ReleaseError(
      CONFIG_INVALID,
      `source-input closure path escapes workspace root: "${candidate}"`,
      { path: candidate },
    );
  }
  return resolved;
}

function toRelative(root, absolutePath) {
  const rel = relative(root, absolutePath).split(sep).join('/');
  if (!rel || rel === '.' || rel.startsWith('../') || rel === '..') {
    throw new ReleaseError(
      CONFIG_INVALID,
      `source-input closure path is outside the workspace: "${absolutePath}"`,
      { path: absolutePath },
    );
  }
  return rel;
}

function normalizeLocalGitMode(mode) {
  return (mode & 0o111) === 0 ? '100644' : '100755';
}

/**
 * Check only frozen source-input paths for staged, unstaged or untracked
 * changes. Unrelated dirty files remain allowed.
 */
export async function checkSourceInputDirty({ closure, root, execFn = execFile }) {
  const paths = (closure?.entries ?? []).map((entry) => entry.path);
  if (paths.length === 0) return { dirty: false, dirtyPaths: [] };

  let stdout;
  try {
    ({ stdout } = await execFn(
      'git',
      [
        'status',
        '--porcelain=v1',
        '-z',
        '--untracked-files=all',
        '--ignored=matching',
        '--',
        ...paths,
      ],
      { cwd: root, encoding: 'utf8', shell: false },
    ));
  } catch (error) {
    throw new ReleaseError(
      DIRTY_SOURCE_INPUT,
      `cannot check source-input dirty status: ${error.message}`,
      { cause: error.code ?? 'UNKNOWN' },
    );
  }

  const dirtyPaths = [];
  const records = String(stdout).split('\0').filter(Boolean);
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (record.length < 4) continue;
    const status = record.slice(0, 2);
    const recordPath = record.slice(3);
    // Ignored inputs are still untracked inputs. A file explicitly selected
    // for publication must not escape the prepare gate merely because a
    // .gitignore rule hides it from ordinary status output.
    dirtyPaths.push(recordPath);
    if (status.startsWith('R') || status.startsWith('C')) index += 1;
  }
  return {
    dirty: dirtyPaths.length > 0,
    dirtyPaths: [...new Set(dirtyPaths)].sort(),
  };
}

/**
 * Prove that the bytes copied into every frozen public snapshot came from
 * the same source-input closure that will later be checked on the remote
 * default branch.
 *
 * This closes the prepare-time interval between closure calculation and
 * snapshot construction. The snapshot builder records the exact source
 * path, content digest and source mode for every copied file.
 */
export function verifySnapshotSourcesMatchClosure({ closure, unitResults }) {
  if (!closure || !Array.isArray(closure.entries)) {
    return failure(CONFIG_INVALID, 'source-input closure is missing');
  }
  const closureByPath = new Map(
    closure.entries.map((entry) => [entry.path, entry]),
  );
  const mismatchedPaths = [];

  for (const { manifest } of unitResults ?? []) {
    for (const entry of manifest?.entries ?? []) {
      const expected = closureByPath.get(entry.from);
      const actualMode = normalizeSnapshotGitMode(entry.mode);
      if (
        !expected
        || entry.hash !== expected.digest
        || actualMode !== expected.mode
      ) {
        mismatchedPaths.push(entry.from);
      }
    }
  }

  if (mismatchedPaths.length > 0) {
    const paths = [...new Set(mismatchedPaths)].sort();
    return {
      passed: false,
      error: {
        code: DIRTY_SOURCE_INPUT,
        message: `frozen snapshots differ from ${paths.length} source-input closure file(s)`,
        paths,
      },
    };
  }
  return {
        passed: true,
        observation: {
          snapshotSourceCount: new Set(
            (unitResults ?? []).flatMap(({ manifest }) => (
              (manifest?.entries ?? []).map((entry) => entry.from)
            )),
          ).size,
        },
      };
}

function normalizeSnapshotGitMode(mode) {
  if (typeof mode === 'string' && GIT_MODE_RE.test(mode)) return mode;
  if (typeof mode === 'number') return normalizeLocalGitMode(mode);
  return null;
}

/**
 * Compare a frozen closure with a repository's actual remote default branch.
 *
 * Tests may inject `readRemoteFn(repo, branch, path)`; production uses one
 * shallow fetch in a temporary bare repository and never mutates user refs.
 */
export async function verifyRemoteSourceContent({
  sourceRepository,
  defaultBranch,
  closure,
  readRemoteFn,
  execFn = execFile,
}) {
  if (!REPOSITORY_RE.test(sourceRepository ?? '')) {
    return failure(CONFIG_MISSING, 'project.sourceRepository must be an explicit GitHub owner/repo');
  }
  if (typeof defaultBranch !== 'string' || defaultBranch.length === 0) {
    return failure(CONFIG_MISSING, 'project.defaultBranch must be an explicit branch name');
  }
  if (!closure || closure.algorithmVersion !== SOURCE_INPUT_ALGORITHM_VERSION) {
    return failure(CONFIG_INVALID, 'source-input closure algorithm is unsupported');
  }
  if (!Array.isArray(closure.entries) || computeEntriesDigest(closure.entries) !== closure.digest) {
    return failure(CONFIG_INVALID, 'source-input closure entries do not match the frozen digest');
  }

  if (readRemoteFn) {
    return verifyWithInjectedReader({
      closure,
      defaultBranch,
      readRemoteFn,
      sourceRepository,
    });
  }
  return verifyWithTemporaryGit({
    closure,
    defaultBranch,
    execFn,
    sourceRepository,
  });
}

async function verifyWithInjectedReader({
  closure,
  defaultBranch,
  readRemoteFn,
  sourceRepository,
}) {
  const mismatchedPaths = [];
  for (const entry of closure.entries) {
    let result;
    try {
      result = await readRemoteFn(sourceRepository, defaultBranch, entry.path);
    } catch (error) {
      return failure(REMOTE_UNAVAILABLE, error.message);
    }
    const classified = classifyRemoteStatus(result, sourceRepository, defaultBranch);
    if (classified) return classified;
    if (
      sha256Hex(Buffer.isBuffer(result.content) ? result.content : Buffer.from(result.content))
        !== entry.digest
      || result.mode !== entry.mode
    ) {
      mismatchedPaths.push(entry.path);
    }
  }
  return mismatchedPaths.length > 0
    ? mismatch(defaultBranch, mismatchedPaths)
    : {
        passed: true,
        observation: {
          defaultBranch,
          entryCount: closure.entries.length,
          sourceRepository,
        },
      };
}

function classifyRemoteStatus(result, repository, branch) {
  if (result?.status === 'ok') return null;
  if (result?.status === 'ref_missing') {
    return failure(
      REF_MISSING,
      result.error ?? `remote ref "${branch}" does not exist in "${repository}"`,
    );
  }
  if (result?.status === 'not_default') {
    return failure(
      NOT_DEFAULT,
      result.error ?? `"${branch}" is not the default branch of "${repository}"`,
    );
  }
  return failure(
    REMOTE_UNAVAILABLE,
    result?.error ?? `remote source "${repository}" is unavailable`,
  );
}

async function verifyWithTemporaryGit({
  closure,
  defaultBranch,
  execFn,
  sourceRepository,
}) {
  const repositoryUrl = `https://github.com/${sourceRepository}.git`;
  let observed;
  try {
    ({ stdout: observed } = await execFn(
      'git',
      ['ls-remote', '--symref', repositoryUrl, 'HEAD', `refs/heads/${defaultBranch}`],
      { encoding: 'utf8', shell: false, timeout: 60_000 },
    ));
  } catch (error) {
    return failure(REMOTE_UNAVAILABLE, `cannot observe "${sourceRepository}": ${error.message}`);
  }

  const lines = String(observed).split(/\r?\n/u).filter(Boolean);
  const headSymref = lines.find((line) => line.startsWith('ref: refs/heads/'));
  const actualDefault = headSymref?.match(/^ref: refs\/heads\/(.+)\tHEAD$/u)?.[1] ?? null;
  if (!actualDefault) {
    return failure(REMOTE_UNAVAILABLE, `remote default branch is not observable for "${sourceRepository}"`);
  }
  if (actualDefault !== defaultBranch) {
    return failure(
      NOT_DEFAULT,
      `configured defaultBranch "${defaultBranch}" does not match remote default "${actualDefault}"`,
    );
  }
  const branchLine = lines.find((line) => line.endsWith(`\trefs/heads/${defaultBranch}`));
  if (!branchLine) {
    return failure(REF_MISSING, `remote ref "refs/heads/${defaultBranch}" does not exist`);
  }
  const tempRoot = await mkdtemp(join(tmpdir(), 'release-skill-source-authority-'));
  try {
    await execFn('git', ['init', '--bare', tempRoot], {
      encoding: 'utf8',
      shell: false,
      timeout: 30_000,
    });
    await execFn(
      'git',
      [
        '-C',
        tempRoot,
        'fetch',
        '--depth=1',
        repositoryUrl,
        `refs/heads/${defaultBranch}:refs/source-authority/target`,
      ],
      { encoding: 'utf8', shell: false, timeout: 120_000 },
    );
    const { stdout: fetchedCommitOutput } = await execFn(
      'git',
      ['-C', tempRoot, 'rev-parse', 'refs/source-authority/target'],
      { encoding: 'utf8', shell: false, timeout: 30_000 },
    );
    const observedCommit = String(fetchedCommitOutput).trim();
    const { stdout: treeOutput } = await execFn(
      'git',
      ['-C', tempRoot, 'ls-tree', '-r', '-z', 'refs/source-authority/target'],
      { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, shell: false, timeout: 30_000 },
    );
    const tree = parseLsTree(treeOutput);
    const mismatchedPaths = [];
    for (const expected of closure.entries) {
      const actual = tree.get(expected.path);
      if (!actual || actual.type !== 'blob' || actual.mode !== expected.mode) {
        mismatchedPaths.push(expected.path);
        continue;
      }
      const { stdout: content } = await execFn(
        'git',
        ['-C', tempRoot, 'cat-file', 'blob', actual.objectId],
        { encoding: null, maxBuffer: 64 * 1024 * 1024, shell: false, timeout: 30_000 },
      );
      const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content);
      if (sha256Hex(bytes) !== expected.digest) mismatchedPaths.push(expected.path);
    }
    return mismatchedPaths.length > 0
      ? mismatch(defaultBranch, mismatchedPaths)
      : {
          passed: true,
          observation: {
            defaultBranch,
            entryCount: closure.entries.length,
            observedCommit,
            sourceRepository,
          },
        };
  } catch (error) {
    return failure(REMOTE_UNAVAILABLE, `cannot read remote source tree: ${error.message}`);
  } finally {
    await rm(tempRoot, { force: true, recursive: true });
  }
}

function parseLsTree(output) {
  const result = new Map();
  for (const record of String(output).split('\0').filter(Boolean)) {
    const match = record.match(/^([0-9]{6}) ([a-z]+) ([0-9a-f]{40,64})\t(.+)$/u);
    if (!match) continue;
    result.set(match[4], {
      mode: match[1],
      objectId: match[3],
      type: match[2],
    });
  }
  return result;
}

function mismatch(defaultBranch, paths) {
  const uniquePaths = [...new Set(paths)].sort();
  return {
    passed: false,
    error: {
      code: CONTENT_MISMATCH,
      message: `remote default branch "${defaultBranch}" differs from ${uniquePaths.length} frozen source input(s)`,
      paths: uniquePaths,
    },
  };
}

function failure(code, message) {
  return { passed: false, error: { code, message } };
}

/** Validate a publish receipt against the frozen plan authority. */
export function verifySourceAuthorityReceipt({ plan, run }) {
  const authority = plan.sourceAuthority;
  if (!authority) return { passed: true };
  const matching = (run.sourceAuthorityReceipts ?? []).find((receipt) => (
    receipt.sourceRepository === authority.sourceRepository
    && receipt.defaultBranch === authority.defaultBranch
    && receipt.inputDigest === authority.inputDigest
    && receipt.algorithmVersion === authority.algorithmVersion
    && receipt.entryCount === authority.entries.length
    && receipt.planDigest === plan.digest
    && receipt.result === 'CONSISTENT'
  ));
  return matching
    ? { passed: true, receipt: matching }
    : {
        passed: false,
        reason: 'publish run has no CONSISTENT source-authority receipt bound to this plan digest',
      };
}

/** Create the digest-bound receipt persisted by publish. */
export function createSourceAuthorityReceipt({
  plan,
  result,
  observation,
  mismatchedPaths,
  clock = () => new Date().toISOString(),
}) {
  const authority = plan.sourceAuthority;
  return {
    algorithmVersion: authority.algorithmVersion,
    defaultBranch: authority.defaultBranch,
    entryCount: authority.entries.length,
    inputDigest: authority.inputDigest,
    planDigest: plan.digest,
    result,
    sourceRepository: authority.sourceRepository,
    verifiedAt: clock(),
    ...(observation?.observedCommit ? { observedCommit: observation.observedCommit } : {}),
    ...(mismatchedPaths?.length ? { mismatchedPaths: [...new Set(mismatchedPaths)].sort() } : {}),
  };
}
