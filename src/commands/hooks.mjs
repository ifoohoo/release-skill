import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

import { loadProjectConfig } from '../core/config.mjs';
import { asError, createEvidenceWriter } from '../core/evidence.mjs';
import { runDeclaredHooks } from './prepare.mjs';
// ReleaseError and GATE_FAILED removed: no authorization gate remains.

/**
 * Run the declared development gates and populate the exact same content-bound
 * hook receipts consumed by prepare. A later ship/prepare reuses only
 * cacheable hooks whose declared input closure is byte-identical.
 */
export async function validateDeclaredHooks(options = {}) {
  const {
    root = process.cwd(),
    hooksAuthorized: _hooksAuthorized,
    hookCache = true,
    runDir = resolve(root, '.release-skill', 'runs', `hooks-${Date.now()}`),
  } = options;
  // The command invocation itself authorizes execution of configured hooks.
  // Old --acknowledge-hook-side-effects is accepted as a no-effect compatibility input.
  const { config, configDigest } = await loadProjectConfig({ root });
  await mkdir(runDir, { recursive: true });
  const evidence = createEvidenceWriter({
    runDir,
    command: 'hooks-validate',
    clock: () => new Date().toISOString(),
  });
  const startedAt = new Date().toISOString();
  const now = () => new Date().toISOString();
  await evidence.append({ phase: 'hooks', status: 'started' });
  try {
    await runDeclaredHooks(config, root, evidence, undefined, {
      hookCache,
      // Explicit env delivery (0.5.1 hook-env-delivery fix): same semantics as
      // prepare — allowlisted keys are read from this explicit map only.
      env: process.env,
    });
  } catch (error) {
    // R-06A/M1: the failure path seals the stream too — a failed hooks
    // validate must leave a terminal summary with the stable phase, evidence
    // location and table-driven recovery action code. The writer normalizes
    // the diagnostic fields (a numeric Git 128 stays EXIT_128, never masked
    // by a schema error); the original error always wins.
    try {
      await evidence.append({ phase: 'hooks', status: 'failed', error });
    } catch {
      // Failure evidence is best-effort; the seal below must never be skipped.
    }
    try {
      await evidence.finish({ status: 'FAILED', error, failedAt: now() });
    } catch {
      // Failure summary is best-effort; never mask the primary failure.
    }
    throw error;
  }
  await evidence.append({ phase: 'hooks', status: 'completed' });
  const finishedAt = now();
  await evidence.finish({
    status: 'PASSED',
    configDigest,
    hooks: Object.keys(config.hooks ?? {}).sort(),
    cacheEnabled: hookCache,
  });
  return {
    command: 'hooks validate',
    status: 'PASSED',
    configDigest,
    hooks: Object.keys(config.hooks ?? {}).sort(),
    cacheEnabled: hookCache,
    evidenceDir: runDir,
    startedAt,
    finishedAt,
  };
}
