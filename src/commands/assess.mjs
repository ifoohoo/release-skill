/**
 * Read-only assess command for release-skill.
 *
 * Performs read-only diagnostics: config schema validation, topology
 * identification, common docs check, plugin manifest check, package metadata,
 * remote prerequisites (skipped in --offline mode), and basic README structure.
 *
 * Classifies gaps into three scopes:
 * - common: universally required (README, LICENSE, config validity)
 * - profile: required for a specific distribution type (npm needs package.json,
 *   plugin needs manifest)
 * - project: project-specific (policy violations, custom requirements)
 *
 * Does NOT modify the working tree unless an explicit --output path is given.
 *
 * @module commands/assess
 */

import { readFile, stat, writeFile, mkdir } from 'node:fs/promises';
import { resolve, dirname, relative } from 'node:path';
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';

import { loadProjectConfig } from '../core/config.mjs';
import { ReleaseError, CONFIG_INVALID, GATE_FAILED } from '../core/errors.mjs';
import { collectExpectedPublicSurfaceAdoptionWarnings } from '../core/public-surface.mjs';

const execFile = promisify(execFileCb);

// ---------------------------------------------------------------------------
// Gap severity levels
// ---------------------------------------------------------------------------

/** @enum {string} */
export const Severity = Object.freeze({
  ERROR: 'error',
  WARNING: 'warning',
});

/** @enum {string} */
export const GapScope = Object.freeze({
  COMMON: 'common',
  PROFILE: 'profile',
  PROJECT: 'project',
});

/** @enum {string} */
export const GapCategory = Object.freeze({
  CONFIG: 'config',
  DOCS: 'docs',
  MANIFEST: 'manifest',
  METADATA: 'metadata',
  REMOTE: 'remote',
  README: 'readme',
  POLICY: 'policy',
});

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Check whether a file exists and is accessible.
 *
 * @param {string} filePath - Absolute path.
 * @returns {Promise<boolean>}
 */
