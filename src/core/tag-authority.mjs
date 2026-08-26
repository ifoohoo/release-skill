/**
 * Frozen tag authority for distribute/postverify (R-01, WP-5).
 *
 * The LIVE LOCAL TAG IS DIAGNOSTIC ONLY. The authority chain for the frozen
 * tag identity is, in order:
 *   1. the frozen plan's create-tag action (repo/githubHost/tag/commit/
 *      gitObjectDir parameters) — FROZEN_TAG_BINDING_MISSING when absent;
 *   2. the same-lineage PUBLISHED publish/reconcile source run carrying a
 *      succeeded (or skipped) create-tag checkpoint for that action id —
 *      FROZEN_TAG_LINEAGE_MISSING when absent (a verify receipt never
 *      substitutes for the publish proof);
 *   3. the frozen git object directory (bare repo) containing the frozen
 *      commit — FROZEN_TAG_OBJECTS_MISSING when missing;
 *   4. the public remote observation (ls-remote) — REMOTE_TAG_MISSING /
 *      REMOTE_TAG_DRIFT conflict (human decision, fail closed), or
 *      REMOTE_UNAVAILABLE when the observation itself fails.
 *
 * The local tag in the source repo is read AFTER the authority chain for
 * diagnostics only (`localTagPresent`/`localTagCommit`/`localTagDrifted`);
 * it can never block or advance the release.
 *
 * Worktrees are built from a COPY of the frozen bare repo so the frozen
 * objects are never checked out in place and the source repository's
 * worktree metadata is never touched.
 *
 * @module core/tag-authority
 */

import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ReleaseError, GATE_FAILED, REMOTE_CONFLICT, REMOTE_UNAVAILABLE } from './errors.mjs';
import { resolveFrozenPath, verifyFrozenDirectoryStructure } from '../snapshot/frozen.mjs';
import { githubRepositoryUrl } from '../adapters/push-snapshot.mjs';
import { parseExternalMarketplaceLsRemote } from '../commands/prepare.mjs';

/** Plan action type of the frozen create-tag binding. */
const CREATE_TAG_TYPES = new Set(['create-tag', 'git-tag']);

/** Lineage checkpoint statuses that prove the tag was actually published. */
const PROVEN_LINEAGE_STATUSES = new Set(['succeeded', 'skipped']);

function authorityError(code, message, reason, details = {}) {
  return new ReleaseError(code, message, { ...details, reason });
}

/**
 * Resolve the frozen tag authority for one release unit.
 *
 * @param {Object} input
 * @param {Object} input.plan - The frozen release plan.
 * @param {string} input.unitId - The release unit id.
 * @param {Object} input.sourceRun - The same-lineage PUBLISHED
 *   publish/reconcile source run record (release-run.json shape with
 *   `checkpoints`).
 * @param {string} input.root - Project root.
 * @param {Function} input.exec - `execFile`-shaped runner used for local git.
 * @param {Function} [input.observeTagFn] - `(tag, {repo, githubHost}) =>
 *   Promise<string>` remote tag observation (ls-remote). Defaults to a
 *   file/git ls-remote over `githubRepositoryUrl`.
 * @param {Function} [input.observeBranchFn] - `(branch, {repo, githubHost}) =>
 *   Promise<string>` remote branch observation (ls-remote). Only invoked
 *   when `observeMainLine` is true.
 * @param {boolean} [input.observeMainLine] - Observe the public main-line
 *   branch (explicitly-enabled optional gate only; false means no branch
 *   observation happens at all).
 * @returns {Promise<Object>} Resolved authority:
 *   `{tag, commit, repo, githubHost, gitDir, remoteUrl, observedRemoteTag,
 *     localTagPresent, localTagCommit, localTagDrifted, branch, branchCommit}`.
 * @throws {ReleaseError} GATE_FAILED (binding/objects/lineage missing) or
 *   REMOTE_CONFLICT / REMOTE_UNAVAILABLE (remote observation).
 */
