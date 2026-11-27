// @decision D-RS-001

import { lstat, readFile } from 'node:fs/promises';
import { relative, resolve, sep } from 'node:path';
import { parseSemverVersion } from '../commands/assess.mjs';
import { CONFIG_INVALID, MISSING_PARAMETERS, ReleaseError } from './errors.mjs';

export const CORE_BASE_PACKAGES = Object.freeze([
  'skill-family-contracts',
  'skill-family-harness-node',
  'skill-family-engineering-kit',
  'artifact-graph',
  'agent-method-registry',
]);

export const BUILTIN_BASE_PACKAGE_BENCHMARKS = Object.freeze({
  'skill-family-contracts': Object.freeze({
    latestStable: '0.39.2',
    deprecatedVersions: Object.freeze([]),
    deprecatedBelow: null,
    deprecatedReason: null,
  }),
  'skill-family-harness-node': Object.freeze({
    latestStable: '0.39.2',
    deprecatedVersions: Object.freeze([]),
    deprecatedBelow: null,
    deprecatedReason: null,
  }),
  'skill-family-engineering-kit': Object.freeze({
    latestStable: '0.39.2',
    deprecatedVersions: Object.freeze([]),
    deprecatedBelow: null,
    deprecatedReason: null,
  }),
  'artifact-graph': Object.freeze({
    latestStable: '1.2.2',
    deprecatedVersions: Object.freeze([]),
    deprecatedBelow: '1.0.0',
    deprecatedReason: '旧版 0.x 存在已知高危安全缺陷（含 Frontmatter 解析 RCE 风险），请升级至 >=1.2.2',
  }),
  'agent-method-registry': Object.freeze({
    latestStable: '0.3.0',
    deprecatedVersions: Object.freeze([]),
    deprecatedBelow: null,
    deprecatedReason: null,
  }),
});

const DEP_SECTIONS = Object.freeze([
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies',
]);

function toPosixRelative(root, target) {
  const rel = relative(root, target);
  if (!rel || rel === '.') return 'package.json';
  return rel.split(sep).join('/');
}

export function compareSemverVersions(a, b) {
  const pa = parseSemverVersion(a);
  const pb = parseSemverVersion(b);
  if (!pa || !pb) return null;
  if (pa.major !== pb.major) return pa.major < pb.major ? -1 : 1;
  if (pa.minor !== pb.minor) return pa.minor < pb.minor ? -1 : 1;
  if (pa.patch !== pb.patch) return pa.patch < pb.patch ? -1 : 1;
  if (pa.prerelease === null && pb.prerelease !== null) return 1;
  if (pa.prerelease !== null && pb.prerelease === null) return -1;
  if (pa.prerelease !== null && pb.prerelease !== null) {
    if (pa.prerelease < pb.prerelease) return -1;
    if (pa.prerelease > pb.prerelease) return 1;
  }
  return 0;
}

export function extractDeclaredSemver(spec) {
  if (typeof spec !== 'string') return null;
  const trimmed = spec.trim();
  if (!trimmed || /^(?:workspace:|file:|link:|git\+|https?:|npm:|\*|latest$)/i.test(trimmed)) {
    return null;
  }
  const clean = trimmed.replace(/^[~^=<>v\s]+/, '');
  const match = clean.match(/^(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/);
  if (!match) return null;
  return parseSemverVersion(match[1]) ? match[1] : null;
}

async function readRegularJsonFile(absPath, label) {
  let st;
  try {
    st = await lstat(absPath);
  } catch (err) {
    if (err?.code === 'ENOENT') return null;
    throw new ReleaseError(CONFIG_INVALID, `cannot stat ${label}: ${err.message}`, {
      field: label,
      cause: err.code ?? 'STAT_FAILED',
    });
  }
  if (st.isSymbolicLink() || !st.isFile()) {
    throw new ReleaseError(CONFIG_INVALID, `${label} must be a regular non-symlink file`, {
      field: label,
    });
  }
  let raw;
  try {
    raw = await readFile(absPath, 'utf8');
  } catch (err) {
    throw new ReleaseError(CONFIG_INVALID, `cannot read ${label}: ${err.message}`, {
      field: label,
      cause: err.code ?? 'READ_FAILED',
    });
  }
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') {
      throw new Error('JSON value must be an object or array');
    }
    return parsed;
  } catch (err) {
    throw new ReleaseError(CONFIG_INVALID, `invalid JSON in ${label}: ${err.message}`, {
      field: label,
    });
  }
}

