/**
 * First-use setup discovery and create-once configuration bootstrap.
 *
 * Dry-run is the default. Human-owned files are never regenerated: write
 * mode can only create an absent `.release-skill/project.yaml` after the
 * caller confirms the exact digest of the current facts and answers.
 */

import { execFile as execFileCb } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { promisify } from 'node:util';
import {
  lstat,
  readFile,
  readdir,
  realpath,
} from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import YAML from 'yaml';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';

import { canonicalJson, sha256Hex } from '../core/digest.mjs';
import { acquireProjectLock } from '../artifacts/project-lock.mjs';
import { getPlatform, PLATFORMS } from '../platforms/registry.mjs';
import { checkNpmEntryClosure } from '../npm/npm-entry-closure.mjs';
import {
  CONFIG_EXISTS,
  CONFIG_INVALID,
  CONFIG_MISSING,
  ReleaseError,
  SETUP_DIGEST_MISMATCH,
} from '../core/errors.mjs';
import { readTrustedPackageResource } from '../core/trusted-resource.mjs';
import { validatePresetHook } from '../core/presets.mjs';
import { validatePostPublishDeclaration, validatePostPublishHookIdUniqueness } from '../core/postpublish.mjs';
import { loadProjectConfig } from '../core/config.mjs';
import { resolveProducerVersion } from '../core/evidence.mjs';
import { validateHook } from '../core/hooks.mjs';
import {
  buildAssessmentReport,
  classifyGapCategory,
  createFinding,
  deriveCheckOnlySuggestions,
  deriveGateSuggestions,
  deriveHookDurations,
  deriveLongHookSuggestions,
  scanGateDeclarationFindings,
  FINDING_CATEGORY,
  ASSESSMENT_STATUS,
} from '../core/adoption-assessment.mjs';
import {
  checkCommonDocs,
  checkPackageMetadata,
  checkPluginManifests,
  checkReadmeStructure,
} from './assess.mjs';

const execFile = promisify(execFileCb);
const SKIP_DIRS = new Set([
  '.git', '.release-skill', '.worktrees', '.claude', '.codex', '.kimi', '.cache', '.tmp',
  '.pytest_cache', '.mypy_cache', '.ruff_cache', '.tox', '.venv', 'venv',
  'node_modules', 'dist', 'coverage', 'build', 'out', 'tmp', 'temp',
  'runs', 'test', 'tests', 'test-fixtures', 'fixtures', 'examples',
]);
// Registry-driven discovery: derive marketplace and plugin manifest paths
// from the platform registry. This replaces hardcoded path checks so that
// new platforms (e.g. Codex's .agents/plugins/marketplace.json) are
// automatically discovered without editing setup.mjs.
const DISCOVERY_MANIFEST_SUFFIXES = new Set(
  PLATFORMS.flatMap((p) => {
    const paths = [p.manifestPaths.plugin];
    if (p.manifestPaths.marketplace) paths.push(p.manifestPaths.marketplace);
    // Kimi has pluginCandidates (kimi.plugin.json, .kimi-plugin/plugin.json)
    if (p.manifestPaths.pluginCandidates) paths.push(...p.manifestPaths.pluginCandidates);
    return paths;
  }),
);

// Build a map from manifest path suffix → host platform id(s).
// For marketplace and plugin files, this allows deterministic host detection
// without hardcoded path.includes() checks.
// Multi-value: Claude and CodeBuddy share .claude-plugin/marketplace.json;
// a single-value Map would overwrite one platform's identity with the other.
const MANIFEST_SUFFIX_HOST_MAP = new Map();
for (const platform of PLATFORMS) {
  const mp = platform.manifestPaths.marketplace;
  if (mp) {
    const existing = MANIFEST_SUFFIX_HOST_MAP.get(mp);
    if (existing) {
      existing.push(platform.id);
    } else {
      MANIFEST_SUFFIX_HOST_MAP.set(mp, [platform.id]);
    }
  }
  const pp = platform.manifestPaths.plugin;
  if (pp) {
    const existing = MANIFEST_SUFFIX_HOST_MAP.get(pp);
    if (existing) {
      existing.push(platform.id);
    } else {
      MANIFEST_SUFFIX_HOST_MAP.set(pp, [platform.id]);
    }
  }
  if (platform.manifestPaths.pluginCandidates) {
    for (const candidate of platform.manifestPaths.pluginCandidates) {
      const existing = MANIFEST_SUFFIX_HOST_MAP.get(candidate);
      if (existing) {
        existing.push(platform.id);
      } else {
        MANIFEST_SUFFIX_HOST_MAP.set(candidate, [platform.id]);
      }
    }
  }
}

const MAX_JSON_BYTES = 1024 * 1024;
const schema = JSON.parse((await readTrustedPackageResource(
  'schemas/release-project.schema.json',
)).toString('utf8'));
const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);
const validateProjectConfig = ajv.compile(schema);

function setupError(code, message, details = {}) {
  return new ReleaseError(code, message, details);
}

function safeRelative(root, path) {
  const rel = relative(root, path).split('\\').join('/');
  return rel || '.';
}

async function readJsonBounded(path, label) {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_JSON_BYTES) {
    throw setupError(CONFIG_INVALID, `${label} must be a regular JSON file no larger than 1 MiB`, { path });
  }
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    throw setupError(CONFIG_INVALID, `${label} is not valid JSON: ${error.message}`, { path });
  }
}

async function walkDiscoveryFiles(root, maxDepth = 8) {
  const found = [];
  async function walk(directory, depth) {
    if (depth > maxDepth) return;
    const children = await readdir(directory, { withFileTypes: true });
    children.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const child of children) {
      if (child.isSymbolicLink()) continue;
      const absolute = join(directory, child.name);
      if (child.isDirectory()) {
        if (!SKIP_DIRS.has(child.name)) await walk(absolute, depth + 1);
      } else if (
        child.isFile() &&
        (child.name === 'package.json' ||
          child.name === 'public-release.json' ||
          child.name === 'SKILL.md' ||
          /^README(?:\.|$)/i.test(child.name) ||
          /^LICENSE(?:\.|$)/i.test(child.name) ||
          /^CHANGELOG(?:\.|$)/i.test(child.name) ||
          [...DISCOVERY_MANIFEST_SUFFIXES].some((suffix) => absolute.endsWith(`/${suffix}`)))
      ) {
        found.push(absolute);
      }
    }
  }
  await walk(root, 0);
  return found;
}

async function digestFile(path) {
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink()) throw setupError(CONFIG_INVALID, 'discovered file must be regular', { path });
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  const after = await lstat(path);
  if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ino !== after.ino) {
    throw setupError(CONFIG_INVALID, 'discovered file changed while setup was reading it', { path });
  }
  return { size: after.size, sha256: hash.digest('hex') };
}

