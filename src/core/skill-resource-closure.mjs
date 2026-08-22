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
import { resolveSkillProjectionSurfaceHost } from '../platforms/registry.mjs';

export const CHECKER_VERSION = 'skill-resource-closure-v3';

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
// G2: user-home search paths (`~/...`, `$HOME/...`, `${HOME}/...`) with at
// least one trailing path character. Only code-span/fence/link tokens reach
// isPathToken, so prose words are never matched; fail-closed over silent miss.
const HOME_DIRECTORY_PATTERN = /^(?:~|\$HOME|\$\{HOME\})\/.+/u;
const ADAPTER_SURFACE_PATTERN = /^adapters\/([^/]+)$/u;
const PLATFORM_SURFACE_PATTERN = /^platforms\/(.+)$/u;
// G3: skill-local resource closure directories. Regular files inside these
// directories (under a skill directory) must be referenced by a SKILL.md of
// the same surface or they are reported as stale on adapter surfaces.
const CLOSURE_RESOURCE_DIRS = Object.freeze(['references', 'assets', 'schemas', 'examples', 'scripts']);
const GLOB_PATTERN = /[*?\[]/u;
// D3: the source-only exemption is scoped to the code snippet that carries the
// marker — the same fence line, inline code span, or link target from which
// the token was extracted. A prose marker elsewhere on the line exempts
// nothing (fail-closed over a line-wide false pass).
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
  HOME_DIRECTORY: 'home_directory',
  OUT_OF_BOUNDS: 'out_of_bounds',
  RESOURCE_DRIFT: 'resource_drift',
  STALE_RESOURCE: 'stale_resource',
  UNKNOWN_PLATFORM_SURFACE: 'unknown_platform_surface',
});

