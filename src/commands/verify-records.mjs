/**
 * Pure, offline verification of caller-supplied release records.
 *
 * This module never discovers records or performs I/O. The CLI layer supplies
 * the exact bytes and source labels selected by the caller.
 */

import { digestBytes } from 'skill-family-harness-node';

import {
  computeApprovalDigest,
  validateApproval,
  validateApprovalRecordSchema,
  validateApprovalTimeWindow,
} from '../core/approval.mjs';
import { isMarketplaceAction, isRemoteWriteAction } from '../core/checkpoints.mjs';
import { computePlanDigest, validatePlan } from '../core/plan.mjs';
import {
  computeRunDigest,
  validateRun,
  validateRunCheckpointMapping,
  validateRunPlanDigest,
  validateSourceRunEdge,
} from '../core/run.mjs';

export const VERIFY_RECORDS_EXIT_CODES = Object.freeze({
  CONSISTENT: 0,
  CONTRADICTED: 1,
  INSUFFICIENT: 2,
});

const SUPPORTED_PLAN_VERSIONS = new Set([1, 2, 3]);
const SUPPORTED_RUN_COMMANDS = new Set(['publish', 'reconcile', 'verify']);
const SUPPORTED_TERMINAL_STATUSES = new Set(['PARTIAL', 'PUBLISHED', 'VERIFIED']);
const FINDING_ORDER = Object.freeze([
  'INPUT_MISSING',
  'INPUT_DAMAGED',
  'FORMAT_UNSUPPORTED',
  'PLAN_DIGEST_MISMATCH',
  'APPROVAL_DIGEST_MISMATCH',
  'RUN_DIGEST_MISMATCH',
  'IDENTITY_MISMATCH',
  'PLAN_BINDING_MISMATCH',
  'APPROVAL_ACTION_MISMATCH',
  'RUN_LINEAGE_MISMATCH',
  'TRANSITION_MISMATCH',
  'CHECKPOINT_MISMATCH',
  'HISTORICAL_TIME_MISSING',
  'HISTORICAL_TIME_OUTSIDE_WINDOW',
]);
const FINDING_RANK = new Map(FINDING_ORDER.map((code, index) => [code, index]));

function sourceLabel(source) {
  if (typeof source !== 'string' || source.length === 0) return null;
  return source.replaceAll('\\', '/').split('/').filter(Boolean).at(-1) ?? null;
}

function parseInput(input, role, addFinding) {
  const summary = { role, source: sourceLabel(input?.source) };
  if (!input || input.bytes === undefined || input.bytes === null) {
    addFinding('INPUT_MISSING', role, `required ${role} input was not provided`, 'INSUFFICIENT');
    return { summary, digest: null, document: null, bytes: null, usable: false };
  }

  let bytes;
  try {
    bytes = Buffer.isBuffer(input.bytes)
      ? Buffer.from(input.bytes)
      : Buffer.from(input.bytes);
  } catch {
    addFinding('INPUT_DAMAGED', role, `${role} input is not byte-compatible`);
    return { summary, digest: null, document: null, bytes: null, usable: false };
  }

  const bytesSha256 = digestBytes(bytes);
  try {
    const document = JSON.parse(bytes.toString('utf8'));
    if (!document || typeof document !== 'object' || Array.isArray(document)) {
      addFinding('INPUT_DAMAGED', role, `${role} input must be a JSON object`);
      return {
        summary,
        digest: { bytesSha256, carriedDomainDigest: null, recomputedDomainDigest: null },
        document: null,
        bytes,
        usable: false,
      };
    }
    return {
      summary,
      digest: { bytesSha256, carriedDomainDigest: null, recomputedDomainDigest: null },
      document,
      bytes,
      usable: true,
    };
  } catch {
    addFinding('INPUT_DAMAGED', role, `${role} input is not valid JSON`);
    return {
      summary,
      digest: { bytesSha256, carriedDomainDigest: null, recomputedDomainDigest: null },
      document: null,
      bytes,
      usable: false,
    };
  }
}

