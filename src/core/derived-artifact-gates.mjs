/**
 * Version-sensitive derived-artifact fast pre-gates (O1, 2026-08-18
 * release-cycle investigation §3.2).
 *
 * In the 0.6.1 cycle two prepares burned the full ~80s test hook before
 * surfacing drift that a sub-second check could have caught: adapter trees
 * out of sync with skills-src/, and self-bootstrap fact pins still bound to
 * the previous version. This module promotes those checks and the platform
 * manifest freshness check to prepare's earliest stage, alongside the bundle
 * freshness gate:
 *
 * - adapter gate: runs `scripts/build-adapters.mjs --check` (drift list,
 *   exit 1 on drift — the same supported check the scripts surface offers);
 * - platform manifest gate: runs
 *   `scripts/generate-platform-manifest.mjs --check`;
 * - fact-pin gate: runs the version fact pins of
 *   `test/release-docs-self-bootstrap.test.mjs` — exactly its hermetic
 *   section 1 (`[self-bootstrap 1*]`: byte-level version assertions plus the
 *   in-process read-only planner), scoped via `--test-name-pattern`.
 *
 * All three promote the CANONICAL check logic — the gates and the full pipeline
 * can never disagree about what "in sync" means. The facts gate is scoped to
 * the suite's hermetic fact-pin section deliberately: the suite's remaining
 * sections shell out to npm/git and drive fixture prepares, which would make
 * a "fast pre-gate" slow, recursive, and brittle under toolchain-shimming
 * fixtures (a prepare invoked with a shimmed `npm` would crash the gate
 * child and false-report drift). Those sections remain the full test hooks'
 * job — this gate never replaces them. Every failure message therefore
 * states the boundary explicitly: this is a fast pre-gate and does NOT
 * replace the full test hooks（快速前置，不替代全量测试）.
 *
 * Spawn hygiene: the child environment drops NODE_TEST_CONTEXT. When prepare
 * itself runs inside a node:test harness, the runner exports that variable,
 * and an inheriting `node --test` child then prints "run() is being called
 * recursively ... skipping running files" and exits 0 — a false pass this
 * gate must never report as fresh. Production prepare runs in a plain shell
 * where the variable is absent, so the sanitization is a pure hardening.
 *
 * Recursion guard: the facts gate spawns the very suite whose fixture
 * prepares call prepareRelease — an unguarded child would re-enter the gate
 * and recurse without bound (every level waits on its own child until the
 * 300s timeouts cascade). Gate children therefore carry
 * RELEASE_SKILL_FACTS_GATE_ACTIVE; a facts gate running under the marker
 * records not-applicable (reason nested-gate-run) and spawns nothing. Only
 * the facts gate needs the guard: the adapter child (build-adapters --check)
 * never calls prepareRelease. The outermost prepare still enforces both
 * gates; only the verification run itself is exempt.
 *
 * Applicability mirrors bundle-freshness: installed distributions ship
 * neither the build scripts nor the test file, so the gates record
 * not-applicable there; a source checkout is always gated.
 *
 * @module core/derived-artifact-gates
 */

import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';

import { ReleaseError, DERIVED_ARTIFACT_STALE } from './errors.mjs';
import { boundedOutputTail } from './bounded-output.mjs';

const defaultExecFile = promisify(execFileCb);

/**
 * Exact bilingual note every pre-gate failure carries: the gates are a fast
 * front line and never a substitute for the full test hooks.
 */
export const DERIVED_ARTIFACT_PREGATE_NOTE =
  'This is a fast pre-gate and does not replace the full test hooks（快速前置，不替代全量测试）.';

/** One-click derived-artifact sync suggested by every drift remediation (O2). */
export const DERIVED_SYNC_COMMAND = 'node scripts/sync-derived-artifacts.mjs';

/**
 * Marker every gate child carries. A facts gate running under it is part of
 * the verification run itself and records not-applicable instead of
 * re-spawning the suite (recursion guard, see module docs).
 */
export const FACTS_GATE_NESTED_ENV = 'RELEASE_SKILL_FACTS_GATE_ACTIVE';

