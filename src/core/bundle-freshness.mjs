/**
 * Bundle freshness authority (2026-08-18 release-cycle investigation §4.2).
 *
 * `bin/release-skill.bundle.mjs` is the shipped form of `src/`. When the two
 * drift, failures used to surface deep inside test hooks; this module gives
 * prepare an earliest-stage, fail-closed staleness gate:
 *
 * - The build script computes a deterministic digest over the bundle's source
 *   inputs (src/, skills-src/ when present, bin/release-skill-cli.mjs,
 *   package.json) and embeds it in the bundle banner as a build-time
 *   constant (`__bundleSourceDigest`).
 * - prepare recomputes the source digest and compares it with the embedded
 *   constant. Any mismatch — including a missing bundle or a bundle without
 *   the constant — fails closed with BUNDLE_STALE.
 * - Installed distributions ship no mutable src/ next to the bundle except
 *   the projected runtime schemas (src/schemas), so the gate is not
 *   applicable there; it records that fact instead of failing.
 *
 * The digest algorithm is shared with scripts/build-bundle.mjs so build and
 * gate can never disagree about what "in sync" means.
 *
 * @module core/bundle-freshness
 */

import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { ReleaseError, BUNDLE_STALE } from './errors.mjs';

/**
 * Digest algorithm marker. Bump when the input set or hashing scheme changes;
 * the value participates in the digest so old embedded digests never match.
 */
export const BUNDLE_SOURCE_DIGEST_ALGORITHM = 'bundle-source-digest-v1';

/** Bundle file name, relative to the package root. */
const BUNDLE_RELPATH = join('bin', 'release-skill.bundle.mjs');

/**
 * Directories whose entire content participates in the source digest.
 * skills-src is included although esbuild does not inline it: the bundle is
 * the release artifact's build authority, and a skills-src change still
 * requires a rebuild so the embedded digest stays current.
 */
const SOURCE_DIRS = ['src', 'skills-src'];

/** Individual files that participate in the source digest. */
const SOURCE_FILES = [join('bin', 'release-skill-cli.mjs'), 'package.json'];

/** Pattern matching the build-time digest constant embedded in the banner. */
const EMBEDDED_DIGEST_PATTERN = /const __bundleSourceDigest = "([a-f0-9]{64})";/;

/**
 * Absolute path of the bundle for a package root.
 *
 * @param {string} pkgRoot - Absolute package root.
 * @returns {string}
 */
export function bundlePathFor(pkgRoot) {
  return join(pkgRoot, BUNDLE_RELPATH);
}

/**
 * Recursively list files under a directory as sorted relative paths.
 * Uses '/' separators for cross-platform determinism.
 *
 * @param {string} dir - Absolute directory.
 * @param {string} [prefix] - Internal recursion prefix.
 * @returns {Promise<string[]>}
 */
async function listFilesSorted(dir, prefix = '') {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      files.push(...(await listFilesSorted(join(dir, entry.name), rel)));
    } else if (entry.isFile()) {
      files.push(rel);
    }
  }
  return files;
}

/**
 * Enumerate the bundle's source inputs as relative paths (sorted, stable).
 * Missing optional inputs (skills-src/, individual files) are skipped; the
 * caller decides whether the resulting set is meaningful.
 *
 * @param {string} pkgRoot - Absolute package root.
 * @returns {Promise<string[]>}
 */
export async function listBundleSourceInputs(pkgRoot) {
  const inputs = [];
  for (const dir of SOURCE_DIRS) {
    const abs = join(pkgRoot, dir);
    const st = await stat(abs).catch(() => null);
    if (st?.isDirectory()) {
      for (const rel of await listFilesSorted(abs)) {
        inputs.push(`${dir}/${rel}`);
      }
    }
  }
  for (const rel of SOURCE_FILES) {
    const st = await stat(join(pkgRoot, rel)).catch(() => null);
    if (st?.isFile()) {
      inputs.push(rel.split(/[\\/]/).join('/'));
    }
  }
  return inputs.sort();
}

/**
 * Compute the deterministic source digest over the bundle's source inputs.
 *
 * @param {string} pkgRoot - Absolute package root.
 * @returns {Promise<string>} sha256 hex digest.
 */
export async function computeBundleSourceDigest(pkgRoot) {
  const inputs = await listBundleSourceInputs(pkgRoot);
  const hash = createHash('sha256');
  hash.update(BUNDLE_SOURCE_DIGEST_ALGORITHM);
  hash.update('\n');
  for (const rel of inputs) {
    const content = await readFile(join(pkgRoot, rel));
    hash.update(rel);
    hash.update('\0');
    hash.update(createHash('sha256').update(content).digest('hex'));
    hash.update('\n');
  }
  return hash.digest('hex');
}

