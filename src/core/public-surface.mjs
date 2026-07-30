/**
 * Project-declared expected public surface.
 *
 * Each configured scan root classifies every observed regular file as exactly
 * one of include or exclude. Included workspace-relative sources must match
 * unit.publicFiles by the exact `(sourceScope, from)` identity.
 *
 * @module core/public-surface
 */

import { lstat, readdir, realpath } from 'node:fs/promises';
import {
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'node:path';

import { CONFIG_INVALID, GATE_FAILED, ReleaseError } from './errors.mjs';
import { canonicalPublicPath } from '../snapshot/public-path.mjs';

const ROOT_CONTROL_DIRECTORIES = Object.freeze(['.git', '.release-skill']);
const UNSUPPORTED_GLOB_CHARACTERS = /[!()[\]{}]/u;
export const PUBLIC_SURFACE_CONFIG_MISSING = 'PUBLIC_SURFACE_CONFIG_MISSING';

function compareStrings(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Return actionable, non-blocking adoption warnings for release units that
 * have not enabled the expected public-surface gate.
 *
 * This helper never invents project policy or writes configuration. It gives
 * assess and prepare one stable machine code and message while legacy projects
 * remain releasable during the adoption window.
 *
 * @param {object} config
 * @returns {ReadonlyArray<object>}
 */
export function collectExpectedPublicSurfaceAdoptionWarnings(config) {
  return Object.freeze(
    (config?.releaseUnits ?? [])
      .filter((unit) => !unit?.expectedPublicSurface)
      .map((unit) => Object.freeze({
        code: PUBLIC_SURFACE_CONFIG_MISSING,
        unitId: unit.id,
        message:
          `发布单元 "${unit.id}" 未配置 expectedPublicSurface；新增或漏配文件不会被分类门禁发现。` +
          '请审阅项目发布边界后，在 .release-skill/project.yaml 中配置 expectedPublicSurface.scanRoots。',
      })),
  );
}

function toPosixPath(path) {
  return path.split(sep).join('/');
}

function isContainedOrEqual(root, candidate) {
  const rel = relative(root, candidate);
  return rel === '' || (
    rel !== '..' &&
    !rel.startsWith(`..${sep}`) &&
    !isAbsolute(rel)
  );
}

function isWorkspaceControlPath(workspaceRoot, candidate) {
  return ROOT_CONTROL_DIRECTORIES.some((name) => (
    isContainedOrEqual(join(workspaceRoot, name), candidate)
  ));
}

function failConfig(message, details) {
  throw new ReleaseError(CONFIG_INVALID, message, details);
}

/**
 * Validate the intentionally small public-surface glob language.
 *
 * Supported wildcards: `*`, `?`, and `**` as a complete path segment.
 *
 * @param {string} glob
 * @returns {string}
 */
export function validatePublicSurfaceGlob(glob) {
  if (typeof glob !== 'string' || glob.length === 0) {
    failConfig('public surface glob must be a non-empty string', {
      reason: 'PUBLIC_SURFACE_GLOB_INVALID',
      glob,
    });
  }
  if (
    glob.startsWith('/') ||
    glob.startsWith('./') ||
    glob.includes('\\') ||
    glob.includes('\0') ||
    glob.includes(':') ||
    glob.endsWith('/') ||
    UNSUPPORTED_GLOB_CHARACTERS.test(glob)
  ) {
    failConfig(`unsupported or unsafe public surface glob "${glob}"`, {
      reason: 'PUBLIC_SURFACE_GLOB_INVALID',
      glob,
    });
  }

  const segments = glob.split('/');
  if (segments.some((segment) => (
    segment === '' ||
    segment === '.' ||
    segment === '..' ||
    (segment.includes('**') && segment !== '**')
  ))) {
    failConfig(`unsupported or unsafe public surface glob "${glob}"`, {
      reason: 'PUBLIC_SURFACE_GLOB_INVALID',
      glob,
    });
  }
  return glob;
}

function compileGlob(glob) {
  validatePublicSurfaceGlob(glob);
  let source = '';
  for (let index = 0; index < glob.length;) {
    if (glob.startsWith('**/', index)) {
      // Zero or more complete leading/intermediate path segments. The zero
      // case is what makes **/*.mjs match a root-level main.mjs.
      source += '(?:.*/)?';
      index += 3;
      continue;
    }
    if (glob.startsWith('**', index)) {
      // `**` is validated as a complete segment. At the end (e.g. dir/**)
      // it matches every descendant depth.
      source += '.*';
      index += 2;
      continue;
    }

    const character = glob[index];
    if (character === '*') {
      source += '[^/]*';
    } else if (character === '?') {
      source += '[^/]';
    } else {
      source += character.replace(/[.+^$|\\]/gu, '\\$&');
    }
    index += 1;
  }
  return new RegExp(`^${source}$`, 'u');
}

function compilePatterns(patterns) {
  return (patterns ?? []).map((pattern) => ({
    pattern,
    regexp: compileGlob(pattern),
  }));
}

function matchingPatterns(matchers, path) {
  return matchers
    .filter(({ regexp }) => regexp.test(path))
    .map(({ pattern }) => pattern)
    .sort(compareStrings);
}

async function assertSafeDirectoryPath({
  workspaceRoot,
  containmentRoot,
  candidate,
  unitId,
  configuredRoot,
}) {
  if (!isContainedOrEqual(containmentRoot, candidate)) {
    failConfig(`public surface scan root escapes its ${containmentRoot === workspaceRoot ? 'workspace' : 'unit'} scope`, {
      reason: 'PUBLIC_SURFACE_SCAN_ROOT_UNSAFE',
      unitId,
      root: configuredRoot,
    });
  }

  const rel = relative(workspaceRoot, candidate);
  if (!isContainedOrEqual(workspaceRoot, candidate)) {
    failConfig('public surface scan root escapes the workspace', {
      reason: 'PUBLIC_SURFACE_SCAN_ROOT_UNSAFE',
      unitId,
      root: configuredRoot,
    });
  }

  let cursor = workspaceRoot;
  for (const segment of rel.split(sep).filter(Boolean)) {
    cursor = join(cursor, segment);
    let stat;
    try {
      stat = await lstat(cursor);
    } catch (error) {
      failConfig(`cannot inspect public surface scan root "${configuredRoot}"`, {
        reason: 'PUBLIC_SURFACE_SCAN_ROOT_UNSAFE',
        unitId,
        root: configuredRoot,
        cause: error.code ?? 'UNKNOWN',
      });
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      failConfig(`public surface scan root or ancestor is not a physical directory: "${configuredRoot}"`, {
        reason: 'PUBLIC_SURFACE_SCAN_ROOT_UNSAFE',
        unitId,
        root: configuredRoot,
      });
    }
  }

  let physicalCandidate;
  let physicalContainmentRoot;
  try {
    [physicalCandidate, physicalContainmentRoot] = await Promise.all([
      realpath(candidate),
      realpath(containmentRoot),
    ]);
  } catch (error) {
    failConfig(`cannot resolve public surface scan root "${configuredRoot}"`, {
      reason: 'PUBLIC_SURFACE_SCAN_ROOT_UNSAFE',
      unitId,
      root: configuredRoot,
      cause: error.code ?? 'UNKNOWN',
    });
  }
  if (
    !isContainedOrEqual(workspaceRoot, physicalCandidate) ||
    !isContainedOrEqual(physicalContainmentRoot, physicalCandidate)
  ) {
    failConfig(`public surface scan root escapes physical containment: "${configuredRoot}"`, {
      reason: 'PUBLIC_SURFACE_SCAN_ROOT_UNSAFE',
      unitId,
      root: configuredRoot,
    });
  }
  return physicalCandidate;
}

async function resolveScanRoots({ root, unit }) {
  let workspaceRoot;
  try {
    workspaceRoot = await realpath(resolve(root));
  } catch (error) {
    failConfig('cannot resolve public surface workspace root', {
      reason: 'PUBLIC_SURFACE_SCAN_ROOT_UNSAFE',
      unitId: unit.id,
      cause: error.code ?? 'UNKNOWN',
    });
  }

  const unitSource = canonicalPublicPath(unit.source, { allowDot: true }).path;
  const unitRoot = resolve(workspaceRoot, unitSource);
  await assertSafeDirectoryPath({
    workspaceRoot,
    containmentRoot: workspaceRoot,
    candidate: unitRoot,
    unitId: unit.id,
    configuredRoot: unit.source,
  });

  const resolvedRoots = [];
  for (const [index, rule] of unit.expectedPublicSurface.scanRoots.entries()) {
    const sourceScope = rule.sourceScope ?? 'unit';
    const configuredRoot = rule.root ?? '.';
    const rootPath = canonicalPublicPath(configuredRoot, { allowDot: true }).path;
    const scopeRoot = sourceScope === 'workspace' ? workspaceRoot : unitRoot;
    const candidate = resolve(scopeRoot, rootPath);
    if (isWorkspaceControlPath(workspaceRoot, candidate)) {
      failConfig(`public surface scan root cannot target workspace control paths: "${configuredRoot}"`, {
        reason: 'PUBLIC_SURFACE_SCAN_ROOT_CONTROL_PATH',
        unitId: unit.id,
        root: configuredRoot,
      });
    }
    const physicalPath = await assertSafeDirectoryPath({
      workspaceRoot,
      containmentRoot: scopeRoot,
      candidate,
      unitId: unit.id,
      configuredRoot,
    });
    resolvedRoots.push({
      index,
      sourceScope,
      configuredRoot,
      physicalPath,
      includeMatchers: compilePatterns(rule.include),
      excludeMatchers: compilePatterns(rule.exclude),
    });
  }

  for (let leftIndex = 0; leftIndex < resolvedRoots.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < resolvedRoots.length; rightIndex += 1) {
      const left = resolvedRoots[leftIndex];
      const right = resolvedRoots[rightIndex];
      if (
        isContainedOrEqual(left.physicalPath, right.physicalPath) ||
        isContainedOrEqual(right.physicalPath, left.physicalPath)
      ) {
        failConfig(`public surface scan roots overlap for unit "${unit.id}"`, {
          reason: 'PUBLIC_SURFACE_SCAN_ROOT_OVERLAP',
          unitId: unit.id,
          scanRoots: [
            { index: left.index, sourceScope: left.sourceScope, root: left.configuredRoot },
            { index: right.index, sourceScope: right.sourceScope, root: right.configuredRoot },
          ],
        });
      }
    }
  }

  return { workspaceRoot, resolvedRoots };
}

function unsupportedEntryError({ unit, rule, workspaceRelative, relativePath, entry, includePatterns, excludePatterns }) {
  return new ReleaseError(
    GATE_FAILED,
    `public surface contains an unsupported non-regular entry "${workspaceRelative}"`,
    {
      reason: 'PUBLIC_SURFACE_UNSUPPORTED_ENTRY',
      unitId: unit.id,
      sourceScope: rule.sourceScope,
      from: workspaceRelative,
      scanRoot: rule.configuredRoot,
      relativePath,
      entryType: entry.isSymbolicLink() ? 'symlink' : 'special',
      includePatterns,
      excludePatterns,
    },
  );
}

async function scanRoot({ workspaceRoot, unit, rule }) {
  const files = [];
  let skippedNonRegularCount = 0;
  const skippedControlPaths = new Set(
    ROOT_CONTROL_DIRECTORIES.map((name) => join(workspaceRoot, name)),
  );

  async function walk(directory, relativeDirectory) {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      failConfig(`cannot read public surface scan root for unit "${unit.id}"`, {
        reason: 'PUBLIC_SURFACE_SCAN_ROOT_UNSAFE',
        unitId: unit.id,
        root: rule.configuredRoot,
        cause: error.code ?? 'UNKNOWN',
      });
    }
    entries.sort((left, right) => compareStrings(left.name, right.name));

    for (const entry of entries) {
      const absolutePath = join(directory, entry.name);
      // Check the exact workspace-root control paths before interpreting entry
      // type because `.git` is commonly a regular file in linked worktrees.
      // Nested paths with the same name remain project content.
      if (skippedControlPaths.has(absolutePath)) continue;

      if (entry.isDirectory()) {
        const childRelative = relativeDirectory
          ? `${relativeDirectory}/${entry.name}`
          : entry.name;
        await walk(absolutePath, childRelative);
        continue;
      }

      const relativePath = relativeDirectory
        ? `${relativeDirectory}/${entry.name}`
        : entry.name;
      const includePatterns = matchingPatterns(rule.includeMatchers, relativePath);
      const excludePatterns = matchingPatterns(rule.excludeMatchers, relativePath);
      const workspaceRelative = canonicalPublicPath(
        toPosixPath(relative(workspaceRoot, absolutePath)),
      ).path;

      if (!entry.isFile()) {
        if (includePatterns.length === 0 && excludePatterns.length > 0) {
          skippedNonRegularCount += 1;
          continue;
        }
        throw unsupportedEntryError({
          unit,
          rule,
          workspaceRelative,
          relativePath,
          entry,
          includePatterns,
          excludePatterns,
        });
      }

      files.push({
        identity: `${rule.sourceScope}\0${workspaceRelative}`,
        sourceScope: rule.sourceScope,
        from: workspaceRelative,
        scanRoot: rule.configuredRoot,
        relativePath,
        includePatterns,
        excludePatterns,
      });
    }
  }

  await walk(rule.physicalPath, '');
  return { files, skippedNonRegularCount };
}

