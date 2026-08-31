/**
 * Incremental hook result cache (T3.2).
 *
 * A hook that opts in with `cacheable: true` and a `cacheInputs` glob list is
 * keyed by a closed v2 receipt: its configuration and input closure, the
 * allowlisted environment values, runtime and physical identities, plus the
 * Foundation executable observation. When the key is unchanged and the last
 * run succeeded, prepare replays the cached outcome instead of re-executing.
 *
 * Safety contract (see t3-2-incremental-hooks.md §4.8):
 * - Failures are never cached. Only an `exitCode === 0` result is written; a
 *   non-zero exit or HOOK_TIMEOUT leaves no record, so the next run re-executes.
 * - The cache only ever skips execution. It runs AFTER the hook authorization
 *   gate and never bypasses any GATE; hook order and failure semantics are
 *   untouched.
 * - Fail-closed inputs: if any declared `cacheInputs` glob matches no file, the
 *   input set is considered a declaration error and caching aborts with
 *   GATE_FAILED before the hook runs (no execution, no cache).
 * - Default zero change: a hook without `cacheable: true` never touches the
 *   cache directory at all.
 *
 * The cache is a pure local optimisation under `.release-skill/cache` (a
 * registered control-plane prefix, excluded from workspaceDigest and
 * .gitignore). Deleting it is equivalent to a cold miss for every hook.
 *
 * @module hook-cache
 */

import { readdir, realpath, stat } from 'node:fs/promises';
import { release as osRelease } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import {
  createFilesystemRootBinding,
  observeExecutableIdentity,
  readFileStrict,
  readFileBound,
  publishFileExclusive,
  publishFileOrReplace,
  HARNESS_ERROR_KINDS,
} from 'skill-family-harness-node';
import { canonicalJson, sha256Hex } from './digest.mjs';
import { ReleaseError, GATE_FAILED } from './errors.mjs';
import { buildHookEnvironment } from './hooks.mjs';
import { readTrustedPackageResourceSync } from './trusted-resource.mjs';

/** Control-plane location of hook cache records: `.release-skill/cache/hooks`. */
const CACHE_BASE = ['.release-skill', 'cache', 'hooks'];

/** Bounded tail length stored per stream (matches prepare's evidence tails). */
const TAIL_LENGTH = 4000;

const CACHE_SCHEMA_VERSION = 2;
const CACHE_KIND = 'release-skill.hook-cache';
const CACHE_ALGORITHM = 'release-skill-hook-cache-v2';
const CACHE_RECEIPT_VERSION = 1;
const CACHE_RECORD_KEYS = Object.freeze([
  'algorithm', 'cacheKey', 'createdAt', 'exitCode', 'kind', 'receipt',
  'receiptVersion', 'schemaVersion', 'stderrTail', 'stdoutTail',
]);
const CACHE_RECEIPT_KEYS = Object.freeze([
  'algorithm', 'envDigest', 'executableObservationDigest', 'hookDigest',
  'hookCwdIdentity', 'inputsDigest', 'projectRootIdentity', 'receiptVersion',
  'releaseSkillVersion', 'runtime', 'schemaVersion',
]);

/**
 * Directory names never walked when enumerating hook inputs. `.git` and
 * `node_modules` are VCS/dependency internals; `.release-skill` is the control
 * plane and MUST stay excluded so cache records never fingerprint themselves
 * (which would destabilise every subsequent key).
 */
const SKIPPED_DIRS = new Set(['.git', 'node_modules', '.release-skill']);

/**
 * Translate a `cacheInputs` glob into an anchored RegExp.
 *
 * Supported syntax (sufficient for input declarations):
 * - `**`  matches any run of characters, including `/` (crosses directories)
 * - `*`   matches any run of characters except `/`
 * - `?`   matches a single character except `/`
 * - every other character matches literally (regex metacharacters escaped)
 *
 * @param {string} glob
 * @returns {RegExp}
 */
function globToRegExp(glob) {
  let source = '';
  let i = 0;
  while (i < glob.length) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        source += '.*';
        i += 2;
      } else {
        source += '[^/]*';
        i += 1;
      }
    } else if (c === '?') {
      source += '[^/]';
      i += 1;
    } else {
      source += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
      i += 1;
    }
  }
  return new RegExp(`^${source}$`);
}

