/**
 * Shared project lock for artifact commands (G4: token-lock adoption).
 *
 * All mutating artifact commands (apply, accept, recover, resolve submit,
 * prepare) share a single project lock domain. The lock is acquired via the
 * Foundation in-flight `token-lock` mechanism: `.release-skill/lock` is a
 * SINGLE FILE (0600) holding the lock record
 * `{schemaVersion:1, owner:<owner6-JSON string>, tokenDigest, acquiredAt}`.
 * The owner record is published atomically together with the lock — there is
 * no ownerless-lock window (G4 conflict-surface.md 第六节).
 *
 * Owner record contains: pid, host, bootId (or session id), nonce, command,
 * startedAt. It is embedded as the lock record `owner` string.
 *
 * TTL is informational only — aging a lock never permits automatic deletion.
 * Only the exact owner can release (token + identity), or an operator can
 * break the lock with `breakProjectLock` which requires matching the exact
 * owner and writes audit evidence before recovery.
 *
 * Old lock domain: `.release-skill/lock` as a DIRECTORY (with `.owner`).
 * Detecting a directory at the lock path fails closed with
 * LOCK_MIGRATION_REQUIRED — never auto-deleted, never auto-converted
 * (same-path different-form makes old/new code mutually exclusive).
 *
 * Bridge: in-flight Foundation capabilities are imported through
 * `../core/foundation-inflight.mjs` (relative-path import of the Foundation
 * workspace; released form must be the bundle).
 *
 * @module artifacts/project-lock
 */

import { mkdir, writeFile, lstat, open } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { hostname } from 'node:os';
import { randomBytes } from 'node:crypto';

import {
  ReleaseError,
  TRANSACTION_INCOMPLETE,
  PATH_UNSAFE,
  LOCK_MIGRATION_REQUIRED,
} from '../core/errors.mjs';
import {
  acquireFilesystemLock,
  inspectFilesystemLock,
  releaseFilesystemLock,
  recoverFilesystemLock,
  HARNESS_ERROR_KINDS as INFLIGHT_KINDS,
} from '../core/foundation-inflight.mjs';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Foundation token-lock relative path (single file — replaces old directory). */
const LOCK_REL_PATH = join('.release-skill', 'lock');
const AUDIT_DIR_NAME = 'lock-audit';
/** Foundation assertOwner upper bound on the owner string (token-lock.mjs). */
const MAX_OWNER_JSON_LENGTH = 200;

/** All owner fields that must match exactly. */
const OWNER_FIELDS = ['pid', 'host', 'bootId', 'nonce', 'command', 'startedAt'];

// ---------------------------------------------------------------------------
// Owner construction
// ---------------------------------------------------------------------------

/**
 * Build an owner record for the current process.
 *
 * @param {string} command - The command acquiring the lock.
 * @param {() => string} [clock] - Clock function for timestamps.
 * @returns {object} Frozen owner record.
 */
function buildOwner(command, clock) {
  const startedAt = clock ? clock() : new Date().toISOString();
  assertIsoTimestamp(startedAt, 'clock result');
  return Object.freeze({
    pid: process.pid,
    host: hostname(),
    bootId: getBootId(),
    nonce: randomBytes(16).toString('hex'),
    command,
    startedAt,
  });
}

/**
 * Get a boot or session identifier.
 *
 * On Linux, reads /proc/sys/kernel/random/boot_id. On other platforms,
 * falls back to a process-lifetime constant derived from process.pid +
 * start time.
 *
 * @returns {string} Boot/session identifier.
 */
function getBootId() {
  try {
    // Linux: stable across reboots
    return readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
  } catch {
    // Fallback: pid + uptime at module load time (stable within process)
    return `pid-${process.pid}-uptime-${Math.floor(process.uptime())}`;
  }
}

// ---------------------------------------------------------------------------
// Internal: path helpers
// ---------------------------------------------------------------------------

