/**
 * Shared downstream git-write lifecycle for R4 write-downstream presets
 * (marketplace-registry-entry, docs-refresh; design §2.5/§2.6).
 *
 * Both presets update an EXISTING downstream repository and push the result.
 * They share one lifecycle so the safety semantics can never drift:
 *
 * - addressing (§2.5 dual addressing): `target.remoteUrl` clones a fresh
 *   worktree (zero local layout assumptions); `target.workspace` reuses a
 *   local checkout in place after the §2.6 execution checks (preflight
 *   realpath, TOCTOU re-check, release-workspace/runtime exclusion) and a
 *   checked-out-branch guard;
 * - observe-before-write: the staged tree is compared against the branch tip
 *   AFTER the preset's mutation; identical -> NO_CHANGE (no commit, no push,
 *   no gates — an idempotent repeat reports honestly);
 * - downstream gates (argument arrays, the R1 hook runner) run inside the
 *   worktree AFTER the mutation and BEFORE any commit/push; a non-zero gate
 *   fails closed with zero remote side effects;
 * - commit uses the frozen bot identity injected per-command (`git -c
 *   user.name=… -c user.email=…`, never touching global git config); the push
 *   is plain (NEVER --force); GIT_TERMINAL_PROMPT=0 everywhere — the host
 *   credential helper answers or delivery fails fast; credentials are never
 *   read, printed, or retried;
 * - after a push, `git ls-remote` cross-checks the branch tip (review N-3).
 *
 * @module core/preset-gitwrite
 */

import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  ReleaseError,
  GATE_FAILED,
  REMOTE_CONFLICT,
  REMOTE_UNAVAILABLE,
  POST_PUBLISH_VERIFY_FAILED,
} from './errors.mjs';
import { preflightPresetWorkspace, assertPresetWorkspaceExecution } from './presets.mjs';
import { POSTPUBLISH_CONTEXT_ENV } from './postpublish.mjs';

const execFileAsync = promisify(execFileCb);

const GIT_TIMEOUT_MS = 120_000;
const TRANSFER_TIMEOUT_MS = 300_000;
const PROBE_TIMEOUT_MS = 30_000;
const TMP_PREFIX = 'release-skill-preset-write-';

const SAFE_REMOTE_URL_RE = /^(?:https?|file):\/\/.+\.git$/;
const SAFE_BRANCH_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;
const SHA_RE = /^[a-f0-9]{40}$/;

/** Credential hygiene: git is never allowed to prompt. */
const NEVER_PROMPT_ENV = { GIT_TERMINAL_PROMPT: '0' };

const AUTH_FAILURE_PATTERNS = [
  /authentication failed/i,
  /could not read username/i,
  /could not read password/i,
  /terminal prompts disabled/i,
  /invalid username or password/i,
  /permission denied/i,
  /access denied/i,
  /authorization failed/i,
  /\b403\b/,
  /\b401\b/,
];

const TRANSPORT_FAILURE_PATTERNS = [
  /could not resolve host/i,
  /unable to access/i,
  /connection refused/i,
  /connection timed out/i,
  /operation timed out/i,
  /network is unreachable/i,
  /ssl certificate problem/i,
  /could not resolve proxy/i,
  /failed to connect/i,
];

function defaultExec(command, args, options = {}) {
  return execFileAsync(command, args, { shell: false, encoding: 'utf8', timeout: GIT_TIMEOUT_MS, ...options });
}

function netEnv() {
  return { ...process.env, ...NEVER_PROMPT_ENV };
}

function hasControlChars(value) {
  return /[\x00-\x1f\x7f]/.test(value);
}

function assertSafeRemoteUrl(remoteUrl) {
  if (typeof remoteUrl !== 'string' || !SAFE_REMOTE_URL_RE.test(remoteUrl) || hasControlChars(remoteUrl)) {
    throw new ReleaseError(GATE_FAILED, 'preset downstream remoteUrl must be an http(s)/file URL ending in .git', { remoteUrl });
  }
}

