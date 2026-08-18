/**
 * Post-publish distribution adapter: append-only git mirrors (R1–R4).
 *
 * After publish pushes the frozen tag, `distribute` mirrors the payload to
 * arbitrary consumer-declared git remotes (any git host, plain http
 * included). This adapter implements the consumer semantics:
 *
 * - probe (DISTRIBUTE_PROBE, built-in R3 obligation): a single
 *   `git ls-remote <remoteUrl> HEAD` with GIT_TERMINAL_PROMPT=0 and a ~30s
 *   timeout. It reuses whatever credential the host keychain already
 *   provides; distribute never reads, creates, prints, or retries
 *   credentials. Transport failure -> REMOTE_UNAVAILABLE with an actionable
 *   "start VPN / check network" message; auth refusal -> REMOTE_CONFLICT.
 *   A second ls-remote classifies existing same-name-tag state. No retries
 *   anywhere.
 * - mirror (DISTRIBUTE_MIRROR): clone the existing target to continue its
 *   history, wipe everything but .git, write the payload (payload-mirror)
 *   or the rendered `.claude-plugin/marketplace.json` + staticFiles
 *   (marketplace-index), stage, and:
 *     - staged tree identical to the branch tip -> NO_CHANGE, reported
 *       honestly: no commit, no tag, no push (idempotent repeat);
 *     - existing same-name tag + changed content -> REMOTE_CONFLICT
 *       (moving an existing tag would be force-equivalent);
 *     - otherwise commit with the frozen bot identity
 *       (`git -c user.name=… -c user.email=…`, never touching global git
 *       config), tag with the source tag name, plain push branch + tag.
 *       NEVER --force.
 *   Dry-run stops after the local commit + tag: zero remote side effects
 *   and no sha (R4: the marketplace sha is backfilled from the actual push
 *   result only).
 *
 * Payload materialization is deliberately NOT part of this adapter: the
 * distribute command runs the consumer-declared materialize hook in the
 * detached tag worktree and hands the adapter a payload directory. This
 * module never reimplements consumer payload logic in parallel.
 *
 * @module adapters/distribute-git
 */