function sameStringSet(left, right) {
  return JSON.stringify([...new Set(left)].sort()) === JSON.stringify([...new Set(right)].sort());
}

function commandStatusIsValid(run) {
  if (run.command === 'publish' || run.command === 'reconcile') {
    return run.status === 'PARTIAL' || run.status === 'PUBLISHED';
  }
  return run.command === 'verify' && run.status === 'VERIFIED';
}

function checkpointStatusIsValid(run) {
  if (run.status === 'VERIFIED') {
    return run.checkpoints.every((checkpoint) => ['succeeded', 'skipped'].includes(checkpoint.status));
  }
  if (run.status === 'PUBLISHED') {
    return run.checkpoints.every((checkpoint) => (
      isRemoteWriteAction(checkpoint.actionType)
        ? ['succeeded', 'skipped'].includes(checkpoint.status)
        : isMarketplaceAction(checkpoint.actionType)
          ? ['succeeded', 'skipped', 'deferred', 'failed'].includes(checkpoint.status)
          : true
    ));
  }
  if (run.status === 'PARTIAL') {
    return run.checkpoints.some((checkpoint) => !['succeeded', 'skipped', 'deferred'].includes(checkpoint.status));
  }
  return false;
}

/**
 * Verify one explicitly supplied record set without filesystem, network, or
 * process access.
 *
 * @param {object} request
 * @param {{bytes: Buffer|string, source?: string}} request.plan
 * @param {{bytes: Buffer|string, source?: string}} request.approval
 * @param {{bytes: Buffer|string, source?: string}} request.targetRun
 * @param {Array<{bytes: Buffer|string, source?: string}>} [request.sourceRuns]
 * @param {string} request.unitId
 * @param {string} request.targetVersion
 */