function assertSafeBranch(branch) {
  if (typeof branch !== 'string' || !SAFE_BRANCH_RE.test(branch)
    || branch.includes('..') || branch.endsWith('.') || branch.endsWith('.lock')) {
    throw new ReleaseError(GATE_FAILED, 'preset downstream branch is not a safe Git branch name', { branch });
  }
}

function assertCommitIdentity(identity) {
  if (!identity || typeof identity !== 'object') {
    throw new ReleaseError(GATE_FAILED, 'preset downstream write requires a frozen commitIdentity');
  }
  for (const field of ['name', 'email']) {
    const value = identity[field];
    if (typeof value !== 'string' || value.length === 0 || value.startsWith('-') || hasControlChars(value)) {
      throw new ReleaseError(GATE_FAILED, `preset downstream commitIdentity.${field} is missing or unsafe`, { field });
    }
  }
}

function stderrText(error) {
  return `${error?.stderr ?? ''}\n${error?.message ?? ''}`;
}

function stderrTail(error, limit = 400) {
  const text = stderrText(error).trim();
  return text.length > limit ? `…${text.slice(-limit)}` : text;
}

function classifyNetFailure(text) {
  const output = typeof text === 'string' ? text : '';
  if (AUTH_FAILURE_PATTERNS.some((pattern) => pattern.test(output))) return 'auth';
  return 'transport';
}

function parseLsRemote(stdout) {
  const refs = new Map();
  for (const line of `${stdout ?? ''}`.trim().split('\n').filter(Boolean)) {
    const tabIndex = line.indexOf('\t');
    if (tabIndex < 0) continue;
    const sha = line.slice(0, tabIndex);
    const ref = line.slice(tabIndex + 1);
    if (!SHA_RE.test(sha)) continue;
    if (ref.endsWith('^{}')) {
      refs.set(ref.slice(0, -3), sha);
    } else if (!refs.has(ref)) {
      refs.set(ref, sha);
    }
  }
  return refs;
}

/**
 * Cross-check that a downstream branch tip equals the pushed commit
 * (review N-3). Fails closed on mismatch or a missing ref.
 *
 * @param {Function} exec - Git exec (argument arrays only).
 * @param {string} remoteUrl
 * @param {string} branch
 * @param {string} pushedCommit - Full 40-hex commit sha.
 * @returns {Promise<string>} The observed branch tip.
 */
export async function crossCheckBranchTip(exec, remoteUrl, branch, pushedCommit) {
  assertSafeRemoteUrl(remoteUrl);
  assertSafeBranch(branch);
  if (typeof pushedCommit !== 'string' || !SHA_RE.test(pushedCommit)) {
    throw new ReleaseError(GATE_FAILED, 'cross-check requires the full 40-hex pushed commit', { pushedCommit });
  }
  const execFn = typeof exec === 'function' ? exec : defaultExec;
  const { stdout } = await execFn('git', ['ls-remote', remoteUrl, `refs/heads/${branch}`], {
    env: netEnv(),
    timeout: PROBE_TIMEOUT_MS,
    shell: false,
  });
  const observed = parseLsRemote(stdout).get(`refs/heads/${branch}`) ?? null;
  if (observed !== pushedCommit) {
    throw new ReleaseError(
      POST_PUBLISH_VERIFY_FAILED,
      `post-push cross-check failed: downstream branch ${branch} is at ${observed ?? '<missing>'}, which disagrees with the pushed commit ${pushedCommit}`,
      { remoteUrl, branch, pushedCommit, observed },
    );
  }
  return observed;
}

