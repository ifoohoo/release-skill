/**
 * Preset hook execution dispatcher (v0.6.3 R4, design §2.5).
 *
 * One dispatch seam shared by the distribute saga and the independent
 * postVerify run: every registered preset routes to its built-in
 * implementation here, so both phases can never drift apart.
 *
 * Result contract (normalized across presets):
 * - `status`: 'EXECUTED' | 'NO_CHANGE';
 * - `mode`: checkpoint/evidence delivery mode ('pushed' | 'local-file' |
 *   'notify-handoff' | 'no-change' | ...);
 * - `observation`: preset-specific observation (pushedCommit, ...);
 * - optional `manualSyncPrompt` (proposal-inbox closure semantics and the
 *   notify-handoff checklist text), `checklist` (notify-handoff lines),
 *   `degradedToNotifyHandoff` (proposal-inbox without a target).
 *
 * proposal-inbox routing (targetOptional, review N-B1): without a target the
 * preset DEGRADES to notify-handoff behavior instead of erroring; with a
 * target the transport follows the addressing unless config.delivery pins it
 * (remoteUrl -> git-push, workspace -> local-file).
 *
 * @module core/preset-executor
 */

import { rm } from 'node:fs/promises';

import { ReleaseError, POST_PUBLISH_VERIFY_FAILED } from './errors.mjs';
import { resolveProposalInboxTransport } from './presets.mjs';
import { executeNotifyHandoffHook } from './notify-handoff.mjs';
import {
  buildProposalDocument,
  executeProposalInboxGitPushHook,
  executeProposalInboxLocalFileHook,
  observeProposalInboxGitPush,
  proposalFileName,
} from './proposal-inbox.mjs';
import { executeMarketplaceRegistryEntryHook } from './marketplace-registry-entry.mjs';
import { executeDocsRefreshHook } from './docs-refresh-preset.mjs';

/**
 * Execute one preset hook end-to-end.
 *
 * F-04 root split: this seam receives `releaseWorkspaceRoot` — the real
 * project root the user releases from. It is forwarded to proposal-inbox
 * (local-file), marketplace-registry-entry, docs-refresh and the shared
 * workspace preflight (§2.6) as the ONLY `target.workspace` resolution basis
 * and release-workspace write-exclusion basis. The detached frozen-tag
 * worktree is the execution worktree (materialize/steps/custom command
 * hooks) and is NEVER accepted here: the legacy ambiguous `root` option is
 * rejected fail-closed, and neither root falls back onto the other through
 * defaults.
 *
 * @param {object} params
 * @param {object} params.hook - Declared hook entry (preset + config).
 * @param {object} params.contextProjection - The §2.3 context projection of
 *   the CURRENT run (notify-handoff checklists, docs/marketplace writes).
 * @param {object} [params.proposalContextProjection] - Lineage-stable
 *   projection for proposal documents (byte-deterministic redelivery);
 *   defaults to contextProjection.
 * @param {object} params.commitIdentity - Frozen postPublish commitIdentity.
 * @param {string} params.releaseWorkspaceRoot - Release workspace root (the
 *   real project root; preset workspace resolution + write exclusion).
 * @param {string} [params.evidencePath] - This run's evidence path
 *   (notify-handoff checklist rendering).
 * @param {Function} [params.exec] - Injectable git exec (tests).
 * @param {Function} [params.hookRunner] - Injectable hook runner (tests).
 * @param {string} [params.payloadDir] - Materialized payload directory
 *   (docs-refresh mappings; distribute phase only).
 * @returns {Promise<object>} Normalized delivery result (see module header).
 */
