/**
 * proposal-inbox preset transports (v0.6.3 R3 git-push / R4 local-file,
 * design §2.5/§2.3).
 *
 * Delivers a machine-readable update proposal — the §2.3 context projection
 * plus a deterministic change summary — to a downstream repository as
 * `incoming/<unitId>-<version>.json`. The downstream consumes it on its own
 * terms (hub governance); delivery success + the deterministic manual-sync
 * prompt in evidence is the closed loop.
 *
 * git-push transport semantics (mirror the distribute-git stance):
 * - clone -> write the proposal -> commit with the frozen bot identity ->
 *   plain push (NEVER --force); GIT_TERMINAL_PROMPT=0 everywhere — the host
 *   credential helper either answers or the delivery fails fast; credentials
 *   are never read, printed, or retried;
 * - identical existing content -> NO_CHANGE (idempotent success, no write);
 * - different existing content -> REMOTE_CONFLICT (human decision required;
 *   a downstream proposal is never auto-overwritten);
 * - after a push, `git ls-remote` cross-checks the pushed commit (review N-3);
 * - the proposal document never carries payloadDir or local absolute paths.
 *
 * local-file transport semantics (R4):
 * - writes the SAME proposal document into the local checkout declared by
 *   config.target.workspace and commits ONLY that file with the frozen bot
 *   identity — but NEVER pushes (the upstream stays untouched; a human or the
 *   downstream governance completes the delivery);
 * - the §2.6 workspace execution checks apply (preflight realpath, TOCTOU
 *   re-check, release-workspace/runtime-directory exclusion), and the
 *   checkout must be on the declared branch before any write;
 * - gates reused from git-push: deterministic snapshot serialization,
 *   NO_CHANGE idempotence on identical existing content, REMOTE_CONFLICT on
 *   different existing content (never auto-overwritten).
 *
 * @module core/proposal-inbox
 */

import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  ReleaseError,
  GATE_FAILED,
  REMOTE_CONFLICT,
  REMOTE_UNAVAILABLE,
  POST_PUBLISH_VERIFY_FAILED,
} from './errors.mjs';
import { preflightPresetWorkspace, assertPresetWorkspaceExecution } from './presets.mjs';
import {
  checkGitRemoteUrl,
  describeGitRemoteUrlFailure,
  redactUrlCredentialsIfPresent,
} from './git-url-policy.mjs';
import { buildProposalDocument, proposalFileName } from './proposal-document.mjs';

export {
  PROPOSAL_SCHEMA_VERSION,
  PROPOSAL_KIND,
  buildProposalDocument,
  proposalFileName,
} from './proposal-document.mjs';

const execFileAsync = promisify(execFileCb);

const PROBE_TIMEOUT_MS = 30_000;
const GIT_TIMEOUT_MS = 120_000;
const TRANSFER_TIMEOUT_MS = 300_000;
const TMP_PREFIX = 'release-skill-proposal-';

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
  const verdict = checkGitRemoteUrl(remoteUrl);
  if (!verdict.ok) {
    throw new ReleaseError(
      GATE_FAILED,
      `proposal-inbox remoteUrl ${describeGitRemoteUrlFailure(verdict.reason)}`,
      { reason: verdict.reason },
    );
  }
}

function assertSafeBranch(branch) {
  if (typeof branch !== 'string' || !SAFE_BRANCH_RE.test(branch)
    || branch.includes('..') || branch.endsWith('.') || branch.endsWith('.lock')) {
    throw new ReleaseError(GATE_FAILED, 'proposal-inbox branch is not a safe Git branch name', { branch });
  }
}

function assertCommitIdentity(identity) {
  if (!identity || typeof identity !== 'object') {
    throw new ReleaseError(GATE_FAILED, 'proposal-inbox requires a frozen commitIdentity');
  }
  for (const field of ['name', 'email']) {
    const value = identity[field];
    if (typeof value !== 'string' || value.length === 0 || value.startsWith('-') || hasControlChars(value)) {
      throw new ReleaseError(GATE_FAILED, `proposal-inbox commitIdentity.${field} is missing or unsafe`, { field });
    }
  }
}