import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { cp, copyFile, mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';

import {
  ActionStatus,
  ActionType,
  assertWritesAuthorized,
  createResult,
} from './contract.mjs';
import { ReleaseError, GATE_FAILED, REMOTE_CONFLICT, REMOTE_UNAVAILABLE } from '../core/errors.mjs';

const execFile = promisify(execFileCb);

const NAME = 'distribute-git';
const PROBE_TIMEOUT_MS = 30_000;
const GIT_TIMEOUT_MS = 120_000;
const TRANSFER_TIMEOUT_MS = 300_000;
const TMP_PREFIX = 'release-skill-distribute-';

/** Remote URL pattern: http(s) or file (test transport), .git-suffixed. */
const SAFE_REMOTE_URL_RE = /^(?:https?|file):\/\/.+\.git$/;
/** Branch pattern (leading alphanumeric blocks option-like names). */
const SAFE_BRANCH_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;
/** Safe tag characters (belt + braces; prepare already rendered the tag). */
const SAFE_TAG_RE = /^[^\s\x00-\x1f\x7f~^:?*[\]\\]+$/;
/** Safe target id. */
const SAFE_ID_RE = /^[a-z0-9][a-z0-9._-]*$/;
/** Full 40-hex commit sha (R4: the sha source is the actual push result). */
const SHA_RE = /^[a-f0-9]{40}$/;

/**
 * Credential hygiene (R3): git is never allowed to prompt. The host
 * keychain either already has a credential or the probe fails fast.
 */
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

/**
 * Classify a failed reachability probe: 'auth' (the remote answered but the
 * host keychain has no usable credential) or 'transport' (unreachable).
 * Unknown failures fail closed as transport: the actionable outcome is the
 * VPN/network message and distribute never retries with credentials.
 *
 * @param {string} [text] - Combined stderr/message text of the failure.
 * @returns {'auth'|'transport'}
 */
export function classifyProbeFailure(text) {
  const output = typeof text === 'string' ? text : '';
  if (AUTH_FAILURE_PATTERNS.some((pattern) => pattern.test(output))) return 'auth';
  if (TRANSPORT_FAILURE_PATTERNS.some((pattern) => pattern.test(output))) return 'transport';
  return 'transport';
}

/**
 * Render the `.claude-plugin/marketplace.json` index for a
 * marketplace-index target (R4 manifest forms):
 * - github form: { source: "github", repo, ref, sha }
 * - url form:    { source: "url", url, ref, sha }
 *
 * `sha` must be the FULL 40-hex commit hash backfilled from the actual push
 * result of the dependsOn payload-mirror target; pass `null` in dry-run and
 * the key is omitted entirely (no push result exists yet).
 *
 * @param {object} marketplace - Frozen declaration marketplace block.
 * @param {object} params
 * @param {string} params.pluginName - Plugin name (resolved from the payload).
 * @param {string} params.ref - Frozen distribution tag.
 * @param {string|null} params.sha - Pushed mirror commit sha or null (dry-run).
 * @param {string|null} params.dependencyUrl - payload-mirror remoteUrl (url form).
 * @returns {object} The marketplace index document.
 * @throws {ReleaseError} GATE_FAILED on any unsafe or missing input.
 */
export function renderMarketplaceIndex(marketplace, params = {}) {
  const fail = (message, details = {}) => {
    throw new ReleaseError(GATE_FAILED, `marketplace index render failed: ${message}`, details);
  };
  if (!marketplace || typeof marketplace !== 'object' || Array.isArray(marketplace)) {
    fail('marketplace metadata is required');
  }
  if (marketplace.form !== 'github' && marketplace.form !== 'url') {
    fail('marketplace.form must be "github" or "url"', { form: marketplace.form });
  }
  const { pluginName, ref, sha = null, dependencyUrl = null } = params;
  if (typeof marketplace.name !== 'string' || marketplace.name.length === 0) fail('marketplace.name must be a non-empty string');
  if (typeof marketplace.owner !== 'string' || marketplace.owner.length === 0) fail('marketplace.owner must be a non-empty string');
  if (typeof pluginName !== 'string' || pluginName.length === 0) fail('pluginName must be a non-empty string');
  if (typeof ref !== 'string' || ref.length === 0) fail('ref must be a non-empty tag');
  if (sha !== null && !SHA_RE.test(sha)) {
    fail('sha must be the full 40-hex commit hash from the actual push result', { sha });
  }

  let source;
  if (marketplace.form === 'github') {
    source = {
      source: 'github',
      repo: marketplace.sourceRepo ?? `${marketplace.owner}/${marketplace.name}`,
      ref,
      ...(sha ? { sha } : {}),
    };
  } else {
    if (typeof dependencyUrl !== 'string' || !SAFE_REMOTE_URL_RE.test(dependencyUrl)) {
      fail('url form requires the payload-mirror dependency remoteUrl', { dependencyUrl });
    }
    source = {
      source: 'url',
      url: dependencyUrl,
      ref,
      ...(sha ? { sha } : {}),
    };
  }

  return {
    name: marketplace.name,
    owner: { name: marketplace.owner },
    plugins: [{ name: pluginName, source }],
  };
}

function hasControlChars(value) {
  return /[\x00-\x1f\x7f]/.test(value);
}

function assertSafeRemoteUrl(remoteUrl) {
  if (typeof remoteUrl !== 'string' || !SAFE_REMOTE_URL_RE.test(remoteUrl) || hasControlChars(remoteUrl)) {
    throw new ReleaseError(
      GATE_FAILED,
      'distribute remoteUrl must be an http(s)/file URL ending in .git',
      { remoteUrl },
    );
  }
}

function assertSafeBranch(branch) {
  if (typeof branch !== 'string' || !SAFE_BRANCH_RE.test(branch)
    || branch.includes('..') || branch.endsWith('.') || branch.endsWith('.lock')) {
    throw new ReleaseError(GATE_FAILED, 'distribute branch is not a safe Git branch name', { branch });
  }
}

function assertSafeTag(tag) {
  if (typeof tag !== 'string' || tag.length === 0 || tag.startsWith('-') || !SAFE_TAG_RE.test(tag)) {
    throw new ReleaseError(GATE_FAILED, 'distribute tag is not a safe Git tag name', { tag });
  }
}

function assertCommitIdentity(identity) {
  if (!identity || typeof identity !== 'object') {
    throw new ReleaseError(GATE_FAILED, 'distribute requires a frozen commitIdentity');
  }
  for (const field of ['name', 'email']) {
    const value = identity[field];
    if (typeof value !== 'string' || value.length === 0 || value.startsWith('-') || hasControlChars(value)) {
      throw new ReleaseError(GATE_FAILED, `distribute commitIdentity.${field} is missing or unsafe`, { field });
    }
  }
}

async function run(command, args, options = {}) {
  return execFile(command, args, {
    shell: false,
    encoding: 'utf8',
    timeout: GIT_TIMEOUT_MS,
    ...options,
  });
}

function stderrText(error) {
  return `${error?.stderr ?? ''}\n${error?.message ?? ''}`;
}

function stderrTail(error, limit = 400) {
  const text = stderrText(error).trim();
  return text.length > limit ? `…${text.slice(-limit)}` : text;
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
    // Prefer the peeled ("ref^{}") commit for annotated tags.
    if (ref.endsWith('^{}')) {
      refs.set(ref.slice(0, -3), sha);
    } else if (!refs.has(ref)) {
      refs.set(ref, sha);
    }
  }
  return refs;
}