function lockPath(root) {
  return join(root, LOCK_REL_PATH);
}

function auditDir(root) {
  return join(root, '.release-skill', AUDIT_DIR_NAME);
}

// ---------------------------------------------------------------------------
// Internal: owner validation
// ---------------------------------------------------------------------------

/**
 * Validate that an expectedOwner object is structurally sound:
 * - Must be a plain object (not array, not null)
 * - Must have exactly the 6 required fields (no extra, no missing)
 * - pid must be a positive integer
 * - All other fields must be non-empty strings
 * - String fields must not contain control characters
 *
 * @param {object} owner - The owner object to validate.
 * @throws {ReleaseError} PATH_UNSAFE on any violation.
 */
function validateOwnerObject(owner) {
  if (!owner || typeof owner !== 'object' || Array.isArray(owner)) {
    throw new ReleaseError(PATH_UNSAFE, 'expectedOwner must be a plain object', {});
  }

  const keys = Object.keys(owner);
  const expectedSet = new Set(OWNER_FIELDS);
  const actualSet = new Set(keys);

  if (keys.length !== OWNER_FIELDS.length) {
    throw new ReleaseError(
      PATH_UNSAFE,
      `expectedOwner must have exactly ${OWNER_FIELDS.length} fields; got ${keys.length}`,
      {},
    );
  }

  for (const field of OWNER_FIELDS) {
    if (!actualSet.has(field)) {
      throw new ReleaseError(PATH_UNSAFE, `expectedOwner missing required field: ${field}`, {});
    }
  }

  for (const key of keys) {
    if (!expectedSet.has(key)) {
      throw new ReleaseError(PATH_UNSAFE, `expectedOwner has unexpected field: ${key}`, {});
    }
  }

  // Type validation
  if (typeof owner.pid !== 'number' || !Number.isInteger(owner.pid) || owner.pid <= 0) {
    throw new ReleaseError(PATH_UNSAFE, 'expectedOwner.pid must be a positive integer', {});
  }

  const stringFields = OWNER_FIELDS.filter((f) => f !== 'pid');
  for (const field of stringFields) {
    if (typeof owner[field] !== 'string' || owner[field].trim().length === 0) {
      throw new ReleaseError(PATH_UNSAFE, `expectedOwner.${field} must be a non-empty string`, {});
    }
  }

  // Control character check on all string fields
  for (const field of stringFields) {
    if (/[\x00-\x1f\x7f]/.test(owner[field])) {
      throw new ReleaseError(PATH_UNSAFE, `expectedOwner.${field} contains control characters`, {});
    }
  }

  // nonce becomes part of an audit filename, so accept only the format
  // produced by buildOwner(). This excludes separators, dot segments and
  // platform-specific path syntax by construction.
  if (!/^[a-f0-9]{32}$/.test(owner.nonce)) {
    throw new ReleaseError(
      PATH_UNSAFE,
      'expectedOwner.nonce must be exactly 32 lowercase hexadecimal characters',
      {},
    );
  }
  if (!/^[A-Za-z0-9._:-]+$/.test(owner.host) || !/^[A-Za-z0-9._:-]+$/.test(owner.bootId)) {
    throw new ReleaseError(PATH_UNSAFE, 'expectedOwner host/bootId contains unsafe characters', {});
  }
  if (sanitizeReason(owner.command) !== owner.command) {
    throw new ReleaseError(PATH_UNSAFE, 'expectedOwner.command must not contain absolute paths', {});
  }
  assertIsoTimestamp(owner.startedAt, 'expectedOwner.startedAt');
}

function assertIsoTimestamp(value, label) {
  if (
    typeof value !== 'string'
    || !Number.isFinite(Date.parse(value))
    || new Date(value).toISOString() !== value
  ) {
    throw new ReleaseError(PATH_UNSAFE, `${label} must be a canonical ISO-8601 timestamp`, {});
  }
}