export async function resolveFrozenTagAuthority({
  plan,
  unitId,
  sourceRun,
  root,
  exec,
  observeTagFn,
  observeBranchFn,
  observeMainLine = false,
}) {
  // 1. Frozen plan binding.
  const actions = Array.isArray(plan?.externalActions) ? plan.externalActions : [];
  const action = actions.find(
    (a) => a && a.unitId === unitId && CREATE_TAG_TYPES.has(a.type ?? a.actionType),
  );
  if (!action) {
    throw authorityError(
      GATE_FAILED,
      `frozen create-tag binding is missing for unit "${unitId}"`,
      'FROZEN_TAG_BINDING_MISSING',
      { unitId },
    );
  }
  const tag = action.parameters?.tag;
  const commit = action.parameters?.commit;
  const repo = action.parameters?.repo;
  const githubHost = action.parameters?.githubHost ?? 'github.com';
  if (!tag || !commit || !repo) {
    throw authorityError(
      GATE_FAILED,
      `frozen create-tag binding is incomplete for unit "${unitId}"`,
      'FROZEN_TAG_BINDING_MISSING',
      { unitId, tag, repo },
    );
  }

  // 2. Same-lineage source run proof.
  const checkpoints = Array.isArray(sourceRun?.checkpoints) ? sourceRun.checkpoints : [];
  const lineage = checkpoints.find(
    (cp) => cp && cp.actionId === action.id
      && cp.actionType === (action.type ?? action.actionType)
      && PROVEN_LINEAGE_STATUSES.has(cp.status),
  );
  if (!lineage) {
    throw authorityError(
      GATE_FAILED,
      `no succeeded create-tag lineage checkpoint for action "${action.id}" in the source run`,
      'FROZEN_TAG_LINEAGE_MISSING',
      { actionId: action.id, sourceRunId: sourceRun?.runId ?? null },
    );
  }

  // 3. Frozen git object directory containing the frozen commit.
  let gitDir;
  try {
    gitDir = await resolveFrozenPath(root, action.parameters.gitObjectDir, 'frozen git object directory');
    await verifyFrozenDirectoryStructure(gitDir, 'frozen git object directory');
    // cat-file -e verifies EXISTENCE (rev-parse alone would echo any 40-hex
    // string back without proving the object is present).
    await exec(
      'git',
      ['--git-dir', gitDir, 'cat-file', '-e', `${commit}^{commit}`],
      { shell: false, encoding: 'utf8' },
    );
  } catch (cause) {
    throw authorityError(
      GATE_FAILED,
      'frozen git objects are missing or incomplete; the tag identity cannot be verified',
      'FROZEN_TAG_OBJECTS_MISSING',
      { gitObjectDir: action.parameters.gitObjectDir, tag, commit },
      // preserve the underlying frozen-path cause for diagnostics
    );
  }

  // 4. Public remote observation (the authoritative tag state). The frozen
  // plan pins the observation endpoint like it pins gitObjectDir: when the
  // create-tag action carries an explicit `parameters.remoteUrl` (digest-
  // bound), that endpoint is observed; otherwise the endpoint derives from
  // repo/githubHost.
  const remoteUrl = action.parameters.remoteUrl ?? githubRepositoryUrl(repo, githubHost);
  const observeTag = observeTagFn ?? defaultObserveTagFn;
  let observedRemoteTag;
  try {
    observedRemoteTag = await observeTag(tag, { repo, githubHost, remoteUrl });
  } catch (cause) {
    throw authorityError(
      REMOTE_UNAVAILABLE,
      `cannot observe the public remote tag ${tag} in ${repo}`,
      'REMOTE_UNAVAILABLE',
      { tag, repo },
    );
  }
  if (!observedRemoteTag) {
    throw authorityError(
      REMOTE_CONFLICT,
      `remote tag ${tag} is missing in ${repo}; human decision required`,
      'REMOTE_TAG_MISSING',
      { tag, repo },
    );
  }
  if (observedRemoteTag !== commit) {
    throw authorityError(
      REMOTE_CONFLICT,
      `remote tag ${tag} drifted: observed ${observedRemoteTag}, frozen plan pins ${commit}; human decision required`,
      'REMOTE_TAG_DRIFT',
      { tag, repo, observedRemoteTag, frozenCommit: commit },
    );
  }

  // 5. Local tag diagnostics (source repo) — diagnostic only, never authority.
  let localTagPresent = false;
  let localTagCommit = null;
  try {
    const { stdout } = await exec(
      'git',
      ['-C', root, 'rev-parse', `refs/tags/${tag}`],
      { shell: false, encoding: 'utf8' },
    );
    localTagPresent = true;
    localTagCommit = stdout.trim() || null;
  } catch {
    // No local tag in the source repo — legitimate for a fresh split repo.
    localTagPresent = false;
    localTagCommit = null;
  }
  const localTagDrifted = localTagPresent && localTagCommit !== commit;

  // 6. Main-line branch observation — ONLY for the explicitly-enabled
  //    optional assertMainVersionAhead gate (裁决 15: with the gate off, no
  //    main-line observation is required or performed).
  let branch = null;
  let branchCommit = null;
  if (observeMainLine === true) {
    const observeBranch = observeBranchFn ?? defaultObserveBranchFn;
    try {
      // Public HEAD is the existing remote default-branch authority. The
      // frozen snapshot branch names the release, not the public main line.
      const { stdout } = await exec('git', ['ls-remote', '--symref', remoteUrl, 'HEAD'], {
        shell: false, encoding: 'utf8', timeout: 30_000,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      });
      branch = parseExternalMarketplaceLsRemote(stdout)?.defaultBranch ?? null;
      if (!branch) throw new Error('public default branch is unobservable');
      branchCommit = await observeBranch(branch, { repo, githubHost, remoteUrl });
    } catch {
      // Unobservable branch stays null; assertMainLineAhead fails closed.
      branchCommit = null;
    }
  }

  return {
    tag,
    commit,
    repo,
    githubHost,
    gitDir,
    remoteUrl,
    observedRemoteTag,
    localTagPresent,
    localTagCommit,
    localTagDrifted,
    branch,
    branchCommit,
  };
}