/**
 * Recursively list every regular file under `root` as a `/`-separated relative
 * path, skipping VCS/dependency/control-plane directories and symlinks (inputs
 * are real files; symlink handling stays deterministic by not following them).
 *
 * @param {string} root - Absolute project root.
 * @returns {Promise<string[]>} Sorted relative paths.
 */
async function listInputFiles(root, matchers) {
  const out = [];
  let unsafe = false;

  function matches(relPath) {
    return matchers.some(({ re }) => re.test(relPath));
  }

  async function walk(dirAbs, dirRel) {
    let entries;
    try {
      entries = await readdir(dirAbs, { withFileTypes: true });
    } catch {
      unsafe = true;
      return;
    }
    for (const entry of entries) {
      const rel = dirRel ? `${dirRel}/${entry.name}` : entry.name;
      if (SKIPPED_DIRS.has(entry.name)) continue;
      if (entry.isSymbolicLink()) {
        if (matches(rel) || symlinkCouldCarryInput(rel, matchers)) unsafe = true;
        continue;
      }
      if (entry.isDirectory()) {
        await walk(join(dirAbs, entry.name), rel);
      } else if (entry.isFile()) {
        out.push(rel);
      } else if (matches(rel)) {
        unsafe = true;
      }
    }
  }

  await walk(root, '');
  out.sort();
  return { files: out, unsafe };
}

/**
 * Compute the cache key for a cacheable hook.
 *
 * `cacheKey = sha256( canonicalJSON(hook config) + canonicalJSON(sorted matched
 * files [{ path, sha256(content) }]) )`
 *
 * The full hook configuration (command/cwd/timeoutMs/envAllowlist/cacheInputs/
 * cacheable) is part of the key, so any config change switches the key. Matched
 * files are sorted by path before hashing for determinism.
 *
 * @param {Object} hook - A hook descriptor with a non-empty `cacheInputs`.
 * @param {string} root - Absolute project root.
 * @returns {Promise<{ cacheKey: string, matchedFiles: string[] }>}
 * @throws {ReleaseError} GATE_FAILED when any declared glob matches no file.
 */
function hasPathSeparator(command) {
  return typeof command === 'string' && (command.includes('/') || command.includes('\\'));
}

function staticGlobBase(glob) {
  const wildcard = glob.search(/[?*]/);
  const prefix = wildcard === -1 ? glob : glob.slice(0, wildcard);
  const slash = prefix.lastIndexOf('/');
  return slash === -1 ? '' : prefix.slice(0, slash);
}

function symlinkCouldCarryInput(relPath, matchers) {
  return matchers.some(({ glob }) => {
    const base = staticGlobBase(glob);
    return base === '' || relPath === base || relPath.startsWith(`${base}/`);
  });
}

function isWithin(root, candidate) {
  const rel = relative(root, candidate);
  return rel === '' || (rel !== '..' && !rel.startsWith('../') && !rel.startsWith('/'));
}

function nearestCommonDirectory(first, second) {
  const firstParts = first.split('/').filter(Boolean);
  const secondParts = second.split('/').filter(Boolean);
  let length = 0;
  while (length < firstParts.length && firstParts[length] === secondParts[length]) length += 1;
  return length === 0 ? '/' : `/${firstParts.slice(0, length).join('/')}`;
}

async function executableBindingRoot(projectRoot, lexicalPath, targetPath, relativeCommand) {
  if (relativeCommand) return projectRoot;
  if (isWithin(projectRoot, lexicalPath) && isWithin(projectRoot, targetPath)) return projectRoot;
  const common = nearestCommonDirectory(dirname(lexicalPath), dirname(targetPath));
  if (common === '/') return null;
  try {
    const details = await stat(common);
    if (!details.isDirectory()) return null;
    const canonical = await realpath(common);
    return canonical === '/' ? null : canonical;
  } catch {
    return null;
  }
}

async function physicalIdentity(path) {
  const canonical = await realpath(path);
  const details = await stat(canonical);
  return {
    path: canonical,
    device: String(details.dev),
    inode: String(details.ino),
    mode: details.mode,
    type: details.isDirectory() ? 'directory' : details.isFile() ? 'file' : 'other',
  };
}