export const FINDING_CODE = Object.freeze({
  SNAPSHOT_UNSAFE: 'SNAPSHOT_UNSAFE',
  RESOURCE_MISSING: 'RESOURCE_MISSING',
  RESOURCE_NOT_REGULAR_FILE: 'RESOURCE_NOT_REGULAR_FILE',
  SOURCE_BACKJUMP: 'SOURCE_BACKJUMP',
  MACHINE_ABSOLUTE_PATH: 'MACHINE_ABSOLUTE_PATH',
  HOME_DIRECTORY_SEARCH: 'HOME_DIRECTORY_SEARCH',
  OUT_OF_BOUNDS: 'OUT_OF_BOUNDS',
  SYMLINK_NOT_ALLOWED: 'SYMLINK_NOT_ALLOWED',
  RESOURCE_DRIFT: 'RESOURCE_DRIFT',
  STALE_RESOURCE: 'STALE_RESOURCE',
  UNKNOWN_PLATFORM_SURFACE: 'UNKNOWN_PLATFORM_SURFACE',
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
    || HOME_DIRECTORY_PATTERN.test(token)
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
    // D3: the source-only marker is evaluated per code snippet, never per
    // line. Only tokens extracted from the very snippet text that contains
    // the marker (this fence line, this inline code span, this link target)
    // are exempt; unrelated tokens elsewhere on the line stay fail-closed.
    if (inFence) scanSnippet(line, lineNumber, SOURCE_ONLY_MARKER.test(line), results, seen);

    for (const match of line.matchAll(/`([^`]+)`/gu)) {
      scanSnippet(match[1], lineNumber, SOURCE_ONLY_MARKER.test(match[1]), results, seen);
    }
    for (const match of line.matchAll(/\]\(([^)]+)\)/gu)) {
      const target = match[1].trim().split(/[?#]/u)[0];
      if (!/^(?:https?:|#)/iu.test(target)) {
        // The whole link-target syntax is the code context for the marker
        // (query/fragment are stripped only for path resolution).
        scanSnippet(target, lineNumber, SOURCE_ONLY_MARKER.test(match[1]), results, seen);
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
  if (HOME_DIRECTORY_PATTERN.test(token)) {
    return {
      classification: CLASSIFICATION.HOME_DIRECTORY,
      resolutionRoot: '(home)',
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

async function collectRegularFiles(dir, results) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  for (const entry of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
    // Symlinks are owned by the snapshot safety gate (SNAPSHOT_UNSAFE); the
    // stale scan never follows or reports them.
    if (entry.isSymbolicLink()) continue;
    const absolute = join(dir, entry.name);
    if (entry.isDirectory()) {
      await collectRegularFiles(absolute, results);
    } else if (entry.isFile()) {
      results.push(absolute);
    }
  }
}

function inferSurfaceHost(surfaceId, defaultHost) {
  const adapterMatch = ADAPTER_SURFACE_PATTERN.exec(surfaceId);
  if (adapterMatch) return adapterMatch[1];
  const platformMatch = PLATFORM_SURFACE_PATTERN.exec(surfaceId);
  if (platformMatch) {
    return resolveSkillProjectionSurfaceHost(surfaceId)
      ?? `unknown-platform:${platformMatch[1]}`;
  }
  return defaultHost;
}

function receiptProjection(result) {
  return {
    checkerVersion: result.checkerVersion,
    inputDigest: result.inputDigest,
    surfaces: result.surfaces,
    skillCount: result.skillCount,
    referenceCount: result.referenceCount,
    sourceOnlyCount: result.sourceOnlyCount,
    sourceOnlyReferences: result.sourceOnlyReferences,
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
  const skillsBySurface = new Map();
  // G3: successfully resolved targets per surface. resolvedResources maps the
  // surface-relative resource path to its absolute target (drift comparison);
  // referencedTargets holds every absolute target some SKILL.md of the surface
  // resolved (stale exemption). resourceReferences records, per surface and
  // surface-relative resource path, the skill/line that referenced it (D4:
  // localizes RESOURCE_DRIFT findings). All stay out of the receipt projection.
  const resolvedResourcesBySurface = new Map();
  const referencedTargetsBySurface = new Map();
  const resourceReferencesBySurface = new Map();
  const sourceOnlyReferences = [];
  let referenceCount = 0;
  let sourceOnlyCount = 0;

  const recordSourceOnlyExemption = (surface, skill, pathToken) => {
    sourceOnlyCount += 1;
    surface.sourceOnlyCount += 1;
    sourceOnlyReferences.push({
      skill,
      line: pathToken.line,
      reference: pathToken.token,
      surface: surface.id,
    });
  };

  for (const skill of skillPaths) {
    const skillRoot = resolveSkillRoot(skill, scanRoot);
    const pluginRoot = resolvePluginRoot(skill, scanRoot);
    const surfaceId = relativeStable(scanRoot, pluginRoot);
    const surfaceHost = inferSurfaceHost(surfaceId, host);
    const firstSkillOnSurface = !surfaceMap.has(surfaceId);
    const surface = surfaceMap.get(surfaceId) ?? {
      id: surfaceId,
      host: surfaceHost,
      skillCount: 0,
      referenceCount: 0,
      sourceOnlyCount: 0,
    };
    surface.skillCount += 1;
    surfaceMap.set(surfaceId, surface);
    if (firstSkillOnSurface
        && PLATFORM_SURFACE_PATTERN.test(surfaceId)
        && resolveSkillProjectionSurfaceHost(surfaceId) === null) {
      findings.push({
        host: surfaceHost,
        surface: surfaceId,
        skill: null,
        line: null,
        reference: surfaceId,
        classification: CLASSIFICATION.UNKNOWN_PLATFORM_SURFACE,
        resolutionRoot: surfaceId,
        resolvedTarget: surfaceId,
        code: FINDING_CODE.UNKNOWN_PLATFORM_SURFACE,
      });
    }
    if (!skillsBySurface.has(surfaceId)) skillsBySurface.set(surfaceId, []);
    skillsBySurface.get(surfaceId).push(skill);

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
          recordSourceOnlyExemption(surface, skill, pathToken);
        } else {
          findings.push({ ...findingBase, code: FINDING_CODE.SOURCE_BACKJUMP });
        }
        continue;
      }
      if (classification.classification === CLASSIFICATION.MACHINE_ABSOLUTE) {
        findings.push({ ...findingBase, code: FINDING_CODE.MACHINE_ABSOLUTE_PATH });
        continue;
      }
      if (classification.classification === CLASSIFICATION.HOME_DIRECTORY) {
        findings.push({ ...findingBase, code: FINDING_CODE.HOME_DIRECTORY_SEARCH });
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
          recordSourceOnlyExemption(surface, skill, pathToken);
        } else {
          findings.push({ ...findingBase, code: inspection.code });
        }
        continue;
      }

      const relativeResource = relativeStable(pluginRoot, classification.absoluteTarget);
      if (!resolvedResourcesBySurface.has(surfaceId)) {
        resolvedResourcesBySurface.set(surfaceId, new Map());
        referencedTargetsBySurface.set(surfaceId, new Set());
        resourceReferencesBySurface.set(surfaceId, new Map());
      }
      resolvedResourcesBySurface.get(surfaceId).set(relativeResource, classification.absoluteTarget);
      referencedTargetsBySurface.get(surfaceId).add(classification.absoluteTarget);
      const resourceReferences = resourceReferencesBySurface.get(surfaceId);
      if (!resourceReferences.has(relativeResource)) resourceReferences.set(relativeResource, []);
      resourceReferences.get(relativeResource).push({
        surface: surfaceId,
        skill,
        line: pathToken.line,
      });
    }
  }

  // G3 RESOURCE_DRIFT: the same surface-relative resource path resolved on two
  // surfaces must be byte-identical (typical case: root vs adapters/<name>
  // projections of the same skill resource). Content digests are cached per
  // absolute target.
  const contentDigestCache = new Map();
  const digestOfTarget = async (absoluteTarget) => {
    if (!contentDigestCache.has(absoluteTarget)) {
      contentDigestCache.set(
        absoluteTarget,
        digestDocument({ content: await readFile(absoluteTarget, 'utf8') }),
      );
    }
    return contentDigestCache.get(absoluteTarget);
  };
  const surfaceIds = [...resolvedResourcesBySurface.keys()].sort((a, b) => a.localeCompare(b));
  for (let i = 0; i < surfaceIds.length; i += 1) {
    for (let j = i + 1; j < surfaceIds.length; j += 1) {
      const [leftId, rightId] = [surfaceIds[i], surfaceIds[j]];
      const left = resolvedResourcesBySurface.get(leftId);
      const right = resolvedResourcesBySurface.get(rightId);
      const commonPaths = [...left.keys()]
        .filter((path) => right.has(path))
        .sort((a, b) => a.localeCompare(b));
      for (const resourcePath of commonPaths) {
        const [leftDigest, rightDigest] = await Promise.all([
          digestOfTarget(left.get(resourcePath)),
          digestOfTarget(right.get(resourcePath)),
        ]);
        if (leftDigest === rightDigest) continue;
        const rightSurface = surfaceMap.get(rightId);
        // D4: localize the drift — list every skill/line on both surfaces that
        // resolved this resource path (deduped, deterministically sorted).
        // Findings never enter the receipt projection, so this is digest-safe.
        const driftReferences = [];
        const seenReference = new Set();
        for (const surfaceId of [leftId, rightId]) {
          for (const ref of resourceReferencesBySurface.get(surfaceId)?.get(resourcePath) ?? []) {
            const key = `${ref.surface}\u0000${ref.skill}\u0000${ref.line}`;
            if (seenReference.has(key)) continue;
            seenReference.add(key);
            driftReferences.push({ surface: ref.surface, skill: ref.skill, line: ref.line });
          }
        }
        driftReferences.sort((a, b) => (
          a.surface.localeCompare(b.surface)
          || a.skill.localeCompare(b.skill)
          || (a.line - b.line)
        ));
        findings.push({
          host: rightSurface.host,
          surface: rightId,
          skill: null,
          line: null,
          reference: resourcePath,
          classification: CLASSIFICATION.RESOURCE_DRIFT,
          resolutionRoot: rightId,
          resolvedTarget: resourcePath,
          surfaces: [leftId, rightId],
          references: driftReferences,
          code: FINDING_CODE.RESOURCE_DRIFT,
        });
      }
    }
  }

  // G3 STALE_RESOURCE: on adapter surfaces only, every regular file inside a
  // skill's resource closure directories must be referenced by some SKILL.md
  // of the same surface (bare or explicit plugin-root form). The root surface
  // is exempt (repository roots carry many legitimate unreferenced files).
  for (const surfaceId of [...skillsBySurface.keys()].sort((a, b) => a.localeCompare(b))) {
    if (!ADAPTER_SURFACE_PATTERN.test(surfaceId)) continue;
    const surface = surfaceMap.get(surfaceId);
    const surfaceRootAbsolute = resolve(scanRoot, surfaceId);
    const referencedTargets = referencedTargetsBySurface.get(surfaceId) ?? new Set();
    const stale = [];
    for (const skill of skillsBySurface.get(surfaceId)) {
      const skillDir = resolve(scanRoot, dirname(skill));
      for (const closureDir of CLOSURE_RESOURCE_DIRS) {
        const files = [];
        await collectRegularFiles(join(skillDir, closureDir), files);
        for (const absolute of files) {
          if (referencedTargets.has(absolute)) continue;
          const relativeResource = relativeStable(surfaceRootAbsolute, absolute);
          stale.push({
            host: surface.host,
            surface: surfaceId,
            skill,
            line: null,
            reference: relativeResource,
            classification: CLASSIFICATION.STALE_RESOURCE,
            resolutionRoot: surfaceId,
            resolvedTarget: relativeResource,
            code: FINDING_CODE.STALE_RESOURCE,
          });
        }
      }
    }
    stale.sort((a, b) => (a.skill.localeCompare(b.skill) || a.resolvedTarget.localeCompare(b.resolvedTarget)));
    findings.push(...stale);
  }

  sourceOnlyReferences.sort((a, b) => (
    a.skill.localeCompare(b.skill)
    || (a.line - b.line)
    || a.reference.localeCompare(b.reference)
  ));

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
    sourceOnlyReferences,
    findings,
  };
  result.receiptDigest = digestDocument(receiptProjection(result));
  return result;
}

/**
 * G4: reconcile declared plugin distributions against observed surfaces.
 *
 * Every declared plugin host must be present among the receipt surfaces with
 * at least one skill; a host whose adapter tree was dropped from publicFiles
 * (or whose projection produced no skills) must fail closed at prepare.
 * `expectedHosts` are adapter directory names (e.g. `codebuddy-plugin`
 * expects the historical `workbuddy` adapter directory).
 *
 * @param {string[]} expectedHosts - declared plugin host surface names
 * @param {Array<{ id: string, host: string, skillCount: number }>} surfaces
 * @returns {{ passed: boolean, missing: Array<{ host: string, skillCount: number }> }}
 */
export function evaluateDeclaredHostSurfaceCoverage(expectedHosts, surfaces) {
  const missing = [];
  for (const expectedHost of [...new Set(expectedHosts ?? [])].sort((a, b) => a.localeCompare(b))) {
    const surface = (surfaces ?? []).find((item) => item.host === expectedHost);
    if (!surface || !(surface.skillCount >= 1)) {
      missing.push({ host: expectedHost, skillCount: surface?.skillCount ?? 0 });
    }
  }
  return { passed: missing.length === 0, missing };
}