/** Default remote tag observation via `git ls-remote --tags`. */
async function defaultObserveTagFn(tag, { remoteUrl }) {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const exec = promisify(execFile);
  const { stdout } = await exec(
    'git',
    ['ls-remote', '--tags', remoteUrl, `refs/tags/${tag}`],
    { shell: false, encoding: 'utf8', timeout: 120_000 },
  );
  return stdout.trim().split(/\s+/)[0] ?? '';
}

/** Default remote branch observation via `git ls-remote --heads`. */
async function defaultObserveBranchFn(branch, { remoteUrl }) {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const exec = promisify(execFile);
  const { stdout } = await exec(
    'git',
    ['ls-remote', '--heads', remoteUrl, `refs/heads/${branch}`],
    { shell: false, encoding: 'utf8', timeout: 120_000 },
  );
  return stdout.trim().split(/\s+/)[0] ?? '';
}

/**
 * Build a detached worktree from a COPY of the frozen bare repo.
 *
 * The frozen objects are never checked out in place: the bare repo is copied
 * under `tmpBase`, then `checkout --detach` materializes the frozen commit
 * tree into a separate worktree directory. The source repository's worktree
 * metadata is never touched.
 *
 * @param {Object} input
 * @param {string} input.gitDir - Frozen bare repo (authority.gitDir).
 * @param {string} input.commit - The frozen commit to materialize.
 * @param {string} input.tmpBase - Scratch base directory for the copy and
 *   the worktree (caller-owned cleanup scope).
 * @param {Function} input.exec - `execFile`-shaped runner.
 * @returns {Promise<{worktreePath: string, gitCopyPath: string}>}
 */