function parseGithubRepo(value) {
  if (!value) return null;
  const raw = typeof value === 'string' ? value : value.url;
  if (typeof raw !== 'string') return null;
  const match = raw.match(/github\.com[/:]([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?(?:#.*)?$/);
  return match ? `${match[1]}/${match[2]}` : null;
}

function safeUnitId(pkg, relDir) {
  const fromName = typeof pkg.name === 'string' ? pkg.name.replace(/^@[^/]+\//, '') : '';
  const fallback = relDir === '.' ? 'root' : basename(relDir);
  const candidate = (fromName || fallback).toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return candidate || 'release-unit';
}

function optionalString(value) {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function stringList(value) {
  return Array.isArray(value)
    ? value.filter((item) => typeof item === 'string' && item.length > 0)
    : [];
}

function summarizeLegacyReleaseConfig(value, path) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw setupError(CONFIG_INVALID, 'public-release.json must contain a JSON object', { path });
  }
  const topLevelRepo = optionalString(value.repoId) ?? parseGithubRepo(value.publicRepoUrl);
  const topLevelSource = optionalString(value.publicSourceDir) ?? stringList(value.publicRoots)[0] ?? '.';
  const declaredRepos = Array.isArray(value.repos) ? value.repos : [];
  const releaseUnits = declaredRepos
    .filter((repo) => repo && typeof repo === 'object' && !Array.isArray(repo))
    .map((repo, index) => ({
      id: optionalString(repo.id) ?? optionalString(repo.name) ?? `legacy-unit-${index + 1}`,
      source: optionalString(repo.source) ?? '.',
      publicRepo: optionalString(repo.publicRepo),
      tagPrefix: optionalString(repo.tagPrefix),
      npmPackage: optionalString(repo.npmPackage),
      npmPackageDeclared: Object.hasOwn(repo, 'npmPackage'),
      npmRequiredPathCandidates: stringList(repo.npmRequiredPackagePaths),
      npmRequiredPathsDeclared: Object.hasOwn(repo, 'npmRequiredPackagePaths'),
      docsSource: optionalString(repo.docsSource),
      requiredPathCandidates: stringList(repo.requiredPackagePaths),
      snapshotCommands: Array.isArray(repo.snapshotCommands) ? repo.snapshotCommands : [],
    }));
  if (releaseUnits.length === 0 && (topLevelRepo || value.plugins || value.snapshotCommands)) {
    const plugins = Array.isArray(value.plugins) ? value.plugins : [];
    const pluginName = plugins
      .filter((plugin) => plugin && typeof plugin === 'object' && !Array.isArray(plugin))
      .map((plugin) => optionalString(plugin.name))
      .find(Boolean);
    releaseUnits.push({
      id: pluginName ?? basename(topLevelSource),
      source: topLevelSource,
      publicRepo: topLevelRepo,
      tagPrefix: optionalString(value.tagPrefix),
      npmPackage: plugins
        .filter((plugin) => plugin && typeof plugin === 'object' && !Array.isArray(plugin))
        .map((plugin) => optionalString(plugin.npmPackage))
        .find(Boolean) ?? null,
      npmPackageDeclared: plugins.some((plugin) => (
        plugin && typeof plugin === 'object' && !Array.isArray(plugin) && Object.hasOwn(plugin, 'npmPackage')
      )),
      npmRequiredPathCandidates: stringList(value.npmRequiredPackagePaths),
      npmRequiredPathsDeclared: Object.hasOwn(value, 'npmRequiredPackagePaths'),
      docsSource: null,
      requiredPathCandidates: stringList(value.requiredPaths),
      snapshotCommands: Array.isArray(value.snapshotCommands) ? value.snapshotCommands : [],
    });
  }
  return {
    path,
    owner: optionalString(value.owner),
    defaultBranch: optionalString(value.defaultBranch),
    parentRepo: optionalString(value.parentRepo),
    releaseUnits,
    sharedFileCandidates: Array.isArray(value.sharedFiles)
      ? value.sharedFiles
        .filter((item) => item && typeof item === 'object' && !Array.isArray(item))
        .map((item) => ({ source: optionalString(item.source), target: optionalString(item.target) }))
        .filter((item) => item.source && item.target)
      : [],
    docFileCandidates: stringList(value.docFiles),
    forbiddenPathCandidates: [
      ...stringList(value.forbiddenPublicPaths),
      ...stringList(value.forbiddenPaths),
    ].sort(),
    forbiddenContentPatternCandidates: stringList(value.forbiddenContentPatterns).sort(),
  };
}

function normalizeLegacyCommand(value) {
  if (Array.isArray(value) && typeof value[0] === 'string') {
    if (Array.isArray(value[1]) && value[1].every((item) => typeof item === 'string')) {
      return [value[0], ...value[1]];
    }
    if (value.every((item) => typeof item === 'string')) return [...value];
  }
  if (typeof value === 'string' && !/[|&;<>`$'"\\]/.test(value)) {
    const tokens = value.trim().split(/\s+/).filter(Boolean);
    return tokens.length > 0 ? tokens : null;
  }
  return null;
}

function classifyScript(name, command, unitId, distributionTypes) {
  const normalizedName = name.toLowerCase();
  const inspectedArgv = normalizeLegacyCommand(command);
  const argv = inspectedArgv?.map((token) => token.toLowerCase()) ?? [];
  const executable = basename(argv[0] ?? '');
  const subcommand = argv[1] ?? '';

  // Script names only express purpose/cost. Network and interactive behavior
  // is derived from parsed argv so repository names such as "release-notes"
  // and paths containing "development" cannot trigger false positives.
  const isSmoke = /smoke/.test(normalizedName);
  const llmLikely = /(?:^|[:_-])llm(?:$|[:_-])/.test(normalizedName) ||
    argv.some((token) => /(?:^|[-_/])(?:llm|claude|openai)(?:[-_.\/]|$)/.test(token));
  const highCost = /(?:^|[:_-])(integration|e2e|browser|real|self-iteration)(?:$|[:_-])/.test(normalizedName) || llmLikely;
  const packagePublish = ['npm', 'pnpm', 'yarn'].includes(executable) && subcommand === 'publish';
  const githubRelease = executable === 'gh' && subcommand === 'release';
  const networkLikely = packagePublish || githubRelease || ['curl', 'wget', 'npx'].includes(executable) ||
    (executable === 'git' && ['push', 'fetch', 'pull'].includes(subcommand)) || llmLikely;
  const interactive = /(?:^|[:_-])(watch|dev|serve)(?:$|[:_-])/.test(normalizedName) ||
    argv.some((token) => token === '--watch' || token.startsWith('--watch=')) ||
    ['nodemon', 'vite'].includes(executable) ||
    subcommand === 'serve' || (executable === 'next' && subcommand === 'dev');
  const mayWrite = /(?:^|[:_-])(build|generate|update|fix|format|codegen)(?:$|[:_-])/.test(normalizedName) ||
    argv.includes('--fix') || packagePublish || githubRelease;
  const distribution = distributionTypes.length === 1 ? distributionTypes[0] : null;
  const consumerContextUnproven = isSmoke;

  // Indirect execution: script interpreters with local script paths, or
  // package manager run/test commands. Their actual behavior cannot be
  // proven from argv alone, so they must fail closed.
  // For node/python/python3/bash/sh: detect when an argument looks like a
  // script path (contains / or .) or when node is invoked as a test runner
  // (--test flag). Exclude pure flags (starting with -) for non-node interpreters.
  // A package script is an indirection boundary regardless of its first argv.
  // It may execute a relative shebang file, load plugins, source another file,
  // or delegate through an unrecognised interpreter. Discovery therefore never
  // proves side effects; only explicit human selection may register it as a gate.
  const sideEffectsUnproven = inspectedArgv !== null &&
    !networkLikely && !interactive && !highCost && !mayWrite;

  // 裁决 19: identified indirect scripts carry an explicit flag (their
  // ineligibilityReason stays unchanged so discovery keeps failing closed).
  // The adoption layer treats indirectScript as manual-judgment — an
  // indirect script's side-effect boundary cannot be proven from the
  // declaration, and "no danger signals found" is never a safety proof.
  // No recursive script dependency graph or general-purpose analyzer is
  // built: the declaration itself is the only input.
  const packageManagers = new Set(['npm', 'pnpm', 'yarn']);
  const scriptInterpreters = new Set(['node', 'python', 'python3', 'bash', 'sh']);
  const indirectScript = inspectedArgv !== null && (
    // Package-manager delegation to another script.
    (packageManagers.has(executable) && (subcommand === 'run' || subcommand === 'test'))
    // Interpreter executing a project script file (relative executable or
    // non-flag argument that looks like a path).
    || (argv[0] !== undefined && (argv[0].includes('/') || argv[0].includes('.')))
    || (scriptInterpreters.has(executable) && argv.some((token, index) => (
      index > 0 && !token.startsWith('-') && (token.includes('/') || token.includes('.'))
    )))
    // Shell/code-string evaluation: opaque by construction.
    || ((executable === 'bash' || executable === 'sh') && argv.includes('-c'))
    || (executable === 'node' && argv.includes('-e'))
    || ((executable === 'python' || executable === 'python3') && argv.includes('-c'))
  );

  const eligibleForRecommendation =
    inspectedArgv !== null &&
    !networkLikely &&
    !interactive &&
    !highCost &&
    !mayWrite &&
    !consumerContextUnproven &&
    !sideEffectsUnproven;
  const ineligibilityReason = networkLikely
    ? 'NETWORK_LIKELY'
    : interactive
      ? 'INTERACTIVE'
      : highCost
        ? 'HIGH_COST'
        : mayWrite
          ? 'MAY_WRITE_FILES'
          : inspectedArgv === null
            ? 'UNPARSEABLE_COMMAND'
            : sideEffectsUnproven
              ? 'SIDE_EFFECTS_UNPROVEN'
              : consumerContextUnproven
                ? 'CONSUMER_CONTEXT_UNPROVEN'
                : null;

  return {
    id: `${unitId}-script-${name.toLowerCase().replace(/[^a-z0-9._-]+/g, '-')}`,
    script: name,
    inspectedArgv,
    command: ['npm', 'run', name],
    recommendedPhase: isSmoke ? 'consumer-verify' : 'snapshot-verify',
    scope: {
      unit: unitId,
      ...(isSmoke && distribution ? { distribution } : {}),
    },
    ...(
      isSmoke && !distribution && distributionTypes.length > 1
        ? { distributionCandidates: [...distributionTypes] }
        : {}
    ),
    cost: highCost ? 'high' : /test|smoke/.test(normalizedName) ? 'medium' : 'low',
    sideEffects: {
      mayWriteFiles: mayWrite,
      networkLikely,
      interactive,
      unsandboxed: true,
    },
    eligibleForRecommendation,
    ...(ineligibilityReason ? { ineligibilityReason } : {}),
    ...(indirectScript ? { indirectScript: true } : {}),
    reason: isSmoke
      ? '脚本名称表明它可能验证安装后的实际使用；必须人工确认后才能注册。'
      : '项目已声明质量脚本，可在冻结快照副本上复用；不会自动注册。',
  };
}

async function discoverGit(root) {
  const run = async (args) => {
    try {
      const { stdout } = await execFile('git', args, { cwd: root, shell: false, encoding: 'utf8', timeout: 5000 });
      return stdout.trim();
    } catch {
      return '';
    }
  };
  const remoteLines = (await run(['remote', '-v'])).split('\n').filter(Boolean);
  const remotes = [];
  const seen = new Set();
  for (const line of remoteLines) {
    const match = line.match(/^(\S+)\s+(\S+)\s+\((fetch|push)\)$/);
    if (!match) continue;
    const key = `${match[1]}\0${match[2]}`;
    if (seen.has(key)) continue;
    seen.add(key);
    remotes.push({ name: match[1], url: match[2], repo: parseGithubRepo(match[2]) });
  }
  remotes.sort((a, b) => canonicalJson(a).localeCompare(canonicalJson(b)));
  return {
    repository: Boolean(await run(['rev-parse', '--git-dir'])),
    branch: await run(['branch', '--show-current']) || null,
    head: await run(['rev-parse', 'HEAD']) || null,
    tags: (await run(['tag', '--list'])).split('\n').filter(Boolean).sort(),
    remotes,
    trackedFiles: (await run(['ls-files'])).split('\n').filter(Boolean).sort(),
  };
}

/**
 * Discover Git information for a release unit's source directory.
 *
 * Returns a JSON-serializable evidence object per unit including git root,
 * independence status, remotes, branch, HEAD, tags, and tracked files within
 * the unit directory. For independent sub-repos, branch/head/tags come from
 * the sub-repo; for shared-repo units they come from the parent.
 *
 * @param {string} unitAbsDir - Absolute path to the unit source directory.
 * @param {string} parentRoot - Absolute path to the parent workspace root.
 * @param {string} unitRelDir - Relative directory of the unit (for tracked files filtering).
 * @returns {Promise<object>} JSON-serializable per-unit Git evidence.
 */
async function discoverUnitGit(unitAbsDir, parentRoot) {
  const run = async (cwd, args) => {
    try {
      const { stdout } = await execFile('git', args, { cwd, shell: false, encoding: 'utf8', timeout: 5000 });
      return stdout.trim();
    } catch {
      return '';
    }
  };
  // Check if this unit's source dir has its own Git root
  const unitGitRoot = await run(unitAbsDir, ['rev-parse', '--show-toplevel']);
  if (!unitGitRoot) {
    return { gitRoot: null, ownRepo: false, ownRemotes: [], branch: null, head: null, tags: [], trackedFiles: [] };
  }

  const parentGitRoot = await run(parentRoot, ['rev-parse', '--show-toplevel']);
  const isIndependent = unitGitRoot !== parentGitRoot;

  // Run from the unit directory. Git selects the correct enclosing repo and
  // `ls-files -- .` then returns paths relative to the unit, for both nested
  // independent repositories and monorepo subdirectories.
  const branch = await run(unitAbsDir, ['branch', '--show-current']) || null;
  const head = await run(unitAbsDir, ['rev-parse', 'HEAD']) || null;
  const tags = (await run(unitAbsDir, ['tag', '--list'])).split('\n').filter(Boolean).sort();

  // Discover remotes from the effective git directory
  const remoteLines = (await run(unitAbsDir, ['remote', '-v'])).split('\n').filter(Boolean);
  const ownRemotes = [];
  const seen = new Set();
  for (const line of remoteLines) {
    const match = line.match(/^(\S+)\s+(\S+)\s+\((fetch|push)\)$/);
    if (!match) continue;
    const key = `${match[1]}\0${match[2]}`;
    if (seen.has(key)) continue;
    seen.add(key);
    ownRemotes.push({ name: match[1], url: match[2], repo: parseGithubRepo(match[2]) });
  }
  ownRemotes.sort((a, b) => canonicalJson(a).localeCompare(canonicalJson(b)));

  // Tracked files within the unit directory
  const lsOutput = await run(unitAbsDir, ['ls-files', '--', '.']);
  const trackedFiles = lsOutput ? lsOutput.split('\n').filter(Boolean).sort() : [];
  const upstream = await run(unitAbsDir, ['rev-parse', '--abbrev-ref', '@{upstream}']) || null;
  const aheadBehind = upstream
    ? (await run(unitAbsDir, ['rev-list', '--left-right', '--count', `HEAD...${upstream}`]))
      .split(/\s+/).map(Number)
    : [];

  return {
    gitRoot: safeRelative(parentRoot, unitGitRoot),
    ownRepo: isIndependent,
    ownRemotes,
    branch,
    head,
    tags,
    trackedFiles,
    remoteTracking: {
      upstream,
      ahead: Number.isFinite(aheadBehind[0]) ? aheadBehind[0] : null,
      behind: Number.isFinite(aheadBehind[1]) ? aheadBehind[1] : null,
      provenance: 'local-git-observation',
      networkFreshness: 'not-checked',
    },
  };
}

async function pathIsGitIgnored(unitAbsDir, target) {
  // --no-index also classifies generated paths that do not exist yet.
  try {
    await execFile('git', ['check-ignore', '--no-index', '--quiet', '--', target], {
      cwd: unitAbsDir,
      shell: false,
      timeout: 5000,
    });
    return true;
  } catch {
    return false;
  }
}

async function classifyNpmEntryCandidate(unitAbsDir, target, trackedFiles) {
  const tracked = trackedFiles.includes(target);
  const ignored = await pathIsGitIgnored(unitAbsDir, target);
  let stat = null;
  try {
    stat = await lstat(join(unitAbsDir, target));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const exists = stat !== null;
  const regular = stat?.isFile() === true && stat?.isSymbolicLink() !== true;
  const state = exists && !regular
    ? 'NON_REGULAR'
    : exists && tracked
      ? 'TRACKED_PRESENT'
      : exists && ignored
        ? 'IGNORED_PRESENT'
        : exists
          ? 'UNTRACKED_PRESENT'
          : ignored
            ? 'IGNORED_MISSING'
            : 'MISSING';
  return { path: target, state, exists, tracked, ignored };
}

async function discoverNpmEntryCandidates(root, pkg, matchingLegacyUnits, unitGitEntry) {
  const emptyIndex = new Map();
  const semantic = checkNpmEntryClosure(pkg.entryManifest, emptyIndex);
  const byPath = new Map();
  const add = (target, source) => {
    const current = byPath.get(target) ?? { path: target, sources: new Set() };
    current.sources.add(source);
    byPath.set(target, current);
  };
  for (const entry of semantic.entries) add(entry.target, `package.json:${entry.field}`);

  const diagnostics = [
    ...semantic.errors
      .filter((error) => error.reason !== 'entry_missing')
      .map((error) => ({ code: 'NPM_ENTRY_DECLARATION_INVALID', ...error })),
    ...semantic.diagnostics.map((diagnostic) => ({
      code: 'NPM_ENTRY_WILDCARD_REQUIRES_REVIEW',
      ...diagnostic,
    })),
  ];
  const declaredLegacyPaths = new Set();
  const legacyCoverageDeclared = matchingLegacyUnits.some((unit) => unit.npmRequiredPathsDeclared);
  for (const legacy of matchingLegacyUnits) {
    for (const target of legacy.npmRequiredPathCandidates) {
      const checked = checkNpmEntryClosure({ main: target }, emptyIndex);
      const normalized = checked.entries[0]?.target;
      if (!normalized) {
        diagnostics.push({
          code: 'LEGACY_NPM_REQUIRED_PATH_INVALID',
          path: target,
          reason: checked.errors[0]?.reason ?? 'invalid_path',
        });
        continue;
      }
      declaredLegacyPaths.add(normalized);
      add(normalized, 'public-release.json:npmRequiredPackagePaths');
    }
  }
  if (legacyCoverageDeclared) {
    for (const entry of semantic.entries) {
      if (!declaredLegacyPaths.has(entry.target)) {
        diagnostics.push({
          code: 'LEGACY_NPM_ENTRY_COVERAGE_MISSING',
          path: entry.target,
          field: entry.field,
        });
      }
    }
  }

  const unitAbsDir = resolve(root, pkg.directory);
  const candidates = [];
  for (const item of [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path))) {
    candidates.push({
      ...await classifyNpmEntryCandidate(
        unitAbsDir,
        item.path,
        unitGitEntry?.trackedFiles ?? [],
      ),
      sources: [...item.sources].sort(),
    });
  }
  diagnostics.sort((a, b) => canonicalJson(a).localeCompare(canonicalJson(b)));
  return { candidates, diagnostics };
}

async function discoverFacts(root) {
  const files = await walkDiscoveryFiles(root);
  const packageFiles = files.filter((path) => (
    basename(path) === 'package.json' &&
    !/[\\/]adapters[\\/](?:claude|codex|kimi)[\\/]package\.json$/.test(path)
  ));
  const pluginFiles = files.filter((path) => path.endsWith('/plugin.json'));
  const marketplaceFiles = files.filter((path) => path.endsWith('/marketplace.json'));
  const legacyReleaseFiles = files.filter((path) => basename(path) === 'public-release.json');
  const fileDigests = [];
  for (const path of files) {
    fileDigests.push({ path: safeRelative(root, path), ...await digestFile(path) });
  }
  fileDigests.sort((a, b) => a.path.localeCompare(b.path));
  const packages = [];
  for (const path of packageFiles) {
    const pkg = await readJsonBounded(path, 'discovered package.json');
    const relPath = safeRelative(root, path);
    const relDir = safeRelative(root, dirname(path));
    packages.push({
      path: relPath,
      directory: relDir,
      name: typeof pkg.name === 'string' ? pkg.name : null,
      version: typeof pkg.version === 'string' ? pkg.version : null,
      private: pkg.private === true,
      repository: parseGithubRepo(pkg.repository),
      publishRegistry: typeof pkg.publishConfig?.registry === 'string' ? pkg.publishConfig.registry : null,
      entryManifest: Object.fromEntries(
        ['bin', 'main', 'module', 'types', 'typings', 'exports']
          .filter((field) => Object.hasOwn(pkg, field))
          .map((field) => [field, pkg[field]]),
      ),
      files: Array.isArray(pkg.files) ? pkg.files.filter((item) => typeof item === 'string').sort() : [],
      scripts: Object.fromEntries(Object.entries(pkg.scripts ?? {})
        .filter(([, value]) => typeof value === 'string')
        .sort(([a], [b]) => a.localeCompare(b))),
    });
  }
  packages.sort((a, b) => a.path.localeCompare(b.path));

  const manifests = [];
  for (const path of [...pluginFiles, ...marketplaceFiles].sort()) {
    const value = await readJsonBounded(path, 'discovered plugin manifest');
    // Registry-driven host detection: find all platforms whose manifest path
    // suffix matches this file. Falls back to 'codex' for unknown paths
    // (preserving legacy behavior for edge cases).
    // Multi-value: Claude and CodeBuddy share .claude-plugin/marketplace.json,
    // so a single file may be claimed by multiple hosts.
    let detectedHosts = ['codex'];
    for (const [suffix, hostIds] of MANIFEST_SUFFIX_HOST_MAP) {
      if (path.endsWith(`/${suffix}`)) {
        detectedHosts = hostIds;
        break;
      }
    }
    const relPath = safeRelative(root, path);
    const kind = path.endsWith('/marketplace.json') ? 'marketplace' : 'plugin';
    const name = typeof value.name === 'string' ? value.name : null;
    const version = typeof value.version === 'string' ? value.version : null;
    for (const host of detectedHosts) {
      manifests.push({ path: relPath, host, kind, name, version });
    }
  }

  const legacyReleaseConfigs = [];
  for (const path of legacyReleaseFiles.sort()) {
    const value = await readJsonBounded(path, 'discovered public-release.json');
    legacyReleaseConfigs.push(summarizeLegacyReleaseConfig(value, safeRelative(root, path)));
  }

  const git = await discoverGit(root);
  const skills = files
    .filter((path) => basename(path) === 'SKILL.md')
    .map((path) => {
      const relPath = safeRelative(root, path);
      const segments = relPath.split('/');
      const skillIndex = segments.lastIndexOf('skills');
      return {
        path: relPath,
        name: skillIndex >= 0 ? segments[skillIndex + 1] ?? null : null,
        host: relPath.includes('/adapters/claude/') ? 'claude'
          : relPath.includes('/adapters/codex/') ? 'codex'
            : relPath.includes('/adapters/kimi/') ? 'kimi'
              : relPath.includes('/adapters/workbuddy/') ? 'codebuddy'
                : 'shared',
      };
    })
    .filter((item) => item.name)
    .sort((a, b) => canonicalJson(a).localeCompare(canonicalJson(b)));

  // Per-unit Git discovery: detect independent sub-repos for each package
  const unitGit = {};
  for (const pkg of packages) {
    const unitAbsDir = resolve(root, pkg.directory);
    unitGit[pkg.directory] = await discoverUnitGit(unitAbsDir, root);
    const inferredId = safeUnitId(pkg, pkg.directory);
    const matchingLegacyUnits = legacyReleaseConfigs
      .flatMap((config) => config.releaseUnits)
      .filter((unit) => (
        unit.id === inferredId ||
        unit.source === pkg.directory ||
        unit.source === dirname(pkg.path)
      ));
    const npmDiscovery = await discoverNpmEntryCandidates(
      root,
      pkg,
      matchingLegacyUnits,
      unitGit[pkg.directory],
    );
    pkg.npmEntryCandidates = npmDiscovery.candidates;
    pkg.npmEntryDiagnostics = npmDiscovery.diagnostics;
  }

  return { git, packages, manifests, skills, legacyReleaseConfigs, fileDigests, unitGit };
}

/**
 * Build publicFileMappingCandidates for a unit, merging from all sources.
 *
 * Each mapping is { from, to, mode: 'preserve', sources: string[] }.
 * When multiple sources map to the same `to`, all sources are merged into a
 * single entry. If two different `from` paths map to the same `to`, that
 * is a conflict and must be reported.
 */
function packagePatternMatches(pattern, relativePath) {
  const normalized = pattern.replace(/^\.\//, '').replace(/\/$/, '');
  if (!normalized) return false;
  if (!/[?*]/.test(normalized)) {
    return relativePath === normalized || relativePath.startsWith(`${normalized}/`);
  }
  const escaped = normalized.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  const regexSource = escaped
    .replace(/\*\*/g, '\u0000')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]')
    .replace(/\u0000/g, '.*');
  return new RegExp(`^${regexSource}(?:/.*)?$`).test(relativePath);
}

function buildPublicFileMappingCandidates(pkg, matchingLegacyUnits, manifestOwners, facts, knownFiles) {
  const unitDir = pkg.directory;
  const prefix = unitDir === '.' ? '' : `${unitDir}/`;
  const toFromMap = new Map();
  const unitTrackedFiles = facts.unitGit?.[unitDir]?.trackedFiles ?? [];
  const availableFiles = new Set([
    ...knownFiles,
    ...(facts.git.trackedFiles ?? []),
    ...unitTrackedFiles.map((path) => `${prefix}${path}`),
  ]);

  function addMapping(from, to, source, priority = 1) {
    if (!availableFiles.has(from)) return;
    const existing = toFromMap.get(to);
    if (existing) {
      if (existing.from === from) {
        existing.sources.add(source);
      } else if (priority > existing.priority) {
        toFromMap.set(to, {
          from,
          priority,
          sources: new Set([source, ...existing.sources]),
        });
      } else if (priority === existing.priority) {
        existing.conflictingFrom = from;
        existing.sources.add(source);
      } else {
        existing.sources.add(`${source}:superseded`);
      }
    } else {
      toFromMap.set(to, { from, priority, sources: new Set([source]) });
    }
  }

  // Explicit legacy sources are authoritative over generic package inference.
  for (const config of facts.legacyReleaseConfigs) {
    for (const shared of config.sharedFileCandidates) {
      addMapping(shared.source, shared.target, 'legacy-shared-file', 3);
    }
  }
  for (const legacy of matchingLegacyUnits) {
    if (legacy.docsSource) {
      const config = facts.legacyReleaseConfigs.find((item) => item.releaseUnits.includes(legacy));
      for (const name of config?.docFileCandidates ?? []) {
        addMapping(`${legacy.docsSource}/${name}`, name, 'legacy-doc-source', 3);
      }
    }
  }

  addMapping(pkg.path, 'package.json', 'package-manifest', 2);

  const STANDARD_NAMES = [
    'README.md', 'README.zh-CN.md', 'LICENSE', 'NOTICE', 'CHANGELOG.md',
    'INSTALL.md', 'CONTRIBUTING.md', 'CODE_OF_CONDUCT.md', 'SECURITY.md',
  ];
  for (const name of STANDARD_NAMES) {
    addMapping(`${prefix}${name}`, name, 'standard-human-file', 1);
  }

  for (const manifest of facts.manifests) {
    if (manifestOwners.get(manifest.path) === pkg.path) {
      const to = manifest.path.startsWith(prefix) ? manifest.path.slice(prefix.length) : manifest.path;
      addMapping(manifest.path, to, 'plugin-manifest', 2);
    }
  }

  for (const legacy of matchingLegacyUnits) {
    for (const reqPath of legacy.requiredPathCandidates) {
      addMapping(`${prefix}${reqPath}`, reqPath, 'legacy-required-path', 2);
    }
  }

  for (const pattern of pkg.files) {
    for (const tracked of unitTrackedFiles) {
      if (packagePatternMatches(pattern, tracked)) {
        addMapping(`${prefix}${tracked}`, tracked, 'package-files', 1);
      }
    }
  }

  const mappings = [];
  const conflicts = [];
  for (const [to, entry] of toFromMap) {
    if (entry.conflictingFrom) {
      conflicts.push({
        to,
        from: entry.from,
        conflictingFrom: entry.conflictingFrom,
        sources: [...entry.sources].sort(),
      });
    } else {
      mappings.push({
        from: entry.from,
        to,
        mode: 'preserve',
        sourceScope: unitDir === '.' || entry.from.startsWith(prefix) ? 'unit' : 'workspace',
        sources: [...entry.sources].sort(),
      });
    }
  }
  mappings.sort((a, b) => a.to.localeCompare(b.to));
  conflicts.sort((a, b) => a.to.localeCompare(b.to));
  return { mappings, conflicts };
}

function entrySkillCandidatesForUnit(facts, pkg, id) {
  const prefix = pkg.directory === '.' ? '' : `${pkg.directory}/`;
  const names = [...new Set((facts.skills ?? [])
    .filter((skill) => skill.path.startsWith(prefix))
    .map((skill) => skill.name))];
  const priority = (name) => {
    if (/(?:^|-)help$/.test(name)) return 0;
    if (/(?:^|-)initial$/.test(name)) return 1;
    if (/(?:^|-)setup$/.test(name)) return 2;
    if (name === id) return 3;
    return 4;
  };
  return names.sort((a, b) => priority(a) - priority(b) || a.localeCompare(b));
}

function buildCandidates(facts) {
  const gitRepos = facts.git.remotes.map((remote) => remote.repo).filter(Boolean);
  const uniqueGitRepos = [...new Set(gitRepos)];
  const unitGit = facts.unitGit ?? {};
  const units = [];
  const gates = [];
  const ids = new Set();
  const knownFiles = new Set(facts.fileDigests.map((file) => file.path));
  // Extract manifest root from path using registry-driven suffix matching.
  // This handles all platform paths including Codex's .agents/plugins/marketplace.json,
  // not just the hardcoded .{platform}-plugin/ pattern.
  const manifestRoots = facts.manifests.map((manifest) => {
    let root = '.';
    for (const suffix of MANIFEST_SUFFIX_HOST_MAP.keys()) {
      const fullSuffix = `/${suffix}`;
      const idx = manifest.path.lastIndexOf(fullSuffix);
      if (idx >= 0) {
        root = manifest.path.slice(0, idx) || '.';
        break;
      }
    }
    return { ...manifest, root };
  });
  const manifestOwners = new Map();
  const legacyUnits = facts.legacyReleaseConfigs.flatMap((config) => config.releaseUnits);
  const legacyDefaultBranches = [...new Set(facts.legacyReleaseConfigs
    .map((config) => config.defaultBranch)
    .filter(Boolean))];
  for (const manifest of manifestRoots) {
    const owners = facts.packages
      .filter((pkg) => pkg.directory === '.' || manifest.root === pkg.directory || manifest.root.startsWith(`${pkg.directory}/`))
      .sort((a, b) => b.directory.length - a.directory.length);
    if (owners[0]) manifestOwners.set(manifest.path, owners[0].path);
  }

  for (const pkg of facts.packages) {
    const sourceMatchedLegacyUnits = legacyUnits.filter((unit) => unit.source === pkg.directory);
    const preferredLegacyId = sourceMatchedLegacyUnits.map((unit) => unit.id).find(Boolean);
    let id = preferredLegacyId ?? safeUnitId(pkg, pkg.directory);
    let suffix = 2;
    while (ids.has(id)) id = `${safeUnitId(pkg, pkg.directory)}-${suffix++}`;
    ids.add(id);
    const matchingLegacyUnits = legacyUnits.filter((unit) => (
      unit.id === id || unit.source === pkg.directory || unit.source === dirname(pkg.path)
    ));
    const pluginHosts = facts.manifests
      .filter((manifest) => manifestOwners.get(manifest.path) === pkg.path)
      .filter((manifest) => manifest.kind === 'plugin')
      .map((manifest) => manifest.host);
    const distributions = [];
    const legacyChannelsAreAuthoritative = matchingLegacyUnits.length > 0;
    const npmExplicitlyDeclared = matchingLegacyUnits.some((unit) => (
      unit.npmPackageDeclared && unit.npmPackage !== null
    ));
    const npmExplicitlyForbidden = matchingLegacyUnits.some((unit) => (
      unit.npmPackageDeclared && unit.npmPackage === null
    ));
    // npm channel rule: only suppress npm when the legacy config explicitly
    // sets npmPackage: null. Field absence must not override package.json
    // metadata that proves the package is publishable.
    if (
      !pkg.private &&
      pkg.name &&
      !npmExplicitlyForbidden
    ) distributions.push('npm');
    if (pluginHosts.includes('claude')) distributions.push('claude-plugin');
    if (pluginHosts.includes('codex')) distributions.push('codex-plugin');
    if (pluginHosts.includes('kimi')) distributions.push('kimi-plugin');
    if (pluginHosts.includes('codebuddy')) distributions.push('codebuddy-plugin');
    if (pkg.private && matchingLegacyUnits.length === 0 && facts.legacyReleaseConfigs.length > 0) continue;
    if (pkg.private && distributions.length === 0) continue;

    // Per-unit Git: if this unit's source directory is inside a separate Git
    // repo, use that repo's remotes instead of the parent workspace remotes.
    const unitGitEntry = unitGit[pkg.directory];
    // The root package's Git remote is unit-level evidence even though its Git
    // root is also the workspace root. Nested shared-repo packages still use
    // the parent remote only as a fallback.
    const unitOwnRemotes = ((pkg.directory === '.' || unitGitEntry?.ownRepo)
      ? unitGitEntry?.ownRemotes ?? []
      : [])
      .map((r) => r.repo)
      .filter(Boolean);
    // Authority-priority collapsing: package.json repository and legacy
    // publicRepo are authoritative. Parent workspace remotes are only a
    // fallback when no unit-level repo evidence exists.
    const legacyRepos = matchingLegacyUnits.map((unit) => unit.publicRepo).filter(Boolean);
    const packageRepos = pkg.repository ? [pkg.repository] : [];
    // Collect all non-fallback authority sources for conflict detection.
    // Each source is { source: string, repos: string[] }.
    const authoritySources = [];
    if (legacyRepos.length > 0) authoritySources.push({ source: 'legacy-publicRepo', repos: [...new Set(legacyRepos)] });
    if (packageRepos.length > 0) authoritySources.push({ source: 'package.json-repository', repos: [...new Set(packageRepos)] });
    if (unitOwnRemotes.length > 0) authoritySources.push({ source: 'git-remote', repos: [...new Set(unitOwnRemotes)] });
    const unitLevelRepos = legacyRepos.length > 0
      ? legacyRepos
      : packageRepos.length > 0
        ? packageRepos
        : unitOwnRemotes;
    const hasUnitLevelRepo = unitLevelRepos.length > 0;
    // Only include parent workspace Git repos when the unit has no repo
    // candidates from package.json, legacy config, or independent remotes.
    const fallbackGitRepos = hasUnitLevelRepo ? [] : uniqueGitRepos;
    // Detect authority conflict: when two or more non-fallback sources
    // give different repos, all unique candidates are preserved and a
    // PUBLIC_REPO_AUTHORITY_CONFLICT is recorded.
    const allAuthorityRepos = [...new Set(authoritySources.flatMap((s) => s.repos))];
    const hasAuthorityConflict = authoritySources.length >= 2 && allAuthorityRepos.length >= 2;
    const repositoryCandidates = [...new Set([
      ...allAuthorityRepos,
      ...fallbackGitRepos,
    ].filter(Boolean))];
    const legacyTagTemplates = matchingLegacyUnits
      .map((unit) => unit.tagPrefix ? `${unit.tagPrefix}{version}` : null)
      .filter(Boolean);
    const branchCandidates = [...new Set([
      ...legacyDefaultBranches,
      unitGitEntry?.branch,
    ].filter(Boolean))];
    const unitTags = unitGitEntry?.tags ?? [];
    const mappingResult = buildPublicFileMappingCandidates(
      pkg, matchingLegacyUnits, manifestOwners, facts, knownFiles,
    );
    const requiredPublicFileCandidates = [...new Set([
      ...matchingLegacyUnits.flatMap((unit) => unit.requiredPathCandidates),
      ...mappingResult.mappings
        .map((mapping) => mapping.to)
        .filter((path) => /^(?:package\.json|README(?:\.|$)|LICENSE(?:\.|$))/i.test(path)),
    ])].filter((path) => mappingResult.mappings.some((mapping) => mapping.to === path)).sort();
    units.push({
      id,
      source: pkg.directory,
      packagePath: pkg.path,
      version: pkg.version,
      publicRepoCandidates: repositoryCandidates,
      distributionCandidates: distributions,
      tagTemplateCandidates: [...new Set([
        ...legacyTagTemplates,
        ...(unitTags.some((tag) => pkg.version && tag === `v${pkg.version}`) ? ['v{version}'] : []),
        ...(unitTags.some((tag) => pkg.version && tag === `${id}-v${pkg.version}`)
          ? [`${id}-v{version}`]
          : []),
      ])],
      branchCandidates,
      branchStrategyCandidates: repositoryCandidates.length > 0
        ? ['advance-existing-branch', 'create-release-branch', 'initialize-default-branch']
        : [],
      previousPublicBaselineStatus: repositoryCandidates.length === 0
        ? 'CHANNEL_MISSING'
        : unitTags.length > 0
          ? 'BOUND_REQUIRES_ONLINE_OBSERVATION'
          : 'FIRST_RELEASE_OR_BOUND_REQUIRES_HUMAN_DECISION',
      publicFileCandidates: [
        pkg.path,
        pkg.directory === '.' ? 'README.md' : `${pkg.directory}/README.md`,
        pkg.directory === '.' ? 'README.zh-CN.md' : `${pkg.directory}/README.zh-CN.md`,
        pkg.directory === '.' ? 'LICENSE' : `${pkg.directory}/LICENSE`,
        ...facts.manifests
          .filter((manifest) => manifestOwners.get(manifest.path) === pkg.path)
          .map((manifest) => manifest.path),
      ].filter((value, index, array) => array.indexOf(value) === index && knownFiles.has(value)).sort(),
      legacyPublicFileHints: matchingLegacyUnits.flatMap((unit) => unit.requiredPathCandidates).sort(),
      packageFilePatternCandidates: [...pkg.files],
      publicFileMappingCandidates: mappingResult.mappings,
      publicFileMappingConflicts: mappingResult.conflicts,
      requiredPublicFileCandidates,
      npmEntryCandidates: pkg.npmEntryCandidates ?? [],
      npmEntryDiagnostics: pkg.npmEntryDiagnostics ?? [],
      entrySkillCandidates: entrySkillCandidatesForUnit(facts, pkg, id),
      ...(hasAuthorityConflict ? {
        authorityConflict: {
          code: 'PUBLIC_REPO_AUTHORITY_CONFLICT',
          unit: id,
          evidence: authoritySources.map((s) => ({ source: s.source, repos: s.repos.sort() }))
            .sort((a, b) => a.source.localeCompare(b.source)),
        },
      } : {}),
    });
    for (const [script, command] of Object.entries(pkg.scripts)) {
      if (/^(docs|build|test|typecheck|lint|check|validate|verify|smoke)(?:$|[:_-])/.test(script)) {
        gates.push(classifyScript(script, command, id, distributions));
      }
    }
    for (const legacy of matchingLegacyUnits) {
      legacy.snapshotCommands.forEach((rawCommand, index) => {
        const command = normalizeLegacyCommand(rawCommand);
        gates.push({
          id: `${id}-legacy-snapshot-${index + 1}`,
          source: 'public-release.json snapshotCommands',
          command,
          recommendedPhase: 'snapshot-verify',
          scope: { unit: id },
          cost: 'medium',
          sideEffects: { mayWriteFiles: true, networkLikely: false, unsandboxed: true },
          requiresManualCommandArray: !command,
          // Legacy snapshot commands are never auto-recommended: their
          // side-effect profile has not been independently verified.
          eligibleForRecommendation: false,
          ineligibilityReason: command === null ? 'UNPARSEABLE_COMMAND' : 'SIDE_EFFECTS_UNPROVEN',
          reason: '旧发布配置声明了快照校验；迁移为 gate 前必须人工确认命令数组、副作用和耗时。',
        });
      });
    }
  }

  // A skill/plugin repository may intentionally have no package.json. Keep
  // it discoverable as a plugin-only candidate instead of inventing npm.
  const unownedPluginRoots = [...new Set(manifestRoots
    .filter((manifest) => manifest.kind === 'plugin' && !manifestOwners.has(manifest.path))
    .map((manifest) => manifest.root))];
  for (const pluginRoot of unownedPluginRoots.sort()) {
    const rootManifests = manifestRoots.filter((manifest) => manifest.root === pluginRoot && manifest.kind === 'plugin');
    const name = rootManifests.map((manifest) => manifest.name).find(Boolean) || basename(pluginRoot);
    const baseId = String(name).toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'plugin';
    let id = baseId;
    let suffix = 2;
    while (ids.has(id)) id = `${baseId}-${suffix++}`;
    ids.add(id);
    const publicFileCandidates = [...knownFiles]
      .filter((path) => pluginRoot === '.' || path.startsWith(`${pluginRoot}/`))
      .filter((path) => /(?:README|LICENSE|CHANGELOG|plugin\.json|marketplace\.json)/i.test(path))
      .sort();
    const pluginPrefix = pluginRoot === '.' ? '' : `${pluginRoot}/`;
    units.push({
      id,
      source: pluginRoot,
      packagePath: null,
      version: rootManifests.map((manifest) => manifest.version).find(Boolean) ?? null,
      publicRepoCandidates: [...uniqueGitRepos],
      distributionCandidates: [...new Set(rootManifests.map((manifest) => `${manifest.host}-plugin`))].sort(),
      tagTemplateCandidates: [],
      branchCandidates: [...new Set([...legacyDefaultBranches, facts.git.branch].filter(Boolean))],
      branchStrategyCandidates: uniqueGitRepos.length > 0
        ? ['advance-existing-branch', 'create-release-branch', 'initialize-default-branch']
        : [],
      previousPublicBaselineStatus: uniqueGitRepos.length > 0
        ? (facts.git.tags.length > 0
          ? 'BOUND_REQUIRES_ONLINE_OBSERVATION'
          : 'FIRST_RELEASE_OR_BOUND_REQUIRES_HUMAN_DECISION')
        : 'CHANNEL_MISSING',
      publicFileCandidates,
      publicFileMappingCandidates: publicFileCandidates.map((path) => ({
        from: path,
        to: path.startsWith(pluginPrefix) ? path.slice(pluginPrefix.length) : path,
        mode: 'preserve',
        sources: ['plugin-only-discovery'],
      })),
      publicFileMappingConflicts: [],
      requiredPublicFileCandidates: publicFileCandidates
        .map((path) => path.startsWith(pluginPrefix) ? path.slice(pluginPrefix.length) : path)
        .filter((path) => /^(?:README(?:\.|$)|LICENSE(?:\.|$))/i.test(path)),
      entrySkillCandidates: [...new Set((facts.skills ?? [])
        .filter((skill) => skill.path.startsWith(pluginPrefix))
        .map((skill) => skill.name))].sort(),
    });
  }
  units.sort((a, b) => a.id.localeCompare(b.id));
  gates.sort((a, b) => a.id.localeCompare(b.id));
  return { units, gates };
}

/**
 * Build a complete recommendedAnswers from candidates, or null when
 * conflicts prevent safe automatic recommendation.
 *
 * The recommendedAnswers is explicitly a proposal pending human confirmation.
 * It only includes gates with eligibleForRecommendation=true.
 */
function buildRecommendedProposal(facts, candidates) {
  const assumptions = [];
  const legacyOwner = facts.legacyReleaseConfigs
    .map((c) => c.owner)
    .find(Boolean);
  const sourceRepositoryCandidates = [...new Set(
    facts.git.remotes.map((remote) => remote.repo).filter(Boolean),
  )].sort();
  if (sourceRepositoryCandidates.length !== 1) {
    return {
      answers: null,
      conflicts: [{
        code: sourceRepositoryCandidates.length === 0
          ? 'SOURCE_REPOSITORY_MISSING'
          : 'SOURCE_REPOSITORY_AMBIGUOUS',
        candidates: sourceRepositoryCandidates,
      }],
      assumptions,
    };
  }

  const units = [];
  for (const unit of candidates.units) {
    // Authority conflict: multiple non-fallback sources disagree on repo
    if (unit.authorityConflict) {
      return {
        answers: null,
        conflicts: [unit.authorityConflict],
        assumptions,
      };
    }
    // Require exactly one public repo candidate for auto-recommendation
    if (unit.publicRepoCandidates.length !== 1) {
      return {
        answers: null,
        conflicts: [{ code: 'PUBLIC_REPO_AMBIGUOUS', unit: unit.id, candidates: unit.publicRepoCandidates }],
        assumptions,
      };
    }
    const publicRepo = unit.publicRepoCandidates[0];

    // Mapping conflicts prevent auto-recommendation
    if ((unit.publicFileMappingConflicts ?? []).length > 0) {
      return {
        answers: null,
        conflicts: [{ code: 'PUBLIC_FILE_MAPPING_CONFLICT', unit: unit.id, conflicts: unit.publicFileMappingConflicts }],
        assumptions,
      };
    }
    if ((unit.publicFileMappingCandidates ?? []).length === 0) {
      return {
        answers: null,
        conflicts: [{ code: 'PUBLIC_FILE_BOUNDARY_EMPTY', unit: unit.id }],
        assumptions,
      };
    }
    if (
      unit.distributionCandidates.includes('npm') &&
      (
        (unit.npmEntryCandidates ?? []).some((candidate) => candidate.state !== 'TRACKED_PRESENT') ||
        (unit.npmEntryDiagnostics ?? []).length > 0
      )
    ) {
      return {
        answers: null,
        conflicts: [{
          code: 'NPM_ENTRY_REVIEW_REQUIRED',
          unit: unit.id,
          candidates: unit.npmEntryCandidates,
          diagnostics: unit.npmEntryDiagnostics,
        }],
        assumptions,
      };
    }

    // Infer npm publisher: prefer legacy owner, then parse from repo slug
    const repoOwner = publicRepo.includes('/') ? publicRepo.split('/')[0] : null;
    const npmPublisher = legacyOwner ?? repoOwner ?? null;
    const pkg = facts.packages.find((item) => item.directory === unit.source);
    if (unit.distributionCandidates.includes('npm') && (!pkg?.name || !npmPublisher)) {
      return {
        answers: null,
        conflicts: [{ code: 'NPM_IDENTITY_INCOMPLETE', unit: unit.id }],
        assumptions,
      };
    }
    if (
      unit.distributionCandidates.some((type) => type.endsWith('-plugin')) &&
      !unit.entrySkillCandidates?.[0]
    ) {
      return {
        answers: null,
        conflicts: [{ code: 'PLUGIN_ENTRY_SKILL_MISSING', unit: unit.id }],
        assumptions,
      };
    }

    // Discover marketplace index candidates for this unit's plugin hosts.
    //
    // 单一权威来源：平台注册表的 manifestPaths.marketplace 是默认索引路径；
    // publicFileMappingCandidates 是该 unit 唯一可发现的公开文件 to 路径集。
    // 按"等于默认索引路径或以 /<默认索引路径> 精确结尾"筛选候选。
    // 1 个候选：根布局省略显式路径，嵌套布局写 marketplaceIndexPath；
    // 0 个候选：产生 MARKETPLACE_ASSET_MISSING；
    // 多个候选：产生 MARKETPLACE_ASSET_AMBIGUOUS。
    // Kimi 默认路径为 null，不要求候选；CodeBuddy 复用 Claude 市场索引。
    const unitPrefix = unit.source === '.' ? '' : `${unit.source}/`;
    const marketplaceConflicts = [];
    const distributions = unit.distributionCandidates.map((type) => {
      if (type === 'npm') {
        return {
          type: 'npm',
          package: pkg.name,
          registry: pkg.publishRegistry ?? 'https://registry.npmjs.org',
          ...(npmPublisher ? { publisher: npmPublisher } : {}),
        };
      }
      const entrySkill = unit.entrySkillCandidates?.[0];
      const host = type.replace(/-plugin$/, '');
      const platform = getPlatform(host);
      const defaultMktPath = platform.manifestPaths.marketplace;
      const dist = {
        type,
        plugin: unit.id,
        marketplace: unit.id,
        entrySkill,
        marketplaceSourceType: 'bundled-family',
      };
      // Kimi 的 manifestPaths.marketplace 为 null，不要求候选
      if (defaultMktPath !== null) {
        const mappingCandidates = unit.publicFileMappingCandidates ?? [];
        const suffix = `/${defaultMktPath}`;
        const candidates = mappingCandidates.filter((m) => (
          m.to === defaultMktPath || m.to.endsWith(suffix)
        ));
        if (candidates.length === 0) {
          marketplaceConflicts.push({
            code: 'MARKETPLACE_ASSET_MISSING',
            unit: unit.id,
            platform: host,
            expectedSuffix: defaultMktPath,
          });
          return null;
        }
        if (candidates.length > 1) {
          marketplaceConflicts.push({
            code: 'MARKETPLACE_ASSET_AMBIGUOUS',
            unit: unit.id,
            platform: host,
            candidates: candidates.map((m) => m.to).sort(),
          });
          return null;
        }
        // 1 个候选
        const candidateTo = candidates[0].to;
        if (candidateTo === defaultMktPath) {
          // 根布局：marketplace index 在平台默认路径，省略显式 marketplaceIndexPath
        } else {
          // 嵌套布局：candidateTo 以 /<defaultMktPath> 精确结尾。
          // 市场文件仍在同一发布快照内，属于 bundled-family 来源；
          // marketplaceIndexPath 标记索引在快照内的相对位置。
          // 不得伪造 marketplaceRepo（那是 standalone-index 独有字段）。
          dist.marketplaceIndexPath = candidateTo;
        }
      }
      return dist;
    }).filter(Boolean);

    // Marketplace asset conflicts: missing or ambiguous marketplace index
    if (marketplaceConflicts.length > 0) {
      return {
        answers: null,
        conflicts: marketplaceConflicts,
        assumptions,
      };
    }

    // If any distribution failed to construct, bail
    if (distributions.length !== unit.distributionCandidates.length) return null;

    const tagTemplate = unit.tagTemplateCandidates[0] ?? 'v{version}';
    const versionSource = unit.packagePath?.startsWith(unitPrefix)
      ? unit.packagePath.slice(unitPrefix.length)
      : unit.packagePath;

    units.push({
      id: unit.id,
      source: unit.source,
      publicRepo,
      version: { source: versionSource, tagTemplate },
      distributions,
      publicFiles: unit.publicFileMappingCandidates.map((m) => ({
        from: m.from,
        to: m.to,
        mode: m.mode,
        ...(m.sourceScope === 'workspace' ? { sourceScope: 'workspace' } : {}),
      })),
      requiredPublicFiles: unit.requiredPublicFileCandidates ?? [],
      previousPublicBaseline: { mode: 'none' },
    });
    assumptions.push({
      code: 'PREVIOUS_PUBLIC_BASELINE_REQUIRES_CONFIRMATION',
      unit: unit.id,
      proposedMode: 'none',
      observedStatus: unit.previousPublicBaselineStatus,
    });
  }

  const selectedGateIds = candidates.gates
    .filter((gate) => gate.eligibleForRecommendation)
    .map((gate) => gate.id);

  const projectConfig = {
    apiVersion: 'release-skill/v1',
    kind: 'ReleaseProject',
    project: {
      name: facts.packages[0]?.name ?? 'project',
      defaultBranch: facts.legacyReleaseConfigs[0]?.defaultBranch ?? facts.git.branch ?? 'main',
      sourceRepository: sourceRepositoryCandidates[0],
    },
    releaseUnits: units,
    ...(selectedGateIds.length > 0 ? {
      verificationGates: candidates.gates
        .filter((gate) => gate.eligibleForRecommendation)
        .map((gate) => ({
          id: gate.id,
          phase: gate.recommendedPhase,
          scope: gate.scope,
          command: gate.command,
          cwd: candidates.units.find((unit) => unit.id === gate.scope.unit)?.source ?? '.',
          timeoutMs: gate.cost === 'medium' ? 600_000 : 120_000,
          envAllowlist: [],
        })),
    } : {}),
  };

  const forbiddenPaths = [...new Set(facts.legacyReleaseConfigs
    .flatMap((config) => config.forbiddenPathCandidates))].sort();
  const forbiddenContentPatterns = [...new Set(facts.legacyReleaseConfigs
    .flatMap((config) => config.forbiddenContentPatternCandidates))].sort();
  if (forbiddenPaths.length > 0 || forbiddenContentPatterns.length > 0) {
    projectConfig.policy = { forbiddenPaths, forbiddenContentPatterns };
  }
  if (!validateProjectConfig(projectConfig)) {
    return {
      answers: null,
      conflicts: [{
        code: 'RECOMMENDED_CONFIG_SCHEMA_INVALID',
        validationErrors: (validateProjectConfig.errors ?? []).map((error) => ({
          instancePath: error.instancePath,
          keyword: error.keyword,
          message: error.message,
        })),
      }],
      assumptions,
    };
  }

  return {
    answers: { projectConfig, selectedGateIds },
    conflicts: [],
    assumptions,
  };
}

function buildDecisionsRequired(candidates, localOnly) {
  const decisions = [];
  if (localOnly) {
    decisions.push({
      id: 'remote-channel',
      description: '未发现 GitHub/npm 远端渠道；决定建立真实渠道，或保持 local-only 并暂停生产发布配置。',
    });
  }
  for (const unit of candidates.units) {
    decisions.push({
      id: `unit:${unit.id}:public-repo`,
      description: unit.publicRepoCandidates.length === 1
        ? `确认公开仓候选 ${unit.publicRepoCandidates[0]}，不得因唯一候选而跳过人工确认。`
        : `从 ${JSON.stringify(unit.publicRepoCandidates)} 中选择公开仓；空列表表示必须先建立渠道。`,
    });
    decisions.push({
      id: `unit:${unit.id}:tag-and-branch`,
      description: `确认 tag 模板、目标分支和 branchStrategy；候选 tag=${JSON.stringify(unit.tagTemplateCandidates)}，branch=${JSON.stringify(unit.branchCandidates)}。`,
    });
    decisions.push({
      id: `unit:${unit.id}:previous-public-baseline`,
      description: `当前状态 ${unit.previousPublicBaselineStatus}；已有公开版本必须在线绑定精确 repo/ref/commit，只有确认不存在前序版本才使用 mode=none。`,
    });
    decisions.push({
      id: `unit:${unit.id}:distributions-and-files`,
      description: `逐项确认渠道 ${JSON.stringify(unit.distributionCandidates)}、公开文件边界和 requiredPublicFiles；候选不是授权。`,
    });
    if (
      (unit.npmEntryCandidates ?? []).length > 0 ||
      (unit.npmEntryDiagnostics ?? []).length > 0
    ) {
      decisions.push({
        id: `unit:${unit.id}:npm-entry-closure`,
        description: '审阅 package.json 入口及旧 npmRequiredPackagePaths 的 tracked/untracked/ignored/missing 状态；setup 只报告候选，不自动写入 publicFiles 或 requiredPublicFiles。',
      });
    }
  }
  decisions.push({
    id: 'verification-gates',
    description: '逐项选择要注册的 gate；发现脚本不等于授权，未选择时必须显式使用 selectedGateIds: []。',
  });
  return decisions;
}

/**
 * Build a deterministic compact summary from the final report.
 *
 * Only includes fields needed for human review. Does not repeat
 * facts.fileDigests, full mapping arrays, or full answers.
 */
function buildCompactSummary(report) {
  return {
    status: report.status,
    setupDigest: report.setupDigest ?? null,
    releaseUnitCandidates: (report.releaseUnitCandidates ?? []).map((unit) => ({
      id: unit.id,
      source: unit.source,
      publicRepoCandidates: [...unit.publicRepoCandidates].sort(),
      branchCandidates: [...unit.branchCandidates].sort(),
      distributionCandidates: [...unit.distributionCandidates].sort(),
      publicFileMappingCount: (unit.publicFileMappingCandidates ?? []).length,
      requiredPublicFileCount: (unit.requiredPublicFileCandidates ?? []).length,
      npmEntryCandidates: unit.npmEntryCandidates ?? [],
      npmEntryDiagnostics: unit.npmEntryDiagnostics ?? [],
    })),
    gateCandidates: (report.gateCandidates ?? []).map((gate) => ({
      id: gate.id,
      script: gate.script ?? null,
      command: gate.command ?? null,
      eligibleForRecommendation: gate.eligibleForRecommendation,
      ineligibilityReason: gate.ineligibilityReason ?? null,
      sideEffects: gate.sideEffects ?? null,
    })),
    recommendedGateIds: [...(report.recommendedGateIds ?? [])].sort(),
    proposalConflicts: report.proposalConflicts ?? [],
    proposalAssumptions: report.proposalAssumptions ?? [],
    productionReadiness: report.productionReadiness ?? null,
    ...(report.audit ? {
      audit: {
        configuredUnitIds: [...(report.audit.configuredUnitIds ?? [])].sort(),
        discoveredUnitIds: [...(report.audit.discoveredUnitIds ?? [])].sort(),
        configuredGateIds: [...(report.audit.configuredGateIds ?? [])].sort(),
        unconfiguredGateCandidateIds: [...(report.audit.unconfiguredGateCandidateIds ?? [])].sort(),
        ...(report.audit.parseError ? { parseError: report.audit.parseError } : {}),
        validationErrorCount: (report.audit.validationErrors ?? []).length,
      },
    } : {}),
  };
}

function validateAnswers(answers, gateCandidates) {
  if (!answers || typeof answers !== 'object' || Array.isArray(answers)) {
    throw setupError(CONFIG_INVALID, 'setup answers must be a JSON object');
  }
  if (!answers.projectConfig || typeof answers.projectConfig !== 'object') {
    throw setupError(CONFIG_INVALID, 'setup answers must contain projectConfig');
  }
  if (!Array.isArray(answers.selectedGateIds)) {
    throw setupError(CONFIG_INVALID, 'setup answers must contain selectedGateIds array (use [] to select none)');
  }
  const selected = new Set(answers.selectedGateIds);
  if (selected.size !== answers.selectedGateIds.length) {
    throw setupError(CONFIG_INVALID, 'selectedGateIds must be unique');
  }
  const candidateIds = new Set(gateCandidates.map((gate) => gate.id));
  for (const id of selected) {
    if (!candidateIds.has(id)) throw setupError(CONFIG_INVALID, `selectedGateIds contains unknown candidate "${id}"`);
  }
  const configuredIds = (answers.projectConfig.verificationGates ?? []).map((gate) => gate.id).sort();
  if (JSON.stringify([...selected].sort()) !== JSON.stringify(configuredIds)) {
    throw setupError(
      CONFIG_INVALID,
      'selectedGateIds must exactly match projectConfig.verificationGates[].id',
      { selectedGateIds: [...selected].sort(), configuredGateIds: configuredIds },
    );
  }
  if (!validateProjectConfig(answers.projectConfig)) {
    const errors = validateProjectConfig.errors ?? [];
    throw setupError(
      CONFIG_INVALID,
      `projectConfig in setup answers is invalid: ${errors.map((error) => `${error.instancePath || '/'} ${error.message}`).join('; ')}`,
      { validationErrors: errors },
    );
  }
}

function directoryIdentity(entry, label) {
  if (
    !entry || entry.type !== 'directory' ||
    !Number.isInteger(entry.dev) || !Number.isInteger(entry.ino)
  ) {
    throw setupError(CONFIG_INVALID, `${label} must be an identity-bound real directory`);
  }
  return { dev: entry.dev, ino: entry.ino };
}

function sameDirectoryIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

async function openBoundConfigDirectory(root, safeFs) {
  const rootHandle = await safeFs.openRoot(root);
  let releaseHandle;
  try {
    const rootIdentity = directoryIdentity(await rootHandle.readEntry('.'), 'project root');
    let releaseEntry = await rootHandle.readEntry('.release-skill');
    if (releaseEntry === null) {
      await rootHandle.mkdir('.release-skill', 0o700);
      releaseEntry = await rootHandle.readEntry('.release-skill');
    }
    const linkedIdentity = directoryIdentity(releaseEntry, '.release-skill');
    releaseHandle = await rootHandle.openDir('.release-skill');
    const openedIdentity = directoryIdentity(await releaseHandle.readEntry('.'), '.release-skill handle');
    if (!sameDirectoryIdentity(linkedIdentity, openedIdentity)) {
      throw setupError(CONFIG_INVALID, '.release-skill identity changed while setup opened it');
    }
    return { rootHandle, releaseHandle, rootIdentity, releaseIdentity: openedIdentity };
  } catch (error) {
    await releaseHandle?.close().catch(() => {});
    await rootHandle.close().catch(() => {});
    throw error;
  }
}

async function assertConfigDirectoryStillBound(root, safeFs, expected) {
  const current = await openBoundConfigDirectory(root, safeFs);
  try {
    if (
      !sameDirectoryIdentity(current.rootIdentity, expected.rootIdentity) ||
      !sameDirectoryIdentity(current.releaseIdentity, expected.releaseIdentity)
    ) {
      throw setupError(
        CONFIG_INVALID,
        'project root or .release-skill identity changed immediately before config creation',
      );
    }
  } finally {
    await current.releaseHandle.close().catch(() => {});
    await current.rootHandle.close().catch(() => {});
  }
}

async function createConfigOnce(root, config, { beforeRename } = {}) {
  const { loadSafeFs } = await import('../artifacts/safe-fs.mjs');
  const safeFs = await loadSafeFs();
  const releaseDir = join(root, '.release-skill');
  const target = join(releaseDir, 'project.yaml');
  const bound = await openBoundConfigDirectory(root, safeFs);
  let tempToken;
  const bytes = Buffer.from(YAML.stringify(config, { lineWidth: 0 }), 'utf8');
  try {
    const existing = await bound.releaseHandle.readEntry('project.yaml');
    if (existing !== null) {
      throw setupError(CONFIG_EXISTS, 'configuration was created concurrently; setup did not overwrite it', { configPath: target });
    }
    tempToken = await bound.releaseHandle.createTemp('project.yaml', 0o600, bytes);
    const commitAuthority = beforeRename ? await beforeRename() : null;
    await assertConfigDirectoryStillBound(root, safeFs, bound);
    try {
      await bound.releaseHandle.rename(tempToken, 'project.yaml');
      tempToken = null;
    } catch (error) {
      if (await bound.releaseHandle.readEntry('project.yaml') !== null) {
        throw setupError(CONFIG_EXISTS, 'configuration was created concurrently; setup did not overwrite it', { configPath: target });
      }
      throw error;
    }
    await bound.releaseHandle.fsync();
    await bound.rootHandle.fsync();
    try {
      await assertConfigDirectoryStillBound(root, safeFs, bound);
    } catch (error) {
      const created = await bound.releaseHandle.readFile('project.yaml').catch(() => null);
      if (created?.bytes?.equals(bytes)) {
        await bound.releaseHandle.unlink('project.yaml').catch(() => {});
        await bound.releaseHandle.fsync().catch(() => {});
      }
      throw error;
    }
    const canonical = await bound.releaseHandle.readFile('project.yaml');
    if (!canonical?.bytes?.equals(bytes)) {
      throw setupError(CONFIG_INVALID, 'created configuration bytes do not match the confirmed setup answers');
    }
    return {
      path: target,
      configSha256: sha256Hex(bytes),
      commitAuthority,
    };
  } finally {
    if (tempToken) await bound.releaseHandle.abortTemp(tempToken).catch(() => {});
    await bound.releaseHandle.close().catch(() => {});
    await bound.rootHandle.close().catch(() => {});
  }
}

/** Run deterministic first-use discovery or create the confirmed config. */
export async function setupProject({ root, answersPath, write = false, confirmSetup, faultInjector } = {}) {
  if (!root || typeof root !== 'string' || !isAbsolute(root)) {
    throw setupError(CONFIG_INVALID, 'setup root must be an absolute path');
  }
  const rootReal = await realpath(root).catch((error) => {
    throw setupError(CONFIG_INVALID, `cannot resolve setup root: ${error.message}`);
  });
  const configPath = join(rootReal, '.release-skill', 'project.yaml');
  let configExists = false;
  try {
    const stat = await lstat(configPath);
    configExists = true;
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw setupError(CONFIG_INVALID, 'existing project.yaml must be a regular file');
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (configExists) {
    if (write) throw setupError(CONFIG_EXISTS, 'configuration already exists; setup never overwrites it', { configPath });
    const [facts, configBytes] = await Promise.all([
      discoverFacts(rootReal),
      readFile(configPath, 'utf8'),
    ]);
    const candidates = buildCandidates(facts);
    let configuredUnitIds = [];
    let configuredGateIds = [];
    let parseError = null;
    let validationErrors = [];
    try {
      const existing = YAML.parse(configBytes);
      configuredUnitIds = (existing?.releaseUnits ?? []).map((unit) => unit?.id).filter(Boolean).sort();
      configuredGateIds = (existing?.verificationGates ?? []).map((gate) => gate?.id).filter(Boolean).sort();
      if (!validateProjectConfig(existing)) {
        validationErrors = (validateProjectConfig.errors ?? []).map((error) => ({
          instancePath: error.instancePath,
          schemaPath: error.schemaPath,
          keyword: error.keyword,
          params: error.params,
          message: error.message,
        }));
      }
    } catch (error) {
      parseError = error.message;
    }
    const discoveredUnitIds = candidates.units.map((unit) => unit.id).sort();
    const unconfiguredGateCandidateIds = candidates.gates
      .map((gate) => gate.id)
      .filter((id) => !configuredGateIds.includes(id))
      .sort();
    const existingReport = {
      setupVersion: 1,
      status: 'ALREADY_CONFIGURED',
      configPath,
      existingConfigSha256: sha256Hex(configBytes),
      facts,
      releaseUnitCandidates: candidates.units,
      gateCandidates: candidates.gates,
      audit: {
        configuredUnitIds,
        discoveredUnitIds,
        configuredGateIds,
        unconfiguredGateCandidateIds,
        ...(parseError ? { parseError } : {}),
        ...(validationErrors.length > 0 ? { validationErrors } : {}),
        patchSuggestions: [
          ...(parseError ? ['已有配置无法解析；先人工修复，再运行 release-assess。'] : []),
          ...(validationErrors.length > 0
            ? ['已有配置不符合 release-project schema；按 validationErrors 人工增量修复，不重新生成。']
            : []),
          ...(canonicalJson(configuredUnitIds) !== canonicalJson(discoveredUnitIds)
            ? ['发现的发布单元与已有配置不同；人工比较后仅做增量编辑，不重新生成。']
            : []),
          ...(unconfiguredGateCandidateIds.length > 0
            ? ['存在未配置的验证候选；逐项审阅副作用后决定是否人工注册。']
            : []),
          ...(candidates.units.some((unit) => (
            (unit.npmEntryCandidates ?? []).some((candidate) => candidate.state !== 'TRACKED_PRESENT') ||
            (unit.npmEntryDiagnostics ?? []).length > 0
          ))
            ? ['npm 入口候选存在未跟踪、被忽略、缺失、非普通文件或声明覆盖疑点；人工增量修复配置或构建流程，setup 不自动改写。']
            : []),
        ],
      },
      recommendedGateIds: [],
      proposalConflicts: [],
      proposalAssumptions: [],
      productionReadiness: 'ASSESS_REQUIRED',
      next: '运行 release-skill assess 审计已有配置；需要调整时依据建议人工增量编辑。',
    };
    existingReport.compactSummary = buildCompactSummary(existingReport);
    return existingReport;
  }

  const facts = await discoverFacts(rootReal);
  const candidates = buildCandidates(facts);
  const sourceRepositoryCandidates = [...new Set(
    facts.git.remotes.map((remote) => remote.repo).filter(Boolean),
  )].sort();
  let answers = null;
  if (answersPath) {
    const resolvedAnswers = isAbsolute(answersPath) ? answersPath : resolve(rootReal, answersPath);
    answers = await readJsonBounded(resolvedAnswers, 'setup answers');
    validateAnswers(answers, candidates.gates);
  }
  const selectedGateIds = answers?.selectedGateIds ?? [];
  const digestAuthority = {
    setupVersion: 1,
    facts,
    sourceRepositoryCandidates,
    releaseUnitCandidates: candidates.units,
    gateCandidates: candidates.gates,
    selectedGateIds,
    projectConfig: answers?.projectConfig ?? null,
  };
  const setupDigest = sha256Hex(canonicalJson(digestAuthority));
  const hasDiscoveredRemoteChannel = candidates.units.some((unit) => (
    unit.publicRepoCandidates.length > 0
  )) || facts.packages.some((pkg) => pkg.publishRegistry);
  const status = answers
    ? 'READY_TO_WRITE'
    : hasDiscoveredRemoteChannel
      ? 'NEEDS_INPUT'
      : 'LOCAL_ONLY_DETECTED';
  const localOnly = status === 'LOCAL_ONLY_DETECTED';
  // Deterministic recommendation: gates eligible for automatic inclusion
  // without human review. Agents use this to build recommendedAnswers.
  const recommendedGateIds = candidates.gates
    .filter((gate) => gate.eligibleForRecommendation)
    .map((gate) => gate.id);
  // Build recommendedAnswers: a complete proposal for human review,
  // or null when conflicts prevent safe automatic recommendation.
  const recommendedProposal = answers
    ? { answers: null, conflicts: [], assumptions: [] }
    : buildRecommendedProposal(facts, candidates);
  const report = {
    ...digestAuthority,
    status,
    setupDigest,
    recommendedGateIds,
    recommendedAnswers: recommendedProposal.answers,
    proposalConflicts: recommendedProposal.conflicts,
    proposalAssumptions: recommendedProposal.assumptions,
    productionReadiness: status === 'LOCAL_ONLY_DETECTED'
      ? 'LOCAL_ONLY'
      : answers
        ? 'CONFIG_DRAFT_READY'
        : 'HUMAN_DECISIONS_REQUIRED',
    decisionsRequired: answers ? [] : buildDecisionsRequired(candidates, localOnly),
    writeContract: {
      default: 'dry-run',
      requires: ['--write', `--confirm-setup ${setupDigest}`, '--answers <json>'],
      target: '.release-skill/project.yaml',
      overwrite: false,
    },
  };
  // Derive compact summary from the final report to avoid state/digest/conflict
  // inconsistencies. Must not read or execute project scripts.
  report.compactSummary = buildCompactSummary(report);

  if (!write) return report;
  if (!answers) throw setupError(CONFIG_INVALID, 'setup --write requires --answers <json>');
  if (confirmSetup !== setupDigest) {
    throw setupError(
      SETUP_DIGEST_MISMATCH,
      'setup confirmation does not match the current facts and answers; rerun dry-run and review again',
      { expected: setupDigest, received: confirmSetup ?? null },
    );
  }
  const lock = await acquireProjectLock({ root: rootReal, command: 'setup', mode: 'exclusive' });
  let committedConfig;
  try {
    committedConfig = await lock.capture(async () => {
      if (faultInjector) await faultInjector('before-config-commit');
      const lockedFacts = await discoverFacts(rootReal);
      const lockedCandidates = buildCandidates(lockedFacts);
      const resolvedAnswers = isAbsolute(answersPath) ? answersPath : resolve(rootReal, answersPath);
      const lockedAnswers = await readJsonBounded(resolvedAnswers, 'setup answers');
      validateAnswers(lockedAnswers, lockedCandidates.gates);
      const lockedAuthority = {
        setupVersion: 1,
        facts: lockedFacts,
        sourceRepositoryCandidates: [...new Set(
          lockedFacts.git.remotes.map((remote) => remote.repo).filter(Boolean),
        )].sort(),
        releaseUnitCandidates: lockedCandidates.units,
        gateCandidates: lockedCandidates.gates,
        selectedGateIds: lockedAnswers.selectedGateIds,
        projectConfig: lockedAnswers.projectConfig,
      };
      const lockedDigest = sha256Hex(canonicalJson(lockedAuthority));
      if (lockedDigest !== confirmSetup) {
        throw setupError(
          SETUP_DIGEST_MISMATCH,
          'project facts or setup answers changed immediately before config creation; rerun dry-run and review the new digest',
          { expected: lockedDigest, received: confirmSetup },
        );
      }
      return createConfigOnce(rootReal, lockedAnswers.projectConfig, {
        beforeRename: async () => {
          if (faultInjector) await faultInjector('before-config-link');
          const finalFacts = await discoverFacts(rootReal);
          const finalCandidates = buildCandidates(finalFacts);
          const finalAnswers = await readJsonBounded(resolvedAnswers, 'setup answers');
          validateAnswers(finalAnswers, finalCandidates.gates);
          const finalAuthority = {
            setupVersion: 1,
            facts: finalFacts,
            sourceRepositoryCandidates: [...new Set(
              finalFacts.git.remotes.map((remote) => remote.repo).filter(Boolean),
            )].sort(),
            releaseUnitCandidates: finalCandidates.units,
            gateCandidates: finalCandidates.gates,
            selectedGateIds: finalAnswers.selectedGateIds,
            projectConfig: finalAnswers.projectConfig,
          };
          const finalDigest = sha256Hex(canonicalJson(finalAuthority));
          if (finalDigest !== confirmSetup) {
            throw setupError(
              SETUP_DIGEST_MISMATCH,
              'project facts or setup answers changed in the final create-once window; rerun dry-run and review the new digest',
              { expected: finalDigest, received: confirmSetup },
            );
          }
          return {
            setupDigest: finalDigest,
            factsDigest: sha256Hex(canonicalJson(finalFacts)),
            answersDigest: sha256Hex(canonicalJson(finalAnswers)),
          };
        },
      });
    });
  } finally {
    await lock.release();
  }
  const createdReport = {
    ...report,
    status: 'CONFIG_CREATED',
    productionReadiness: 'ASSESS_REQUIRED',
    configPath: committedConfig.path,
    configSha256: committedConfig.configSha256,
    committedSetupDigest: committedConfig.commitAuthority.setupDigest,
    committedFactsDigest: committedConfig.commitAuthority.factsDigest,
    committedAnswersDigest: committedConfig.commitAuthority.answersDigest,
    next: '运行 release-skill assess；再根据 gate 副作用决定 prepare/verify 的显式授权。',
  };
  createdReport.compactSummary = buildCompactSummary(createdReport);
  return createdReport;
}

// ===========================================================================
// R5 — downstream discovery + postPublish hook declaration proposal
// (guided configuration) and the independent incremental-proposal mode.
//
// Design §2.9 / §2.8 R5. The pipeline reuses the existing setup shape:
//   read-only discovery -> mechanical proposal extraction -> human confirms
//   the exact setupDigest -> write. No new automatic writes are introduced.
//
// The incremental mode is deliberately SEPARATE from setupProject: it never
// regenerates an existing configuration (the create-once hard boundary stays
// intact) and, after exact digest confirmation, appends ONLY the target
// release unit's postPublish.hooks block — every other byte of a human-owned
// config is preserved (comment/formatting-preserving YAML edit + semantic guard).
// ===========================================================================

const R5_REMOTE_URL_RE = /^(?:https?|file):\/\/.+\.git$/;
const FOUNDATION_PROFILE_FILENAME = 'foundation-profile.json';
const MAX_NEIGHBOR_SCAN = 64;

// postPublishHook schema fields that may be carried into an appended draft;
// report-only fields (source/rationale) are stripped before writing because
// the schema is additionalProperties:false. Preset proposals never carry the
// command-hook fields (command/cwd/timeoutMs/envAllowlist) — listing them
// here would be an unreachable allowlist, so they are deliberately absent
// (R5 review note-2).
const R5_HOOK_DRAFT_FIELDS = [
  'id', 'preset', 'phase', 'config', 'requiresApproval', 'blocksVerified',
];

async function r5IsRegularFile(path) {
  try {
    const entry = await lstat(path);
    return entry.isFile() && !entry.isSymbolicLink();
  } catch {
    return false;
  }
}

async function r5IsDirectory(path) {
  try {
    const entry = await lstat(path);
    return entry.isDirectory() && !entry.isSymbolicLink();
  } catch {
    return false;
  }
}

async function r5HasGitEntry(absDir) {
  try {
    await lstat(join(absDir, '.git'));
    return true;
  } catch {
    return false;
  }
}

/**
 * Enumerate the immediate sibling directories of the project root (bounded,
 * read-only). Symlinks and SKIP_DIRS are excluded; the result is sorted and
 * capped so discovery stays deterministic and cheap.
 */
async function r5SiblingDirs(rootReal) {
  const parent = dirname(rootReal);
  if (!parent || parent === rootReal) return [];
  let entries;
  try {
    entries = await readdir(parent, { withFileTypes: true });
  } catch {
    return [];
  }
  const rootBase = basename(rootReal);
  const siblings = [];
  for (const entry of entries) {
    if (entry.name === rootBase) continue;
    if (entry.isSymbolicLink()) continue;
    if (!entry.isDirectory()) continue;
    if (SKIP_DIRS.has(entry.name)) continue;
    siblings.push(join(parent, entry.name));
  }
  return siblings.sort().slice(0, MAX_NEIGHBOR_SCAN);
}

/**
 * Detect downstream clue markers at the TOP LEVEL of a directory (read-only,
 * bounded): marketplace manifests (registry-driven suffixes), and docs
 * repositories (mkdocs.yml or docs/ together with a .git entry).
 */
async function r5DetectCluesInDir(absDir) {
  const clues = [];
  for (const suffix of DISCOVERY_MANIFEST_SUFFIXES) {
    if (typeof suffix !== 'string' || !suffix.includes('marketplace.json')) continue;
    if (await r5IsRegularFile(join(absDir, suffix))) {
      clues.push({ path: suffix, kind: 'marketplace' });
    }
  }
  const hasMkdocs = await r5IsRegularFile(join(absDir, 'mkdocs.yml'));
  const hasDocsDir = await r5IsDirectory(join(absDir, 'docs'));
  if (hasMkdocs || hasDocsDir) {
    const gitBacked = await r5HasGitEntry(absDir);
    clues.push({ path: hasMkdocs ? 'mkdocs.yml' : 'docs', kind: gitBacked ? 'docs-repo' : 'docs' });
  }
  return clues;
}

function r5ValidateProfileShape(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('foundation profile must be a JSON object');
  }
  if (value.profileVersion !== 1) {
    throw new Error('foundation profile profileVersion must be 1');
  }
  const hooks = value.hooks ?? [];
  const targets = value.targets ?? [];
  if (!Array.isArray(hooks) || !Array.isArray(targets)) {
    throw new Error('foundation profile hooks and targets must be arrays');
  }
  return { profileVersion: 1, hooks, targets };
}

/**
 * Search (read-only) for a foundation profile. Deterministic order: explicit
 * path, project-local, then immediate siblings. The first existing regular
 * file wins. Descriptors are root-relative / sibling-relative (never absolute)
 * so reports and digests carry no /Users/... layout.
 */
async function r5FindFoundationProfile(rootReal, explicitPath) {
  const candidates = [];
  if (explicitPath && typeof explicitPath === 'string' && explicitPath.length > 0) {
    candidates.push({
      abs: isAbsolute(explicitPath) ? explicitPath : resolve(rootReal, explicitPath),
      desc: explicitPath,
    });
  }
  candidates.push(
    { abs: join(rootReal, '.release-skill', FOUNDATION_PROFILE_FILENAME), desc: `.release-skill/${FOUNDATION_PROFILE_FILENAME}` },
    { abs: join(rootReal, FOUNDATION_PROFILE_FILENAME), desc: FOUNDATION_PROFILE_FILENAME },
  );
  for (const sibling of await r5SiblingDirs(rootReal)) {
    const name = basename(sibling);
    candidates.push(
      { abs: join(sibling, '.release-skill', FOUNDATION_PROFILE_FILENAME), desc: `../${name}/.release-skill/${FOUNDATION_PROFILE_FILENAME}` },
      { abs: join(sibling, FOUNDATION_PROFILE_FILENAME), desc: `../${name}/${FOUNDATION_PROFILE_FILENAME}` },
    );
  }
  for (const candidate of candidates) {
    if (await r5IsRegularFile(candidate.abs)) return candidate;
  }
  return null;
}

/**
 * Strictly read-only downstream discovery (design §2.9 clue set): git remote
 * enumeration (mirror candidates), workspace + neighbor marketplace/docs
 * clues, artifact-graph.config.yaml presence, and the foundation profile
 * (when present). Never writes anywhere.
 */
async function r5Discover(rootReal, foundationProfilePath) {
  const configPath = join(rootReal, '.release-skill', 'project.yaml');
  const configExists = await r5IsRegularFile(configPath);

  const git = await discoverGit(rootReal);
  const gitRemotes = git.remotes.map((remote) => ({ name: remote.name, url: remote.url, repo: remote.repo }));
  const sourceRepositoryCandidates = [...new Set(
    git.remotes.map((remote) => remote.repo).filter(Boolean),
  )].sort();
  const mirrorCandidates = git.remotes
    .filter((remote) => R5_REMOTE_URL_RE.test(remote.url))
    .map((remote) => ({ remoteName: remote.name, remoteUrl: remote.url, repo: remote.repo }))
    .sort((a, b) => canonicalJson(a).localeCompare(canonicalJson(b)));

  const artifactGraphPresent = await r5IsRegularFile(join(rootReal, 'artifact-graph.config.yaml'));

  const workspaceClues = (await r5DetectCluesInDir(rootReal))
    .sort((a, b) => canonicalJson(a).localeCompare(canonicalJson(b)));

  const neighborClues = [];
  for (const sibling of await r5SiblingDirs(rootReal)) {
    const name = basename(sibling);
    if (/hub/i.test(name)) neighborClues.push({ sibling: name, kind: 'hub' });
    for (const clue of await r5DetectCluesInDir(sibling)) {
      neighborClues.push({ sibling: name, kind: clue.kind, path: clue.path });
    }
  }
  neighborClues.sort((a, b) => canonicalJson(a).localeCompare(canonicalJson(b)));

  const profileDiagnostics = [];
  let foundationProfile = null;
  let foundationProfileParsed = null;
  const found = await r5FindFoundationProfile(rootReal, foundationProfilePath);
  if (found) {
    try {
      const raw = JSON.parse(await readFile(found.abs, 'utf8'));
      const parsed = r5ValidateProfileShape(raw);
      foundationProfile = {
        path: found.desc,
        profileVersion: parsed.profileVersion,
        hookCount: parsed.hooks.length,
        targetCount: parsed.targets.length,
      };
      foundationProfileParsed = parsed;
    } catch (error) {
      profileDiagnostics.push({ path: found.desc, error: error.message });
    }
  }

  return {
    mode: 'postpublish-discovery',
    configExists,
    gitRemotes,
    sourceRepositoryCandidates,
    mirrorCandidates,
    artifactGraphConfig: {
      present: artifactGraphPresent,
      ...(artifactGraphPresent ? { path: 'artifact-graph.config.yaml' } : {}),
    },
    workspaceClues,
    neighborClues,
    foundationProfile,
    foundationProfileParsed,
    foundationProfileLoadDiagnostics: profileDiagnostics,
  };
}

/** Read-only downstream discovery entry point (R5). */
export async function discoverDownstream({ root, foundationProfilePath } = {}) {
  if (!root || typeof root !== 'string' || !isAbsolute(root)) {
    throw setupError(CONFIG_INVALID, 'discovery root must be an absolute path');
  }
  const rootReal = await realpath(root).catch((error) => {
    throw setupError(CONFIG_INVALID, `cannot resolve discovery root: ${error.message}`);
  });
  const discovery = await r5Discover(rootReal, foundationProfilePath);
  // The parsed profile is an internal carrier for the proposal stage; the
  // public discovery report keeps only the profile metadata.
  const { foundationProfileParsed, ...publicDiscovery } = discovery;
  return publicDiscovery;
}

/**
 * Mechanically extract postPublish declaration drafts from discovery.
 * Only LEGAL hooks[]-form drafts are produced (validated against the preset
 * registry); targets-form presets (git-mirror / marketplace-index-render) are
 * surfaced as targetProposals for guided/new-project use, never as hooks.
 * foundation profile is one input among several and never auto-applies.
 */
function r5BuildProposals(discovery, existingHookIds) {
  const existing = new Set(existingHookIds);
  const hookProposals = [];
  const targetProposals = [];
  const candidates = [];
  const notes = [];
  const diagnostics = [...discovery.foundationProfileLoadDiagnostics];

  const proposeHook = (draft, source, rationale) => {
    hookProposals.push({ ...draft, source, rationale });
  };

  // 1. Zero-write floor — always available to every project.
  proposeHook(
    { id: 'downstream-notify-handoff', preset: 'notify-handoff', phase: 'distribute' },
    'discovery-baseline',
    'zero-write floor: renders the downstream sync checklist in evidence',
  );

  // 2. proposal-inbox from a hub-looking git remote (git-push transport).
  const hub = discovery.mirrorCandidates.find((candidate) => (
    /hub/i.test(candidate.remoteName) || /hub/i.test(candidate.repo ?? '')
  ));
  if (hub) {
    proposeHook(
      {
        id: 'downstream-hub-proposal',
        preset: 'proposal-inbox',
        phase: 'postVerify',
        requiresApproval: true,
        config: { delivery: 'git-push', target: { remoteUrl: hub.remoteUrl, branch: 'main' } },
      },
      'git-remote',
      `hub-looking remote "${hub.remoteName}" suggests a proposal inbox`,
    );
  }

  // 3. git-mirror target drafts (targets-form) from non-self remotes.
  const selfRepo = discovery.sourceRepositoryCandidates.length === 1
    ? discovery.sourceRepositoryCandidates[0]
    : null;
  for (const candidate of discovery.mirrorCandidates) {
    if (selfRepo && candidate.repo === selfRepo) continue;
    const slug = (candidate.repo ?? candidate.remoteName)
      .toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
    targetProposals.push({
      id: `mirror-${slug}`,
      kind: 'payload-mirror',
      remoteUrl: candidate.remoteUrl,
      visibility: 'public',
      branch: 'main',
      source: 'git-remote',
      rationale: `remote "${candidate.remoteName}" is a payload-mirror candidate`,
    });
  }
  if (!selfRepo && discovery.mirrorCandidates.length > 0) {
    notes.push('source repository is ambiguous; review mirror target drafts before adopting them.');
  }

  // 4. foundation profile hooks/targets (validated; invalid entries reported).
  const profile = discovery.foundationProfileParsed;
  if (profile) {
    for (const [index, hook] of profile.hooks.entries()) {
      const id = hook && typeof hook.id === 'string' ? hook.id : null;
      try {
        if (!id) throw new Error('hook must declare a string id');
        // validatePresetHook enforces registry membership, targets-form-only
        // rejection, secret scanning, and preset config semantics (fail-closed).
        validatePresetHook(hook, `foundationProfile.hooks[${index}]`);
        const draft = { id, preset: hook.preset };
        if (hook.phase !== undefined) draft.phase = hook.phase;
        if (hook.config !== undefined) draft.config = hook.config;
        if (hook.requiresApproval !== undefined) draft.requiresApproval = hook.requiresApproval;
        if (hook.blocksVerified !== undefined) draft.blocksVerified = hook.blocksVerified;
        proposeHook(draft, 'foundation-profile', 'declared by the foundation profile');
      } catch (error) {
        diagnostics.push({ id, error: error.message });
      }
    }
    for (const target of profile.targets) {
      targetProposals.push({
        ...target,
        source: 'foundation-profile',
        rationale: 'declared by the foundation profile',
      });
    }
  }

  // 5. Existence clues become candidate evidence + guidance notes.
  if (discovery.artifactGraphConfig.present) {
    candidates.push({ kind: 'artifact-graph', path: discovery.artifactGraphConfig.path, source: 'workspace' });
    notes.push('artifact-graph.config.yaml present: consider a marketplace-registry-entry hook via the foundation profile.');
  }
  for (const clue of discovery.workspaceClues) candidates.push({ ...clue, source: 'workspace' });
  for (const clue of discovery.neighborClues) candidates.push({ ...clue, source: 'neighbor-scan' });
  if (discovery.neighborClues.some((clue) => clue.kind === 'docs-repo')) {
    notes.push('docs repository clue found: a docs-refresh hook needs mappings from the foundation profile or human input.');
  }
  if (discovery.neighborClues.some((clue) => clue.kind === 'marketplace')) {
    notes.push('marketplace clue found: a marketplace-registry-entry hook needs entryKey/fieldsFromPlan from the foundation profile or human input.');
  }

  // Conflicts: a proposal id that already exists must never be overwritten.
  const appendableHookProposals = [];
  const conflicts = [];
  for (const proposal of hookProposals) {
    if (existing.has(proposal.id)) {
      conflicts.push({ existingHookId: proposal.id, preset: proposal.preset, source: proposal.source });
    } else {
      appendableHookProposals.push(proposal);
    }
  }

  return {
    hookProposals,
    appendableHookProposals,
    targetProposals,
    candidates,
    notes,
    conflicts,
    foundationProfileDiagnostics: diagnostics,
  };
}

/** Strip report-only fields so an appended draft is schema-clean. */
function r5CleanHookDraft(proposal) {
  const draft = {};
  for (const field of R5_HOOK_DRAFT_FIELDS) {
    if (proposal[field] !== undefined) draft[field] = proposal[field];
  }
  return draft;
}

/**
 * Append hook drafts into releaseUnits[unitIndex].postPublish.hooks.
 *
 * First-time hooks-key creation is a byte-level splice (r5HooksBlockSplice):
 * only the rendered `hooks:` block is inserted after the postPublish map's
 * last content line, so every pre-existing line — including inline comments —
 * keeps its exact source bytes (R5 review minor-1). The splice falls back to
 * a document-level setIn/toString only for non-block-map postPublish shapes.
 * Appending to an already-present hooks sequence re-serializes the document;
 * the semantic identity of every non-hooks section is then asserted by the
 * caller (r5AppendHooksOnce) before any write.
 */
function r5AppendHooksToYaml(text, hookDrafts, unitIndex) {
  const doc = YAML.parseDocument(text);
  const hooksPath = ['releaseUnits', unitIndex, 'postPublish', 'hooks'];
  const existingHooks = doc.getIn(hooksPath);
  if (existingHooks === undefined || existingHooks === null) {
    const postPublishMap = doc.getIn(hooksPath.slice(0, -1));
    const splice = r5HooksBlockSplice(text, postPublishMap, hookDrafts);
    if (splice !== null) return splice;
    doc.setIn(hooksPath, hookDrafts);
    return doc.toString();
  }
  for (const draft of hookDrafts) existingHooks.add(draft);
  return doc.toString();
}

/**
 * Render the new `hooks:` block and splice it into the source bytes right
 * after the target postPublish map's last content line. Returns null when the
 * map shape is not a plain block map (flow, alias, or absent), in which case
 * the caller falls back to a document-level serialization.
 */
function r5HooksBlockSplice(text, postPublishMap, hookDrafts) {
  if (!YAML.isMap(postPublishMap) || postPublishMap.flow || YAML.isAlias(postPublishMap)) return null;
  const [mapStart, valueEnd] = postPublishMap.range;
  if (!Number.isInteger(mapStart) || !Number.isInteger(valueEnd)) return null;
  if (mapStart < 0 || valueEnd > text.length || mapStart > valueEnd) return null;
  // The block's indentation is the whitespace before its first key.
  const lineStart = text.lastIndexOf('\n', mapStart - 1) + 1;
  const indent = text.slice(lineStart, mapStart);
  if (!/^[ ]*$/.test(indent)) return null; // tabs or unexpected content
  // Insert after the newline that terminates the map's last content line;
  // a same-line trailing comment stays with that line.
  const nl = text.indexOf('\n', Math.max(lineStart, valueEnd - 1));
  const insertPos = nl === -1 ? text.length : nl + 1;
  const fragment = YAML.stringify({ hooks: hookDrafts }, { lineWidth: 0 });
  const block = fragment.replace(/\n$/, '').split('\n').map((line) => indent + line);
  const terminator = insertPos === text.length && !text.endsWith('\n') ? '' : '\n';
  return text.slice(0, insertPos) + block.join('\n') + terminator + text.slice(insertPos);
}

/** Remove every release unit's postPublish.hooks (for the unchanged-section guard). */
function r5StripHooks(config) {
  const copy = JSON.parse(JSON.stringify(config ?? {}));
  for (const unit of copy.releaseUnits ?? []) {
    if (unit?.postPublish) delete unit.postPublish.hooks;
  }
  return copy;
}

/**
 * Atomically replace project.yaml with the hooks-appended bytes using the
 * safe-fs bound-directory machinery. The existing file's read identity
 * authorizes the replace (TOCTOU-safe); the merged config is schema-validated
 * and every non-hooks section is asserted unchanged before the rename.
 */
async function r5AppendHooksOnce(rootReal, hookDrafts, unitIndex) {
  const { loadSafeFs } = await import('../artifacts/safe-fs.mjs');
  const safeFs = await loadSafeFs();
  const bound = await openBoundConfigDirectory(rootReal, safeFs);
  let tempToken;
  try {
    const existing = await bound.releaseHandle.readFile('project.yaml');
    if (existing === null) {
      throw setupError(CONFIG_MISSING, 'configuration disappeared before hooks could be appended');
    }
    const existingText = existing.bytes.toString('utf8');
    const newText = r5AppendHooksToYaml(existingText, hookDrafts, unitIndex);
    const merged = YAML.parse(newText);
    if (!validateProjectConfig(merged)) {
      const errors = validateProjectConfig.errors ?? [];
      throw setupError(
        CONFIG_INVALID,
        `appended configuration would be invalid: ${errors.map((error) => `${error.instancePath || '/'} ${error.message}`).join('; ')}`,
        { validationErrors: errors },
      );
    }
    const before = YAML.parse(existingText);
    if (canonicalJson(r5StripHooks(before)) !== canonicalJson(r5StripHooks(merged))) {
      throw setupError(CONFIG_INVALID, 'hooks append would alter non-hooks configuration sections; refusing to write');
    }
    // Defense in depth (R5 review note-1): fail closed at declaration time
    // when the merged unit would not survive the runtime declaration
    // validation that prepare/distribute/postverify enforce anyway. This
    // never writes a hooks block onto a unit that can never pass runtime.
    const mergedUnit = Array.isArray(merged.releaseUnits) ? merged.releaseUnits[unitIndex] : null;
    validatePostPublishDeclaration(mergedUnit?.postPublish, { unitId: mergedUnit?.id });
    const newBytes = Buffer.from(newText, 'utf8');
    tempToken = await bound.releaseHandle.createTemp('project.yaml', 0o600, newBytes);
    await assertConfigDirectoryStillBound(rootReal, safeFs, bound);
    // `existing` carries the read identity that authorizes replacing this file.
    await bound.releaseHandle.rename(tempToken, 'project.yaml', existing);
    tempToken = null;
    await bound.releaseHandle.fsync();
    await bound.rootHandle.fsync();
    return { configSha256: sha256Hex(newBytes) };
  } finally {
    if (tempToken) await bound.releaseHandle.abortTemp(tempToken).catch(() => {});
    await bound.releaseHandle.close().catch(() => {});
    await bound.rootHandle.close().catch(() => {});
  }
}

/** Assemble the digest authority + report for one discovery/proposal pass. */
async function r5Compute({ rootReal, foundationProfilePath, selectedHookIds, unitId }) {
  const configPath = join(rootReal, '.release-skill', 'project.yaml');
  let configBytes = null;
  let existingParsed = null;
  const configExists = await r5IsRegularFile(configPath);
  if (configExists) {
    configBytes = await readFile(configPath, 'utf8');
    try {
      existingParsed = YAML.parse(configBytes);
    } catch (error) {
      throw setupError(CONFIG_INVALID, `existing configuration cannot be parsed; refusing incremental proposal: ${error.message}`);
    }
  }

  // postPublish is a per-release-unit block. Resolve the single unit whose
  // hooks will be appended: an explicit unitId, or the unique unit that
  // already declares the materialize + commitIdentity distribute base.
  const units = Array.isArray(existingParsed?.releaseUnits) ? existingParsed.releaseUnits : [];
  const hasBase = (unit) => Boolean(unit?.postPublish?.materialize && unit?.postPublish?.commitIdentity);
  const baseUnitIndexes = units.map((unit, index) => ({ unit, index })).filter(({ unit }) => hasBase(unit)).map(({ index }) => index);
  let targetUnitIndex = null;
  let targetUnitId = null;
  let targetRefusal = null;
  if (configExists) {
    if (unitId !== undefined && unitId !== null) {
      const idx = units.findIndex((unit) => unit?.id === unitId);
      if (idx === -1) targetRefusal = `release unit "${unitId}" was not found in the existing configuration`;
      else if (!hasBase(units[idx])) targetRefusal = `release unit "${unitId}" lacks the postPublish materialize/commitIdentity base required before hooks can be appended`;
      else { targetUnitIndex = idx; targetUnitId = unitId; }
    } else if (baseUnitIndexes.length === 1) {
      targetUnitIndex = baseUnitIndexes[0];
      targetUnitId = units[targetUnitIndex]?.id ?? null;
    } else if (baseUnitIndexes.length === 0) {
      targetRefusal = 'no release unit declares the postPublish materialize/commitIdentity base required before hooks can be appended; declare the distribute base first (human decision)';
    } else {
      targetRefusal = `multiple release units declare a postPublish base (${baseUnitIndexes.map((index) => units[index]?.id ?? `#${index}`).join(', ')}); pass an explicit unitId to choose one`;
    }
  }

  const existingHookIds = targetUnitIndex === null
    ? []
    : (units[targetUnitIndex]?.postPublish?.hooks ?? [])
      .map((hook) => hook?.id)
      .filter((id) => typeof id === 'string');
  const hasPostPublishBase = targetUnitIndex !== null;

  const discovery = await r5Discover(rootReal, foundationProfilePath);
  const proposals = r5BuildProposals(discovery, existingHookIds);

  const appendableIds = proposals.appendableHookProposals.map((proposal) => proposal.id);
  let selected;
  if (selectedHookIds !== undefined && selectedHookIds !== null) {
    if (!Array.isArray(selectedHookIds)) {
      throw setupError(CONFIG_INVALID, 'selectedHookIds must be an array of proposal ids');
    }
    const requested = [...new Set(selectedHookIds)];
    for (const id of requested) {
      if (!appendableIds.includes(id)) {
        throw setupError(CONFIG_INVALID, `selectedHookIds contains unknown or conflicting proposal "${id}"`);
      }
    }
    selected = requested.sort();
  } else {
    selected = [...appendableIds].sort();
  }
  const selectedProposals = proposals.appendableHookProposals
    .filter((proposal) => selected.includes(proposal.id));
  const selectedDrafts = selectedProposals.map(r5CleanHookDraft);

  const authority = {
    setupVersion: 1,
    mode: 'postpublish-hooks-proposal',
    configExists,
    existingConfigSha256: configExists ? sha256Hex(configBytes) : null,
    targetUnitId,
    discovery,
    selectedHookIds: selected,
    selectedDrafts,
  };
  const setupDigest = sha256Hex(canonicalJson(authority));

  return {
    configPath,
    configExists,
    configBytes,
    existingParsed,
    hasPostPublishBase,
    targetUnitIndex,
    targetUnitId,
    targetRefusal,
    discovery,
    proposals,
    selected,
    selectedDrafts,
    authority,
    setupDigest,
  };
}

/**
 * R5 guided proposal + independent incremental-proposal mode.
 *
 * Dry-run (default): read-only discovery + hook declaration drafts + a
 * setupDigest binding the existing config, the discovery facts, and the
 * selected drafts. Write mode: after exact setupDigest confirmation and under
 * the project lock, appends ONLY postPublish.hooks to an EXISTING config
 * (create-once is never touched). foundation profile is one proposal input and
 * never auto-applies.
 */
export async function proposePostPublishHooks({
  root,
  write = false,
  confirmSetup,
  selectedHookIds,
  foundationProfilePath,
  unitId,
  faultInjector,
} = {}) {
  if (!root || typeof root !== 'string' || !isAbsolute(root)) {
    throw setupError(CONFIG_INVALID, 'proposal root must be an absolute path');
  }
  const rootReal = await realpath(root).catch((error) => {
    throw setupError(CONFIG_INVALID, `cannot resolve proposal root: ${error.message}`);
  });
  const computed = await r5Compute({ rootReal, foundationProfilePath, selectedHookIds, unitId });
  const report = {
    setupVersion: 1,
    mode: 'postpublish-hooks-proposal',
    status: 'HOOKS_PROPOSAL_READY',
    configPath: computed.configPath,
    configExists: computed.configExists,
    targetUnitId: computed.targetUnitId,
    targetRefusal: computed.targetRefusal ?? null,
    existingConfigSha256: computed.configExists ? sha256Hex(computed.configBytes) : null,
    discovery: (() => {
      const { foundationProfileParsed, ...publicDiscovery } = computed.discovery;
      return publicDiscovery;
    })(),
    hookProposals: computed.proposals.hookProposals,
    appendableHookIds: computed.proposals.appendableHookProposals.map((proposal) => proposal.id),
    targetProposals: computed.proposals.targetProposals,
    candidates: computed.proposals.candidates,
    notes: computed.proposals.notes,
    conflicts: computed.proposals.conflicts,
    foundationProfileDiagnostics: computed.proposals.foundationProfileDiagnostics,
    selectedHookIds: computed.selected,
    setupDigest: computed.setupDigest,
    writeContract: {
      default: 'dry-run',
      requires: ['--write', `--confirm-setup ${computed.setupDigest}`],
      appendOnly: 'releaseUnits[<target>].postPublish.hooks',
      overwrite: false,
      createOnceBoundary: 'setup create-once is never touched by this mode',
    },
  };

  if (!write) return report;

  if (!computed.configExists) {
    throw setupError(
      CONFIG_MISSING,
      'incremental postPublish proposal requires an existing configuration; run setup create first',
      { configPath: computed.configPath },
    );
  }
  if (!computed.hasPostPublishBase) {
    throw setupError(
      CONFIG_INVALID,
      computed.targetRefusal ?? 'existing configuration lacks the postPublish base required before hooks can be appended',
      { configPath: computed.configPath },
    );
  }
  if (confirmSetup !== computed.setupDigest) {
    throw setupError(
      SETUP_DIGEST_MISMATCH,
      'proposal confirmation does not match the current configuration, discovery facts, and selection; rerun dry-run and review again',
      { expected: computed.setupDigest, received: confirmSetup ?? null },
    );
  }
  if (computed.selectedDrafts.length === 0) {
    return { ...report, status: 'HOOKS_NO_CHANGE', next: '没有可追加的 hook 草案；无写入。' };
  }

  const lock = await acquireProjectLock({ root: rootReal, command: 'setup-postpublish', mode: 'exclusive' });
  let appendResult;
  try {
    appendResult = await lock.capture(async () => {
      if (faultInjector) await faultInjector('before-hooks-append');
      const locked = await r5Compute({ rootReal, foundationProfilePath, selectedHookIds, unitId });
      if (locked.setupDigest !== confirmSetup) {
        throw setupError(
          SETUP_DIGEST_MISMATCH,
          'configuration or discovery facts changed immediately before hooks append; rerun dry-run and review the new digest',
          { expected: locked.setupDigest, received: confirmSetup },
        );
      }
      if (!locked.hasPostPublishBase) {
        throw setupError(
          CONFIG_INVALID,
          locked.targetRefusal ?? 'postPublish base disappeared before hooks append',
          { configPath: locked.configPath },
        );
      }
      return r5AppendHooksOnce(rootReal, locked.selectedDrafts, locked.targetUnitIndex);
    });
  } finally {
    await lock.release();
  }

  return {
    ...report,
    status: 'HOOKS_APPENDED',
    configSha256: appendResult.configSha256,
    appendedHookIds: computed.selected,
    committedSetupDigest: computed.setupDigest,
    next: '运行 release-skill assess；分发前审阅追加的 postPublish hooks 与其批准分级。',
  };
}

// ---------------------------------------------------------------------------
// WP-6 — adoption assessment (read-only, offline)
// ---------------------------------------------------------------------------

/**
 * Check whether a path exists (file or directory) without following the
 * existence of the last component as a hard requirement.
 *
 * @param {string} filePath - Absolute path.
 * @returns {Promise<boolean>}
 */
async function adoptionPathExists(filePath) {
  try {
    await lstat(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Read every parsed evidence event from `<root>/.release-skill/runs/<runId>/evidence.jsonl`.
 *
 * Read-only observation (R-11): the adoption assessment never writes runs
 * and never trusts any other evidence location. Unreadable or malformed
 * lines are skipped; the assessment stays robust to arbitrary run debris.
 *
 * @param {string} root - Project root.
 * @returns {Promise<Array<Object>>} Parsed evidence events.
 */
async function readEvidenceEvents(root) {
  const runsDir = join(root, '.release-skill', 'runs');
  const events = [];
  let runDirs;
  try {
    runDirs = await readdir(runsDir, { withFileTypes: true });
  } catch {
    return events;
  }
  for (const entry of runDirs.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory()) continue;
    let content;
    try {
      content = await readFile(join(runsDir, entry.name, 'evidence.jsonl'), 'utf8');
    } catch {
      continue;
    }
    for (const line of content.split('\n')) {
      if (line.trim().length === 0) continue;
      try {
        const event = JSON.parse(line);
        if (event !== null && typeof event === 'object' && !Array.isArray(event)) {
          events.push(event);
        }
      } catch {
        // malformed historical line: observation layer only, never fatal
      }
    }
  }
  return events;
}

/**
 * Build the NOT_CONFIGURED report (acceptance scenario 1).
 *
 * Reuses the first-time discovery result (facts + candidates) as a read-only
 * preview of what `release-skill setup` would propose, gives the precise
 * first-setup next step, and reports zero findings — missing optional hooks
 * are never treated as blockers.
 *
 * @param {string} root - Project root.
 * @param {string} configPath - Expected config path.
 * @returns {Promise<Object>} Frozen report.
 */
async function reportNotConfigured(root, configPath) {
  const facts = await discoverFacts(root);
  const candidates = buildCandidates(facts);
  const discovery = {
    gitRepository: facts.git.repository,
    unitCandidates: candidates.units.map((unit) => ({
      id: unit.id,
      source: unit.source,
      distributionCandidates: [...unit.distributionCandidates],
      publicRepoCandidates: [...unit.publicRepoCandidates],
    })),
    gateCandidates: candidates.gates.length,
  };
  const next = '项目尚未接入 release-skill。运行 release-skill setup（首次创建）或 setup --answers <file> 生成配置提案；评估只读，未修改任何文件。';
  return Object.freeze({
    command: 'release-setup',
    mode: 'adoption-assessment',
    status: ASSESSMENT_STATUS.NOT_CONFIGURED,
    configPath: null,
    configDigest: null,
    assessmentDigest: null,
    topology: { type: 'not-configured', releaseUnits: [], distributions: [] },
    findings: [],
    hookDurations: [],
    gateSuggestions: [],
    workflowPrerequisites: {
      full: { met: false, note: '缺少 .release-skill/project.yaml；先完成首次 setup。' },
      docs: { met: false, note: '缺少配置；docs-only 工作流分类由 release-route 决定。' },
      config: { met: false, note: '缺少配置。' },
      marketplace: { met: false, note: '缺少配置；插件渠道前提在配置存在后评估。' },
    },
    unobserved: [{
      field: '远端前提（npm/GitHub 可用性、发布标签序列）',
      note: '评估默认离线，未观测远端；不能据此否定本地接入，也不代表具备生产发布条件。',
    }],
    next,
    discovery,
    summary: [
      '项目: (尚未配置)',
      '接入状态: 尚未配置',
      '必选缺口 0 | 已满足 0 | 可选建议 0 | 不适用 0',
      `发现 ${discovery.unitCandidates.length} 个候选发布单元（只读预览，未写入）`,
      `下一步: ${next}`,
      '注意: 评估默认离线且只读，未访问远端，未修改任何文件。',
    ].join('\n'),
  });
}

/**
 * Map a config load failure to field-level findings (acceptance scenarios 2
 * and 4): never a bare CONFIG_INVALID. Schema errors carry their
 * instancePath; gate declaration errors (unknown unit, unknown channel,
 * duplicate ids) are scanned across ALL declared gates so the report lists
 * every invalid declaration, not just the first one the loader hit.
 *
 * @param {string} root - Project root.
 * @param {string} configPath - Config path.
 * @param {Object} error - ReleaseError with details.
 * @returns {Promise<Object>} Frozen report.
 */
async function reportConfigLoadError(root, configPath, error) {
  const findings = [];
  const details = error.details ?? {};
  if (Array.isArray(details.validationErrors)) {
    for (const validationError of details.validationErrors) {
      findings.push(createFinding({
        category: FINDING_CATEGORY.MANDATORY_GAP,
        code: 'CONFIG_INVALID',
        fieldPath: validationError.instancePath || '/',
        message: `配置字段不符合 Schema: ${validationError.message}`,
        evidence: { configPath, schemaPath: validationError.schemaPath },
        action: '修复该字段后重新运行 release-skill setup --assess-adoption。',
        severity: 'blocking',
      }));
    }
  }
  if (typeof details.gateId === 'string') {
    // 配置加载在第一个无效 gate 处停止；扫描全部声明，逐条列为阻断项。
    let scanned = [];
    try {
      const raw = await readFile(configPath, 'utf8');
      const parsed = YAML.parse(raw);
      scanned = scanGateDeclarationFindings({
        units: parsed?.releaseUnits ?? [],
        gates: parsed?.verificationGates ?? [],
      });
    } catch {
      scanned = [];
    }
    if (scanned.length > 0) {
      findings.push(...scanned);
    } else {
      findings.push(createFinding({
        category: FINDING_CATEGORY.MANDATORY_GAP,
        code: 'GATE_DECLARATION_INVALID',
        unitId: details.unitId,
        fieldPath: 'verificationGates[]',
        message: error.message,
        evidence: { gateId: details.gateId, unitId: details.unitId },
        action: '修正 verificationGates 声明（单元/渠道必须存在，id 不得重复）后重新评估。',
        severity: 'blocking',
      }));
    }
  }
  if (findings.length === 0) {
    findings.push(createFinding({
      category: FINDING_CATEGORY.MANDATORY_GAP,
      code: 'CONFIG_INVALID',
      fieldPath: '/',
      message: error.message,
      evidence: { configPath },
      action: '修复配置后重新运行 release-skill setup --assess-adoption。',
      severity: 'blocking',
    }));
  }
  return Object.freeze({
    command: 'release-setup',
    mode: 'adoption-assessment',
    status: ASSESSMENT_STATUS.PARTIALLY_ADOPTED,
    configPath,
    configDigest: null,
    assessmentDigest: null,
    topology: { type: 'unknown', releaseUnits: [], distributions: [] },
    findings,
    hookDurations: [],
    gateSuggestions: [],
    workflowPrerequisites: {
      full: { met: false, note: '配置无法通过校验。' },
      docs: { met: false, note: '配置无法通过校验。' },
      config: { met: false, note: '配置无法通过校验。' },
      marketplace: { met: false, note: '配置无法通过校验。' },
    },
    unobserved: [{
      field: '远端前提（npm/GitHub 可用性、发布标签序列）',
      note: '评估默认离线，未观测远端；不能据此否定本地接入，也不代表具备生产发布条件。',
    }],
    summary: [
      '项目: (配置加载失败)',
      '接入状态: 部分接入（存在必选缺口）',
      `必选缺口 ${findings.length} | 已满足 0 | 可选建议 0 | 不适用 0`,
      ...findings.map((finding) => `  - [${finding.code}] ${finding.fieldPath ?? ''} ${finding.message}`),
      `下一步: 修复全部配置错误后重新运行 release-skill setup --assess-adoption。`,
      '注意: 评估默认离线且只读，未访问远端，未修改任何文件。',
    ].join('\n'),
    next: '修复全部配置错误后重新运行 release-skill setup --assess-adoption。',
  });
}

/**
 * WP-6 adoption assessment entry point (read-only, offline).
 *
 * Answers whether a project is fully adopted into the release workflow and
 * reports a four-category matrix (mandatory gaps / satisfied / optional
 * suggestions / not applicable), hook cost observations (R-11), structured
 * gate drafts for directly verifiable check commands (scenario 5), and the
 * precise next step. Never writes any file, never accesses the remote, and
 * never registers hooks/gates.
 *
 * @param {Object} options
 * @param {string} options.root - Absolute project root.
 * @returns {Promise<Object>} Adoption report.
 */
export async function assessAdoption({ root } = {}) {
  if (!root || typeof root !== 'string' || !isAbsolute(root)) {
    throw setupError(CONFIG_INVALID, 'assessment root must be an absolute path');
  }
  const rootReal = await realpath(root).catch((error) => {
    throw setupError(CONFIG_INVALID, `cannot resolve assessment root: ${error.message}`);
  });
  const configPath = join(rootReal, '.release-skill', 'project.yaml');

  let configExists = false;
  try {
    const stat = await lstat(configPath);
    configExists = stat.isFile() && !stat.isSymbolicLink();
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (!configExists) {
    return reportNotConfigured(rootReal, configPath);
  }

  let loaded;
  try {
    loaded = await loadProjectConfig({ root: rootReal });
  } catch (error) {
    if (error.code !== CONFIG_INVALID) throw error;
    return reportConfigLoadError(rootReal, configPath, error);
  }
  const { config, configDigest } = loaded;

  // --- Discovery facts (read-only) ---
  const facts = await discoverFacts(rootReal);
  const candidates = buildCandidates(facts);

  // --- Field-level authority facts (scenario 2) ---
  const findings = [];
  const declaredUnits = config.releaseUnits ?? [];
  // 裁决 17: 区分源仓与公开仓，只比较同类事实。公开仓声明只与同类事实
  // （单元的 package.json repository 声明）比较；git 远端是源仓侧观察，
  // 从不单独充当公开仓权威。默认离线：没有同类事实时标记未观测，不默认
  // 联网，也不宣称远端已核实。不新增仓库 registry。
  const workspaceGitRepos = [...new Set(
    facts.git.remotes.map((remote) => remote.repo).filter(Boolean),
  )].sort();
  const declaredSourceRepo = (
    typeof config.project?.sourceRepository === 'string'
    && config.project.sourceRepository.length > 0
  ) ? config.project.sourceRepository : null;
  for (const unit of declaredUnits) {
    const unitId = unit.id;
    const unitDir = resolve(rootReal, unit.source);

    // source directory
    if (await adoptionPathExists(unitDir)) {
      findings.push(createFinding({
        category: FINDING_CATEGORY.SATISFIED, code: 'UNIT_SOURCE_OK',
        unitId, fieldPath: 'releaseUnits[].source',
        message: `发布单元 "${unitId}" 的 source 目录存在。`,
        evidence: { source: unit.source },
      }));
    } else {
      findings.push(createFinding({
        category: FINDING_CATEGORY.MANDATORY_GAP, code: 'UNIT_SOURCE_MISSING',
        unitId, fieldPath: 'releaseUnits[].source',
        message: `发布单元 "${unitId}" 的 source 目录不存在: ${unit.source}`,
        evidence: { source: unit.source },
        action: '创建该目录，或修正 releaseUnits[].source。',
        severity: 'blocking',
      }));
    }

    // version source (unit-relative, same rule as prepare)
    const versionSource = unit.version?.source;
    if (typeof versionSource === 'string') {
      if (await adoptionPathExists(resolve(unitDir, versionSource))) {
        findings.push(createFinding({
          category: FINDING_CATEGORY.SATISFIED, code: 'VERSION_SOURCE_OK',
          unitId, fieldPath: 'releaseUnits[].version.source',
          message: `发布单元 "${unitId}" 的版本来源文件存在。`,
          evidence: { source: versionSource },
        }));
      } else {
        findings.push(createFinding({
          category: FINDING_CATEGORY.MANDATORY_GAP, code: 'VERSION_SOURCE_MISSING',
          unitId, fieldPath: 'releaseUnits[].version.source',
          message: `发布单元 "${unitId}" 的版本来源文件不存在: ${versionSource}`,
          evidence: { source: versionSource },
          action: '创建该文件，或修正 releaseUnits[].version.source。',
          severity: 'blocking',
        }));
      }
    }

    // public repo consistency (裁决 17): same-kind comparison only.
    const declaredRepo = unit.publicRepo;
    if (declaredRepo) {
      // 同类公开仓声明：单元目录下 package.json 的 repository 字段。
      const unitPackageRepos = [...new Set(
        facts.packages
          .filter((pkg) => pkg.directory === unit.source)
          .map((pkg) => pkg.repository)
          .filter(Boolean),
      )].sort();
      if (unitPackageRepos.includes(declaredRepo)) {
        findings.push(createFinding({
          category: FINDING_CATEGORY.SATISFIED, code: 'PUBLIC_REPO_DECLARED',
          unitId, fieldPath: 'releaseUnits[].publicRepo',
          message: `发布单元 "${unitId}" 声明的公开仓库与包元数据（package.json repository）一致。`,
          evidence: { declared: declaredRepo, packageRepository: unitPackageRepos },
        }));
      } else if (unitPackageRepos.length > 0) {
        findings.push(createFinding({
          category: FINDING_CATEGORY.MANDATORY_GAP, code: 'PUBLIC_REPO_CONFLICT',
          unitId, fieldPath: 'releaseUnits[].publicRepo',
          message: `发布单元 "${unitId}" 声明的公开仓库 ${declaredRepo} 与包元数据声明的公开仓库冲突: ${unitPackageRepos.join(', ')}`,
          evidence: { declared: declaredRepo, packageRepository: unitPackageRepos },
          action: '核对 package.json repository 与 releaseUnits[].publicRepo 后修正声明。',
          severity: 'blocking',
        }));
      } else if (workspaceGitRepos.includes(declaredRepo)) {
        findings.push(createFinding({
          category: FINDING_CATEGORY.SATISFIED, code: 'PUBLIC_REPO_DECLARED',
          unitId, fieldPath: 'releaseUnits[].publicRepo',
          message: `发布单元 "${unitId}" 声明的公开仓库与本地工作区仓库身份一致。`,
          evidence: { declared: declaredRepo, workspaceRepos: workspaceGitRepos },
        }));
      } else if (declaredSourceRepo && workspaceGitRepos.includes(declaredSourceRepo)) {
        findings.push(createFinding({
          category: FINDING_CATEGORY.SATISFIED, code: 'PUBLIC_REPO_DECLARED',
          unitId, fieldPath: 'releaseUnits[].publicRepo',
          message: `发布单元 "${unitId}" 已声明公开仓库；本地 git 身份与声明的源仓库 ${declaredSourceRepo} 一致（拆分仓拓扑），公开仓未本地观测（未宣称已核实）。`,
          evidence: { declared: declaredRepo, sourceRepository: declaredSourceRepo, unobserved: true },
        }));
      } else {
        findings.push(createFinding({
          category: FINDING_CATEGORY.SATISFIED, code: 'PUBLIC_REPO_DECLARED',
          unitId, fieldPath: 'releaseUnits[].publicRepo',
          message: `发布单元 "${unitId}" 已声明公开仓库；本地无同类公开仓事实可交叉验证（未观测，未联网核实）。`,
          evidence: { declared: declaredRepo, unobserved: true },
        }));
      }
    }

    // tag template declaration
    if (typeof unit.version?.tagTemplate === 'string' && unit.version.tagTemplate.includes('{version}')) {
      findings.push(createFinding({
        category: FINDING_CATEGORY.SATISFIED, code: 'TAG_TEMPLATE_DECLARED',
        unitId, fieldPath: 'releaseUnits[].version.tagTemplate',
        message: `发布单元 "${unitId}" 已声明标签模板（含 {version} 占位符）。`,
        evidence: { tagTemplate: unit.version.tagTemplate },
      }));
    }

    // distributions declaration + per-type prerequisite
    const distributionTypes = (unit.distributions ?? []).map((dist) => dist.type);
    findings.push(createFinding({
      category: FINDING_CATEGORY.SATISFIED, code: 'DISTRIBUTIONS_DECLARED',
      unitId, fieldPath: 'releaseUnits[].distributions',
      message: `发布单元 "${unitId}" 已声明分发渠道: ${distributionTypes.join(', ') || '(无)'}`,
      evidence: { types: distributionTypes },
    }));

    // previousPublicBaseline declaration
    if (unit.previousPublicBaseline) {
      findings.push(createFinding({
        category: FINDING_CATEGORY.SATISFIED, code: 'PREVIOUS_BASELINE_DECLARED',
        unitId, fieldPath: 'releaseUnits[].previousPublicBaseline',
        message: `发布单元 "${unitId}" 已声明上一公开基线（mode: ${unit.previousPublicBaseline.mode}）。`,
        evidence: { mode: unit.previousPublicBaseline.mode },
      }));
    }

    // publicFiles[].from existence (root-relative canonical public paths)
    const publicFileMappings = unit.publicFiles ?? [];
    for (const mapping of publicFileMappings) {
      if (typeof mapping?.from !== 'string') continue;
      if (await adoptionPathExists(resolve(rootReal, mapping.from))) continue;
      findings.push(createFinding({
        category: FINDING_CATEGORY.MANDATORY_GAP, code: 'PUBLIC_FILE_MISSING',
        unitId, fieldPath: 'releaseUnits[].publicFiles[].from',
        message: `发布单元 "${unitId}" 的公开文件输入不存在: ${mapping.from}`,
        evidence: { from: mapping.from, to: mapping.to },
        action: '创建该文件，或修正 releaseUnits[].publicFiles[].from。',
        severity: 'blocking',
      }));
    }
    for (const required of unit.requiredPublicFiles ?? []) {
      if (typeof required?.from !== 'string') continue;
      if (await adoptionPathExists(resolve(rootReal, required.from))) continue;
      findings.push(createFinding({
        category: FINDING_CATEGORY.MANDATORY_GAP, code: 'REQUIRED_PUBLIC_FILE_MISSING',
        unitId, fieldPath: 'releaseUnits[].requiredPublicFiles[].from',
        message: `发布单元 "${unitId}" 的必选公开文件输入不存在: ${required.from}`,
        evidence: { from: required.from },
        action: '创建该文件，或修正 releaseUnits[].requiredPublicFiles[].from。',
        severity: 'blocking',
      }));
    }
    if (
      publicFileMappings.length > 0
      && (await Promise.all(publicFileMappings
        .filter((mapping) => typeof mapping?.from === 'string')
        .map((mapping) => adoptionPathExists(resolve(rootReal, mapping.from)))))
        .every(Boolean)
    ) {
      findings.push(createFinding({
        category: FINDING_CATEGORY.SATISFIED, code: 'PUBLIC_FILES_OK',
        unitId, fieldPath: 'releaseUnits[].publicFiles',
        message: `发布单元 "${unitId}" 的公开文件输入全部存在。`,
        evidence: { count: publicFileMappings.length },
      }));
    }

    // postPublish declaration validity (scenario 4: unknown presets etc.)
    if (unit.postPublish !== undefined) {
      try {
        validatePostPublishDeclaration(unit.postPublish, { unitId });
        findings.push(createFinding({
          category: FINDING_CATEGORY.SATISFIED, code: 'POSTPUBLISH_DECLARED_VALID',
          unitId, fieldPath: 'releaseUnits[].postPublish',
          message: `发布单元 "${unitId}" 的 postPublish 声明通过 fail-closed 校验。`,
        }));
      } catch (error) {
        findings.push(createFinding({
          category: FINDING_CATEGORY.MANDATORY_GAP, code: 'POSTPUBLISH_INVALID',
          unitId, fieldPath: 'releaseUnits[].postPublish',
          message: `发布单元 "${unitId}" 的 postPublish 声明无效: ${error.message}`,
          evidence: { unitId, error: error.message },
          action: '修正 postPublish 声明（preset 必须存在、target/hook id 不得重复冲突）后重新评估。',
          severity: 'blocking',
        }));
      }
    } else {
      findings.push(createFinding({
        category: FINDING_CATEGORY.NOT_APPLICABLE, code: 'POSTPUBLISH_NOT_DECLARED',
        unitId, fieldPath: 'releaseUnits[].postPublish',
        message: `发布单元 "${unitId}" 未声明 postPublish（可选扩展，不影响接入）。`,
      }));
    }
  }

  // --- Project-level declarations ---
  findings.push(createFinding({
    category: FINDING_CATEGORY.SATISFIED, code: 'CONFIG_VALID',
    fieldPath: '.release-skill/project.yaml',
    message: '配置存在并通过 Schema 校验。',
    evidence: { configDigest },
  }));

  // 多发布单元 postPublish v3（设计 §9.2/§9.7；返工 R-02）：多个发布单元
  // 各自声明 postPublish 本身不再构成缺口——每个声明的字段级校验已在上面
  // 逐项完成。仍失败关闭的只有：声明内容无效（POSTPUBLISH_INVALID，逐项
  // 报告）与整份计划显式 hooks[].id 跨单元重复（(planDigest, hookId) 批准
  // 合同要求全局唯一；target 与内部 probe 的本地 ID 可跨单元重复，检查点
  // 以 unitId 区分）。唯一校验真源是 core/postpublish.mjs 的
  // validatePostPublishHookIdUniqueness——本入口只做输入归一（收集各单元的
  // 声明块）并调用同一函数，再把领域事实转成评估 finding。
  const declaredPostPublishBlocks = declaredUnits
    .filter((unit) => unit.postPublish !== undefined)
    .map((unit) => ({ ...unit.postPublish, unitId: unit.id }));
  try {
    validatePostPublishHookIdUniqueness(declaredPostPublishBlocks);
  } catch (error) {
    if (error?.details?.hookId !== undefined && Array.isArray(error?.details?.unitIds)) {
      const [owner, unitId] = error.details.unitIds;
      findings.push(createFinding({
        category: FINDING_CATEGORY.MANDATORY_GAP, code: 'POSTPUBLISH_HOOK_ID_DUPLICATE',
        unitId, fieldPath: 'releaseUnits[].postPublish.hooks[].id',
        message: `postPublish 显式 hook id "${error.details.hookId}" 同时由发布单元 "${owner}" 与 "${unitId}" 声明；整份计划的显式 hooks[].id 必须唯一（target 与内部 probe 的本地 ID 可跨单元重复）。`,
        evidence: { hookId: error.details.hookId, unitIds: error.details.unitIds },
        action: '为重复的显式 hook id 改名（或合并声明）后重新评估。',
        severity: 'blocking',
      }));
    }
  }

  // 裁决 20: 评估复用实际 Hook 校验（core/hooks.mjs 的纯校验函数，不调用
  // runHook、不复制第二套 validator）；运行时会被拒绝的声明在评估里就是
  // 字段级必选缺口，不能误报已接入。零命令执行。
  if (config.hooks !== undefined) {
    const invalidHooks = [];
    for (const [name, hook] of Object.entries(config.hooks)) {
      try {
        validateHook(hook);
      } catch (error) {
        invalidHooks.push({ name, error });
      }
    }
    if (invalidHooks.length === 0) {
      findings.push(createFinding({
        category: FINDING_CATEGORY.SATISFIED, code: 'HOOKS_DECLARED_VALID',
        fieldPath: 'hooks',
        message: `已声明 hooks: ${Object.keys(config.hooks).join(', ')}（Schema 与运行时校验均通过）。`,
        evidence: { hooks: Object.keys(config.hooks).sort() },
      }));
    } else {
      for (const { name, error } of invalidHooks) {
        findings.push(createFinding({
          category: FINDING_CATEGORY.MANDATORY_GAP, code: 'HOOK_DECLARATION_INVALID',
          fieldPath: `hooks.${name}`,
          message: `hook "${name}" 声明无效: ${error.message}`,
          evidence: { hookName: name },
          action: '修正 hooks 声明（cacheable=true 必须提供非空 cacheInputs 等）后重新评估。',
          severity: 'blocking',
        }));
      }
    }
  } else {
    findings.push(createFinding({
      category: FINDING_CATEGORY.NOT_APPLICABLE, code: 'HOOKS_NOT_DECLARED',
      fieldPath: 'hooks',
      message: '未声明 hooks（可选扩展，不影响接入）。',
    }));
  }
  if (Array.isArray(config.verificationGates)) {
    findings.push(createFinding({
      category: FINDING_CATEGORY.SATISFIED, code: 'VERIFICATION_GATES_DECLARED_VALID',
      fieldPath: 'verificationGates',
      message: `已声明 ${config.verificationGates.length} 个 verificationGates（加载期已校验单元/渠道/id 唯一性）。`,
      evidence: { count: config.verificationGates.length },
    }));
  } else {
    findings.push(createFinding({
      category: FINDING_CATEGORY.NOT_APPLICABLE, code: 'VERIFICATION_GATES_NOT_DECLARED',
      fieldPath: 'verificationGates',
      message: '未声明 verificationGates（可选扩展，不影响接入）。',
    }));
  }

  // --- Assess checks (offline; only the four local check families) ---
  const assessGaps = (await Promise.all([
    checkCommonDocs(rootReal, config),
    checkPluginManifests(rootReal, config),
    checkPackageMetadata(rootReal, config),
    checkReadmeStructure(rootReal, config),
  ])).flat();
  for (const gap of assessGaps) {
    findings.push(createFinding({
      category: classifyGapCategory(gap.severity),
      code: gap.code,
      message: gap.message,
      evidence: { file: gap.file, scope: gap.scope, category: gap.category },
      action: classifyGapCategory(gap.severity) === FINDING_CATEGORY.MANDATORY_GAP
        ? '补齐该文件或修正相关配置后重新评估。'
        : '可选改进；人工确认后再决定是否采纳。',
      severity: gap.severity === 'error' ? 'blocking' : 'suggestion',
    }));
  }

  // --- R-11: hook cost observations from trusted evidence (裁决 18:
  // description-matched pairing only; the current declared hooks supply the
  // current normalized description) ---
  const hookDurations = deriveHookDurations({
    events: await readEvidenceEvents(rootReal),
    declaredHooks: config.hooks ?? {},
    currentProducerVersion: resolveProducerVersion(),
  });
  findings.push(...deriveLongHookSuggestions(hookDurations));
  findings.push(...deriveCheckOnlySuggestions(config.hooks));

  // --- Gate suggestions (scenarios 5 & 6) ---
  const gateSuggestions = deriveGateSuggestions({ declaredUnits, candidates });

  const hasBlocking = findings.some((f) => f.category === FINDING_CATEGORY.MANDATORY_GAP);
  const next = hasBlocking
    ? '修复全部必选缺口后重新运行 release-skill setup --assess-adoption。'
    : null;

  return buildAssessmentReport({
    config,
    configPath,
    configDigest,
    facts,
    findings,
    hookDurations,
    gateSuggestions,
    next,
  });
}