/** The proposal path is repository-relative and must never escape the clone. */
function assertSafeProposalPath(proposalPath) {
  if (typeof proposalPath !== 'string' || proposalPath.length === 0
    || proposalPath.startsWith('/') || proposalPath.startsWith('./')
    || proposalPath.includes('..') || proposalPath.includes('\\')
    || proposalPath.includes(':') || hasControlChars(proposalPath)) {
    throw new ReleaseError(GATE_FAILED, 'proposal path is not a safe repository-relative path', { proposalPath });
  }
}

function stderrText(error) {
  return `${error?.stderr ?? ''}\n${error?.message ?? ''}`;
}

function stderrTail(error, limit = 400) {
  const text = stderrText(error).trim();
  return text.length > limit ? `…${text.slice(-limit)}` : text;
}

/** Classify a failed network git call without ever touching credentials. */
function classifyNetFailure(text) {
  const output = typeof text === 'string' ? text : '';
  if (AUTH_FAILURE_PATTERNS.some((pattern) => pattern.test(output))) return 'auth';
  if (TRANSPORT_FAILURE_PATTERNS.some((pattern) => pattern.test(output))) return 'transport';
  return 'transport';
}

/** Parse `git ls-remote` stdout lines ("<sha>\t<ref>") into sha per ref. */
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

// ---------------------------------------------------------------------------
// Proposal document (deterministic projection of the §2.3 context)
// ---------------------------------------------------------------------------

/**
 * Deterministic manual-sync prompt (closure semantics): delivery success plus
 * this prompt in evidence IS the closed loop — downstream consumption is the
 * hub's own governance. Names the hub repo, the proposal path, and the
 * suggested manual action.
 *
 * @param {object} params - { remoteUrl, proposalPath, branch }
 * @returns {string}
 */
export function buildManualSyncPrompt({ remoteUrl, proposalPath, branch }) {
  const safeRemoteUrl = redactUrlCredentialsIfPresent(remoteUrl);
  return `manual sync required: review proposal ${proposalPath} in downstream repository ${safeRemoteUrl} (branch ${branch}); suggested action: open a pull request or apply the proposal through the downstream governance workflow`;
}

// ---------------------------------------------------------------------------
// git-push transport
// ---------------------------------------------------------------------------

/**
 * Post-push cross-check (review N-3): `git ls-remote` must confirm the branch
 * tip equals the pushed commit; any mismatch fails closed.
 *
 * @param {Function} exec - Injectable git exec (argument arrays only).
 * @param {string} remoteUrl
 * @param {string} branch
 * @param {string} pushedCommit - Full 40-hex commit sha.
 * @returns {Promise<string>} The observed branch tip.
 * @throws {ReleaseError} POST_PUBLISH_VERIFY_FAILED on mismatch/missing ref.
 */
export async function crossCheckPushedCommit(exec, remoteUrl, branch, pushedCommit) {
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
      `post-push cross-check failed: remote branch ${branch} is at ${observed ?? '<missing>'}, which disagrees with the pushed commit ${pushedCommit}`,
      { remoteUrl: redactUrlCredentialsIfPresent(remoteUrl), branch, pushedCommit, observed },
    );
  }
  return observed;
}

/**
 * Observe-before-write for the git-push transport (rework R-01): clone the
 * downstream into a fresh disposable checkout and compare any existing
 * proposal bytes with the serialized document. This is the SINGLE observation
 * implementation shared by the execution-phase delivery (observe-before-write)
 * and the full-declaration preflight (deterministic conflict detection BEFORE
 * the first external write) — no second observe algorithm or dispatch table.
 *
 * - existing identical content -> verdict 'IDENTICAL';
 * - different existing content -> REMOTE_CONFLICT (human decision), thrown
 *   from here so preflight and delivery can never drift apart;
 * - absent -> verdict 'ABSENT'.
 *
 * On success the CALLER owns `cloneDir` and must remove it (the delivery
 * continues writing/committing/pushing from that checkout; the preflight
 * discards it immediately). On any thrown failure the clone dir is already
 * removed.
 *
 * @param {object} params
 * @param {string} params.remoteUrl - Downstream repository URL.
 * @param {string} params.branch - Downstream branch.
 * @param {string} params.proposalPath - Repository-relative proposal path.
 * @param {object} params.proposalDocument - The proposal document.
 * @param {Function} [params.exec] - Injectable git exec (tests).
 * @returns {Promise<{cloneDir: string, previousHead: string|null, verdict: 'ABSENT'|'IDENTICAL'}>}
 */