/** Gate descriptors: marker file (applicability), argv, remediation text. */
const GATES = Object.freeze({
  adapters: Object.freeze({
    artifact: 'adapters',
    marker: join('scripts', 'build-adapters.mjs'),
    argv: (pkgRoot) => [join(pkgRoot, 'scripts', 'build-adapters.mjs'), '--check'],
    timeoutMs: 120000,
    remediation:
      'Rebuild the existing adapters with: node scripts/build-adapters.mjs --apply ' +
      `(or run the one-click derived-artifact sync from the workspace root: ${DERIVED_SYNC_COMMAND}).`,
  }),
  'platform-manifest': Object.freeze({
    artifact: 'platform-manifest',
    marker: join('scripts', 'generate-platform-manifest.mjs'),
    argv: (pkgRoot) => [join(pkgRoot, 'scripts', 'generate-platform-manifest.mjs'), '--check'],
    timeoutMs: 120000,
    remediation:
      'Regenerate the platform manifest with: node scripts/generate-platform-manifest.mjs ' +
      `(or run the one-click derived-artifact sync from the workspace root: ${DERIVED_SYNC_COMMAND}).`,
  }),
  'self-bootstrap-facts': Object.freeze({
    artifact: 'self-bootstrap-facts',
    marker: join('test', 'release-docs-self-bootstrap.test.mjs'),
    // Hermetic fact-pin section only (see module docs): byte-level version
    // facts + in-process planner — no npm/git, no fixture prepares.
    argv: (pkgRoot) => [
      '--test',
      '--test-name-pattern',
      '\\[self-bootstrap 1',
      join(pkgRoot, 'test', 'release-docs-self-bootstrap.test.mjs'),
    ],
    timeoutMs: 120000,
    remediation:
      'Refresh the derived documents and version points first ' +
      `(workspace root: ${DERIVED_SYNC_COMMAND}); if the pins still fail, update the fact pins deliberately — ` +
      'the gate never edits sources or test pins itself.',
  }),
});

async function isFile(path) {
  try {
    return (await lstat(path)).isFile();
  } catch {
    return false;
  }
}

/**
 * Run one derived-artifact check (pure decision, never throws).
 *
 * @param {'adapters' | 'platform-manifest' | 'self-bootstrap-facts'} kind - Gate to run.
 * @param {string} pkgRoot - Absolute package root of the running checkout.
 * @param {object} [options]
 * @param {Function} [options.execFileFn] - execFile seam (tests).
 * @param {number} [options.timeoutMs] - Child timeout override.
 * @returns {Promise<{
 *   applicable: boolean,
 *   fresh?: boolean,
 *   reason?: string,
 *   artifact?: string,
 *   exitCode?: number | null,
 *   stdoutTail?: string,
 *   stderrTail?: string,
 *   durationMs?: number,
 * }>} stdoutTail/stderrTail are bounded and present on BOTH outcomes —
 * on the fresh path they prove the child really executed (e.g. the facts
 * gate carries the child suite's own `ℹ tests N` summary).
 */
export async function checkDerivedArtifactGate(kind, pkgRoot, options = {}) {
  const gate = GATES[kind];
  if (!gate) {
    throw new ReleaseError(DERIVED_ARTIFACT_STALE, `unknown derived-artifact gate: ${kind}`, { kind });
  }
  const execFileFn = options.execFileFn ?? defaultExecFile;

  if (kind === 'self-bootstrap-facts' && process.env[FACTS_GATE_NESTED_ENV]) {
    // Recursion guard: this prepare runs inside a gate child (the suite the
    // facts gate itself spawns). Re-spawning would recurse without bound;
    // the outermost prepare already enforces the gate for this checkout.
    return { applicable: false, reason: 'nested-gate-run', artifact: gate.artifact };
  }

  if (!(await isFile(join(pkgRoot, gate.marker)))) {
    // Installed distributions ship neither the build scripts nor the test
    // file; drift is a source-checkout concern only (bundle-freshness rule).
    return { applicable: false, reason: 'installed-layout', artifact: gate.artifact };
  }

  const startedAt = Date.now();
  // Never hand the child a test-runner context: under a nested node:test
  // harness NODE_TEST_CONTEXT makes `node --test` skip all files and exit 0,
  // which this gate must not report as fresh (false pass).
  const childEnv = { ...process.env };
  delete childEnv.NODE_TEST_CONTEXT;
  childEnv[FACTS_GATE_NESTED_ENV] = '1';
  try {
    const { stdout, stderr } = await execFileFn(process.execPath, gate.argv(pkgRoot), {
      cwd: pkgRoot,
      shell: false,
      encoding: 'utf8',
      timeout: options.timeoutMs ?? gate.timeoutMs,
      env: childEnv,
      maxBuffer: 16 * 1024 * 1024,
    });
    return {
      applicable: true,
      fresh: true,
      artifact: gate.artifact,
      stdoutTail: boundedOutputTail(stdout ?? ''),
      stderrTail: boundedOutputTail(stderr ?? ''),
      durationMs: Date.now() - startedAt,
    };
  } catch (err) {
    // Timeout / spawn failure fail closed too: an undecidable gate is drift.
    const stdoutTail = boundedOutputTail(err?.stdout ?? '');
    const stderrTail = boundedOutputTail(err?.stderr ?? err?.message ?? '');
    return {
      applicable: true,
      fresh: false,
      reason: err?.killed || err?.code === 'ETIMEDOUT' ? 'timeout' : 'drift',
      artifact: gate.artifact,
      exitCode: typeof err?.code === 'number' ? err.code : null,
      stdoutTail,
      stderrTail,
      durationMs: Date.now() - startedAt,
    };
  }
}

