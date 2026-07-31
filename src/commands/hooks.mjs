import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

import { loadProjectConfig } from '../core/config.mjs';
import { createEvidenceWriter } from '../core/evidence.mjs';
import { runDeclaredHooks } from './prepare.mjs';
import { ReleaseError, GATE_FAILED } from '../core/errors.mjs';

/**
 * Run the declared development gates and populate the exact same content-bound
 * hook receipts consumed by prepare. A later ship/prepare reuses only
 * cacheable hooks whose declared input closure is byte-identical.
 */
export async function validateDeclaredHooks(options = {}) {
  const {
    root = process.cwd(),
    hooksAuthorized,
    hookCache = true,
    runDir = resolve(root, '.release-skill', 'runs', `hooks-${Date.now()}`),
  } = options;
  if (hooksAuthorized !== true) {
    throw new ReleaseError(
      GATE_FAILED,
      'hooks validate executes declared project commands; pass --acknowledge-hook-side-effects',
    );
  }
  const { config, configDigest } = await loadProjectConfig({ root });
  await mkdir(runDir, { recursive: true });
  const evidence = createEvidenceWriter({
    runDir,
    command: 'hooks-validate',
    clock: () => new Date().toISOString(),
  });
  const startedAt = new Date().toISOString();
  await runDeclaredHooks(config, root, evidence, undefined, { hookCache });
  return {
    command: 'hooks validate',
    status: 'PASSED',
    configDigest,
    hooks: Object.keys(config.hooks ?? {}).sort(),
    cacheEnabled: hookCache,
    evidenceDir: runDir,
    startedAt,
    finishedAt: new Date().toISOString(),
  };
}