export async function observeProposalInboxGitPush(params) {
  const {
    remoteUrl,
    branch,
    proposalPath,
    proposalDocument,
    exec: execOpt,
  } = params ?? {};
  assertSafeRemoteUrl(remoteUrl);
  assertSafeBranch(branch);
  assertSafeProposalPath(proposalPath);
  if (!proposalDocument || typeof proposalDocument !== 'object' || Array.isArray(proposalDocument)) {
    throw new ReleaseError(GATE_FAILED, 'proposal-inbox requires a proposal document');
  }
  const exec = typeof execOpt === 'function' ? execOpt : defaultExec;
  const serialized = `${JSON.stringify(proposalDocument, null, 2)}\n`;

  const cloneDir = await mkdtemp(join(tmpdir(), TMP_PREFIX));
  try {
    // Clone the existing downstream to continue its history (append-only).
    try {
      await exec('git', ['clone', '--quiet', remoteUrl, cloneDir], {
        env: netEnv(),
        timeout: TRANSFER_TIMEOUT_MS,
        shell: false,
      });
    } catch (error) {
      const classification = classifyNetFailure(stderrText(error));
      const safeRemoteUrl = redactUrlCredentialsIfPresent(remoteUrl);
      throw new ReleaseError(
        classification === 'auth' ? REMOTE_CONFLICT : REMOTE_UNAVAILABLE,
        classification === 'auth'
          ? `proposal-inbox remote refused authentication for ${safeRemoteUrl}; the host keychain credential is reused and never prompted, read, or retried`
          : `cannot reach proposal-inbox remote ${safeRemoteUrl} — start VPN / check network; delivery fails closed and never retries with credentials`,
        { remoteUrl: safeRemoteUrl, stderrTail: stderrTail(error) },
      );
    }

    const git = (args, options = {}) => exec('git', args, { cwd: cloneDir, shell: false, timeout: GIT_TIMEOUT_MS, ...options });

    // Continue the declared branch when it exists; start a root commit otherwise.
    let previousHead = null;
    try {
      const { stdout } = await git(['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branch}`]);
      previousHead = stdout.trim() || null;
    } catch {
      previousHead = null;
    }
    if (previousHead) {
      await git(['checkout', '--quiet', '-B', branch, previousHead]);
    } else {
      await git(['checkout', '--quiet', '--orphan', branch]);
    }

    // Observe: an existing proposal decides the outcome.
    const targetPath = join(cloneDir, proposalPath);
    let existing = null;
    try {
      existing = await readFile(targetPath, 'utf8');
    } catch {
      existing = null;
    }
    if (existing === null) {
      return { cloneDir, previousHead, verdict: 'ABSENT' };
    }
    if (existing === serialized) {
      return { cloneDir, previousHead, verdict: 'IDENTICAL' };
    }
    throw new ReleaseError(
      REMOTE_CONFLICT,
      `proposal ${proposalPath} already exists in ${redactUrlCredentialsIfPresent(remoteUrl)} with different content; overwriting a downstream proposal requires a human decision`,
      { remoteUrl: redactUrlCredentialsIfPresent(remoteUrl), proposalPath },
    );
  } catch (cause) {
    await rm(cloneDir, { recursive: true, force: true }).catch(() => {});
    throw cause;
  }
}

/**
 * Deliver one proposal document through the git-push transport:
 * observe -> write (absent only) -> commit (frozen identity) -> push.
 *
 * - identical existing content -> NO_CHANGE, nothing written;
 * - different existing content -> REMOTE_CONFLICT (human decision);
 * - NEVER --force.
 *
 * The observe-before-write step calls the SAME shared observation
 * implementation the full-declaration preflight uses, so the execution phase
 * always re-observes the remote (the preflight is never a lock).
 *
 * No preset-level dry-run (R4 review m-3): the command-level DRY_RUN skip
 * contract skips preset hooks wholesale (SKIPPED/DRY_RUN checkpoints in
 * distribute/postVerify) before this delivery is ever invoked, so a dryRun
 * parameter here would be unreachable dead surface.
 *
 * @param {object} params
 * @param {string} params.remoteUrl - Downstream repository URL.
 * @param {string} params.branch - Downstream branch.
 * @param {string} params.proposalPath - Repository-relative proposal path.
 * @param {object} params.proposalDocument - The proposal document.
 * @param {object} params.commitIdentity - Frozen { name, email }.
 * @param {Function} [params.exec] - Injectable git exec (tests).
 * @returns {Promise<{ status: 'EXECUTED'|'NO_CHANGE', observation: object }>}
 */
export async function deliverProposalGitPush(params) {
  const {
    remoteUrl,
    branch,
    proposalPath,
    proposalDocument,
    commitIdentity,
    exec: execOpt,
  } = params ?? {};
  assertCommitIdentity(commitIdentity);
  const exec = typeof execOpt === 'function' ? execOpt : defaultExec;
  const serialized = `${JSON.stringify(proposalDocument, null, 2)}\n`;

  // Shared observe-before-write: identical -> NO_CHANGE; different -> the
  // shared observation throws REMOTE_CONFLICT (human decision).
  const { cloneDir, previousHead, verdict } = await observeProposalInboxGitPush({
    remoteUrl,
    branch,
    proposalPath,
    proposalDocument,
    ...(execOpt !== undefined ? { exec: execOpt } : {}),
  });

  try {
    if (verdict === 'IDENTICAL') {
      return {
        status: 'NO_CHANGE',
        observation: { mode: 'no-change', previousHead, branchTip: previousHead },
      };
    }

    const git = (args, options = {}) => exec('git', args, { cwd: cloneDir, shell: false, timeout: GIT_TIMEOUT_MS, ...options });
    const targetPath = join(cloneDir, proposalPath);
    await mkdir(dirname(targetPath), { recursive: true });
    await writeFile(targetPath, serialized);
    await git(['add', '-A']);
    await git([
      '-c', `user.name=${commitIdentity.name}`,
      '-c', `user.email=${commitIdentity.email}`,
      'commit', '--quiet', '-m', `release-skill proposal ${proposalPath}`,
    ]);
    const { stdout: headOut } = await git(['rev-parse', 'HEAD']);
    const localCommit = headOut.trim();

    // Plain push. NEVER --force.
    try {
      await exec('git', ['push', '--quiet', 'origin', branch], {
        cwd: cloneDir,
        env: netEnv(),
        timeout: TRANSFER_TIMEOUT_MS,
        shell: false,
      });
    } catch (error) {
      const classification = classifyNetFailure(stderrText(error));
      const safeRemoteUrl = redactUrlCredentialsIfPresent(remoteUrl);
      throw new ReleaseError(
        classification === 'auth' ? REMOTE_CONFLICT : REMOTE_UNAVAILABLE,
        classification === 'auth'
          ? `proposal-inbox push refused authentication for ${safeRemoteUrl}; the host keychain credential is reused and never prompted, read, or retried`
          : `proposal-inbox push to ${safeRemoteUrl} failed — start VPN / check network; delivery fails closed and never retries with credentials`,
        { remoteUrl: safeRemoteUrl, branch, stderrTail: stderrTail(error) },
      );
    }

    return {
      status: 'EXECUTED',
      observation: { mode: 'pushed', pushedCommit: localCommit, previousHead, branchTip: localCommit },
    };
  } finally {
    await rm(cloneDir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Execute one proposal-inbox git-push preset hook end-to-end: build the
 * document from the §2.3 context, deliver it, and cross-check the pushed
 * commit (review N-3). Shared by the distribute saga and the postVerify run.
 * Dry-run semantics live one level up (command-level DRY_RUN skip contract;
 * R4 review m-3) — this executor path always delivers.
 *
 * @param {object} params
 * @param {object} params.hook - Declared hook entry (config.target bound).
 * @param {object} params.contextProjection - The §2.3 context projection.
 * @param {object} params.commitIdentity - Frozen commitIdentity.
 * @param {Function} [params.exec]
 * @returns {Promise<{ status: string, observation: object, manualSyncPrompt: string }>}
 */
export async function executeProposalInboxGitPushHook(params) {
  const { hook, contextProjection, commitIdentity, exec } = params ?? {};
  const target = hook?.config?.target;
  if (!target || typeof target.remoteUrl !== 'string' || typeof target.branch !== 'string') {
    throw new ReleaseError(GATE_FAILED, 'proposal-inbox git-push requires config.target.remoteUrl and config.target.branch');
  }
  const document = buildProposalDocument(contextProjection);
  const proposalPath = proposalFileName(contextProjection.unitId, contextProjection.version);
  const delivery = await deliverProposalGitPush({
    remoteUrl: target.remoteUrl,
    branch: target.branch,
    proposalPath,
    proposalDocument: document,
    commitIdentity,
    ...(exec !== undefined ? { exec } : {}),
  });
  if (delivery.status === 'EXECUTED' && delivery.observation.mode === 'pushed') {
    await crossCheckPushedCommit(exec, target.remoteUrl, target.branch, delivery.observation.pushedCommit);
  }
  return {
    ...delivery,
    proposalPath,
    manualSyncPrompt: buildManualSyncPrompt({
      remoteUrl: target.remoteUrl,
      proposalPath,
      branch: target.branch,
    }),
  };
}

// ---------------------------------------------------------------------------
// local-file transport (R4)
// ---------------------------------------------------------------------------

/**
 * Deterministic manual-sync prompt for the local-file transport: names the
 * checkout, the proposal path, and the missing push step (delivery is
 * completed by a human or the downstream governance workflow).
 *
 * @param {object} params - { workspace, proposalPath, branch }
 * @returns {string}
 */
export function buildLocalFileSyncPrompt({ workspace, proposalPath, branch }) {
  return `manual sync required: proposal ${proposalPath} was committed to the local downstream checkout ${workspace} (branch ${branch}) but not pushed; suggested action: review the proposal and push or apply it through the downstream governance workflow`;
}

/**
 * Deliver one proposal document through the local-file transport: write the
 * proposal into the local checkout and commit ONLY that file with the frozen
 * bot identity. NEVER pushes — the upstream stays untouched.
 *
 * - identical existing content -> NO_CHANGE, nothing written;
 * - different existing content -> REMOTE_CONFLICT (human decision);
 * - the checkout must be on the declared branch before any write.
 *
 * @param {object} params
 * @param {string} params.workspaceRealpath - Resolved realpath of the local
 *   checkout (already execution-checked by the caller, §2.6).
 * @param {string} params.branch - Declared downstream branch.
 * @param {string} params.proposalPath - Repository-relative proposal path.
 * @param {object} params.proposalDocument - The proposal document.
 * @param {object} params.commitIdentity - Frozen { name, email }.
 * @param {Function} [params.exec] - Injectable git exec (tests).
 * @returns {Promise<{ status: 'EXECUTED'|'NO_CHANGE', observation: object }>}
 */
export async function deliverProposalLocalFile(params) {
  const {
    workspaceRealpath,
    branch,
    proposalPath,
    proposalDocument,
    commitIdentity,
    exec: execOpt,
  } = params ?? {};
  assertSafeBranch(branch);
  assertSafeProposalPath(proposalPath);
  assertCommitIdentity(commitIdentity);
  if (typeof workspaceRealpath !== 'string' || workspaceRealpath.length === 0) {
    throw new ReleaseError(GATE_FAILED, 'proposal-inbox local-file requires a resolved workspace realpath');
  }
  if (!proposalDocument || typeof proposalDocument !== 'object' || Array.isArray(proposalDocument)) {
    throw new ReleaseError(GATE_FAILED, 'proposal-inbox requires a proposal document');
  }
  const exec = typeof execOpt === 'function' ? execOpt : defaultExec;
  const git = (args, options = {}) => exec('git', args, { cwd: workspaceRealpath, shell: false, timeout: GIT_TIMEOUT_MS, ...options });

  // Branch guard: the proposal lands on the declared branch only; switching
  // branches in a user checkout is never done automatically.
  let headRef = '';
  try {
    const { stdout } = await git(['symbolic-ref', '--quiet', 'HEAD']);
    headRef = `${stdout}`.trim();
  } catch {
    headRef = '';
  }
  if (headRef !== `refs/heads/${branch}`) {
    throw new ReleaseError(
      GATE_FAILED,
      `proposal-inbox local-file requires the checkout to be on branch "${branch}", but HEAD is at "${headRef || '<detached>'}"; check out the branch and rerun`,
      { workspace: workspaceRealpath, branch, headRef: headRef || null },
    );
  }

  // Observe-before-write: an existing proposal decides the outcome.
  const serialized = `${JSON.stringify(proposalDocument, null, 2)}\n`;
  const targetPath = join(workspaceRealpath, proposalPath);
  let existing = null;
  try {
    existing = await readFile(targetPath, 'utf8');
  } catch {
    existing = null;
  }
  if (existing !== null) {
    if (existing === serialized) {
      return { status: 'NO_CHANGE', observation: { mode: 'no-change', branch } };
    }
    throw new ReleaseError(
      REMOTE_CONFLICT,
      `proposal ${proposalPath} already exists in the local checkout with different content; overwriting a downstream proposal requires a human decision`,
      { workspace: workspaceRealpath, proposalPath },
    );
  }

  await mkdir(dirname(targetPath), { recursive: true });
  await writeFile(targetPath, serialized);
  // Stage ONLY the proposal file: unrelated checkout state is never swept in.
  await git(['add', '--', proposalPath]);
  await git([
    '-c', `user.name=${commitIdentity.name}`,
    '-c', `user.email=${commitIdentity.email}`,
    'commit', '--quiet', '-m', `release-skill proposal ${proposalPath}`,
  ]);
  const { stdout: headOut } = await git(['rev-parse', 'HEAD']);
  const localCommit = headOut.trim();

  // Deliberately NO push: the upstream is never touched by local-file.
  return {
    status: 'EXECUTED',
    observation: { mode: 'local-file', localCommit, branch },
  };
}

/**
 * Execute one proposal-inbox local-file preset hook end-to-end: run the §2.6
 * workspace execution checks, build the document from the §2.3 context, and
 * deliver it into the local checkout (never pushed). Shared by the
 * distribute saga and the postVerify run.
 *
 * F-04: `releaseWorkspaceRoot` is the real project root — the ONLY
 * resolution basis for `config.target.workspace` and the release-workspace
 * write exclusion. The detached execution worktree is never passed here.
 *
 * @param {object} params
 * @param {object} params.hook - Declared hook entry (config.target bound).
 * @param {object} params.contextProjection - The §2.3 context projection.
 * @param {object} params.commitIdentity - Frozen commitIdentity.
 * @param {string} params.releaseWorkspaceRoot - Release workspace root
 *   (workspace resolution + release-workspace write exclusion).
 * @param {Function} [params.exec] - Injectable git exec (tests).
 * @returns {Promise<{ status: string, observation: object, proposalPath: string, manualSyncPrompt: string }>}
 */
export async function executeProposalInboxLocalFileHook(params) {
  const { hook, contextProjection, commitIdentity, releaseWorkspaceRoot, exec } = params ?? {};
  const target = hook?.config?.target;
  if (!target || typeof target.workspace !== 'string' || typeof target.branch !== 'string') {
    throw new ReleaseError(GATE_FAILED, 'proposal-inbox local-file requires config.target.workspace and config.target.branch');
  }
  if (typeof releaseWorkspaceRoot !== 'string' || releaseWorkspaceRoot.length === 0) {
    throw new ReleaseError(
      GATE_FAILED,
      'proposal-inbox local-file requires the release workspace root (releaseWorkspaceRoot); the detached execution worktree is never the release workspace',
    );
  }

  // §2.6 workspace execution checks: preflight realpath, TOCTOU re-check,
  // release-workspace/runtime-directory exclusion — all before any write.
  const preflight = await preflightPresetWorkspace(target.workspace, { releaseWorkspaceRoot });
  const execution = await assertPresetWorkspaceExecution(target.workspace, {
    releaseWorkspaceRoot,
    preflightRealpath: preflight.realpath,
  });

  const document = buildProposalDocument(contextProjection);
  const proposalPath = proposalFileName(contextProjection.unitId, contextProjection.version);
  const delivery = await deliverProposalLocalFile({
    workspaceRealpath: execution.realpath,
    branch: target.branch,
    proposalPath,
    proposalDocument: document,
    commitIdentity,
    ...(exec !== undefined ? { exec } : {}),
  });
  return {
    ...delivery,
    proposalPath,
    workspaceRealpath: execution.realpath,
    manualSyncPrompt: buildLocalFileSyncPrompt({
      workspace: execution.realpath,
      proposalPath,
      branch: target.branch,
    }),
  };
}