/**
 * Apply one preset mutation to a downstream git repository and push it.
 *
 * Lifecycle: resolve worktree (clone or workspace) -> checkout/verify branch
 * -> `mutate(worktree)` -> stage + NO_CHANGE detection -> run `gates` ->
 * commit (frozen identity) -> push (never --force) -> ls-remote cross-check.
 *
 * @param {object} params
 * @param {object} params.target - { remoteUrl? XOR workspace?, branch }.
 * @param {object} params.commitIdentity - Frozen { name, email }.
 * @param {string} params.commitSubject - Deterministic commit subject.
 * @param {(worktree: string) => Promise<void>} params.mutate - Writes the
 *   preset's files into the worktree.
 * @param {object[]} [params.gates] - Downstream gates (argument arrays).
 * @param {object} [params.contextProjection] - Injected into gate env.
 * @param {string} params.root - Release workspace root (workspace addressing).
 * @param {Function} [params.exec] - Injectable git exec (tests).
 * @param {Function} [params.hookRunner] - Injectable gate runner (tests).
 * @returns {Promise<{ status: 'EXECUTED'|'NO_CHANGE', observation: object }>}
 *   The observation carries `workspaceRealpath` for workspace addressing
 *   (§2.6 evidence, R4 review m-2) and `crossCheck: { status: 'skipped',
 *   reason }` when the post-push ls-remote cross-check could not run
 *   (R4 review m-4; a performed cross-check leaves no note).
 */
