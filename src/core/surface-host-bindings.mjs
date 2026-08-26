/**
 * R-13 surface host binding derivation (0.8.0).
 *
 * Single-plugin root host surface repair: the real host surface of a plugin
 * distribution is derived from the frozen installation facts — the plugin
 * manifest `skills` path (validated against the platform's manifest rules)
 * anchored at the manifest's plugin root — and canonicalized through the
 * Foundation host profiles. The resulting in-memory `{ surfaceId, host }`
 * bindings are passed to the skill-resource-closure checker so its surface
 * host labels and the G4 declared-host coverage agree with the installation
 * contract at prepare, publish, and verify.
 *
 * Derivation rules (design single-plugin-root-host-surface-binding.md §4.2):
 * - `skillSurfaceId = normalizeSurfacePath(join(pluginRoot, dirname(skillsRel)))`
 * - pluginRoot is the manifest's directory relative to the snapshot root
 *   ('.' for `<root>/.claude-plugin/plugin.json`, or the marketplace entry
 *   source subdirectory for bundled-family layouts);
 * - a manifest without a `skills` field yields no binding and the checker's
 *   inference path stays authoritative (legacy adapter layouts);
 * - unsafe / empty / out-of-bounds skills paths fail closed;
 * - the bound host is `normalizeHostId(platform.buildAdapter.name)` — one
 *   canonical identity per platform, never a user-fillable string.
 */

import { dirname, isAbsolute, join, normalize, resolve, sep } from 'node:path';
import { lstat } from 'node:fs/promises';

import { normalizeHostId } from '../platforms/registry.mjs';
import { ReleaseError, GATE_FAILED } from './errors.mjs';
import {
  normalizeCodeBuddySkillsRel,
  normalizeKimiSkillsRel,
} from '../adapters/plugin-marketplace.mjs';

/**
 * Normalize a snapshot-root-relative surface path: strip a leading './',
 * collapse separators, and fail closed on empty, absolute, or out-of-bounds
 * values.
 *
 * @param {string} rawPath - relative path from the snapshot root.
 * @returns {string} normalized relative path ('.' for the root itself).
 */
