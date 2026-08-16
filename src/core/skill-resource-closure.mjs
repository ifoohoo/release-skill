/**
 * Built-in, read-only Skill resource closure verification.
 *
 * Only path tokens in Markdown code spans, fenced code blocks, and local link
 * targets are interpreted. Bare Skill resources resolve from the directory
 * containing SKILL.md. Explicit plugin-root tokens resolve from the parent of
 * the nearest `skills/` directory.
 */

import { lstat, readFile, readdir } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import { canonicalJson, digestDocument } from 'skill-family-contracts';
import { GATE_FAILED, ReleaseError } from './errors.mjs';
import { computeFrozenSnapshot } from '../snapshot/frozen.mjs';

export const CHECKER_VERSION = 'skill-resource-closure-v1';

const BARE_PREFIXES = ['references/', 'assets/', 'schemas/', 'examples/', 'scripts/'];
const EXPLICIT_PREFIXES = [
  '<plugin-root>/',
  '<plugin_dir>/',
  '$PLUGIN_ROOT/',
  '${PLUGIN_ROOT}/',
  '${CLAUDE_PLUGIN_ROOT}/',
  'PLUGIN_ROOT/',
];
const SOURCE_TREE_PATTERN = /(?:^|\/)packages\/[A-Za-z0-9._-]+(?:\/|$)/u;
const MACHINE_ABSOLUTE_PATTERN = /^(?:\/(?:Users|home|root|tmp|var|etc|opt)(?:\/|$)|[A-Za-z]:[\\/])/u;
const GLOB_PATTERN = /[*?\[]/u;
const SOURCE_ONLY_MARKER = /(?:\bsource-only\b|仅源码包)/iu;
const TRANSPORT_EXCLUSIONS = Object.freeze([
  '.git',
  'node_modules',
  '.in_use',
  '.codex-plugin/migrated-command-skills',
]);

export const CLASSIFICATION = Object.freeze({
  SKILL_LOCAL: 'skill_local',
  PLUGIN_ROOT: 'plugin_root',
  SOURCE_BACKJUMP: 'source_backjump',
  MACHINE_ABSOLUTE: 'machine_absolute',
  OUT_OF_BOUNDS: 'out_of_bounds',
});

export const FINDING_CODE = Object.freeze({
  SNAPSHOT_UNSAFE: 'SNAPSHOT_UNSAFE',
  RESOURCE_MISSING: 'RESOURCE_MISSING',
  RESOURCE_NOT_REGULAR_FILE: 'RESOURCE_NOT_REGULAR_FILE',
  SOURCE_BACKJUMP: 'SOURCE_BACKJUMP',
  MACHINE_ABSOLUTE_PATH: 'MACHINE_ABSOLUTE_PATH',
  OUT_OF_BOUNDS: 'OUT_OF_BOUNDS',
  SYMLINK_NOT_ALLOWED: 'SYMLINK_NOT_ALLOWED',
});

function toPosix(value) {
  return value.replaceAll('\\', '/');
}

function relativeStable(root, target) {
  const value = toPosix(relative(root, target));
  return value === '' ? '.' : value;
}

function isInside(parent, candidate) {
  const rel = relative(parent, candidate);
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
}

export async function discoverSkills(root, base = root) {
  const results = [];
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return results;
    throw error;
  }
  for (const entry of entries) {
    if (entry.name === '.git' || entry.name === 'node_modules') continue;
    const absolute = join(root, entry.name);
    const stableRelative = toPosix(relative(base, absolute));
    if (stableRelative === '.codex-plugin/migrated-command-skills') continue;
    if (entry.isDirectory()) {
      results.push(...await discoverSkills(absolute, base));
    } else if (entry.isFile() && entry.name === 'SKILL.md') {
      results.push(stableRelative);
    }
  }
  return results.sort();
}

export function resolvePluginRoot(skillRelativePath, scanRoot) {
  const parts = toPosix(skillRelativePath).split('/');
  const skillsIndex = parts.lastIndexOf('skills');
  if (skillsIndex < 0) return resolve(scanRoot);
  return resolve(scanRoot, ...parts.slice(0, skillsIndex));
}