function publicSourceIdentity(sourceScope, from) {
  return `${sourceScope}\0${from}`;
}

function sortBySource(left, right) {
  return compareStrings(left.sourceScope, right.sourceScope) ||
    compareStrings(left.from, right.from);
}

/**
 * Inspect one release unit's expected public surface without changing files.
 *
 * @returns {Promise<object>}
 */
export async function inspectExpectedPublicSurface({ root, unit } = {}) {
  if (!unit?.expectedPublicSurface) {
    return Object.freeze({ enabled: false, passed: true, unitId: unit?.id ?? null });
  }

  const { workspaceRoot, resolvedRoots } = await resolveScanRoots({ root, unit });
  const observedFiles = [];
  let skippedNonRegularCount = 0;
  for (const rule of resolvedRoots) {
    const observed = await scanRoot({ workspaceRoot, unit, rule });
    observedFiles.push(...observed.files);
    skippedNonRegularCount += observed.skippedNonRegularCount;
  }

  const includedByIdentity = new Map();
  const unclassifiedFiles = [];
  const ambiguousFiles = [];
  let excludedFileCount = 0;

  for (const file of observedFiles) {
    const included = file.includePatterns.length > 0;
    const excluded = file.excludePatterns.length > 0;
    if (included) includedByIdentity.set(file.identity, file);
    if (!included && !excluded) {
      unclassifiedFiles.push(file);
    } else if (included && excluded) {
      ambiguousFiles.push(file);
    } else if (excluded) {
      excludedFileCount += 1;
    }
  }

  const mappingsByIdentity = new Map();
  for (const mapping of unit.publicFiles ?? []) {
    const sourceScope = mapping.sourceScope ?? 'unit';
    const from = canonicalPublicPath(mapping.from).path;
    const identity = publicSourceIdentity(sourceScope, from);
    const current = mappingsByIdentity.get(identity) ?? {
      sourceScope,
      from,
      targets: [],
    };
    current.targets.push(canonicalPublicPath(mapping.to).path);
    current.targets.sort(compareStrings);
    mappingsByIdentity.set(identity, current);
  }

  const missingMappings = [...includedByIdentity.entries()]
    .filter(([identity]) => !mappingsByIdentity.has(identity))
    .map(([, file]) => ({
      sourceScope: file.sourceScope,
      from: file.from,
    }))
    .sort(sortBySource);
  const unexpectedMappings = [...mappingsByIdentity.entries()]
    .filter(([identity]) => !includedByIdentity.has(identity))
    .map(([, mapping]) => mapping)
    .sort(sortBySource);

  unclassifiedFiles.sort(sortBySource);
  ambiguousFiles.sort(sortBySource);

  const passed = (
    missingMappings.length === 0 &&
    unexpectedMappings.length === 0 &&
    unclassifiedFiles.length === 0 &&
    ambiguousFiles.length === 0
  );
  return {
    enabled: true,
    passed,
    unitId: unit.id,
    summary: {
      scannedFileCount: observedFiles.length,
      includedFileCount: includedByIdentity.size,
      excludedFileCount,
      mappedSourceCount: mappingsByIdentity.size,
      skippedNonRegularCount,
    },
    missingMappings,
    unexpectedMappings,
    unclassifiedFiles,
    ambiguousFiles,
  };
}

/**
 * Inspect and fail closed when any classification or mapping difference exists.
 */
export async function assertExpectedPublicSurface(options) {
  const result = await inspectExpectedPublicSurface(options);
  if (!result.enabled || result.passed) return result;
  throw new ReleaseError(
    GATE_FAILED,
    `expected public surface mismatch for unit "${result.unitId}"`,
    {
      reason: 'PUBLIC_SURFACE_MISMATCH',
      unitId: result.unitId,
      summary: result.summary,
      missingMappings: result.missingMappings,
      unexpectedMappings: result.unexpectedMappings,
      unclassifiedFiles: result.unclassifiedFiles,
      ambiguousFiles: result.ambiguousFiles,
    },
  );
}