export function normalizeSurfacePath(rawPath) {
  if (typeof rawPath !== 'string' || rawPath.length === 0) {
    throw new Error('surface path must be a non-empty relative path');
  }
  if (isAbsolute(rawPath) || rawPath.includes('\\')) {
    throw new Error(`surface path "${rawPath}" must be snapshot-root-relative`);
  }
  const normalized = normalize(rawPath).replace(/^\.\//, '').replace(/\/+$/, '');
  if (normalized === '.') return '.';
  if (
    normalized === '' ||
    normalized === '..' ||
    normalized.startsWith(`..${sep}`) ||
    normalized.split(sep).some((segment) => segment === '' || segment === '..')
  ) {
    throw new Error(`surface path "${rawPath}" escapes the snapshot root or is empty`);
  }
  return normalized;
}

/**
 * Generic manifest `skills` path validator for platforms whose manifest
 * format carries a plain relative path (claude / codex). Returns the
 * normalized plugin-root-relative path (no leading './', no trailing '/').
 *
 * @param {string} skillsRaw
 * @returns {string} normalized relative path ('' for the plugin root itself)
 */
export function normalizeGenericSkillsRel(skillsRaw) {
  if (typeof skillsRaw !== 'string' || skillsRaw.length === 0) {
    throw new Error('plugin manifest skills must be a non-empty relative path when present');
  }
  if (
    skillsRaw.startsWith('/') ||
    skillsRaw.includes('..') ||
    skillsRaw.includes('\\') ||
    /^https?:\/\//i.test(skillsRaw)
  ) {
    throw new Error(`plugin manifest skills "${skillsRaw}" is not a safe relative path`);
  }
  let rel = skillsRaw.replace(/^\.\//, '');
  rel = rel.replace(/\/+$/, '');
  if (rel.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')) {
    throw new Error(`plugin manifest skills "${skillsRaw}" is not a safe relative path`);
  }
  return rel;
}

const SKILLS_NORMALIZERS = {
  claude: normalizeGenericSkillsRel,
  codex: normalizeGenericSkillsRel,
  kimi: normalizeKimiSkillsRel,
  codebuddy: normalizeCodeBuddySkillsRel,
};

/**
 * Shared rule: the plugin root of a frozen manifest fact is the directory
 * that contains the manifest file. Frozen manifest relative paths have the
 * shape `<pluginRoot>/<platform-manifest-dir>/<manifest-file>` (e.g.
 * `.claude-plugin/plugin.json` → `.`, `adapters/claude/.claude-plugin/
 * plugin.json` → `adapters/claude`), so stripping the last two segments
 * yields the plugin root. prepare, publish, and verify must all use this
 * single interpretation — no caller may write its own path math.
 *
 * @param {string} manifestRelativePath - snapshot-root-relative manifest path.
 * @returns {string} normalized plugin-root-relative path ('.' for the root).
 */
export function pluginRootFromManifestRelativePath(manifestRelativePath) {
  return dirname(dirname(manifestRelativePath));
}

/**
 * P1 (ruling 6): verify that the manifest-declared skills directory
 * physically exists under the given snapshot/install root. The surface
 * derivation trims the declared path to its parent surface (skills './skills/'
 * surfaces '.'), so a missing declared directory must fail closed here —
 * otherwise a parent surface that carries skills from somewhere else masks
 * the missing directory and prepare/publish/verify would judge success.
 *
 * @param {string} snapshotDir - absolute snapshot or install root.
 * @param {string} pluginRoot - plugin-root-relative path ('.' or subdir).
 * @param {string} skillsRel - normalized plugin-root-relative skills path
 *   ('' for the plugin root itself, e.g. Kimi './').
 * @throws {ReleaseError} GATE_FAILED when the declared directory is missing,
 *   not a directory, or a symlink.
 */
async function assertDeclaredSkillsDirExists(snapshotDir, pluginRoot, skillsRel) {
  const declaredDir = join(pluginRoot, skillsRel);
  let stat;
  try {
    stat = await lstat(resolve(snapshotDir, declaredDir));
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw new ReleaseError(
        GATE_FAILED,
        `plugin manifest skills directory "${declaredDir}" does not exist in the snapshot`,
        { declaredSkillsDir: declaredDir },
      );
    }
    throw err;
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new ReleaseError(
      GATE_FAILED,
      `plugin manifest skills directory "${declaredDir}" is not a real directory in the snapshot`,
      { declaredSkillsDir: declaredDir },
    );
  }
}

/**
 * Derive the single surface host binding of a plugin distribution from its
 * frozen manifest facts.
 *
 * @param {object} input
 * @param {object} input.manifest - parsed plugin manifest (frozen bytes).
 * @param {string} input.pluginRoot - manifest directory relative to the
 *   snapshot root ('.' or a subdirectory).
 * @param {object} input.platform - platform descriptor from the registry.
 * @param {string} [input.snapshotDir] - absolute snapshot/install root. When
 *   provided, the manifest-declared skills directory must physically exist
 *   under it (P1: a missing declared directory must never be masked by a
 *   non-empty parent surface). prepare, publish, and verify all pass it.
 * @returns {Promise<{ surfaceId: string, host: string }|null>} the binding,
 *   or null when the manifest declares no `skills` path (inference stays
 *   authoritative).
 */
export async function deriveSurfaceHostBinding({ manifest, pluginRoot, platform, snapshotDir }) {
  const skillsRaw = manifest?.skills;
  if (skillsRaw === undefined || skillsRaw === null) return null;
  const normalizeSkillsRel = SKILLS_NORMALIZERS[platform.id];
  if (!normalizeSkillsRel) {
    throw new Error(`platform "${platform.id}" has no manifest skills normalizer`);
  }
  const skillsRel = normalizeSkillsRel(skillsRaw);
  if (snapshotDir !== undefined && snapshotDir !== null) {
    await assertDeclaredSkillsDirExists(snapshotDir, pluginRoot, skillsRel);
  }
  // A skills path at the plugin root itself (e.g. './skills/') surfaces the
  // plugin root; a nested path surfaces its parent directory.
  const skillsDir = dirname(skillsRel); // 'skills' → '.', 'adapters/claude/skills' → 'adapters/claude'
  const rawSurfaceId = join(pluginRoot, skillsDir);
  const surfaceId = normalizeSurfacePath(rawSurfaceId);
  const host = await normalizeHostId(platform.buildAdapter.name);
  return { surfaceId, host };
}