export function verifyReleaseRecords(request = {}) {
  const findings = [];
  const addFinding = (code, role, message, outcome = 'CONTRADICTED') => {
    findings.push({ code, role, message, _outcome: outcome });
  };

  const planInput = parseInput(request.plan, 'plan', addFinding);
  const approvalInput = parseInput(request.approval, 'approval', addFinding);
  const targetInput = parseInput(request.targetRun, 'targetRun', addFinding);
  const sourceInputs = Array.isArray(request.sourceRuns)
    ? request.sourceRuns.map((input, index) => parseInput(input, `sourceRun[${index}]`, addFinding))
    : [];

  const plan = planInput.document;
  const approval = approvalInput.document;
  const targetRun = targetInput.document;

  let planSupported = false;
  if (planInput.usable) {
    if (!SUPPORTED_PLAN_VERSIONS.has(plan?.planVersion)) {
      addFinding('FORMAT_UNSUPPORTED', 'plan', `unsupported release plan version: ${String(plan?.planVersion)}`, 'INSUFFICIENT');
    } else {
      planSupported = true;
      try {
        validatePlan(plan);
      } catch (error) {
        addFinding('INPUT_DAMAGED', 'plan', error.message);
        planSupported = false;
      }
      const recomputed = computePlanDigest(plan);
      planInput.digest.carriedDomainDigest = plan?.digest ?? null;
      planInput.digest.recomputedDomainDigest = recomputed;
      if (!plan?.digest || plan.digest !== recomputed) {
        addFinding('PLAN_DIGEST_MISMATCH', 'plan', 'plan digest does not match its binding content');
      }
    }
  }

  let approvalSupported = false;
  let approvalDigest = null;
  if (approvalInput.usable) {
    approvalDigest = computeApprovalDigest(approvalInput.bytes);
    approvalInput.digest.recomputedDomainDigest = approvalDigest;
    try {
      validateApprovalRecordSchema(approval);
      approvalSupported = true;
    } catch (error) {
      addFinding('INPUT_DAMAGED', 'approval', error.message);
    }
    if (approvalSupported) {
      try {
        validateApprovalTimeWindow(approval, {
          clock: () => approval.approvedAt,
          requireUnexpired: false,
        });
      } catch (error) {
        addFinding('INPUT_DAMAGED', 'approval', error.message);
        approvalSupported = false;
      }
    }
  }

  const runEntries = [
    { input: targetInput, role: 'targetRun', isTarget: true },
    ...sourceInputs.map((input, index) => ({ input, role: `sourceRun[${index}]`, isTarget: false })),
  ];
  const usableRuns = [];
  let trustedTargetTerminalStatus = null;
  for (const entry of runEntries) {
    const run = entry.input.document;
    if (!entry.input.usable) continue;
    entry.input.digest.carriedDomainDigest = run?.runDigest ?? null;
    entry.input.digest.recomputedDomainDigest = computeRunDigest(run);

    if (!SUPPORTED_RUN_COMMANDS.has(run?.command) || !SUPPORTED_TERMINAL_STATUSES.has(run?.status)) {
      addFinding(
        'FORMAT_UNSUPPORTED',
        entry.role,
        `unsupported release run command/status: ${String(run?.command)}/${String(run?.status)}`,
        'INSUFFICIENT',
      );
      continue;
    }

    const { runDigest: _runDigest, ...unsignedRun } = run;
    try {
      validateRun(unsignedRun);
    } catch (error) {
      addFinding('INPUT_DAMAGED', entry.role, error.message);
      continue;
    }

    const digestMatches = Boolean(run.runDigest)
      && run.runDigest === entry.input.digest.recomputedDomainDigest;
    const transitionIsValid = commandStatusIsValid(run);
    const terminalCheckpointsAreValid = checkpointStatusIsValid(run);
    if (!digestMatches) {
      addFinding('RUN_DIGEST_MISMATCH', entry.role, 'run digest does not match its content');
    }
    if (!transitionIsValid) {
      addFinding('TRANSITION_MISMATCH', entry.role, `run command ${run.command} cannot terminate as ${run.status}`);
    }
    if (!terminalCheckpointsAreValid) {
      addFinding('CHECKPOINT_MISMATCH', entry.role, `checkpoint results do not support terminal status ${run.status}`);
    }
    if (entry.isTarget && digestMatches && transitionIsValid && terminalCheckpointsAreValid) {
      trustedTargetTerminalStatus = run.status;
    }
    usableRuns.push({ ...entry, run });
  }

  if (planSupported && typeof request.unitId === 'string' && typeof request.targetVersion === 'string') {
    const expectedUnit = (plan.units ?? []).find((unit) => unit.id === request.unitId);
    if (!expectedUnit || expectedUnit.targetVersion !== request.targetVersion) {
      addFinding('IDENTITY_MISMATCH', 'plan', 'expected release unit and version do not match the plan');
    }
  } else if (typeof request.unitId !== 'string' || typeof request.targetVersion !== 'string') {
    addFinding('INPUT_MISSING', 'identity', 'unitId and targetVersion are required', 'INSUFFICIENT');
  }

  if (planSupported && approvalSupported) {
    const planDigest = computePlanDigest(plan);
    if (approval.planDigest !== planDigest) {
      addFinding('PLAN_BINDING_MISMATCH', 'approval', 'approval planDigest does not match the supplied plan');
    }

    const expectedUnitVersions = Object.fromEntries((plan.units ?? []).map((unit) => [unit.id, unit.targetVersion]));
    const approvedUnitVersions = approval.unitVersions
      ?? ((plan.units ?? []).length === 1 ? { [plan.units[0].id]: approval.targetVersion } : {});
    const identityMatches = sameStringSet(Object.keys(expectedUnitVersions), Object.keys(approvedUnitVersions))
      && Object.entries(expectedUnitVersions).every(([unitId, version]) => approvedUnitVersions[unitId] === version)
      && (approval.targetVersion === undefined
        || new Set(Object.values(expectedUnitVersions)).size !== 1
        || approval.targetVersion === Object.values(expectedUnitVersions)[0]);
    if (!identityMatches) {
      addFinding('IDENTITY_MISMATCH', 'approval', 'approval unit/version identity does not match the plan');
    }

    const planActions = (plan.externalActions ?? []).map((action) => action.id);
    if (!sameStringSet(approval.approvedActions ?? [], planActions)) {
      addFinding('APPROVAL_ACTION_MISMATCH', 'approval', 'approved actions do not exactly match the plan actions');
    }

    try {
      validateApproval(plan, approval, {
        clock: () => approval.approvedAt,
        requireUnexpired: false,
      });
    } catch (error) {
      const alreadyRepresented = (
        (/planDigest/i.test(error.message)
          && findings.some((finding) => finding.role === 'approval' && finding.code === 'PLAN_BINDING_MISMATCH'))
        || (/version|unitVersions/i.test(error.message)
          && findings.some((finding) => finding.role === 'approval' && finding.code === 'IDENTITY_MISMATCH'))
        || (/approved|action/i.test(error.message)
          && findings.some((finding) => finding.role === 'approval' && finding.code === 'APPROVAL_ACTION_MISMATCH'))
      );
      if (!alreadyRepresented) {
        addFinding('INPUT_DAMAGED', 'approval', error.message);
      }
    }
  }

  if (planSupported) {
    for (const entry of usableRuns) {
      try {
        validateRunPlanDigest(entry.run, plan);
      } catch (error) {
        addFinding('PLAN_BINDING_MISMATCH', entry.role, error.message);
      }
      try {
        validateRunCheckpointMapping(entry.run, plan.externalActions ?? []);
      } catch (error) {
        addFinding('CHECKPOINT_MISMATCH', entry.role, error.message);
      }
    }
  }

  if (approvalDigest) {
    for (const entry of usableRuns) {
      if (!entry.run.approvalDigest) {
        addFinding('INPUT_MISSING', entry.role, 'run does not carry the approval digest needed to bind the supplied approval', 'INSUFFICIENT');
      } else if (entry.run.approvalDigest !== approvalDigest) {
        addFinding('APPROVAL_DIGEST_MISMATCH', entry.role, 'run approvalDigest does not match the supplied approval bytes');
      }
    }
  }

  const supportingRuns = usableRuns.filter((entry) => !entry.isTarget);
  const chain = [];
  let lineageComplete = false;
  if (targetRun && usableRuns.some((entry) => entry.isTarget)) {
    let current = usableRuns.find((entry) => entry.isTarget);
    const visited = new Set();
    for (let depth = 0; depth <= 16 && current; depth += 1) {
      chain.push(current.run);
      const visitKey = `${current.run.runId}:${current.run.runDigest}`;
      if (visited.has(visitKey)) {
        addFinding('RUN_LINEAGE_MISMATCH', current.role, 'release run lineage contains a cycle');
        break;
      }
      visited.add(visitKey);

      if (current.run.command === 'publish') {
        lineageComplete = true;
        break;
      }
      if (!current.run.sourceRunId || !current.run.sourceRunDigest || !current.run.sourceRunPath) {
        addFinding('INPUT_MISSING', current.role, 'run is missing complete source-run lineage fields', 'INSUFFICIENT');
        break;
      }
      const exactParent = supportingRuns.find((candidate) => (
        candidate.run.runId === current.run.sourceRunId
        && candidate.run.runDigest === current.run.sourceRunDigest
      ));
      if (!exactParent) {
        const sameId = supportingRuns.find((candidate) => candidate.run.runId === current.run.sourceRunId);
        if (sameId) {
          addFinding('RUN_LINEAGE_MISMATCH', current.role, 'source run id is present but its digest does not match');
        } else {
          addFinding('INPUT_MISSING', current.role, 'explicit source run required by lineage was not supplied', 'INSUFFICIENT');
        }
        break;
      }
      try {
        validateSourceRunEdge(current.run, exactParent.run);
      } catch (error) {
        addFinding('TRANSITION_MISMATCH', current.role, error.message);
        break;
      }
      current = exactParent;
    }
    if (!lineageComplete && chain.length > 16) {
      addFinding('RUN_LINEAGE_MISMATCH', 'targetRun', 'release run lineage exceeds maximum depth');
    }
  }

  for (const entry of usableRuns) {
    const run = entry.run;
    if (run.stateSequence === undefined) {
      if (run.previousStateDigest !== undefined) {
        addFinding('RUN_LINEAGE_MISMATCH', entry.role, 'non-state run claims a previous state digest');
      }
      continue;
    }
    if (run.stateSequence === 0) {
      if (run.previousStateDigest !== undefined) {
        addFinding('RUN_LINEAGE_MISMATCH', entry.role, 'initial state run claims a previous state digest');
      }
      continue;
    }
    const predecessor = supportingRuns.find((candidate) => (
      candidate.run.runId === run.runId
      && candidate.run.stateSequence === run.stateSequence - 1
    ));
    if (!predecessor) {
      addFinding('INPUT_MISSING', entry.role, 'explicit predecessor state snapshot was not supplied', 'INSUFFICIENT');
    } else if (
      predecessor.run.runDigest !== run.previousStateDigest
      || predecessor.run.command !== run.command
      || predecessor.run.planDigest !== run.planDigest
    ) {
      addFinding('RUN_LINEAGE_MISMATCH', entry.role, 'state predecessor identity or digest does not match');
    }
  }

  if (approvalSupported) {
    const executionRun = [...chain].reverse().find((run) => (
      ['publish', 'reconcile'].includes(run.command)
      && (run.checkpoints ?? []).some((checkpoint) => isRemoteWriteAction(checkpoint.actionType))
    ));
    if (!lineageComplete || !executionRun?.startedAt || !executionRun?.finishedAt) {
      addFinding('HISTORICAL_TIME_MISSING', 'approval', 'historical publish execution interval cannot be proven', 'INSUFFICIENT');
    } else {
      const approvedAt = Date.parse(approval.approvedAt);
      const expiresAt = Date.parse(approval.expiresAt);
      const startedAt = Date.parse(executionRun.startedAt);
      const finishedAt = Date.parse(executionRun.finishedAt);
      if (
        !Number.isFinite(startedAt)
        || !Number.isFinite(finishedAt)
        || startedAt < approvedAt
        || finishedAt > expiresAt
        || finishedAt < startedAt
      ) {
        addFinding('HISTORICAL_TIME_OUTSIDE_WINDOW', 'approval', 'publish execution interval is outside the approval window');
      }
    }
  }

  findings.sort((left, right) => (
    (FINDING_RANK.get(left.code) ?? 999) - (FINDING_RANK.get(right.code) ?? 999)
    || left.role.localeCompare(right.role)
    || left.message.localeCompare(right.message)
  ));
  const hasContradiction = findings.some((finding) => finding._outcome === 'CONTRADICTED');
  const hasInsufficient = findings.some((finding) => finding._outcome === 'INSUFFICIENT');
  const status = hasContradiction ? 'CONTRADICTED' : hasInsufficient ? 'INSUFFICIENT' : 'CONSISTENT';

  return {
    status,
    unitId: typeof request.unitId === 'string' ? request.unitId : null,
    targetVersion: typeof request.targetVersion === 'string' ? request.targetVersion : null,
    historicalTerminalStatus: trustedTargetTerminalStatus,
    inputs: {
      plan: planInput.summary,
      approval: approvalInput.summary,
      targetRun: targetInput.summary,
      sourceRuns: sourceInputs.map((input) => input.summary),
    },
    digests: {
      plan: planInput.digest,
      approval: approvalInput.digest,
      targetRun: targetInput.digest,
      sourceRuns: sourceInputs.map((input) => input.digest),
    },
    findings: findings.map(({ _outcome, ...finding }) => finding),
  };
}
