/**
 * Verify command: post-publish verification and smoke tests.
 *
 * Reads a source run (publish or reconcile) and validates:
 * 1. Source run status is PUBLISHED (VERIFIED is terminal)
 * 2. All checkpoints in the source run are succeeded or skipped
 * 3. Each action's remote state is verified via adapter.verify()
 * 4. Installation smoke test passes
 *
 * The source run is mandatory; verify never silently falls back to plan.status.
 *
 * @module commands/verify
 */

import { readFile, writeFile, mkdtemp, rm, mkdir, lstat, realpath, readdir } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { dirname, join, relative, isAbsolute, resolve, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { resolveContained } from 'skill-family-harness-node';

const execFile = promisify(execFileCb);

import { validatePlan, computePlanDigest, validatePlanActionCompleteness } from '../core/plan.mjs';
import { createEvidenceWriter } from '../core/evidence.mjs';
import { readRunRecovery } from '../core/recovery.mjs';
import {
  loadRun,
  resolveRunPath,
  validateRunPlanDigest,
  validateRunCheckpointMapping,
  validateRunLineage,
  writeRunAtomic,
  computeRunDigest,
  resolveDefaultRunDir,
  createProductionRunDir,
} from '../core/run.mjs';
import {
  assertImmutableApprovalAuthority,
  validateApproval,
  validateApprovalRecordSchema,
} from '../core/approval.mjs';
import {
  ReleaseError,
  GATE_FAILED,
  CONFIG_MISSING,
  POST_PUBLISH_VERIFY_FAILED,
  CONSUMER_VERIFICATION_DEFERRED,
} from '../core/errors.mjs';
import {
  consumePublicSourceAuthorityReceipt,
  verifySourceAuthorityReceipt,
} from '../core/source-authority.mjs';
import { verifyFrozenFile } from '../snapshot/frozen.mjs';
import {
  deriveBaselineAdvances,
  applyBaselineAdvances,
  isWorktreeFileClean,
  commitBaselineAdvance,
} from '../core/baseline-advance.mjs';
import { loadProjectConfig } from '../core/config.mjs';
import { assertTransition, PUBLISHED, VERIFIED } from '../core/state-machine.mjs';
import { clearFrozenMarker } from '../core/frozen-marker.mjs';
import { resolveUnitScopedPath } from '../snapshot/public-path.mjs';
import {
  normalizeRegistry,
  registryTokenKey,
  resolveNpmRegistryAuthToken,
  verifyFrozenNpmTarballContract,
} from '../adapters/npm.mjs';
import { runConsumerVerificationGates } from '../core/verification-gates.mjs';
import {
  assertSkillResourceClosureReceipt,
  checkSkillResourceClosure,
  createSkillResourceClosureReceipt,
  evaluateConsumerSkillResourceClosureReceipts,
} from '../core/skill-resource-closure.mjs';
import { deriveSurfaceHostBinding, pluginRootFromManifestRelativePath } from '../core/surface-host-bindings.mjs';
import { isRemoteWriteAction, isMarketplaceAction } from '../core/checkpoints.mjs';
import { PLATFORMS, normalizeHostId } from '../platforms/registry.mjs';
import {
  shouldSkipVerification,
  INSTALLATION_CONTRACT_ALGORITHM_VERSION,
} from '../core/installation-contract.mjs';
import {
  buildDirectoryFileIndex,
  checkNpmEntryClosure,
} from '../npm/npm-entry-closure.mjs';
import {
  KIMI_ATTESTATION_FILE,
  KIMI_REQUIREMENT_FILE,
  kimiAuthorityDir,
  resolveBoundPlanDigest,
  validateKimiAttestation,
} from '../platforms/kimi.mjs';
import {
  CODEBUDDY_ATTESTATION_FILE,
  CODEBUDDY_REQUIREMENT_FILE,
  codebuddyAuthorityDir,
  resolveCodeBuddyBoundPlanDigest,
  validateCodeBuddyAttestation,
} from '../platforms/codebuddy.mjs';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * 验证已解决结果类型。
 *
 * - PASSED_AUTOMATIC: 自动验证通过（adapter.verify 返回 VERIFIED）
 * - PASSED_MANUAL: 人工验证通过（用户手动确认）
 * - NOT_REQUIRED_UNCHANGED: 无需验证（远端状态未变化，跳过验证）
 */
export const VERIFICATION_RESOLVED_TYPES = Object.freeze({
  PASSED_AUTOMATIC: 'PASSED_AUTOMATIC',
  PASSED_MANUAL: 'PASSED_MANUAL',
  NOT_REQUIRED_UNCHANGED: 'NOT_REQUIRED_UNCHANGED',
});

/** Re-read every frozen subject tarball before consuming the public receipt. */
export async function verifyPublicSourceAuthorityReceiptOffline({ plan, root }) {
  const descriptor = plan.publicSourceAuthorityReceipt;
  const verifiedAsset = await verifyFrozenFile({
    root,
    filePath: descriptor.asset.path,
    expectedSha256: descriptor.asset.sha256,
    label: 'public source-authority receipt',
  });
  const actualSubjects = [];
  for (const unitId of descriptor.subjectUnitIds) {
    const unit = plan.units.find((candidate) => candidate.id === unitId);
    const npmDistribution = unit?.distributions?.find((distribution) => distribution.type === 'npm');
    const npm = unit?.frozenSnapshot?.npm;
    await verifyFrozenNpmTarballContract({
      package: npmDistribution?.package,
      version: unit?.targetVersion,
      tarballPath: npm?.tarballPath,
      tarballSha256: npm?.tarballSha256,
      integrity: npm?.integrity,
    }, root);
    actualSubjects.push({
      packageName: npmDistribution.package,
      version: unit.targetVersion,
      filename: basename(npm.tarballPath),
      sha256: npm.tarballSha256,
    });
  }
  return consumePublicSourceAuthorityReceipt(
    await readFile(verifiedAsset.physical),
    actualSubjects,
  );
}

/**
 * Map plan action type to adapter ActionType.
 * Must match publish.mjs and reconcile.mjs.
 */
const ADAPTER_ACTION_TYPE_MAP = {
  'push-commit': 'git-push',
  'push-snapshot': 'push-snapshot',
  'set-default-branch': 'set-default-branch',
  'create-tag': 'git-tag',
  'npm-publish': 'npm-publish',
  'github-release': 'github-release',
  'claude-marketplace-install': 'claude-marketplace-install',
  'codex-marketplace-install': 'codex-marketplace-install',
  'kimi-marketplace-install': 'kimi-marketplace-install',
  'codebuddy-marketplace-install': 'codebuddy-marketplace-install',
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function defaultClock() {
  return new Date().toISOString();
}

/**
 * 验证摘要格式是否为合法的 64 位十六进制字符串。
 *
 * @param {string} digest - 摘要
 * @returns {boolean} 是否合法
 */
function isValidDigest(digest) {
  return typeof digest === 'string' && /^[a-f0-9]{64}$/.test(digest);
}

/**
 * Generate every manual consumer requirement before any expensive automatic
 * consumer install starts. This turns a sequence of "install Kimi, rerun,
 * then discover CodeBuddy" failures into one actionable response.
 */
async function collectMissingManualAttestations({
  actions,
  adapterRegistry,
  plan,
  root,
  runDir,
  clockFn,
}) {
  const manual = actions.filter((action) => (
    action.type === 'kimi-marketplace-install'
    || action.type === 'codebuddy-marketplace-install'
  ));
  if (manual.length === 0) return [];

  const missing = [];
  for (const action of manual) {
    const adapterActionType = ADAPTER_ACTION_TYPE_MAP[action.type];
    const adapter = adapterRegistry.getAdapter(adapterActionType);
    // Tests and embedders may intentionally register a fully automatic
    // adapter for these action types. Only the real platform adapter owns the
    // interactive manual-install protocol and its stable authority files.
    if (adapter.name !== 'plugin-marketplace') continue;
    const context = {
      externalWritesAuthorized: false,
      isolatedConsumerWritesAuthorized: true,
      plan,
      baseline: plan.baseline,
      root,
      runDir,
    };
    const actionInput = { actionType: adapterActionType, ...action.parameters };
    const preflight = await adapter.preflight(actionInput, context);
    if (preflight.status !== 'PREFLIGHT_PASSED') {
      throw new ReleaseError(
        POST_PUBLISH_VERIFY_FAILED,
        `manual consumer preflight did not pass for action "${action.id}": ${preflight.error}`,
        { actionId: action.id, platform: action.type.split('-')[0] },
      );
    }
    const executed = await adapter.execute(actionInput, context);
    if (executed.status !== 'EXECUTED') {
      throw new ReleaseError(
        POST_PUBLISH_VERIFY_FAILED,
        `cannot generate manual consumer requirement for action "${action.id}": ${executed.error}`,
        { actionId: action.id, platform: action.type.split('-')[0] },
      );
    }

    const isKimi = action.type === 'kimi-marketplace-install';
    const planDigest = isKimi
      ? resolveBoundPlanDigest(context)
      : await resolveCodeBuddyBoundPlanDigest(context);
    const authorityDir = isKimi
      ? kimiAuthorityDir(context, planDigest, action.parameters.plugin)
      : codebuddyAuthorityDir(context, planDigest, action.parameters.plugin);
    const requirementPath = join(
      authorityDir,
      isKimi ? KIMI_REQUIREMENT_FILE : CODEBUDDY_REQUIREMENT_FILE,
    );
    const attestationPath = join(
      authorityDir,
      isKimi ? KIMI_ATTESTATION_FILE : CODEBUDDY_ATTESTATION_FILE,
    );

    let valid = false;
    let reason = 'attestation file is missing';
    try {
      const attestation = JSON.parse(await readFile(attestationPath, 'utf8'));
      const validation = isKimi
        ? validateKimiAttestation(attestation, action.parameters, clockFn(), planDigest)
        : validateCodeBuddyAttestation(attestation, action.parameters, clockFn(), planDigest);
      valid = validation.valid;
      reason = validation.error;
    } catch (error) {
      if (error?.code !== 'ENOENT') reason = `attestation cannot be read: ${error.message}`;
    }
    if (!valid) {
      missing.push({
        actionId: action.id,
        platform: isKimi ? 'kimi' : 'codebuddy',
        plugin: action.parameters.plugin,
        version: action.parameters.version,
        planDigest,
        requirementPath,
        attestationPath,
        reason,
      });
    }
  }
  return missing;
}

// ---------------------------------------------------------------------------
// Smoke test
// ---------------------------------------------------------------------------

/**
 * Recursive subset matching: every leaf in `expected` must exist in `actual`
 * with the same value. Nested objects are compared recursively; primitives
 * are compared with strict equality.
 *
 * @param {any} actual
 * @param {any} expected
 * @returns {boolean}
 */
function matchesSubset(actual, expected) {
  if (expected === null || expected === undefined) {
    return actual === expected;
  }
  if (typeof expected !== 'object' || Array.isArray(expected)) {
    return actual === expected;
  }
  if (typeof actual !== 'object' || actual === null || Array.isArray(actual)) {
    return false;
  }
  for (const key of Object.keys(expected)) {
    if (!(key in actual) || !matchesSubset(actual[key], expected[key])) {
      return false;
    }
  }
  return true;
}

/**
 * Run installation smoke test in a temporary directory.
 *
 * For every npm distribution declared in the plan, installs the exact
 * `<package>@<targetVersion>` into an isolated temporary project with
 * safe default npm flags. Validates:
 * - Installed package.json name and version match exactly.
 * - When smokeBin is configured: the specified bin is resolved, validated
 *   against path-escape/symlink/non-regular-file guards, and executed with
 *   smokeArgs; output is validated against smokeExpectedJson (recursive
 *   subset match) when present. The expected `version` field is injected at
 *   runtime from the unit's resolved targetVersion and overrides any
 *   config-declared value, so the version check never depends on a
 *   hand-written config version (T2.1 §4.3).
 * - When smokeBin is not configured: install + name/version check passes
 *   immediately; runBin is never called; result records
 *   cliSmoke: "not-configured".
 * - No best-effort catch: any failure is fail-closed.
 *
 * When no npm distribution exists, returns `{ passed: true, skipped: true }`
 * so pure plugin projects can verify cleanly.
 *
 * @param {Object} plan - The frozen release plan.
 * @param {string} root - Project root for source access.
 * @param {Object} [options]
 * @param {Object} [options.npmExecutor] - Injectable npm executor for testing.
 * @returns {Promise<{ passed: boolean, skipped?: boolean, details: Object }>}
 */
export async function runSmokeTest(plan, root, options = {}) {
  const baseDir = options.baseDir ?? tmpdir();
  await mkdir(baseDir, { recursive: true });
  const tmpDir = await mkdtemp(join(baseDir, 'verify-smoke-'));
  const npmExec = options.npmExecutor ?? defaultNpmExecutor;
  const installFlags = [
    '--ignore-scripts',
    '--no-audit',
    '--no-fund',
    '--package-lock=false',
    '--save=false',
  ];

  try {
    // Collect all npm distributions across all units
    const units = plan.units ?? [];
    const npmDistributions = [];
    for (const unit of units) {
      for (const dist of unit.distributions ?? []) {
        if (dist.type === 'npm' && dist.package) {
          npmDistributions.push({
            package: dist.package,
            registry: normalizeRegistry(dist.registry),
            targetVersion: unit.targetVersion,
            unitId: unit.id,
            smokeBin: dist.smokeBin,
            smokeArgs: dist.smokeArgs ?? [],
            // The expected `version` is always the unit's resolved
            // targetVersion (whose source is version.source → package.json),
            // injected at runtime. A config-declared smokeExpectedJson.version
            // is redundant and overridden. This keeps the version check strong
            // without hand-writing the version into project config, so a
            // version bump never churns configDigest (T2.1 §4.3).
            smokeExpectedJson: dist.smokeExpectedJson
              ? { ...dist.smokeExpectedJson, version: unit.targetVersion }
              : dist.smokeExpectedJson,
          });
        }
      }
    }

    // No npm distribution: smoke passes with skipped flag
    if (npmDistributions.length === 0) {
      return {
        passed: true,
        skipped: true,
        details: { message: 'No npm distributions in plan; smoke test skipped' },
        gateResults: [],
        skillResourceClosureReceipts: [],
      };
    }

    const results = [];
    const gateResults = [];
    const skillResourceClosureReceipts = [];

    for (const { package: pkgName, registry, targetVersion, unitId, smokeBin, smokeArgs, smokeExpectedJson } of npmDistributions) {
      const packageAtVersion = `${pkgName}@${targetVersion}`;
      const installDir = resolveUnitScopedPath(tmpDir, unitId);
      await mkdir(join(installDir, 'node_modules'), { recursive: true });

      // Install exact package@version with safe flags
      const registryFlags = [...installFlags, '--registry', registry];
      const installResult = await npmExec.install(
        packageAtVersion,
        installDir,
        registryFlags,
        { registry },
      );
      if (!installResult.success) {
        return {
          passed: false,
          details: {
            error: `npm install ${packageAtVersion} failed: ${installResult.error}`,
            packageAtVersion,
            unitId,
          },
        };
      }

      // Verify installed package.json name and version
      const installedPkgPath = join(installDir, 'node_modules', pkgName, 'package.json');
      let installedPkg;
      try {
        installedPkg = JSON.parse(await readFile(installedPkgPath, 'utf8'));
      } catch {
        return {
          passed: false,
          details: {
            error: `Installed package.json not found at ${installedPkgPath}`,
            packageAtVersion,
            unitId,
          },
        };
      }

      if (installedPkg.name !== pkgName) {
        return {
          passed: false,
          details: {
            error: `Installed package name mismatch: expected ${pkgName}, got ${installedPkg.name}`,
            packageAtVersion,
            unitId,
          },
        };
      }

      if (installedPkg.version !== targetVersion) {
        return {
          passed: false,
          details: {
            error: `Installed version mismatch: expected ${targetVersion}, got ${installedPkg.version}`,
            packageAtVersion,
            unitId,
          },
        };
      }

      const pkgRoot = join(installDir, 'node_modules', pkgName);

      // Entry closure check: verify all declared entry points (bin, main,
      // module, types, typings, exports) exist as regular files in the
      // installed package. This catches incident-class tarballs where
      // name/version are correct but distribution files are missing.
      {
        const dirIndex = await buildDirectoryFileIndex(pkgRoot);
        const closureResult = checkNpmEntryClosure(installedPkg, dirIndex);
        if (closureResult.errors.length > 0) {
          return {
            passed: false,
            details: {
              gate: 'npm-entry-closure',
              error: `npm entry closure check failed for ${packageAtVersion}: ${closureResult.errors.map((e) => e.message).join('; ')}`,
              packageAtVersion,
              unitId,
              entries: closureResult.entries,
              errors: closureResult.errors,
              diagnostics: closureResult.diagnostics,
            },
          };
        }
      }

      if (plan.skillResourceClosure) {
        const expectedUnitReceipt = plan.skillResourceClosure.unitReceipts
          .find((item) => item.unitId === unitId);
        if (!expectedUnitReceipt) {
          return {
            passed: false,
            details: { error: `Skill resource closure receipt missing for npm unit "${unitId}"` },
          };
        }
        const closureResult = await checkSkillResourceClosure({
          snapshotDir: pkgRoot,
          host: 'npm',
        });
        if (closureResult.findings.length > 0) {
          return {
            passed: false,
            details: {
              error: `Skill resource closure failed for ${packageAtVersion}`,
              findings: closureResult.findings,
            },
          };
        }
        if (expectedUnitReceipt.skillCount > 0 && closureResult.skillCount === 0) {
          return {
            passed: false,
            details: {
              error: `Installed npm package ${packageAtVersion} contains no skills`,
            },
          };
        }
        skillResourceClosureReceipts.push(createSkillResourceClosureReceipt(
          closureResult,
          {
            unitId,
            distribution: 'npm',
            host: 'npm',
            checkedAt: new Date().toISOString(),
            exitCode: 0,
          },
        ));
      }
      gateResults.push(...await runConsumerVerificationGates({
        plan,
        unitId,
        distribution: 'npm',
        executionRoot: pkgRoot,
        evidence: options.evidence,
        env: options.gateEnv ?? process.env,
        fixedEnv: { HOME: installDir },
      }));

      // If smokeBin is not configured, install + name/version check is sufficient
      if (!smokeBin) {
        results.push({
          packageName: pkgName,
          version: targetVersion,
          packageAtVersion,
          unitId,
          cliSmoke: 'not-configured',
        });
        continue;
      }

      // Resolve and validate the specified bin by name
      const binMapping = installedPkg.bin;
      if (!binMapping) {
        return {
          passed: false,
          details: {
            error: `Installed package ${packageAtVersion} has no bin field; smokeBin "${smokeBin}" requested`,
            packageAtVersion,
            unitId,
          },
        };
      }

      const binRelative = typeof binMapping === 'string'
        ? binMapping
        : binMapping[smokeBin];
      if (typeof binRelative !== 'string' || binRelative.length === 0) {
        return {
          passed: false,
          details: {
            error: `Installed package ${packageAtVersion} does not expose bin "${smokeBin}"`,
            packageAtVersion,
            unitId,
          },
        };
      }

      // Verify bin path does not escape the installed package root
      const binPath = resolve(pkgRoot, binRelative);
      const relBin = relative(pkgRoot, binPath);
      const sep = process.platform === 'win32' ? '\\' : '/';
      if (isAbsolute(relBin) || relBin === '..' || relBin.startsWith(`..${sep}`)) {
        return {
          passed: false,
          details: {
            error: `Bin path escapes package root: ${binPath}`,
            packageAtVersion,
            unitId,
          },
        };
      }

      let binStat;
      try {
        binStat = await lstat(binPath);
        const [pkgRootReal, binPathReal] = await Promise.all([realpath(pkgRoot), realpath(binPath)]);
        const relReal = relative(pkgRootReal, binPathReal);
        if (
          !binStat.isFile() ||
          binStat.isSymbolicLink() ||
          isAbsolute(relReal) ||
          relReal === '..' ||
          relReal.startsWith(`..${sep}`)
        ) {
          throw new Error('bin is not a regular file inside the installed package');
        }
      } catch (err) {
        return {
          passed: false,
          details: {
            error: `Invalid installed bin for ${packageAtVersion}: ${err.message}`,
            packageAtVersion,
            unitId,
          },
        };
      }

      // Run CLI smoke — fail-closed, no best-effort catch
      const cliArgs = smokeArgs.length > 0 ? smokeArgs : [];
      let binResult;
      try {
        binResult = await npmExec.runBin(binPath, cliArgs, {
          cwd: pkgRoot,
          env: {
            HOME: installDir,
            TMPDIR: installDir,
            TEMP: installDir,
            TMP: installDir,
            PATH: dirname(process.execPath),
            CI: '1',
          },
        });
      } catch (binErr) {
        return {
          passed: false,
          details: {
            error: `CLI smoke execution failed for ${packageAtVersion}: ${binErr.message}`,
            packageAtVersion,
            unitId,
          },
        };
      }

      if (binResult.exitCode !== 0 && binResult.exitCode !== undefined) {
        return {
          passed: false,
          details: {
            error: `CLI smoke exited with code ${binResult.exitCode} for ${packageAtVersion}`,
            packageAtVersion,
            unitId,
          },
        };
      }

      // Validate CLI output
      if (smokeExpectedJson) {
        // Recursive subset matching: all expected fields must be present and equal
        let parsedOutput;
        try {
          parsedOutput = JSON.parse(binResult.stdout);
        } catch {
          return {
            passed: false,
            details: {
              error: `CLI smoke returned non-JSON output for ${packageAtVersion}`,
              packageAtVersion,
              unitId,
            },
          };
        }
        if (!matchesSubset(parsedOutput, smokeExpectedJson)) {
          return {
            passed: false,
            details: {
              error: `CLI smoke JSON output does not match expected fields for ${packageAtVersion}`,
              packageAtVersion,
              unitId,
              expected: smokeExpectedJson,
              actual: parsedOutput,
            },
          };
        }
      } else {
        // No expected JSON specified: only require valid JSON output
        try {
          JSON.parse(binResult.stdout);
        } catch {
          return {
            passed: false,
            details: {
              error: `CLI smoke returned non-JSON output for ${packageAtVersion}`,
              packageAtVersion,
              unitId,
            },
          };
        }
      }

      results.push({
        packageName: pkgName,
        version: targetVersion,
        packageAtVersion,
        unitId,
        cliSmoke: 'passed',
      });
    }

    return {
      passed: true,
      details: {
        distributions: results,
        count: results.length,
      },
      gateResults,
      skillResourceClosureReceipts,
    };
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Default npm executor that runs real npm commands.
 *
 * Install flags include --ignore-scripts, --no-audit, --no-fund,
 * --package-lock=false, --save=false for safe isolated installs.
 */
const defaultNpmExecutor = {
  async install(packageAtVersion, cwd, flags, { registry }) {
    const normalizedRegistry = normalizeRegistry(registry);
    const token = await resolveNpmRegistryAuthToken({
      registry: normalizedRegistry,
      cwd,
      exec: execFile,
      env: process.env,
    });
    const userConfig = join(cwd, '.release-skill-npmrc');
    await writeFile(
      userConfig,
      `registry=${normalizedRegistry}/\n${registryTokenKey(normalizedRegistry)}=${token}\n`,
      { encoding: 'utf8', mode: 0o600 },
    );
    const env = { ...process.env };
    for (const name of [
      'NPM_TOKEN', 'NODE_AUTH_TOKEN',
      'NPM_CONFIG_REGISTRY', 'npm_config_registry',
      'NPM_CONFIG_USERCONFIG', 'npm_config_userconfig',
    ]) delete env[name];
    try {
      await execFile('npm', [
        'install', packageAtVersion,
        ...flags,
        '--userconfig', userConfig,
      ], {
        cwd,
        env,
        shell: false,
        encoding: 'utf8',
        timeout: 60_000,
      });
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    } finally {
      await rm(userConfig, { force: true }).catch(() => {});
    }
  },
  async runBin(binPath, args = [], options = {}) {
    return execFile(process.execPath, [binPath, ...args], {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      encoding: 'utf8',
      timeout: 30_000,
    });
  },
};

// ---------------------------------------------------------------------------
// Distribute run discovery
// ---------------------------------------------------------------------------

/**
 * Discover sibling distribute runs from the same planDigest within .release-skill/runs.
 * Only accept verified, non-symbolic-link directories matching distribute-* prefix.
 */
async function discoverDistributeRuns({ planPath, plan }) {
  const planDir = dirname(planPath);
  const releaseDir = basename(planDir) === 'plans' ? dirname(planDir) : planDir;
  const runsDir = resolve(releaseDir, 'runs');
  
  try {
    const runsDirStat = await lstat(runsDir);
    if (runsDirStat.isSymbolicLink()) {
      throw new ReleaseError(
        GATE_FAILED,
        'runs directory is a symbolic link; authority identity compromised',
        { runsDir },
      );
    }
    if (!runsDirStat.isDirectory()) {
      throw new ReleaseError(
        GATE_FAILED,
        'runs path is not a directory',
        { runsDir },
      );
    }
    
    const runsDirReal = realpathSync(runsDir);
    const authorityDirReal = realpathSync(releaseDir);
    if (!runsDirReal.startsWith(authorityDirReal + '/') && runsDirReal !== authorityDirReal) {
      throw new ReleaseError(
        GATE_FAILED,
        'runs directory is not a real child of the plan authority directory',
        { runsDir, runsDirReal, authorityDirReal },
      );
    }
  } catch (err) {
    if (err instanceof ReleaseError) throw err;
    // runs directory doesn't exist — this is okay for optional distribution
    return null;
  }
  
  const candidates = [];
  const entries = await readdir(runsDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.name.startsWith('distribute-')) continue;
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      throw new ReleaseError(
        GATE_FAILED,
        'distribute-* candidate is a symbolic link or not a directory; authority identity compromised',
        { entry: entry.name, runsDir },
      );
    }
    const candidateDir = resolve(runsDir, entry.name);
    const candidateStat = await lstat(candidateDir).catch(() => null);
    if (!candidateStat || candidateStat.isSymbolicLink()) {
      throw new ReleaseError(
        GATE_FAILED,
        'distribute-* candidate is a symbolic link; authority identity compromised',
        { candidateDir, runsDir },
      );
    }
    const candidateReal = realpathSync(candidateDir);
    if (!candidateReal.startsWith(runsDir + '/') && candidateReal !== runsDir) {
      throw new ReleaseError(
        GATE_FAILED,
        'distribute-* candidate real path is not contained in authority runs directory',
        { candidateDir, candidateReal, runsDir },
      );
    }
    const candidatePath = resolve(candidateDir, 'release-run.json');
    try {
      const candidate = await loadRun(candidatePath, { requireDigest: true });
      if (candidate.command !== 'distribute') continue;
      if (!candidate.planDigest) continue;
      if (candidate.planDigest !== plan.digest) continue;
      candidates.push(candidate);
    } catch {
      // Skip invalid candidates silently
      continue;
    }
  }
  
  return candidates;
}

/**
 * Evaluate one distribute run against the verify distribute gate
 * (v0.6.3 R1, design §2.4/§2.7).
 *
 * Semantics:
 * - A DISTRIBUTED run passes outright (no warning).
 * - A PARTIAL run passes only when EVERY checkpoint that is not
 *   succeeded/skipped is a FAILED `postpublish-hook` checkpoint whose hook
 *   declaration in the frozen plan explicitly downgrades with
 *   `blocksVerified: false` (default true). Each such downgrade is reported
 *   as a warning exemption — prominently evidenced, never silent.
 * - AWAITING_APPROVAL checkpoints never pass (the checkpoint approval is
 *   still missing), and target/mirror checkpoints are never exemptable.
 * - Any other run status (BLOCKED / NEEDS_INPUT / ...) never passes, per the
 *   governance rule that NEEDS_INPUT/BLOCKED cannot silently become VERIFIED.
 *
 * @param {Object} run - A distribute run record (checkpoints + status).
 * @param {Object} plan - The frozen release plan (postPublish.hooks source).
 * @returns {{ pass: boolean, warned: boolean, exemptions: Object[] }}
 */
export function evaluateDistributeGateRun(run, plan) {
  if (!run || typeof run !== 'object') return { pass: false, warned: false, exemptions: [] };
  if (run.status === 'DISTRIBUTED') return { pass: true, warned: false, exemptions: [] };
  if (run.status !== 'PARTIAL') return { pass: false, warned: false, exemptions: [] };

  const hooksById = new Map(((plan?.postPublish?.hooks ?? [])).map((hook) => [hook.id, hook]));
  const exemptions = [];
  for (const checkpoint of run.checkpoints ?? []) {
    if (checkpoint.status === 'succeeded' || checkpoint.status === 'skipped') continue;
    const hook = checkpoint.actionType === 'postpublish-hook'
      ? hooksById.get(checkpoint.actionId)
      : undefined;
    if (hook && checkpoint.status === 'failed' && hook.blocksVerified === false) {
      exemptions.push({ actionId: checkpoint.actionId, status: checkpoint.status });
      continue;
    }
    return { pass: false, warned: false, exemptions: [] };
  }
  return { pass: true, warned: exemptions.length > 0, exemptions };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Post-publish verification of a release.
 *
 * @param {Object} options
 * @param {string} options.planPath - Absolute path to the frozen release plan.
 * @param {string} options.sourceRunPath - Absolute path to the source run
 *   file, or to its containing run directory (resolved to release-run.json; O6).
 * @param {Object} options.adapterRegistry - Adapter registry for verification.
 * @param {string} [options.root] - Project root for source access.
 * @param {string} [options.runDir] - Evidence directory.
 * @param {() => string} [options.clock] - Clock function returning ISO-8601 strings.
 * @param {Object} [options.previousVerifyRun] - 上一次验证成功的 verify run 记录，用于安装契约摘要免验。
 *
 * @returns {Promise<{ planPath: string, status: string, adapterChecks: Object[], smokeTest: Object }>}
 *
 * @throws {ReleaseError} GATE_FAILED on safety gate failures.
 * @throws {ReleaseError} POST_PUBLISH_VERIFY_FAILED if any verification fails.
 */
export async function verifyRelease(options) {
  const {
    planPath,
    sourceRunPath,
    adapterRegistry,
    root = process.cwd(),
    runDir: runDirOpt,
    clock: clockOpt,
    npmExecutor,
    verificationGatesAuthorized: _verificationGatesAuthorized,
    gateEnv,
    previousVerifyRun,
    execFn,
    configPath: configPathOpt,
  } = options ?? {};

  const clockFn = typeof clockOpt === 'function' ? clockOpt : defaultClock;

  // --- Gate: sourceRunPath is required ---
  if (!sourceRunPath) {
    throw new ReleaseError(
      GATE_FAILED,
      'verify requires a source run path (--run)',
      { parameter: 'sourceRunPath' },
    );
  }

  // O6: --run accepts a run directory as well as the run file. Resolve a
  // directory to its release-run.json before any load/lineage/authority step;
  // a file input passes through unchanged (compat).
  const resolvedSourceRunPath = await resolveRunPath(sourceRunPath);

  // Load and validate the plan before creating any evidence directory. A
  // production plan grants authority only to a fresh direct child of its
  // sibling .release-skill/runs directory.
  let planRaw;
  try {
    planRaw = await readFile(planPath, 'utf8');
  } catch (err) {
    throw new ReleaseError(
      GATE_FAILED,
      `cannot read release plan: ${err.message}`,
      { planPath, cause: err.code },
    );
  }

  let plan;
  try {
    plan = JSON.parse(planRaw);
  } catch (err) {
    throw new ReleaseError(
      GATE_FAILED,
      `release plan is not valid JSON: ${err.message}`,
      { planPath },
    );
  }
  validatePlan(plan);
  if (plan.production?.mode === 'github-npm-v1' && !plan.sourceAuthority) {
    throw new ReleaseError(
      CONFIG_MISSING,
      'production verify requires a frozen sourceAuthority binding; the release must be re-prepared before publish',
      { gate: 'source-authority' },
    );
  }

  // --- Set up directories ---
  const runId = `verify-${Date.now()}`;
  const requestedRunDir = runDirOpt ?? resolveDefaultRunDir(planPath, 'verify', runId);
  const runDir = plan.production
    ? await createProductionRunDir(requestedRunDir, planPath)
    : requestedRunDir;
  if (!plan.production) await mkdir(runDir, { recursive: true });

  const evidence = createEvidenceWriter({ runDir, command: 'verify', clock: clockFn });

  try {
    // =======================================================================
    // Step 1: Load and validate release plan
    // =======================================================================
    await evidence.append({ phase: 'verify', step: 'plan-load', status: 'started' });

    const consumerGates = (plan.verificationGates ?? []).filter((gate) => gate.phase === 'consumer-verify');
    const configuredSmokeBins = (plan.units ?? []).flatMap((unit) => (
      (unit.distributions ?? [])
        .filter((distribution) => distribution.type === 'npm' && distribution.smokeBin)
        .map((distribution) => ({ unitId: unit.id, smokeBin: distribution.smokeBin }))
    ));
    // The command invocation itself authorizes execution of configured
    // verification gates and smoke processes. Old --acknowledge-gate-side-effects
    // is accepted as a no-effect compatibility input.

    await evidence.append({ phase: 'verify', step: 'plan-load', status: 'passed' });

    // =======================================================================
    // Step 2: Load and validate source run
    // =======================================================================
    await evidence.append({ phase: 'verify', step: 'source-run-load', status: 'started' });

    const sourceRun = await loadRun(resolvedSourceRunPath, {
      requireDigest: Boolean(plan.production),
      ...(plan.production ? { authorityPlanPath: planPath } : {}),
    });
    await validateRunLineage(sourceRun, {
      plan,
      planPath,
      runPath: resolvedSourceRunPath,
      production: Boolean(plan.production),
    });

    // Only accept source runs from publish or reconcile commands
    if (sourceRun.command !== 'publish' && sourceRun.command !== 'reconcile') {
      throw new ReleaseError(
        GATE_FAILED,
        `verify only accepts source runs from publish or reconcile; source run command is "${sourceRun.command}"`,
        { sourceRunCommand: sourceRun.command, sourceRunId: sourceRun.runId },
      );
    }

    // VERIFIED is terminal: verification may only promote PUBLISHED once.
    if (sourceRun.status !== 'PUBLISHED') {
      throw new ReleaseError(
        GATE_FAILED,
        `cannot verify: source run status is "${sourceRun.status}"; expected PUBLISHED (VERIFIED is terminal)`,
        { sourceRunStatus: sourceRun.status },
      );
    }

    // =======================================================================
    // Step 2b: Check for postPublish distribution requirement.
    // v0.6.3 R1: the gate triggers on targets OR hooks declarations, and a
    // PARTIAL distribute run passes only through the blocksVerified:false
    // exemption path (evaluateDistributeGateRun) — warned, never silent.
    // =======================================================================
    const declaredPostPublishTargets = plan.postPublish?.targets ?? [];
    const declaredPostPublishHooks = plan.postPublish?.hooks ?? [];
    if (plan.postPublish
      && (declaredPostPublishTargets.length > 0 || declaredPostPublishHooks.length > 0)) {
      await evidence.append({ phase: 'verify', step: 'distribute-run-discovery', status: 'started' });

      const distributeCandidates = await discoverDistributeRuns({ planPath, plan }) ?? [];

      let gateRun = distributeCandidates.find((c) => c.status === 'DISTRIBUTED') ?? null;
      let gateVerdict = gateRun ? { pass: true, warned: false, exemptions: [] } : null;
      if (!gateRun) {
        for (const candidate of distributeCandidates) {
          const verdict = evaluateDistributeGateRun(candidate, plan);
          if (verdict.pass) {
            gateRun = candidate;
            gateVerdict = verdict;
            break;
          }
        }
      }

      await evidence.append({
        phase: 'verify',
        step: 'distribute-run-discovery',
        status: 'checked',
        foundCandidate: Boolean(gateRun),
        distributeRunPath: gateRun?.runPath ?? null,
      });

      if (!gateRun) {
        throw new ReleaseError(
          GATE_FAILED,
          `distribution required by plan.postPublish but no DISTRIBUTED (or blocksVerified-exempted) distribute run found; run release-skill distribute --plan ${planPath} --root ${root}`,
          { requiredDistribution: true, evidenceEvent: 'distribute-run-missing' },
        );
      }

      if (gateVerdict.warned) {
        await evidence.append({
          phase: 'verify',
          step: 'distribute-gate',
          status: 'warning',
          warning: 'blocksVerified:false postPublish hook failure exempted; VERIFIED proceeds with a downgrade warning',
          exemptions: gateVerdict.exemptions,
          distributeRunPath: gateRun.runPath ?? null,
        });
      }
    }

    if (plan.production) {
      if (!sourceRun.approvalPath || !sourceRun.approvalDigest) {
        throw new ReleaseError(
          GATE_FAILED,
          'production verify requires immutable approvalPath and approvalDigest on the source run',
        );
      }
      let approvalRaw;
      try {
        approvalRaw = await readFile(sourceRun.approvalPath, 'utf8');
      } catch (error) {
        throw new ReleaseError(
          GATE_FAILED,
          `cannot read source run approval authority: ${error.message}`,
        );
      }
      let approval;
      try {
        approval = JSON.parse(approvalRaw);
      } catch (error) {
        throw new ReleaseError(GATE_FAILED, `source run approval is not valid JSON: ${error.message}`);
      }
      validateApprovalRecordSchema(approval);
      const approvalDigest = assertImmutableApprovalAuthority(
        sourceRun.approvalPath,
        plan,
        approvalRaw,
      );
      if (approvalDigest !== sourceRun.approvalDigest) {
        throw new ReleaseError(
          GATE_FAILED,
          'source run approvalDigest does not match immutable approval bytes',
        );
      }
      validateApproval(plan, approval, { clock: clockFn, requireUnexpired: false });
    }

    // Validate plan action completeness before checkpoint mapping
    // Use legacyCompatibility: old plans (pre-v0.1.5) lack
    // parameters.timeoutMs. Verify must still pass these plans,
    // while strict mode (prepare/approve/publish) rejects them.
    const completenessResult = validatePlanActionCompleteness(plan, { legacyCompatibility: true });
    if (!completenessResult.passed) {
      throw new ReleaseError(
        GATE_FAILED,
        `plan action completeness gate failed: ${completenessResult.details.failures.join('; ')}`,
        { failures: completenessResult.details.failures },
      );
    }

    // Validate checkpoint mapping
    validateRunCheckpointMapping(sourceRun, plan.externalActions ?? []);

    // --- Source authority receipt verification ---
    // If the plan declares sourceAuthority, the source publish run must
    // contain a matching CONSISTENT receipt bound to this planDigest.
    if (plan.sourceAuthority) {
      await evidence.append({ phase: 'source-authority-receipt', status: 'started' });

      const receiptResult = verifySourceAuthorityReceipt({ plan, run: sourceRun });
      if (!receiptResult.passed) {
        await evidence.append({
          phase: 'source-authority-receipt',
          status: 'failed',
          reason: receiptResult.reason,
        });
        throw new ReleaseError(
          GATE_FAILED,
          `source authority receipt verification failed: ${receiptResult.reason}`,
          { reason: receiptResult.reason },
        );
      }

      await evidence.append({ phase: 'source-authority-receipt', status: 'passed' });
    }

    // All checkpoints must be succeeded or skipped (no failed/pending),
    // except marketplace install checkpoints which are re-verified by verify
    // itself via consumer verification (human attestation or automatic).
    // Deferred marketplace checkpoints from publish are also allowed through.
    const incompleteCheckpoints = sourceRun.checkpoints.filter(
      (cp) => cp.status !== 'succeeded' && cp.status !== 'skipped'
        && !((cp.status === 'failed' || cp.status === 'deferred') && isMarketplaceAction(cp.actionType)),
    );
    if (incompleteCheckpoints.length > 0) {
      throw new ReleaseError(
        GATE_FAILED,
        `cannot verify: source run has ${incompleteCheckpoints.length} incomplete checkpoint(s): ${incompleteCheckpoints.map((cp) => `${cp.actionId}=${cp.status}`).join(', ')}`,
        { incompleteCheckpoints: incompleteCheckpoints.map((cp) => ({ actionId: cp.actionId, status: cp.status })) },
      );
    }

    await evidence.append({
      phase: 'verify',
      step: 'source-run-load',
      status: 'passed',
      sourceRunId: sourceRun.runId,
    });

    // =======================================================================
    // Step 3: Verify all actions via adapters
    //
    // Marketplace actions (claude-marketplace-install, codex-marketplace-install,
    // kimi-marketplace-install)
    // are verified as fresh, isolated consumer installs in verify's own runDir.
    // This ensures verify does not read the publish run's consumer install
    // directories or evidence.
    //
    // Non-marketplace actions use read-only adapter.verify().
    // =======================================================================
    await evidence.append({ phase: 'verify', step: 'adapter-verify', status: 'started' });

    const adapterChecks = [];
    const consumerGateResults = [];
    const consumerVerificationReceipts = [];
    const actions = plan.externalActions ?? [];

    // --- 自动发现可信消费端验证收据 ---
    // 收据选择逻辑（per-action 从所有候选中选最新匹配）：
    // - 只读取同一权威 .release-skill/runs 的真实直接子目录
    // - runs 根或候选目录不得是符号链接，不得物理越界
    // - 候选必须经 loadRun(..., { requireDigest: true })、状态 VERIFIED、合法 finishedAt
    // - 对当前 action 收集所有可信匹配收据，按 finishedAt 最新选择
    // - 收据必须是 consumerVerificationReceipts，严格匹配 actionId/unitId/platform
    // - 收据 planDigest 等于候选 run 自身 planDigest
    // - 显式注入的 previousVerifyRun 也必须经过同等语义校验

    /** @type {Array<Object>} 所有可信的验证 run 候选 */
    const trustedVerifyRuns = [];

    // 计算权威 runs 目录路径（基于 plan 的物理位置）
    const planDir = dirname(planPath);
    const releaseDir = basename(planDir) === 'plans' ? dirname(planDir) : planDir;
    const runsDir = resolve(releaseDir, 'runs');
    let runsDirReal = null;
    let authorityDirReal = null;

    // 校验并纳入显式注入的 previousVerifyRun
    // 必须经过完整语义校验：status=VERIFIED、合法 runDigest、合法 finishedAt、
    // 合法 planDigest、收据身份绑定。不满足则不注入（不参与复用），但不阻断。
    if (previousVerifyRun) {
      if (
        previousVerifyRun.status === 'VERIFIED'
        && isValidDigest(previousVerifyRun.planDigest)
        && previousVerifyRun.finishedAt
        && typeof previousVerifyRun.finishedAt === 'string'
        && !isNaN(Date.parse(previousVerifyRun.finishedAt))
      ) {
        const computedRunDigest = computeRunDigest(previousVerifyRun);
        if (
          typeof previousVerifyRun.runDigest === 'string'
          && previousVerifyRun.runDigest.length > 0
          && previousVerifyRun.runDigest === computedRunDigest
        ) {
          trustedVerifyRuns.push(previousVerifyRun);
        }
      }
    }

    // 自动发现：从同一 .release-skill/runs 权威目录中发现
    {
      try {
        const runsDirStat = await lstat(runsDir);
        if (runsDirStat.isSymbolicLink()) {
          // runs 根是符号链接：权威目录身份错误，失败关闭
          throw new ReleaseError(
            GATE_FAILED,
            'runs directory is a symbolic link; authority identity compromised',
            { runsDir },
          );
        }
        if (!runsDirStat.isDirectory()) {
          throw new ReleaseError(
            GATE_FAILED,
            'runs path is not a directory',
            { runsDir },
          );
        }
        // 以 plan 的物理权威目录为基准，验证 runs 是其中真实 runs 子目录
        runsDirReal = realpathSync(runsDir);
        authorityDirReal = realpathSync(releaseDir);
        if (!runsDirReal.startsWith(authorityDirReal + '/') && runsDirReal !== authorityDirReal) {
          throw new ReleaseError(
            GATE_FAILED,
            'runs directory is not a real child of the plan authority directory',
            { runsDir, runsDirReal, authorityDirReal },
          );
        }
      } catch (err) {
        if (err instanceof ReleaseError) throw err;
        // runs 目录不存在等非致命情况：跳过自动发现
        runsDirReal = null;
      }

      if (runsDirReal) {
        const entries = await readdir(runsDirReal, { withFileTypes: true });
        for (const entry of entries) {
          if (!entry.name.startsWith('verify-')) continue;
          // 非目录或符号链接：失败关闭
          if (!entry.isDirectory() || entry.isSymbolicLink()) {
            throw new ReleaseError(
              GATE_FAILED,
              'verify-* candidate is a symbolic link or not a directory; authority identity compromised',
              { entry: entry.name, runsDir: runsDirReal },
            );
          }
          const candidateDir = resolve(runsDirReal, entry.name);
          const candidateStat = await lstat(candidateDir).catch(() => null);
          if (!candidateStat || candidateStat.isSymbolicLink()) {
            throw new ReleaseError(
              GATE_FAILED,
              'verify-* candidate is a symbolic link; authority identity compromised',
              { candidateDir, runsDir: runsDirReal },
            );
          }
          // realpath 包含性校验：候选必须在权威 runs 目录内
          const candidateReal = realpathSync(candidateDir);
          if (!candidateReal.startsWith(runsDirReal + '/') && candidateReal !== runsDirReal) {
            throw new ReleaseError(
              GATE_FAILED,
              'verify-* candidate real path is not contained in authority runs directory',
              { candidateDir, candidateReal, runsDir: runsDirReal },
            );
          }
          const candidatePath = resolve(candidateDir, 'release-run.json');
          try {
            const candidate = await loadRun(candidatePath, { requireDigest: true });
            if (candidate.status !== 'VERIFIED') continue;
            if (!candidate.planDigest) continue;
            if (!candidate.finishedAt || typeof candidate.finishedAt !== 'string') continue;
            trustedVerifyRuns.push(candidate);
          } catch {
            // 真实直接目录里的坏/缺 release-run.json 可忽略
            continue;
          }
        }
      }
    }

    // When the plan declares humanConsumersStrategy: 'manualFollowUps',
    // Kimi/CodeBuddy installations are non-blocking post-release manual tasks.
    // Skip attestation collection and blocking for these platforms.
    const isHumanConsumerFollowUp = plan.humanConsumersStrategy === 'manualFollowUps';

    const missingManualAttestations = isHumanConsumerFollowUp
      ? []
      : await collectMissingManualAttestations({
          actions,
          adapterRegistry,
          plan,
          root,
          runDir,
          clockFn,
        });
    if (missingManualAttestations.length > 0) {
      await evidence.append({
        phase: 'verify',
        step: 'manual-attestations',
        status: 'needs-input',
        requirements: missingManualAttestations,
      });
      throw new ReleaseError(
        CONSUMER_VERIFICATION_DEFERRED,
        `${missingManualAttestations.length} manual consumer attestation(s) are required`,
        { requirements: missingManualAttestations },
      );
    }

    // Collect non-blocking manual follow-up tasks for human consumer platforms
    const manualFollowUps = [];

    // Every action is identity-bound and adapters receive read-only or
    // per-action isolated consumer paths. Run independent checks concurrently;
    // the evidence writer serializes append operations and result arrays are
    // sorted afterwards for deterministic receipts.
    const actionResults = await Promise.allSettled(actions.map(async (action) => {
      const adapterActionType = ADAPTER_ACTION_TYPE_MAP[action.type];

      // Skip meta-checkpoints
      if (!adapterActionType) {
        adapterChecks.push({
          actionId: action.id,
          actionType: action.type,
          status: 'SKIPPED',
          reason: 'meta-checkpoint',
        });
        return;
      }

      let adapter;
      try {
        adapter = adapterRegistry.getAdapter(adapterActionType);
      } catch {
        // Missing adapter for a verified action => structured failure (not silent SKIPPED)
        throw new ReleaseError(
          POST_PUBLISH_VERIFY_FAILED,
          `no adapter registered for action type "${adapterActionType}" (plan action "${action.id}")`,
          { actionId: action.id, adapterActionType },
        );
      }

      if (isMarketplaceAction(action.type)) {
        // When humanConsumersStrategy is 'manualFollowUps', Kimi/CodeBuddy
        // installations are non-blocking manual follow-up tasks. Skip adapter
        // processing and collect them as manualFollowUps.
        const isHumanConsumerPlatform = action.type === 'kimi-marketplace-install'
          || action.type === 'codebuddy-marketplace-install';
        if (isHumanConsumerFollowUp && isHumanConsumerPlatform) {
          const platform = action.type === 'kimi-marketplace-install' ? 'kimi' : 'codebuddy';
          manualFollowUps.push({
            actionId: action.id,
            platform,
            plugin: action.parameters?.plugin,
            version: action.parameters?.version,
            unitId: action.unitId,
            verifiedBySystem: false,
            reason: 'human consumer platform — installation is a manual post-release task; not verified by system',
          });
          adapterChecks.push({
            actionId: action.id,
            actionType: action.type,
            status: 'SKIPPED',
            reason: 'manual-follow-up',
          });
          await evidence.append({
            phase: 'verify-marketplace',
            actionId: action.id,
            actionType: action.type,
            status: 'SKIPPED',
            reason: 'manual-follow-up',
          });
          return;
        }

        // --- Marketplace: fresh consumer verification in verify's own runDir ---
        // Context: isolatedConsumerWritesAuthorized allows writing to verify's
        // runDir/consumers/ directory; externalWritesAuthorized stays false.
        const marketplaceContext = {
          externalWritesAuthorized: false,
          isolatedConsumerWritesAuthorized: true,
          plan,
          baseline: plan.baseline,
          root,
          runDir,
        };

        const actionInput = {
          actionType: adapterActionType,
          ...action.parameters,
        };

        // --- 安装契约摘要免验检查 ---
        // 从计划中读取冻结的安装契约摘要。
        // 新计划在 prepare 阶段计算并冻结 installationContractDigest；
        // 旧计划（无此字段）跳过免验检查，强制重新验证。
        const unit = (plan.units ?? []).find((u) => u.id === action.unitId);
        const typeToDist = {
          'claude-marketplace-install': 'claude-plugin',
          'codex-marketplace-install': 'codex-plugin',
          'kimi-marketplace-install': 'kimi-plugin',
          'codebuddy-marketplace-install': 'codebuddy-plugin',
        };
        const dist = unit?.distributions?.find((d) => d.type === typeToDist[action.type]);

        // Step 3a: Preflight（始终先执行 adapter preflight，完成静态身份、版本、
        // tag/ref/sha、来源和 payload 校验；只有 preflight 通过后才允许免验）
        // 必须明确要求 PREFLIGHT_PASSED，其他状态全部失败关闭。
        const preflightResult = await adapter.preflight(actionInput, marketplaceContext);
        if (preflightResult.status !== 'PREFLIGHT_PASSED') {
          adapterChecks.push({
            actionId: action.id,
            actionType: action.type,
            status: 'FAILED',
            error: `preflight did not pass: status=${preflightResult.status}, error=${preflightResult.error}`,
          });
          throw new ReleaseError(
            POST_PUBLISH_VERIFY_FAILED,
            `marketplace preflight did not pass for action "${action.id}": status=${preflightResult.status}, error=${preflightResult.error}`,
            { actionId: action.id },
          );
        }

        // Preflight 通过后，检查是否可以免验
        if (dist?.installationContractDigest) {
          const currentDigest = dist.installationContractDigest;
          const currentPlatform = action.parameters?.consumer ?? action.type.replace('-marketplace-install', '');

          // 紧邻可信公开基线：只检查最近一个 VERIFIED run 的收据。
          // 不能从任意更老历史中捞出相同摘要来免验。
          // 若最近 run 无该 action/platform 的收据，则 REQUIRE_VERIFICATION。
          let previousActionCheck = null;
          if (trustedVerifyRuns.length > 0) {
            // 按 finishedAt 降序排序，取最近一个
            const sorted = [...trustedVerifyRuns].sort((a, b) => {
              const ta = Date.parse(a.finishedAt) || 0;
              const tb = Date.parse(b.finishedAt) || 0;
              return tb - ta;
            });
            const latest = sorted[0];
            const matchingReceipt = (latest.consumerVerificationReceipts ?? []).find(
              (r) => r.actionId === action.id
                && r.unitId === action.unitId
                && r.platform === currentPlatform
                && r.planDigest === latest.planDigest,
            );
            if (matchingReceipt) {
              previousActionCheck = { ...matchingReceipt, _runFinishedAtTime: Date.parse(latest.finishedAt) };
            }
          }
          const previousDigest = previousActionCheck?.installationContractDigest ?? null;

          const skipDecision = shouldSkipVerification({
            currentDigest,
            previousDigest,
            previousReceipt: previousActionCheck,
            algorithmVersion: INSTALLATION_CONTRACT_ALGORITHM_VERSION,
          });

          // A current-run resource-closure receipt requires a fresh isolated
          // install. Installation-contract reuse alone cannot prove the
          // installed Skill resources are reachable.
          if (skipDecision === 'NOT_REQUIRED_UNCHANGED' && !plan.skillResourceClosure) {
            adapterChecks.push({
              actionId: action.id,
              actionType: action.type,
              status: VERIFICATION_RESOLVED_TYPES.NOT_REQUIRED_UNCHANGED,
              installationContractDigest: currentDigest,
              reason: '安装契约摘要未变化，跳过验证',
            });

            consumerVerificationReceipts.push({
              actionId: action.id,
              unitId: action.unitId,
              platform: action.parameters?.consumer ?? action.type.replace('-marketplace-install', ''),
              result: VERIFICATION_RESOLVED_TYPES.NOT_REQUIRED_UNCHANGED,
              installationContractDigest: currentDigest,
              algorithmVersion: INSTALLATION_CONTRACT_ALGORITHM_VERSION,
              planDigest: plan.digest,
              verifiedAt: clockFn(),
            });

            await evidence.append({
              phase: 'verify-marketplace',
              actionId: action.id,
              actionType: action.type,
              status: VERIFICATION_RESOLVED_TYPES.NOT_REQUIRED_UNCHANGED,
              installationContractDigest: currentDigest,
            });

            return;
          }
        }

        // Step 3b: Execute (install to isolated consumer directory)
        const executeResult = await adapter.execute(actionInput, marketplaceContext);
        if (executeResult.status !== 'EXECUTED') {
          adapterChecks.push({
            actionId: action.id,
            actionType: action.type,
            status: 'FAILED',
            error: `execute failed: ${executeResult.error}`,
          });
          throw new ReleaseError(
            POST_PUBLISH_VERIFY_FAILED,
            `marketplace execute failed for action "${action.id}": ${executeResult.error}`,
            { actionId: action.id },
          );
        }

        // Step 3c: Verify (observe + match against plan expected state)
        const verifyResult = await adapter.verify(
          { ...actionInput, expected: action.expected },
          marketplaceContext,
        );

        // 正确分类：人工确认 -> PASSED_MANUAL，其他自动通路 -> PASSED_AUTOMATIC
        const isHumanConfirmed = verifyResult.observation?.humanConfirmed === true;
        const resolvedStatus = verifyResult.status === 'VERIFIED'
          ? (isHumanConfirmed
            ? VERIFICATION_RESOLVED_TYPES.PASSED_MANUAL
            : VERIFICATION_RESOLVED_TYPES.PASSED_AUTOMATIC)
          : 'FAILED';

        const check = {
          actionId: action.id,
          actionType: action.type,
          status: resolvedStatus,
          observation: verifyResult.observation,
          error: verifyResult.error,
          ...(dist?.installationContractDigest ? { installationContractDigest: dist.installationContractDigest } : {}),
        };
        adapterChecks.push(check);

        // 持久化消费端验证收据
        // 旧计划无摘要时可不生成"安装契约复用收据"，但不得写非法空字符串
        if (resolvedStatus !== 'FAILED' && dist?.installationContractDigest && /^[a-f0-9]{64}$/.test(dist.installationContractDigest)) {
          consumerVerificationReceipts.push({
            actionId: action.id,
            unitId: action.unitId,
            platform: action.parameters?.consumer ?? action.type.replace('-marketplace-install', ''),
            result: resolvedStatus,
            installationContractDigest: dist.installationContractDigest,
            algorithmVersion: INSTALLATION_CONTRACT_ALGORITHM_VERSION,
            planDigest: plan.digest,
            verifiedAt: clockFn(),
          });
        }

        await evidence.append({
          phase: 'verify-marketplace',
          actionId: action.id,
          actionType: action.type,
          status: check.status,
        });

        if (check.status === 'FAILED') {
          throw new ReleaseError(
            POST_PUBLISH_VERIFY_FAILED,
            `marketplace verification failed for action "${action.id}": ${verifyResult.error}`,
            {
              actionId: action.id,
              actionType: action.type,
              verificationResult: check.status,
              observation: verifyResult.observation,
              expected: action.expected,
            },
          );
        }

        const distribution = action.type === 'claude-marketplace-install'
          ? 'claude-plugin'
          : action.type === 'codex-marketplace-install'
            ? 'codex-plugin'
            : action.type === 'codebuddy-marketplace-install'
              ? 'codebuddy-plugin'
              : 'kimi-plugin';
        const installPath = verifyResult.observation?.installPath;
        consumerGateResults.push(...await runConsumerVerificationGates({
          plan,
          unitId: action.unitId,
          distribution,
          executionRoot: installPath,
          evidence,
          env: gateEnv ?? process.env,
          fixedEnv: action.type === 'claude-marketplace-install'
            ? {
                HOME: resolve(runDir, 'consumers', `claude-${action.parameters.plugin}`),
                CLAUDE_CONFIG_DIR: resolve(runDir, 'consumers', `claude-${action.parameters.plugin}`, '.claude'),
              }
            : action.type === 'codex-marketplace-install'
              ? {
                  HOME: resolve(runDir, 'consumers', `codex-${action.parameters.plugin}`),
                  CODEX_HOME: resolve(runDir, 'consumers', `codex-${action.parameters.plugin}`),
                }
              : action.type === 'codebuddy-marketplace-install'
                ? {
                    HOME: resolve(runDir, 'consumers', `codebuddy-${action.parameters.plugin}`),
                  }
                : {
                    HOME: resolve(runDir, 'consumers', `kimi-${action.parameters.plugin}`),
                  },
        }));
      } else {
        // --- Non-marketplace: read-only adapter.verify() ---
        const context = {
          externalWritesAuthorized: false,
          plan,
          baseline: plan.baseline,
          root,
          runDir,
        };

        const verifyResult = await adapter.verify(
          {
            actionType: adapterActionType,
            ...action.parameters,
            expected: action.expected,
          },
          context,
        );

        const check = {
          actionId: action.id,
          actionType: action.type,
          status: verifyResult.status === 'VERIFIED' ? VERIFICATION_RESOLVED_TYPES.PASSED_AUTOMATIC : 'FAILED',
          observation: verifyResult.observation,
          error: verifyResult.error,
        };

        adapterChecks.push(check);

        await evidence.append({
          phase: 'verify-adapter',
          actionId: action.id,
          actionType: action.type,
          status: check.status,
        });

        if (check.status === 'FAILED') {
          throw new ReleaseError(
            POST_PUBLISH_VERIFY_FAILED,
            `adapter verification failed for action "${action.id}": ${verifyResult.error}`,
            {
              actionId: action.id,
              actionType: action.type,
              verificationResult: check.status,
              observation: verifyResult.observation,
              expected: action.expected,
            },
          );
        }
      }
    }));
    adapterChecks.sort((a, b) => a.actionId.localeCompare(b.actionId));
    consumerVerificationReceipts.sort((a, b) => a.actionId.localeCompare(b.actionId));
    consumerGateResults.sort((a, b) => a.id.localeCompare(b.id));
    const rejectedAction = actionResults.find((result) => result.status === 'rejected');
    if (rejectedAction) throw rejectedAction.reason;

    await evidence.append({ phase: 'verify', step: 'adapter-verify', status: 'completed' });

    if (plan.publicSourceAuthorityReceipt) {
      const consumed = await verifyPublicSourceAuthorityReceiptOffline({ plan, root });
      await evidence.append({
        phase: 'public-source-authority-receipt',
        status: 'passed',
        verificationMode: 'offline-consumer',
        sourceRepository: consumed.sourceRepository,
        sourceBaseCommit: consumed.sourceBaseCommit,
        subjectCount: consumed.subjects.length,
        assetSha256: consumed.sha256,
      });
    }

    // =======================================================================
    // Step 4: Installation smoke test
    // =======================================================================
    await evidence.append({ phase: 'verify', step: 'smoke-test', status: 'started' });

    let smokeTest;
    try {
      smokeTest = await runSmokeTest(plan, root, {
        npmExecutor,
        baseDir: runDir,
        evidence,
        gateEnv: gateEnv ?? process.env,
      });
    } catch (err) {
      smokeTest = { passed: false, details: { error: err.message } };
    }

    await evidence.append({
      phase: 'verify',
      step: 'smoke-test',
      status: smokeTest.passed ? 'passed' : 'failed',
      details: smokeTest.details,
    });

    if (!smokeTest.passed) {
      throw new ReleaseError(
        POST_PUBLISH_VERIFY_FAILED,
        `installation smoke test failed: ${smokeTest.details.error}`,
        { smokeTest: smokeTest.details },
      );
    }

    consumerGateResults.push(...(smokeTest.gateResults ?? []));
    const expectedGateIds = consumerGates.map((gate) => gate.id).sort();
    const observedGateIds = consumerGateResults.map((result) => result.id).sort();
    if (JSON.stringify(expectedGateIds) !== JSON.stringify(observedGateIds)) {
      throw new ReleaseError(
        POST_PUBLISH_VERIFY_FAILED,
        'consumer verification gate execution set does not match the frozen plan',
        { expectedGateIds, observedGateIds },
      );
    }

    // =======================================================================
    // Step 4b: Skill resource closure check on consumer install surfaces
    // Re-run the closure check on each declared consumer install surface.
    // If the plan declares skillResourceClosure, every declared host surface
    // must be checked and pass; undeclared or failed surfaces block VERIFIED.
    // =======================================================================
    const skillResourceClosureReceipts = [
      ...(smokeTest.skillResourceClosureReceipts ?? []),
    ];
    if (plan.skillResourceClosure) {
      await evidence.append({ phase: 'verify', step: 'skill-resource-closure', status: 'started' });

      // Collect install paths from marketplace adapter checks.
      // R-13 P2 (ruling 6): the surface binding is derived from the frozen
      // installation contract at the REAL install coordinates — the same
      // derivation rule prepare and publish use, never a hard-coded '.'.
      // Plans without a frozen installation contract (legacy) fall back to
      // the plugin-root surface ('.') with the legacy permissive checks.
      const installSurfaces = [];
      for (const check of adapterChecks) {
        const platform = PLATFORMS.find((p) => p.actionType === check.actionType);
        if (!platform || !check.observation?.installPath) continue;
        const unitId = actions.find((a) => a.id === check.actionId)?.unitId;
        const unit = (plan.units ?? []).find((u) => u.id === unitId);
        const dist = unit?.distributions?.find((d) => d.type === platform.distributionType);
        let binding = null;
        const contract = dist?.installationContract;
        if (contract?.normalizedManifest) {
          binding = await deriveSurfaceHostBinding({
            manifest: contract.normalizedManifest,
            pluginRoot: pluginRootFromManifestRelativePath(contract.manifestRelativePath),
            platform,
            snapshotDir: check.observation.installPath,
          });
        }
        installSurfaces.push({
          host: await normalizeHostId(platform.buildAdapter.name),
          distribution: platform.distributionType,
          installPath: check.observation.installPath,
          actionId: check.actionId,
          unitId,
          surfaceId: binding?.surfaceId ?? '.',
          binding,
          unit,
        });
      }

      // P2: one physical surface must never be claimed by two hosts across
      // consumer install coordinates (the same rule the checker enforces
      // inside one closure run). Only derived bindings make a claim; the
      // legacy '.' fallback of old plans claims nothing.
      {
        const bindingBySurface = new Map();
        for (const surface of installSurfaces) {
          if (!surface.binding) continue;
          // Relative ids belong to their install roots. Canonicalize the
          // actual directory so aliases and overlapping roots share a key.
          // resolveContained deliberately rejects the root itself ('.').
          const surfacePath = await realpath(surface.surfaceId === '.'
            ? surface.installPath
            : await resolveContained(surface.installPath, surface.surfaceId));
          const prior = bindingBySurface.get(surfacePath);
          if (prior !== undefined && prior !== surface.host) {
            throw new ReleaseError(
              POST_PUBLISH_VERIFY_FAILED,
              `consumer install surfaces claim "${surface.surfaceId}" for multiple hosts: ${prior} and ${surface.host}`,
              { surfaceId: surface.surfaceId, hosts: [prior, surface.host] },
            );
          }
          bindingBySurface.set(surfacePath, surface.host);
        }
      }

      for (const surface of installSurfaces) {
        const closureResult = await checkSkillResourceClosure({
          snapshotDir: surface.installPath,
          host: surface.host,
          surfaceHostBindings: [{ surfaceId: surface.surfaceId, host: surface.host }],
        });

        if (closureResult.findings.length > 0) {
          await evidence.append({
            phase: 'verify',
            step: 'skill-resource-closure',
            status: 'failed',
            host: surface.host,
            findingCount: closureResult.findings.length,
            findings: closureResult.findings,
          });
          throw new ReleaseError(
            POST_PUBLISH_VERIFY_FAILED,
            `skill resource closure check failed for ${surface.host} consumer install: ${closureResult.findings.length} finding(s)`,
            { host: surface.host, findings: closureResult.findings },
          );
        }
        const expectedUnitReceipt = plan.skillResourceClosure.unitReceipts
          .find((item) => item.unitId === surface.unitId);
        if (!expectedUnitReceipt || closureResult.skillCount === 0) {
          throw new ReleaseError(
            POST_PUBLISH_VERIFY_FAILED,
            `skill resource closure installed surface is empty or unbound for ${surface.distribution}`,
            { unitId: surface.unitId, distribution: surface.distribution },
          );
        }
        // P2 (ruling 6): with a derived binding, the install coordinate must
        // reproduce the bound surface (id + host + at least one skill); the
        // frozen contract and the observed install can never silently diverge.
        if (surface.binding) {
          const boundSurface = closureResult.surfaces.find(
            (candidate) => candidate.id === surface.binding.surfaceId,
          );
          if (
            !boundSurface
            || boundSurface.host !== surface.binding.host
            || boundSurface.skillCount < 1
          ) {
            await evidence.append({
              phase: 'verify',
              step: 'skill-resource-closure',
              status: 'failed',
              host: surface.host,
              reason: 'installed-surface-binding-mismatch',
              expectedSurfaceId: surface.binding.surfaceId,
              observedSurfaces: closureResult.surfaces.map((item) => ({
                id: item.id,
                host: item.host,
                skillCount: item.skillCount,
              })),
            });
            throw new ReleaseError(
              POST_PUBLISH_VERIFY_FAILED,
              `skill resource closure surface binding mismatch for ${surface.distribution}: the frozen contract binds "${surface.binding.surfaceId}" to ${surface.binding.host}, but the install coordinate does not reproduce that surface`,
              {
                unitId: surface.unitId,
                distribution: surface.distribution,
                expectedSurfaceId: surface.binding.surfaceId,
                observedSurfaces: closureResult.surfaces.map((item) => ({
                  id: item.id,
                  host: item.host,
                  skillCount: item.skillCount,
                })),
              },
            );
          }
          // For single-plugin units (the root-surface distributions this
          // design covers) the install payload IS the frozen snapshot, so the
          // recomputed receipt must equal the frozen unit receipt field for
          // field (checker version, input digest, surface/skill/reference/
          // finding counts, receipt digest). Record-layer fields (preparedAt,
          // exitCode) are carried from the frozen receipt — the same rule
          // publish's recheck uses.
          const pluginDistCount = (surface.unit?.distributions ?? [])
            .filter((d) => d.type !== 'npm').length;
          if (pluginDistCount === 1) {
            const observedReceipt = createSkillResourceClosureReceipt(closureResult, {
              unitId: surface.unitId,
              preparedAt: expectedUnitReceipt.preparedAt ?? null,
              exitCode: expectedUnitReceipt.exitCode ?? 0,
            });
            assertSkillResourceClosureReceipt(
              expectedUnitReceipt,
              observedReceipt,
              `unit "${surface.unitId}"`,
            );
          }
        }
        skillResourceClosureReceipts.push(createSkillResourceClosureReceipt(
          closureResult,
          {
            host: surface.host,
            distribution: surface.distribution,
            actionId: surface.actionId,
            unitId: surface.unitId,
            checkedAt: clockFn(),
            exitCode: 0,
          },
        ));
      }

      const receiptCoverage = evaluateConsumerSkillResourceClosureReceipts(
        plan,
        skillResourceClosureReceipts,
      );
      if (!receiptCoverage.passed) {
        throw new ReleaseError(
          POST_PUBLISH_VERIFY_FAILED,
          'skill resource closure receipt set does not match declared consumer distributions',
          receiptCoverage,
        );
      }

      await evidence.append({
        phase: 'verify',
        step: 'skill-resource-closure',
        status: 'completed',
        surfaceCount: installSurfaces.length,
        receipts: skillResourceClosureReceipts,
      });
    }

    // =======================================================================
    // All verifications passed — write verify run
    // =======================================================================
    assertTransition(PUBLISHED, VERIFIED);
    await evidence.append({ phase: 'verify', status: 'completed', overallStatus: VERIFIED });

    const sourceRunDigest = sourceRun.runDigest ?? computeRunDigest(sourceRun);

    const verifyRunPath = join(runDir, 'release-run.json');
    const verifyRunState = {
      runId,
      command: 'verify',
      planDigest: plan.digest,
      planPath,
      ...(sourceRun.approvalPath ? {
        approvalPath: sourceRun.approvalPath,
        approvalDigest: sourceRun.approvalDigest,
      } : {}),
      sourceRunId: sourceRun.runId,
      sourceRunDigest,
      sourceRunPath: resolvedSourceRunPath,
      status: VERIFIED,
      checkpoints: actions.map((a) => {
        const check = adapterChecks.find((c) => c.actionId === a.id);
        let status;
        if (check?.status === 'SKIPPED') {
          status = 'skipped';
        } else if (check?.status === VERIFICATION_RESOLVED_TYPES.PASSED_AUTOMATIC) {
          status = 'succeeded';
        } else if (check?.status === VERIFICATION_RESOLVED_TYPES.PASSED_MANUAL) {
          status = 'succeeded';
        } else if (check?.status === VERIFICATION_RESOLVED_TYPES.NOT_REQUIRED_UNCHANGED) {
          status = 'skipped';
        } else {
          status = 'succeeded';
        }
        return {
          actionId: a.id,
          actionType: a.type,
          status,
        };
      }),
      gateResults: consumerGateResults,
      consumerVerificationReceipts,
      skillResourceClosureReceipts,
      ...(manualFollowUps.length > 0 ? { manualFollowUps } : {}),
      startedAt: clockFn(),
      finishedAt: clockFn(),
    };
    const persistedVerifyRun = await writeRunAtomic(verifyRunPath, verifyRunState);

    // =======================================================================
    // FROZEN marker retirement (2026-08-18 investigation §4.5 option 1):
    // the release reached VERIFIED, so the freeze signal is cleared. Only
    // this success path clears it — failed/PARTIAL verify runs never reach
    // here and keep the marker. Best-effort: a removal failure must never
    // demote VERIFIED.
    // =======================================================================
    try {
      const removed = await clearFrozenMarker(join(root, '.release-skill'));
      await evidence.append({
        phase: 'frozen-marker',
        status: removed ? 'cleared' : 'absent',
      });
    } catch (err) {
      await evidence.append({
        phase: 'frozen-marker',
        status: 'clear-failed',
        error: { code: err.code, message: err.message },
      });
    }

    // =======================================================================
    // Baseline advance: move per-unit previousPublicBaseline to the commit
    // that was just verified. Local bookkeeping only — no remote writes.
    // Best-effort: a failure here must never demote VERIFIED, and the config
    // is only auto-committed when the file was clean before the write, so a
    // dirty worktree leaves the decision to the human.
    // =======================================================================
    let baselineAdvance = null;
    const baselineAdvances = deriveBaselineAdvances(plan);
    if (baselineAdvances.length > 0) {
      try {
        const configAbs = configPathOpt
          ? (isAbsolute(configPathOpt) ? configPathOpt : join(root, configPathOpt))
          : join(root, '.release-skill/project.yaml');
        const cleanBefore = await isWorktreeFileClean({ root, filePath: configAbs, execFn });
        const applyResult = await applyBaselineAdvances({
          configPath: configAbs,
          advances: baselineAdvances,
          validateFn: async () => { await loadProjectConfig({ root, configPath: configAbs }); },
        });
        baselineAdvance = { ...applyResult, committed: false };
        if (applyResult.changed && cleanBefore) {
          const versionLabel = (plan.units ?? [])
            .map((u) => `${u.id} v${u.targetVersion}`)
            .join(', ');
          await commitBaselineAdvance({
            root,
            filePath: configAbs,
            message: `chore: advance previousPublicBaseline to published ${versionLabel}`,
            execFn,
          });
          baselineAdvance.committed = true;
        }
        await evidence.append({
          phase: 'verify',
          step: 'baseline-advance',
          status: applyResult.changed ? 'advanced' : 'already-current',
          updatedUnits: applyResult.updatedUnits,
          committed: baselineAdvance.committed,
        });
      } catch (err) {
        baselineAdvance = { failed: true, error: err.message };
        await evidence.append({
          phase: 'verify',
          step: 'baseline-advance',
          status: 'failed',
          error: { code: err.code, message: err.message },
        });
      }
    }

    await evidence.finish({
      status: VERIFIED,
      recoveryActionCode: null,
      planPath,
      sourceRunId: sourceRun.runId,
      sourceRunDigest,
      runDigest: persistedVerifyRun.runDigest,
      adapterCheckCount: adapterChecks.length,
      smokeTestPassed: true,
      consumerGateCount: consumerGateResults.length,
      completedAt: clockFn(),
    });

    return {
      planPath,
      status: VERIFIED,
      adapterChecks,
      recoveryActionCode: null,
      smokeTest,
      gateResults: consumerGateResults,
      ...(manualFollowUps.length > 0 ? { manualFollowUps } : {}),
      ...(baselineAdvance ? { baselineAdvance } : {}),
    };
  } catch (err) {
    const { recoveryActionCode } = await readRunRecovery(resolvedSourceRunPath, {
      planPath, clock: clockFn, command: 'verify', error: err,
    });
    err.details = { ...err.details, recoveryActionCode };
    await evidence.append({
      phase: 'verify',
      status: 'failed',
      error: { code: err.code, message: err.message, details: err.details },
      details: { recoveryActionCode },
    });

    await evidence.finish({
      status: 'FAILED',
      recoveryActionCode,
      error: { code: err.code, message: err.message, details: err.details },
      details: { recoveryActionCode },
      failedAt: clockFn(),
    });

    throw err;
  }
}
