/**
 * Checkpoint-level approval for requiresApproval postPublish hooks
 * (v0.6.3 R1, design §2.7 ruling 2).
 *
 * A `requiresApproval: true` hook needs its own approval record binding
 * (planDigest, hookId). The plan-level approval-record schema is NOT
 * extended (its top level is additionalProperties: false); this module owns
 * the separate postpublish-approval-record schema and its validation.
 *
 * Time semantics (24h max window, 5-minute clock-skew tolerance, expiry) are
 * delegated wholesale to core/approval.mjs `validateApprovalTimeWindow` so
 * both approval kinds can never drift apart. Hook config changes change the
 * plan digest, so approvals invalidate naturally with the plan; `runId` is
 * audit-only and never participates in binding.
 *
 * @module core/postpublish-approval
 */

import Ajv from 'ajv';
import addFormats from 'ajv-formats';

import { ReleaseError, GATE_FAILED } from './errors.mjs';
import { computePlanDigest } from './plan.mjs';
import { validateApprovalTimeWindow } from './approval.mjs';
import { resolvePresetRequiresApproval } from './presets.mjs';
import { readTrustedPackageResource } from './trusted-resource.mjs';

const postpublishApprovalSchema = JSON.parse((await readTrustedPackageResource(
  'schemas/postpublish-approval-record.schema.json',
)).toString('utf8'));
const postpublishApprovalAjv = new Ajv({ allErrors: true, strict: false });
addFormats(postpublishApprovalAjv);
const validatePostPublishApprovalSchema = postpublishApprovalAjv.compile(postpublishApprovalSchema);

/**
 * Schema-validate a postpublish checkpoint approval record.
 *
 * @param {object} approval
 * @throws {ReleaseError} GATE_FAILED when the record violates the schema.
 */
export function validatePostPublishApprovalRecordSchema(approval) {
  if (validatePostPublishApprovalSchema(approval)) return;
  const errors = validatePostPublishApprovalSchema.errors ?? [];
  throw new ReleaseError(
    GATE_FAILED,
    `postpublish approval record schema validation failed: ${errors.map((error) => `${error.instancePath || '/'}: ${error.message}`).join('; ')}`,
    { validationErrors: errors },
  );
}

/**
 * Validate a checkpoint approval against the frozen plan.
 *
 * Bindings enforced (all fail-closed with GATE_FAILED):
 * - record shape (postpublish-approval-record schema; additionalProperties
 *   is false, so plan-level fields like approvedActions are rejected);
 * - planDigest equals the computed plan digest;
 * - hookId names a hook declared in the frozen plan's postPublish.hooks;
 * - that hook actually declares requiresApproval: true;
 * - the shared approval time window (24h max, 5-minute skew, unexpired).
 *
 * @param {object} plan - Frozen plan (schema-valid, digest verified by caller).
 * @param {object} approval - Parsed postpublish approval record.
 * @param {object} [options]
 * @param {() => string} [options.clock] - Clock function returning ISO-8601.
 * @param {boolean} [options.requireUnexpired] - Default true.
 * @returns {object} The approved hook declaration.
 * @throws {ReleaseError} GATE_FAILED on any violation.
 */
export function validatePostPublishApproval(plan, approval, options = {}) {
  validatePostPublishApprovalRecordSchema(approval);

  const actualDigest = computePlanDigest(plan);
  if (approval.planDigest !== actualDigest) {
    throw new ReleaseError(
      GATE_FAILED,
      `postpublish approval planDigest mismatch: approval says ${String(approval.planDigest).slice(0, 16)}..., plan is ${actualDigest.slice(0, 16)}...`,
      { approvalPlanDigest: approval.planDigest, planDigest: actualDigest },
    );
  }

  const hooks = plan.postPublish?.hooks ?? [];
  const hook = hooks.find((entry) => entry.id === approval.hookId);
  if (!hook) {
    throw new ReleaseError(
      GATE_FAILED,
      `postpublish approval names hook "${approval.hookId}" which is not declared in the frozen plan`,
      { hookId: approval.hookId, declaredHookIds: hooks.map((entry) => entry.id) },
    );
  }
  // Effective requiresApproval (§2.6 grading): preset hooks may inherit the
  // preset-declared default (proposal-inbox git-push -> true) without an
  // explicit declaration; command hooks carry their declared value.
  const effectiveRequiresApproval = hook.requiresApproval
    ?? (hook.preset !== undefined ? resolvePresetRequiresApproval(hook.preset, hook.config) : false);
  if (effectiveRequiresApproval !== true) {
    throw new ReleaseError(
      GATE_FAILED,
      `postpublish approval names hook "${approval.hookId}" which does not require approval (requiresApproval is not true)`,
      { hookId: approval.hookId, requiresApproval: effectiveRequiresApproval ?? false },
    );
  }

  validateApprovalTimeWindow(approval, {
    clock: options.clock,
    requireUnexpired: options.requireUnexpired,
  });

  return hook;
}
