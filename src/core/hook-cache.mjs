/**
 * Incremental hook result cache (T3.2).
 *
 * A hook that opts in with `cacheable: true` and a `cacheInputs` glob list is
 * keyed by the fingerprint of its full configuration plus the content of every
 * file its inputs match. When the key is unchanged and the last run succeeded,
 * prepare replays the cached outcome instead of re-executing the hook.
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

import { readdir, readFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { canonicalJson, sha256Hex } from './digest.mjs';
import { ReleaseError, GATE_FAILED } from './errors.mjs';

/** Control-plane location of hook cache records: `.release-skill/cache/hooks`. */
const CACHE_BASE = ['.release-skill', 'cache', 'hooks'];

/** Bounded tail length stored per stream (matches prepare's evidence tails). */
const TAIL_LENGTH = 4000;

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
async function listInputFiles(root) {
  const out = [];

  async function walk(dirAbs, dirRel) {
    let entries;
    try {
      entries = await readdir(dirAbs, { withFileTypes: true });
    } catch {
      return; // Unreadable directory: treat as no inputs there.
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (SKIPPED_DIRS.has(entry.name)) continue;
        const rel = dirRel ? `${dirRel}/${entry.name}` : entry.name;
        await walk(join(dirAbs, entry.name), rel);
      } else if (entry.isFile()) {
        out.push(dirRel ? `${dirRel}/${entry.name}` : entry.name);
      }
    }
  }

  await walk(root, '');
  out.sort();
  return out;
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
export async function computeHookCacheKey(hook, root) {
  const globs = Array.isArray(hook.cacheInputs) ? hook.cacheInputs : [];
  const matchers = globs.map((glob) => ({ glob, re: globToRegExp(glob) }));

  const allFiles = await listInputFiles(root);
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
    const content = await readFile(join(root, relPath));
    fileEntries.push({ path: relPath, sha256: sha256Hex(content) });
  }

  const cacheKey = sha256Hex(canonicalJson(hook) + canonicalJson(fileEntries));
  return { cacheKey, matchedFiles: matched };
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
export async function readHookCache(root, hookName, cacheKey) {
  try {
    const raw = await readFile(hookCachePath(root, hookName, cacheKey), 'utf8');
    const record = JSON.parse(raw);
    if (record && record.cacheKey === cacheKey && record.exitCode === 0) {
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
 * @returns {Promise<{ ok: true } | { ok: false, error: string }>}
 */
export async function writeHookCache(root, hookName, cacheKey, result) {
  // Defence in depth: a failure must never be persisted, even if a caller
  // mistakenly passes a non-zero exit code.
  if (!result || result.exitCode !== 0) {
    return { ok: false, error: 'refusing to cache a non-zero exit result' };
  }
  try {
    await mkdir(hookCacheDir(root, hookName), { recursive: true });
    const record = {
      cacheKey,
      exitCode: 0,
      stdoutTail: String(result.stdoutTail ?? '').slice(-TAIL_LENGTH),
      stderrTail: String(result.stderrTail ?? '').slice(-TAIL_LENGTH),
      createdAt: result.createdAt ?? new Date().toISOString(),
    };
    await writeFile(hookCachePath(root, hookName, cacheKey), `${JSON.stringify(record, null, 2)}\n`, 'utf8');
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}