async function countFiles(dir) {
  let total = 0;
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === '.git') continue;
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      total += await countFiles(fullPath);
    } else if (entry.isFile() || entry.isSymbolicLink()) {
      total += 1;
    }
  }
  return total;
}

/**
 * Create the distribute-git adapter.
 *
 * @param {object} [deps]
 * @param {Function} [deps.exec] - Injectable exec (tests); defaults to execFile.
 * @param {Function} [deps.mkdtempFn] - Injectable mkdtemp (tests).
 * @param {Function} [deps.rmFn] - Injectable rm (tests).
 * @param {string} [deps.tmpRoot] - Temp root for clone dirs (tests).
 */
export function createDistributeGitAdapter(deps = {}) {
  const exec = deps.exec ?? run;
  const mkdtempFn = deps.mkdtempFn ?? (async (prefix) => mkdtemp(prefix));
  const rmFn = deps.rmFn ?? (async (path, options) => rm(path, options));
  const tmpRoot = deps.tmpRoot ?? tmpdir();

  const netEnv = () => ({ ...process.env, ...NEVER_PROMPT_ENV });

  async function lsRemoteRefs(remoteUrl, refs) {
    const { stdout } = await exec('git', ['ls-remote', remoteUrl, ...refs], {
      env: netEnv(),
      timeout: PROBE_TIMEOUT_MS,
      shell: false,
    });
    return parseLsRemote(stdout);
  }

  function probeFailureResult(action, error) {
    const classification = classifyProbeFailure(stderrText(error));
    const code = classification === 'auth' ? REMOTE_CONFLICT : REMOTE_UNAVAILABLE;
    const message = classification === 'auth'
      ? `remote refused authentication for ${action.remoteUrl}; distribute reuses the host keychain credential and never prompts, reads, or retries credentials`
      : `cannot reach ${action.remoteUrl} — start VPN / check network; distribute fails closed and never retries with credentials`;
    return createResult({
      actionType: action.actionType,
      status: ActionStatus.PREFLIGHT_FAILED,
      error: message,
      details: {
        code,
        classification,
        remoteUrl: action.remoteUrl,
        stderrTail: stderrTail(error),
      },
    });
  }

  async function probeRemote(action) {
    assertSafeRemoteUrl(action.remoteUrl);
    assertSafeTag(action.tag);
    let headRefs;
    try {
      headRefs = await lsRemoteRefs(action.remoteUrl, ['HEAD']);
    } catch (error) {
      return probeFailureResult(action, error);
    }
    let tagRefs;
    try {
      tagRefs = await lsRemoteRefs(action.remoteUrl, [`refs/tags/${action.tag}`]);
    } catch (error) {
      return probeFailureResult(action, error);
    }
    const tagOid = tagRefs.get(`refs/tags/${action.tag}`) ?? null;
    return createResult({
      actionType: action.actionType,
      status: ActionStatus.PREFLIGHT_PASSED,
      observation: {
        reachable: true,
        head: headRefs.get('HEAD') ?? null,
        tagOid,
        tagExists: tagOid !== null,
      },
    });
  }

  function assertMirrorActionShape(action) {
    if (typeof action.targetId !== 'string' || !SAFE_ID_RE.test(action.targetId)) {
      throw new ReleaseError(GATE_FAILED, 'distribute-mirror requires a safe targetId', { targetId: action.targetId });
    }
    if (action.kind !== 'payload-mirror' && action.kind !== 'marketplace-index') {
      throw new ReleaseError(GATE_FAILED, 'distribute-mirror kind must be payload-mirror or marketplace-index', { kind: action.kind });
    }
    assertSafeRemoteUrl(action.remoteUrl);
    assertSafeBranch(action.branch);
    assertSafeTag(action.tag);
    assertCommitIdentity(action.commitIdentity);
    if (action.kind === 'payload-mirror') {
      if (typeof action.payloadDir !== 'string' || action.payloadDir.length === 0 || !isAbsolute(action.payloadDir)) {
        throw new ReleaseError(GATE_FAILED, 'payload-mirror requires an absolute payloadDir', { payloadDir: action.payloadDir });
      }
    } else {
      if (!action.marketplace || typeof action.marketplace !== 'object') {
        throw new ReleaseError(GATE_FAILED, 'marketplace-index requires the frozen marketplace block');
      }
      if (typeof action.pluginName !== 'string' || action.pluginName.length === 0) {
        throw new ReleaseError(GATE_FAILED, 'marketplace-index requires a resolved pluginName');
      }
      if (!action.dependency || typeof action.dependency !== 'object') {
        throw new ReleaseError(GATE_FAILED, 'marketplace-index requires its payload-mirror dependency result');
      }
      assertSafeRemoteUrl(action.dependency.remoteUrl);
      if (action.dependency.sha !== null && action.dependency.sha !== undefined && !SHA_RE.test(action.dependency.sha)) {
        throw new ReleaseError(GATE_FAILED, 'dependency sha must be null (dry-run) or the full 40-hex push result', { sha: action.dependency.sha });
      }
    }
    for (const [index, file] of (action.staticFiles ?? []).entries()) {
      if (typeof file?.sourcePath !== 'string' || !isAbsolute(file.sourcePath)) {
        throw new ReleaseError(GATE_FAILED, `staticFiles[${index}].sourcePath must be an absolute path`, { index });
      }
      if (typeof file?.to !== 'string' || file.to.length === 0
        || file.to.startsWith('/') || file.to.startsWith('./') || file.to.includes('..')
        || file.to.includes('\\') || file.to.includes(':')) {
        throw new ReleaseError(GATE_FAILED, `staticFiles[${index}].to is not a safe relative path`, { index, to: file?.to });
      }
    }
  }

  async function mirror(action) {
    assertMirrorActionShape(action);
    const cloneDir = await mkdtempFn(join(tmpRoot, TMP_PREFIX));
    const git = (args, options = {}) => exec('git', args, { cwd: cloneDir, shell: false, timeout: GIT_TIMEOUT_MS, ...options });
    try {
      // Clone the existing target to continue its history (append-only).
      await exec('git', ['clone', '--quiet', action.remoteUrl, cloneDir], {
        env: netEnv(),
        timeout: TRANSFER_TIMEOUT_MS,
        shell: false,
      });

      // Continue the declared branch when it exists; start a root commit otherwise.
      let previousHead = null;
      try {
        const { stdout } = await git(['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${action.branch}`]);
        previousHead = stdout.trim() || null;
      } catch {
        previousHead = null;
      }
      if (previousHead) {
        await git(['checkout', '--quiet', '-B', action.branch, previousHead]);
      } else {
        await git(['checkout', '--quiet', '--orphan', action.branch]);
      }

      // Wipe everything but .git, then write the declared content.
      for (const entry of await readdir(cloneDir)) {
        if (entry === '.git') continue;
        await rm(join(cloneDir, entry), { recursive: true, force: true });
      }
      if (action.kind === 'payload-mirror') {
        const payloadStat = await stat(action.payloadDir).catch(() => null);
        if (!payloadStat || !payloadStat.isDirectory()) {
          throw new ReleaseError(GATE_FAILED, 'payloadDir does not exist or is not a directory', { payloadDir: action.payloadDir });
        }
        await cp(action.payloadDir, cloneDir, { recursive: true });
      } else {
        const index = renderMarketplaceIndex(action.marketplace, {
          pluginName: action.pluginName,
          ref: action.tag,
          sha: action.dependency.sha ?? null,
          dependencyUrl: action.dependency.remoteUrl,
        });
        await mkdir(join(cloneDir, '.claude-plugin'), { recursive: true });
        await writeFile(join(cloneDir, '.claude-plugin', 'marketplace.json'), `${JSON.stringify(index, null, 2)}\n`);
      }
      for (const file of action.staticFiles ?? []) {
        await mkdir(dirname(join(cloneDir, file.to)), { recursive: true });
        await copyFile(file.sourcePath, join(cloneDir, file.to));
      }

      const payloadFileCount = await countFiles(cloneDir);
      await git(['add', '-A']);

      // Honest NO_CHANGE: staged tree identical to the branch tip (or the
      // empty tree on a root commit) -> no commit, no tag, no push.
      const noChange = await git(['status', '--porcelain'])
        .then(({ stdout }) => stdout.trim().length === 0)
        .catch(() => false);
      if (noChange) {
        return createResult({
          actionType: action.actionType,
          status: ActionStatus.NO_CHANGE,
          observation: { mode: 'no-change', previousHead, branchTip: previousHead, payloadFileCount },
        });
      }

      // Same-name tag + changed content: moving an existing tag to a new
      // commit would be force-equivalent. Fail closed for human decision.
      let existingTag = '';
      try {
        const { stdout } = await git(['rev-parse', '--verify', '--quiet', `refs/tags/${action.tag}`]);
        existingTag = stdout.trim();
      } catch {
        existingTag = '';
      }
      if (existingTag) {
        throw new ReleaseError(
          REMOTE_CONFLICT,
          `target ${action.remoteUrl} already carries tag ${action.tag} and the content differs; moving an existing tag would be force-equivalent — human decision required`,
          { targetId: action.targetId, tag: action.tag },
        );
      }

      // Commit with the frozen bot identity, injected per-command so the
      // global git config is never read or modified.
      const commitMessage = `release-skill distribute ${action.tag} (${action.targetId})`;
      await git([
        '-c', `user.name=${action.commitIdentity.name}`,
        '-c', `user.email=${action.commitIdentity.email}`,
        'commit', '--quiet', '-m', commitMessage,
      ]);
      const { stdout: headOut } = await git(['rev-parse', 'HEAD']);
      const localCommit = headOut.trim();
      await git(['tag', action.tag, localCommit]);

      if (action.dryRun) {
        return createResult({
          actionType: action.actionType,
          status: ActionStatus.EXECUTED,
          observation: { mode: 'dry-run', localCommit, localTag: action.tag, previousHead, payloadFileCount },
        });
      }

      // Plain push, branch first then tag. NEVER --force.
      await exec('git', ['push', '--quiet', 'origin', action.branch], {
        cwd: cloneDir,
        env: netEnv(),
        timeout: TRANSFER_TIMEOUT_MS,
        shell: false,
      });
      await exec('git', ['push', '--quiet', 'origin', `refs/tags/${action.tag}`], {
        cwd: cloneDir,
        env: netEnv(),
        timeout: TRANSFER_TIMEOUT_MS,
        shell: false,
      });

      return createResult({
        actionType: action.actionType,
        status: ActionStatus.EXECUTED,
        observation: {
          mode: 'pushed',
          pushedCommit: localCommit,
          previousHead,
          branchTip: localCommit,
          tagOid: localCommit,
          payloadFileCount,
        },
      });
    } finally {
      await rmFn(cloneDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  return Object.freeze({
    name: NAME,
    actionTypes: Object.freeze([ActionType.DISTRIBUTE_PROBE, ActionType.DISTRIBUTE_MIRROR]),

    async preflight(action, context) {
      try {
        if (action.actionType === ActionType.DISTRIBUTE_PROBE) {
          return await probeRemote(action);
        }
        if (action.actionType === ActionType.DISTRIBUTE_MIRROR) {
          // Reachability is probed via dedicated DISTRIBUTE_PROBE actions;
          // mirror preflight is a pure shape check (no network I/O).
          assertMirrorActionShape(action);
          return createResult({ actionType: action.actionType, status: ActionStatus.PREFLIGHT_PASSED });
        }
        throw new Error(`unsupported action type: ${action.actionType}`);
      } catch (error) {
        return createResult({
          actionType: action.actionType,
          status: ActionStatus.PREFLIGHT_FAILED,
          error: error.message,
          details: error instanceof ReleaseError ? { code: error.code } : null,
        });
      }
    },

    async execute(action, context) {
      assertWritesAuthorized(context, action.actionType);
      if (action.actionType !== ActionType.DISTRIBUTE_MIRROR) {
        return createResult({
          actionType: action.actionType,
          status: ActionStatus.EXECUTE_FAILED,
          error: `unsupported action type: ${action.actionType}`,
        });
      }
      try {
        return await mirror(action);
      } catch (error) {
        return createResult({
          actionType: action.actionType,
          status: ActionStatus.EXECUTE_FAILED,
          error: error.message,
          details: { code: error instanceof ReleaseError ? error.code : GATE_FAILED, stderrTail: stderrTail(error) },
        });
      }
    },

    async observe(action, context) {
      try {
        assertSafeRemoteUrl(action.remoteUrl);
        assertSafeBranch(action.branch);
        assertSafeTag(action.tag);
        const refs = await lsRemoteRefs(action.remoteUrl, [`refs/heads/${action.branch}`, `refs/tags/${action.tag}`]);
        const observation = {
          branchTip: refs.get(`refs/heads/${action.branch}`) ?? null,
          tagOid: refs.get(`refs/tags/${action.tag}`) ?? null,
        };
        if (action.pushedCommit) {
          observation.pushedCommit = action.pushedCommit;
          observation.consistent = observation.branchTip === action.pushedCommit
            && observation.tagOid === action.pushedCommit;
        }
        return createResult({ actionType: action.actionType, status: ActionStatus.OBSERVED, observation });
      } catch (error) {
        return createResult({
          actionType: action.actionType,
          status: ActionStatus.OBSERVED,
          observation: {},
          error: error.message,
        });
      }
    },

    async verify(action, context) {
      const observed = await this.observe(action, context);
      if (observed.error) {
        return createResult({
          actionType: action.actionType,
          status: ActionStatus.VERIFY_FAILED,
          observation: observed.observation,
          error: observed.error,
        });
      }
      if (!action.pushedCommit) {
        // Nothing was pushed (NO_CHANGE / dry-run): remote state was reported as-is.
        return createResult({ actionType: action.actionType, status: ActionStatus.VERIFIED, observation: observed.observation });
      }
      if (observed.observation.consistent === true) {
        return createResult({ actionType: action.actionType, status: ActionStatus.VERIFIED, observation: observed.observation });
      }
      return createResult({
        actionType: action.actionType,
        status: ActionStatus.VERIFY_FAILED,
        observation: observed.observation,
        error: `remote refs disagree with the pushed commit ${action.pushedCommit}`,
      });
    },
  });
}