/** Adapter freshness decision (build-adapters --check). */
export function checkAdapterFreshness(pkgRoot, options = {}) {
  return checkDerivedArtifactGate('adapters', pkgRoot, options);
}

/** Platform manifest freshness decision (generate-platform-manifest --check). */
export function checkPlatformManifestFreshness(pkgRoot, options = {}) {
  return checkDerivedArtifactGate('platform-manifest', pkgRoot, options);
}

/** Self-bootstrap fact-pin decision (single-file test). */
export function checkSelfBootstrapFacts(pkgRoot, options = {}) {
  return checkDerivedArtifactGate('self-bootstrap-facts', pkgRoot, options);
}

async function assertGate(kind, pkgRoot, options = {}) {
  const result = await checkDerivedArtifactGate(kind, pkgRoot, options);
  if (!result.applicable || result.fresh) {
    return result;
  }
  const gate = GATES[kind];
  const subject = kind === 'adapters'
    ? 'adapters/ is out of sync with its sources (build-adapters --check reported drift)'
    : kind === 'platform-manifest'
      ? 'platform-manifest.json is out of sync with the current package tree (generate-platform-manifest --check reported drift)'
      : 'the release-docs-self-bootstrap fact pins are stale (the hermetic fact-pin check failed)';
  throw new ReleaseError(
    DERIVED_ARTIFACT_STALE,
    `${subject}. ${DERIVED_ARTIFACT_PREGATE_NOTE} ${gate.remediation}`,
    {
      artifact: result.artifact,
      reason: result.reason,
      exitCode: result.exitCode,
      stdoutTail: result.stdoutTail,
      stderrTail: result.stderrTail,
      durationMs: result.durationMs,
    },
  );
}

/**
 * Fail-closed adapter pre-gate used by prepare's earliest stage.
 * Not-applicable layouts return quietly; drift throws DERIVED_ARTIFACT_STALE.
 *
 * @param {string} pkgRoot - Absolute package root.
 * @param {object} [options] - execFileFn/timeoutMs seams (tests).
 * @returns {Promise<object>} The gate decision.
 * @throws {ReleaseError} DERIVED_ARTIFACT_STALE on drift/timeout.
 */
export function assertAdapterFreshness(pkgRoot, options = {}) {
  return assertGate('adapters', pkgRoot, options);
}

/**
 * Fail-closed platform manifest pre-gate used by prepare's earliest stage.
 * Not-applicable layouts return quietly; drift throws DERIVED_ARTIFACT_STALE.
 */
export function assertPlatformManifestFreshness(pkgRoot, options = {}) {
  return assertGate('platform-manifest', pkgRoot, options);
}

/**
 * Fail-closed self-bootstrap fact-pin pre-gate used by prepare's earliest
 * stage. Not-applicable layouts return quietly; drift throws
 * DERIVED_ARTIFACT_STALE.
 *
 * @param {string} pkgRoot - Absolute package root.
 * @param {object} [options] - execFileFn/timeoutMs seams (tests).
 * @returns {Promise<object>} The gate decision.
 * @throws {ReleaseError} DERIVED_ARTIFACT_STALE on drift/timeout.
 */
export function assertSelfBootstrapFacts(pkgRoot, options = {}) {
  return assertGate('self-bootstrap-facts', pkgRoot, options);
}