async function fileExists(filePath) {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Create a gap entry.
 *
 * @param {Object} params
 * @param {string} params.scope - GapScope value.
 * @param {string} params.category - GapCategory value.
 * @param {string} params.severity - Severity value.
 * @param {string} params.code - Machine-readable gap code.
 * @param {string} params.message - Human-readable message (Chinese).
 * @param {string} [params.file] - Optional file path related to the gap.
 * @returns {Object}
 */
function createGap({ scope, category, severity, code, message, file }) {
  const gap = { scope, category, severity, code, message };
  if (file !== undefined) {
    gap.file = file;
  }
  return Object.freeze(gap);
}

/**
 * Return a project-root-relative display path for a file inside a release unit.
 *
 * @param {Object} unit - Release unit configuration.
 * @param {string} file - Path relative to the unit source.
 * @returns {string}
 */
function unitFile(unit, file) {
  return unit.source === '.' ? file : `${unit.source}/${file}`;
}

/**
 * Decide whether a failed `npm view` check proves the queried version is
 * absent from the registry.
 *
 * Only an explicit E404/ETARGET from npm (the registry answered "not found",
 * either for the package or for the exact version) is trusted as proof of
 * absence. Network errors, auth failures, timeouts, a missing npm CLI, and
 * any other failure remain unknown: they must be reported as a failed check
 * instead of being silently treated as "no gap".
 *
 * @param {Error & { stdout?: string, stderr?: string, message?: string }} error - execFile rejection.
 * @returns {boolean} true when npm explicitly reported the version as absent.
 */
function isVersionAbsentError(error) {
  const text = [
    error?.stdout,
    error?.stderr,
    error?.message,
  ]
    .filter((part) => typeof part === 'string')
    .join('\n');
  return /\bE404\b|\bETARGET\b/i.test(text);
}

/**
 * Extract a short, safe error token from a failed `npm view` invocation.
 *
 * Only npm's machine error code (e.g. ECONNREFUSED, E404) or a spawn-level
 * code (e.g. ENOENT for a missing npm CLI) is returned. Raw stderr is never
 * embedded because it can contain absolute paths and npm log file locations.
 *
 * @param {Error & { code?: unknown, stderr?: string, message?: string }} error - execFile rejection.
 * @returns {string} npm error code, spawn-level code, or 'UNKNOWN'.
 */
function describeNpmError(error) {
  const spawnCode = error?.code;
  if (typeof spawnCode === 'string' && /^[A-Z][A-Z0-9_]{2,}$/.test(spawnCode)) {
    return spawnCode;
  }
  const text = `${error?.stderr ?? ''}\n${error?.message ?? ''}`;
  const match = /\bcode\s+([A-Z][A-Z0-9_]{2,})\b/i.exec(text);
  return match ? match[1] : 'UNKNOWN';
}

/**
 * Determine the project topology from the loaded config.
 *
 * Examines the distribution types to classify the project.
 *
 * @param {Object} config - The validated project config.
 * @returns {{ type: string, releaseUnits: string[], distributions: string[] }}
 */
function identifyTopology(config) {
  const units = config.releaseUnits ?? [];
  const unitIds = units.map((u) => u.id);

  const allDistTypes = [];
  for (const unit of units) {
    for (const dist of unit.distributions ?? []) {
      allDistTypes.push(dist.type);
    }
  }
  const uniqueDistTypes = [...new Set(allDistTypes)];

  let type = 'unknown';
  const hasNpm = uniqueDistTypes.includes('npm');
  const hasPlugin =
    uniqueDistTypes.includes('claude-plugin') ||
    uniqueDistTypes.includes('codex-plugin') ||
    uniqueDistTypes.includes('kimi-plugin') ||
    uniqueDistTypes.includes('codebuddy-plugin');

  if (units.length === 0) {
    type = 'no-release-units';
  } else if (units.length === 1) {
    if (hasNpm && hasPlugin) {
      type = 'hybrid-plugin-npm';
    } else if (hasNpm) {
      type = 'single-npm';
    } else if (hasPlugin) {
      type = 'single-plugin';
    } else {
      type = 'single-unit';
    }
  } else {
    type = 'split-public-repos';
  }

  return { type, releaseUnits: unitIds, distributions: uniqueDistTypes };
}

// ---------------------------------------------------------------------------
// Individual assessment checks
// ---------------------------------------------------------------------------

/**
 * Validate the project configuration.
 *
 * @param {string} root - Project root.
 * @returns {Promise<{ config: Object|null, configPath: string|null, configDigest: string|null, gaps: Object[] }>}
 */
async function checkConfig(root) {
  try {
    const result = await loadProjectConfig({ root });
    return {
      config: result.config,
      configPath: result.configPath,
      configDigest: result.configDigest,
      gaps: [],
    };
  } catch (err) {
    if (err instanceof ReleaseError && err.code === CONFIG_INVALID) {
      return {
        config: null,
        configPath: null,
        configDigest: null,
        gaps: [
          createGap({
            scope: GapScope.COMMON,
            category: GapCategory.CONFIG,
            severity: Severity.ERROR,
            code: 'CONFIG_INVALID',
            message: `配置文件无效: ${err.message}`,
          }),
        ],
      };
    }
    // Unexpected error
    return {
      config: null,
      configPath: null,
      configDigest: null,
      gaps: [
        createGap({
          scope: GapScope.COMMON,
          category: GapCategory.CONFIG,
          severity: Severity.ERROR,
          code: 'CONFIG_ERROR',
          message: `配置加载失败: ${err.message}`,
        }),
      ],
    };
  }
}

/**
 * Check for required and recommended common documentation files.
 *
 * @param {string} root - Project root.
 * @param {Object} config - The validated project config.
 * @returns {Promise<Object[]>} Array of gap entries.
 */
async function checkCommonDocs(root, config) {
  const gaps = [];
  const units = config.releaseUnits ?? [];

  // Required files
  const requiredDocs = [
    { file: 'README.md', code: 'README_MISSING', message: '缺少 README.md 文件' },
    { file: 'LICENSE', code: 'LICENSE_MISSING', message: '缺少 LICENSE 文件' },
  ];

  for (const unit of units) {
    const unitRoot = resolve(root, unit.source);
    for (const doc of requiredDocs) {
      const exists = await fileExists(resolve(unitRoot, doc.file));
      if (!exists) {
        gaps.push(
          createGap({
            scope: GapScope.COMMON,
            category: GapCategory.DOCS,
            severity: Severity.ERROR,
            code: doc.code,
            message: `${doc.message}（发布单元 "${unit.id}"）`,
            file: unitFile(unit, doc.file),
          }),
        );
      }
    }
  }

  // Recommended files (warning-level)
  const recommendedDocs = [
    { file: 'CHANGELOG.md', code: 'CHANGELOG_MISSING', message: '建议添加 CHANGELOG.md' },
    { file: 'SECURITY.md', code: 'SECURITY_MISSING', message: '建议添加 SECURITY.md' },
    { file: 'CONTRIBUTING.md', code: 'CONTRIBUTING_MISSING', message: '建议添加 CONTRIBUTING.md' },
  ];

  for (const unit of units) {
    const unitRoot = resolve(root, unit.source);
    for (const doc of recommendedDocs) {
      const exists = await fileExists(resolve(unitRoot, doc.file));
      if (!exists) {
        gaps.push(
          createGap({
            scope: GapScope.COMMON,
            category: GapCategory.DOCS,
            severity: Severity.WARNING,
            code: doc.code,
            message: `${doc.message}（发布单元 "${unit.id}"）`,
            file: unitFile(unit, doc.file),
          }),
        );
      }
    }
  }

  return gaps;
}

/**
 * Check plugin manifests for Claude and Codex plugin distributions.
 *
 * @param {string} root - Project root.
 * @param {Object} config - The validated project config.
 * @returns {Promise<Object[]>} Array of gap entries.
 */
async function checkPluginManifests(root, config) {
  const gaps = [];
  const units = config.releaseUnits ?? [];

  for (const unit of units) {
    const distributionTypes = new Set((unit.distributions ?? []).map((dist) => dist.type));
    const unitRoot = resolve(root, unit.source);

    if (distributionTypes.has('claude-plugin')) {
      const manifestPath = resolve(unitRoot, '.claude-plugin', 'plugin.json');
      const displayPath = unitFile(unit, '.claude-plugin/plugin.json');
      const exists = await fileExists(manifestPath);
      if (!exists) {
        gaps.push(
          createGap({
            scope: GapScope.PROFILE,
            category: GapCategory.MANIFEST,
            severity: Severity.ERROR,
            code: 'CLAUDE_MANIFEST_MISSING',
            message: `发布单元 "${unit.id}" 缺少 .claude-plugin/plugin.json 插件清单`,
            file: displayPath,
          }),
        );
      } else {
        // Validate manifest structure
        try {
          const content = await readFile(manifestPath, 'utf8');
          const manifest = JSON.parse(content);
          const requiredFields = ['name', 'version', 'description'];
          const missingFields = requiredFields.filter((f) => !(f in manifest));
          if (missingFields.length > 0) {
            gaps.push(
              createGap({
                scope: GapScope.PROFILE,
                category: GapCategory.MANIFEST,
                severity: Severity.ERROR,
                code: 'CLAUDE_MANIFEST_INCOMPLETE',
                message: `Claude 插件清单缺少必填字段: ${missingFields.join(', ')}`,
                file: displayPath,
              }),
            );
          }
        } catch {
          gaps.push(
            createGap({
              scope: GapScope.PROFILE,
              category: GapCategory.MANIFEST,
              severity: Severity.ERROR,
              code: 'CLAUDE_MANIFEST_INVALID',
              message: '.claude-plugin/plugin.json 解析失败',
              file: displayPath,
            }),
          );
        }
      }
    }

    if (distributionTypes.has('codex-plugin')) {
      const manifestPath = resolve(unitRoot, '.codex-plugin', 'plugin.json');
      const displayPath = unitFile(unit, '.codex-plugin/plugin.json');
      const exists = await fileExists(manifestPath);
      if (!exists) {
        gaps.push(
          createGap({
            scope: GapScope.PROFILE,
            category: GapCategory.MANIFEST,
            severity: Severity.ERROR,
            code: 'CODEX_MANIFEST_MISSING',
            message: `发布单元 "${unit.id}" 缺少 .codex-plugin/plugin.json 插件清单`,
            file: displayPath,
          }),
        );
      } else {
        try {
          const content = await readFile(manifestPath, 'utf8');
          const manifest = JSON.parse(content);
          const requiredFields = ['name', 'version', 'description'];
          const missingFields = requiredFields.filter((f) => !(f in manifest));
          if (missingFields.length > 0) {
            gaps.push(
              createGap({
                scope: GapScope.PROFILE,
                category: GapCategory.MANIFEST,
                severity: Severity.ERROR,
                code: 'CODEX_MANIFEST_INCOMPLETE',
                message: `Codex 插件清单缺少必填字段: ${missingFields.join(', ')}`,
                file: displayPath,
              }),
            );
          }
        } catch {
          gaps.push(
            createGap({
              scope: GapScope.PROFILE,
              category: GapCategory.MANIFEST,
              severity: Severity.ERROR,
              code: 'CODEX_MANIFEST_INVALID',
              message: '.codex-plugin/plugin.json 解析失败',
              file: displayPath,
            }),
          );
        }
      }
    }

    if (distributionTypes.has('kimi-plugin')) {
      const manifestPath = resolve(unitRoot, '.kimi-plugin', 'plugin.json');
      const displayPath = unitFile(unit, '.kimi-plugin/plugin.json');
      const exists = await fileExists(manifestPath);
      if (!exists) {
        gaps.push(
          createGap({
            scope: GapScope.PROFILE,
            category: GapCategory.MANIFEST,
            severity: Severity.ERROR,
            code: 'KIMI_MANIFEST_MISSING',
            message: `发布单元 "${unit.id}" 缺少 .kimi-plugin/plugin.json 插件清单`,
            file: displayPath,
          }),
        );
      } else {
        try {
          const content = await readFile(manifestPath, 'utf8');
          const manifest = JSON.parse(content);
          const requiredFields = ['name', 'version', 'description'];
          const missingFields = requiredFields.filter((f) => !(f in manifest));
          if (missingFields.length > 0) {
            gaps.push(
              createGap({
                scope: GapScope.PROFILE,
                category: GapCategory.MANIFEST,
                severity: Severity.ERROR,
                code: 'KIMI_MANIFEST_INCOMPLETE',
                message: `Kimi 插件清单缺少必填字段: ${missingFields.join(', ')}`,
                file: displayPath,
              }),
            );
          }
        } catch {
          gaps.push(
            createGap({
              scope: GapScope.PROFILE,
              category: GapCategory.MANIFEST,
              severity: Severity.ERROR,
              code: 'KIMI_MANIFEST_INVALID',
              message: '.kimi-plugin/plugin.json 解析失败',
              file: displayPath,
            }),
          );
        }
      }
    }

    if (distributionTypes.has('codebuddy-plugin')) {
      const manifestPath = resolve(unitRoot, '.codebuddy-plugin', 'plugin.json');
      const displayPath = unitFile(unit, '.codebuddy-plugin/plugin.json');
      const exists = await fileExists(manifestPath);
      if (!exists) {
        gaps.push(
          createGap({
            scope: GapScope.PROFILE,
            category: GapCategory.MANIFEST,
            severity: Severity.ERROR,
            code: 'CODEBUDDY_MANIFEST_MISSING',
            message: `发布单元 "${unit.id}" 缺少 .codebuddy-plugin/plugin.json 插件清单`,
            file: displayPath,
          }),
        );
      } else {
        try {
          const content = await readFile(manifestPath, 'utf8');
          const manifest = JSON.parse(content);
          const requiredFields = ['name', 'version', 'description'];
          const missingFields = requiredFields.filter((f) => !(f in manifest));
          if (missingFields.length > 0) {
            gaps.push(
              createGap({
                scope: GapScope.PROFILE,
                category: GapCategory.MANIFEST,
                severity: Severity.ERROR,
                code: 'CODEBUDDY_MANIFEST_INCOMPLETE',
                message: `CodeBuddy 插件清单缺少必填字段: ${missingFields.join(', ')}`,
                file: displayPath,
              }),
            );
          }
        } catch {
          gaps.push(
            createGap({
              scope: GapScope.PROFILE,
              category: GapCategory.MANIFEST,
              severity: Severity.ERROR,
              code: 'CODEBUDDY_MANIFEST_INVALID',
              message: '.codebuddy-plugin/plugin.json 解析失败',
              file: displayPath,
            }),
          );
        }
      }
    }
  }

  return gaps;
}

/**
 * Check npm package metadata for npm distributions.
 *
 * @param {string} root - Project root.
 * @param {Object} config - The validated project config.
 * @returns {Promise<Object[]>} Array of gap entries.
 */
async function checkPackageMetadata(root, config) {
  const gaps = [];
  const units = config.releaseUnits ?? [];

  let hasNpm = false;
  for (const unit of units) {
    for (const dist of unit.distributions ?? []) {
      if (dist.type === 'npm') {
        hasNpm = true;
        break;
      }
    }
    if (hasNpm) break;
  }

  if (!hasNpm) return gaps;

  // Check that each npm-distributed unit has a package.json in its source
  for (const unit of units) {
    const hasNpmDist = (unit.distributions ?? []).some((d) => d.type === 'npm');
    if (!hasNpmDist) continue;

    const unitRoot = resolve(root, unit.source);
    const pkgPath = resolve(unitRoot, 'package.json');
    const exists = await fileExists(pkgPath);

    if (!exists) {
      gaps.push(
        createGap({
          scope: GapScope.PROFILE,
          category: GapCategory.METADATA,
          severity: Severity.ERROR,
          code: 'PACKAGE_JSON_MISSING',
          message: `发布单元 "${unit.id}" 的 source 目录缺少 package.json`,
          file: `${unit.source}/package.json`,
        }),
      );
      continue;
    }

    try {
      const content = await readFile(pkgPath, 'utf8');
      const pkg = JSON.parse(content);
      const requiredFields = ['name', 'version'];
      const missingFields = requiredFields.filter((f) => !(f in pkg));
      if (missingFields.length > 0) {
        gaps.push(
          createGap({
            scope: GapScope.PROFILE,
            category: GapCategory.METADATA,
            severity: Severity.ERROR,
            code: 'PACKAGE_JSON_INCOMPLETE',
            message: `发布单元 "${unit.id}" 的 package.json 缺少字段: ${missingFields.join(', ')}`,
            file: `${unit.source}/package.json`,
          }),
        );
      }
    } catch {
      gaps.push(
        createGap({
          scope: GapScope.PROFILE,
          category: GapCategory.METADATA,
          severity: Severity.ERROR,
          code: 'PACKAGE_JSON_INVALID',
          message: `发布单元 "${unit.id}" 的 package.json 解析失败`,
          file: `${unit.source}/package.json`,
        }),
      );
    }
  }

  return gaps;
}

/**
 * Check remote prerequisites (git remote, npm version conflicts).
 * Skipped entirely in offline mode.
 *
 * @param {string} root - Project root.
 * @param {Object} config - The validated project config.
 * @param {boolean} offline - Whether to skip remote checks.
 * @returns {Promise<Object[]>} Array of gap entries.
 */
async function checkRemotePrerequisites(root, config, offline) {
  if (offline) return [];

  const gaps = [];
  const units = config.releaseUnits ?? [];

  // Check git remote
  try {
    const { stdout } = await execFile('git', ['remote', 'get-url', 'origin'], {
      cwd: root,
      shell: false,
      encoding: 'utf8',
      timeout: 10_000,
    });
    if (!stdout.trim()) {
      gaps.push(
        createGap({
          scope: GapScope.COMMON,
          category: GapCategory.REMOTE,
          severity: Severity.WARNING,
          code: 'GIT_REMOTE_EMPTY',
          message: 'Git remote "origin" URL 为空',
        }),
      );
    }
  } catch {
    gaps.push(
      createGap({
        scope: GapScope.COMMON,
        category: GapCategory.REMOTE,
        severity: Severity.WARNING,
        code: 'GIT_REMOTE_MISSING',
        message: '未找到 Git remote "origin"',
      }),
    );
  }

  // Check npm registry for existing versions
  for (const unit of units) {
    const npmDist = (unit.distributions ?? []).find((d) => d.type === 'npm');
    if (!npmDist?.package) continue;

    const pkgPath = resolve(root, unit.source, 'package.json');
    let version;
    try {
      const content = await readFile(pkgPath, 'utf8');
      const pkg = JSON.parse(content);
      version = pkg.version;
    } catch {
      continue; // Already reported in checkPackageMetadata
    }

    if (!version) continue;

    try {
      await execFile(
        'npm',
        ['view', `${npmDist.package}@${version}`, 'version'],
        { cwd: root, shell: false, encoding: 'utf8', timeout: 15_000 },
      );
      // If we get here, the version already exists on npm
      gaps.push(
        createGap({
          scope: GapScope.PROFILE,
          category: GapCategory.REMOTE,
          severity: Severity.ERROR,
          code: 'NPM_VERSION_CONFLICT',
          message: `npm 包 ${npmDist.package}@${version} 已存在于 registry`,
        }),
      );
    } catch (error) {
      // Only an explicit E404/ETARGET from the registry proves the version is
      // absent -- good, no gap. All other failures (network, auth, timeout,
      // missing npm CLI) are a failed check and must be reported instead of
      // being silently treated as "version not published".
      if (!isVersionAbsentError(error)) {
        gaps.push(
          createGap({
            scope: GapScope.PROFILE,
            category: GapCategory.REMOTE,
            severity: Severity.WARNING,
            code: 'NPM_VERSION_CHECK_FAILED',
            message: `npm 包 ${npmDist.package}@${version} 的 registry 版本检查失败（${describeNpmError(error)}），无法确认该版本是否已发布，已跳过版本冲突检查`,
          }),
        );
      }
    }
  }

  return gaps;
}

/**
 * Parse a semver-ish version string into comparable components.
 *
 * Accepts `major.minor.patch` with an optional `-prerelease` suffix (which
 * sorts strictly below the same release triple). Returns null for anything
 * that is not a version-shaped tag (candidate names like `0.1.27-candidate.2`
 * parse fine; non-version tags are skipped).
 *
 * @param {string} version
 * @returns {{ major: number, minor: number, patch: number, prerelease: string|null } | null}
 */
export function parseSemverVersion(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(version);
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ?? null,
  };
}

