/**
 * Prepare command: freeze a release plan with snapshots and gates.
 *
 * Runs the full prepare pipeline in order:
 * 1. Load and validate project configuration
 * 1b. Resolve authoritative versions and gate release-document freshness
 *     (read-only; blocks stale docs before hooks, baseline, snapshots,
 *     remote checks, and plan write; re-checked after hooks)
 * 2. Capture Git baseline (HEAD, tree hash, dirty files)
 * 3. Run project-declared hooks (build, test)
 * 4. For each release unit: build snapshot, scan for leakage, evaluate README
 * 5. Check remote tag / version uniqueness (skipped in --offline mode)
 * 6. Assemble and validate the release plan against the plan schema
 * 7. Write the plan atomically
 *
 * If any gate fails, no PREPARED plan is written.
 *
 * @module commands/prepare
 */

import { resolve, relative, isAbsolute, normalize, dirname } from 'node:path';
import { readFile, mkdir, realpath } from 'node:fs/promises';
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';

const execFile = promisify(execFileCb);

import { loadProjectConfig } from '../core/config.mjs';
import { captureBaseline } from '../core/baseline.mjs';
import { runHook } from '../core/hooks.mjs';
import { computeHookCacheKey, readHookCache, writeHookCache } from '../core/hook-cache.mjs';
import { runSnapshotVerificationGates } from '../core/verification-gates.mjs';
import { createEvidenceWriter } from '../core/evidence.mjs';
import { computePlanDigest, writePlanAtomic, writePlanImmutable } from '../core/plan.mjs';
import { sha256Hex } from '../core/digest.mjs';
import {
  CHECKER_VERSION as SKILL_RESOURCE_CHECKER_VERSION,
  checkSkillResourceClosure,
  createSkillResourceClosureReceipt,
} from '../core/skill-resource-closure.mjs';
import { buildPublicStaging } from '../snapshot/public-map.mjs';
import { resolveUnitScopedPath } from '../snapshot/public-path.mjs';
import { scanSnapshot } from '../snapshot/scan.mjs';
import { evaluateReadme } from '../readme/contract.mjs';
import {
  buildFrozenGitRepository,
  buildFrozenNpmTarball,
  computeFrozenSnapshot,
  normalizeGitTimestamp,
  sealFrozenSnapshot,
} from '../snapshot/frozen.mjs';
import { ReleaseError, GATE_FAILED, CONFIG_INVALID, CONFIG_MISSING, FORBIDDEN_CONTENT_DETECTED, RELEASE_DOCS_STALE, DIRTY_SOURCE_INPUT } from '../core/errors.mjs';
import {
  SOURCE_INPUT_ALGORITHM_VERSION,
  computeSourceInputClosure,
  checkSourceInputDirty,
  verifySnapshotSourcesMatchClosure,
} from '../core/source-authority.mjs';
import { acquireProjectLock } from '../artifacts/project-lock.mjs';
import { assertPreviousPublicBaselineTarget, observePreviousPublicBaseline } from '../core/previous-public-baseline.mjs';
import { verifyFrozenNpmTarballIdentity } from '../adapters/npm.mjs';
import { createProductionPrepareRunDir } from '../core/run.mjs';
import { PLATFORMS } from '../platforms/registry.mjs';
import { validateMarketplaceSourceSelection, MARKETPLACE_SOURCE_TYPES, resolvePluginManifestFromMarketplaceEntrySource, resolveMarketplaceRoot } from '../adapters/plugin-marketplace.mjs';
import { buildInstallationContract, computeInstallationContractDigest, INSTALLATION_CONTRACT_ALGORITHM_VERSION } from '../core/installation-contract.mjs';

// ---------------------------------------------------------------------------
// 安装契约常量
// ---------------------------------------------------------------------------

/** 消费端安装验证配方版本。算法变更时递增。 */
const CONSUMER_INSTALL_RECIPE_VERSION = 'consumer-install-v1';

// ---------------------------------------------------------------------------
// Version resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the target version for a release unit.
 *
 * Resolution rules:
 * 1. The version is read AUTHORITATIVELY from
 *    `<root>/<unit.source>/<unit.version.source>`; it is never overridden.
 * 2. An explicitVersion (when provided) is only a consistency ASSERTION:
 *    a mismatch fails closed with GATE_FAILED.
 * 3. Reject: absolute path, path escape, missing file, invalid JSON,
 *    missing/empty version field.
 * 4. For v0.1: if multiple units resolve to different versions, fail closed.
 *
 * @param {object} unit - The release unit configuration.
 * @param {string} root - Absolute project root.
 * @param {string} [explicitVersion] - Explicit version consistency assertion.
 * @returns {Promise<string>} The resolved authoritative version string.
 * @throws {ReleaseError} CONFIG_INVALID or GATE_FAILED on any validation failure.
 */
export async function resolveUnitVersion(unit, root, explicitVersion) {
  // Validate unit.version.source exists
  const versionSource = unit.version?.source;
  if (!versionSource || typeof versionSource !== 'string') {
    throw new ReleaseError(
      CONFIG_INVALID,
      `unit "${unit.id}" missing version.source configuration`,
      { unitId: unit.id },
    );
  }

  // Reject absolute paths
  if (isAbsolute(versionSource)) {
    throw new ReleaseError(
      CONFIG_INVALID,
      `unit "${unit.id}" version.source must be a relative path, got absolute: "${versionSource}"`,
      { unitId: unit.id, versionSource },
    );
  }

  // Resolve and normalize the path
  const unitRoot = resolve(root, unit.source);
  const resolvedPath = resolve(unitRoot, versionSource);
  const normalizedPath = normalize(resolvedPath);

  // Reject path escapes (must stay within unit root)
  const rel = relative(unitRoot, normalizedPath);
  if (rel.startsWith('..') || rel === '..' || isAbsolute(rel)) {
    throw new ReleaseError(
      CONFIG_INVALID,
      `unit "${unit.id}" version.source escapes unit root: "${versionSource}"`,
      { unitId: unit.id, versionSource, resolved: normalizedPath },
    );
  }

  // Read the file
  let content;
  try {
    content = await readFile(normalizedPath, 'utf8');
  } catch (err) {
    throw new ReleaseError(
      CONFIG_INVALID,
      `unit "${unit.id}" cannot read version file "${versionSource}": ${err.message}`,
      { unitId: unit.id, versionSource, cause: err.code },
    );
  }

  // Parse JSON
  let pkg;
  try {
    pkg = JSON.parse(content);
  } catch (err) {
    throw new ReleaseError(
      CONFIG_INVALID,
      `unit "${unit.id}" invalid JSON in "${versionSource}": ${err.message}`,
      { unitId: unit.id, versionSource },
    );
  }

  // Extract version field
  const version = pkg?.version;
  if (!version || typeof version !== 'string' || version.trim().length === 0) {
    throw new ReleaseError(
      CONFIG_INVALID,
      `unit "${unit.id}" missing or empty version field in "${versionSource}"`,
      { unitId: unit.id, versionSource, found: version },
    );
  }

  const authoritativeVersion = version.trim();
  if (explicitVersion && explicitVersion !== authoritativeVersion) {
    throw new ReleaseError(
      GATE_FAILED,
      `unit "${unit.id}" explicit version "${explicitVersion}" does not match authoritative version "${authoritativeVersion}" from "${versionSource}"`,
      { unitId: unit.id, explicitVersion, authoritativeVersion, versionSource },
    );
  }

  return authoritativeVersion;
}

/**
 * Resolve versions for all release units independently.
 *
 * @param {object[]} units - Array of release unit configurations.
 * @param {string} root - Absolute project root.
 * @param {string} [explicitVersion] - Explicit version override.
 * @param {object} evidence - The evidence writer.
 * @returns {Promise<string[]>} Array of resolved versions (one per unit).
 * @throws {ReleaseError} CONFIG_INVALID or GATE_FAILED on any validation failure.
 */
export async function resolveAllUnitVersions(units, root, explicitVersion, evidence) {
  await evidence.append({ phase: 'version-resolution', status: 'started' });

  const resolvedVersions = [];
  for (const unit of units) {
    try {
      const version = await resolveUnitVersion(unit, root, explicitVersion);
      resolvedVersions.push(version);

    } catch (err) {
      await evidence.append({
        phase: 'version-resolution',
        status: 'failed',
        unitId: unit.id,
        error: { code: err.code, message: err.message },
      });
      throw err;
    }
  }

  await evidence.append({
    phase: 'version-resolution',
    status: 'completed',
    unitCount: units.length,
    resolvedVersions: Object.fromEntries(units.map((unit, index) => [unit.id, resolvedVersions[index]])),
    explicitVersion: !!explicitVersion,
  });

  return resolvedVersions;
}

// ---------------------------------------------------------------------------
// Hooks execution
// ---------------------------------------------------------------------------

/**
 * Run all declared project hooks in order: docs, build, test, typecheck.
 *
 * Incremental cache (T3.2): a hook that opts in with `cacheable: true` and a
 * non-empty `cacheInputs` is fingerprinted by its configuration plus the
 * content of every matched input file. On an unchanged fingerprint whose last
 * run succeeded, execution is skipped and the cached outcome replayed. The
 * cache only ever skips execution — it runs after the hook authorization gate
 * and never bypasses any GATE; hook order and failure semantics are unchanged.
 * Failures (non-zero exit or HOOK_TIMEOUT) are never cached. A `cacheInputs`
 * glob that matches nothing fails closed before the hook runs.
 *
 * @param {object} config - The loaded project config.
 * @param {string} root - Absolute project root.
 * @param {object} evidence - The evidence writer.
 * @param {Function} [hookFn] - Hook runner (default runHook); tests inject a
 *   spy that records call order while delegating to the real implementation.
 * @param {object} [options]
 * @param {boolean} [options.hookCache=true] - When false (--no-hook-cache),
 *   every hook runs in full and the cache is neither read nor written.
 * @returns {Promise<void>}
 * @throws {ReleaseError} GATE_FAILED if any hook returns a non-zero exit code,
 *   throws, or declares a cacheInputs glob that matches no file.
 */
export async function runDeclaredHooks(config, root, evidence, hookFn = runHook, options = {}) {
  const hookOrder = ['docs', 'build', 'test', 'typecheck'];
  const hooks = config.hooks ?? {};
  const cacheEnabled = options.hookCache !== false;

  for (const name of hookOrder) {
    const hook = hooks[name];
    if (!hook) continue;

    await evidence.append({
      phase: 'hooks',
      status: 'started',
      hookName: name,
    });

    // --- Incremental cache lookup (opt-in only; default zero change) ---
    let cacheKey;
    if (cacheEnabled && hook.cacheable === true) {
      try {
        ({ cacheKey } = await computeHookCacheKey(hook, root));
      } catch (err) {
        await evidence.append({
          phase: 'hooks',
          status: 'failed',
          hookName: name,
          error: { code: err.code, message: err.message },
        });
        throw err;
      }

      const cached = await readHookCache(root, name, cacheKey);
      if (cached) {
        // Cache hit: skip execution. The authorization gate already passed and
        // no GATE is bypassed — ordering and failure semantics are untouched.
        await evidence.append({
          phase: 'hooks',
          status: 'completed',
          hookName: name,
          cached: true,
          cacheKey,
        });
        continue;
      }
    }

    let result;
    try {
      result = await hookFn(hook, { root });
    } catch (err) {
      await evidence.append({
        phase: 'hooks',
        status: 'failed',
        hookName: name,
        error: { code: err.code, message: err.message },
      });
      throw new ReleaseError(
        GATE_FAILED,
        `hook "${name}" failed: ${err.message}`,
        { hookName: name, cause: err.code },
      );
    }

    if (result.exitCode !== 0) {
      await evidence.append({
        phase: 'hooks',
        status: 'failed',
        hookName: name,
        exitCode: result.exitCode,
        // Test runners usually emit the actionable failure summary at the
        // end. Preserve bounded tails of both streams instead of the noisy
        // compiler prelude at the beginning.
        stdoutTail: result.stdout.slice(-4000),
        stderrTail: result.stderr.slice(-4000),
      });
      throw new ReleaseError(
        GATE_FAILED,
        `hook "${name}" exited with code ${result.exitCode}`,
        { hookName: name, exitCode: result.exitCode },
      );
    }

    // --- Write cache on success only; failures are never cached ---
    if (cacheEnabled && hook.cacheable === true && cacheKey) {
      const written = await writeHookCache(root, name, cacheKey, {
        exitCode: 0,
        stdoutTail: result.stdout.slice(-4000),
        stderrTail: result.stderr.slice(-4000),
      });
      if (!written.ok) {
        // The cache is an optimisation, not a gate: a write failure must not
        // abort prepare. Surface it as a warning-level evidence event.
        await evidence.append({
          phase: 'hooks',
          status: 'warning',
          hookName: name,
          warning: 'hook cache write failed; continuing without caching',
          error: written.error,
        });
      }
    }

    await evidence.append({
      phase: 'hooks',
      status: 'completed',
      hookName: name,
      exitCode: 0,
    });
  }
}

// ---------------------------------------------------------------------------
// Release-documents freshness gate
// ---------------------------------------------------------------------------

/**
 * Resolve the release-documents planner the freshness gate runs with.
 *
 * An injected planner (test spy or documented bypass) is returned unchanged.
 * Otherwise the default planner is loaded LAZILY from the refresh service:
 * src/docs/** joins the published package snapshot at the public-asset
 * generation stage, so prepare.mjs must not carry a static import of it —
 * every staged runtime file must stay importable from the minimal public
 * distribution. The load happens only when a release unit actually
 * configures releaseDocuments, and an unavailable module fails closed —
 * the freshness gate is never silently skipped.
 *
 * @param {Function} [injected] - Injected planner (takes precedence).
 * @returns {Promise<Function>} The planner to use.
 * @throws {ReleaseError} GATE_FAILED when the default planner is unavailable.
 */