export async function createFrozenTagWorktree({ gitDir, commit, tmpBase, exec }) {
  await mkdir(tmpBase, { recursive: true });
  const stamp = Date.now();
  const gitCopyPath = join(tmpBase, `frozen-${stamp}-copy.git`);
  const worktreePath = join(tmpBase, `frozen-${stamp}-wt`);
  await cp(gitDir, gitCopyPath, { recursive: true });
  await mkdir(worktreePath, { recursive: true });
  // T01 (裁决 13): the frozen repo is BARE (core.bare=true). A `.git` file
  // pointing at a bare git dir makes every in-worktree git invocation answer
  // "this operation must be run in a work tree" and `--is-inside-work-tree`
  // false, so hooks cannot run. The COPY is scratch (tmpBase-owned), so its
  // configuration may be rewritten: mark the copy non-bare so the linked
  // worktree below behaves like a real checkout. The frozen repo and the
  // source repo are never touched.
  await exec(
    'git',
    ['--git-dir', gitCopyPath, 'config', 'core.bare', 'false'],
    { shell: false, encoding: 'utf8' },
  );
  // Standard git worktree linkage: a `.git` file pointing at the git dir, so
  // any git invocation from INSIDE the worktree (hooks, fixtures, `git
  // rev-parse HEAD`) resolves against the frozen copy. Plain
  // `--git-dir/--work-tree checkout` would leave the worktree without git
  // metadata, and `git worktree add` would touch the source repo's worktree
  // registry — this file gives consumers the former without the latter.
  await writeFile(join(worktreePath, '.git'), `gitdir: ${gitCopyPath}\n`, 'utf8');
  await exec(
    'git',
    ['--git-dir', gitCopyPath, '--work-tree', worktreePath, 'checkout', '--detach', commit],
    { shell: false, encoding: 'utf8' },
  );
  return { worktreePath, gitCopyPath };
}

/**
 * Verify ancestry in one git object directory: `ancestor` is an ancestor of
 * `descendant`.
 *
 * @returns {Promise<boolean|undefined>} true (ancestor), false (not an
 *   ancestor — both objects present), undefined (objects insufficient:
 *   missing revision or any other git failure).
 */
async function isAncestorIn(gitDir, ancestor, descendant, exec) {
  try {
    await exec(
      'git',
      ['--git-dir', gitDir, 'merge-base', '--is-ancestor', ancestor, descendant],
      { shell: false, encoding: 'utf8' },
    );
    return true;
  } catch (err) {
    if (Number(err?.code) === 1) return false; // both present, not an ancestor
    return undefined; // missing objects (128) or any other failure
  }
}

/**
 * Assert the public main line has moved AHEAD of the frozen tag commit.
 *
 * 裁决 15 domain semantics: the frozen tag commit must be an ANCESTOR of the
 * observed public main-line commit AND the two must differ. "A different
 * sha" is never accepted as proof of being ahead: behind, diverged, equal,
 * unobservable and objects-insufficient observations all fail closed.
 *
 * Verification uses, in order:
 *   1. the frozen git object directory (no network); then
 *   2. when the frozen objects cannot decide, one narrow, single-purpose
 *      fetch of the public main branch into a scratch copy of the frozen
 *      objects (temp-managed, discarded immediately — never the frozen repo,
 *      never the public remote, and never a standing fetch/history cache).
 *
 * @param {Object} input
 * @param {string} input.tagCommit - The frozen tag commit.
 * @param {string} input.branchCommit - Observed public main-line commit.
 * @param {string} input.branch - The observed branch name (diagnostics).
 * @param {string} input.gitDir - Frozen git object directory (read-only).
 * @param {string} input.remoteUrl - Public remote pinned by the frozen plan.
 * @param {Function} input.exec - `execFile`-shaped runner.
 * @returns {Promise<void>}
 * @throws {ReleaseError} GATE_FAILED when the branch has not moved ahead
 *   (reason: MAIN_LINE_UNOBSERVED / MAIN_LINE_EQUAL / MAIN_LINE_NOT_AHEAD /
 *   MAIN_LINE_OBJECTS_INSUFFICIENT).
 */