async function observeHookExecutable(hook, root, options = {}) {
  if (process.platform === 'win32') return { eligible: false, reason: 'WINDOWS' };
  const command = Array.isArray(hook.command) ? hook.command[0] : undefined;
  if (!hasPathSeparator(command) || /^[A-Za-z]:[\\/]/.test(command)) {
    return { eligible: false, reason: 'AMBIENT_PATH_OR_UNSUPPORTED_COMMAND' };
  }

  let projectRoot;
  let cwd;
  let executablePath;
  try {
    projectRoot = await realpath(root);
    const declaredCwd = typeof hook.cwd === 'string' && hook.cwd.length > 0 ? hook.cwd : '.';
    cwd = await realpath(resolve(projectRoot, declaredCwd));
    if (!isWithin(projectRoot, cwd)) return { eligible: false, reason: 'CWD_OUTSIDE_PROJECT' };
    executablePath = isAbsolute(command) ? resolve(command) : resolve(cwd, command);
    if (!isAbsolute(command) && !isWithin(projectRoot, executablePath)) {
      return { eligible: false, reason: 'EXECUTABLE_OUTSIDE_PROJECT' };
    }
    const targetPath = await realpath(executablePath);
    const executableRoot = await executableBindingRoot(
      projectRoot,
      executablePath,
      targetPath,
      !isAbsolute(command),
    );
    if (!executableRoot) return { eligible: false, reason: 'BOUND_ROOT_TOO_BROAD' };
    // The executable observation receives one minimal root covering the
    // lexical absolute entry and its physical target. The project root binding
    // is separate and is used only for cache-record IO.
    const executableBinding = await createFilesystemRootBinding(executableRoot);
    const projectRootBinding = executableRoot === projectRoot
      ? executableBinding : await createFilesystemRootBinding(projectRoot);
    try {
      const observe = options.observeExecutableIdentityFn ?? observeExecutableIdentity;
      const observed = await observe({
        boundRoots: [{ root: executableRoot, rootBinding: executableBinding }],
        lookup: { mode: 'absolute-path', path: executablePath },
      });
      if (!observed || !isDigest(observed.observationDigest)) {
        return { eligible: false, reason: 'OBSERVATION_INVALID' };
      }
      return {
        eligible: true,
        observationDigest: observed.observationDigest,
        projectRoot: await physicalIdentity(projectRoot),
        hookCwd: await physicalIdentity(cwd),
        projectRootBinding,
      };
    } catch {
      return { eligible: false, reason: 'OBSERVATION_FAILED' };
    }
  } catch {
    return { eligible: false, reason: 'OBSERVATION_FAILED' };
  }
}

function sortedObject(object) {
  return Object.fromEntries(Object.keys(object).sort().map((key) => [key, object[key]]));
}

function hasExactKeys(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join('\0') === keys.slice().sort().join('\0');
}

function isDigest(value) {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}

function isValidIdentity(value) {
  return hasExactKeys(value, ['device', 'inode', 'mode', 'path', 'type'])
    && typeof value.path === 'string'
    && typeof value.device === 'string'
    && typeof value.inode === 'string'
    && Number.isInteger(value.mode)
    && ['directory', 'file', 'other'].includes(value.type);
}

function readCurrentReleaseSkillVersion() {
  const validVersion = (version) => typeof version === 'string'
    && version.length > 0 && version.length <= 128 && !/[\u0000-\u001f\u007f]/.test(version)
    ? version : null;
  if (typeof __bundlePkg !== 'undefined' && __bundlePkg && typeof __bundlePkg.version === 'string') {
    return validVersion(__bundlePkg.version);
  }
  try {
    const pkg = JSON.parse(readTrustedPackageResourceSync('package.json').toString('utf8'));
    return validVersion(pkg.version);
  } catch {
    return null;
  }
}

function isValidReceipt(receipt, cacheKey, currentVersion) {
  if (!hasExactKeys(receipt, CACHE_RECEIPT_KEYS)) return false;
  if (receipt.schemaVersion !== CACHE_SCHEMA_VERSION
    || receipt.algorithm !== CACHE_ALGORITHM
    || receipt.receiptVersion !== CACHE_RECEIPT_VERSION
    || receipt.releaseSkillVersion !== currentVersion
    || !isDigest(receipt.hookDigest)
    || !isDigest(receipt.inputsDigest)
    || !isDigest(receipt.envDigest)
    || !isDigest(receipt.executableObservationDigest)
    || !isValidIdentity(receipt.projectRootIdentity)
    || !isValidIdentity(receipt.hookCwdIdentity)
    || !hasExactKeys(receipt.runtime, ['arch', 'node', 'os', 'platform'])
    || typeof receipt.runtime.arch !== 'string'
    || typeof receipt.runtime.node !== 'string'
    || typeof receipt.runtime.os !== 'string'
    || typeof receipt.runtime.platform !== 'string') return false;
  return sha256Hex(canonicalJson(receipt)) === cacheKey;
}