// ---------------------------------------------------------------------------
// Internal: reason sanitization
// ---------------------------------------------------------------------------

/**
 * Sanitize a reason string for audit records.
 *
 * If the reason contains absolute paths (e.g. /Users/..., /home/...),
 * they are deterministically replaced with path-agnostic placeholders.
 * This prevents leaking local filesystem layout into audit files.
 *
 * @param {string} reason - Raw reason text.
 * @returns {string} Sanitized reason text.
 */
function sanitizeReason(reason) {
  return reason
    .replace(/\/Users\/[^\s,;:'")\]]+/g, '<user-path>')
    .replace(/\/home\/[^\s,;:'")\]]+/g, '<user-path>')
    .replace(/\/tmp\/[^\s,;:'")\]]+/g, '<temp-path>')
    .replace(/(^|[\s("'=])\/(?!\/)[^\s,;:'")\]]+/g, '$1<absolute-path>')
    .replace(/(^|[\s("'=])(?:[A-Za-z]:[\\/]|\\\\)[^\s,;:'")\]]+/g, '$1<absolute-path>');
}

// ---------------------------------------------------------------------------
// Internal: durability observation (real fsync at wrapper boundaries)
// ---------------------------------------------------------------------------

async function emitDurability(observer, event) {
  if (!observer) return;
  try {
    await observer(Object.freeze(event));
  } catch {
    // Observation must never weaken, skip or fail a durability operation.
  }
}

async function fsyncFileObserved(filePath, observer) {
  await fsyncFile(filePath);
  await emitDurability(observer, { operation: 'fsync-file', path: filePath });
}

async function fsyncDirObserved(dirPath, observer) {
  await fsyncDir(dirPath);
  await emitDurability(observer, { operation: 'fsync-dir', path: dirPath });
}

/**
 * Fsync a file by path — opens, syncs, closes.
 *
 * @param {string} filePath
 */
async function fsyncFile(filePath) {
  const fh = await open(filePath, 'r');
  try {
    await fh.sync();
  } finally {
    await fh.close();
  }
}

/**
 * Fsync a directory by path.
 *
 * @param {string} dirPath
 */
async function fsyncDir(dirPath) {
  const fh = await open(dirPath, 'r');
  try {
    await fh.sync();
  } finally {
    await fh.close();
  }
}

// ---------------------------------------------------------------------------
// Internal: Foundation error mapping (G4 conflict-surface.md 第五节)
// ---------------------------------------------------------------------------

function mapKindToCode(kind) {
  switch (kind) {
    case INFLIGHT_KINDS.STORE_LOCKED:
    case INFLIGHT_KINDS.LOCK_CORRUPT:
    case INFLIGHT_KINDS.LOCK_RECOVERY_REFUSED:
    case INFLIGHT_KINDS.EXCLUSIVE_PUBLISH_CONFLICT:
      return TRANSACTION_INCOMPLETE;
    case INFLIGHT_KINDS.UNSAFE_STATE_ENTRY:
      return PATH_UNSAFE;
    default:
      // 未知 kind → fail-closed，默认拒绝
      return PATH_UNSAFE;
  }
}

/**
 * Map a Foundation mechanism error to a local ReleaseError.
 *
 * Errors WITHOUT `details.kind` are genuine local I/O failures (ENOENT,
 * ENOSPC, EACCES, ...) and are rethrown unchanged — they must surface with
 * their native message and code.
 *
 * @param {Error} cause - The caught error.
 * @param {string} fallbackMessage - Message when the cause has none.
 * @returns {ReleaseError}
 */
function mapFoundationError(cause, fallbackMessage) {
  const kind = cause?.details?.kind;
  if (typeof kind === 'string') {
    return new ReleaseError(mapKindToCode(kind), cause.message ?? fallbackMessage, {
      ...cause.details,
    });
  }
  if (cause instanceof TypeError) {
    // Foundation assertOwner 上限（owner 非字符串/超长）——已由 wrapper 写前预检兜底
    return new ReleaseError(PATH_UNSAFE, cause.message ?? fallbackMessage, {});
  }
  throw cause;
}

// ---------------------------------------------------------------------------
// Internal: lock path state & fail-closed checks
// ---------------------------------------------------------------------------

/**
 * Classify the lock path state.
 *
 * @param {string} root - Repository root.
 * @returns {Promise<'absent'|'file'|'dir'|'symlink'>}
 */
async function lockPathState(root) {
  let st;
  try {
    st = await lstat(lockPath(root));
  } catch (err) {
    if (err.code === 'ENOENT') return 'absent';
    throw err;
  }
  if (st.isSymbolicLink()) return 'symlink';
  if (st.isDirectory()) return 'dir';
  return 'file';
}

/**
 * Fail closed when the lock path holds an unsafe or old-domain form.
 *
 * - symlink → PATH_UNSAFE (same as pre-migration assertion)
 * - directory → LOCK_MIGRATION_REQUIRED (old lock domain; never auto-migrated)
 * - absent/file → OK (Foundation acquires / inspects the single-file lock)
 *
 * @param {string} root - Repository root.
 * @returns {Promise<void>}
 */
async function assertLockPathSafe(root) {
  const state = await lockPathState(root);
  if (state === 'symlink') {
    throw new ReleaseError(
      PATH_UNSAFE,
      '.release-skill/lock is a symlink — refusing to operate on symlinked path',
      { path: lockPath(root) },
    );
  }
  if (state === 'dir') {
    throw new ReleaseError(
      LOCK_MIGRATION_REQUIRED,
      'project lock uses the old directory format; migration required',
      { root, lockPath: lockPath(root), hint: 'confirm no command is in progress, then remove the .release-skill/lock directory' },
    );
  }
}

/**
 * Assert that .release-skill exists as a real directory (not a symlink).
 *
 * @param {string} root - Repository root.
 * @returns {Promise<void>}
 */
async function assertReleaseSkillDirSafe(root) {
  const releaseSkillDir = join(root, '.release-skill');
  let st;
  try {
    st = await lstat(releaseSkillDir);
  } catch (err) {
    if (err.code === 'ENOENT') return; // doesn't exist yet — OK
    throw err;
  }
  if (st.isSymbolicLink()) {
    throw new ReleaseError(
      PATH_UNSAFE,
      '.release-skill is a symlink — refusing to operate on symlinked path',
      { path: releaseSkillDir },
    );
  }
  if (!st.isDirectory()) {
    throw new ReleaseError(
      PATH_UNSAFE,
      '.release-skill exists but is not a directory',
      { path: releaseSkillDir },
    );
  }
}

/**
 * Assert that the audit directory is not a symlink.
 *
 * @param {string} root - Repository root.
 * @returns {Promise<void>}
 */
async function assertAuditPathNotSymlink(root) {
  await assertReleaseSkillDirSafe(root);
  const auditPath = auditDir(root);
  let st;
  try {
    st = await lstat(auditPath);
  } catch (err) {
    if (err.code === 'ENOENT') return;
    throw err;
  }
  if (st.isSymbolicLink()) {
    throw new ReleaseError(
      PATH_UNSAFE,
      '.release-skill/lock-audit is a symlink — refusing to operate on symlinked path',
      { path: auditPath },
    );
  }
}

// ---------------------------------------------------------------------------
// Internal: assert owner matches persisted lock record
// ---------------------------------------------------------------------------

/**
 * Parse the persisted owner string from a lock record and compare all six
 * fields exactly with the expected owner.
 *
 * @param {string} persistedOwnerJson - `record.owner` from the lock file.
 * @param {object} expected - The expected owner record.
 * @param {string} root - Repository root.
 * @param {string} messagePrefix - Prefix for the mismatch message.
 * @returns {void}
 * @throws {ReleaseError} TRANSACTION_INCOMPLETE on mismatch or corrupt record.
 */
function assertOwnerMatches(persistedOwnerJson, expected, root, messagePrefix) {
  let actual;
  try {
    actual = JSON.parse(persistedOwnerJson);
  } catch {
    throw new ReleaseError(
      TRANSACTION_INCOMPLETE,
      'project lock owner record is corrupt',
      { root },
    );
  }
  for (const field of OWNER_FIELDS) {
    if (actual[field] !== expected[field]) {
      throw new ReleaseError(
        TRANSACTION_INCOMPLETE,
        `${messagePrefix} — field "${field}" differs`,
        { root, field, expected: field === 'nonce' ? expected[field]?.slice(0, 8) : undefined },
      );
    }
  }
}

/**
 * Assert that the persisted lock record still belongs to `owner`.
 *
 * @param {object} owner - The expected owner record.
 * @param {string} root - Repository root.
 * @returns {Promise<void>}
 * @throws {ReleaseError} TRANSACTION_INCOMPLETE if lock missing or owner mismatch.
 */
async function assertOwned(owner, root) {
  let inspected;
  try {
    inspected = await inspectFilesystemLock(root, LOCK_REL_PATH);
  } catch (cause) {
    if (cause?.code === 'ENOENT') {
      // Lock domain (or .release-skill) does not exist at all — ownership lost.
      throw new ReleaseError(
        TRANSACTION_INCOMPLETE,
        'project lock does not exist — ownership lost',
        { root },
      );
    }
    throw mapFoundationError(cause, 'project lock inspection failed');
  }
  if (!inspected.locked) {
    throw new ReleaseError(
      TRANSACTION_INCOMPLETE,
      'project lock does not exist — ownership lost',
      { root },
    );
  }
  assertOwnerMatches(inspected.owner, owner, root, 'project lock owner does not match');
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Acquire the project lock.
 *
 * Delegates to Foundation `acquireFilesystemLock` — one exclusive create of
 * the lock record file (temp + fsync + exclusive link + verify + directory
 * fsync). The owner is published atomically with the lock, so there is no
 * ownerless-lock window.
 *
 * If the lock is already held, throws `TRANSACTION_INCOMPLETE` — there is
 * no automatic stale lock breakage based on TTL.
 *
 * @param {object} options
 * @param {string} options.root - Repository root (absolute).
 * @param {string} options.command - The command acquiring the lock (e.g. 'apply', 'accept').
 * @param {'exclusive'} [options.mode='exclusive'] - Lock mode (currently only exclusive).
 * @param {() => string} [options.clock] - Clock function for timestamps.
 * @param {(event: object) => Promise<void>} [options.durabilityObserver] - Best-effort observer; cannot replace or interrupt fsync.
 * @param {(point: string) => Promise<void>} [options.faultInjector] - Test-only safe failure injection.
 * @returns {Promise<ProjectLock>}
 * @throws {ReleaseError} TRANSACTION_INCOMPLETE if lock is already held.
 */
export async function acquireProjectLock({
  root,
  command,
  mode = 'exclusive',
  clock,
  durabilityObserver,
  faultInjector,
} = {}) {
  if (!root || typeof root !== 'string') {
    throw new ReleaseError(PATH_UNSAFE, 'root must be a non-empty string', { root });
  }
  if (!command || typeof command !== 'string' || command.trim().length === 0) {
    throw new ReleaseError(PATH_UNSAFE, 'command must be a non-empty string', { command });
  }
  if (/[\x00-\x1f\x7f]/.test(command)) {
    throw new ReleaseError(PATH_UNSAFE, 'command contains control characters', {});
  }
  if (sanitizeReason(command) !== command) {
    throw new ReleaseError(PATH_UNSAFE, 'command must not contain absolute paths', {});
  }
  if (mode !== 'exclusive') {
    throw new ReleaseError(
      PATH_UNSAFE,
      `lock mode must be "exclusive"; "${mode}" is not supported`,
      { mode },
    );
  }

  // Construct and validate the owner before touching the filesystem so a bad
  // injected clock cannot shape any persisted state.
  const owner = buildOwner(command, clock);
  const ownerJson = JSON.stringify(owner);
  if (ownerJson.length > MAX_OWNER_JSON_LENGTH) {
    // Foundation assertOwner 上限（200 字符）；写前预检 fail-closed（G4 C.4）
    throw new ReleaseError(
      PATH_UNSAFE,
      'lock owner record exceeds the 200-character limit; refusing to acquire',
      { length: ownerJson.length },
    );
  }

  // Symlink / old-domain fail-closed: check every path level before touching fs
  const releaseSkillDir = join(root, '.release-skill');
  await assertReleaseSkillDirSafe(root);
  await assertLockPathSafe(root);

  // Ensure parent directory exists (only fsync root when newly created)
  let parentExisted = true;
  try {
    await lstat(releaseSkillDir);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    parentExisted = false;
  }
  if (!parentExisted) {
    await mkdir(releaseSkillDir, { recursive: true, mode: 0o700 });
    await emitDurability(durabilityObserver, { operation: 'create-dir', path: releaseSkillDir });
    // Persist the new .release-skill directory entry in root.
    await fsyncDirObserved(root, durabilityObserver);
  }

  if (faultInjector) await faultInjector('after-lock-create');

  // Foundation single-file atomic lock acquisition. A failure before commit
  // leaves nothing behind (staging is cleaned by publishFileExclusive).
  let handle;
  try {
    handle = await acquireFilesystemLock(root, LOCK_REL_PATH, { owner: ownerJson });
  } catch (cause) {
    if (cause?.details?.kind === INFLIGHT_KINDS.STORE_LOCKED) {
      // Lock is held — TTL never permits automatic breakage
      throw new ReleaseError(
        TRANSACTION_INCOMPLETE,
        'project lock is already held; another command is in progress',
        { root, lockPath: lockPath(root) },
      );
    }
    throw mapFoundationError(cause, 'project lock acquisition failed');
  }

  // Foundation publishFileExclusive already fsynced .release-skill; record the
  // completed boundary durability at the wrapper edge.
  await emitDurability(durabilityObserver, { operation: 'fsync-dir', path: releaseSkillDir });

  if (faultInjector) {
    try {
      await faultInjector('after-owner-write');
    } catch (writeErr) {
      // The atomic commit already happened; roll the lock back so an
      // "acquire reported failure" never leaves a held lock behind.
      try {
        await releaseFilesystemLock(handle);
        await emitDurability(durabilityObserver, { operation: 'remove-dir', path: lockPath(root) });
        await emitDurability(durabilityObserver, { operation: 'fsync-dir', path: releaseSkillDir });
      } catch (cleanupErr) {
        const incomplete = new ReleaseError(
          TRANSACTION_INCOMPLETE,
          'project lock acquisition failed and cleanup could not be made durable',
          {
            acquireErrorCode: typeof writeErr?.code === 'string' ? writeErr.code : null,
            cleanupErrorCode: typeof cleanupErr?.code === 'string' ? cleanupErr.code : null,
          },
        );
        incomplete.cause = writeErr;
        incomplete.cleanupCause = cleanupErr;
        throw incomplete;
      }
      throw writeErr;
    }
  }

  return Object.freeze({
    owner,

    /**
     * Run a function while asserting lock ownership before and after.
     *
     * Post-owner check runs regardless of whether fn succeeds or throws.
     * If fn throws AND post-owner check fails, the error is TRANSACTION_INCOMPLETE
     * with the original business error as `cause` (fail-closed, never loses the error).
     *
     * @param {() => Promise<T>} fn - Function to execute under lock.
     * @returns {Promise<T>} Result of fn.
     * @throws {ReleaseError} if ownership verification fails.
     */
    async capture(fn) {
      await assertOwned(owner, root);
      let fnResult;
      try {
        fnResult = await fn();
      } catch (fnErr) {
        // fn threw — still perform post-owner check (fail-closed)
        try {
          await assertOwned(owner, root);
        } catch {
          // Both fn error AND owner lost — fail closed with TRANSACTION_INCOMPLETE,
          // preserve the original business error as cause
          const lockError = new ReleaseError(
            TRANSACTION_INCOMPLETE,
            'business error and lock ownership lost during capture',
            { businessErrorCode: typeof fnErr?.code === 'string' ? fnErr.code : null },
          );
          lockError.cause = fnErr;
          throw lockError;
        }
        // Owner still held — re-throw the original business error
        throw fnErr;
      }
      // fn succeeded — post-owner check
      await assertOwned(owner, root);
      return fnResult;
    },

    /**
     * Assert that the current process still owns the lock.
     *
     * @returns {Promise<void>}
     * @throws {ReleaseError} TRANSACTION_INCOMPLETE if ownership lost.
     */
    async assertOwner() {
      return assertOwned(owner, root);
    },

    /**
     * Release the lock. Only succeeds if the persisted record still matches
     * the token and identity captured at acquire. Foundation `unlinkSame`
     * fsyncs `.release-skill` as part of removal.
     *
     * @returns {Promise<void>}
     * @throws {ReleaseError} TRANSACTION_INCOMPLETE if token/owner mismatch.
     */
    async release() {
      try {
        await releaseFilesystemLock(handle);
      } catch (cause) {
        throw mapFoundationError(cause, 'project lock release failed — token or owner does not match');
      }
      await emitDurability(durabilityObserver, { operation: 'remove-dir', path: lockPath(root) });
      await emitDurability(durabilityObserver, { operation: 'fsync-dir', path: releaseSkillDir });
    },
  });
}

/**
 * Break a project lock by force.
 *
 * Requires the exact owner record to match what is persisted in the lock
 * record. Writes an audit record to `.release-skill/lock-audit/` before
 * recovering (removing) the lock file via Foundation `recoverFilesystemLock`
 * (explicit operator recovery — no age/PID/liveness inference).
 *
 * @param {object} options
 * @param {string} options.root - Repository root (absolute).
 * @param {object} options.expectedOwner - The exact owner record to match.
 * @param {string} options.reason - Human-readable reason for breaking the lock.
 * @param {() => string} [options.clock] - Clock function for timestamps.
 * @param {(event: object) => Promise<void>} [options.durabilityObserver] - Observe completed durability operations; cannot replace fsync.
 * @returns {Promise<AuditRecord>}
 * @throws {ReleaseError} if owner does not match or lock does not exist.
 */
export async function breakProjectLock({ root, expectedOwner, reason, clock, durabilityObserver } = {}) {
  if (!root || typeof root !== 'string') {
    throw new ReleaseError(PATH_UNSAFE, 'root must be a non-empty string', { root });
  }

  // Strict owner validation before any filesystem operations
  validateOwnerObject(expectedOwner);

  if (typeof reason !== 'string' || reason.trim().length === 0) {
    throw new ReleaseError(PATH_UNSAFE, 'reason must be a non-empty string (trimmed)', {});
  }
  if (/[\x00-\x1f\x7f]/.test(reason)) {
    throw new ReleaseError(PATH_UNSAFE, 'reason contains control characters', {});
  }
  const trimmedReason = sanitizeReason(reason.trim());
  const brokenAt = clock ? clock() : new Date().toISOString();
  assertIsoTimestamp(brokenAt, 'clock result');

  // Symlink / old-domain / absent fail-closed check before reading the lock record
  await assertReleaseSkillDirSafe(root);
  await assertLockPathSafe(root);
  if ((await lockPathState(root)) === 'absent') {
    throw new ReleaseError(
      TRANSACTION_INCOMPLETE,
      'no project lock to break — lock file does not exist',
      { root },
    );
  }

  let inspected;
  try {
    inspected = await inspectFilesystemLock(root, LOCK_REL_PATH);
  } catch (cause) {
    throw mapFoundationError(cause, 'project lock inspection failed');
  }
  assertOwnerMatches(inspected.owner, expectedOwner, root, 'break-lock rejected: expectedOwner does not match persisted owner');

  const actualOwner = JSON.parse(inspected.owner); // 已通过 assertOwnerMatches 校验

  // Check audit path is not a symlink before writing
  await assertAuditPathNotSymlink(root);

  // Build audit record — sanitize: no absolute paths in the JSON
  const safeOriginalOwner = Object.freeze({
    pid: actualOwner.pid,
    host: actualOwner.host,
    bootId: actualOwner.bootId,
    nonce: actualOwner.nonce,
    command: actualOwner.command,
    startedAt: actualOwner.startedAt,
  });

  const auditRecord = Object.freeze({
    brokenAt,
    reason: trimmedReason,
    originalOwner: safeOriginalOwner,
    breakerPid: process.pid,
    breakerHost: hostname(),
  });

  // Write audit evidence before recovering the lock
  const auditDirectory = auditDir(root);
  await mkdir(auditDirectory, { recursive: true, mode: 0o700 });
  await emitDurability(durabilityObserver, { operation: 'create-dir', path: auditDirectory });

  // Fsync .release-skill after creating audit directory
  await fsyncDirObserved(join(root, '.release-skill'), durabilityObserver);

  const safeTimestamp = auditRecord.brokenAt.replace(/[^A-Za-z0-9_-]/g, '-');
  const auditFileName = `${safeTimestamp}-${actualOwner.nonce}.json`;
  const auditFilePath = join(auditDirectory, auditFileName);
  await writeFile(auditFilePath, JSON.stringify(auditRecord, null, 2), { mode: 0o600, flag: 'wx' });
  await emitDurability(durabilityObserver, { operation: 'write-file', path: auditFilePath });
  await fsyncFileObserved(auditFilePath, durabilityObserver);
  await fsyncDirObserved(auditDirectory, durabilityObserver);

  // Explicit operator recovery: digest must still match the inspected record
  // (TOCTOU fail-closed — the lock may not have changed between inspect and recover).
  try {
    await recoverFilesystemLock(root, LOCK_REL_PATH, {
      expectedTokenDigest: inspected.tokenDigest,
      confirmAbandoned: true,
    });
  } catch (cause) {
    throw mapFoundationError(cause, 'project lock break failed — lock changed after inspection');
  }

  // Foundation unlinkSame fsynced .release-skill as part of removal; record
  // the completed boundary durability at the wrapper edge.
  await emitDurability(durabilityObserver, { operation: 'remove-dir', path: lockPath(root) });
  await emitDurability(durabilityObserver, { operation: 'fsync-dir', path: join(root, '.release-skill') });

  return auditRecord;
}

/**
 * @typedef {object} ProjectLock
 * @property {object} owner - The owner record.
 * @property {(fn: () => Promise<T>) => Promise<T>} capture - Run fn under lock ownership assertion.
 * @property {() => Promise<void>} assertOwner - Verify current process owns the lock.
 * @property {() => Promise<void>} release - Release the lock.
 */

/**
 * @typedef {object} AuditRecord
 * @property {string} brokenAt - ISO timestamp of when the lock was broken.
 * @property {string} reason - Human-readable reason.
 * @property {object} originalOwner - The owner that was broken.
 * @property {number} breakerPid - PID of the process that broke the lock.
 * @property {string} breakerHost - Hostname of the breaker.
 */