export async function assertMainLineAhead({
  tagCommit,
  branchCommit,
  branch,
  gitDir,
  remoteUrl,
  exec,
}) {
  if (!branchCommit) {
    throw new ReleaseError(
      GATE_FAILED,
      `main line branch "${branch}" could not be observed; cannot determine whether the main line has moved ahead of the frozen tag commit`,
      { branch, tagCommit, reason: 'MAIN_LINE_UNOBSERVED' },
    );
  }
  if (branchCommit === tagCommit) {
    throw new ReleaseError(
      GATE_FAILED,
      `main line branch "${branch}" is still at the frozen tag commit; the main line has not moved ahead`,
      { branch, tagCommit, reason: 'MAIN_LINE_EQUAL' },
    );
  }

  const frozenVerdict = await isAncestorIn(gitDir, tagCommit, branchCommit, exec);
  if (frozenVerdict === true) return;
  if (frozenVerdict === false) {
    throw new ReleaseError(
      GATE_FAILED,
      `main line branch "${branch}" at ${branchCommit} is not a descendant of the frozen tag commit ${tagCommit}`,
      { branch, tagCommit, branchCommit, reason: 'MAIN_LINE_NOT_AHEAD' },
    );
  }

  // Frozen objects cannot decide (the public main advanced past the freeze):
  // narrow single-purpose fetch of the public main branch into a scratch
  // copy, then re-verify. The scratch base is temp-managed and removed in
  // the finally block; the frozen repo and the public remote are read-only.
  let scratchBase = null;
  try {
    scratchBase = await mkdtemp(join(tmpdir(), 'release-skill-mainline-'));
    const scratchGitDir = join(scratchBase, 'objects.git');
    await cp(gitDir, scratchGitDir, { recursive: true });
    // Object-only narrow fetch into FETCH_HEAD: no ref is created or updated
    // in the scratch copy, so a diverged (non-fast-forward) public main
    // cannot fail the fetch itself — the ancestry verdict below decides.
    await exec(
      'git',
      ['--git-dir', scratchGitDir, 'fetch', '--quiet', '--no-tags', remoteUrl, `refs/heads/${branch}`],
      { shell: false, encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } },
    );
    const fetchedVerdict = await isAncestorIn(scratchGitDir, tagCommit, branchCommit, exec);
    if (fetchedVerdict === true) return;
    throw new ReleaseError(
      GATE_FAILED,
      fetchedVerdict === false
        ? `main line branch "${branch}" at ${branchCommit} is not a descendant of the frozen tag commit ${tagCommit}`
        : `cannot determine whether main line branch "${branch}" is ahead of the frozen tag commit: the observed objects are insufficient`,
      {
        branch,
        tagCommit,
        branchCommit,
        reason: fetchedVerdict === false ? 'MAIN_LINE_NOT_AHEAD' : 'MAIN_LINE_OBJECTS_INSUFFICIENT',
      },
    );
  } catch (err) {
    if (err instanceof ReleaseError) throw err;
    throw new ReleaseError(
      GATE_FAILED,
      `cannot determine whether main line branch "${branch}" is ahead of the frozen tag commit: ${err?.message ?? err}`,
      {
        branch,
        tagCommit,
        branchCommit,
        reason: 'MAIN_LINE_OBJECTS_INSUFFICIENT',
        ...(err?.stderr !== undefined && err?.stderr !== null
          ? { gitStderr: String(err.stderr).slice(0, 500) }
          : {}),
      },
    );
  } finally {
    if (scratchBase) {
      await rm(scratchBase, { recursive: true, force: true }).catch(() => {});
    }
  }
}