function normalizeSnapshotEntries(snapshot) {
  const byName = new Map();
  if (!snapshot || typeof snapshot !== 'object') return byName;

  const pushEntry = (rawName, rawMeta) => {
    if (!rawMeta || typeof rawMeta !== 'object') return;
    const name = typeof rawMeta.packageName === 'string'
      ? rawMeta.packageName
      : (typeof rawMeta.name === 'string' ? rawMeta.name : rawName);
    if (typeof name !== 'string' || !CORE_BASE_PACKAGES.includes(name)) return;
    if (!byName.has(name)) byName.set(name, []);
    byName.get(name).push(rawMeta);
  };

  if (Array.isArray(snapshot)) {
    for (const item of snapshot) pushEntry(null, item);
    return byName;
  }

  for (const listKey of ['packages', 'entries', 'plugins', 'ecosystemComponents']) {
    const container = snapshot[listKey];
    if (Array.isArray(container)) {
      for (const item of container) pushEntry(null, item);
    } else if (container && typeof container === 'object') {
      for (const [k, v] of Object.entries(container)) pushEntry(k, v);
    }
  }
  if (snapshot.marketplace && typeof snapshot.marketplace === 'object') {
    for (const listKey of ['ecosystemComponents', 'packages', 'entries']) {
      const container = snapshot.marketplace[listKey];
      if (Array.isArray(container)) {
        for (const item of container) pushEntry(null, item);
      }
    }
  }
  if (typeof snapshot.name === 'string' || typeof snapshot.packageName === 'string') {
    pushEntry(null, snapshot);
  }
  return byName;
}

function resolveSnapshotRule(pkgName, lockedVersion, entries) {
  if (!entries || entries.length === 0) {
    return { latestStable: null, deprecated: false, deprecatedReason: null };
  }

  let latestStable = null;
  let deprecated = false;
  let deprecatedReason = null;

  for (const entry of entries) {
    const state = entry.lifecycleState ?? entry.lifecycleStatus ?? null;
    const candidateLatest = entry.latestStable ?? entry.latestVersion ?? entry.fallbackVersion ?? null;
    if (typeof candidateLatest === 'string' && parseSemverVersion(candidateLatest)) {
      if (!latestStable || compareSemverVersions(candidateLatest, latestStable) > 0) {
        latestStable = candidateLatest;
      }
    } else if (state !== 'deprecated' && typeof entry.version === 'string' && parseSemverVersion(entry.version)) {
      if (!latestStable || compareSemverVersions(entry.version, latestStable) > 0) {
        latestStable = entry.version;
      }
    }

    if (state === 'deprecated') {
      let matches = false;
      const explicitList = Array.isArray(entry.deprecatedVersions) ? entry.deprecatedVersions : null;
      if (explicitList && explicitList.includes(lockedVersion)) {
        matches = true;
      } else if (typeof entry.deprecatedBelow === 'string' && parseSemverVersion(entry.deprecatedBelow)) {
        matches = compareSemverVersions(lockedVersion, entry.deprecatedBelow) < 0;
      } else if (typeof entry.affectedVersion === 'string' && parseSemverVersion(entry.affectedVersion)) {
        matches = compareSemverVersions(lockedVersion, entry.affectedVersion) === 0;
      } else if (typeof entry.version === 'string' && parseSemverVersion(entry.version)) {
        const cmp = compareSemverVersions(lockedVersion, entry.version);
        const isSafeFallback = typeof entry.fallbackVersion === 'string'
          && parseSemverVersion(entry.fallbackVersion)
          && compareSemverVersions(lockedVersion, entry.fallbackVersion) === 0;
        matches = cmp !== null && cmp <= 0 && !isSafeFallback;
      } else {
        matches = true;
      }
      if (matches) {
        deprecated = true;
        deprecatedReason = entry.deprecationNotice
          ?? entry.reason
          ?? entry.deprecatedReason
          ?? `市场台账标记 ${pkgName}@${lockedVersion} 为 deprecated`;
      }
    }
  }

  return { latestStable, deprecated, deprecatedReason };
}

/**
 * Inspect target workspace root and selected unit package.json files for core
 * base dependency staleness and deprecated/vulnerable versions.
 */