export function resolveSkillRoot(skillRelativePath, scanRoot) {
  return resolve(scanRoot, dirname(skillRelativePath));
}

function trimCandidate(value) {
  return value
    .trim()
    .replace(/^["']/u, '')
    .replace(/["']$/u, '')
    .replace(/[.,;:]+$/u, '');
}

function isPathToken(value) {
  const token = trimCandidate(value);
  if (!token || GLOB_PATTERN.test(token)) return false;
  return BARE_PREFIXES.some((prefix) => token.startsWith(prefix))
    || EXPLICIT_PREFIXES.some((prefix) => token.startsWith(prefix))
    || SOURCE_TREE_PATTERN.test(token)
    || MACHINE_ABSOLUTE_PATTERN.test(token);
}

function scanSnippet(snippet, line, sourceOnly, results, seen) {
  const candidates = snippet.match(/(?:"[^"\n]+"|'[^'\n]+'|[^\s"'`()\[\],;]+)/gu) ?? [];
  for (const candidate of candidates) {
    const token = trimCandidate(candidate);
    if (!isPathToken(token)) continue;
    const key = `${line}:${token}`;
    if (seen.has(key)) continue;
    seen.add(key);
    results.push({ token, line, sourceOnly });
  }
}

export function extractPathTokens(content) {
  const results = [];
  const seen = new Set();
  const lines = content.split(/\r?\n/u);
  let inFence = false;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const lineNumber = index + 1;
    if (/^\s*```/u.test(line)) {
      inFence = !inFence;
      continue;
    }
    const sourceOnly = SOURCE_ONLY_MARKER.test(line);
    if (inFence) scanSnippet(line, lineNumber, sourceOnly, results, seen);

    for (const match of line.matchAll(/`([^`]+)`/gu)) {
      scanSnippet(match[1], lineNumber, sourceOnly, results, seen);
    }
    for (const match of line.matchAll(/\]\(([^)]+)\)/gu)) {
      const target = match[1].trim().split(/[?#]/u)[0];
      if (!/^(?:https?:|#)/iu.test(target)) {
        scanSnippet(target, lineNumber, sourceOnly, results, seen);
      }
    }
  }
  return results;
}

function stripExplicitPrefix(token) {
  for (const prefix of EXPLICIT_PREFIXES) {
    if (token.startsWith(prefix)) return token.slice(prefix.length);
  }
  return token;
}

export function classifyReference(token, skillRoot, pluginRoot, scanRoot) {
  if (MACHINE_ABSOLUTE_PATTERN.test(token)) {
    return {
      classification: CLASSIFICATION.MACHINE_ABSOLUTE,
      resolutionRoot: '(machine)',
      resolvedTarget: token,
      absoluteTarget: token,
    };
  }
  if (SOURCE_TREE_PATTERN.test(token)) {
    return {
      classification: CLASSIFICATION.SOURCE_BACKJUMP,
      resolutionRoot: '(source-tree)',
      resolvedTarget: token,
      absoluteTarget: resolve(scanRoot, token),
    };
  }

  const explicit = EXPLICIT_PREFIXES.some((prefix) => token.startsWith(prefix));
  const resolutionRootAbsolute = explicit ? pluginRoot : skillRoot;
  const relativeTarget = explicit ? stripExplicitPrefix(token) : token;
  const absoluteTarget = resolve(resolutionRootAbsolute, relativeTarget);
  const inBounds = isInside(resolutionRootAbsolute, absoluteTarget);
  return {
    classification: inBounds
      ? (explicit ? CLASSIFICATION.PLUGIN_ROOT : CLASSIFICATION.SKILL_LOCAL)
      : CLASSIFICATION.OUT_OF_BOUNDS,
    resolutionRoot: relativeStable(scanRoot, resolutionRootAbsolute),
    resolvedTarget: relativeStable(scanRoot, absoluteTarget),
    absoluteTarget,
  };
}

async function inspectRegularFile(root, target) {
  if (!isInside(root, target)) return { code: FINDING_CODE.OUT_OF_BOUNDS };
  const parts = relative(root, target).split(sep).filter(Boolean);
  let current = root;
  const rootStat = await lstat(root);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    return { code: FINDING_CODE.SYMLINK_NOT_ALLOWED };
  }
  for (const part of parts) {
    current = join(current, part);
    let stat;
    try {
      stat = await lstat(current);
    } catch (error) {
      if (error.code === 'ENOENT') return { code: FINDING_CODE.RESOURCE_MISSING };
      throw error;
    }
    if (stat.isSymbolicLink()) return { code: FINDING_CODE.SYMLINK_NOT_ALLOWED };
  }
  const targetStat = await lstat(target);
  if (!targetStat.isFile() || targetStat.nlink !== 1) {
    return { code: FINDING_CODE.RESOURCE_NOT_REGULAR_FILE };
  }
  return { code: null };
}

function inferSurfaceHost(surfaceId, defaultHost) {
  const match = /^adapters\/([^/]+)$/u.exec(surfaceId);
  return match?.[1] ?? defaultHost;
}

function receiptProjection(result) {
  return {
    checkerVersion: result.checkerVersion,
    inputDigest: result.inputDigest,
    surfaces: result.surfaces,
    skillCount: result.skillCount,
    referenceCount: result.referenceCount,
    sourceOnlyCount: result.sourceOnlyCount,
    findingCount: result.findings.length,
  };
}

export function createSkillResourceClosureReceipt(result, identity = {}) {
  return {
    ...identity,
    checkerVersion: result.checkerVersion,
    inputDigest: result.inputDigest,
    surfaceCount: result.surfaces.length,
    skillCount: result.skillCount,
    referenceCount: result.referenceCount,
    sourceOnlyCount: result.sourceOnlyCount,
    findingCount: result.findings.length,
    receiptDigest: result.receiptDigest,
  };
}

export function assertSkillResourceClosureReceipt(expected, observed, label = 'release unit') {
  // 收据对象均为纯 JSON（JSON.parse 派生或固定字段投影），直接委托 Foundation
  // contracts 严格 canonicalJson 比较（非 JSON 输入 fail-closed，抛 TypeError）。
  if (canonicalJson(expected) !== canonicalJson(observed)) {
    throw new ReleaseError(
      GATE_FAILED,
      `skill resource closure receipt changed for ${label}`,
      { expected, observed },
    );
  }
}

export function evaluateConsumerSkillResourceClosureReceipts(plan, receipts) {
  const supported = new Set([
    'npm',
    'claude-plugin',
    'codex-plugin',
    'kimi-plugin',
    'codebuddy-plugin',
  ]);
  // When plan declares humanConsumersStrategy: 'manualFollowUps', Kimi/CodeBuddy
  // are non-blocking manual follow-up tasks and are not verified by the system.
  // Exclude them from the expected receipt set.
  const humanConsumerTypes = plan.humanConsumersStrategy === 'manualFollowUps'
    ? new Set(['kimi-plugin', 'codebuddy-plugin'])
    : new Set();
  const expectedKeys = [];
  for (const unit of plan.units ?? []) {
    for (const distribution of unit.distributions ?? []) {
      if (supported.has(distribution.type) && !humanConsumerTypes.has(distribution.type)) {
        expectedKeys.push(`${unit.id}:${distribution.type}`);
      }
    }
  }
  const observedKeys = receipts.map((item) => `${item.unitId}:${item.distribution}`);
  return {
    passed: new Set(observedKeys).size === observedKeys.length
      && canonicalJson([...expectedKeys].sort()) === canonicalJson([...observedKeys].sort()),
    expectedKeys: expectedKeys.sort(),
    observedKeys: observedKeys.sort(),
  };
}

export async function checkSkillResourceClosure({
  snapshotDir,
  host = 'root',
} = {}) {
  if (typeof snapshotDir !== 'string' || snapshotDir.length === 0) {
    throw new TypeError('snapshotDir must be a non-empty string');
  }
  const scanRoot = resolve(snapshotDir);
  const scanStat = await lstat(scanRoot);
  if (!scanStat.isDirectory() || scanStat.isSymbolicLink()) {
    throw new Error('snapshotDir must be a real directory');
  }

  let inputDigest;
  let snapshotError = null;
  try {
    inputDigest = (await computeFrozenSnapshot(scanRoot, {
      excludeRootEntries: TRANSPORT_EXCLUSIONS,
    })).digest;
  } catch (error) {
    snapshotError = error;
    inputDigest = digestDocument({
      invalidTree: error.message,
    });
  }
  const skillPaths = await discoverSkills(scanRoot);
  const findings = [];
  const surfaceMap = new Map();
  let referenceCount = 0;
  let sourceOnlyCount = 0;

  for (const skill of skillPaths) {
    const skillRoot = resolveSkillRoot(skill, scanRoot);
    const pluginRoot = resolvePluginRoot(skill, scanRoot);
    const surfaceId = relativeStable(scanRoot, pluginRoot);
    const surfaceHost = inferSurfaceHost(surfaceId, host);
    const surface = surfaceMap.get(surfaceId) ?? {
      id: surfaceId,
      host: surfaceHost,
      skillCount: 0,
      referenceCount: 0,
      sourceOnlyCount: 0,
    };
    surface.skillCount += 1;
    surfaceMap.set(surfaceId, surface);

    const content = await readFile(resolve(scanRoot, skill), 'utf8');
    for (const pathToken of extractPathTokens(content)) {
      referenceCount += 1;
      surface.referenceCount += 1;
      const classification = classifyReference(
        pathToken.token,
        skillRoot,
        pluginRoot,
        scanRoot,
      );
      const findingBase = {
        host: surfaceHost,
        surface: surfaceId,
        skill,
        line: pathToken.line,
        reference: pathToken.token,
        classification: classification.classification,
        resolutionRoot: classification.resolutionRoot,
        resolvedTarget: classification.resolvedTarget,
      };

      if (classification.classification === CLASSIFICATION.SOURCE_BACKJUMP) {
        if (pathToken.sourceOnly) {
          sourceOnlyCount += 1;
          surface.sourceOnlyCount += 1;
        } else {
          findings.push({ ...findingBase, code: FINDING_CODE.SOURCE_BACKJUMP });
        }
        continue;
      }
      if (classification.classification === CLASSIFICATION.MACHINE_ABSOLUTE) {
        findings.push({ ...findingBase, code: FINDING_CODE.MACHINE_ABSOLUTE_PATH });
        continue;
      }
      if (classification.classification === CLASSIFICATION.OUT_OF_BOUNDS) {
        findings.push({ ...findingBase, code: FINDING_CODE.OUT_OF_BOUNDS });
        continue;
      }

      const resolutionRootAbsolute = classification.classification === CLASSIFICATION.PLUGIN_ROOT
        ? pluginRoot
        : skillRoot;
      const inspection = await inspectRegularFile(
        resolutionRootAbsolute,
        classification.absoluteTarget,
      );
      if (inspection.code) {
        if (pathToken.sourceOnly && inspection.code === FINDING_CODE.RESOURCE_MISSING) {
          sourceOnlyCount += 1;
          surface.sourceOnlyCount += 1;
        } else {
          findings.push({ ...findingBase, code: inspection.code });
        }
      }
    }
  }

  if (snapshotError) {
    findings.push({
      host,
      surface: '.',
      skill: null,
      line: null,
      reference: '(snapshot tree)',
      classification: CLASSIFICATION.OUT_OF_BOUNDS,
      resolutionRoot: '.',
      resolvedTarget: '.',
      code: FINDING_CODE.SNAPSHOT_UNSAFE,
      reason: snapshotError.message,
    });
  }

  const surfaces = [...surfaceMap.values()].sort((a, b) => a.id.localeCompare(b.id));
  const result = {
    checkerVersion: CHECKER_VERSION,
    inputDigest,
    surfaces,
    skillCount: skillPaths.length,
    referenceCount,
    sourceOnlyCount,
    findings,
  };
  result.receiptDigest = digestDocument(receiptProjection(result));
  return result;
}