async function resolveReleaseDocsPlanFn(injected) {
  if (typeof injected === 'function') return injected;
  let loaded;
  try {
    loaded = await import('../docs/refresh-service.mjs');
  } catch (err) {
    throw new ReleaseError(
      GATE_FAILED,
      'the release-documents refresh planner is unavailable; the freshness gate cannot run',
      { reason: 'RELEASE_DOCS_PLAN_UNAVAILABLE', cause: err?.code ?? 'UNKNOWN' },
    );
  }
  if (typeof loaded.planReleaseDocsRefreshForUnit !== 'function') {
    throw new ReleaseError(
      GATE_FAILED,
      'the release-documents refresh planner is unavailable; the freshness gate cannot run',
      { reason: 'RELEASE_DOCS_PLAN_UNAVAILABLE' },
    );
  }
  return loaded.planReleaseDocsRefreshForUnit;
}

/**
 * Read-only release-documents freshness gate
 * (2026-07-21-release-docs-command-and-prepare-gate §5).
 *
 * Runs the SAME read-only refresh planner the standalone `docs refresh`
 * dry-run uses, for every release unit that configures `releaseDocuments`:
 *
 * - no unit configures releaseDocuments → no check runs and no
 *   docs-freshness evidence is appended (legacy behaviour preserved);
 * - a clean unit appends a `completed` docs-freshness event carrying its
 *   unitId and refreshDigest;
 * - the first `changes` result appends a `blocking` event and throws
 *   RELEASE_DOCS_STALE with the exact dry-run/write argv the operator needs
 *   to refresh (canonical relative paths only — never bodies, absolute
 *   paths, or serialized bytes).
 *
 * When `expectedBindings` is supplied (the post-hook pass), a plan that
 * re-renders clean is STILL compared against the pre-hook binding: hooks
 * run as arbitrary local processes and may rewrite bytes the renderers
 * deliberately preserve (for example text outside the managed regions).
 * Any divergence from the validated binding — the refreshDigest or any
 * per-target old digest — fails closed with RELEASE_DOCS_STALE so an
 * inconsistent plan can never be frozen.
 *
 * The gate is strictly read-only: prepare never writes README/CHANGELOG
 * implicitly. Refreshed bytes enter the baseline/workspace/snapshot/plan
 * digests through the standalone docs command, which naturally invalidates
 * approvals bound to the pre-refresh plan digest.
 *
 * @param {object} options
 * @param {object[]} options.units - Release units from the loaded config.
 * @param {string[]} options.resolvedVersions - Authoritative versions,
 *   index-aligned with `units` (resolved once before hooks, reused after).
 * @param {string} options.root - Absolute project root.
 * @param {object} options.config - The loaded project config.
 * @param {object} options.evidence - The evidence writer.
 * @param {Function} [options.planFn] - Read-only planner; tests inject spies
 *   or documented bypasses. When omitted, the shared
 *   planReleaseDocsRefreshForUnit is loaded lazily (see
 *   resolveReleaseDocsPlanFn — keeps the public boundary import-clean and
 *   fails closed when unavailable).
 * @param {string} options.reasonTag - Gate-pass identifier bound into the
 *   evidence and error details ('RELEASE_DOCS_STALE' before hooks,
 *   'CHANGES_AFTER_HOOKS' after hooks).
 * @param {Map<string, { refreshDigest: string, files: Map<string, string> }>}
 *   [options.expectedBindings] - Pre-hook bindings (unitId → refreshDigest +
 *   canonical target path → old digest) the post-hook pass fails closed
 *   against. Omitted on the pre-hook pass.
 * @returns {Promise<Map<string, { refreshDigest: string, files: Map<string, string> }>>}
 *   The bindings observed on this pass (empty when no unit configures
 *   releaseDocuments); the pre-hook pass result feeds the post-hook pass.
 * @throws {ReleaseError} RELEASE_DOCS_STALE when any configured unit is stale
 *   or drifted from the expected binding.
 */
async function runReleaseDocsFreshnessGate({
  units,
  resolvedVersions,
  root,
  config,
  evidence,
  planFn,
  reasonTag,
  expectedBindings = null,
}) {
  const configured = [];
  for (let index = 0; index < units.length; index += 1) {
    const unit = units[index];
    if (unit && unit.releaseDocuments !== undefined && unit.releaseDocuments !== null) {
      configured.push({ unit, index });
    }
  }
  const bindings = new Map();
  if (configured.length === 0) return bindings;

  const effectivePlanFn = await resolveReleaseDocsPlanFn(planFn);

  await evidence.append({ phase: 'docs-freshness', status: 'started', reasonTag });

  for (const { unit, index } of configured) {
    const { display } = await effectivePlanFn({
      root,
      config,
      unit,
      version: resolvedVersions[index],
    });

    bindings.set(unit.id, {
      refreshDigest: display.refreshDigest,
      files: new Map(display.files.map((file) => [file.path, file.oldDigest])),
    });

    if (display.status === 'clean') {
      // Bound-change detection (post-hook pass): a hook may rewrite bytes
      // the renderers preserve, which still re-plan clean. Compare against
      // the pre-hook binding and fail closed on ANY divergence.
      const expected = expectedBindings?.get(unit.id);
      const driftedFiles = expected
        ? display.files.filter((file) => expected.files.get(file.path) !== file.oldDigest)
        : [];
      if (expected && (display.refreshDigest !== expected.refreshDigest || driftedFiles.length > 0)) {
        await evidence.append({
          phase: 'docs-freshness',
          status: 'blocking',
          unitId: unit.id,
          reason: reasonTag,
          refreshDigest: display.refreshDigest,
          changedPaths: driftedFiles.map((file) => file.path),
        });
        throw new ReleaseError(
          RELEASE_DOCS_STALE,
          `release documents for unit "${unit.id}" changed after hooks`,
          {
            reason: reasonTag,
            unitId: unit.id,
            version: resolvedVersions[index],
            refreshDigest: display.refreshDigest,
            changedPaths: driftedFiles.map((file) => file.path),
            files: driftedFiles.map(({ path, kind, locale, change, oldDigest, newDigest }) => ({
              path,
              kind,
              locale,
              change,
              oldDigest,
              newDigest,
            })),
            dryRunArgv: [...display.nextCommand.argv],
            writeArgv: display.nextCommand.writeArgv ? [...display.nextCommand.writeArgv] : null,
          },
        );
      }
      await evidence.append({
        phase: 'docs-freshness',
        status: 'completed',
        unitId: unit.id,
        refreshDigest: display.refreshDigest,
      });
      continue;
    }

    const changedFiles = display.files.filter((file) => file.changed);
    await evidence.append({
      phase: 'docs-freshness',
      status: 'blocking',
      unitId: unit.id,
      reason: reasonTag,
      refreshDigest: display.refreshDigest,
      changedPaths: changedFiles.map((file) => file.path),
    });
    throw new ReleaseError(
      RELEASE_DOCS_STALE,
      `release documents are stale for unit "${unit.id}"`,
      {
        reason: reasonTag,
        unitId: unit.id,
        version: resolvedVersions[index],
        refreshDigest: display.refreshDigest,
        changedPaths: changedFiles.map((file) => file.path),
        files: changedFiles.map(({ path, kind, locale, change, oldDigest, newDigest }) => ({
          path,
          kind,
          locale,
          change,
          oldDigest,
          newDigest,
        })),
        dryRunArgv: [...display.nextCommand.argv],
        writeArgv: [...display.nextCommand.writeArgv],
      },
    );
  }

  return bindings;
}

// ---------------------------------------------------------------------------
// Snapshot pipeline
// ---------------------------------------------------------------------------

/**
 * Build snapshots for all release units, scan for leakage, and evaluate README.
 *
 * @param {object} config - The loaded project config.
 * @param {string} root - Absolute project root.
 * @param {object} evidence - The evidence writer.
 * @param {string} runDir - The run directory for temp snapshot storage.
 * @returns {Promise<{ unitResults: object[], snapshotDigests: string[] }>}
 * @throws {ReleaseError} GATE_FAILED on any snapshot/scan/readme gate failure.
 */
async function processSnapshots(config, root, evidence, runDir, production = false) {
  const units = config.releaseUnits ?? [];
  const unitResults = [];
  const snapshotDigests = [];

  for (const unit of units) {
    const outputDir = resolveUnitScopedPath(resolve(runDir, 'snapshots'), unit.id);

    // --- Build snapshot ---
    await evidence.append({
      phase: 'snapshot',
      status: 'started',
      unitId: unit.id,
      source: unit.source,
    });

    let manifest;
    try {
      // All units use explicit public file mappings — no implicit
      // git/package.json collection.
      const publicManifest = await buildPublicStaging({
        sourceRoot: root,
        unit,
        outputDir,
      });
      // Adapt the public manifest to the shape expected by downstream code.
      manifest = {
        entries: publicManifest.entries,
        files: publicManifest.entries.map((e) => e.path).sort(),
        totalSize: publicManifest.totalSize,
        fileCount: publicManifest.fileCount,
        contentHash: publicManifest.contentHash,
        snapshotDigest: publicManifest.contentHash,
        source: unit.source,
        outputDir: publicManifest.outputDir,
      };
    } catch (err) {
      await evidence.append({
        phase: 'snapshot',
        status: 'failed',
        unitId: unit.id,
        error: { code: err.code, message: err.message },
      });
      // Preserve original stable error codes (PUBLIC_FILE_MISSING,
      // SNAPSHOT_FIDELITY_FAILED, etc.) — do not wrap into GATE_FAILED.
      throw err;
    }

    snapshotDigests.push(manifest.snapshotDigest);

    await evidence.append({
      phase: 'snapshot',
      status: 'completed',
      unitId: unit.id,
      snapshotDigest: manifest.snapshotDigest,
      fileCount: manifest.fileCount,
      totalSize: manifest.totalSize,
    });

    // --- Scan for leakage ---
    await evidence.append({
      phase: 'scan',
      status: 'started',
      unitId: unit.id,
    });

    const findings = await scanSnapshot({
      snapshotDir: outputDir,
      policy: {
        forbiddenPaths: config.policy?.forbiddenPaths ?? [],
        forbiddenContentPatterns: config.policy?.forbiddenContentPatterns ?? [],
      },
    });

    // Check for fatal findings (secrets, forbidden paths, forbidden content)
    const FATAL_KINDS = new Set(['SECRET_DETECTED', 'PUBLIC_PATH_FORBIDDEN', 'FORBIDDEN_CONTENT_DETECTED']);
    const fatalFindings = findings.filter((f) => FATAL_KINDS.has(f.kind));

    if (fatalFindings.length > 0) {
      await evidence.append({
        phase: 'scan',
        status: 'failed',
        unitId: unit.id,
        findings: fatalFindings.map((f) => ({
          kind: f.kind,
          file: f.file,
          line: f.line,
          message: f.message,
        })),
      });

      // Use the specific error code for the first finding kind
      const primaryKind = fatalFindings[0].kind;
      const errorCode = primaryKind === 'FORBIDDEN_CONTENT_DETECTED'
        ? FORBIDDEN_CONTENT_DETECTED
        : GATE_FAILED;
      throw new ReleaseError(
        errorCode,
        `leakage scan failed for unit "${unit.id}": ${fatalFindings.length} finding(s)`,
        { unitId: unit.id, findings: fatalFindings },
      );
    }

    // Non-fatal findings (stale build artifacts) are logged but allowed
    const nonFatalFindings = findings.filter((f) => !FATAL_KINDS.has(f.kind));

    await evidence.append({
      phase: 'scan',
      status: 'completed',
      unitId: unit.id,
      fatalCount: 0,
      nonFatalCount: nonFatalFindings.length,
    });

    // --- Evaluate README ---
    await evidence.append({
      phase: 'readme',
      status: 'started',
      unitId: unit.id,
    });

    let readmeReport;
    try {
      readmeReport = await evaluateReadme({
        snapshotDir: outputDir,
      });
    } catch (err) {
      await evidence.append({
        phase: 'readme',
        status: 'failed',
        unitId: unit.id,
        error: { code: err.code, message: err.message },
      });
      throw new ReleaseError(
        GATE_FAILED,
        `README evaluation failed for unit "${unit.id}": ${err.message}`,
        { unitId: unit.id, cause: err.code },
      );
    }

    // Check required README markers — blocking finding for production prepare (Item 23)
    if (readmeReport.missing.length > 0) {
      if (production) {
        await evidence.append({
          phase: 'readme',
          status: 'blocking',
          unitId: unit.id,
          missingMarkers: readmeReport.missing,
        });
        throw new ReleaseError(
          GATE_FAILED,
          `README missing required markers for unit "${unit.id}": ${readmeReport.missing.join(', ')}`,
          { unitId: unit.id, missingMarkers: readmeReport.missing },
        );
      }
      // Non-production: warn but don't block
      await evidence.append({
        phase: 'readme',
        status: 'warning',
        unitId: unit.id,
        missingMarkers: readmeReport.missing,
      });
    }

    // Check readability (Item 23): installation, example, diagnosis — blocking for production
    const rc = readmeReport.readabilityChecks;
    const missingReadability = [];
    if (rc && !rc.hasInstall) missingReadability.push('install command');
    if (rc && !rc.hasMinimalExample) missingReadability.push('minimal example');
    if (rc && !rc.hasFailureDiagnosis) missingReadability.push('failure diagnosis');
    if (missingReadability.length > 0) {
      if (production) {
        await evidence.append({
          phase: 'readme',
          status: 'blocking',
          unitId: unit.id,
          missingReadability,
        });
        throw new ReleaseError(
          GATE_FAILED,
          `README missing readability requirements for unit "${unit.id}": ${missingReadability.join(', ')}`,
          { unitId: unit.id, missingReadability },
        );
      }
      // Non-production: warn but don't block
      await evidence.append({
        phase: 'readme',
        status: 'warning',
        unitId: unit.id,
        missingReadability,
      });
    }

    await evidence.append({
      phase: 'readme',
      status: 'completed',
      unitId: unit.id,
      presentMarkers: readmeReport.present,
    });

    unitResults.push({
      unit,
      manifest,
      readmeReport,
      nonFatalFindings,
    });
  }

  return { unitResults, snapshotDigests };
}