export async function executePresetHook(params) {
  const {
    hook,
    contextProjection,
    proposalContextProjection,
    commitIdentity,
    releaseWorkspaceRoot,
    evidencePath,
    exec,
    hookRunner,
    payloadDir,
  } = params ?? {};
  if (!hook || typeof hook.preset !== 'string') {
    throw new ReleaseError(POST_PUBLISH_VERIFY_FAILED, 'preset execution requires a preset hook entry');
  }
  if (params?.root !== undefined) {
    // F-04: the ambiguous `root` is gone. Silently honoring it would let the
    // detached execution worktree impersonate the release workspace again.
    throw new ReleaseError(
      POST_PUBLISH_VERIFY_FAILED,
      'executePresetHook no longer accepts the ambiguous "root" option; pass releaseWorkspaceRoot (the real project root) explicitly — the detached tag worktree is the execution worktree for materialize/steps/custom command hooks and is never the release workspace',
      {},
    );
  }
  const proposalProjection = proposalContextProjection ?? contextProjection;

  switch (hook.preset) {
    case 'notify-handoff': {
      return executeNotifyHandoffHook({
        contextProjection,
        ...(evidencePath !== undefined ? { evidencePath } : {}),
      });
    }

    case 'proposal-inbox': {
      const target = hook.config?.target;
      if (!target) {
        // targetOptional degradation (N-B1): notify-handoff behavior, never
        // an error — evidenced as such, never silent.
        const degraded = await executeNotifyHandoffHook({
          contextProjection,
          ...(evidencePath !== undefined ? { evidencePath } : {}),
        });
        return { ...degraded, degradedToNotifyHandoff: true };
      }
      // Effective transport (single authority: core/presets.mjs, shared with
      // the requiresApproval grading — R4 review M-1). Presets have NO
      // dry-run path of their own: the command-level DRY_RUN skip contract
      // skips preset hooks wholesale (SKIPPED/DRY_RUN checkpoints) before
      // this dispatch is ever reached (R4 review m-3).
      const transport = resolveProposalInboxTransport(hook.config);
      if (transport === 'git-push') {
        return executeProposalInboxGitPushHook({
          hook,
          contextProjection: proposalProjection,
          commitIdentity,
          ...(exec !== undefined ? { exec } : {}),
        });
      }
      if (transport === 'local-file') {
        return executeProposalInboxLocalFileHook({
          hook,
          contextProjection: proposalProjection,
          commitIdentity,
          releaseWorkspaceRoot,
          ...(exec !== undefined ? { exec } : {}),
        });
      }
      throw new ReleaseError(
        POST_PUBLISH_VERIFY_FAILED,
        `proposal-inbox transport "${transport}" is unknown (expected git-push or local-file)`,
        { transport },
      );
    }

    case 'marketplace-registry-entry': {
      return executeMarketplaceRegistryEntryHook({
        hook,
        contextProjection,
        commitIdentity,
        releaseWorkspaceRoot,
        ...(exec !== undefined ? { exec } : {}),
        ...(hookRunner !== undefined ? { hookRunner } : {}),
      });
    }

    case 'docs-refresh': {
      return executeDocsRefreshHook({
        hook,
        contextProjection,
        commitIdentity,
        payloadDir,
        releaseWorkspaceRoot,
        ...(exec !== undefined ? { exec } : {}),
        ...(hookRunner !== undefined ? { hookRunner } : {}),
      });
    }

    default: {
      // Fail-closed: an unimplemented preset never executes. Declaration
      // validation rejects unknown preset names, so this only guards presets
      // registered but not yet shipped.
      throw new ReleaseError(
        POST_PUBLISH_VERIFY_FAILED,
        `hook "${hook.id}" is preset "${hook.preset}"; this preset's behavior is not yet available in this release and ships in a later release`,
        { preset: hook.preset },
      );
    }
  }
}

/**
 * Narrow READ-ONLY preset preflight (rework R-01): deterministic conflicts a
 * preset can already recognize from its existing observe-before-write
 * observation, evaluated BEFORE the first external write of the phase. This
 * is NOT a second dispatch table and NOT a lock — it only covers the presets
 * whose observation implementation already exists (proposal-inbox git-push:
 * the proposal path exists with different bytes -> the shared observation
 * throws REMOTE_CONFLICT), and every preset hook is re-observed at execution
 * time regardless.
 *
 * Returns `null` for presets/transports without a read-only deterministic
 * conflict observation (proposal-inbox local-file, notify-handoff, ...) —
 * their execution-phase observe-before-write stays the only gate.
 *
 * @param {object} params
 * @param {object} params.hook - Declared preset hook entry.
 * @param {object} params.contextProjection - The deterministic §2.3 context
 *   projection of the current run (the same bytes the execution-phase
 *   delivery serializes; lineage-stable runId).
 * @param {Function} [params.exec] - Injectable git exec (tests).
 * @returns {Promise<{verdict: string, proposalPath: string}|null>}
 * @throws {ReleaseError} REMOTE_CONFLICT/REMOTE_UNAVAILABLE from the shared
 *   observation implementation.
 */
export async function preflightPresetHook(params) {
  const { hook, contextProjection, exec } = params ?? {};
  if (!hook || typeof hook.preset !== 'string') return null;
  if (hook.preset !== 'proposal-inbox') return null;
  const target = hook.config?.target;
  if (!target) return null; // targetOptional degradation: nothing remote to observe.
  const transport = resolveProposalInboxTransport(hook.config);
  if (transport !== 'git-push') return null; // local-file: no deterministic remote conflict observation.

  // The same observation implementation the execution-phase delivery uses:
  // build the byte-deterministic proposal and observe-before-write.
  const document = buildProposalDocument(contextProjection);
  const proposalPath = proposalFileName(contextProjection.unitId, contextProjection.version);
  const { cloneDir, verdict } = await observeProposalInboxGitPush({
    remoteUrl: target.remoteUrl,
    branch: target.branch,
    proposalPath,
    proposalDocument: document,
    ...(exec !== undefined ? { exec } : {}),
  });
  await rm(cloneDir, { recursive: true, force: true }).catch(() => {});
  return { verdict, proposalPath };
}
