// @decision D-RS-004
// @decision D-RS-005

import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

import { loadProjectConfig } from '../core/config.mjs';
import { createEvidenceWriter } from '../core/evidence.mjs';
import { ReleaseError, GATE_FAILED } from '../core/errors.mjs';
import { describeDeclaredHookSideEffects } from '../core/hooks.mjs';
import { HOOK_EXECUTION_ORDER, runDeclaredHooks } from './prepare.mjs';

/**
 * Run the declared development gates and populate the exact same content-bound
 * hook receipts consumed by prepare. A later ship/prepare reuses only
 * cacheable hooks whose declared input closure is byte-identical.
 *
 * Hooks that explicitly declare write or external side effects (`mutating: true`
 * or `sideEffects: 'local-write' | 'network-or-external'`) disclose their
 * command and scope up front and require `hooksAuthorized: true`
 * (`--acknowledge-hook-side-effects`) before execution (`US-043`).
 */
export async function validateDeclaredHooks(options = {}) {
  const {
    root = process.cwd(),
    hooksAuthorized = false,
    hookCache = true,
    runDir = resolve(root, '.release-skill', 'runs', `hooks-${Date.now()}`),
  } = options;
  const { config, configDigest } = await loadProjectConfig({ root });
  const sideEffectDisclosure = describeDeclaredHookSideEffects(config.hooks, HOOK_EXECUTION_ORDER);
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
    if (sideEffectDisclosure.requiresAcknowledgement && hooksAuthorized !== true) {
      await evidence.append({
        phase: 'hook-authorization',
        status: 'blocking',
        reason: 'HOOK_SIDE_EFFECTS_ACKNOWLEDGEMENT_REQUIRED',
        requiredFlag: '--acknowledge-hook-side-effects',
        disclosedHooks: sideEffectDisclosure.disclosedHooks,
      });
      const disclosureLines = [
        `钩子核验门禁已阻断：检测到 ${sideEffectDisclosure.disclosedHooks.length} 个声明了副作用的开发钩子，未传入 --acknowledge-hook-side-effects 前不会启动子进程：`,
        ...sideEffectDisclosure.disclosedHooks.map((entry) => `  - ${entry.impactSummary}`),
        '恢复方式：审阅上述待执行命令与影响范围后，追加 --acknowledge-hook-side-effects 重新运行 release-skill hooks validate。',
      ];
      throw new ReleaseError(
        GATE_FAILED,
        disclosureLines.join('\n'),
        {
          reason: 'HOOK_SIDE_EFFECTS_ACKNOWLEDGEMENT_REQUIRED',
          requiredFlag: '--acknowledge-hook-side-effects',
          disclosedHooks: sideEffectDisclosure.disclosedHooks,
          nextSteps: [{
            code: 'ACKNOWLEDGE_HOOK_SIDE_EFFECTS',
            message: '审阅披露的副作用钩子命令后，追加 --acknowledge-hook-side-effects 重新执行 hooks validate',
            argv: ['release-skill', 'hooks', 'validate', '--acknowledge-hook-side-effects'],
          }],
        },
      );
    }
    if (sideEffectDisclosure.requiresAcknowledgement) {
      await evidence.append({
        phase: 'hook-authorization',
        status: 'authorized',
        sideEffectsAcknowledged: true,
        disclosedHooks: sideEffectDisclosure.disclosedHooks,
      });
    }
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
    ...(sideEffectDisclosure.requiresAcknowledgement
      ? { disclosedHooks: sideEffectDisclosure.disclosedHooks }
      : {}),
    cacheEnabled: hookCache,
    evidenceDir: runDir,
    startedAt,
    finishedAt,
  };
}