function resolveProductionBranch(unit, version) {
  const tagTemplate = unit.version?.tagTemplate ?? `${unit.id}-v{version}`;
  const tag = tagTemplate.replace('{version}', version);
  const branchTemplate = unit.production?.branchTemplate ?? 'release/{tag}';
  return {
    tag,
    branch: branchTemplate
      .replaceAll('{tag}', tag)
      .replaceAll('{version}', version)
      .replaceAll('{unit}', unit.id),
    branchStrategy: unit.production?.branchStrategy ?? 'create-release-branch',
  };
}

function normalizedProductionConfig(unit) {
  return {
    ...(unit.production ?? {}),
    githubHost: unit.production?.githubHost ?? 'github.com',
    branchTemplate: unit.production?.branchTemplate ?? 'release/{tag}',
    branchStrategy: unit.production?.branchStrategy ?? 'create-release-branch',
  };
}

/**
 * Derive the deterministic freeze timestamp for planVersion 2 plans (design:
 * t1-2-digest-decoupling.md §4.2): the baseline headCommit's committer date,
 * read via `git show -s --format=%cI` and normalized to canonical UTC second
 * precision with `normalizeGitTimestamp`.
 *
 * Same source commit -> same freeze timestamp -> byte-identical frozen
 * release commit on every re-prepare. Failures fail closed with GATE_FAILED
 * (prepare requires a readable Git repository); there is deliberately no
 * fallback clock.
 *
 * @param {string} root - Repository root (git cwd).
 * @param {string} headCommit - The baseline head commit object id.
 * @param {Function} [exec] - Injectable exec (tests); defaults to execFile.
 * @returns {Promise<string>} Canonical `YYYY-MM-DDTHH:MM:SS+00:00` timestamp.
 * @throws {ReleaseError} GATE_FAILED when the committer date cannot be read
 *   or normalized.
 */
export async function readHeadCommitTimestamp(root, headCommit, exec = execFile) {
  try {
    const { stdout } = await exec(
      'git',
      ['show', '-s', '--format=%cI', headCommit],
      { cwd: root, shell: false },
    );
    const committerDate = stdout.trim();
    if (!committerDate) {
      throw new ReleaseError(
        GATE_FAILED,
        'plan freeze timestamp derivation returned an empty headCommit committer date',
        { headCommit },
      );
    }
    return normalizeGitTimestamp(committerDate, 'plan freeze timestamp');
  } catch (error) {
    if (error instanceof ReleaseError) throw error;
    throw new ReleaseError(
      GATE_FAILED,
      'plan freeze timestamp could not be derived from the headCommit committer date (git show -s --format=%cI failed); no fallback clock is used',
      { headCommit, cause: error?.message ?? String(error) },
    );
  }
}

async function buildProductionAssets(
  unitResults,
  resolvedVersions,
  root,
  runDir,
  unitBaselineResults,
  buildGitRepository = buildFrozenGitRepository,
  freezeTimestamp,
) {
  // The plan freeze timestamp is sampled exactly once by prepareRelease.
  // Every unit reuses this single value; the wall clock is never re-read.
  const canonicalFreezeTimestamp = normalizeGitTimestamp(freezeTimestamp, 'plan freeze timestamp');
  for (const { unit } of unitResults) {
    const npmDistribution = (unit.distributions ?? []).find((distribution) => distribution.type === 'npm');
    if (npmDistribution && !['public', 'restricted'].includes(npmDistribution.access)) {
      throw new ReleaseError(
        GATE_FAILED,
        `production npm distribution for unit "${unit.id}" requires explicit access: public or restricted`,
      );
    }
  }
  const assets = [];
  for (let index = 0; index < unitResults.length; index += 1) {
    const { unit, manifest } = unitResults[index];
    const version = resolvedVersions[index];
    const { tag, branch, branchStrategy } = resolveProductionBranch(unit, version);
    const snapshotPath = relative(root, manifest.outputDir);
    const observed = await computeFrozenSnapshot(manifest.outputDir);
    if (observed.digest !== manifest.snapshotDigest) {
      throw new ReleaseError(
        GATE_FAILED,
        `snapshot digest changed before production asset freeze for unit "${unit.id}"`,
        { expected: manifest.snapshotDigest, observed: observed.digest },
      );
    }

    // Freeze the byte/mode authority before deriving either distribution.
    // Git and npm must consume the same immutable snapshot, never two reads of
    // a writable staging directory separated by an attacker-controlled gap.
    await sealFrozenSnapshot(manifest.outputDir);
    const sealed = await computeFrozenSnapshot(manifest.outputDir);

    const repositoryDir = resolveUnitScopedPath(resolve(runDir, 'git'), unit.id, { suffix: '.git' });
    const unitBaseline = unitBaselineResults.get(unit.id);
    const parent = branchStrategy === 'create-release-branch'
      ? undefined
      : {
          githubHost: unitBaseline.githubHost,
          repo: unitBaseline.repo,
          ref: unitBaseline.ref,
          commit: unitBaseline.commit,
        };
    const git = await buildGitRepository({
      snapshotDir: manifest.outputDir,
      repositoryDir,
      version,
      expectedSnapshotDigest: sealed.digest,
      parent,
      commitTimestamp: canonicalFreezeTimestamp,
    });

    let npm = null;
    const npmDistribution = (unit.distributions ?? []).find((distribution) => distribution.type === 'npm');
    if (npmDistribution) {
      npm = await buildFrozenNpmTarball({
        snapshotDir: manifest.outputDir,
        tarballDir: resolveUnitScopedPath(resolve(runDir, 'tarballs'), unit.id),
        expectedSnapshotDigest: sealed.digest,
      });
      await verifyFrozenNpmTarballIdentity({
        package: npmDistribution.package,
        version,
        tarballPath: relative(root, npm.tarballPath),
        tarballSha256: npm.sha256,
        integrity: npm.integrity,
      }, root);
    }

    assets.push({
      snapshotPath,
      manifestDigest: sealed.digest,
      gitObjectDir: relative(root, repositoryDir),
      commit: git.commit,
      tree: git.tree,
      commitTimestamp: canonicalFreezeTimestamp,
      branchStrategy,
      ...(git.parentCommit ? { parentCommit: git.parentCommit } : {}),
      branch,
      tag,
      npm: npm ? {
        tarballPath: relative(root, npm.tarballPath),
        tarballSha256: npm.sha256,
        integrity: npm.integrity,
        size: npm.size,
      } : null,
    });
  }
  return assets;
}

// ---------------------------------------------------------------------------
// External independent marketplace freeze (production + online only)
// ---------------------------------------------------------------------------

const EXTERNAL_MARKETPLACE_SHA_RE = /^[0-9a-f]{40}$/;

/**
 * Parse `git ls-remote --symref <url> HEAD` output into the resolved HEAD
 * commit sha and the default branch name. Pure: no I/O.
 *
 * Expected lines (tab-separated):
 *   ref: refs/heads/<branch>\tHEAD
 *   <40-hex sha>\tHEAD
 *
 * @param {string} stdout
 * @returns {{sha:string, defaultBranch:string}|null} null when either is absent.
 */
export function parseExternalMarketplaceLsRemote(stdout) {
  if (typeof stdout !== 'string') return null;
  const lines = stdout.trim().split('\n').filter((line) => line.length > 0);
  let defaultBranch = null;
  let sha = null;
  for (const line of lines) {
    const tabIndex = line.indexOf('\t');
    if (tabIndex < 0) continue;
    const left = line.slice(0, tabIndex);
    const right = line.slice(tabIndex + 1);
    if (right !== 'HEAD') continue;
    if (left.startsWith('ref: refs/heads/')) {
      defaultBranch = left.slice('ref: refs/heads/'.length);
    } else if (EXTERNAL_MARKETPLACE_SHA_RE.test(left)) {
      sha = left;
    }
  }
  if (!sha || !defaultBranch) return null;
  return { sha, defaultBranch };
}

/**
 * Decode a GitHub contents-API base64 `.content` field and parse it as the
 * marketplace index JSON. Pure: no I/O.
 *
 * @param {string} base64Content
 * @returns {object|null} parsed index, or null on decode/parse failure.
 */