export async function computeHookCacheKey(hook, root, options = {}) {
  const globs = Array.isArray(hook.cacheInputs) ? hook.cacheInputs : [];
  const matchers = globs.map((glob) => ({ glob, re: globToRegExp(glob) }));

  const { files: allFiles, unsafe: unsafeInputs } = await listInputFiles(root, matchers);
  if (unsafeInputs) {
    return { cacheKey: null, matchedFiles: [], cacheable: false, reason: 'INPUT_CLOSURE_UNSAFE' };
  }
  const matched = [];
  const hitPerGlob = matchers.map(() => false);
  for (const relPath of allFiles) {
    let hit = false;
    for (let i = 0; i < matchers.length; i += 1) {
      if (matchers[i].re.test(relPath)) {
        hitPerGlob[i] = true;
        hit = true;
      }
    }
    if (hit) matched.push(relPath);
  }

  // Fail-closed: a glob that matches nothing is a declaration error (a typo or
  // a missing input). Refuse to cache rather than risk a false hit.
  for (let i = 0; i < matchers.length; i += 1) {
    if (!hitPerGlob[i]) {
      throw new ReleaseError(
        GATE_FAILED,
        `hook cacheInputs glob "${matchers[i].glob}" matched no files; refusing to cache`,
        { glob: matchers[i].glob },
      );
    }
  }

  matched.sort();
  const fileEntries = [];
  for (const relPath of matched) {
    try {
      const content = await readFileStrict(root, relPath);
      if (!content || !Buffer.isBuffer(content.content) || !isDigest(content.sha256)) {
        return { cacheKey: null, matchedFiles: matched, cacheable: false, reason: 'INPUT_READ_FAILED' };
      }
      fileEntries.push({ path: relPath, sha256: content.sha256 });
    } catch {
      return { cacheKey: null, matchedFiles: matched, cacheable: false, reason: 'INPUT_READ_FAILED' };
    }
  }

  const observed = await observeHookExecutable(hook, root, options);
  if (!observed.eligible) {
    return { cacheKey: null, matchedFiles: matched, cacheable: false, reason: observed.reason };
  }

  const releaseSkillVersion = readCurrentReleaseSkillVersion();
  if (releaseSkillVersion === null) {
    return { cacheKey: null, matchedFiles: matched, cacheable: false, reason: 'VERSION_UNAVAILABLE' };
  }
  const selectedEnv = buildHookEnvironment(hook.envAllowlist ?? [], options.env ?? process.env);
  const receipt = {
    schemaVersion: CACHE_SCHEMA_VERSION,
    algorithm: CACHE_ALGORITHM,
    receiptVersion: CACHE_RECEIPT_VERSION,
    hookDigest: sha256Hex(canonicalJson(hook)),
    inputsDigest: sha256Hex(canonicalJson(fileEntries)),
    envDigest: sha256Hex(canonicalJson(sortedObject(selectedEnv))),
    releaseSkillVersion,
    runtime: {
      platform: process.platform,
      arch: process.arch,
      os: osRelease(),
      node: process.versions.node,
    },
    projectRootIdentity: observed.projectRoot,
    hookCwdIdentity: observed.hookCwd,
    executableObservationDigest: observed.observationDigest,
  };
  const cacheKey = sha256Hex(canonicalJson(receipt));
  return { cacheKey, matchedFiles: matched, cacheable: true, receipt };
}

/**
 * Resolve the cache directory for a named hook.
 *
 * @param {string} root
 * @param {string} hookName
 * @returns {string} Absolute path to `.release-skill/cache/hooks/<hookName>`.
 */
export function hookCacheDir(root, hookName) {
  return join(root, ...CACHE_BASE, hookName);
}

/**
 * Resolve the cache record path for a hook + key.
 *
 * @param {string} root
 * @param {string} hookName
 * @param {string} cacheKey
 * @returns {string} Absolute path to the `<cacheKey>.json` record.
 */
export function hookCachePath(root, hookName, cacheKey) {
  return join(hookCacheDir(root, hookName), `${cacheKey}.json`);
}

function hookCacheRelativePath(hookName, cacheKey) {
  return join(...CACHE_BASE, hookName, `${cacheKey}.json`);
}

