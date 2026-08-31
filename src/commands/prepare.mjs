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

import { resolve, relative, isAbsolute, normalize, dirname, basename, posix as pathPosix } from 'node:path';
import { readFile, mkdir, readdir, realpath, lstat } from 'node:fs/promises';
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';

const execFile = promisify(execFileCb);

import { classifyPathInput, writeFileAtomic, withTemporaryWorkspace } from 'skill-family-harness-node';
import { loadProjectConfig } from '../core/config.mjs';
import { captureBaseline } from '../core/baseline.mjs';
import { runHook } from '../core/hooks.mjs';
import { computeHookCacheKey, readHookCache, writeHookCache } from '../core/hook-cache.mjs';
import {
  assertExpectedPublicSurface,
  collectExpectedPublicSurfaceAdoptionWarnings,
} from '../core/public-surface.mjs';
import { runSnapshotVerificationGates } from '../core/verification-gates.mjs';
import { asError, createEvidenceWriter } from '../core/evidence.mjs';
import { computePlanDigest, writePlanAtomic, writePlanImmutable } from '../core/plan.mjs';
import { sha256Hex } from '../core/digest.mjs';
import {
  CHECKER_VERSION as SKILL_RESOURCE_CHECKER_VERSION,
  checkSkillResourceClosure,
  createSkillResourceClosureReceipt,
  evaluateDeclaredHostSurfaceCoverage,
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
import { ReleaseError, GATE_FAILED, CONFIG_INVALID, CONFIG_MISSING, FORBIDDEN_CONTENT_DETECTED, RELEASE_DOCS_STALE, DIRTY_SOURCE_INPUT, BUNDLE_STALE } from '../core/errors.mjs';
import { assertBundleFreshness } from '../core/bundle-freshness.mjs';
import {
  assertAdapterFreshness,
  assertPlatformManifestFreshness,
  assertSelfBootstrapFacts,
} from '../core/derived-artifact-gates.mjs';
import { isFoundationPluginVerificationEligible } from '../core/foundation-plugin-verification.mjs';
import { PKG_ROOT } from '../core/pkg-root.mjs';
import { writeFrozenMarker, FROZEN_MARKER_FILENAME } from '../core/frozen-marker.mjs';
import {
  SOURCE_INPUT_ALGORITHM_VERSION,
  REPOSITORY_RE,
  createPublicSourceAuthorityReceipt,
  computeSourceInputClosure,
  checkSourceInputDirty,
  verifySnapshotSourcesMatchClosure,
} from '../core/source-authority.mjs';
import { acquireProjectLock } from '../artifacts/project-lock.mjs';
import { observePreviousPublicBaseline } from '../core/previous-public-baseline.mjs';
import { verifyFrozenNpmTarballContract } from '../adapters/npm.mjs';
import { createProductionPrepareRunDir } from '../core/run.mjs';
import { PLATFORMS, normalizeHostId } from '../platforms/registry.mjs';
import { deriveSurfaceHostBinding, pluginRootFromManifestRelativePath } from '../core/surface-host-bindings.mjs';
import { validateMarketplaceSourceSelection, MARKETPLACE_SOURCE_TYPES, resolvePluginManifestFromMarketplaceEntrySource, resolveMarketplaceRoot } from '../adapters/plugin-marketplace.mjs';
import { buildInstallationContract, computeInstallationContractDigest, INSTALLATION_CONTRACT_ALGORITHM_VERSION } from '../core/installation-contract.mjs';
import {
  validatePostPublishDeclaration,
  normalizePostPublishDeclaration,
  orderNormalizedHooks,
  validatePostPublishHookIdUniqueness,
  PAYLOAD_SOURCE_TAG_WORKTREE,
} from '../core/postpublish.mjs';
import { freezeExecutionBundle, bundleRootForAuthorityDir } from '../core/postpublish-bundle.mjs';
import { digestReleaseAssetIdentities } from '../core/release-assets.mjs';

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

// v0.6.3 R1 tail unification: the "last 50 lines / 8 KiB" tail authority now
// lives in core/bounded-output.mjs, shared by prepare and distribute. The
// re-export preserves prepare's historical public surface.
export {
  boundedOutputTail,
  HOOK_OUTPUT_TAIL_MAX_LINES,
  HOOK_OUTPUT_TAIL_MAX_BYTES,
} from '../core/bounded-output.mjs';
import { boundedOutputTail } from '../core/bounded-output.mjs';

/**
 * Run all declared project hooks in order: lint, docs, build, test, typecheck.
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
 * Failure output passthrough (2026-08-18 investigation §4.1): the executor
 * already captures child stdout/stderr on non-zero exit; on failure this
 * layer writes bounded tails into the hooks evidence event AND echoes them to
 * the current process' stderr, so a failing hook is diagnosable on the
 * terminal without opening evidence.jsonl. Success events carry no tails.
 * Exit-code semantics are unchanged.
 *
 * @param {object} config - The loaded project config.
 * @param {string} root - Absolute project root.
 * @param {object} evidence - The evidence writer.
 * @param {Function} [hookFn] - Hook runner (default runHook); tests inject a
 *   spy that records call order while delegating to the real implementation.
 * @param {object} [options]
 * @param {boolean} [options.hookCache=true] - When false (--no-hook-cache),
 *   every hook runs in full and the cache is neither read nor written.
 * @param {Record<string, string>} [options.env] - Explicit environment map
 *   merged into the hook context (`hookFn(hook, { root, env })`). The hook
 *   runner's `buildFilteredEnv` reads `envAllowlist` keys exclusively from
 *   this map (never from process.env), so the caller decides what is
 *   injectable. Defaults to process.env at the prepare call site, which makes
 *   allowlisted keys exported by the invoking shell reach the hook
 *   subprocess.
 * @returns {Promise<Array<{ name: string, completed: boolean, cached: boolean, testSelection: string | undefined }>>}
 *   One record per declared hook that completed (fresh or cached replay).
 *   Failures throw instead of returning a record.
 * @throws {ReleaseError} GATE_FAILED if any hook returns a non-zero exit code,
 *   throws, or declares a cacheInputs glob that matches no file.
 */
export const HOOK_EXECUTION_ORDER = Object.freeze(['lint', 'docs', 'build', 'test', 'typecheck']);

export async function runDeclaredHooks(config, root, evidence, hookFn = runHook, options = {}) {
  const hooks = config.hooks ?? {};
  const cacheEnabled = options.hookCache !== false;
  const records = [];

  for (const name of HOOK_EXECUTION_ORDER) {
    const hook = hooks[name];
    if (!hook) continue;

    // Test-selection evidence (2026-08-18 investigation §4.4): the test hook
    // records whether it ran the full suite. Absence of a declaration means
    // 'full' — every existing config stays backward compatible.
    const selectionField = name === 'test'
      ? { testSelection: hook.testSelection === 'incremental' ? 'incremental' : 'full' }
      : {};

    await evidence.append({
      phase: 'hooks',
      status: 'started',
      hookName: name,
      ...selectionField,
    });

    // --- Incremental cache lookup (opt-in only; default zero change) ---
    let cacheKey;
    let cacheReceipt;
    let cacheRootBinding;
    if (cacheEnabled && hook.cacheable === true) {
      try {
        ({ cacheKey, receipt: cacheReceipt, projectRootBinding: cacheRootBinding } = await computeHookCacheKey(hook, root, {
          env: options.env ?? process.env,
          ...(typeof options.observeExecutableIdentityFn === 'function'
            ? { observeExecutableIdentityFn: options.observeExecutableIdentityFn }
            : {}),
        }));
      } catch (err) {
        await evidence.append({
          phase: 'hooks',
          status: 'failed',
          hookName: name,
          error: { code: err.code, message: err.message },
        });
        throw err;
      }

      const cached = cacheKey ? await readHookCache(root, name, cacheKey, {
        rootBinding: cacheRootBinding,
      }) : null;
      if (cached) {
        // Cache hit: skip execution. The authorization gate already passed and
        // no GATE is bypassed — ordering and failure semantics are untouched.
        await evidence.append({
          phase: 'hooks',
          status: 'completed',
          hookName: name,
          cached: true,
          cacheKey,
          ...selectionField,
        });
        records.push({ name, completed: true, cached: true, testSelection: selectionField.testSelection });
        continue;
      }
    }

    let result;
    try {
      result = await hookFn(hook, {
        root,
        ...(options.env !== undefined ? { env: options.env } : {}),
      });
    } catch (err) {
      await evidence.append({
        phase: 'hooks',
        status: 'failed',
        hookName: name,
        error: { code: err.code, message: err.message },
        ...selectionField,
      });
      throw new ReleaseError(
        GATE_FAILED,
        `hook "${name}" failed: ${err.message}`,
        { hookName: name, cause: err.code },
      );
    }

    if (result.exitCode !== 0) {
      const stdoutTail = boundedOutputTail(result.stdout);
      const stderrTail = boundedOutputTail(result.stderr);
      // Echo the captured tails to the current process' stderr so a failing
      // hook is diagnosable on the terminal without opening evidence.jsonl
      // (2026-08-18 investigation §4.1). Exit-code semantics are untouched.
      process.stderr.write(`[release-skill] hook "${name}" failed with exit code ${result.exitCode}\n`);
      if (stdoutTail) {
        process.stderr.write(`[release-skill] hook "${name}" stdout tail:\n${stdoutTail}\n`);
      }
      if (stderrTail) {
        process.stderr.write(`[release-skill] hook "${name}" stderr tail:\n${stderrTail}\n`);
      }
      await evidence.append({
        phase: 'hooks',
        status: 'failed',
        hookName: name,
        exitCode: result.exitCode,
        // Test runners usually emit the actionable failure summary at the
        // end. Preserve bounded tails (last 50 lines, capped at 8 KB) of both
        // streams instead of the noisy compiler prelude at the beginning.
        stdoutTail,
        stderrTail,
        ...selectionField,
      });
      throw new ReleaseError(
        GATE_FAILED,
        `hook "${name}" exited with code ${result.exitCode}`,
        { hookName: name, exitCode: result.exitCode },
      );
    }

    // --- Write cache on success only; failures are never cached ---
    if (cacheEnabled && hook.cacheable === true && cacheKey && cacheReceipt) {
      const written = await writeHookCache(root, name, cacheKey, {
        exitCode: 0,
        stdoutTail: result.stdout.slice(-4000),
        stderrTail: result.stderr.slice(-4000),
        receipt: cacheReceipt,
      }, { rootBinding: cacheRootBinding });
      if (!written.ok) {
        // The cache is an optimisation, not a gate: a write failure must not
        // abort prepare. Surface it as a warning-level evidence event.
        await evidence.append({
          phase: 'hooks',
          status: 'warning',
          hookName: name,
          warning: 'hook cache write failed; continuing without caching',
          error: { code: 'HOOK_CACHE_WRITE_FAILED', message: written.error },
        });
      }
    }

    await evidence.append({
      phase: 'hooks',
      status: 'completed',
      hookName: name,
      exitCode: 0,
      ...selectionField,
    });
    records.push({ name, completed: true, cached: false, testSelection: selectionField.testSelection });
  }

  return records;
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

/**
 * R-03 (WP-5): pure-config consistency rules for ONE production unit,
 * collected as independent defects (T10, ruling 21).
 *
 * Only checks that depend on NO build artifact, NO snapshot, NO remote
 * observation and NO public-file scan belong here: branchStrategy
 * requirements (online, bound baseline, matching ref) and
 * previousPublicBaseline repo/host consistency with the production unit.
 * Shared by the pre-hook Step 2b gate (aggregating collector) and the
 * post-hook baseline section (throwing projection) so the two windows can
 * never drift apart.
 *
 * The repo/host conditions mirror core/previous-public-baseline.mjs
 * `assertPreviousPublicBaselineTarget` (which stays the authority for
 * publish/reconcile) with identical message text.
 *
 * @param {Object} unit - Resolved release unit config.
 * @param {string} version - Resolved target version (branch derivation).
 * @param {Object} input
 * @param {boolean} input.production - Production prepare flag.
 * @param {boolean} input.offline - Offline prepare flag.
 * @param {string} input.githubHost - Production GitHub host.
 * @param {Array<Object>} defects - Collector for
 *   `{ code, unitId, field, message, remediation }` entries.
 */
function collectProductionUnitPureConfigDefects(unit, version, { production, offline, githubHost }, defects) {
  const ppbConfig = unit.previousPublicBaseline;
  if (!ppbConfig) return;
  const { branch, branchStrategy } = resolveProductionBranch(unit, version);
  if (production && ['advance-existing-branch', 'initialize-default-branch'].includes(branchStrategy)) {
    if (offline) {
      defects.push({
        code: GATE_FAILED,
        unitId: unit.id,
        field: `releaseUnits[${unit.id}].production.branchStrategy`,
        message:
          `unit "${unit.id}" branch strategy "${branchStrategy}" requires online production prepare. ` +
          `Remediation: release-skill prepare --production --online`,
        remediation: 'release-skill prepare --production --online',
      });
    }
    if (ppbConfig.mode !== 'bound') {
      defects.push({
        code: GATE_FAILED,
        unitId: unit.id,
        field: `releaseUnits[${unit.id}].previousPublicBaseline.mode`,
        message: `unit "${unit.id}" branch strategy "${branchStrategy}" requires previousPublicBaseline.mode=bound`,
        remediation: 'set previousPublicBaseline.mode=bound and freeze the previous release commit',
      });
    }
    if (
      branchStrategy === 'advance-existing-branch' &&
      ppbConfig.ref !== `refs/heads/${branch}`
    ) {
      defects.push({
        code: GATE_FAILED,
        unitId: unit.id,
        field: `releaseUnits[${unit.id}].previousPublicBaseline.ref`,
        message: `unit "${unit.id}" advance-existing-branch baseline ref must equal refs/heads/${branch}`,
        remediation: `set previousPublicBaseline.ref to refs/heads/${branch}`,
      });
    }
  }
  if (ppbConfig.mode === 'bound') {
    if (ppbConfig.repo !== unit.publicRepo) {
      defects.push({
        code: GATE_FAILED,
        unitId: unit.id,
        field: `releaseUnits[${unit.id}].previousPublicBaseline.repo`,
        message: 'previous public baseline repo does not match the production repository',
        remediation: `align previousPublicBaseline.repo with the unit publicRepo "${unit.publicRepo}"`,
      });
    }
    // T09 (ruling 21): only fill the host default when the baseline does NOT
    // declare githubHost; an explicit value is preserved and compared so a
    // real host conflict is detected instead of being overwritten away.
    const baselineHost = ppbConfig.githubHost ?? githubHost;
    if (baselineHost !== githubHost) {
      defects.push({
        code: GATE_FAILED,
        unitId: unit.id,
        field: `releaseUnits[${unit.id}].previousPublicBaseline.githubHost`,
        message: 'previous public baseline host does not match the production GitHub host',
        remediation: 'align previousPublicBaseline.githubHost with the unit production githubHost (or remove the explicit host to use the default)',
      });
    }
  }
}

/**
 * R-03 (WP-5) throwing projection: fail on the first defect of one production
 * unit. Used by the post-hook baseline re-validation window (the pre-hook
 * Step 2b gate aggregates ALL independent defects via the collector above).
 *
 * @throws {ReleaseError} on the first collected consistency defect.
 */
function assertProductionUnitPureConfig(unit, version, { production, offline, githubHost }) {
  const defects = [];
  collectProductionUnitPureConfigDefects(
    unit,
    version,
    { production, offline, githubHost },
    defects,
  );
  if (defects.length > 0) {
    const first = defects[0];
    throw new ReleaseError(first.code, first.message, {
      unitId: first.unitId,
      field: first.field,
      remediation: first.remediation,
    });
  }
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
 * O5 (2026-08-18 release-cycle investigation §3.2): observe how the local
 * workspace HEAD relates to `origin/<defaultBranch>` for an ONLINE production
 * prepare. This is a WARNING-LEVEL, non-blocking pre-publish signal: in the
 * 0.6.1 cycle a workspace 15 commits ahead of origin only surfaced when the
 * publish source-authority gate rejected it. Pushing is a legitimate
 * pre-publish action, so the observation must inform, never block the freeze.
 *
 * Read-only git plumbing only (argv arrays, no shell): rev-parse, ls-remote,
 * cat-file, rev-list. Every failure degrades to a descriptive status object —
 * this function NEVER throws, so it can never break a freeze.
 *
 * @param {object} options
 * @param {string} options.root - Workspace (git repository) root.
 * @param {string} options.defaultBranch - Default branch name on origin.
 * @returns {Promise<{
 *   status: 'in-sync' | 'ahead' | 'behind' | 'diverged' | 'no-origin' | 'remote-ref-missing' | 'unknown',
 *   localHead?: string,
 *   remoteHead?: string,
 *   aheadCount?: number,
 *   behindCount?: number,
 *   error?: string,
 * }>}
 */
export async function observeOriginAhead({ root, defaultBranch }) {
  const runGit = (gitArgs) => execFile('git', ['-C', root, ...gitArgs], {
    shell: false,
    encoding: 'utf8',
    timeout: 30000,
  });

  let localHead;
  try {
    ({ stdout: localHead } = await runGit(['rev-parse', 'HEAD']));
    localHead = localHead.trim();
  } catch (err) {
    return { status: 'unknown', error: `rev-parse HEAD failed: ${err.message}` };
  }

  // Distinguish "no origin remote" from a transient ls-remote failure.
  try {
    await runGit(['remote', 'get-url', 'origin']);
  } catch {
    return { status: 'no-origin', localHead };
  }

  let remoteHead;
  try {
    const { stdout } = await runGit(['ls-remote', 'origin', `refs/heads/${defaultBranch}`]);
    const firstLine = stdout.trim().split('\n').filter((line) => line.length > 0)[0];
    if (!firstLine) {
      return { status: 'remote-ref-missing', localHead, defaultBranch };
    }
    remoteHead = firstLine.split('\t')[0];
  } catch (err) {
    return { status: 'unknown', localHead, error: `ls-remote origin failed: ${err.message}` };
  }

  if (remoteHead === localHead) {
    return { status: 'in-sync', localHead, remoteHead };
  }

  // Ancestry is only computable when the remote head object exists locally
  // (no implicit fetch — this observer is read-only on the network beyond the
  // single ls-remote above). When it does not, report diverged with no counts.
  try {
    await runGit(['cat-file', '-e', `${remoteHead}^{commit}`]);
  } catch {
    return { status: 'diverged', localHead, remoteHead };
  }

  try {
    const aheadRaw = await runGit(['rev-list', '--count', `${remoteHead}..HEAD`]);
    const behindRaw = await runGit(['rev-list', '--count', `HEAD..${remoteHead}`]);
    const aheadCount = Number.parseInt(aheadRaw.stdout.trim(), 10) || 0;
    const behindCount = Number.parseInt(behindRaw.stdout.trim(), 10) || 0;
    if (aheadCount > 0 && behindCount === 0) {
      return { status: 'ahead', localHead, remoteHead, aheadCount };
    }
    if (behindCount > 0 && aheadCount === 0) {
      return { status: 'behind', localHead, remoteHead, behindCount };
    }
    return { status: 'diverged', localHead, remoteHead, aheadCount, behindCount };
  } catch (err) {
    return { status: 'diverged', localHead, remoteHead, error: err.message };
  }
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
      await verifyFrozenNpmTarballContract({
        package: npmDistribution.package,
        version,
        tarballPath: relative(root, npm.tarballPath),
        tarballSha256: npm.sha256,
        integrity: npm.integrity,
      }, root, resolveUnitScopedPath(resolve(runDir, 'tarballs'), unit.id));
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
// F-01 / T1: private execution inputs freeze gate
// ---------------------------------------------------------------------------

/**
 * Normalize one relative path for closure-style set comparison (the same
 * lexical normalization Foundation applies to closure resource paths).
 *
 * @param {string} value - Relative path candidate.
 * @returns {string} POSIX-normalized form.
 */
function normalizeRelativeClosurePath(value) {
  return pathPosix.normalize(String(value).replaceAll('\\', '/'));
}

/**
 * Enumerate the paths present in the frozen tag tree: the production asset
 * commit is the commit the distribution tag will point at, and its tree
 * lives in the detached asset repository built by buildProductionAssets.
 * Read-only local git; no network.
 *
 * @param {string} root - Release workspace root.
 * @param {object} asset - productionAssets entry (gitObjectDir + commit).
 * @returns {Promise<Set<string>>} Normalized paths contained in the tag.
 */
async function enumerateFrozenTagPaths(root, asset) {
  const gitDir = resolve(root, asset.gitObjectDir);
  let stdout;
  try {
    ({ stdout } = await execFile('git', [
      '--git-dir', gitDir,
      'ls-tree', '-r', '-z', '--name-only', asset.commit,
    ]));
  } catch (err) {
    throw new ReleaseError(
      GATE_FAILED,
      `cannot enumerate the frozen tag tree for the executionFiles gate: ${err?.message ?? err}`,
      { gitObjectDir: asset.gitObjectDir, commit: asset.commit },
    );
  }
  return new Set(`${stdout}`.split('\0').filter(Boolean).map(normalizeRelativeClosurePath));
}

/**
 * Collect the relative-path candidates from every postPublish command array
 * (materialize, steps, custom command hooks). Flag-like elements are not
 * path candidates; lexical safety is decided by Foundation classification.
 *
 * @param {object} postPublish - The unit postPublish declaration.
 * @returns {Array<{where: string, element: string}>}
 */
function collectPostPublishCommandCandidates(postPublish) {
  const candidates = [];
  const visit = (where, command) => {
    if (!Array.isArray(command)) return;
    for (const element of command) {
      if (typeof element !== 'string' || element.length === 0 || element.startsWith('-')) continue;
      candidates.push({ where, element });
    }
  };
  visit('materialize', postPublish.materialize?.command);
  for (const step of postPublish.steps ?? []) visit(`steps[${step.name}]`, step.command);
  for (const hook of postPublish.hooks ?? []) {
    if (Array.isArray(hook.command)) visit(`hooks[${hook.id}]`, hook.command);
  }
  return candidates;
}

/**
 * F-01 / T1 declaration gate (fail-closed, before any plan write):
 *
 * - a command-array element that is a safe relative path, EXISTS as a
 *   regular file in the live workspace, is ABSENT from the frozen tag tree,
 *   and is NOT declared in executionFiles is an undeclared private input —
 *   report it immediately instead of letting distribute guess or copy;
 * - an executionFiles entry that already exists in the frozen tag is
 *   rejected: tag files stay bound to tagCommit and the execution bundle
 *   must never shadow them.
 *
 * When no frozen tag exists yet (non-production prepare) the tag-dependent
 * checks are skipped — distribute fails closed later without a tagCommit.
 *
 * @param {object} postPublish - Unit postPublish declaration.
 * @param {object} params
 * @param {string} params.workspaceRoot - Release workspace root (realpath).
 * @param {Set<string>|null} params.frozenTagPaths - Frozen tag tree paths.
 * @param {string[]} params.executionFiles - Declared closed-world manifest.
 */
async function assertPrivateExecutionDeclarations(postPublish, { workspaceRoot, frozenTagPaths, executionFiles }) {
  const declared = new Set(executionFiles.map(normalizeRelativeClosurePath));
  for (const { where, element } of collectPostPublishCommandCandidates(postPublish)) {
    const classification = classifyPathInput(element);
    if (!classification.ok) continue; // absolute/UNC/backslash inputs are not workspace-relative files
    let stats = null;
    try {
      stats = await lstat(resolve(workspaceRoot, element));
    } catch {
      continue; // not present in the live workspace: nothing to declare
    }
    if (!stats.isFile()) continue;
    const normalized = normalizeRelativeClosurePath(element);
    if (frozenTagPaths && frozenTagPaths.has(normalized)) continue; // bound by tagCommit
    if (declared.has(normalized)) continue;
    throw new ReleaseError(
      GATE_FAILED,
      `postPublish ${where} command references the workspace-private file "${element}" that exists in the workspace but is absent from the frozen tag; declare it in postPublish.executionFiles (closed world — helper files included)`,
      { where, path: element },
    );
  }
  if (frozenTagPaths) {
    for (const entry of executionFiles) {
      if (frozenTagPaths.has(normalizeRelativeClosurePath(entry))) {
        throw new ReleaseError(
          GATE_FAILED,
          `postPublish.executionFiles entry "${entry}" already exists in the frozen tag; tag files stay bound to tagCommit and the execution bundle must never shadow them`,
          { path: entry },
        );
      }
    }
  }
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
          `unit "${unit.id}" ${dist.type} external marketplace form requires online production prepare to freeze the marketplace commit sha. ` +
          `Remediation: release-skill prepare --production --online`,
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
export function buildExternalActions(unitResults, resolvedVersions, productionAssets, externalFreezes = new Map(), frozenDistributions = null, publicSourceAuthorityReceipt = null) {
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
      // body for every platform. Marketplace identity follows the distribution
      // declaration: claude/codex require it via the registry schema fields;
      // kimi/codebuddy tolerate an optional declaration (codebuddy defaults to
      // its unified marketplace constant downstream when undeclared).
      // Undeclared stays absent so legacy frozen plans remain byte-identical.
      const frozenUnitDists = frozenDistributions?.get(unit.id) ?? null;
      for (const platform of PLATFORMS) {
        const dist = frozenUnitDists
          ? frozenUnitDists.find((d) => d.type === platform.distributionType)
          : (unit.distributions ?? []).find((d) => d.type === platform.distributionType);
        if (!dist) continue;
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
            ...(dist.marketplace !== undefined ? { marketplace: dist.marketplace } : {}),
            ...(dist.marketplaceSource !== undefined ? { marketplaceSource: dist.marketplaceSource } : {}),
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
            ...(dist.marketplace !== undefined ? { marketplace: dist.marketplace } : {}),
            ...(dist.marketplaceSource !== undefined ? { marketplaceSource: dist.marketplaceSource } : {}),
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
    const releaseAssets = publicSourceAuthorityReceipt?.coordinatorUnitId === unit.id
      ? [publicSourceAuthorityReceipt.asset]
      : null;
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
        ...(releaseAssets ? { releaseAssets } : {}),
      },
      expected: {
        tag: resolvedTag,
        commit: asset.commit,
        ...(releaseAssets ? { releaseAssetsDigest: digestReleaseAssetIdentities(releaseAssets) } : {}),
      },
      status: 'PENDING',
    });

    // Consumer marketplace install actions (only when distribution
    // declared), driven by the platform registry (T2.2 step 3): mirrors the
    // non-production loop above plus the production-only bindings
    // (ref/snapshotPath/manifestDigest parameters; consumer/repo/ref/
    // entrySkillFound/manifestDigest expected). Marketplace identity follows
    // the distribution declaration, same as the non-production loop.
    for (const platform of PLATFORMS) {
      const dist = frozenUnitDists
        ? frozenUnitDists.find((d) => d.type === platform.distributionType)
        : (unit.distributions ?? []).find((d) => d.type === platform.distributionType);
      if (!dist) continue;
      // Marketplace identity follows the distribution declaration: claude/codex
      // require it via the registry schema fields; kimi/codebuddy tolerate an
      // optional declaration (codebuddy defaults to its unified marketplace
      // constant downstream when undeclared). Undeclared stays absent so
      // legacy frozen plans remain byte-identical.
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
          ...(dist.marketplace !== undefined ? { marketplace: dist.marketplace } : {}),
          ...(dist.marketplaceSource !== undefined ? { marketplaceSource: dist.marketplaceSource } : {}),
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
          ...(dist.marketplace !== undefined ? { marketplace: dist.marketplace } : {}),
          ...(dist.marketplaceSource !== undefined ? { marketplaceSource: dist.marketplaceSource } : {}),
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
 * @param {Function} [options.adapterFreshnessFn] - Adapter derived-artifact
 *   pre-gate (default assertAdapterFreshness). No environment variable
 *   exempts the default gate (F-03): it runs in the CLI, plain function
 *   calls, and the node:test harness alike. Tests that need a lightweight
 *   fixture inject a double explicitly in-process; the CLI exposes no
 *   parameter for it.
 * @param {Function} [options.selfBootstrapFactsFn] - Self-bootstrap fact-pin
 *   pre-gate (default assertSelfBootstrapFacts); same injection contract as
 *   adapterFreshnessFn.
 *
 * @returns {Promise<{ planPath: string, planDigest: string, evidenceDir: string, warnings: ReadonlyArray<object>, nextSteps: ReadonlyArray<{ code: string, message: string }> }>}
 *
 * @throws {ReleaseError} on any gate failure. No PREPARED plan is written.
 */

/**
 * R-14: source-authority content closure gate, extracted from Step 3c so the
 * config workflow can run it either at Step 3c (docs) or deferred at the
 * Step 6b-pre public-byte decision (config scenario B). Behavior is byte-for-
 * byte the original Step 3c: CONFIG_MISSING when production configs declare no
 * sourceRepository, deterministic source-input closure, dirty closure inputs
 * fail closed, and the O5 origin-ahead observation stays a non-blocking
 * warning in online runs.
 *
 * @param {object} input
 * @param {string|null} input.sourceRepository - config.project.sourceRepository
 * @param {string|null} input.configDefaultBranch - config.project.defaultBranch
 * @param {Array<object>} input.configUnits - resolved unit configs
 * @param {string} input.realRoot - real project root
 * @param {boolean} input.offline - offline prepare flag
 * @param {object} input.evidence - evidence stream (append)
 * @param {Function} input.observeOriginAheadFn - injectable origin observer
 * @param {Array<object>} input.runWarnings - warning collector (pushed into)
 * @param {string} input.configPath - config file path for error attribution
 * @returns {Promise<{ sourceAuthority: object, sourceInputClosure: object }>}
 */
async function computeSourceAuthorityClosure({
  sourceRepository,
  configDefaultBranch,
  configUnits,
  realRoot,
  offline,
  evidence,
  observeOriginAheadFn,
  runWarnings,
  configPath,
}) {
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
  const sourceInputClosure = await computeSourceInputClosure({
    units: unitConfigsForClosure,
    root: realRoot,
  });

  await evidence.append({
    phase: 'source-authority',
    step: 'closure-computed',
    status: 'computed',
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
  const sourceAuthority = {
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

  // --- Step 3c-ahead: local vs origin ahead observation (O5) ---
  // Online production prepare only. WARNING level, never blocking: pushing
  // is a legitimate pre-publish action, but the operator must know before
  // approval — the publish source-authority gate compares the frozen
  // source-input closure against the remote default branch and rejects
  // unpushed local commits (0.6.1 cycle: 15 commits ahead, discovered only
  // at publish). Offline prepare keeps the legacy zero-observation form.
  if (!offline) {
    if (!configDefaultBranch) {
      await evidence.append({
        phase: 'origin-ahead',
        status: 'skipped',
        reason: 'no project.defaultBranch configured',
      });
    } else {
      await evidence.append({ phase: 'origin-ahead', status: 'started' });
      const observeOriginAheadImpl = observeOriginAheadFn ?? observeOriginAhead;
      let originObservation;
      try {
        originObservation = await observeOriginAheadImpl({
          root: realRoot,
          defaultBranch: configDefaultBranch,
        });
      } catch (err) {
        originObservation = { status: 'unknown', error: err?.message ?? String(err) };
      }
      if (originObservation?.status === 'ahead') {
        await evidence.append({
          phase: 'origin-ahead',
          status: 'warning',
          defaultBranch: configDefaultBranch,
          localHead: originObservation.localHead ?? null,
          remoteHead: originObservation.remoteHead ?? null,
          aheadCount: originObservation.aheadCount ?? null,
          guidance: 'push the workspace before publish (git push); the publish source-authority gate compares against the remote default branch',
        });
        runWarnings.push({
          code: 'ORIGIN_AHEAD',
          defaultBranch: configDefaultBranch,
          aheadCount: originObservation.aheadCount ?? null,
          message:
            `local HEAD is ${originObservation.aheadCount ?? 'an unknown number of'} commit(s) ahead of origin/${configDefaultBranch}; ` +
            'the publish source-authority gate compares against the remote default branch — push the workspace (git push) before publish',
        });
      } else if (['in-sync', 'behind', 'diverged'].includes(originObservation?.status)) {
        await evidence.append({
          phase: 'origin-ahead',
          status: 'completed',
          observation: originObservation.status,
          defaultBranch: configDefaultBranch,
          localHead: originObservation.localHead ?? null,
          remoteHead: originObservation.remoteHead ?? null,
          aheadCount: originObservation.aheadCount ?? null,
          behindCount: originObservation.behindCount ?? null,
        });
      } else {
        await evidence.append({
          phase: 'origin-ahead',
          status: 'unobserved',
          reason: originObservation?.status ?? 'unknown',
          defaultBranch: configDefaultBranch,
          error: originObservation?.error
            ? { code: 'ORIGIN_OBSERVE_FAILED', message: originObservation.error }
            : null,
        });
      }
    }
  }

  return { sourceAuthority, sourceInputClosure };
}

/**
 * R-14: snapshot-to-closure binding verification, extracted from Step 5 so
 * the config workflow can run it at the same moment as the (possibly
 * deferred) closure computation. Behavior is byte-for-byte the original
 * Step 5: snapshot sources must match the closure (SNAPSHOT_SOURCE_DRIFT),
 * the re-computed closure must equal the frozen one (SOURCE_CLOSURE_DRIFT),
 * and closure files must still be clean (DIRTY_AFTER_SNAPSHOT).
 *
 * @param {object} input
 * @param {object} input.sourceInputClosure - frozen source-input closure
 * @param {Array<object>} input.unitResults - unit snapshot results
 * @param {Array<object>} input.configUnits - resolved unit configs
 * @param {string} input.realRoot - real project root
 * @param {object} input.evidence - evidence stream (append)
 */
async function verifySnapshotClosureBinding({ sourceInputClosure, unitResults, configUnits, realRoot, evidence }) {
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

/**
 * Read the newest frozen plan from `.release-skill/plans/` (digest-addressed
 * immutable plans written by writePlanImmutable). Used by the config workflow
 * decision to compare public bytes (per-unit snapshotDigest) against the
 * latest frozen state. Returns null when no readable plan exists.
 *
 * @param {string} root - project root directory
 * @returns {Promise<{ plan: object, fileName: string } | null>}
 */
export async function readLatestFrozenPlan(root) {
  const plansDir = resolve(root, '.release-skill', 'plans');
  let files;
  try {
    files = await readdir(plansDir);
  } catch {
    return null;
  }
  let best = null;
  for (const file of files.sort()) {
    if (!file.endsWith('.json')) continue;
    let plan;
    try {
      plan = JSON.parse(await readFile(resolve(plansDir, file), 'utf8'));
    } catch {
      continue;
    }
    if (!plan || typeof plan !== 'object' || !Array.isArray(plan.units)) continue;
    const ts = plan.createdAt ? new Date(plan.createdAt).getTime() : NaN;
    const effectiveTs = Number.isFinite(ts) ? ts : 0;
    if (!best || effectiveTs > best.ts) {
      best = { plan, fileName: file, ts: effectiveTs };
    }
  }
  return best ? { plan: best.plan, fileName: best.fileName } : null;
}

/**
 * P4 (ruling 6) Phase A: resolve every plugin distribution's frozen manifest
 * facts from the local snapshot — marketplace source selection, bundled index
 * entry, and manifest bytes — BEFORE the local skill-resource closure gate
 * and any remote marketplace observation. The resolved facts are shared by
 * the closure gate (surface bindings) and the installation-contract
 * construction (Phase D), so each manifest is parsed exactly once per
 * distribution and every consumer reads the same frozen bytes.
 *
 * @param {object[]} unitResults - processSnapshots results.
 * @param {string[]} resolvedVersions - index-aligned target versions.
 * @returns {Promise<{
 *   frozenManifestByDist: Map<string, {manifest: object, manifestRelativePath: string}>,
 *   distributionFacts: Map<string, object>,
 * }>}
 */
async function resolveDistributionManifestFacts(unitResults, resolvedVersions) {
  const frozenManifestByDist = new Map();
  const distributionFacts = new Map();
  for (let idx = 0; idx < unitResults.length; idx += 1) {
    const { unit, manifest } = unitResults[idx];
    const unitVersion = resolvedVersions[idx];
    const snapshotDir = manifest.outputDir;
    for (const dist of unit.distributions ?? []) {
      const platform = PLATFORMS.find((p) => p.distributionType === dist.type);
      if (!platform || dist.type === 'npm') continue;
      const key = `${unit.id} ${dist.type}`;

      // 校验 marketplaceSourceType：从配置读取，不允许硬编码默认值
      const sourceTypeResult = validateMarketplaceSourceSelection(platform.id, dist, dist);
      if (!sourceTypeResult.valid) {
        throw new ReleaseError(
          CONFIG_INVALID,
          `unit "${unit.id}" ${dist.type} marketplace source validation failed: ${sourceTypeResult.error}`,
          { unitId: unit.id, distributionType: dist.type },
        );
      }
      let marketplaceSourceType = sourceTypeResult.selectedSource;
      if (!marketplaceSourceType) {
        marketplaceSourceType = dist.marketplaceRepo ? 'standalone-index' : 'bundled-family';
      }

      const hasDefaultMarketplace = platform.manifestPaths.marketplace !== null;
      const hasExplicitMarketplacePath = dist.marketplaceIndexPath != null;
      const isBundledFamily = marketplaceSourceType === 'bundled-family';
      const isStandaloneIndex = marketplaceSourceType === 'standalone-index';

      // Bundled index entry resolution is a local snapshot read; the
      // standalone-index entry is remote-frozen and resolved in Phase C/D.
      let includeMarketplaceEntryBundled = false;
      let marketplaceIndexRelative = null;
      let bundledMarketIndex = null;
      let selectedMarketplaceEntryBundled = null;
      if (isBundledFamily) {
        includeMarketplaceEntryBundled = hasDefaultMarketplace || hasExplicitMarketplacePath;
        if (includeMarketplaceEntryBundled) {
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
          selectedMarketplaceEntryBundled = matchingEntries[0];
          bundledMarketIndex = marketplaceIndex;
        }
      }

      // Read the plugin manifest from the real snapshot.
      let pluginManifestRelative;
      let pluginManifestParsed;
      if (isBundledFamily && bundledMarketIndex && platform.marketplaceSourceForm !== null) {
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
        const readResult = await platform.strategy.readManifest(snapshotDir);
        pluginManifestParsed = readResult.manifest;
        pluginManifestRelative = readResult.manifestRelative ?? platform.manifestPaths.plugin;
      } else {
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

      frozenManifestByDist.set(key, {
        manifest: pluginManifestParsed,
        manifestRelativePath: pluginManifestRelative,
      });

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

      distributionFacts.set(key, {
        kind: 'plugin',
        platform,
        marketplaceSourceType,
        isBundledFamily,
        isStandaloneIndex,
        includeMarketplaceEntryBundled,
        marketplaceIndexRelative,
        bundledMarketIndex,
        selectedMarketplaceEntryBundled,
        pluginManifestRelative,
        pluginManifestParsed,
      });
    }
  }
  return { frozenManifestByDist, distributionFacts };
}

/**
 * P4 (ruling 6) Phase B: the built-in local skill-resource closure gate.
 * Runs on the sealed/final staging snapshots with the surface host bindings
 * derived from the shared frozen manifest facts (R-13). It must complete
 * BEFORE any remote marketplace observation (Phase C).
 *
 * @param {object} input
 * @param {object[]} input.unitResults - processSnapshots results.
 * @param {Map<string, {manifest: object, manifestRelativePath: string}>}
 *   input.frozenManifestByDist - frozen manifest facts from Phase A.
 * @param {string|null} input.freezeTimestamp - deterministic freeze timestamp.
 * @param {object} input.evidence - evidence writer.
 * @param {boolean} input.skipSkillResourceClosure - workflow trim flag.
 * @param {string} input.workflow - prepare workflow kind (skip evidence).
 * @returns {Promise<object[]>} the frozen unit receipts.
 */
async function runPrepareSkillResourceClosureGate({
  unitResults,
  frozenManifestByDist,
  freezeTimestamp,
  evidence,
  skipSkillResourceClosure,
  workflow,
}) {
  const skillResourceClosureResults = [];
  if (skipSkillResourceClosure) {
    await evidence.append({
      phase: 'skill-resource-closure',
      status: 'skipped',
      reason: `workflow "${workflow}" trims the skill resource closure gate`,
      unitCount: unitResults.length,
    });
    return skillResourceClosureResults;
  }
  for (const { unit, manifest } of unitResults) {
    await evidence.append({
      phase: 'skill-resource-closure',
      status: 'started',
      unitId: unit.id,
    });

    // R-13: 从冻结安装事实推导每个 distribution 的宿主表面绑定
    // （manifest skills 路径锚定在 manifest 插件根，宿主经 Foundation
    // 规范化）——checker 用它标记表面宿主，保证与安装契约一致。
    // 无 skills 字段的 manifest 不产生绑定，checker 推断路径保持权威。
    // P1: 声明 skills 目录必须真实存在于冻结快照（derive 内校验）。
    const surfaceHostBindings = [];
    for (const distribution of unit.distributions ?? []) {
      const platform = PLATFORMS.find(
        (p) => p.distributionType === distribution.type,
      );
      if (!platform) continue;
      const frozenManifest = frozenManifestByDist.get(
        `${unit.id} ${distribution.type}`,
      );
      if (!frozenManifest) continue;
      const pluginRoot = pluginRootFromManifestRelativePath(
        frozenManifest.manifestRelativePath,
      );
      const binding = await deriveSurfaceHostBinding({
        manifest: frozenManifest.manifest,
        pluginRoot,
        platform,
        snapshotDir: manifest.outputDir,
      });
      if (binding) surfaceHostBindings.push(binding);
    }

    const closureResult = await checkSkillResourceClosure({
      snapshotDir: manifest.outputDir,
      host: 'root',
      surfaceHostBindings,
    });

    // G5: bind execution time + exit code into the frozen receipt.
    // preparedAt reuses this prepare's deterministic freeze timestamp
    // (production: the baseline HEAD commit committer date; otherwise
    // null) — never a wall-clock sample — so identical sources freeze
    // byte-identical receipts on every re-prepare.
    const receipt = createSkillResourceClosureReceipt(closureResult, {
      unitId: unit.id,
      preparedAt: freezeTimestamp ?? null,
      exitCode: 0,
    });
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
          // D4: RESOURCE_DRIFT findings localize via references (the
          // finding's own skill/line stay null for a cross-surface drift).
          ...(f.references ? { references: f.references } : {}),
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

    // G4: every declared plugin distribution must be backed by a host
    // surface in the frozen snapshot with at least one skill. If
    // publicFiles drops an adapter tree, that host surface is silently
    // absent from the receipt — fail closed here instead of shipping a
    // unit whose declared host never entered the closure gate.
    const expectedHosts = [];
    for (const distribution of unit.distributions ?? []) {
      const platform = PLATFORMS.find(
        (p) => p.distributionType === distribution.type,
      );
      if (!platform) continue;
      expectedHosts.push(await normalizeHostId(platform.buildAdapter.name));
    }
    const hostCoverage = evaluateDeclaredHostSurfaceCoverage(
      expectedHosts,
      closureResult.surfaces,
    );
    if (!hostCoverage.passed) {
      await evidence.append({
        phase: 'skill-resource-closure',
        status: 'blocking',
        unitId: unit.id,
        reason: 'declared-host-surface-missing',
        missingHosts: hostCoverage.missing,
      });
      throw new ReleaseError(
        GATE_FAILED,
        `skill resource closure gate failed for unit "${unit.id}": declared host surface(s) missing or empty: ${hostCoverage.missing.map((item) => item.host).join(', ')}`,
        {
          unitId: unit.id,
          missingHosts: hostCoverage.missing,
          observedSurfaces: closureResult.surfaces.map((surface) => ({
            id: surface.id,
            host: surface.host,
            skillCount: surface.skillCount,
          })),
        },
      );
    }

    // R-13: manifest 声明的 skills 表面必须真实存在于冻结快照且至少
    // 含一个技能（binding-surface existence）。G4 按宿主名覆盖，这里按
    // 绑定表面路径覆盖 —— 例如 manifest 指向 './adapters/claude/skills/'
    // 但 publicFiles 丢弃该目录时，绑定表面缺失必须失败关闭。
    for (const binding of surfaceHostBindings) {
      const boundSurface = closureResult.surfaces.find(
        (surface) => surface.id === binding.surfaceId,
      );
      if (!boundSurface || boundSurface.skillCount < 1) {
        await evidence.append({
          phase: 'skill-resource-closure',
          status: 'blocking',
          unitId: unit.id,
          reason: 'declared-host-surface-missing',
          missingHosts: [{ host: binding.host, surfaceId: binding.surfaceId }],
        });
        throw new ReleaseError(
          GATE_FAILED,
          `skill resource closure gate failed for unit "${unit.id}": declared host surface(s) missing or empty: ${binding.host} (${binding.surfaceId})`,
          {
            unitId: unit.id,
            missingHosts: [{ host: binding.host, surfaceId: binding.surfaceId }],
            observedSurfaces: closureResult.surfaces.map((surface) => ({
              id: surface.id,
              host: surface.host,
              skillCount: surface.skillCount,
            })),
          },
        );
      }
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
      // D2: per-reference exemption detail for approval/audit review —
      // evidence-layer only; the receipt object (and its digest binding)
      // is intentionally left unchanged.
      sourceOnlyReferences: closureResult.sourceOnlyReferences,
      findingCount: 0,
      receiptDigest: closureResult.receiptDigest,
    });
  }
  return skillResourceClosureResults;
}

/**
 * R93-01: optionally inspect the public surface before the first declared
 * hook. The staging and closure checks are deliberately ephemeral: their
 * result is an execution gate, not a plan/approval/publish receipt. The
 * normal post-hook snapshot and closure gate remains authoritative.
 */
async function runPreHookPublicSurfaceGate({
  config,
  root,
  resolvedVersions,
  evidence,
  skipDeclaredHooks,
  workflow,
}) {
  if (config.policy?.preHookPublicSurfaceCheck !== true) return;

  const declaredHookCount = Object.values(config.hooks ?? {})
    .filter((hook) => hook && hook.command).length;
  if (skipDeclaredHooks || declaredHookCount === 0) {
    await evidence.append({
      phase: 'pre-hook-public-surface',
      status: 'skipped',
      reason: skipDeclaredHooks
        ? `workflow "${workflow}" trims code-class hooks`
        : 'no declared hooks',
    });
    return;
  }

  await evidence.append({ phase: 'pre-hook-public-surface', status: 'started' });
  let currentUnitId = null;
  let unitCount = 0;
  try {
    await withTemporaryWorkspace(async (workspace) => {
      const stagingRoot = workspace.root;
      const unitResults = [];
      for (const unit of config.releaseUnits ?? []) {
        currentUnitId = unit.id;
        const outputDir = resolveUnitScopedPath(stagingRoot, unit.id);
        const publicManifest = await buildPublicStaging({
          sourceRoot: root,
          unit,
          outputDir,
        });
        unitResults.push({
          unit,
          manifest: {
            entries: publicManifest.entries,
            files: publicManifest.entries.map((entry) => entry.path).sort(),
            totalSize: publicManifest.totalSize,
            fileCount: publicManifest.fileCount,
            contentHash: publicManifest.contentHash,
            snapshotDigest: publicManifest.contentHash,
            source: unit.source,
            outputDir: publicManifest.outputDir,
          },
        });
      }

      const { frozenManifestByDist } = await resolveDistributionManifestFacts(
        unitResults,
        resolvedVersions,
      );
      unitCount = unitResults.length;
      // Reuse the production closure/host-surface implementation, but do not
      // append its ordinary phase events or retain its receipt in the plan.
      await runPrepareSkillResourceClosureGate({
        unitResults,
        frozenManifestByDist,
        freezeTimestamp: null,
        evidence: { append: async () => undefined },
        skipSkillResourceClosure: false,
        workflow: 'pre-hook-public-surface',
      });
    });
    await evidence.append({
      phase: 'pre-hook-public-surface',
      status: 'passed',
      unitCount,
    });
  } catch (error) {
    const details = {
      ...(error instanceof ReleaseError ? error.details : {}),
      phase: 'pre-hook-public-surface',
      unitId: error?.details?.unitId ?? currentUnitId,
    };
    if (Array.isArray(details.findings)) {
      details.findings = details.findings.slice(0, 50);
    }
    await evidence.append({
      phase: 'pre-hook-public-surface',
      status: 'failed',
      error: { code: error.code ?? GATE_FAILED, message: error.message },
    });
    if (error instanceof ReleaseError) {
      throw new ReleaseError(
        error.code,
        `pre-hook public surface check failed before hooks: ${error.message}`,
        details,
        error.exitCode,
      );
    }
    throw new ReleaseError(
      GATE_FAILED,
      `pre-hook public surface check failed before hooks: ${error.message}`,
      details,
    );
  } finally {
    // withTemporaryWorkspace disposes the Foundation-managed staging root on
    // both success and failure; no project run artifact is retained.
  }
}

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
    workflow = 'full',
    observePreviousPublicBaselineFn,
    testSelection = 'full',
  } = options ?? {};

  // --- Workflow profile (H5) ---
  // 'full' runs the complete gate set. 'docs', 'config' and 'marketplace'
  // trim only code-class gates — declared hooks, snapshot-verify gates,
  // source-authority closure, and skill-resource-closure — and record the
  // trim as `workflowDecision` bound into the plan digest. All other gates
  // (docs freshness, public surface, baseline, snapshots, remote checks,
  // plan freeze, consumer-verify gates) run identically for every workflow.
  const WORKFLOW_KINDS = new Set(['full', 'docs', 'config', 'marketplace']);
  if (!WORKFLOW_KINDS.has(workflow)) {
    throw new ReleaseError(
      CONFIG_INVALID,
      `unknown workflow kind "${workflow}"; expected one of ${[...WORKFLOW_KINDS].sort().join(', ')}`,
      { workflow },
    );
  }

  // --- Test selection (2026-08-18 investigation §4.4, review §3.4) ---
  // Design decision: prepare IS the freeze, so incremental test selection is
  // rejected outright; the flag is reserved for a future preflight mode.
  if (testSelection === 'incremental') {
    throw new ReleaseError(
      GATE_FAILED,
      'incremental selection is not allowed at freeze time',
      { testSelection, reservedFor: 'preflight mode' },
    );
  }
  if (testSelection !== 'full') {
    throw new ReleaseError(
      CONFIG_INVALID,
      `unknown testSelection "${testSelection}"; expected "full" or "incremental"`,
      { testSelection },
    );
  }
  const trimmedWorkflow = workflow !== 'full';
  const skipDeclaredHooks = trimmedWorkflow;
  const skipSnapshotVerifyGates = trimmedWorkflow;
  // R-14: docs keeps the release-skill publish path, so its source-authority
  // closure gate is never trimmed; config defers the gate to the public-byte
  // comparison decision and only runs it when publish is needed. Marketplace
  // keeps the delegated-publish model unchanged (gate stays trimmed).
  const skipSourceAuthorityClosure = trimmedWorkflow && workflow !== 'docs';
  const deferSourceAuthorityClosure = trimmedWorkflow && production && workflow === 'config';
  const skipSkillResourceClosure = trimmedWorkflow;

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
    const adoptionWarnings = collectExpectedPublicSurfaceAdoptionWarnings(config);
    // Mutable operator-facing warning list: seeded from the adoption warnings,
    // appended by later gates (O5 origin-ahead). Returned as `warnings`.
    const runWarnings = [...adoptionWarnings];

    await evidence.append({
      phase: 'config',
      status: 'completed',
      configPath: relative(realRoot, configPath),
      configDigest,
    });
    for (const warning of adoptionWarnings) {
      await evidence.append({
        phase: 'public-surface-adoption',
        status: 'warning',
        ...warning,
      });
    }

    // --- Step 1-fresh: Bundle freshness gate (BUNDLE_STALE, fail-closed) ---
    // 2026-08-18 investigation §4.2: a stale bin/release-skill.bundle.mjs
    // used to surface only deep inside test hooks. Compare the deterministic
    // source digest embedded in the bundle at build time with the current
    // sources at the earliest stage — config loaded, before any hook.
    // This gate is artifact-integrity class, NOT a code-class gate:
    // docs/config/marketplace workflow trimming must never exempt it.
    await evidence.append({ phase: 'bundle-freshness', status: 'started' });
    const bundleFreshnessFn = options.bundleFreshnessFn ?? assertBundleFreshness;
    let bundleFreshness;
    try {
      bundleFreshness = await bundleFreshnessFn(PKG_ROOT);
    } catch (err) {
      await evidence.append({
        phase: 'bundle-freshness',
        status: 'blocking',
        reason: err.details?.reason ?? null,
        error: { code: err.code, message: err.message },
      });
      throw err;
    }
    if (bundleFreshness?.applicable === false) {
      // Installed distributions ship no mutable src/ next to the bundle;
      // staleness is a source-checkout concern only.
      await evidence.append({
        phase: 'bundle-freshness',
        status: 'not-applicable',
        reason: bundleFreshness.reason,
      });
    } else {
      await evidence.append({
        phase: 'bundle-freshness',
        status: 'completed',
        algorithm: bundleFreshness?.algorithm ?? null,
        sourceDigest: bundleFreshness?.sourceDigest ?? null,
      });
    }

    // --- Step 1a: Workflow configuration evidence ---
    // Records the deterministic trim set for docs/config/marketplace
    // workflows. The trim never weakens the retained gates; it only removes
    // code-class gates that a non-code change surface cannot exercise.
    await evidence.append({
      phase: 'workflow',
      status: 'configured',
      workflowKind: workflow,
      // R-14: the trim set is scenario-truthful — docs production keeps the
      // source-authority closure (its publish path stays release-skill
      // executed); config records the declared trim here and Step 6b records
      // the final truth after the public-byte comparison.
      trimmedGates: trimmedWorkflow
        ? ['declared-hooks', 'snapshot-verify-gates', 'skill-resource-closure']
            .concat(production && !skipSourceAuthorityClosure ? [] : ['source-authority-closure'])
        : [],
      retainedGates: [
        'docs-freshness',
        'public-surface',
        'baseline',
        'snapshots',
        'remote-check',
        'plan-freeze',
        'consumer-verify',
      ],
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

    // --- Step 1b-fast: version-sensitive derived-artifact fast pre-gates (O1) ---
    // 2026-08-18 investigation §3.2: adapter drift and stale self-bootstrap
    // fact pins used to surface only deep inside the ~80s full test hook.
    // Promote the three exact canonical checks (build-adapters --check,
    // generate-platform-manifest --check, and the release-docs-self-bootstrap
    // single-file test) to prepare's earliest
    // stage so the same drift fails closed in seconds, before any hook. Like
    // the bundle freshness gate this is artifact-integrity class: workflow
    // trimming never exempts it. Installed layouts record not-applicable.
    // F-03 (2026-08-21 architecture review): the gates run identically in
    // the CLI, plain function calls, and the node:test harness — no
    // environment variable may exempt them (a test seam is never a
    // production switch). Tests that need lightweight fixtures inject the
    // adapterFreshnessFn/platformManifestFreshnessFn/selfBootstrapFactsFn
    // seams explicitly in-process.
    await evidence.append({ phase: 'adapter-freshness', status: 'started' });
    const adapterFreshnessFn = options.adapterFreshnessFn ?? assertAdapterFreshness;
    let adapterFreshness;
    try {
      adapterFreshness = await adapterFreshnessFn(PKG_ROOT);
    } catch (err) {
      await evidence.append({
        phase: 'adapter-freshness',
        status: 'blocking',
        reason: err.details?.reason ?? null,
        error: { code: err.code, message: err.message },
      });
      throw err;
    }
    if (adapterFreshness?.applicable === false) {
      await evidence.append({
        phase: 'adapter-freshness',
        status: 'not-applicable',
        reason: adapterFreshness.reason,
      });
    } else {
      await evidence.append({
        phase: 'adapter-freshness',
        status: 'completed',
        durationMs: adapterFreshness?.durationMs ?? null,
      });
    }

    await evidence.append({ phase: 'platform-manifest-freshness', status: 'started' });
    const platformManifestFreshnessFn = options.platformManifestFreshnessFn
      ?? assertPlatformManifestFreshness;
    let platformManifestFreshness;
    try {
      platformManifestFreshness = await platformManifestFreshnessFn(PKG_ROOT);
    } catch (err) {
      await evidence.append({
        phase: 'platform-manifest-freshness',
        status: 'blocking',
        reason: err.details?.reason ?? null,
        error: { code: err.code, message: err.message },
      });
      throw err;
    }
    if (platformManifestFreshness?.applicable === false) {
      await evidence.append({
        phase: 'platform-manifest-freshness',
        status: 'not-applicable',
        reason: platformManifestFreshness.reason,
      });
    } else {
      await evidence.append({
        phase: 'platform-manifest-freshness',
        status: 'completed',
        durationMs: platformManifestFreshness?.durationMs ?? null,
      });
    }

    await evidence.append({ phase: 'self-bootstrap-facts', status: 'started' });
    const selfBootstrapFactsFn = options.selfBootstrapFactsFn ?? assertSelfBootstrapFacts;
    let selfBootstrapFacts;
    try {
      selfBootstrapFacts = await selfBootstrapFactsFn(PKG_ROOT);
    } catch (err) {
      await evidence.append({
        phase: 'self-bootstrap-facts',
        status: 'blocking',
        reason: err.details?.reason ?? null,
        error: { code: err.code, message: err.message },
      });
      throw err;
    }
    if (selfBootstrapFacts?.applicable === false) {
      await evidence.append({
        phase: 'self-bootstrap-facts',
        status: 'not-applicable',
        reason: selfBootstrapFacts.reason,
      });
    } else {
      await evidence.append({
        phase: 'self-bootstrap-facts',
        status: 'completed',
        durationMs: selfBootstrapFacts?.durationMs ?? null,
      });
    }

    // --- Step 1c: postPublish distribution declaration gate (R1/R2) ---
    // The per-unit postPublish block drives the post-publish distribute
    // command. Validate every declaration here, before any hook, baseline,
    // snapshot, remote check, or plan write, so an unsafe declaration fails
    // closed with zero side effects. This is the runtime re-check on top of
    // the config JSON schema: plans frozen by older schema versions must not
    // be able to smuggle shell strings, option-like executables, or
    // secret-ish env keys through. R2: preset references resolve against the
    // built-in preset registry (per-preset config validation +
    // requiresApproval grading), and targets normalize onto preset hooks —
    // the normalized table is a deterministic projection of the digest-bound
    // declaration, so any list change changes the plan digest and voids
    // approvals. Multiple units may each declare postPublish (multi-release-
    // unit v3): every declaration is validated individually, in plan.units
    // order, and the whole project's EXPLICIT hooks[].id must be unique
    // across units (target and internal probe local ids may repeat; the
    // (planDigest, hookId) approval contract needs globally unique hook ids).
    const postPublishDeclarations = configUnits
      .map((unit, index) => ({ unit, index }))
      .filter(({ unit }) => unit.postPublish !== undefined);
    for (const { unit } of postPublishDeclarations) {
      validatePostPublishDeclaration(unit.postPublish, { unitId: unit.id });
      // Normalized hook table (design §2.2): validate the dependency
      // topology at freeze time too, so a cyclic/dangling declaration can
      // never be frozen for distribute to trip over.
      const normalizedDeclaration = normalizePostPublishDeclaration(unit.postPublish);
      const orderedNormalizedHooks = orderNormalizedHooks(normalizedDeclaration.hooks);
      await evidence.append({
        phase: 'postpublish-declaration',
        status: 'validated',
        unitId: unit.id,
        targetCount: (unit.postPublish.targets ?? []).length,
        hookCount: (unit.postPublish.hooks ?? []).length,
        normalizedHookCount: orderedNormalizedHooks.length,
        preGates: normalizedDeclaration.preGates.map((gate) => gate.gate),
      });
    }
    // Whole-project explicit hooks[].id uniqueness (design §9.2 rule 3;
    // rework R-02): the (planDigest, hookId) approval contract binds every
    // explicit hook id plan-wide, so a duplicate across units must fail
    // before any plan write and before any project hook runs. The single
    // array-level authority lives in core/postpublish.mjs
    // validatePostPublishHookIdUniqueness — this entry only normalizes its
    // input to the declaration array view (config blocks carry no unitId;
    // the owning unit id is bound here, exactly as the frozen plan does) and
    // calls it. Per-declaration duplicates are already rejected by
    // validatePostPublishDeclaration.
    validatePostPublishHookIdUniqueness(
      postPublishDeclarations.map(({ unit }) => ({ ...unit.postPublish, unitId: unit.id })),
    );

    // --- Step 2: Hook authorization gate ---
    // Hooks are user-configured arbitrary local processes without filesystem
    // or network isolation. They may write outside the project, access local
    // credentials, or make network calls. The user must explicitly accept
    // these risks before any hook is executed.
    // docs/config/marketplace workflows trim code-class hooks entirely
    // (H5): a non-code change surface cannot exercise them, so they are
    // recorded as skipped rather than authorized-and-run.
    const declaredHooks = Object.entries(config.hooks ?? {})
      .filter(([, hook]) => hook && hook.command)
      .map(([name, hook]) => ({
        name,
        executable: hook.command[0],
        args: hook.command.slice(1),
        cwd: hook.cwd ?? '.',
      }));

    // Hook and gate authorization: the command invocation itself authorizes
    // execution of configured commands. Old acknowledgement parameters
    // (--acknowledge-hook-side-effects, --acknowledge-gate-side-effects) are
    // accepted as no-effect compatibility inputs but are not required.
    if (!skipDeclaredHooks && declaredHooks.length > 0) {
      await evidence.append({
        phase: 'hook-authorization',
        status: 'authorized',
        hookCount: declaredHooks.length,
        hooks: declaredHooks.map((h) => `${h.name}: ${h.executable} ${h.args.join(' ')}`),
      });
    }

    const declaredVerificationGates = config.verificationGates ?? [];
    if (declaredVerificationGates.length > 0) {
      await evidence.append({
        phase: 'verification-gate-authorization',
        status: 'authorized',
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
    }

    // --- Step 2b: Production pure-config gate (R-03, WP-5) ---
    // Runs BEFORE the first declared hook: hooks are arbitrary local
    // processes that may take tens of minutes, and a config-consistency
    // defect must fail closed before any of them executes. Only checks that
    // depend on NO build artifact, NO snapshot, NO remote observation and NO
    // public-file scan are allowed in this window: sourceRepository presence
    // and format, branchStrategy requirements, and previousPublicBaseline
    // repo/host consistency. Artifact-dependent gates (public-surface
    // scanning, source-input closure, dirty inputs, snapshots, leak scans,
    // remote baseline observation) stay AFTER hooks.
    if (production) {
      await evidence.append({ phase: 'production-config', status: 'started' });
      const sourceRepository = config.project?.sourceRepository ?? null;
      // T10 (ruling 21): collect EVERY independent pure-config defect in this
      // window and report them together — field, unit, and remediation hint —
      // in ONE pre-hook failure. No aggregation framework and no second
      // preflight: the same rule functions run, they just append to a shared
      // defect list instead of throwing one at a time.
      const pureConfigDefects = [];
      if (!sourceRepository || typeof sourceRepository !== 'string') {
        pureConfigDefects.push({
          code: CONFIG_MISSING,
          unitId: null,
          field: 'project.sourceRepository',
          message: 'production prepare requires project.sourceRepository in configuration; source authority content gate needs a workspace source repository',
          remediation: 'add project.sourceRepository (<owner>/<repo>) to .release-skill/project.yaml',
        });
      } else if (!REPOSITORY_RE.test(sourceRepository)) {
        pureConfigDefects.push({
          code: CONFIG_INVALID,
          unitId: null,
          field: 'project.sourceRepository',
          message: `project.sourceRepository "${sourceRepository}" is not a valid GitHub owner/repo`,
          remediation: 'set project.sourceRepository to a valid GitHub owner/repo (owner/repository)',
        });
      }
      for (let unitIndex = 0; unitIndex < configUnits.length; unitIndex += 1) {
        collectProductionUnitPureConfigDefects(
          configUnits[unitIndex],
          resolvedVersions[unitIndex],
          {
            production,
            offline,
            githubHost: configUnits[unitIndex].production?.githubHost ?? 'github.com',
          },
          pureConfigDefects,
        );
      }
      if (pureConfigDefects.length > 0) {
        // Keep the existing single-defect codes (CONFIG_MISSING /
        // CONFIG_INVALID / GATE_FAILED); with several defects the most
        // severe class wins so existing recovery-code semantics stay intact.
        const CODE_RANK = { CONFIG_MISSING: 0, CONFIG_INVALID: 1, GATE_FAILED: 2 };
        const code = [...pureConfigDefects]
          .sort((a, b) => (CODE_RANK[a.code] ?? 3) - (CODE_RANK[b.code] ?? 3))[0].code;
        const configErrors = pureConfigDefects.map((defect) => ({
          unitId: defect.unitId,
          field: defect.field,
          message: defect.message,
          remediation: defect.remediation,
        }));
        const pureConfigError = new ReleaseError(
          code,
          `production pure-config gate failed with ${pureConfigDefects.length} independent defect(s):\n`
            + configErrors.map((entry) => (
              `- ${entry.unitId ? `unit "${entry.unitId}" ` : ''}${entry.field}: ${entry.message} (remediation: ${entry.remediation})`
            )).join('\n'),
          { configPath, configErrors },
        );
        await evidence.append({
          phase: 'production-config',
          status: 'failed',
          gate: 'pure-config',
          error: asError(pureConfigError.code ?? GATE_FAILED, pureConfigError.message),
        });
        throw pureConfigError;
      }
      await evidence.append({
        phase: 'production-config',
        status: 'passed',
        unitCount: configUnits.length,
      });
    }

    // R93-01: optional ephemeral public-surface check immediately before the
    // first hook. Its staging and closure receipt never enter the plan.
    await runPreHookPublicSurfaceGate({
      config,
      root: realRoot,
      resolvedVersions,
      evidence,
      skipDeclaredHooks,
      workflow,
    });

    // --- Step 3: Run declared hooks ---
    let hookRecords = [];
    if (skipDeclaredHooks) {
      await evidence.append({
        phase: 'hooks',
        status: 'skipped',
        reason: `workflow "${workflow}" trims code-class hooks; declared hooks: ${declaredHooks.length}`,
      });
    } else {
      await evidence.append({ phase: 'hooks', status: 'started' });
      hookRecords = await runDeclaredHooks(config, realRoot, evidence, options.runHookFn ?? runHook, {
        hookCache: options.hookCache,
        // Explicit env delivery (0.5.1 hook-env-delivery fix): the hook runner
        // reads envAllowlist keys exclusively from context.env, so the invoking
        // shell's environment is injected here explicitly. Allowlist semantics
        // are unchanged — only allowlisted keys from this map reach the child.
        env: options.env ?? process.env,
      });
      await evidence.append({ phase: 'hooks', status: 'completed' });
    }

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

    // --- Step 3b.1: Validate the post-build expected public surface ---
    // This gate runs after every declared hook (and the post-hook docs check)
    // but before source-authority closure, baseline, snapshots, remote reads,
    // and plan write. Therefore build-generated files must be explicitly
    // classified and every included source must already exist in publicFiles
    // before downstream authorities bind the release inputs.
    for (const unit of configUnits) {
      if (!unit?.expectedPublicSurface) continue;
      await evidence.append({
        phase: 'public-surface',
        status: 'started',
        unitId: unit.id,
      });
      try {
        const surface = await assertExpectedPublicSurface({
          root: realRoot,
          unit,
        });
        await evidence.append({
          phase: 'public-surface',
          status: 'completed',
          unitId: unit.id,
          ...surface.summary,
        });
      } catch (error) {
        await evidence.append({
          phase: 'public-surface',
          status: 'failed',
          unitId: unit.id,
          reason: error.details?.reason ?? 'PUBLIC_SURFACE_CHECK_FAILED',
          error: {
            code: error.code,
            message: error.message,
          },
          diagnostics: {
            missingMappings: error.details?.missingMappings ?? [],
            unexpectedMappings: error.details?.unexpectedMappings ?? [],
            unclassifiedFiles: error.details?.unclassifiedFiles ?? [],
            ambiguousFiles: error.details?.ambiguousFiles ?? [],
          },
        });
        throw error;
      }
    }

    // --- Step 3c: Source authority content closure gate ---
    // After hooks complete, compute the deterministic source-input closure
    // and verify that closure inputs are clean (no staged/unstaged/untracked
    // changes). Production configs must declare sourceRepository.
    const sourceRepository = config.project?.sourceRepository ?? null;
    const configDefaultBranch = config.project?.defaultBranch ?? null;

    let sourceAuthority = null;
    let sourceInputClosure = null;
    if (production && !skipSourceAuthorityClosure) {
      // docs production and full run the gate here, before snapshots.
      ({ sourceAuthority, sourceInputClosure } = await computeSourceAuthorityClosure({
        sourceRepository,
        configDefaultBranch,
        configUnits,
        realRoot,
        offline,
        evidence,
        observeOriginAheadFn: options.observeOriginAheadFn,
        runWarnings,
        configPath,
      }));
    } else if (production && deferSourceAuthorityClosure) {
      // config: the gate is deferred until the public-byte comparison
      // decision (Step 6b); publish-needed runs it before the plan is built.
      await evidence.append({
        phase: 'source-authority',
        status: 'deferred',
        reason: 'config workflow defers the source-authority closure to the public-byte comparison decision',
      });
    } else if (production) {
      await evidence.append({
        phase: 'source-authority',
        status: 'skipped',
        reason: `workflow "${workflow}" trims the source-authority content closure gate`,
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
    // CHAIN_GAP detection (0.5.1 chain hardening): when a unit declares
    // previousPublicBaseline.mode=none (first-release semantics) but the
    // public repository already carries release tags for the unit's
    // tagTemplate, a subsequent release pretending to be the first would
    // freeze a plan whose push-snapshot creates a new orphan root commit.
    // Detection is online-only: `git ls-remote` on the tag pattern
    // (tagTemplate with {version} → *). Any match proves a prior release.
    const defaultPriorReleaseTagDetector = async (repo, tagPattern, { githubHost = 'github.com' } = {}) => {
      try {
        const { stdout } = await execFile(
          'git',
          ['ls-remote', `https://${githubHost}/${repo}.git`, `refs/tags/${tagPattern}`],
          { shell: false, encoding: 'utf8', timeout: 30000 },
        );
        return { found: stdout.trim().length > 0 };
      } catch (err) {
        // Network/auth failure: unknown, not "no prior release". The caller
        // records a warning and continues (consistent with the bound-baseline
        // observer's unknown status); it never silently proves first release.
        return { error: err.message };
      }
    };
    const detectPriorReleaseTags = options.detectPriorReleaseTagsFn ?? defaultPriorReleaseTagDetector;
    const unitBaselineResults = new Map();
    for (let unitIndex = 0; unitIndex < configUnits.length; unitIndex += 1) {
      const unit = configUnits[unitIndex];
      const ppbConfig = unit.previousPublicBaseline;
      if (!ppbConfig) continue;
      const productionGithubHost = unit.production?.githubHost ?? 'github.com';
      // R-03: same pure-config assertions the Step 2b pre-hook gate runs;
      // re-validated here (after hooks) so hook-side config mutation can
      // never smuggle a defect past the frozen plan.
      assertProductionUnitPureConfig(unit, resolvedVersions[unitIndex], {
        production,
        offline,
        githubHost: productionGithubHost,
      });

      if (ppbConfig.mode === "none") {
        // Chain-integrity gate (0.5.1, CHAIN_GAP): a production online
        // prepare must not freeze a first-release plan for a repository that
        // has already published. This is the orphan-root channel that caused
        // the synthetic 2000-01-01 root commits in the historical public
        // repositories: first releases used mode=none, push-snapshot degraded
        // to create-release-branch with no parent, and every later release
        // started a fresh lineage. Fail closed and demand a bound baseline
        // pointing at the previous release commit instead.
        if (production && !offline) {
          const tagTemplate = unit.version?.tagTemplate;
          const tagPattern = tagTemplate ? tagTemplate.replace('{version}', '*') : null;
          if (tagPattern) {
            const detection = await detectPriorReleaseTags(unit.publicRepo, tagPattern, {
              githubHost: productionGithubHost,
            });
            if (detection.found) {
              await evidence.append({
                phase: "previous-public-baseline",
                unitId: unit.id,
                status: "blocking",
                reason: "CHAIN_GAP",
                repo: unit.publicRepo,
                tagPattern,
                guidance: "非首次发布：必须把 previousPublicBaseline 绑定到上一发布提交（mode=bound），不能以 mode=none 制造新的孤儿根提交",
              });
              throw new ReleaseError(
                GATE_FAILED,
                `unit "${unit.id}" previousPublicBaseline.mode=none but the public repository already has release tags matching "${tagPattern}" (CHAIN_GAP): bind the previous public release commit as a bound baseline`,
                { unitId: unit.id, reason: 'CHAIN_GAP', repo: unit.publicRepo, tagPattern },
              );
            }
            if (detection.error) {
              await evidence.append({
                phase: "previous-public-baseline",
                unitId: unit.id,
                status: "warning",
                reason: "CHAIN_GAP_DETECTION_FAILED",
                repo: unit.publicRepo,
                tagPattern,
                error: { code: 'CHAIN_GAP_DETECTION_FAILED', message: detection.error },
              });
            }
          }
        }
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
            `Must use --online to observe the previous public baseline before freezing a production plan. ` +
            `Remediation: release-skill prepare --production --online`,
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

      // T09 (ruling 21): same default-only fill as the pre-hook window — an
      // explicit baseline githubHost is preserved so a conflict stays visible.
      const effectivePpbConfig = ppbConfig.mode === 'bound'
        ? { ...ppbConfig, githubHost: ppbConfig.githubHost ?? productionGithubHost }
        : ppbConfig;
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

      // R-03: re-derive the branch strategy from pure config (same source as
      // the pre-hook gate and assertProductionUnitPureConfig above) so the
      // initialize-default-branch freeze-time check cannot read an
      // out-of-scope variable.
      const { branchStrategy } = resolveProductionBranch(
        unit,
        resolvedVersions[unitIndex],
      );
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
          ...(observedDefault.error
            ? { error: { code: 'DEFAULT_BRANCH_OBSERVE_FAILED', message: observedDefault.error } }
            : {}),
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
    // docs/config/marketplace workflows trim snapshot-verify gates (H5):
    // they are declared code-class gates that a non-code change surface
    // cannot exercise. Consumer-verify gates (phase 'consumer-verify') are
    // NOT part of this skip — they run during verify regardless of workflow.
    if (skipSnapshotVerifyGates) {
      await evidence.append({
        phase: 'snapshot-verify',
        status: 'skipped',
        reason: `workflow "${workflow}" trims snapshot-verify gates; declared gates: ${declaredVerificationGates.length}`,
      });
    } else {
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
    }

    // Bind the remote source-authority proof to the exact bytes that entered
    // the frozen snapshots, not merely to an earlier read of the workspace.
    // Then re-read the complete closure and dirty state once more so version
    // sources and non-snapshot closure entries cannot drift during prepare.
    // Trimmed together with Step 3c when a docs/config/marketplace workflow
    // skips the source-authority closure.
    if (production && !skipSourceAuthorityClosure) {
      await verifySnapshotClosureBinding({
        sourceInputClosure,
        unitResults,
        configUnits,
        realRoot,
        evidence,
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

    // --- Step 7-gate: Full-test freeze gate (hard gate) ---
    // 2026-08-18 investigation §4.4 / review §3.4: "full test suite before
    // freeze" is a HARD gate, not a convention. The plan digest may only be
    // computed after a completed FULL-mode test hook exists in THIS run's
    // evidence (fresh run or a cached replay of a successful full run).
    // Built-in and read-only — like secret-scan, plan-digest binding, and
    // approval, it cannot be disabled by project overlays. Workflows that
    // trim declared hooks record the trim; projects declaring no test hook
    // pass vacuously (nothing can run incrementally there).
    if (skipDeclaredHooks) {
      await evidence.append({
        phase: 'full-test-gate',
        status: 'skipped',
        reason: `workflow "${workflow}" trims declared hooks`,
      });
    } else if (!config.hooks?.test) {
      await evidence.append({
        phase: 'full-test-gate',
        status: 'not-declared',
        reason: 'no test hook declared; nothing can run incrementally',
      });
    } else {
      const testRecord = hookRecords.find((record) => record.name === 'test');
      const satisfied = Boolean(
        testRecord && testRecord.completed && testRecord.testSelection === 'full',
      );
      if (!satisfied) {
        await evidence.append({
          phase: 'full-test-gate',
          status: 'blocking',
          testSelection: testRecord?.testSelection ?? null,
          cached: Boolean(testRecord?.cached),
        });
        throw new ReleaseError(
          GATE_FAILED,
          testRecord?.testSelection === 'incremental'
            ? 'full-test freeze gate failed: incremental test selection cannot satisfy the freeze-time requirement of a completed full test run in this prepare run'
            : 'full-test freeze gate failed: prepare requires a completed full-mode test hook in this run before the plan digest is computed',
          {
            gate: 'full-test-freeze',
            testSelection: testRecord?.testSelection ?? null,
            cached: Boolean(testRecord?.cached),
          },
        );
      }
      await evidence.append({
        phase: 'full-test-gate',
        status: 'completed',
        testSelection: 'full',
        cached: Boolean(testRecord.cached),
      });
    }

    // New prepares emit planVersion 3 (multi-release-unit postPublish v3;
    // v3 inherits the v2 record-layer freeze-timestamp semantics from
    // t1-2-digest-decoupling.md §4.2/§7). Production freeze timestamps are
    // derived deterministically from the baseline headCommit's committer
    // date, before the first frozen Git object exists. This single canonical
    // value becomes GIT_AUTHOR_DATE/GIT_COMMITTER_DATE for every unit's
    // frozen commit and every unit's frozenSnapshot.commitTimestamp;
    // identical sources freeze byte-identical Git objects on every
    // re-prepare. The wall-clock sample is still validated here (fail closed
    // before any Git write) and becomes plan.createdAt -- record-layer real
    // clock behind the 24h approval window, no longer equal to the freeze
    // timestamp for v2/v3 plans. The v1 legacy path used this same sample as
    // the freeze timestamp itself (commitTimestamp == createdAt). publish,
    // retry, and reconcile consume the frozen value from the plan and never
    // re-read the wall clock or re-derive it.
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


    // P4 (ruling 6) ordering: local facts and the local closure gate FIRST,
    // remote marketplace observation AFTER.
    //
    // Phase A: resolve every plugin distribution's frozen manifest facts from
    // the local snapshot (marketplace source selection, bundled index entry,
    // manifest bytes). No remote observation happens here.
    const { frozenManifestByDist, distributionFacts } =
      await resolveDistributionManifestFacts(unitResults, resolvedVersions);

    // Phase B: the built-in local skill-resource closure gate. Production
    // snapshots are sealed inside buildProductionAssets; the receipt binds the
    // exact byte/mode identity publish will re-verify. A local closure
    // failure aborts prepare BEFORE any remote marketplace observer runs.
    const skillResourceClosureResults = await runPrepareSkillResourceClosureGate({
      unitResults,
      frozenManifestByDist,
      freezeTimestamp,
      evidence,
      skipSkillResourceClosure,
      workflow,
    });

    // Phase C: freeze external independent marketplace HEADs (production +
    // online only): for each claude/codex/codebuddy distribution declaring
    // marketplaceRepo, resolve the external repo's HEAD sha + default branch
    // and validate the marketplace index entry at that sha before freezing the
    // add-ref. The remote is only ever read (git ls-remote / gh api), never
    // written, and it is only ever reached AFTER the local closure passed.
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

    // Phase D: freeze the installation contract for every plugin
    // distribution, consuming the SAME frozen manifest facts the closure gate
    // used (parsed once) plus the remote-freeze entries from Phase C.
    const units = await Promise.all(unitResults.map(async ({ unit, manifest }, idx) => {
      const unitVersion = resolvedVersions[idx];
      const unitBaseline = unitBaselineResults.get(unit.id);

      const distributionsWithSource = await Promise.all((unit.distributions ?? []).map(async (dist) => {
        const platform = PLATFORMS.find((p) => p.distributionType === dist.type);
        if (!platform || dist.type === 'npm') return dist;
        const key = `${unit.id} ${dist.type}`;
        const facts = distributionFacts.get(key);

        // includeMarketplaceEntry 代表"契约实际包含一条市场条目"，
        // 不能只代表平台理论上支持市场条目。
        // bundled-family: 平台支持市场时即包含（Phase A 已从快照读取）。
        // standalone-index: 只有拿到冻结条目且非 Kimi 时才包含（Phase C）。
        // Kimi 不纳入市场条目：Kimi 无市场 CLI，selectedEntry 仅供静态校验。
        let includeMarketplaceEntry;
        let selectedMarketplaceEntry = null;
        let marketplaceIndexRelative = facts.marketplaceIndexRelative;
        if (facts.isBundledFamily) {
          includeMarketplaceEntry = facts.includeMarketplaceEntryBundled;
          selectedMarketplaceEntry = facts.selectedMarketplaceEntryBundled;
        } else if (facts.isStandaloneIndex) {
          if (platform.id === 'kimi') {
            // Kimi standalone: 安装契约不纳入市场条目
            includeMarketplaceEntry = false;
          } else {
            const freezeKey = key;
            const freeze = externalMarketplaceFreezes.get(freezeKey);
            if (freeze) {
              includeMarketplaceEntry = true;
              // standalone-index: 从外部冻结结果获取条目和路径
              selectedMarketplaceEntry = freeze.selectedEntry;
              marketplaceIndexRelative = freeze.marketplaceIndexPath;
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

        // 使用 buildInstallationContract 构建完整可审计契约对象
        const installationContract = buildInstallationContract({
          distributionType: dist.type,
          manifestRelativePath: facts.pluginManifestRelative,
          manifest: facts.pluginManifestParsed,
          marketplaceSourceType: facts.marketplaceSourceType,
          includeMarketplaceEntry,
          ...(includeMarketplaceEntry ? {
            marketplaceIndexRelativePath: marketplaceIndexRelative,
            selectedMarketplaceEntry,
          } : {}),
          verificationRecipeVersion: CONSUMER_INSTALL_RECIPE_VERSION,
        });

        // 计算摘要（使用权威算法入口，保证契约对象与摘要一致）
        const installationContractDigest = computeInstallationContractDigest({
          distributionType: dist.type,
          manifestRelativePath: facts.pluginManifestRelative,
          manifest: facts.pluginManifestParsed,
          marketplaceSourceType: facts.marketplaceSourceType,
          includeMarketplaceEntry,
          ...(includeMarketplaceEntry ? {
            marketplaceIndexRelativePath: marketplaceIndexRelative,
            selectedMarketplaceEntry,
          } : {}),
          verificationRecipeVersion: CONSUMER_INSTALL_RECIPE_VERSION,
        });

        // 构建返回对象，包含冻结的审计字段
        const frozenDist = {
          ...dist,
          marketplaceSourceType: facts.marketplaceSourceType,
          installationContract,
          installationContractDigest,
        };

        // standalone-index 审计字段：来自外部冻结结果
        if (facts.isStandaloneIndex) {
          const freezeKey = key;
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

    // --- Step 6b-pre: config public-byte comparison (R-14) ---
    // The config decision must be known before publicSourceAuthorityReceipt
    // and the deferred source-authority gate: scenario B (publish-needed)
    // runs the exact existing source-authority logic here so the frozen plan
    // carries the binding; scenario A ends with externalActions=[] and no
    // sourceAuthority. The decision evidence stays in Step 6b below.
    let configDecision = null;
    if (workflow === 'config') {
      const previousPlan = await readLatestFrozenPlan(realRoot);
      let publishPath;
      let decision;
      if (!previousPlan) {
        publishPath = 'publish-needed';
        decision = 'indeterminable';
      } else {
        const prevDigests = new Map(
          (previousPlan.plan.units ?? []).map((u) => [u.id, u.snapshotDigest]),
        );
        const unchanged =
          units.length > 0 && units.every((u) => prevDigests.get(u.id) === u.snapshotDigest);
        publishPath = unchanged ? 'no-publish-needed' : 'publish-needed';
        decision = unchanged ? 'public-bytes-unchanged' : 'public-bytes-changed';
      }
      configDecision = {
        publishPath,
        decision,
        comparedPlan: previousPlan?.fileName ?? null,
      };
      if (deferSourceAuthorityClosure && publishPath === 'publish-needed') {
        ({ sourceAuthority, sourceInputClosure } = await computeSourceAuthorityClosure({
          sourceRepository,
          configDefaultBranch,
          configUnits,
          realRoot,
          offline,
          evidence,
          observeOriginAheadFn: options.observeOriginAheadFn,
          runWarnings,
          configPath,
        }));
        await verifySnapshotClosureBinding({
          sourceInputClosure,
          unitResults,
          configUnits,
          realRoot,
          evidence,
        });
      }
    }

    let publicSourceAuthorityReceipt = null;
    if (config.publicSourceAuthorityReceipt) {
      // P3 (ruling 7): config scenario A (no-publish-needed) means the public
      // bytes are unchanged and nothing will be published — a configured
      // public source receipt must not require or generate a nonexistent
      // publish binding. The receipt is skipped and evidenced; the
      // receipt-mandatory rules stay in force for every publish path.
      if (workflow === 'config' && configDecision?.publishPath === 'no-publish-needed') {
        await evidence.append({
          phase: 'public-source-authority-receipt',
          status: 'skipped',
          reason: 'config workflow decided no-publish-needed; no public source receipt is generated without a publish path',
        });
      } else if (!production || !sourceAuthority) {
        throw new ReleaseError(
          CONFIG_INVALID,
          'publicSourceAuthorityReceipt requires a production prepare with source-authority closure enabled',
        );
      } else {
      const unitsById = new Map(units.map((unit) => [unit.id, unit]));
      const subjects = config.publicSourceAuthorityReceipt.subjectUnitIds.map((unitId) => {
        const unit = unitsById.get(unitId);
        const npmDistribution = unit?.distributions?.find((distribution) => distribution.type === 'npm');
        const npm = unit?.frozenSnapshot?.npm;
        if (!unit || !npmDistribution || !npm) {
          throw new ReleaseError(
            GATE_FAILED,
            `public source-authority subject unit "${unitId}" is missing its frozen npm tarball`,
          );
        }
        return {
          packageName: npmDistribution.package,
          version: unit.targetVersion,
          filename: basename(npm.tarballPath),
          sha256: npm.tarballSha256,
        };
      });
      const builtReceipt = createPublicSourceAuthorityReceipt({
        sourceRepository: sourceAuthority.sourceRepository,
        sourceBaseCommit: baseline.gitHead,
        subjects,
      });
      const assetName = 'source-authority-receipt.json';
      const assetDirectory = resolve(runDir, 'release-assets');
      await mkdir(assetDirectory, { recursive: true });
      await writeFileAtomic(assetDirectory, assetName, builtReceipt.bytes, { mode: 0o644 });
      publicSourceAuthorityReceipt = {
        coordinatorUnitId: config.publicSourceAuthorityReceipt.coordinatorUnitId,
        subjectUnitIds: [...config.publicSourceAuthorityReceipt.subjectUnitIds],
        asset: {
          name: assetName,
          path: relative(realRoot, resolve(assetDirectory, assetName)),
          sha256: builtReceipt.sha256,
        },
      };
      await evidence.append({
        phase: 'public-source-authority-receipt',
        status: 'frozen',
        coordinatorUnitId: publicSourceAuthorityReceipt.coordinatorUnitId,
        subjectUnitIds: publicSourceAuthorityReceipt.subjectUnitIds,
        assetPath: publicSourceAuthorityReceipt.asset.path,
        assetSha256: publicSourceAuthorityReceipt.asset.sha256,
      });
      }
    }

    let externalActions = buildExternalActions(
      unitResults,
      resolvedVersions,
      productionAssets,
      externalMarketplaceFreezes,
      frozenDistributionsMap,
      publicSourceAuthorityReceipt,
    );

    // Compute overall snapshot digest
    const overallSnapshotDigest = sha256Hex(snapshotDigests.join(':'));

    // --- Step 6b: Workflow decision (H5) ---
    // config workflow: compare per-unit snapshotDigests with the latest
    // frozen plan. Identical public bytes → no publish path (all publish-class
    // external actions are dropped from the plan, so approve/publish execute
    // nothing). No comparable plan or any byte difference → publish-needed
    // (fail-safe). The decision is bound into the plan digest as
    // `workflowDecision`, making the trim immutable and auditable.
    let workflowDecision = null;
    if (workflow === 'config') {
      const { publishPath, decision, comparedPlan } = configDecision;
      // R-14: trimmedGates must be scenario-truthful — config scenario B
      // runs the deferred source-authority closure, so it is not trimmed.
      const sourceAuthorityClosureTrimmed = !(publishPath === 'publish-needed' && production);
      workflowDecision = {
        workflowKind: workflow,
        decision,
        publishPath,
        trimmedGates: [
          'declared-hooks',
          'snapshot-verify-gates',
          ...(sourceAuthorityClosureTrimmed ? ['source-authority-closure'] : []),
          'skill-resource-closure',
        ],
        ...(comparedPlan ? { comparedPlan } : {}),
      };
      if (publishPath === 'no-publish-needed') {
        externalActions = [];
      }
      await evidence.append({
        phase: 'workflow-decision',
        status: publishPath,
        decision,
        ...(comparedPlan ? { comparedPlan } : {}),
        actionCount: externalActions.length,
      });
    } else if (trimmedWorkflow) {
      workflowDecision = {
        workflowKind: workflow,
        decision: 'code-gates-trimmed',
        publishPath: 'publish-needed',
        // docs production keeps the source-authority closure (its publish
        // path is release-skill executed), so the trim list reflects it.
        trimmedGates: [
          'declared-hooks',
          'snapshot-verify-gates',
          ...(production && !skipSourceAuthorityClosure ? [] : ['source-authority-closure']),
          'skill-resource-closure',
        ],
      };
      await evidence.append({
        phase: 'workflow-decision',
        status: 'publish-needed',
        decision: 'code-gates-trimmed',
      });
    }

    // Detect human consumer platforms (Kimi/CodeBuddy) in the plan. Foundation
    // 0.13 can observe their complete local payload only when production has
    // frozen a bundled-family source. Standalone marketplace sources remain on
    // the legacy manual-follow-up path because Foundation exposes no public
    // Kimi/WorkBuddy public-channel driver in this release.
    const humanConsumerActions = externalActions.filter(
      (a) => a.type === 'kimi-marketplace-install' || a.type === 'codebuddy-marketplace-install',
    );
    const humanConsumersStrategy = humanConsumerActions.length === 0
      ? null
      : humanConsumerActions.some((action) => (
          isFoundationPluginVerificationEligible({ action, units })
        ))
        ? 'foundationPayloadThenManualFollowUps'
        : 'manualFollowUps';

    // --- Fold the validated postPublish declarations into the frozen plan ---
    // Multi-release-unit v3 contract: the frozen field is ALWAYS an array,
    // one entry per declaring unit in plan.units order (zero declarations
    // freeze the empty array, which never enters post-release execution).
    // Bindings per entry: tag (tagTemplate rendered at the resolved target
    // version — the same computation create-tag will use), tagCommit (the
    // frozen production asset commit the tag will point at; only production
    // prepares can freeze it — distribute fails closed when it is absent),
    // unitId (declaring unit), and payloadSource "tag-worktree" (R1 timing
    // contract: payload may only come from the detached worktree at
    // tagCommit, never from workspace state). The array and every entry
    // participate in the plan digest through the existing digest mechanism
    // (no per-entry summaries, maps, or second manifest), so declaration
    // order and any bound field change change the plan digest.
    //
    // F-01 / T1 private execution bundle: parent-workspace files that the
    // post-publish commands need but the frozen tag does not contain are
    // frozen here — Foundation closure (verbatim computeResourceClosure
    // return) + the release-unit publicFiles projection — and their bytes
    // are published digest-addressed under this plan's .release-skill. The
    // plan is the bundle's only source of truth (no parallel manifest, no
    // second bundle digest): the raw executionFiles list folds into the
    // closure and is NOT duplicated into the frozen block.
    const frozenPostPublish = [];
    for (const { unit, index } of postPublishDeclarations) {
      const { tag } = resolveProductionBranch(unit, resolvedVersions[index]);
      const declaredExecutionFiles = unit.postPublish.executionFiles ?? [];
      const frozenTagPaths = productionAssets
        ? await enumerateFrozenTagPaths(realRoot, productionAssets[index])
        : null;
      await assertPrivateExecutionDeclarations(unit.postPublish, {
        workspaceRoot: realRoot,
        frozenTagPaths,
        executionFiles: declaredExecutionFiles,
      });
      const executionBundle = await freezeExecutionBundle({
        workspaceRoot: realRoot,
        releaseSkillDir: releaseDir,
        executionFiles: declaredExecutionFiles,
        publicFiles: unit.publicFiles ?? [],
      });
      await evidence.append({
        phase: 'postpublish-execution-bundle',
        status: 'frozen',
        unitId: unit.id,
        closureDigest: executionBundle.closure.digest,
        resourceCount: executionBundle.closure.resources.length,
        publicFileCount: executionBundle.publicFiles.length,
        bundleRoot: relative(realRoot, bundleRootForAuthorityDir(releaseDir)),
      });
      const { executionFiles: _executionFiles, ...declarationWithoutManifest } = structuredClone(unit.postPublish);
      frozenPostPublish.push({
        ...declarationWithoutManifest,
        tag,
        ...(productionAssets ? { tagCommit: productionAssets[index].commit } : {}),
        unitId: unit.id,
        payloadSource: PAYLOAD_SOURCE_TAG_WORKTREE,
        executionBundle,
      });
    }

    const plan = {
      // New prepares emit planVersion 3 (multi-release-unit postPublish v3):
      // postPublish is the declaration ARRAY (possibly empty). v3 inherits
      // the v2 record-layer digest and approval semantics; only the
      // postPublish shape changes.
      planVersion: 3,
      status: 'PREPARED',
      // Workflow profile (H5): 'full' for the complete gate set;
      // 'docs'/'config'/'marketplace' for trimmed code-class gates. Both
      // fields are binding-layer (not stripped from the plan digest), so the
      // trim is frozen immutably with the plan.
      workflowKind: workflow,
      ...(workflowDecision ? { workflowDecision } : {}),
      baseline: {
        gitTreeHash: baseline.gitTreeHash,
        headCommit: baseline.gitHead,
        workspaceDigestAlgorithm: baseline.workspaceDigestAlgorithm,
        workspaceDigest: baseline.workspaceDigest,
        dirtyFiles: baseline.statusEntries,
        capturedAt: baseline.capturedAt,
      },
      configDigest,
      ...(skillResourceClosureResults.length > 0
        ? {
            skillResourceClosure: {
              checkerVersion: SKILL_RESOURCE_CHECKER_VERSION,
              unitReceipts: skillResourceClosureResults,
              totalSkillCount: skillResourceClosureResults.reduce((sum, item) => sum + item.skillCount, 0),
              totalReferenceCount: skillResourceClosureResults.reduce((sum, item) => sum + item.referenceCount, 0),
              totalSourceOnlyCount: skillResourceClosureResults.reduce((sum, item) => sum + item.sourceOnlyCount, 0),
              totalFindingCount: 0,
            },
          }
        : {}),
      verificationGates: config.verificationGates ?? [],
      snapshotDigest: overallSnapshotDigest,
      ...(humanConsumersStrategy ? { humanConsumersStrategy } : {}),
      ...(production ? {
        production: {
          mode: 'github-npm-v1',
          assetRoot: relative(realRoot, runDir),
        },
      } : {}),
      units,
      externalActions,
      ...(publicSourceAuthorityReceipt ? { publicSourceAuthorityReceipt } : {}),
      postPublish: frozenPostPublish,
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

    // --- Write the FROZEN governance marker (§4.5 option 1) ---
    // Mechanical maintenance only: the marker is a read-only gentlemen's-
    // agreement signal for cross-repo writers (e.g. skill-family治理 tasks)
    // that this workspace is mid-release. It is written ONLY after the plan
    // is frozen, overwritten by every successful prepare, and cleared by
    // verify only upon VERIFIED. A failed prepare never reaches this point.
    await writeFrozenMarker(releaseDir, {
      planDigest,
      targetVersions: Object.fromEntries(
        configUnits.map((unit, index) => [unit.id, resolvedVersions[index]]),
      ),
      createdAt: plan.createdAt,
      runId: basename(runDir),
    });
    await evidence.append({
      phase: 'frozen-marker',
      status: 'written',
      markerPath: `.release-skill/${FROZEN_MARKER_FILENAME}`,
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
      workflowKind: workflow,
      ...(workflowDecision ? { workflowDecision } : {}),
      completedAt: (clock ? clock() : new Date().toISOString()),
    });

    // --- O4 (2026-08-18 investigation §3.2): success-time guidance ---
    // A NON-PRODUCTION plan cannot be used by publish; historically operators
    // discovered that only after a full prepare+approve round-trip. Surface the
    // remediation at success time so the loop never starts. Production plans
    // carry no such warning. The prepare command's own defaults are unchanged —
    // this only enriches the result, never flips offline/production.
    const nextSteps = [];
    if (!production) {
      nextSteps.push({
        code: 'NON_PRODUCTION_PLAN_NOT_PUBLISHABLE',
        message:
          'This plan is NON-PRODUCTION and cannot be used by publish. ' +
          'To release, re-run: release-skill prepare --production --online — ' +
          'or use the guided happy end: release-skill ship --target-version <version>.',
      });
    }

    return {
      planPath: writtenPath,
      planDigest,
      evidenceDir,
      warnings: runWarnings,
      nextSteps,
    };
  } catch (err) {
    // Record failure evidence (best effort). A broken clock can make the
    // failure event itself fail v2 schema validation (timestamp format);
    // the stream must still be sealed so the FAILED summary is written and
    // the evidence fd is released (2026-08-26: badclock fixture leak).
    try {
      await evidence.append({
        phase: 'prepare',
        status: 'failed',
        error: { code: err.code, message: err.message },
      });
    } catch {
      // Failure evidence is best-effort; the finish seal below is
      // authoritative and must never be skipped.
    }

    // RW-1 hardening alignment (2026-08-26): the failure-path finish is
    // best-effort too — an evidence-disk failure must never mask the original
    // error, which always propagates unchanged.
    try {
      await evidence.finish({
        status: 'FAILED',
        error: { code: err.code, message: err.message },
        failedAt: (clock ? clock() : new Date().toISOString()),
      });
    } catch {
      // The FAILED summary could not be sealed (e.g. evidence directory
      // became unwritable); the original failure still propagates.
    }

    throw err;
  } finally {
    // Release project lock — always, even on failure
    await lock.release();
  }
}