/**
 * Extract the embedded build-time source digest from a bundle's text.
 *
 * @param {string} bundlePath - Absolute bundle path.
 * @returns {Promise<string | null>} The digest, or null when the bundle is
 *   missing or carries no digest constant.
 */
export async function readEmbeddedBundleDigest(bundlePath) {
  let content;
  try {
    content = await readFile(bundlePath, 'utf8');
  } catch {
    return null;
  }
  const match = content.match(EMBEDDED_DIGEST_PATTERN);
  return match ? match[1] : null;
}

/**
 * Decide bundle freshness for a package root (pure decision, no throw).
 *
 * Installed-layout classification (ruling 9 / B1): the 0.8.0 build projects
 * the contracts runtime schemas into `src/schemas/` next to the bundle, so
 * an installed root or adapter ships an `src/` directory even though no
 * source checkout is present. The layout is "installed" only when src/
 * contains nothing but the `schemas` subtree; any other src/ member — even a
 * PARTIAL source tree — is a source layout and fails closed through the
 * regular digest comparison.
 *
 * @param {string} pkgRoot - Absolute package root.
 * @returns {Promise<{
 *   applicable: boolean,
 *   fresh: boolean,
 *   reason: 'installed-layout' | 'bundle-missing' | 'digest-missing' | 'digest-mismatch' | 'fresh',
 *   embeddedDigest: string | null,
 *   sourceDigest: string | null,
 *   algorithm: string,
 * }>}
 */
export async function checkBundleFreshness(pkgRoot) {
  const base = {
    applicable: true,
    fresh: false,
    embeddedDigest: null,
    sourceDigest: null,
    algorithm: BUNDLE_SOURCE_DIGEST_ALGORITHM,
  };

  // Installed distributions ship the bundle without mutable sources next to
  // it; staleness is a source-checkout concern only. The ONLY src/ content an
  // installed layout carries is the projected runtime-schema subtree.
  const srcStat = await stat(join(pkgRoot, 'src')).catch(() => null);
  if (!srcStat?.isDirectory()) {
    return { ...base, applicable: false, reason: 'installed-layout' };
  }
  const srcMembers = await readdir(join(pkgRoot, 'src'));
  const schemasOnly = srcMembers.length > 0
    && srcMembers.every((name) => name === 'schemas')
    && (await stat(join(pkgRoot, 'src', 'schemas')).catch(() => null))?.isDirectory();
  if (schemasOnly) {
    return { ...base, applicable: false, reason: 'installed-layout' };
  }

  const bundleStat = await stat(bundlePathFor(pkgRoot)).catch(() => null);
  if (!bundleStat?.isFile()) {
    return { ...base, reason: 'bundle-missing' };
  }

  const [embeddedDigest, sourceDigest] = await Promise.all([
    readEmbeddedBundleDigest(bundlePathFor(pkgRoot)),
    computeBundleSourceDigest(pkgRoot),
  ]);

  if (!embeddedDigest) {
    return { ...base, sourceDigest, reason: 'digest-missing' };
  }
  if (embeddedDigest !== sourceDigest) {
    return { ...base, embeddedDigest, sourceDigest, reason: 'digest-mismatch' };
  }
  return { ...base, fresh: true, embeddedDigest, sourceDigest, reason: 'fresh' };
}

/** Human-facing rebuild instruction embedded in every BUNDLE_STALE error. */
export const BUNDLE_REBUILD_COMMAND = 'node scripts/build-bundle.mjs';

/**
 * Fail-closed freshness assertion used by prepare's earliest stage.
 *
 * Not applicable layouts return quietly; every stale/undecidable state in a
 * source checkout throws BUNDLE_STALE with the rebuild command.
 *
 * @param {string} pkgRoot - Absolute package root.
 * @returns {Promise<object>} The freshness decision (see checkBundleFreshness).
 * @throws {ReleaseError} BUNDLE_STALE when the bundle is stale or undecidable.
 */
export async function assertBundleFreshness(pkgRoot) {
  const result = await checkBundleFreshness(pkgRoot);
  if (!result.applicable) {
    return result;
  }
  if (result.fresh) {
    return result;
  }
  const reasonText = {
    'bundle-missing': 'the bundle file is missing',
    'digest-missing': 'the bundle carries no embedded source digest',
    'digest-mismatch': 'the bundle is out of sync with src/',
  }[result.reason] ?? result.reason;
  throw new ReleaseError(
    BUNDLE_STALE,
    `bin/release-skill.bundle.mjs is stale: ${reasonText}. Rebuild it from the release-skill package root with: ${BUNDLE_REBUILD_COMMAND} (or pnpm build)`,
    {
      reason: result.reason,
      algorithm: result.algorithm,
      embeddedDigest: result.embeddedDigest,
      sourceDigest: result.sourceDigest,
      rebuildCommand: BUNDLE_REBUILD_COMMAND,
    },
  );
}