/**
 * Read a cached hook result. Returns the record only when it exists, its key
 * matches, and it recorded a successful (`exitCode === 0`) run; anything else
 * (missing, corrupt, or non-zero) is a miss.
 *
 * @param {string} root
 * @param {string} hookName
 * @param {string} cacheKey
 * @returns {Promise<Object | null>}
 */
async function resolveCacheRoot(root, suppliedBinding) {
  const projectRoot = await realpath(root);
  const rootBinding = suppliedBinding ?? await createFilesystemRootBinding(projectRoot);
  return { projectRoot, rootBinding };
}

export async function readHookCache(root, hookName, cacheKey, options = {}) {
  try {
    const currentVersion = readCurrentReleaseSkillVersion();
    if (currentVersion === null) return null;
    const { projectRoot, rootBinding } = await resolveCacheRoot(root, options.rootBinding);
    const rawReceipt = await readFileBound(projectRoot, hookCacheRelativePath(hookName, cacheKey), {
      rootBinding,
      encoding: 'utf8',
    });
    const raw = rawReceipt?.content;
    if (typeof raw !== 'string') return null;
    const record = JSON.parse(raw);
    if (record && record.cacheKey === cacheKey && record.exitCode === 0
      && hasExactKeys(record, CACHE_RECORD_KEYS)
      && record.schemaVersion === CACHE_SCHEMA_VERSION
      && record.kind === CACHE_KIND
      && record.algorithm === CACHE_ALGORITHM
      && record.receiptVersion === CACHE_RECEIPT_VERSION
      && typeof record.createdAt === 'string'
      && typeof record.stdoutTail === 'string'
      && typeof record.stderrTail === 'string'
      && record.stdoutTail.length <= TAIL_LENGTH
      && record.stderrTail.length <= TAIL_LENGTH
      && isValidReceipt(record.receipt, cacheKey, currentVersion)) {
      return record;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Write a successful hook result to the cache. Never throws: a write failure
 * returns `{ ok: false, error }` so the caller can record a warning without
 * aborting prepare (the cache is an optimisation, not a gate).
 *
 * @param {string} root
 * @param {string} hookName
 * @param {string} cacheKey
 * @param {Object} result
 * @param {number} result.exitCode - Must be 0; non-zero results are not cached.
 * @param {string} [result.stdoutTail] - Already truncated to TAIL_LENGTH.
 * @param {string} [result.stderrTail] - Already truncated to TAIL_LENGTH.
 * @param {string} [result.createdAt] - ISO timestamp (defaults to now).
 * @param {Object} result.receipt - The v2 cache receipt produced with the key.
 * @returns {Promise<{ ok: true } | { ok: false, error: string }>}
 */
export async function writeHookCache(root, hookName, cacheKey, result, options = {}) {
  // Defence in depth: a failure must never be persisted, even if a caller
  // mistakenly passes a non-zero exit code.
  if (!result || result.exitCode !== 0) {
    return { ok: false, error: 'refusing to cache a non-zero exit result' };
  }
  try {
    const currentVersion = readCurrentReleaseSkillVersion();
    if (!isValidReceipt(result.receipt, cacheKey, currentVersion)) {
      return { ok: false, error: 'refusing to cache without a v2 receipt' };
    }
    const record = {
      schemaVersion: CACHE_SCHEMA_VERSION,
      kind: CACHE_KIND,
      algorithm: CACHE_ALGORITHM,
      receiptVersion: CACHE_RECEIPT_VERSION,
      cacheKey,
      exitCode: 0,
      stdoutTail: String(result.stdoutTail ?? '').slice(-TAIL_LENGTH),
      stderrTail: String(result.stderrTail ?? '').slice(-TAIL_LENGTH),
      createdAt: result.createdAt ?? new Date().toISOString(),
      receipt: result.receipt,
    };
    const { projectRoot, rootBinding } = await resolveCacheRoot(root, options.rootBinding);
    const relPath = hookCacheRelativePath(hookName, cacheKey);
    const bytes = `${JSON.stringify(record, null, 2)}\n`;
    try {
      await publishFileExclusive(projectRoot, relPath, bytes, { mode: 0o644, createParents: true });
    } catch (err) {
      if (err?.details?.kind !== HARNESS_ERROR_KINDS.EXCLUSIVE_PUBLISH_CONFLICT) throw err;
      await publishFileOrReplace(projectRoot, relPath, bytes, { mode: 0o644 });
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}