/**
 * Compare two parsed semver values. Returns a negative/zero/positive number.
 *
 * @param {{ major: number, minor: number, patch: number, prerelease: string|null }} a
 * @param {{ major: number, minor: number, patch: number, prerelease: string|null }} b
 * @returns {number}
 */
export function compareSemverVersions(a, b) {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  if (a.patch !== b.patch) return a.patch - b.patch;
  if (a.prerelease && !b.prerelease) return -1;
  if (!a.prerelease && b.prerelease) return 1;
  return 0;
}

/**
 * Describe a version-sequence gap between an immediate predecessor and the
 * target version, or null when the step is contiguous.
 *
 * A gap means some version between the two was never released (e.g. the
 * historical 0.1.1 -> 0.1.3 jump with no v0.1.2 tag). Pre-release steps
 * never count as gaps by themselves.
 *
 * @param {{ major: number, minor: number, patch: number, prerelease: string|null }} prev
 * @param {{ major: number, minor: number, patch: number, prerelease: string|null }} target
 * @returns {string|null}
 */
export function describeVersionSequenceGap(prev, target) {
  if (prev.major !== target.major) {
    return prev.major + 1 < target.major
      ? `major ${prev.major}.x.x -> ${target.major}.x.x`
      : null;
  }
  if (prev.minor !== target.minor) {
    return prev.minor + 1 < target.minor
      ? `minor ${prev.major}.${prev.minor}.x -> ${target.major}.${target.minor}.x`
      : null;
  }
  if (prev.patch !== target.patch) {
    return prev.patch + 1 < target.patch
      ? `patch ${prev.major}.${prev.minor}.${prev.patch} -> ${target.major}.${target.minor}.${target.patch}`
      : null;
  }
  return null;
}