export function decodeExternalMarketplaceIndex(base64Content) {
  if (typeof base64Content !== 'string') return null;
  try {
    const base64 = base64Content.replace(/\s/g, '');
    const content = Buffer.from(base64, 'base64').toString('utf8');
    const parsed = JSON.parse(content);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Resolve an external marketplace repository's current HEAD via
 * `git ls-remote --symref`, returning both the resolved commit sha and the
 * default branch name. Read-only: never writes to the remote.
 *
 * @param {string} repo - External marketplace repository (owner/name).
 * @param {object} [opts]
 * @param {string} [opts.githubHost]
 * @returns {Promise<{status:string, sha?:string, defaultBranch?:string, error?:string}>}
 */
async function defaultObserveExternalMarketplaceHead(repo, { githubHost = 'github.com' } = {}) {
  try {
    const { stdout } = await execFile(
      'git',
      ['ls-remote', '--symref', `https://${githubHost}/${repo}.git`, 'HEAD'],
      { shell: false, encoding: 'utf8', timeout: 30000 },
    );
    const parsed = parseExternalMarketplaceLsRemote(stdout);
    if (!parsed) {
      return { status: 'unknown', error: 'could not resolve HEAD commit sha and default branch from ls-remote --symref output' };
    }
    return { status: 'observed', sha: parsed.sha, defaultBranch: parsed.defaultBranch };
  } catch (error) {
    return { status: 'unknown', error: error.message };
  }
}

/**
 * Fetch and parse an external marketplace index manifest at a frozen ref via
 * the GitHub contents API. Read-only: never writes to the remote.
 *
 * @param {string} repo - External marketplace repository (owner/name).
 * @param {string} manifestPath - Platform marketplace manifest path.
 * @param {string} ref - Frozen commit sha to read the index at.
 * @param {object} [opts]
 * @param {string} [opts.githubHost]
 * @returns {Promise<{status:string, index?:object, error?:string}>}
 */
async function defaultFetchExternalMarketplaceIndex(repo, manifestPath, ref, { githubHost = 'github.com' } = {}) {
  try {
    const { stdout } = await execFile(
      'gh',
      ['api', `repos/${repo}/contents/${manifestPath}?ref=${ref}`, '--jq', '.content'],
      {
        shell: false,
        encoding: 'utf8',
        timeout: 30000,
        env: { ...process.env, GH_HOST: githubHost },
      },
    );
    const index = decodeExternalMarketplaceIndex(stdout);
    if (!index) {
      return { status: 'unknown', error: 'could not decode external marketplace index content' };
    }
    return { status: 'fetched', index };
  } catch (error) {
    return { status: 'unknown', error: error.message };
  }
}

/**
 * Freeze the external marketplace HEAD for every claude/codex distribution
 * that declares `marketplaceRepo` (production + online only). For each such
 * distribution: resolve the external repository's HEAD commit sha + default
 * branch name, validate the marketplace index entry at that sha (name match,
 * exactly one plugin entry, claude-form entry version equals the target
 * version), then record the add-ref (codex=sha, claude=default branch name)
 * and the frozen marketplaceCommitSha. Any failure fails closed. The remote is
 * only ever read (git ls-remote / gh api), never written.
 *
 * @returns {Promise<Map<string, {repo:string, ref:string, marketplaceCommitSha:string, marketplace:string}>>}
 *   keyed by `${unitId} ${distributionType}`.
 */
export async function resolveExternalMarketplaceFreezes({
  unitResults,
  resolvedVersions,
  offline,
  evidence,
  observeHeadFn,
  fetchIndexFn,
}) {
  const freezes = new Map();
  for (let index = 0; index < unitResults.length; index += 1) {
    const { unit } = unitResults[index];
    const version = resolvedVersions[index];
    const githubHost = unit.production?.githubHost ?? 'github.com';
    for (const dist of unit.distributions ?? []) {
      // 只处理 standalone-index 来源；bundled-family 不需要外部冻结。
      if (dist.marketplaceSourceType !== 'standalone-index') continue;
      // standalone-index 必须有 marketplaceRepo；没有则跳过（兼容旧配置）。
      if (!dist.marketplaceRepo) continue;
      const platform = PLATFORMS.find((p) => p.distributionType === dist.type);
      if (!platform) {
        throw new ReleaseError(
          GATE_FAILED,
          `unit "${unit.id}" ${dist.type} distribution declares standalone-index but the platform is unknown`,
          { unitId: unit.id, distributionType: dist.type },
        );
      }
      if (offline) {
        throw new ReleaseError(
          GATE_FAILED,
          `unit "${unit.id}" ${dist.type} external marketplace form requires online production prepare to freeze the marketplace commit sha`,
          { unitId: unit.id, marketplaceSourceType: dist.marketplaceSourceType },
        );
      }
      const observed = await observeHeadFn(dist.marketplaceRepo, { githubHost });
      if (observed.status !== 'observed' || !EXTERNAL_MARKETPLACE_SHA_RE.test(observed.sha ?? '') || !observed.defaultBranch) {
        throw new ReleaseError(
          GATE_FAILED,
          `unit "${unit.id}" could not freeze external marketplace "${dist.marketplaceRepo}" HEAD: ${observed.error ?? 'unknown'}`,
          { unitId: unit.id, marketplaceRepo: dist.marketplaceRepo },
        );
      }
      const sha = observed.sha;
      // 索引路径：distribution 显式声明优先，否则使用平台默认路径。
      // 平台注册表没有默认路径时（kimi、codebuddy），必须显式提供。
      const manifestPath = dist.marketplaceIndexPath ?? platform.manifestPaths.marketplace;
      if (!manifestPath) {
        throw new ReleaseError(
          GATE_FAILED,
          `unit "${unit.id}" ${dist.type} cannot determine marketplace index path: neither marketplaceIndexPath nor platform.manifestPaths.marketplace is set`,
          { unitId: unit.id, distributionType: dist.type },
        );
      }
      const fetched = await fetchIndexFn(dist.marketplaceRepo, manifestPath, sha, { githubHost });
      if (fetched.status !== 'fetched' || !fetched.index || typeof fetched.index !== 'object') {
        throw new ReleaseError(
          GATE_FAILED,
          `unit "${unit.id}" could not read external marketplace index for "${dist.marketplaceRepo}" at ${sha}: ${fetched.error ?? 'unknown'}`,
          { unitId: unit.id, marketplaceRepo: dist.marketplaceRepo },
        );
      }
      const marketplaceIndex = fetched.index;
      // 校验市场名称（仅当 distribution 显式声明 marketplace 时）
      if (dist.marketplace && marketplaceIndex.name !== dist.marketplace) {
        throw new ReleaseError(
          GATE_FAILED,
          `unit "${unit.id}" external marketplace index name "${marketplaceIndex.name}" does not match distribution marketplace "${dist.marketplace}"`,
          { unitId: unit.id, marketplaceRepo: dist.marketplaceRepo },
        );
      }
      const pluginEntries = Array.isArray(marketplaceIndex.plugins)
        ? marketplaceIndex.plugins.filter((entry) => entry && entry.name === dist.plugin)
        : [];
      if (pluginEntries.length !== 1) {
        throw new ReleaseError(
          GATE_FAILED,
          `unit "${unit.id}" external marketplace index must contain exactly one plugin entry named "${dist.plugin}", found ${pluginEntries.length}`,
          { unitId: unit.id, marketplaceRepo: dist.marketplaceRepo },
        );
      }
      if (platform.marketplaceEntryCarriesVersion && pluginEntries[0].version !== version) {
        throw new ReleaseError(
          GATE_FAILED,
          `unit "${unit.id}" external marketplace index entry version "${pluginEntries[0].version}" does not match target version "${version}"`,
          { unitId: unit.id, marketplaceRepo: dist.marketplaceRepo },
        );
      }
      // marketplaceRef：Claude 使用默认分支名（name-ref），其余平台使用提交 SHA。
      // 无 CLI 的平台（kimi、codebuddy）也必须能冻结，ref 用 SHA。
      const marketplaceRef = platform.marketplaceRefForm === 'name' ? observed.defaultBranch : sha;
      freezes.set(`${unit.id} ${dist.type}`, {
        // 向后兼容字段（buildExternalActions 使用 repo / ref / marketplace）
        repo: dist.marketplaceRepo,
        ref: marketplaceRef,
        marketplaceCommitSha: sha,
        marketplace: dist.marketplace,
        // B3B 完整冻结字段
        marketplaceRepo: dist.marketplaceRepo,
        marketplaceRef,
        marketplaceIndexPath: manifestPath,
        marketplaceName: marketplaceIndex.name,
        selectedEntry: pluginEntries[0],
      });
      await evidence.append({
        phase: 'external-marketplace-freeze',
        unitId: unit.id,
        distributionType: dist.type,
        status: 'completed',
        marketplaceRepo: dist.marketplaceRepo,
        marketplaceCommitSha: sha,
        marketplaceRef,
        marketplaceIndexPath: manifestPath,
        marketplaceName: marketplaceIndex.name,
        selectedEntry: pluginEntries[0],
        defaultBranch: observed.defaultBranch,
      });
    }
  }
  return freezes;
}

// ---------------------------------------------------------------------------
// External actions generation
// ---------------------------------------------------------------------------

/**
 * Build the list of external actions that would be taken during publish.
 *
 * Each action is in PENDING status. Actions are generated per unit and
 * include: push-snapshot, create-tag, npm-publish, github-release.
 *
 * @param {object[]} unitResults - Results from processSnapshots.
 * @param {string} planVersion - The target version.
 * @param {string} realRoot - The project root for relative path calculation.
 * @returns {object[]} Array of external action descriptors.
 */
export function buildExternalActions(unitResults, resolvedVersions, productionAssets, externalFreezes = new Map(), frozenDistributions = null) {
  const actions = [];

  if (!productionAssets) {
    for (let index = 0; index < unitResults.length; index += 1) {
      const { unit } = unitResults[index];
      const version = resolvedVersions[index];
      const tagTemplate = unit.version?.tagTemplate ?? `${unit.id}-v{version}`;
      const tag = tagTemplate.replace('{version}', version);
      actions.push({
        id: `push-snapshot-${unit.id}`,
        type: 'push-snapshot',
        adapter: 'git-github',
        unitId: unit.id,
        parameters: { source: unit.source, publicRepo: unit.publicRepo, version, cwd: unit.source },
        expected: { tag },
        status: 'PENDING',
      });
      actions.push({
        id: `create-tag-${unit.id}`,
        type: 'create-tag',
        adapter: 'git-github',
        unitId: unit.id,
        parameters: { tagTemplate, publicRepo: unit.publicRepo, version },
        status: 'PENDING',
      });
      const npmDistribution = (unit.distributions ?? []).find((item) => item.type === 'npm');
      if (npmDistribution) {
        actions.push({
          id: `npm-publish-${unit.id}`,
          type: 'npm-publish',
          adapter: 'npm',
          unitId: unit.id,
          parameters: {
            package: npmDistribution.package,
            version,
            cwd: unit.source,
            registry: npmDistribution.registry,
            publisher: npmDistribution.publisher,
          },
          expected: {
            package: npmDistribution.package,
            version,
            registry: npmDistribution.registry,
            publisher: npmDistribution.publisher,
          },
          status: 'PENDING',
        });
      }
      actions.push({
        id: `github-release-${unit.id}`,
        type: 'github-release',
        adapter: 'github',
        unitId: unit.id,
        parameters: { publicRepo: unit.publicRepo, version },
        status: 'PENDING',
      });
      // Consumer marketplace install actions (only when distribution
      // declared), driven by the platform registry (T2.2 step 3): one loop
      // body for every platform; the registry declares the per-platform
      // differences (actionType, distributionType, adapter, and — via the
      // schema required fields — marketplace identity, which kimi does not
      // carry: Kimi Code has no non-interactive install/marketplace API, so
      // the kimi action carries no marketplace identity (MINOR-1); plugin +
      // entrySkill are the meaningful identity fields there).
      const frozenUnitDists = frozenDistributions?.get(unit.id) ?? null;
      for (const platform of PLATFORMS) {
        const dist = frozenUnitDists
          ? frozenUnitDists.find((d) => d.type === platform.distributionType)
          : (unit.distributions ?? []).find((d) => d.type === platform.distributionType);
        if (!dist) continue;
        const requiresMarketplace = platform.schemaRequiredFields.includes('marketplace');
        const timeoutMs = Number.isInteger(dist.timeoutMs) ? dist.timeoutMs : 300000;
        // External independent marketplace form: the distribution declares
        // marketplaceRepo, so the install targets the external marketplace repo
        // and carries the external payload contract. Non-production prepare does
        // no online resolution, so it carries the external marker + repo shape
        // but no frozen ref/marketplaceCommitSha (production-only bindings),
        // keeping the two loops' shapes aligned for plan completeness.
        const externalMarketplace = dist.marketplaceRepo !== undefined && dist.marketplaceRepo !== null;
        // Normalized marketplace form: explicit mutually exclusive declaration.
        // bundled-family: marketplace and plugin live in the same repo.
        // standalone-index: external marketplace repo indexes a separate plugin repo.
        // All four platforms carry marketplaceForm and sourceDescriptor when a
        // marketplace source type is declared (bundled-family or standalone-index).
        const marketplaceSourceType = dist.marketplaceSourceType ?? (externalMarketplace ? 'standalone-index' : 'bundled-family');
        const marketplaceForm = marketplaceSourceType;
        const sourceDescriptor = marketplaceForm === 'standalone-index'
          ? Object.freeze({
            form: 'standalone-index',
            marketplaceRepo: dist.marketplaceRepo,
            marketplaceEntry: dist.plugin,
            // pluginRepo is the plugin's own public repo, NOT the external
            // marketplace repo. The marketplace repo contains the index; the
            // plugin repo contains the actual plugin code.
            pluginRepo: unit.publicRepo,
            sourceType: 'marketplace-entry',
            // Production-only fields: marketplaceCommitSha and ref are frozen
            // by resolveExternalMarketplaceFreezes in the production path.
            marketplaceCommitSha: null,
            ref: null,
            payloadDigest: null,
          })
          : marketplaceForm === 'bundled-family'
            ? Object.freeze({
              form: 'bundled-family',
              repo: unit.publicRepo,
              marketplaceEntry: dist.plugin,
              pluginSubpath: '.',
              payloadDigest: null,
            })
            : null;
        actions.push({
          id: `${platform.actionType}-${unit.id}`,
          type: platform.actionType,
          adapter: platform.adapter,
          unitId: unit.id,
          parameters: {
            consumer: platform.id,
            plugin: dist.plugin,
            ...(requiresMarketplace ? { marketplace: dist.marketplace } : {}),
            repo: externalMarketplace ? dist.marketplaceRepo : unit.publicRepo,
            version,
            entrySkill: dist.entrySkill,
            timeoutMs,
            // Payload verification contract for new plans (T1.3): installed
            // payload is verified by declared-manifest containment; host-added
            // files are recorded, not failed. Frozen plans without this marker
            // keep the legacy full-tree equality semantics byte-for-byte.
            // External marketplace form uses the external-marketplace-v1
            // contract (whole-tree '.' containment; see plugin-marketplace).
            payloadContract: externalMarketplace ? 'external-marketplace-v1' : 'declared-manifest-v1',
            ...(externalMarketplace ? { marketplaceLocation: 'external' } : {}),
            ...(marketplaceForm ? { marketplaceForm } : {}),
            ...(sourceDescriptor ? { sourceDescriptor } : {}),
            // 安装契约摘要、算法版本和来源类型，用于完整性交叉校验
            ...(dist.installationContractDigest ? {
              installationContractDigest: dist.installationContractDigest,
              algorithmVersion: INSTALLATION_CONTRACT_ALGORITHM_VERSION,
              marketplaceSourceType: dist.marketplaceSourceType,
            } : {}),
            // standalone-index 审计字段仅在生产在线冻结成功后出现；
            // 非生产 action 不携带这三个字段（未冻结时无真实值可用）。
          },
          expected: {
            installed: true,
            plugin: dist.plugin,
            ...(requiresMarketplace ? { marketplace: dist.marketplace } : {}),
            version,
            entrySkill: dist.entrySkill,
            ...(externalMarketplace ? { marketplaceLocation: 'external', repo: dist.marketplaceRepo } : {}),
          },
          status: 'PENDING',
        });
      }
    }
    return actions;
  }

  for (let index = 0; index < unitResults.length; index += 1) {
    const { unit } = unitResults[index];
    const unitVersion = resolvedVersions[index];
    const asset = productionAssets[index];
    const tagTemplate = unit.version?.tagTemplate ?? `${unit.id}-v{version}`;
    const resolvedTag = asset.tag;
    const frozenUnitDists = frozenDistributions?.get(unit.id) ?? null;

    // Push snapshot
    actions.push({
      id: `push-snapshot-${unit.id}`,
      type: 'push-snapshot',
      adapter: 'git-github',
      unitId: unit.id,
      parameters: {
        source: unit.source,
        publicRepo: unit.publicRepo,
        version: unitVersion,
        cwd: unit.source,
        snapshotPath: asset.snapshotPath,
        manifestDigest: asset.manifestDigest,
        gitObjectDir: asset.gitObjectDir,
        branch: asset.branch,
        repo: unit.publicRepo,
        githubHost: unit.production?.githubHost ?? 'github.com',
        commit: asset.commit,
        tree: asset.tree,
        branchStrategy: asset.branchStrategy,
        ...(asset.parentCommit ? { parentCommit: asset.parentCommit } : {}),
        ...(asset.branchStrategy === 'advance-existing-branch'
          ? { expectedBaselineCommit: asset.parentCommit }
          : {}),
      },
      expected: {
        branch: asset.branch,
        commit: asset.commit,
        tree: asset.tree,
        manifestDigest: asset.manifestDigest,
      },
      status: 'PENDING',
    });

    if (asset.branchStrategy === 'initialize-default-branch') {
      actions.push({
        id: `set-default-branch-${unit.id}`,
        type: 'set-default-branch',
        adapter: 'git-github',
        unitId: unit.id,
        parameters: {
          repo: unit.publicRepo,
          githubHost: unit.production?.githubHost ?? 'github.com',
          oldBranch: unit.production.expectedCurrentDefaultBranch,
          newBranch: asset.branch,
          expectedNewBranchCommit: asset.commit,
        },
        expected: { defaultBranch: asset.branch, newBranchCommit: asset.commit },
        status: 'PENDING',
      });
    }

    // Create tag
    actions.push({
      id: `create-tag-${unit.id}`,
      type: 'create-tag',
      adapter: 'git-github',
      unitId: unit.id,
      parameters: {
        tagTemplate,
        publicRepo: unit.publicRepo,
        version: unitVersion,
        tag: resolvedTag,
        repo: unit.publicRepo,
        githubHost: unit.production?.githubHost ?? 'github.com',
        gitObjectDir: asset.gitObjectDir,
        commit: asset.commit,
      },
      expected: { tag: resolvedTag, commit: asset.commit },
      status: 'PENDING',
    });

    // npm publish (only for npm distributions)
    const npmDist = (unit.distributions ?? []).find((d) => d.type === 'npm');
    if (npmDist) {
      actions.push({
        id: `npm-publish-${unit.id}`,
        type: 'npm-publish',
        adapter: 'npm',
        unitId: unit.id,
        parameters: {
          package: npmDist.package,
          version: unitVersion,
          cwd: unit.source,
          tarballPath: asset.npm.tarballPath,
          tarballSha256: asset.npm.tarballSha256,
          integrity: asset.npm.integrity,
          access: npmDist.access,
          provenance: npmDist.provenance === true,
          ...(npmDist.tag ? { tag: npmDist.tag } : {}),
          registry: npmDist.registry,
          publisher: npmDist.publisher,
        },
        expected: {
          package: npmDist.package,
          version: unitVersion,
          integrity: asset.npm.integrity,
          registry: npmDist.registry,
          publisher: npmDist.publisher,
        },
        status: 'PENDING',
      });
    }

    // GitHub release
    actions.push({
      id: `github-release-${unit.id}`,
      type: 'github-release',
      adapter: 'github',
      unitId: unit.id,
      parameters: {
        publicRepo: unit.publicRepo,
        version: unitVersion,
        tag: resolvedTag,
        repo: unit.publicRepo,
        githubHost: unit.production?.githubHost ?? 'github.com',
        commit: asset.commit,
        name: (unit.production?.releaseTitleTemplate ?? 'Release {tag}')
          .replaceAll('{tag}', resolvedTag)
          .replaceAll('{version}', unitVersion)
          .replaceAll('{unit}', unit.id),
        notes: unit.production?.releaseNotes ?? `Release ${resolvedTag}`,
      },
      expected: {
        tag: resolvedTag,
        commit: asset.commit,
      },
      status: 'PENDING',
    });

    // Consumer marketplace install actions (only when distribution
    // declared), driven by the platform registry (T2.2 step 3): mirrors the
    // non-production loop above plus the production-only bindings
    // (ref/snapshotPath/manifestDigest parameters; consumer/repo/ref/
    // entrySkillFound/manifestDigest expected). Marketplace identity follows
    // the registry's schema required fields — kimi carries none (MINOR-1).
    for (const platform of PLATFORMS) {
      const dist = frozenUnitDists
        ? frozenUnitDists.find((d) => d.type === platform.distributionType)
        : (unit.distributions ?? []).find((d) => d.type === platform.distributionType);
      if (!dist) continue;
      const requiresMarketplace = platform.schemaRequiredFields.includes('marketplace');
      const timeoutMs = Number.isInteger(dist.timeoutMs) ? dist.timeoutMs : 300000;
      // External independent marketplace form: the install targets the external
      // marketplace repo with the add-ref + marketplaceCommitSha frozen online
      // by resolveExternalMarketplaceFreezes. snapshotPath/manifestDigest still
      // bind this unit's own frozen snapshot — the payload authority is the unit
      // snapshot, unchanged. Inline form (no marketplaceRepo) is byte-identical.
      const externalMarketplace = dist.marketplaceRepo !== undefined && dist.marketplaceRepo !== null;
      const freeze = externalMarketplace ? externalFreezes.get(`${unit.id} ${dist.type}`) : null;
      // Normalized marketplace form: explicit mutually exclusive declaration.
      // All four platforms carry marketplaceForm and sourceDescriptor.
      const marketplaceSourceType = dist.marketplaceSourceType ?? (externalMarketplace ? 'standalone-index' : 'bundled-family');
      const marketplaceForm = marketplaceSourceType;
      const sourceDescriptor = marketplaceForm === 'standalone-index'
        ? Object.freeze({
          form: 'standalone-index',
          marketplaceRepo: dist.marketplaceRepo,
          marketplaceCommitSha: freeze?.marketplaceCommitSha ?? null,
          marketplaceEntry: dist.plugin,
          // pluginRepo is the plugin's own public repo, NOT the external
          // marketplace repo. The marketplace repo contains the index; the
          // plugin repo contains the actual plugin code.
          pluginRepo: unit.publicRepo,
          sourceType: 'marketplace-entry',
          ref: freeze?.ref ?? null,
          payloadDigest: asset.manifestDigest,
        })
        : marketplaceForm === 'bundled-family'
          ? Object.freeze({
            form: 'bundled-family',
            repo: unit.publicRepo,
            commit: asset.commit,
            marketplaceEntry: dist.plugin,
            pluginSubpath: '.',
            payloadDigest: asset.manifestDigest,
          })
          : null;
      actions.push({
        id: `${platform.actionType}-${unit.id}`,
        type: platform.actionType,
        adapter: platform.adapter,
        unitId: unit.id,
        parameters: {
          consumer: platform.id,
          plugin: dist.plugin,
          ...(requiresMarketplace ? { marketplace: dist.marketplace } : {}),
          repo: externalMarketplace ? dist.marketplaceRepo : unit.publicRepo,
          ref: externalMarketplace ? freeze.ref : resolvedTag,
          version: unitVersion,
          entrySkill: dist.entrySkill,
          snapshotPath: asset.snapshotPath,
          manifestDigest: asset.manifestDigest,
          timeoutMs,
          // Payload verification contract for new plans (T1.3): installed
          // payload is verified by declared-manifest containment; host-added
          // files are recorded, not failed. Frozen plans without this marker
          // keep the legacy full-tree equality semantics byte-for-byte.
          // External marketplace form uses the external-marketplace-v1
          // contract (whole-tree '.' containment; see plugin-marketplace).
          payloadContract: externalMarketplace ? 'external-marketplace-v1' : 'declared-manifest-v1',
          ...(externalMarketplace ? { marketplaceLocation: 'external', marketplaceCommitSha: freeze.marketplaceCommitSha } : {}),
          ...(marketplaceForm ? { marketplaceForm } : {}),
          ...(sourceDescriptor ? { sourceDescriptor } : {}),
          // 冻结的插件来源提交，用于 sourceDescriptor.commit 交叉校验。
          // bundled-family: sourceDescriptor.commit 绑定到此值。
          // standalone-index: 通过此值绑定插件载荷来源。
          sourceCommit: asset.commit,
          // 安装契约摘要、算法版本和来源类型，用于完整性交叉校验
          ...(dist.installationContractDigest ? {
            installationContractDigest: dist.installationContractDigest,
            algorithmVersion: INSTALLATION_CONTRACT_ALGORITHM_VERSION,
            marketplaceSourceType: dist.marketplaceSourceType,
          } : {}),
          // standalone-index 审计字段：供后续静态预检使用
          ...(externalMarketplace && freeze ? {
            marketplaceIndexPath: freeze.marketplaceIndexPath,
            marketplaceName: freeze.marketplaceName,
            selectedEntry: freeze.selectedEntry,
          } : {}),
        },
        expected: {
          installed: true,
          consumer: platform.id,
          plugin: dist.plugin,
          ...(requiresMarketplace ? { marketplace: dist.marketplace } : {}),
          repo: externalMarketplace ? dist.marketplaceRepo : unit.publicRepo,
          version: unitVersion,
          ref: externalMarketplace ? freeze.ref : resolvedTag,
          entrySkill: dist.entrySkill,
          entrySkillFound: true,
          manifestDigest: asset.manifestDigest,
          ...(externalMarketplace ? { marketplaceLocation: 'external', marketplaceCommitSha: freeze.marketplaceCommitSha } : {}),
        },
        status: 'PENDING',
      });
    }
  }

  return actions;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Run the full prepare pipeline and freeze a release plan.
 *
 * @param {Object} options
 * @param {string} options.root - Absolute path to the project root.
 * @param {string} [options.version] - Target version override. If not provided,
 *   each unit's version is read from its configured source.
 * @param {boolean} [options.offline=true] - Skip remote checks when true.
 * @param {string} [options.output] - Path to write the plan. Defaults to
 *   `<root>/.release-skill/release-plan.json`.
 * @param {string} [options.runDir] - Directory for evidence. Defaults to
 *   `<root>/.release-skill/runs/prepare-<timestamp>`.
 * @param {() => string} [options.clock] - Clock function for timestamps.
 * @param {boolean} [options.hooksAuthorized] - Must be explicitly `true` when
 *   the project config declares hooks. Hooks are user-configured arbitrary
 *   local processes without filesystem/network isolation. Authorization
 *   means the user accepts hook side-effect risks, not that hooks are safe.
 * @param {boolean} [options.verificationGatesAuthorized] - Must be explicitly
 *   true when project verification gates are declared.
 * @param {Function} [options.releaseDocsPlanFn] - Read-only release-documents
 *   planner used by the freshness gate (default
 *   planReleaseDocsRefreshForUnit); tests inject spies or documented
 *   bypasses. Prepare itself never writes README/CHANGELOG.
 * @param {Function} [options.runHookFn] - Hook runner passed to
 *   runDeclaredHooks (default runHook); tests inject a spy that records call
 *   order while delegating to the real implementation.
 * @param {boolean} [options.hookCache=true] - When false (CLI --no-hook-cache),
 *   every declared hook runs in full and the incremental hook cache is neither
 *   read nor written.
 *
 * @returns {Promise<{ planPath: string, planDigest: string, evidenceDir: string }>}
 *
 * @throws {ReleaseError} on any gate failure. No PREPARED plan is written.
 */
export async function prepareRelease(options) {
  const {
    root,
    version,
    offline = true,
    output,
    runDir: runDirOpt,
    clock,
    hooksAuthorized,
    verificationGatesAuthorized,
    production = false,
    observePreviousPublicBaselineFn,
  } = options ?? {};

  // --- Validate root ---
  if (!root || typeof root !== 'string') {
    throw new ReleaseError(CONFIG_INVALID, 'root must be a non-empty string');
  }

  // Resolve root to real path (follows system symlinks like macOS /var → /private/var).
  // This ensures outputDir paths use the real filesystem path, avoiding false
  // positives in ancestor symlink checks.
  let realRoot;
  try {
    realRoot = await realpath(root);
  } catch (err) {
    throw new ReleaseError(
      CONFIG_INVALID,
      `cannot resolve root path: ${err.message}`,
      { root, cause: err.code },
    );
  }

  if (production) {
    const canonicalOutput = resolve(realRoot, '.release-skill', 'release-plan.json');
    if (output && resolve(output) !== canonicalOutput) {
      throw new ReleaseError(
        GATE_FAILED,
        'production prepare requires the canonical .release-skill/release-plan.json output; custom --output is supported only outside production',
        { output: resolve(output), expected: canonicalOutput },
      );
    }
  }

  // --- Acquire project lock (shared domain with all mutating artifact commands) ---
  const lock = await acquireProjectLock({ root: realRoot, command: 'prepare', mode: 'exclusive' });

  // --- Set up directories ---
  // Use realRoot for directory construction to avoid system symlink issues
  // (e.g., macOS /var → /private/var) in outputDir ancestor checks.
  const releaseDir = resolve(realRoot, '.release-skill');
  const runId = `prepare-${Date.now()}`;
  const rawRunDir = runDirOpt ?? resolve(releaseDir, 'runs', runId);
  let runDir;
  try {
    if (production) {
      runDir = await createProductionPrepareRunDir(rawRunDir, releaseDir);
    } else {
      await mkdir(rawRunDir, { recursive: true });
      // Resolve after mkdir to canonicalize system aliases such as /var → /private/var.
      runDir = await realpath(rawRunDir);
    }
  } catch (error) {
    await lock.release();
    throw error;
  }
  const evidenceDir = runDir;

  // --- Evidence writer ---
  const evidence = createEvidenceWriter({ runDir, command: 'prepare', clock });

  try {
    // --- Step 1: Load and validate config ---
    await evidence.append({ phase: 'config', status: 'started' });

    const { config, configPath, configDigest } = await loadProjectConfig({ root: realRoot });

    await evidence.append({
      phase: 'config',
      status: 'completed',
      configPath: relative(realRoot, configPath),
      configDigest,
    });

    // --- Step 1b: Resolve authoritative versions and gate release-document
    //     freshness BEFORE hook authorization ---
    // Authoritative versions resolve exactly once here and are reused by
    // every downstream consumer, so a hook can never silently switch the
    // version a plan binds. Units that configure releaseDocuments must be
    // clean under the read-only refresh planner before any hook, verification
    // gate, baseline, snapshot, remote check, or plan write runs. Units
    // without releaseDocuments keep the exact legacy behaviour (the gate
    // appends no evidence and performs no check).
    const configUnits = config.releaseUnits ?? [];
    const resolvedVersions = await resolveAllUnitVersions(
      configUnits,
      realRoot,
      version,
      evidence,
    );
    const preHookDocsBindings = await runReleaseDocsFreshnessGate({
      units: configUnits,
      resolvedVersions,
      root: realRoot,
      config,
      evidence,
      planFn: options.releaseDocsPlanFn,
      reasonTag: 'RELEASE_DOCS_STALE',
    });

    // --- Step 2: Hook authorization gate ---
    // Hooks are user-configured arbitrary local processes without filesystem
    // or network isolation. They may write outside the project, access local
    // credentials, or make network calls. The user must explicitly accept
    // these risks before any hook is executed.
    const declaredHooks = Object.entries(config.hooks ?? {})
      .filter(([, hook]) => hook && hook.command)
      .map(([name, hook]) => ({
        name,
        executable: hook.command[0],
        args: hook.command.slice(1),
        cwd: hook.cwd ?? '.',
      }));

    if (declaredHooks.length > 0) {
      await evidence.append({
        phase: 'hook-authorization',
        status: 'started',
        hookCount: declaredHooks.length,
        hooks: declaredHooks.map((h) => `${h.name}: ${h.executable} ${h.args.join(' ')}`),
      });

      if (hooksAuthorized !== true) {
        const hookList = declaredHooks
          .map((h) => `  - ${h.name}: executable="${h.executable}", args=[${h.args.join(', ')}], cwd="${h.cwd}"`)
          .join('\n');

        await evidence.append({
          phase: 'hook-authorization',
          status: 'denied',
          reason: 'hooks not explicitly authorized',
        });

        throw new ReleaseError(
          GATE_FAILED,
          `project declares ${declaredHooks.length} hook(s) that will be executed as arbitrary local processes.\n` +
          `These hooks are NOT sandboxed — they may write to the filesystem outside the project, ` +
          `access local credentials, or make network calls.\n` +
          `The following hooks will run:\n${hookList}\n\n` +
          `To proceed, pass --acknowledge-hook-side-effects (CLI) or hooksAuthorized=true (API). ` +
          `Authorization means you accept hook side-effect risks; it does NOT make hooks safe.`,
          { hookNames: declaredHooks.map((h) => h.name), hookCount: declaredHooks.length },
        );
      }

      await evidence.append({
        phase: 'hook-authorization',
        status: 'authorized',
        hookCount: declaredHooks.length,
      });
    }

    const declaredVerificationGates = config.verificationGates ?? [];
    if (declaredVerificationGates.length > 0) {
      await evidence.append({
        phase: 'verification-gate-authorization',
        status: 'started',
        gateCount: declaredVerificationGates.length,
        gates: declaredVerificationGates.map((gate) => ({
          id: gate.id,
          phase: gate.phase,
          unitId: gate.scope.unit,
          distribution: gate.scope.distribution ?? null,
          executable: gate.command[0],
          args: gate.command.slice(1),
          cwd: gate.cwd,
        })),
      });
      if (verificationGatesAuthorized !== true) {
        await evidence.append({
          phase: 'verification-gate-authorization',
          status: 'denied',
          gateCount: declaredVerificationGates.length,
        });
        throw new ReleaseError(
          GATE_FAILED,
          `project declares ${declaredVerificationGates.length} verification gate(s). ` +
          'They run local project commands without a network sandbox. ' +
          'To proceed, pass --acknowledge-gate-side-effects (CLI) or verificationGatesAuthorized=true (API).',
          { gateIds: declaredVerificationGates.map((gate) => gate.id) },
        );
      }
      await evidence.append({
        phase: 'verification-gate-authorization',
        status: 'authorized',
        gateCount: declaredVerificationGates.length,
      });
    }

    // --- Step 3: Run declared hooks ---
    await evidence.append({ phase: 'hooks', status: 'started' });
    await runDeclaredHooks(config, realRoot, evidence, options.runHookFn ?? runHook, {
      hookCache: options.hookCache,
    });
    await evidence.append({ phase: 'hooks', status: 'completed' });

    // --- Step 3b: Re-check release-document freshness AFTER hooks ---
    // Declared hooks run as arbitrary local processes; they may rewrite a
    // release unit's authoritative version source or any declared release
    // document. Re-bind the pre-hook authoritative versions and re-run the
    // same read-only planner gate; any drift or new change fails closed
    // BEFORE the baseline, snapshots, remote checks, and plan write, so an
    // inconsistent plan can never be frozen. Skipped entirely when no unit
    // configures releaseDocuments (legacy behaviour preserved).
    if (configUnits.some((unit) => unit && unit.releaseDocuments)) {
      for (let unitIndex = 0; unitIndex < configUnits.length; unitIndex += 1) {
        const postHookVersion = await resolveUnitVersion(
          configUnits[unitIndex],
          realRoot,
          version,
        );
        if (postHookVersion !== resolvedVersions[unitIndex]) {
          await evidence.append({
            phase: 'docs-freshness',
            status: 'blocking',
            unitId: configUnits[unitIndex].id,
            reason: 'VERSION_DRIFT_AFTER_HOOKS',
          });
          throw new ReleaseError(
            RELEASE_DOCS_STALE,
            `release unit "${configUnits[unitIndex].id}" authoritative version changed after hooks`,
            {
              reason: 'VERSION_DRIFT_AFTER_HOOKS',
              unitId: configUnits[unitIndex].id,
              version: resolvedVersions[unitIndex],
              currentVersion: postHookVersion,
            },
          );
        }
      }
      await runReleaseDocsFreshnessGate({
        units: configUnits,
        resolvedVersions,
        root: realRoot,
        config,
        evidence,
        planFn: options.releaseDocsPlanFn,
        reasonTag: 'CHANGES_AFTER_HOOKS',
        expectedBindings: preHookDocsBindings,
      });
    }

    // --- Step 3c: Source authority content closure gate ---
    // After hooks complete, compute the deterministic source-input closure
    // and verify that closure inputs are clean (no staged/unstaged/untracked
    // changes). Production configs must declare sourceRepository.
    const sourceRepository = config.project?.sourceRepository ?? null;
    const configDefaultBranch = config.project?.defaultBranch ?? null;

    let sourceAuthority = null;
    let sourceInputClosure = null;
    if (production) {
      if (!sourceRepository || typeof sourceRepository !== 'string') {
        throw new ReleaseError(
          CONFIG_MISSING,
          'production prepare requires project.sourceRepository in configuration; source authority content gate needs a workspace source repository',
          { configPath },
        );
      }

      await evidence.append({ phase: 'source-authority', status: 'started' });

      // Compute source-input closure from resolved unit configs
      const unitConfigsForClosure = configUnits.map((unit, idx) => ({
        ...unit,
        version: { ...unit.version },
      }));
      sourceInputClosure = await computeSourceInputClosure({
        units: unitConfigsForClosure,
        root: realRoot,
      });

      await evidence.append({
        phase: 'source-authority',
        step: 'closure-computed',
        entryCount: sourceInputClosure.entries.length,
        inputDigest: sourceInputClosure.digest,
      });

      // Check only closure inputs for dirty (not whole workspace)
      const dirtyResult = await checkSourceInputDirty({
        closure: sourceInputClosure,
        root: realRoot,
      });
      if (dirtyResult.dirty) {
        await evidence.append({
          phase: 'source-authority',
          status: 'blocking',
          reason: 'DIRTY_SOURCE_INPUT',
          dirtyPaths: dirtyResult.dirtyPaths,
        });
        throw new ReleaseError(
          DIRTY_SOURCE_INPUT,
          `source-input closure files have uncommitted changes: ${dirtyResult.dirtyPaths.join(', ')}`,
          { dirtyPaths: dirtyResult.dirtyPaths },
        );
      }

      await evidence.append({
        phase: 'source-authority',
        step: 'dirty-check',
        status: 'clean',
      });

      // Build sourceAuthority binding for plan digest
      sourceAuthority = {
        sourceRepository,
        defaultBranch: configDefaultBranch,
        entries: sourceInputClosure.entries,
        inputDigest: sourceInputClosure.digest,
        algorithmVersion: SOURCE_INPUT_ALGORITHM_VERSION,
      };

      await evidence.append({
        phase: 'source-authority',
        status: 'completed',
        sourceRepository,
        defaultBranch: configDefaultBranch,
        inputDigest: sourceInputClosure.digest,
        remoteObservation: offline ? 'unobserved-offline' : 'deferred-to-publish',
      });
    }

    // --- Step 4: Capture Git baseline (AFTER hooks, so workspaceDigest
    //     reflects any file changes introduced by hooks) ---
    await evidence.append({ phase: 'baseline', status: 'started' });

    const baseline = await captureBaseline(realRoot);

    await evidence.append({
      phase: 'baseline',
      status: 'completed',
      gitTreeHash: baseline.gitTreeHash,
      headCommit: baseline.gitHead,
      dirtyFileCount: baseline.statusEntries.length,
    });

    // --- Step 4b: Per-unit previous public baseline observe ---
    // `configUnits` and `resolvedVersions` were resolved once in Step 1b
    // (before hook authorization and the docs freshness gate) and are reused
    // here verbatim, so the frozen plan binds exactly the versions the
    // pre-hook gate validated.
    const defaultObserveFn = async (repo, ref, expectedCommit, { githubHost = 'github.com' } = {}) => {
      try {
        const { stdout } = await execFile("git", ["ls-remote", `https://${githubHost}/${repo}.git`, ref], {
          shell: false, encoding: "utf8", timeout: 30000,
        });
        const lines = stdout.trim().split("\n").filter(l => l.length > 0);
        if (lines.length === 0) return { status: "drifted", actual: null, diff: "ref not found on remote" };
        const [remoteCommit] = lines[0].split("\t");
        if (remoteCommit === expectedCommit) return { status: "consistent", actual: remoteCommit };
        return { status: "drifted", actual: remoteCommit, diff: "expected " + expectedCommit + ", got " + remoteCommit };
      } catch (err) {
        return { status: "unknown", error: err.message };
      }
    };
    const observeFn = options.observePreviousPublicBaselineFn ?? defaultObserveFn;
    const defaultObserveDefaultBranchFn = async (repo, { githubHost = 'github.com' } = {}) => {
      try {
        const { stdout } = await execFile(
          'gh',
          ['api', `repos/${repo}`, '--jq', '.default_branch'],
          {
            shell: false,
            encoding: 'utf8',
            timeout: 30000,
            env: { ...process.env, GH_HOST: githubHost },
          },
        );
        return { status: 'observed', defaultBranch: stdout.trim() };
      } catch (error) {
        return { status: 'unknown', error: error.message };
      }
    };
    const observeDefaultBranch = options.observeDefaultBranchFn ?? defaultObserveDefaultBranchFn;
    const unitBaselineResults = new Map();
    for (let unitIndex = 0; unitIndex < configUnits.length; unitIndex += 1) {
      const unit = configUnits[unitIndex];
      const ppbConfig = unit.previousPublicBaseline;
      if (!ppbConfig) continue;
      const productionGithubHost = unit.production?.githubHost ?? 'github.com';
      const { branch, branchStrategy } = resolveProductionBranch(unit, resolvedVersions[unitIndex]);
      if (production && ['advance-existing-branch', 'initialize-default-branch'].includes(branchStrategy)) {
        if (offline) {
          throw new ReleaseError(
            GATE_FAILED,
            `unit "${unit.id}" branch strategy "${branchStrategy}" requires online production prepare`,
            { unitId: unit.id, branchStrategy },
          );
        }
        if (ppbConfig.mode !== 'bound') {
          throw new ReleaseError(
            GATE_FAILED,
            `unit "${unit.id}" branch strategy "${branchStrategy}" requires previousPublicBaseline.mode=bound`,
            { unitId: unit.id, branchStrategy },
          );
        }
        if (
          branchStrategy === 'advance-existing-branch' &&
          ppbConfig.ref !== `refs/heads/${branch}`
        ) {
          throw new ReleaseError(
            GATE_FAILED,
            `unit "${unit.id}" advance-existing-branch baseline ref must equal refs/heads/${branch}`,
            { unitId: unit.id, expectedRef: `refs/heads/${branch}`, actualRef: ppbConfig.ref },
          );
        }
      }
      const effectivePpbConfig = ppbConfig.mode === 'bound'
        ? { ...ppbConfig, githubHost: productionGithubHost }
        : ppbConfig;
      assertPreviousPublicBaselineTarget({
        baseline: effectivePpbConfig,
        githubHost: productionGithubHost,
        publicRepo: unit.publicRepo,
      });

      if (ppbConfig.mode === "none") {
        unitBaselineResults.set(unit.id, {
          mode: "none",
          status: "consistent",
        });
        await evidence.append({
          phase: "previous-public-baseline",
          unitId: unit.id,
          status: "skipped",
          reason: "fresh repository",
        });
        continue;
      }

      if (offline) {
        // Production + bound + offline: fail closed before plan write
        if (production) {
          await evidence.append({
            phase: "previous-public-baseline",
            unitId: unit.id,
            status: "blocking",
            repo: ppbConfig.repo,
            ref: ppbConfig.ref,
            commit: ppbConfig.commit,
            reason: "production bound baseline requires --online observation",
          });
          throw new ReleaseError(
            GATE_FAILED,
            `unit "${unit.id}" has bound previousPublicBaseline but production prepare uses --offline. ` +
            `Must use --online to observe the previous public baseline before freezing a production plan.`,
            { unitId: unit.id, repo: ppbConfig.repo, ref: ppbConfig.ref },
          );
        }
        // Non-production offline: record unobserved-offline for local assessment
        unitBaselineResults.set(unit.id, {
          mode: "bound",
          githubHost: productionGithubHost,
          repo: ppbConfig.repo,
          ref: ppbConfig.ref,
          commit: ppbConfig.commit,
          status: "unobserved-offline",
        });
        await evidence.append({
          phase: "previous-public-baseline",
          unitId: unit.id,
          status: "unobserved-offline",
          reason: "offline mode",
        });
        continue;
      }

      // Online bound: observe the remote ref
      await evidence.append({
        phase: "previous-public-baseline",
        unitId: unit.id,
        status: "started",
        repo: ppbConfig.repo,
        ref: ppbConfig.ref,
      });

      let result;
      try {
        result = await observePreviousPublicBaseline({
          baseline: effectivePpbConfig,
          observeFn,
          evidence,
        });
      } catch (err) {
        // Observe failed (drifted or unknown): write blocking evidence with resolution options
        const observation = err?.details ?? {};
        const mappingDiff = observation.diff
          ? { status: "available", summary: observation.diff }
          : {
              status: "unavailable",
              reason: observation.error
                ? `remote mapping observation failed: ${observation.error}`
                : "remote ref-to-commit mapping could not be determined",
            };
        await evidence.append({
          phase: "previous-public-baseline",
          unitId: unit.id,
          status: "blocking",
          repo: ppbConfig.repo,
          ref: ppbConfig.ref,
          expected: ppbConfig.commit,
          expectedCommit: ppbConfig.commit,
          actual: observation.actual ?? null,
          diff: observation.diff ?? null,
          mappingDiff,
          contentDiff: {
            status: "unavailable",
            reason: "the default previous-baseline observer resolves only ref-to-commit mapping and does not fetch remote content",
          },
          error: { code: err.code, message: err.message },
          resolutionOptions: ["merge", "adopt", "reject"],
          guidance: "把已采用改动合并回 human-owned 权威源后重新 prepare",
        });
        throw err;
      }

      unitBaselineResults.set(unit.id, {
        mode: "bound",
        githubHost: productionGithubHost,
        repo: ppbConfig.repo,
        ref: ppbConfig.ref,
        commit: ppbConfig.commit,
        observedCommit: result?.observed?.actual ?? ppbConfig.commit,
        observedAt: (clock ? clock() : new Date().toISOString()),
        status: "consistent",
      });
      await evidence.append({
        phase: "previous-public-baseline",
        unitId: unit.id,
        status: "completed",
        consistent: true,
      });

      if (production && branchStrategy === 'initialize-default-branch') {
        const expectedCurrent = unit.production?.expectedCurrentDefaultBranch;
        const observedDefault = await observeDefaultBranch(unit.publicRepo, {
          githubHost: productionGithubHost,
        });
        await evidence.append({
          phase: 'default-branch-observe',
          unitId: unit.id,
          status: observedDefault.status,
          expectedCurrentDefaultBranch: expectedCurrent,
          observedCurrentDefaultBranch: observedDefault.defaultBranch ?? null,
          ...(observedDefault.error ? { error: observedDefault.error } : {}),
        });
        if (
          observedDefault.status !== 'observed' ||
          !observedDefault.defaultBranch ||
          observedDefault.defaultBranch !== expectedCurrent
        ) {
          throw new ReleaseError(
            GATE_FAILED,
            `unit "${unit.id}" GitHub default branch does not match expectedCurrentDefaultBranch`,
            {
              unitId: unit.id,
              expectedCurrentDefaultBranch: expectedCurrent,
              observedCurrentDefaultBranch: observedDefault.defaultBranch ?? null,
              observationStatus: observedDefault.status,
            },
          );
        }
      }
    }

    // --- Step 5: Build snapshots, scan, and evaluate README ---
    const { unitResults, snapshotDigests } = await processSnapshots(
      config, realRoot, evidence, runDir, production,
    );

    // Snapshot gates always run on disposable writable copies. The public
    // snapshot authority is re-digested after every gate and is never exposed
    // as the gate working directory.
    const snapshotGateResults = await runSnapshotVerificationGates({
      gates: declaredVerificationGates,
      unitResults,
      runDir,
      evidence,
      env: options.gateEnv ?? process.env,
    });
    await evidence.append({
      phase: 'snapshot-verify',
      status: 'completed',
      gateCount: snapshotGateResults.length,
    });

    // Bind the remote source-authority proof to the exact bytes that entered
    // the frozen snapshots, not merely to an earlier read of the workspace.
    // Then re-read the complete closure and dirty state once more so version
    // sources and non-snapshot closure entries cannot drift during prepare.
    if (production) {
      const snapshotSourceResult = verifySnapshotSourcesMatchClosure({
        closure: sourceInputClosure,
        unitResults,
      });
      if (!snapshotSourceResult.passed) {
        throw new ReleaseError(
          DIRTY_SOURCE_INPUT,
          'source inputs changed between closure calculation and frozen snapshot construction',
          {
            reason: 'SNAPSHOT_SOURCE_DRIFT',
            dirtyPaths: snapshotSourceResult.error.paths,
          },
        );
      }

      const finalClosure = await computeSourceInputClosure({
        units: configUnits,
        root: realRoot,
      });
      if (finalClosure.digest !== sourceInputClosure.digest) {
        const initialByPath = new Map(
          sourceInputClosure.entries.map((entry) => [entry.path, entry]),
        );
        const finalByPath = new Map(
          finalClosure.entries.map((entry) => [entry.path, entry]),
        );
        const changedPaths = [...new Set([
          ...sourceInputClosure.entries.map((entry) => entry.path),
          ...finalClosure.entries.map((entry) => entry.path),
        ])].filter((path) => (
          JSON.stringify(initialByPath.get(path) ?? null)
          !== JSON.stringify(finalByPath.get(path) ?? null)
        )).sort();
        throw new ReleaseError(
          DIRTY_SOURCE_INPUT,
          'source-input closure changed while preparing frozen snapshots',
          { reason: 'SOURCE_CLOSURE_DRIFT', dirtyPaths: changedPaths },
        );
      }

      const finalDirtyResult = await checkSourceInputDirty({
        closure: finalClosure,
        root: realRoot,
      });
      if (finalDirtyResult.dirty) {
        throw new ReleaseError(
          DIRTY_SOURCE_INPUT,
          `source-input closure files have uncommitted changes after snapshot construction: ${finalDirtyResult.dirtyPaths.join(', ')}`,
          {
            reason: 'DIRTY_AFTER_SNAPSHOT',
            dirtyPaths: finalDirtyResult.dirtyPaths,
          },
        );
      }

      await evidence.append({
        phase: 'source-authority',
        step: 'snapshot-binding',
        status: 'completed',
        inputDigest: sourceInputClosure.digest,
        snapshotSourceCount: snapshotSourceResult.observation.snapshotSourceCount,
      });
    }

    // --- Step 6: Remote uniqueness (deferred to publish preflight) ---
    // Prepare only observes the previous public baseline (already done above).
    // Remote uniqueness checks (tag, GitHub Release, npm version) are deferred
    // to the publish phase's global preflight, which runs before any execute.
    if (!offline) {
      await evidence.append({
        phase: 'remote-check',
        status: 'deferred',
        reason: 'remote uniqueness checks (tag, GitHub Release, npm version) deferred to publish global preflight',
      });
    } else if (production) {
      await evidence.append({
        phase: 'remote-check',
        status: 'deferred',
        reason: 'offline production prepare is allowed only for an explicit fresh baseline; target branch, tag, GitHub Release, and npm uniqueness are deferred to publish global preflight before any execute',
      });
    } else {
      await evidence.append({ phase: 'remote-check', status: 'skipped', reason: 'offline mode' });
    }

    // --- Step 7: Build plan object ---
    await evidence.append({ phase: 'plan-assembly', status: 'started' });

    // New prepares emit planVersion 2 (design: t1-2-digest-decoupling.md
    // §4.2/§7). Production freeze timestamps are derived deterministically
    // from the baseline headCommit's committer date, before the first frozen
    // Git object exists. This single canonical value becomes
    // GIT_AUTHOR_DATE/GIT_COMMITTER_DATE for every unit's frozen commit and
    // every unit's frozenSnapshot.commitTimestamp; identical sources freeze
    // byte-identical Git objects on every re-prepare. The wall-clock sample
    // is still validated here (fail closed before any Git write) and becomes
    // plan.createdAt -- record-layer real clock behind the 24h approval
    // window, no longer equal to the freeze timestamp for v2 plans. The v1
    // legacy path used this same sample as the freeze timestamp itself
    // (commitTimestamp == createdAt). publish, retry, and reconcile consume
    // the frozen value from the plan and never re-read the wall clock or
    // re-derive it.
    const createdAtTimestamp = production
      ? normalizeGitTimestamp(clock ? clock() : new Date().toISOString(), 'plan createdAt timestamp')
      : null;
    const freezeTimestamp = production
      ? await readHeadCommitTimestamp(realRoot, baseline.gitHead)
      : null;

    const productionAssets = production
      ? await buildProductionAssets(
          unitResults,
          resolvedVersions,
          realRoot,
          runDir,
          unitBaselineResults,
          options.buildFrozenGitRepositoryFn ?? buildFrozenGitRepository,
          freezeTimestamp,
        )
      : null;

    // --- Step 7b: Skill resource closure gate ---
    // Production snapshots are sealed inside buildProductionAssets. Scan only
    // after that transition so the receipt binds the exact byte/mode identity
    // publish will re-verify, rather than the writable pre-freeze staging tree.
    // Non-production plans scan the final staging tree at the same point.
    // This gate is built in, read-only, and cannot be disabled by overlays.
    const skillResourceClosureResults = [];
    for (const { unit, manifest } of unitResults) {
      await evidence.append({
        phase: 'skill-resource-closure',
        status: 'started',
        unitId: unit.id,
      });

      const closureResult = await checkSkillResourceClosure({
        snapshotDir: manifest.outputDir,
        host: 'root',
      });

      const receipt = createSkillResourceClosureReceipt(closureResult, { unitId: unit.id });
      skillResourceClosureResults.push(receipt);

      if (closureResult.findings.length > 0) {
        await evidence.append({
          phase: 'skill-resource-closure',
          status: 'blocking',
          unitId: unit.id,
          findingCount: closureResult.findings.length,
          findings: closureResult.findings.map((f) => ({
            skill: f.skill,
            line: f.line,
            reference: f.reference,
            classification: f.classification,
            code: f.code,
          })),
        });
        throw new ReleaseError(
          GATE_FAILED,
          `skill resource closure gate failed for unit "${unit.id}": ${closureResult.findings.length} finding(s)`,
          {
            unitId: unit.id,
            findingCount: closureResult.findings.length,
            findings: closureResult.findings,
          },
        );
      }

      await evidence.append({
        phase: 'skill-resource-closure',
        status: 'completed',
        unitId: unit.id,
        checkerVersion: closureResult.checkerVersion,
        surfaceCount: receipt.surfaceCount,
        skillCount: receipt.skillCount,
        referenceCount: closureResult.referenceCount,
        sourceOnlyCount: closureResult.sourceOnlyCount,
        findingCount: 0,
        receiptDigest: closureResult.receiptDigest,
      });
    }

    // Freeze external independent marketplace HEADs (production + online only):
    // for each claude/codex/codebuddy distribution declaring marketplaceRepo,
    // resolve the external repo's HEAD sha + default branch and validate the
    // marketplace index entry at that sha before freezing the add-ref. This
    // MUST happen before installation contract construction so that standalone-index
    // contracts can use the frozen external entries. Offline production with a
    // declared marketplaceRepo fails closed inside the resolver. The remote is
    // only ever read (git ls-remote / gh api), never written.
    const externalMarketplaceFreezes = production
      ? await resolveExternalMarketplaceFreezes({
          unitResults,
          resolvedVersions,
          offline,
          evidence,
          observeHeadFn: options.observeExternalMarketplaceHeadFn ?? defaultObserveExternalMarketplaceHead,
          fetchIndexFn: options.fetchExternalMarketplaceIndexFn ?? defaultFetchExternalMarketplaceIndex,
        })
      : new Map();

    // 为每个分发渠道校验 marketplaceSourceType 并冻结安装契约。
    // 对每个插件 distribution：
    // 1. 从 unitResults[].manifest.outputDir 的真实快照读取 manifest
    // 2. manifest 读取：若平台 strategy.readManifest 存在则调用它，否则读 platform.manifestPaths.plugin
    // 3. 确定 includeMarketplaceEntry：
    //    - bundled-family: Kimi=false, Claude/Codex/CodeBuddy=true（从快照读取）
    //    - standalone-index: Kimi=false, Claude/Codex/CodeBuddy=true（使用外部冻结条目）
    // 4. 需要条目时：
    //    - bundled-family: 从 dist.marketplaceIndexPath ?? platform.manifestPaths.marketplace 读取 bundled 索引
    //    - standalone-index: 从 externalMarketplaceFreezes 获取冻结的 selectedEntry 和 marketplaceIndexPath
    // 5. 使用 buildInstallationContract 构建完整可审计契约对象
    // 6. 在 distribution 中冻结 marketplaceSourceType / installationContract / installationContractDigest
    //    以及独立市场审计字段
    const units = await Promise.all(unitResults.map(async ({ unit, manifest }, idx) => {
      const unitVersion = resolvedVersions[idx];
      const unitBaseline = unitBaselineResults.get(unit.id);
      const snapshotDir = manifest.outputDir;

      const distributionsWithSource = await Promise.all((unit.distributions ?? []).map(async (dist) => {
        const platform = PLATFORMS.find((p) => p.distributionType === dist.type);
        if (!platform) return dist;

        // 校验 marketplaceSourceType：从配置读取，不允许硬编码默认值
        const sourceTypeResult = validateMarketplaceSourceSelection(
          platform.id,
          dist,  // config
          dist,  // plan (same source at prepare time)
        );
        if (!sourceTypeResult.valid) {
          throw new ReleaseError(
            CONFIG_INVALID,
            `unit "${unit.id}" ${dist.type} marketplace source validation failed: ${sourceTypeResult.error}`,
            { unitId: unit.id, distributionType: dist.type },
          );
        }

        // 仅插件 distribution 需要安装契约
        if (dist.type === 'npm') {
          return dist;
        }

        // 1. 确定 marketplaceSourceType（防御性归一化：旧配置可能仍缺少字段）
        let marketplaceSourceType = sourceTypeResult.selectedSource;
        if (!marketplaceSourceType) {
          marketplaceSourceType = dist.marketplaceRepo ? 'standalone-index' : 'bundled-family';
        }

        // 2. 确定 includeMarketplaceEntry 和 selectedMarketplaceEntry
        // bundled-family: 从快照中的 bundled 索引读取唯一选中条目。
        // standalone-index: 从 externalMarketplaceFreezes 获取冻结的 selectedEntry 和 marketplaceIndexPath。
        // Kimi 不纳入市场条目（platform.manifestPaths.marketplace === null 且无显式路径）；
        // Claude/Codex/CodeBuddy 使用默认或显式路径。
        const hasDefaultMarketplace = platform.manifestPaths.marketplace !== null;
        const hasExplicitMarketplacePath = dist.marketplaceIndexPath != null;
        const isBundledFamily = marketplaceSourceType === 'bundled-family';
        const isStandaloneIndex = marketplaceSourceType === 'standalone-index';

        // includeMarketplaceEntry 代表"契约实际包含一条市场条目"，
        // 不能只代表平台理论上支持市场条目。
        // bundled-family: 平台支持市场时即包含（从快照读取）
        // standalone-index: 只有拿到冻结条目且非 Kimi 时才包含
        // Kimi 不纳入市场条目：Kimi 无市场 CLI，selectedEntry 仅供静态校验。
        let includeMarketplaceEntry;
        if (isBundledFamily) {
          includeMarketplaceEntry = hasDefaultMarketplace || hasExplicitMarketplacePath;
        } else if (isStandaloneIndex) {
          if (platform.id === 'kimi') {
            // Kimi standalone: 安装契约不纳入市场条目
            includeMarketplaceEntry = false;
          } else {
            const freezeKey = `${unit.id} ${dist.type}`;
            const freeze = externalMarketplaceFreezes.get(freezeKey);
            if (freeze) {
              includeMarketplaceEntry = true;
            } else {
              // 生产在线的独立市场缺冻结结果必须失败关闭
              if (production && !offline) {
                throw new ReleaseError(
                  GATE_FAILED,
                  `unit "${unit.id}" ${dist.type} standalone-index requires external marketplace freeze but no freeze result found`,
                  { unitId: unit.id, distributionType: dist.type },
                );
              }
              // 非生产/离线没有冻结结果时，契约仍记录来源形态，但不包含空条目
              includeMarketplaceEntry = false;
            }
          }
        } else {
          includeMarketplaceEntry = false;
        }

        // 3. 需要条目时，根据来源类型获取
        let selectedMarketplaceEntry = null;
        let marketplaceIndexRelative = null;
        let bundledMarketIndex = null;
        if (includeMarketplaceEntry) {
          if (isStandaloneIndex) {
            // standalone-index: 从外部冻结结果获取条目和路径（freeze 已确认存在）
            const freezeKey = `${unit.id} ${dist.type}`;
            const freeze = externalMarketplaceFreezes.get(freezeKey);
            selectedMarketplaceEntry = freeze.selectedEntry;
            marketplaceIndexRelative = freeze.marketplaceIndexPath;
          } else {
            // bundled-family: 从快照中的 bundled 索引读取
            marketplaceIndexRelative = dist.marketplaceIndexPath ?? platform.manifestPaths.marketplace;
            if (!marketplaceIndexRelative) {
              throw new ReleaseError(
                GATE_FAILED,
                `unit "${unit.id}" ${dist.type} cannot determine marketplace index path: neither marketplaceIndexPath nor platform.manifestPaths.marketplace is set`,
                { unitId: unit.id, distributionType: dist.type },
              );
            }
            const marketplaceIndexPath = resolve(snapshotDir, marketplaceIndexRelative);
            let marketplaceIndexRaw;
            try {
              marketplaceIndexRaw = await readFile(marketplaceIndexPath, 'utf8');
            } catch (err) {
              throw new ReleaseError(
                GATE_FAILED,
                `unit "${unit.id}" ${dist.type} cannot read bundled marketplace index "${marketplaceIndexRelative}": ${err.message}`,
                { unitId: unit.id, distributionType: dist.type, cause: err.code },
              );
            }
            let marketplaceIndex;
            try {
              marketplaceIndex = JSON.parse(marketplaceIndexRaw);
            } catch (err) {
              throw new ReleaseError(
                GATE_FAILED,
                `unit "${unit.id}" ${dist.type} invalid JSON in bundled marketplace index "${marketplaceIndexRelative}": ${err.message}`,
                { unitId: unit.id, distributionType: dist.type },
              );
            }
            if (!marketplaceIndex || typeof marketplaceIndex !== 'object' || !Array.isArray(marketplaceIndex.plugins)) {
              throw new ReleaseError(
                GATE_FAILED,
                `unit "${unit.id}" ${dist.type} bundled marketplace index "${marketplaceIndexRelative}" must be an object with a plugins array`,
                { unitId: unit.id, distributionType: dist.type },
              );
            }
            const matchingEntries = marketplaceIndex.plugins.filter(
              (entry) => entry && entry.name === dist.plugin,
            );
            if (matchingEntries.length !== 1) {
              throw new ReleaseError(
                GATE_FAILED,
                `unit "${unit.id}" ${dist.type} bundled marketplace index must contain exactly one plugin entry named "${dist.plugin}", found ${matchingEntries.length}`,
                { unitId: unit.id, distributionType: dist.type },
              );
            }
            // 传完整解析条目给 buildInstallationContract，不得只取名字
            selectedMarketplaceEntry = matchingEntries[0];
            bundledMarketIndex = marketplaceIndex;
          }
        }

        // 4. 从真实快照读取插件 manifest
        //    bundled-family + 有市场索引：使用 resolvePluginManifestFromMarketplaceEntrySource
        //    从条目 source 安全解析插件根并读取 manifest（支持子目录布局）。
        //    其他路径：保留原有策略。
        let pluginManifestRelative;
        let pluginManifestParsed;
        if (isBundledFamily && bundledMarketIndex && platform.marketplaceSourceForm !== null) {
          // bundled-family 有市场索引且平台支持市场来源解析（Claude/Codex）：
          // 通过条目 source 路径解析 manifest。
          // 计算市场根：从 marketplaceIndexRelative 推断（精确后缀匹配）。
          const mktRoot = resolveMarketplaceRoot(platform, marketplaceIndexRelative);
          try {
            const resolved = await resolvePluginManifestFromMarketplaceEntrySource(
              bundledMarketIndex, dist.plugin, platform, snapshotDir, mktRoot,
            );
            pluginManifestParsed = resolved.manifest;
            pluginManifestRelative = resolved.manifestRelativePath;
          } catch (err) {
            throw new ReleaseError(
              GATE_FAILED,
              `unit "${unit.id}" ${dist.type} cannot resolve plugin manifest from marketplace entry source: ${err.message}`,
              { unitId: unit.id, distributionType: dist.type },
            );
          }
        } else if (platform.strategy.readManifest) {
          // Kimi/Codex/CodeBuddy 有自定义 manifest 读取策略
          const readResult = await platform.strategy.readManifest(snapshotDir);
          pluginManifestParsed = readResult.manifest;
          pluginManifestRelative = readResult.manifestRelative ?? platform.manifestPaths.plugin;
        } else {
          // Claude fallback（standalone-index 或无市场索引时）
          pluginManifestRelative = platform.manifestPaths.plugin;
          const pluginManifestPath = resolve(snapshotDir, pluginManifestRelative);
          let raw;
          try {
            raw = await readFile(pluginManifestPath, 'utf8');
          } catch (err) {
            throw new ReleaseError(
              GATE_FAILED,
              `unit "${unit.id}" ${dist.type} cannot read plugin manifest "${pluginManifestRelative}": ${err.message}`,
              { unitId: unit.id, distributionType: dist.type, cause: err.code },
            );
          }
          try {
            pluginManifestParsed = JSON.parse(raw);
          } catch (err) {
            throw new ReleaseError(
              GATE_FAILED,
              `unit "${unit.id}" ${dist.type} invalid JSON in plugin manifest "${pluginManifestRelative}": ${err.message}`,
              { unitId: unit.id, distributionType: dist.type },
            );
          }
        }

        // 静态校验 manifest 名称和版本（被摘要剔除不等于不校验）
        if (pluginManifestParsed.name !== dist.plugin) {
          throw new ReleaseError(
            GATE_FAILED,
            `unit "${unit.id}" ${dist.type} plugin manifest name "${pluginManifestParsed.name}" does not match distribution plugin "${dist.plugin}"`,
            { unitId: unit.id, distributionType: dist.type },
          );
        }
        if (typeof pluginManifestParsed.version === 'string' && pluginManifestParsed.version !== unitVersion) {
          throw new ReleaseError(
            GATE_FAILED,
            `unit "${unit.id}" ${dist.type} plugin manifest version "${pluginManifestParsed.version}" does not match target version "${unitVersion}"`,
            { unitId: unit.id, distributionType: dist.type },
          );
        }

        // 5. 使用 buildInstallationContract 构建完整可审计契约对象
        const installationContract = buildInstallationContract({
          distributionType: dist.type,
          manifestRelativePath: pluginManifestRelative,
          manifest: pluginManifestParsed,
          marketplaceSourceType,
          includeMarketplaceEntry,
          ...(includeMarketplaceEntry ? {
            marketplaceIndexRelativePath: marketplaceIndexRelative,
            selectedMarketplaceEntry,
          } : {}),
          verificationRecipeVersion: CONSUMER_INSTALL_RECIPE_VERSION,
        });

        // 6. 计算摘要（使用权威算法入口，保证契约对象与摘要一致）
        const installationContractDigest = computeInstallationContractDigest({
          distributionType: dist.type,
          manifestRelativePath: pluginManifestRelative,
          manifest: pluginManifestParsed,
          marketplaceSourceType,
          includeMarketplaceEntry,
          ...(includeMarketplaceEntry ? {
            marketplaceIndexRelativePath: marketplaceIndexRelative,
            selectedMarketplaceEntry,
          } : {}),
          verificationRecipeVersion: CONSUMER_INSTALL_RECIPE_VERSION,
        });

        // 7. 构建返回对象，包含冻结的审计字段
        const frozenDist = {
          ...dist,
          marketplaceSourceType,
          installationContract,
          installationContractDigest,
        };

        // standalone-index 审计字段：来自外部冻结结果
        if (isStandaloneIndex) {
          const freezeKey = `${unit.id} ${dist.type}`;
          const freeze = externalMarketplaceFreezes.get(freezeKey);
          if (freeze) {
            frozenDist.marketplaceRepo = freeze.marketplaceRepo;
            frozenDist.marketplaceCommitSha = freeze.marketplaceCommitSha;
            frozenDist.marketplaceRef = freeze.marketplaceRef;
            frozenDist.marketplaceIndexPath = freeze.marketplaceIndexPath;
            frozenDist.marketplaceName = freeze.marketplaceName;
            frozenDist.selectedEntry = freeze.selectedEntry;
          }
        }

        return frozenDist;
      }));

      return {
        id: unit.id,
        targetVersion: unitVersion,
        source: unit.source,
        publicRepo: unit.publicRepo,
        tagTemplate: unit.version?.tagTemplate,
        snapshotDigest: snapshotDigests[idx],
        ...(productionAssets ? {
          productionConfig: normalizedProductionConfig(unit),
          frozenSnapshot: {
            path: productionAssets[idx].snapshotPath,
            manifestDigest: productionAssets[idx].manifestDigest,
            gitObjectDir: productionAssets[idx].gitObjectDir,
            branch: productionAssets[idx].branch,
            branchStrategy: productionAssets[idx].branchStrategy,
            commit: productionAssets[idx].commit,
            tree: productionAssets[idx].tree,
            commitTimestamp: productionAssets[idx].commitTimestamp,
            ...(productionAssets[idx].parentCommit
              ? { parentCommit: productionAssets[idx].parentCommit }
              : {}),
            npm: productionAssets[idx].npm,
          },
        } : {}),
        distributions: distributionsWithSource,
        ...(unitBaseline ? { previousPublicBaseline: unitBaseline } : {}),
      };
    }));

    // 构建冻结分发映射：unitId -> frozen distributions
    const frozenDistributionsMap = new Map(units.map((u) => [u.id, u.distributions]));

    const externalActions = buildExternalActions(unitResults, resolvedVersions, productionAssets, externalMarketplaceFreezes, frozenDistributionsMap);

    // Compute overall snapshot digest
    const overallSnapshotDigest = sha256Hex(snapshotDigests.join(':'));

    const plan = {
      planVersion: 2,
      status: 'PREPARED',
      baseline: {
        gitTreeHash: baseline.gitTreeHash,
        headCommit: baseline.gitHead,
        workspaceDigestAlgorithm: baseline.workspaceDigestAlgorithm,
        workspaceDigest: baseline.workspaceDigest,
        dirtyFiles: baseline.statusEntries,
        capturedAt: baseline.capturedAt,
      },
      configDigest,
      skillResourceClosure: {
        checkerVersion: SKILL_RESOURCE_CHECKER_VERSION,
        unitReceipts: skillResourceClosureResults,
        totalSkillCount: skillResourceClosureResults.reduce((sum, item) => sum + item.skillCount, 0),
        totalReferenceCount: skillResourceClosureResults.reduce((sum, item) => sum + item.referenceCount, 0),
        totalSourceOnlyCount: skillResourceClosureResults.reduce((sum, item) => sum + item.sourceOnlyCount, 0),
        totalFindingCount: 0,
      },
      verificationGates: config.verificationGates ?? [],
      snapshotDigest: overallSnapshotDigest,
      ...(production ? {
        production: {
          mode: 'github-npm-v1',
          assetRoot: relative(realRoot, runDir),
        },
      } : {}),
      units,
      externalActions,
      ...(sourceAuthority ? { sourceAuthority } : {}),
      createdAt: production ? createdAtTimestamp : (clock ? clock() : new Date().toISOString()),
    };

    await evidence.append({
      phase: 'plan-assembly',
      status: 'completed',
      unitCount: units.length,
      actionCount: externalActions.length,
    });

    // --- Step 8: Validate and write plan atomically ---
    await evidence.append({ phase: 'plan-write', status: 'started' });

    const latestPlanPath = output ?? resolve(releaseDir, 'release-plan.json');
    const plannedDigest = computePlanDigest(plan);
    const immutablePlanPath = resolve(dirname(latestPlanPath), 'plans', `${plannedDigest}.json`);
    const { planPath: writtenPath, planDigest } = await writePlanImmutable(immutablePlanPath, plan);
    // This is a convenience copy only. All downstream authority uses the
    // digest-addressed immutable path returned above.
    await writePlanAtomic(latestPlanPath, plan);

    await evidence.append({
      phase: 'plan-write',
      status: 'completed',
      planPath: writtenPath,
      planDigest,
    });

    // --- Write summary ---
    await evidence.finish({
      status: 'PREPARED',
      planPath: writtenPath,
      planDigest,
      configDigest,
      snapshotDigest: overallSnapshotDigest,
      unitCount: units.length,
      actionCount: externalActions.length,
      offline,
      completedAt: (clock ? clock() : new Date().toISOString()),
    });

    return {
      planPath: writtenPath,
      planDigest,
      evidenceDir,
    };
  } catch (err) {
    // Record failure evidence
    await evidence.append({
      phase: 'prepare',
      status: 'failed',
      error: { code: err.code, message: err.message },
    });

    await evidence.finish({
      status: 'FAILED',
      error: { code: err.code, message: err.message },
      failedAt: (clock ? clock() : new Date().toISOString()),
    });

    throw err;
  } finally {
    // Release project lock — always, even on failure
    await lock.release();
  }
}