export async function checkDependencyFreshness({
  root,
  units = [],
  production = false,
  acknowledgeDeprecatedDeps = false,
  marketplaceSnapshot = null,
  marketplaceSnapshotPath = null,
} = {}) {
  const realRoot = resolve(root);
  let loadedSnapshot = marketplaceSnapshot;
  if (!loadedSnapshot && marketplaceSnapshotPath) {
    const absSnapshotPath = resolve(realRoot, marketplaceSnapshotPath);
    loadedSnapshot = await readRegularJsonFile(absSnapshotPath, '--marketplace-snapshot');
    if (!loadedSnapshot) {
      throw new ReleaseError(
        MISSING_PARAMETERS,
        `marketplace snapshot file not found: ${marketplaceSnapshotPath}`,
        { field: '--marketplace-snapshot', path: marketplaceSnapshotPath },
      );
    }
  }

  const snapshotMap = normalizeSnapshotEntries(loadedSnapshot);

  const manifestCandidates = new Set([resolve(realRoot, 'package.json')]);
  for (const unit of units) {
    const unitSource = typeof unit?.source === 'string' && unit.source.length > 0 ? unit.source : '.';
    manifestCandidates.add(resolve(realRoot, unitSource, 'package.json'));
  }

  const checkedManifests = [];
  const evaluatedDependencies = [];
  const advisories = [];

  for (const manifestAbs of [...manifestCandidates].sort()) {
    const pkgJson = await readRegularJsonFile(manifestAbs, toPosixRelative(realRoot, manifestAbs));
    if (!pkgJson) continue;
    const relManifest = toPosixRelative(realRoot, manifestAbs);
    checkedManifests.push(relManifest);

    const seenInManifest = new Set();
    for (const section of DEP_SECTIONS) {
      const depsObj = pkgJson[section];
      if (!depsObj || typeof depsObj !== 'object') continue;
      for (const pkgName of CORE_BASE_PACKAGES) {
        if (!Object.hasOwn(depsObj, pkgName) || seenInManifest.has(pkgName)) continue;
        seenInManifest.add(pkgName);
        const declaredSpec = depsObj[pkgName];
        const lockedVersion = extractDeclaredSemver(declaredSpec);
        if (!lockedVersion) continue;

        const builtin = BUILTIN_BASE_PACKAGE_BENCHMARKS[pkgName];
        const snapshotEntries = snapshotMap.get(pkgName) ?? [];
        const snapshotRule = resolveSnapshotRule(pkgName, lockedVersion, snapshotEntries);

        let latestStable = builtin.latestStable;
        if (
          snapshotRule.latestStable
          && compareSemverVersions(snapshotRule.latestStable, latestStable) > 0
        ) {
          latestStable = snapshotRule.latestStable;
        }

        const hitBuiltinDeprecated = (
          builtin.deprecatedVersions.includes(lockedVersion)
          || (builtin.deprecatedBelow !== null && compareSemverVersions(lockedVersion, builtin.deprecatedBelow) < 0)
        );
        const isDeprecated = hitBuiltinDeprecated || snapshotRule.deprecated;
        const cmpLatest = compareSemverVersions(lockedVersion, latestStable);
        const isOutdated = cmpLatest !== null && cmpLatest < 0;

        const record = {
          packageName: pkgName,
          manifestPath: relManifest,
          dependencySection: section,
          declaredSpec,
          lockedVersion,
          latestStableVersion: latestStable,
          status: isDeprecated ? 'deprecated' : (isOutdated ? 'outdated' : 'current'),
        };
        evaluatedDependencies.push(record);

        if (isDeprecated) {
          const reason = snapshotRule.deprecated
            ? snapshotRule.deprecatedReason
            : (builtin.deprecatedReason ?? `命中高危弃用版本名单（${pkgName}@${lockedVersion}）`);
          const source = snapshotRule.deprecated ? 'marketplace-snapshot' : 'builtin';
          advisories.push({
            kind: 'dependency-freshness',
            code: 'DEPRECATED_BASE_DEPENDENCY',
            severity: 'high',
            level: 'deprecated',
            blocking: production && acknowledgeDeprecatedDeps !== true,
            packageName: pkgName,
            lockedVersion,
            declaredSpec,
            manifestPath: relManifest,
            dependencySection: section,
            latestStableVersion: latestStable,
            lifecycleState: 'deprecated',
            source,
            reason,
            message: `高危弃用依赖告警：检测到 ${pkgName}@${lockedVersion}（声明于 ${relManifest}），${reason}；最新稳定版为 ${latestStable}，请升级底座依赖或确认已知风险后传入 --acknowledge-deprecated-deps 放行`,
          });
        } else if (isOutdated) {
          advisories.push({
            kind: 'dependency-freshness',
            code: 'BASE_DEPENDENCY_OUTDATED',
            severity: 'info',
            level: 'outdated',
            blocking: false,
            packageName: pkgName,
            lockedVersion,
            declaredSpec,
            manifestPath: relManifest,
            dependencySection: section,
            latestStableVersion: latestStable,
            lifecycleState: 'active',
            source: snapshotEntries.length > 0 ? 'marketplace-snapshot' : 'builtin',
            reason: null,
            message: `检测到 ${pkgName}@${lockedVersion}（声明于 ${relManifest}），最新稳定版为 ${latestStable}，业务迭代可按需升级`,
          });
        }
      }
    }
  }

  const deprecatedAdvisories = advisories.filter((item) => item.level === 'deprecated');
  const outdatedAdvisories = advisories.filter((item) => item.level === 'outdated');

  return {
    checkedManifests,
    evaluatedDependencies,
    advisories,
    outdatedAdvisories,
    deprecatedAdvisories,
    hasOutdated: outdatedAdvisories.length > 0,
    hasDeprecated: deprecatedAdvisories.length > 0,
    blocked: production && deprecatedAdvisories.length > 0 && acknowledgeDeprecatedDeps !== true,
    acknowledgedDeprecatedDeps: acknowledgeDeprecatedDeps === true,
  };
}