/**
 * Build a regex that extracts the version from a tag name following the
 * unit's tagTemplate (`{version}` placeholder, regex-special characters
 * escaped).
 *
 * @param {string} tagTemplate
 * @returns {RegExp}
 */
export function buildTagVersionRegex(tagTemplate) {
  const escaped = tagTemplate
    .split('{version}')
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('(.+)');
  return new RegExp(`^${escaped}$`);
}

/**
 * Check the public repository's release tag sequence for version jumps
 * (0.5.1 chain hardening): when the immediate predecessor release is more
 * than one version step below the current target version, register a
 * warning-level gap `VERSION_SEQUENCE_GAP` (e.g. 0.1.1 -> 0.1.3 with no
 * v0.1.2 tag). This never blocks: it records the observation for the human
 * release planner.
 *
 * @param {string} root - Project root.
 * @param {Object} config - The loaded project config.
 * @returns {Promise<Object[]>} Array of warning gap entries.
 */
async function checkReleaseTagSequence(root, config) {
  const gaps = [];
  for (const unit of config.releaseUnits ?? []) {
    const tagTemplate = unit.version?.tagTemplate;
    if (!tagTemplate || !unit.publicRepo) continue;

    const versionRegex = buildTagVersionRegex(tagTemplate);
    const tagPattern = tagTemplate.replace('{version}', '*');

    let stdout;
    try {
      ({ stdout } = await execFile(
        'git',
        ['ls-remote', `https://github.com/${unit.publicRepo}.git`, `refs/tags/${tagPattern}`],
        { cwd: root, shell: false, encoding: 'utf8', timeout: 15_000 },
      ));
    } catch {
      // Tag enumeration failure (network/auth/repo absent) is not a version
      // gap and must not block; the remote-prerequisites npm check already
      // reports unreachable registries where relevant.
      continue;
    }

    let targetVersion;
    try {
      const pkg = JSON.parse(await readFile(resolve(root, unit.source, 'package.json'), 'utf8'));
      targetVersion = pkg.version;
    } catch {
      continue; // package metadata issues are reported elsewhere
    }
    const targetParsed = parseSemverVersion(targetVersion);
    if (!targetParsed) continue;

    let previousParsed = null;
    let previousTag = null;
    for (const line of stdout.trim().split('\n')) {
      if (!line) continue;
      const tagName = line.split('\t')[1]?.replace(/^refs\/tags\//, '');
      if (!tagName) continue;
      const versionMatch = versionRegex.exec(tagName);
      if (!versionMatch) continue;
      const parsed = parseSemverVersion(versionMatch[1]);
      if (!parsed) continue;
      // Prereleases never qualify as the "previous release" predecessor.
      if (parsed.prerelease) continue;
      if (compareSemverVersions(parsed, targetParsed) >= 0) continue;
      if (previousParsed === null || compareSemverVersions(parsed, previousParsed) > 0) {
        previousParsed = parsed;
        previousTag = tagName;
      }
    }

    if (!previousParsed) continue;
    const gap = describeVersionSequenceGap(previousParsed, targetParsed);
    if (gap) {
      gaps.push(createGap({
        scope: GapScope.PROJECT,
        category: GapCategory.REMOTE,
        severity: Severity.WARNING,
        code: 'VERSION_SEQUENCE_GAP',
        message: `发布单元 "${unit.id}" 的版本序列存在跳号（${gap}，上一发布标签 ${previousTag}，目标版本 ${targetVersion}）：请确认中间版本未发布是否是有意为之；发布链仍会以链式历史推进，但跳过的版本不会补造标签`,
        file: '.release-skill/project.yaml',
      }));
    }
  }
  return gaps;
}

/**
 * Perform a basic README structural check.
 *
 * @param {string} root - Project root.
 * @param {Object} config - The validated project config.
 * @returns {Promise<Object[]>} Array of gap entries.
 */
async function checkReadmeStructure(root, config) {
  const gaps = [];
  const units = config.releaseUnits ?? [];

  for (const unit of units) {
    const readmePath = resolve(root, unit.source, 'README.md');
    const displayPath = unitFile(unit, 'README.md');
    const exists = await fileExists(readmePath);
    if (!exists) continue; // Already reported by checkCommonDocs

    try {
      const content = await readFile(readmePath, 'utf8');

      // Basic structural checks
      const hasHeading = /^#\s+/m.test(content);
      if (!hasHeading) {
        gaps.push(
          createGap({
            scope: GapScope.COMMON,
            category: GapCategory.README,
            severity: Severity.WARNING,
            code: 'README_NO_HEADING',
            message: `发布单元 "${unit.id}" 的 README.md 缺少标题（一级标题）`,
            file: displayPath,
          }),
        );
      }

      const hasInstallSection = /install|安装|setup/i.test(content);
      if (!hasInstallSection) {
        gaps.push(
          createGap({
            scope: GapScope.COMMON,
            category: GapCategory.README,
            severity: Severity.WARNING,
            code: 'README_NO_INSTALL',
            message: `发布单元 "${unit.id}" 的 README.md 缺少安装说明`,
            file: displayPath,
          }),
        );
      }

      // Check for very short README (likely incomplete)
      if (content.trim().length < 100) {
        gaps.push(
          createGap({
            scope: GapScope.COMMON,
            category: GapCategory.README,
            severity: Severity.WARNING,
            code: 'README_TOO_SHORT',
            message: `发布单元 "${unit.id}" 的 README.md 内容过短（少于 100 字符），可能不完整`,
            file: displayPath,
          }),
        );
      }
    } catch {
      // File exists but can't be read - unusual, report it
      gaps.push(
        createGap({
          scope: GapScope.COMMON,
          category: GapCategory.README,
          severity: Severity.ERROR,
          code: 'README_UNREADABLE',
          message: `发布单元 "${unit.id}" 的 README.md 存在但无法读取`,
          file: displayPath,
        }),
      );
    }
  }

  return gaps;
}

// ---------------------------------------------------------------------------
// Chinese summary generation
// ---------------------------------------------------------------------------

/**
 * Generate a Chinese summary from the assessment report data.
 *
 * @param {Object} params
 * @param {Object|null} params.config - The loaded config or null.
 * @param {Object} params.topology - Topology information.
 * @param {Object[]} params.gaps - Array of gap entries.
 * @param {boolean} params.offline - Whether remote checks were skipped.
 * @returns {string} Chinese summary text.
 */
function generateSummary({ config, topology, gaps, offline }) {
  const lines = [];

  // Project identity
  if (config) {
    lines.push(`项目: ${config.project?.name ?? '(未命名)'}`);
  } else {
    lines.push('项目: 配置加载失败');
  }

  // Topology
  const topologyLabels = {
    'single-npm': '单 npm 包',
    'single-plugin': '单插件',
    'hybrid-plugin-npm': '混合插件+npm 包',
    'split-public-repos': '多公开仓库',
    'single-unit': '单发布单元',
    'no-release-units': '无发布单元',
    'unknown': '未知拓扑',
  };
  lines.push(`拓扑: ${topologyLabels[topology.type] ?? topology.type}`);
  lines.push(`发布单元: ${topology.releaseUnits.length} 个`);
  if (topology.distributions.length > 0) {
    lines.push(`分发类型: ${topology.distributions.join(', ')}`);
  }

  // Gap summary
  const errors = gaps.filter((g) => g.severity === Severity.ERROR);
  const warnings = gaps.filter((g) => g.severity === Severity.WARNING);

  if (gaps.length === 0) {
    lines.push('诊断结果: 未发现缺口');
  } else {
    lines.push(`诊断结果: ${errors.length} 个错误, ${warnings.length} 个警告`);

    // Group by scope
    const commonGaps = gaps.filter((g) => g.scope === GapScope.COMMON);
    const profileGaps = gaps.filter((g) => g.scope === GapScope.PROFILE);
    const projectGaps = gaps.filter((g) => g.scope === GapScope.PROJECT);

    if (commonGaps.length > 0) {
      lines.push(`\n通用缺口 (${commonGaps.length}):`);
      for (const gap of commonGaps) {
        const prefix = gap.severity === Severity.ERROR ? '[错误]' : '[警告]';
        lines.push(`  ${prefix} ${gap.message}`);
      }
    }

    if (profileGaps.length > 0) {
      lines.push(`\nProfile 缺口 (${profileGaps.length}):`);
      for (const gap of profileGaps) {
        const prefix = gap.severity === Severity.ERROR ? '[错误]' : '[警告]';
        lines.push(`  ${prefix} ${gap.message}`);
      }
    }

    if (projectGaps.length > 0) {
      lines.push(`\n项目个性化缺口 (${projectGaps.length}):`);
      for (const gap of projectGaps) {
        const prefix = gap.severity === Severity.ERROR ? '[错误]' : '[警告]';
        lines.push(`  ${prefix} ${gap.message}`);
      }
    }
  }

  if (offline) {
    lines.push('\n注意: 已跳过远端前置条件检查（--offline 模式）');
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Perform a read-only assessment of a project's release readiness.
 *
 * @param {Object} options
 * @param {string} options.root - Absolute path to the project root.
 * @param {boolean} [options.offline=true] - Skip remote checks when true.
 * @param {string} [options.output] - Optional file path to write the JSON report.
 *   If not provided, no files are written.
 *
 * @returns {Promise<Object>} The AssessmentReport:
 *   - status: 'ASSESSED' | 'NEEDS_INPUT' | 'BLOCKED'
 *   - configDigest: string | null
 *   - topology: { type, releaseUnits, distributions }
 *   - gaps: Array<{ scope, category, severity, code, message, file? }>
 *   - summary: string (Chinese)
 *   - assessedAt: string (ISO-8601)
 *   - offline: boolean
 */
export async function assessProject(options) {
  const { root, offline = true, output } = options;

  if (!root || typeof root !== 'string') {
    throw new ReleaseError(CONFIG_INVALID, 'root must be a non-empty string');
  }

  const allGaps = [];

  // --- 1. Config validation ---
  const configResult = await checkConfig(root);
  allGaps.push(...configResult.gaps);

  // If config is completely broken, early return with NEEDS_INPUT
  if (!configResult.config) {
    const report = {
      status: 'NEEDS_INPUT',
      configDigest: null,
      topology: { type: 'unknown', releaseUnits: [], distributions: [] },
      gaps: allGaps,
      summary: generateSummary({
        config: null,
        topology: { type: 'unknown', releaseUnits: [], distributions: [] },
        gaps: allGaps,
        offline,
      }),
      assessedAt: new Date().toISOString(),
      offline,
    };

    if (output) {
      await writeReport(output, report);
    }

    return report;
  }

  const config = configResult.config;

  // --- 2. Topology identification ---
  const topology = identifyTopology(config);

  // --- 3. Expected public-surface adoption ---
  for (const warning of collectExpectedPublicSurfaceAdoptionWarnings(config)) {
    allGaps.push(createGap({
      scope: GapScope.PROJECT,
      category: GapCategory.POLICY,
      severity: Severity.WARNING,
      code: warning.code,
      message: warning.message,
      file: '.release-skill/project.yaml',
    }));
  }

  // --- 4. Common docs check ---
  const docGaps = await checkCommonDocs(root, config);
  allGaps.push(...docGaps);

  // --- 5. Plugin manifest check ---
  const manifestGaps = await checkPluginManifests(root, config);
  allGaps.push(...manifestGaps);

  // --- 6. Package metadata check ---
  const metadataGaps = await checkPackageMetadata(root, config);
  allGaps.push(...metadataGaps);

  // --- 7. Remote prerequisites ---
  const remoteGaps = await checkRemotePrerequisites(root, config, offline);
  allGaps.push(...remoteGaps);

  // --- 7b. Release tag sequence (online only; warning, never blocking) ---
  if (!offline) {
    const tagSequenceGaps = await checkReleaseTagSequence(root, config);
    allGaps.push(...tagSequenceGaps);
  }

  // --- 8. README structure check ---
  const readmeGaps = await checkReadmeStructure(root, config);
  allGaps.push(...readmeGaps);

  // --- Determine status ---
  const hasErrors = allGaps.some((g) => g.severity === Severity.ERROR);
  const status = hasErrors ? 'NEEDS_INPUT' : 'ASSESSED';

  // --- Build report ---
  const report = {
    status,
    configDigest: configResult.configDigest,
    topology,
    gaps: allGaps,
    summary: generateSummary({ config, topology, gaps: allGaps, offline }),
    assessedAt: new Date().toISOString(),
    offline,
  };

  // --- Write output if requested ---
  if (output) {
    await writeReport(output, report);
  }

  return report;
}

/**
 * Write the assessment report to a file.
 *
 * @param {string} outputPath - Absolute or relative path to write the report.
 * @param {Object} report - The AssessmentReport object.
 */
async function writeReport(outputPath, report) {
  const dir = dirname(outputPath);
  await mkdir(dir, { recursive: true });
  await writeFile(outputPath, JSON.stringify(report, null, 2), 'utf8');
}