export async function applyDownstreamGitChange(params) {
  const {
    target,
    commitIdentity,
    commitSubject,
    mutate,
    gates = [],
    contextProjection,
    root,
    exec: execOpt,
    hookRunner,
  } = params ?? {};
  if (!target || typeof target !== 'object') {
    throw new ReleaseError(GATE_FAILED, 'preset downstream write requires a config.target');
  }
  assertSafeBranch(target.branch);
  assertCommitIdentity(commitIdentity);
  if (typeof mutate !== 'function') {
    throw new ReleaseError(GATE_FAILED, 'preset downstream write requires a mutate function');
  }
  const exec = typeof execOpt === 'function' ? execOpt : defaultExec;
  const runGate = typeof hookRunner === 'function' ? hookRunner : defaultRunGate;

  const hasRemoteUrl = typeof target.remoteUrl === 'string';
  const hasWorkspace = typeof target.workspace === 'string';
  if (hasRemoteUrl === hasWorkspace) {
    throw new ReleaseError(GATE_FAILED, 'preset downstream target must declare exactly one of remoteUrl or workspace');
  }

  let worktree = null;
  let isClone = false;
  let previousHead = null;
  // §2.6 execution realpath (workspace addressing only): returned in the
  // observation so the saga evidence records WHERE the write landed
  // (R4 review m-2). Clone addressing uses a fresh tmpdir with no meaning
  // after cleanup, so it stays null there.
  let workspaceRealpath = null;

  if (hasRemoteUrl) {
    assertSafeRemoteUrl(target.remoteUrl);
    worktree = await mkdtemp(join(tmpdir(), TMP_PREFIX));
    isClone = true;
    try {
      await exec('git', ['clone', '--quiet', target.remoteUrl, worktree], {
        env: netEnv(),
        timeout: TRANSFER_TIMEOUT_MS,
        shell: false,
      });
    } catch (error) {
      await rm(worktree, { recursive: true, force: true }).catch(() => {});
      const classification = classifyNetFailure(stderrText(error));
      throw new ReleaseError(
        classification === 'auth' ? REMOTE_CONFLICT : REMOTE_UNAVAILABLE,
        classification === 'auth'
          ? `preset downstream remote refused authentication for ${target.remoteUrl}; the host keychain credential is reused and never prompted, read, or retried`
          : `cannot reach preset downstream remote ${target.remoteUrl} — start VPN / check network; delivery fails closed and never retries with credentials`,
        { remoteUrl: target.remoteUrl, stderrTail: stderrTail(error) },
      );
    }
    // Continue the declared branch when it exists; start a root commit otherwise.
    try {
      const { stdout } = await exec('git', ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${target.branch}`], { cwd: worktree, shell: false });
      previousHead = stdout.trim() || null;
    } catch {
      previousHead = null;
    }
    if (previousHead) {
      await exec('git', ['checkout', '--quiet', '-B', target.branch, previousHead], { cwd: worktree, shell: false });
    } else {
      await exec('git', ['checkout', '--quiet', '--orphan', target.branch], { cwd: worktree, shell: false });
    }
  } else {
    // Workspace addressing: §2.6 execution checks + a branch guard. The
    // checkout is used in place (no clone); the branch is never switched.
    const preflight = await preflightPresetWorkspace(target.workspace, { root });
    const execution = await assertPresetWorkspaceExecution(target.workspace, {
      root,
      preflightRealpath: preflight.realpath,
    });
    worktree = execution.realpath;
    workspaceRealpath = execution.realpath;
    let headRef = '';
    try {
      const { stdout } = await exec('git', ['symbolic-ref', '--quiet', 'HEAD'], { cwd: worktree, shell: false });
      headRef = `${stdout}`.trim();
    } catch {
      headRef = '';
    }
    if (headRef !== `refs/heads/${target.branch}`) {
      throw new ReleaseError(
        GATE_FAILED,
        `preset downstream workspace must be checked out on branch "${target.branch}", but HEAD is at "${headRef || '<detached>'}"; check out the branch and rerun`,
        { workspace: worktree, branch: target.branch, headRef: headRef || null },
      );
    }
    try {
      const { stdout } = await exec('git', ['rev-parse', '--verify', '--quiet', 'HEAD'], { cwd: worktree, shell: false });
      previousHead = stdout.trim() || null;
    } catch {
      previousHead = null;
    }
    // Clean-tree requirement: the preset stages with `git add -A`, so a dirty
    // checkout would sweep unrelated user work into the downstream commit.
    // Fail closed for human decision instead.
    const { stdout: dirtyOut } = await exec('git', ['status', '--porcelain'], { cwd: worktree, shell: false });
    if (`${dirtyOut}`.trim().length > 0) {
      throw new ReleaseError(
        GATE_FAILED,
        'preset downstream workspace has uncommitted changes; the preset would have to stage them alongside its own write — commit or stash the local work and rerun',
        { workspace: worktree },
      );
    }
  }

  try {
    const git = (args, options = {}) => exec('git', args, { cwd: worktree, shell: false, timeout: GIT_TIMEOUT_MS, ...options });

    // Preset mutation.
    await mutate(worktree);

    // Stage and detect NO_CHANGE against the branch tip.
    await git(['add', '-A']);
    const noChange = await git(['status', '--porcelain'])
      .then(({ stdout }) => stdout.trim().length === 0)
      .catch(() => false);
    if (noChange) {
      return {
        status: 'NO_CHANGE',
        observation: {
          mode: 'no-change',
          previousHead,
          branchTip: previousHead,
          ...(workspaceRealpath ? { workspaceRealpath } : {}),
        },
      };
    }

    // Downstream gates run BEFORE any commit/push; a failure leaves zero
    // remote side effects (the staged change is discarded with the clone or
    // reset in the workspace).
    for (const [index, gate] of gates.entries()) {
      let gateResult;
      try {
        gateResult = await runGate(
          {
            command: gate.command,
            ...(gate.cwd ? { cwd: gate.cwd } : {}),
            ...(gate.timeoutMs !== undefined ? { timeoutMs: gate.timeoutMs } : {}),
            ...(gate.envAllowlist ? { envAllowlist: gate.envAllowlist } : {}),
          },
          {
            root: worktree,
            env: process.env,
            injectEnv: contextProjection !== undefined
              ? { [POSTPUBLISH_CONTEXT_ENV]: JSON.stringify(contextProjection) }
              : {},
          },
        );
      } catch (err) {
        // Reset the staged change so a workspace is left clean on failure.
        await git(['reset', '--quiet']).catch(() => {});
        const code = err?.code === 'HOOK_TIMEOUT' ? 'HOOK_TIMEOUT' : GATE_FAILED;
        throw new ReleaseError(
          code === 'HOOK_TIMEOUT' ? GATE_FAILED : code,
          `downstream gate ${index + 1} timed out or could not run: ${err?.message ?? err}`,
          { gateIndex: index },
        );
      }
      if (gateResult.exitCode !== 0) {
        await git(['reset', '--quiet']).catch(() => {});
        throw new ReleaseError(
          GATE_FAILED,
          `downstream gate ${index + 1} failed with exit code ${gateResult.exitCode}; the downstream change was not committed or pushed`,
          { gateIndex: index, exitCode: gateResult.exitCode },
        );
      }
    }

    // Commit with the frozen bot identity, then push (NEVER --force).
    await git([
      '-c', `user.name=${commitIdentity.name}`,
      '-c', `user.email=${commitIdentity.email}`,
      'commit', '--quiet', '-m', commitSubject,
    ]);
    const { stdout: headOut } = await git(['rev-parse', 'HEAD']);
    const localCommit = headOut.trim();

    try {
      await exec('git', ['push', '--quiet', 'origin', target.branch], {
        cwd: worktree,
        env: netEnv(),
        timeout: TRANSFER_TIMEOUT_MS,
        shell: false,
      });
    } catch (error) {
      const classification = classifyNetFailure(stderrText(error));
      throw new ReleaseError(
        classification === 'auth' ? REMOTE_CONFLICT : REMOTE_UNAVAILABLE,
        classification === 'auth'
          ? `preset downstream push refused authentication for ${target.remoteUrl ?? target.workspace}; the host keychain credential is reused and never prompted, read, or retried`
          : `preset downstream push to ${target.remoteUrl ?? target.workspace} failed — start VPN / check network; delivery fails closed and never retries with credentials`,
        { branch: target.branch, stderrTail: stderrTail(error) },
      );
    }

    // Cross-check the pushed branch tip (review N-3). Workspace addressing
    // resolves the checkout's origin URL; clone addressing uses the target.
    // A skip is NEVER silent (R4 review m-4): an unresolvable or
    // non-http(s)/file origin (SSH etc.) records crossCheck skipped + reason
    // in the observation, so the evidence shows the verification gap.
    let crossCheckUrl = target.remoteUrl;
    let crossCheckSkipReason = null;
    if (!hasRemoteUrl) {
      try {
        const { stdout } = await git(['remote', 'get-url', 'origin']);
        crossCheckUrl = stdout.trim();
      } catch {
        crossCheckUrl = null;
      }
      if (!crossCheckUrl) {
        crossCheckSkipReason =
          'workspace checkout declares no origin remote; the post-push ls-remote cross-check needs a remote URL';
      } else if (!SAFE_REMOTE_URL_RE.test(crossCheckUrl)) {
        crossCheckSkipReason =
          'workspace origin URL is not an http(s)/file URL (SSH and other transports are outside the ls-remote cross-check policy); post-push cross-check skipped';
      }
    }
    if (crossCheckUrl && SAFE_REMOTE_URL_RE.test(crossCheckUrl)) {
      await crossCheckBranchTip(exec, crossCheckUrl, target.branch, localCommit);
    }

    return {
      status: 'EXECUTED',
      observation: {
        mode: 'pushed',
        pushedCommit: localCommit,
        previousHead,
        branchTip: localCommit,
        ...(workspaceRealpath ? { workspaceRealpath } : {}),
        ...(crossCheckSkipReason ? { crossCheck: { status: 'skipped', reason: crossCheckSkipReason } } : {}),
      },
    };
  } finally {
    if (isClone) {
      await rm(worktree, { recursive: true, force: true }).catch(() => {});
    }
  }
}

/** Default gate runner: delegates to the R1 hook runner (core/hooks.mjs). */
async function defaultRunGate(gate, context) {
  const { runHook } = await import('./hooks.mjs');
  return runHook(gate, context);
}
