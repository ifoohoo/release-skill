/**
 * Explicit test-intake reads, coverage acceptance, and binding re-check.
 *
 * The module does not start a model, a skill, or an arbitrary command.
 * It checks declared files, digests, and the acceptance contract only.
 *
 * @module core/test-intake
 */

import { resolve, sep } from 'node:path';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { readFileStrict, HARNESS_ERROR_KINDS } from 'skill-family-harness-node';
import { readTrustedPackageResourceSync } from './trusted-resource.mjs';
import { ReleaseError, CONFIG_INVALID, GATE_FAILED } from './errors.mjs';
import { computePlanDigest } from './plan.mjs';

const RELATIVE_FILE = /^(?!\/)(?!.*\\)(?!.*\0)(?!.*(?:^|\/)\.\.(?:\/|$))(?!.*\/\/)(?!.*\/$).+$/;

const INTAKE_SCHEMA = JSON.parse(readTrustedPackageResourceSync(
  'schemas/test-intake.schema.json',
).toString('utf8'));

const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);
ajv.addSchema(INTAKE_SCHEMA);

function compileDef(name) {
  return ajv.compile({ $ref: `${INTAKE_SCHEMA.$id}#/definitions/${name}` });
}

const validateRequirements = compileDef('requirementsDocument');
const validateResult = compileDef('resultDocument');
const validateAcceptance = compileDef('testAcceptance');

const DONE_DISPOSITIONS = new Set(['executed', 'reused', 'not-applicable']);
const OPEN_DISPOSITIONS = new Set(['failed', 'incomplete', 'uncovered']);

/**
 * Drop testAcceptance before the existing plan digest. Record-layer fields
 * stay excluded by computePlanDigest itself.
 *
 * @param {object} plan
 * @returns {string}
 */
export function subjectDigestOf(plan) {
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) {
    throw new ReleaseError(GATE_FAILED, 'test intake subject is missing', {
      reason: 'TEST_ACCEPTANCE_SUBJECT',
    });
  }
  const { testAcceptance: _testAcceptance, ...rest } = plan;
  return computePlanDigest(rest);
}

/**
 * Lexical project-relative ordinary file path. `foo..bar` stays allowed.
 *
 * @param {string} value
 * @param {string} field
 */
export function assertIntakeRelativePath(value, field) {
  if (typeof value !== 'string' || !RELATIVE_FILE.test(value)) {
    throw new ReleaseError(
      CONFIG_INVALID,
      `testIntake ${field} is not a project-relative ordinary file path`,
      { reason: 'TEST_INTAKE_PATH', field },
    );
  }
}

/**
 * Collapse `.` segments so `a/./b` and `a/b` compare as the same path.
 * `..` is rejected by assertIntakeRelativePath before this runs.
 *
 * @param {string} value
 * @returns {string}
 */
export function normalizeIntakePath(value) {
  const parts = [];
  for (const segment of value.split('/')) {
    if (segment === '' || segment === '.') continue;
    parts.push(segment);
  }
  return parts.join('/');
}

/**
 * @param {{ requirementsFile: string, resultFile: string }} testIntake
 */
export function assertTestIntakePaths(testIntake) {
  assertIntakeRelativePath(testIntake?.requirementsFile, 'requirementsFile');
  assertIntakeRelativePath(testIntake?.resultFile, 'resultFile');
  if (normalizeIntakePath(testIntake.requirementsFile) === normalizeIntakePath(testIntake.resultFile)) {
    throw new ReleaseError(
      CONFIG_INVALID,
      'testIntake requirementsFile and resultFile must be different paths',
      { reason: 'TEST_INTAKE_PATH', field: 'testIntake' },
    );
  }
}

/**
 * Undeclared intake keeps the old path. A declared intake is production-only.
 *
 * @param {{ config: object, production: boolean }} options
 * @returns {{ declared: boolean }}
 */
export function assertTestIntakeDeclaration({ config, production }) {
  if (!config?.testIntake) return { declared: false };
  if (production !== true) {
    throw new ReleaseError(
      CONFIG_INVALID,
      'testIntake is unsupported outside production prepare',
      { reason: 'TEST_INTAKE_NON_PRODUCTION', field: 'testIntake' },
    );
  }
  assertTestIntakePaths(config.testIntake);
  return { declared: true };
}

function schemaFailure(validator, field) {
  const errors = validator.errors ?? [];
  const summary = errors.map((entry) => {
    const extra = entry.params?.additionalProperty ? ` (${entry.params.additionalProperty})` : '';
    return `${entry.instancePath || '/'} ${entry.message}${extra}`;
  }).join('; ');
  throw new ReleaseError(
    CONFIG_INVALID,
    `testIntake ${field} schema validation failed: ${summary}`,
    { field, validationErrors: errors.map((entry) => ({
      instancePath: entry.instancePath,
      message: entry.message,
      params: entry.params,
    })) },
  );
}

function harnessKind(err) {
  return err?.details?.kind ?? err?.cause?.details?.kind ?? null;
}

function throwRead(err, label, { missingCode, missingReason, tamperCode, tamperReason }) {
  const kind = harnessKind(err);
  if (kind === HARNESS_ERROR_KINDS.MISSING_RESOURCE) {
    throw new ReleaseError(missingCode, `${label} is missing`, {
      reason: missingReason,
      field: label,
      cause: kind,
    });
  }
  if (
    kind === HARNESS_ERROR_KINDS.CONTENT_GUARD_REJECTED
    || kind === HARNESS_ERROR_KINDS.UNSAFE_STATE_ENTRY
  ) {
    throw new ReleaseError(tamperCode, `${label} does not match the declared digest`, {
      reason: tamperReason,
      field: label,
      cause: kind,
    });
  }
  const cause = kind ?? 'unknown';
  throw new ReleaseError(tamperCode, `${label} cannot be read`, {
    reason: cause === 'unknown' ? 'unknown' : cause,
    field: label,
    cause,
  });
}

async function readJsonStrict(root, relPath, label, { missingCode, missingReason }) {
  let receipt;
  try {
    receipt = await readFileStrict(root, relPath, { encoding: 'utf8' });
  } catch (err) {
    throwRead(err, label, {
      missingCode,
      missingReason,
      tamperCode: missingCode,
      tamperReason: missingReason,
    });
  }
  try {
    return { document: JSON.parse(receipt.content), sha256: receipt.sha256, path: relPath };
  } catch {
    throw new ReleaseError(CONFIG_INVALID, `testIntake ${label} is not valid JSON`, {
      field: label,
    });
  }
}

async function verifyFileRef(root, ref, label) {
  try {
    await readFileStrict(root, ref.path, { expectedSha256: ref.sha256 });
  } catch (err) {
    throwRead(err, label, {
      missingCode: GATE_FAILED,
      missingReason: 'TEST_ACCEPTANCE_MISSING',
      tamperCode: GATE_FAILED,
      tamperReason: 'TEST_ACCEPTANCE_TAMPERED',
    });
  }
}

function scopeKey(scope) {
  return scope.kind === 'project' ? 'project' : `unit:${scope.unitId}`;
}

function assertHandoff(item, config, selectedSet) {
  const handoff = item.handoff;
  if (!handoff || typeof handoff.id !== 'string' || typeof handoff.kind !== 'string') {
    throw new ReleaseError(
      CONFIG_INVALID,
      `testIntake requirement "${item.id}" is missing a later-phase handoff`,
      { field: 'handoff', requirementId: item.id },
    );
  }
  const applicable = item.scope?.kind === 'project' || selectedSet.has(item.scope?.unitId);
  let targetUnit = null;

  if (item.phase === 'consumer-verify') {
    if (handoff.kind !== 'gate') {
      throw new ReleaseError(
        CONFIG_INVALID,
        `testIntake requirement "${item.id}" consumer-verify handoff "${handoff.id}" must be a consumer-verify gate, not kind "${handoff.kind}"`,
        { field: 'handoff', requirementId: item.id, handoffId: handoff.id },
      );
    }
    const gate = (config.verificationGates ?? []).find((entry) => (
      entry?.id === handoff.id && entry.phase === 'consumer-verify'
    ));
    if (!gate) {
      throw new ReleaseError(
        CONFIG_INVALID,
        `testIntake requirement "${item.id}" handoff gate "${handoff.id}" is not a consumer-verify gate`,
        { field: 'handoff', requirementId: item.id, handoffId: handoff.id },
      );
    }
    targetUnit = typeof gate.scope?.unit === 'string' ? gate.scope.unit : null;
  } else if (item.phase === 'postverify') {
    if (handoff.kind !== 'hook') {
      throw new ReleaseError(
        CONFIG_INVALID,
        `testIntake requirement "${item.id}" postverify handoff "${handoff.id}" must be a postVerify hook, not kind "${handoff.kind}"`,
        { field: 'handoff', requirementId: item.id, handoffId: handoff.id },
      );
    }
    let foundUnit = null;
    for (const unit of config.releaseUnits ?? []) {
      for (const hook of unit.postPublish?.hooks ?? []) {
        if (hook?.id !== handoff.id) continue;
        if ((hook.phase ?? 'distribute') !== 'postVerify') continue;
        foundUnit = unit.id;
      }
    }
    if (!foundUnit) {
      throw new ReleaseError(
        CONFIG_INVALID,
        `testIntake requirement "${item.id}" handoff hook "${handoff.id}" is not a postVerify hook`,
        { field: 'handoff', requirementId: item.id, handoffId: handoff.id },
      );
    }
    targetUnit = foundUnit;
  } else if (item.phase === 'finish') {
    if (handoff.kind !== 'finish') {
      throw new ReleaseError(
        CONFIG_INVALID,
        `testIntake requirement "${item.id}" finish handoff "${handoff.id}" must be the finish entry, not kind "${handoff.kind}"`,
        { field: 'handoff', requirementId: item.id, handoffId: handoff.id },
      );
    }
    const finishIds = new Set(['release-finish']);
    if (typeof config.releaseFinish?.setupSkill === 'string' && config.releaseFinish.setupSkill.length > 0) {
      finishIds.add(config.releaseFinish.setupSkill);
    }
    if (!finishIds.has(handoff.id)) {
      throw new ReleaseError(
        CONFIG_INVALID,
        `testIntake requirement "${item.id}" handoff finish "${handoff.id}" is not declared`,
        { field: 'handoff', requirementId: item.id, handoffId: handoff.id },
      );
    }
  } else {
    throw new ReleaseError(
      CONFIG_INVALID,
      `testIntake requirement "${item.id}" has an unknown later phase "${item.phase}"`,
      { field: 'phase', requirementId: item.id },
    );
  }

  if (item.scope?.kind === 'unit' && targetUnit && targetUnit !== item.scope.unitId) {
    throw new ReleaseError(
      CONFIG_INVALID,
      `testIntake requirement "${item.id}" handoff "${handoff.id}" is outside unit "${item.scope.unitId}"`,
      { field: 'handoff', requirementId: item.id, handoffId: handoff.id, unitId: targetUnit },
    );
  }
  if (applicable && targetUnit && !selectedSet.has(targetUnit)) {
    throw new ReleaseError(
      CONFIG_INVALID,
      `testIntake requirement "${item.id}" handoff "${handoff.id}" is outside the selected unit scope`,
      { field: 'handoff', requirementId: item.id, handoffId: handoff.id, unitId: targetUnit },
    );
  }
}

/**
 * Read and check the requirements attachment. Does not read resultFile.
 *
 * @param {{ root: string, config: object, selectedUnitIds?: string[] }} options
 */
export async function readTestRequirements({ root, config, selectedUnitIds }) {
  if (!config?.testIntake) {
    throw new ReleaseError(CONFIG_INVALID, 'testIntake is not declared', {
      reason: 'TEST_INTAKE_PATH',
      field: 'testIntake',
    });
  }
  assertTestIntakePaths(config.testIntake);
  const knownUnits = new Set((config.releaseUnits ?? []).map((unit) => unit.id));
  const selected = selectedUnitIds === undefined
    ? [...knownUnits]
    : [...selectedUnitIds];
  for (const unitId of selected) {
    if (!knownUnits.has(unitId)) {
      throw new ReleaseError(
        CONFIG_INVALID,
        `testIntake selected unit "${unitId}" is not configured`,
        { field: 'selectedUnitIds', unitId },
      );
    }
  }
  const selectedSet = new Set(selected);
  const loaded = await readJsonStrict(
    root,
    config.testIntake.requirementsFile,
    'requirementsFile',
    { missingCode: CONFIG_INVALID, missingReason: 'TEST_INTAKE_PATH' },
  );
  if (!validateRequirements(loaded.document)) schemaFailure(validateRequirements, 'requirementsFile');

  const seenIds = new Set();
  const seenDeclarations = new Set();
  for (const item of loaded.document.requirements) {
    if (seenIds.has(item.id)) {
      throw new ReleaseError(
        CONFIG_INVALID,
        `testIntake requirementsFile contains duplicate id "${item.id}"`,
        { field: 'requirements', requirementId: item.id },
      );
    }
    seenIds.add(item.id);
    if (item.scope.kind === 'unit' && !knownUnits.has(item.scope.unitId)) {
      throw new ReleaseError(
        CONFIG_INVALID,
        `testIntake requirement "${item.id}" references unknown unit "${item.scope.unitId}"`,
        { field: 'scope', requirementId: item.id, unitId: item.scope.unitId },
      );
    }
    const declarationKey = JSON.stringify({
      scope: scopeKey(item.scope),
      phase: item.phase,
      path: item.criterion.path,
      anchor: item.criterion.anchor ?? null,
    });
    if (seenDeclarations.has(declarationKey)) {
      throw new ReleaseError(
        CONFIG_INVALID,
        `testIntake requirement "${item.id}" conflicts with another declaration`,
        { field: 'requirements', requirementId: item.id },
      );
    }
    seenDeclarations.add(declarationKey);
    if (item.phase === 'pre-freeze') {
      if (item.handoff !== undefined) {
        throw new ReleaseError(
          CONFIG_INVALID,
          `testIntake requirement "${item.id}" must not declare a pre-freeze handoff`,
          { field: 'handoff', requirementId: item.id },
        );
      }
    } else {
      assertHandoff(item, config, selectedSet);
    }
    await verifyFileRef(root, item.source, `requirement ${item.id} source`);
    await verifyFileRef(root, item.criterion, `requirement ${item.id} criterion`);
  }

  const applicable = loaded.document.requirements.filter((item) => (
    item.scope.kind === 'project' || selectedSet.has(item.scope.unitId)
  ));
  const preFreeze = applicable.filter((item) => item.phase === 'pre-freeze');
  const deferred = applicable.filter((item) => item.phase !== 'pre-freeze');
  return {
    document: loaded.document,
    file: { path: config.testIntake.requirementsFile, sha256: loaded.sha256 },
    resultFile: config.testIntake.resultFile,
    applicable,
    preFreeze,
    deferred,
    selectedUnitIds: selected,
    allRequirements: loaded.document.requirements,
  };
}

function gap(requirementId, reason, extra = {}) {
  return { requirementId, reason, ...extra };
}

async function verifyResultRefs(root, item) {
  await verifyFileRef(root, item.decision, `result ${item.requirementId} decision`);
  await verifyFileRef(root, item.applicability, `result ${item.requirementId} applicability`);
  for (const ref of item.evidence ?? []) {
    await verifyFileRef(root, ref, `result ${item.requirementId} evidence`);
  }
  for (const ref of item.limitations ?? []) {
    await verifyFileRef(root, ref, `result ${item.requirementId} limitation`);
  }
}

/**
 * Accept pre-freeze results bound to this prepared object.
 * Structural failures throw. Coverage gaps return accepted:false.
 *
 * @param {{ root: string, requirements: object, prepared: object }} options
 */
export async function acceptTestResults({ root, requirements, prepared }) {
  const subjectDigest = subjectDigestOf(prepared);
  let loaded;
  try {
    loaded = await readJsonStrict(root, requirements.resultFile, 'resultFile', {
      missingCode: GATE_FAILED,
      missingReason: 'TEST_REQUIREMENT_MISSING',
    });
  } catch (err) {
    if (err instanceof ReleaseError && err.details?.reason === 'TEST_REQUIREMENT_MISSING') {
      return {
        accepted: false,
        gaps: [gap(null, 'TEST_REQUIREMENT_MISSING', { field: 'resultFile' })],
        subjectDigest,
      };
    }
    throw err;
  }
  if (!validateResult(loaded.document)) schemaFailure(validateResult, 'resultFile');

  const byId = new Map();
  for (const item of loaded.document.results) {
    if (byId.has(item.requirementId)) {
      throw new ReleaseError(
        CONFIG_INVALID,
        `testIntake resultFile contains duplicate requirementId "${item.requirementId}"`,
        { field: 'results', requirementId: item.requirementId },
      );
    }
    byId.set(item.requirementId, item);
  }
  const known = new Set(requirements.allRequirements.map((item) => item.id));
  for (const item of loaded.document.results) {
    if (!known.has(item.requirementId)) {
      throw new ReleaseError(
        CONFIG_INVALID,
        `testIntake result requirementId "${item.requirementId}" is not in the requirements file`,
        { field: 'results', requirementId: item.requirementId },
      );
    }
  }
  for (const item of loaded.document.results) {
    await verifyResultRefs(root, item);
  }

  const gaps = [];
  if (loaded.document.subjectDigest !== subjectDigest) {
    gaps.push(gap(null, 'TEST_SUBJECT_MISMATCH'));
  }
  if (loaded.document.requirementsSha256 !== requirements.file.sha256) {
    gaps.push(gap(null, 'TEST_REQUIREMENTS_DIGEST_MISMATCH'));
  }

  const requirementById = new Map(requirements.allRequirements.map((item) => [item.id, item]));
  for (const item of loaded.document.results) {
    const requirement = requirementById.get(item.requirementId);
    if (requirement.phase !== 'pre-freeze' && DONE_DISPOSITIONS.has(item.disposition) && item.verdict === 'passed') {
      gaps.push(gap(item.requirementId, 'TEST_RESULT_EARLY_PHASE', { phase: requirement.phase }));
    }
  }

  for (const requirement of requirements.preFreeze) {
    const item = byId.get(requirement.id);
    if (!item) {
      gaps.push(gap(requirement.id, 'TEST_REQUIREMENT_MISSING'));
      continue;
    }
    if (OPEN_DISPOSITIONS.has(item.disposition)) {
      gaps.push(gap(requirement.id, 'unknown', { disposition: item.disposition }));
      continue;
    }
    if (!DONE_DISPOSITIONS.has(item.disposition) || item.verdict !== 'passed') {
      gaps.push(gap(requirement.id, 'unknown', {
        disposition: item.disposition,
        verdict: item.verdict,
      }));
      continue;
    }
    const expectedAcceptor = item.disposition === 'not-applicable' ? requirement.owner : requirement.acceptor;
    if (item.acceptedBy !== expectedAcceptor) {
      gaps.push(gap(requirement.id, 'TEST_ACCEPTOR_MISMATCH'));
      continue;
    }
    if (item.disposition !== 'not-applicable' && item.evidence.length === 0) {
      gaps.push(gap(requirement.id, 'TEST_EVIDENCE_EMPTY'));
    }
  }

  if (gaps.length > 0) {
    return { accepted: false, gaps, subjectDigest };
  }

  const acceptedRequirementIds = requirements.preFreeze.map((item) => item.id).sort();
  const deferredRequirementIds = requirements.deferred.map((item) => item.id).sort();
  const testAcceptance = {
    formatVersion: 1,
    subjectDigest,
    requirements: { path: requirements.file.path, sha256: requirements.file.sha256 },
    result: { path: requirements.resultFile, sha256: loaded.sha256 },
    acceptedRequirementIds,
    deferredRequirementIds,
  };
  if (!validateAcceptance(testAcceptance)) schemaFailure(validateAcceptance, 'testAcceptance');
  return { accepted: true, gaps: [], subjectDigest, testAcceptance };
}

/**
 * @param {string} planPath
 * @returns {string}
 */
export function projectRootFromPlanPath(planPath) {
  const abs = resolve(planPath);
  const marker = `${sep}.release-skill${sep}`;
  const idx = abs.lastIndexOf(marker);
  if (idx < 0) {
    throw new ReleaseError(GATE_FAILED, 'testAcceptance plan path is outside a .release-skill authority', {
      reason: 'TEST_ACCEPTANCE_ROOT',
    });
  }
  return abs.slice(0, idx);
}

/**
 * Re-check a formal plan's testAcceptance originals. Absent field is the old path.
 *
 * @param {{ root: string, plan: object }} options
 */
export async function verifyTestAcceptance({ root, plan }) {
  if (!plan?.testAcceptance) return { applicable: false };
  if (typeof root !== 'string' || root.length === 0) {
    throw new ReleaseError(GATE_FAILED, 'testAcceptance root is missing', {
      reason: 'TEST_ACCEPTANCE_ROOT',
    });
  }
  if (!validateAcceptance(plan.testAcceptance)) schemaFailure(validateAcceptance, 'testAcceptance');
  const subjectDigest = subjectDigestOf(plan);
  if (plan.testAcceptance.subjectDigest !== subjectDigest) {
    throw new ReleaseError(GATE_FAILED, 'testAcceptance subjectDigest does not match the plan object', {
      reason: 'TEST_ACCEPTANCE_SUBJECT',
    });
  }
  const requirementsRel = plan.testAcceptance.requirements.path;
  const resultRel = plan.testAcceptance.result.path;
  let requirementsReceipt;
  let resultReceipt;
  try {
    requirementsReceipt = await readFileStrict(root, requirementsRel, {
      encoding: 'utf8',
      expectedSha256: plan.testAcceptance.requirements.sha256,
    });
  } catch (err) {
    throwRead(err, 'testAcceptance requirements', {
      missingCode: GATE_FAILED,
      missingReason: 'TEST_ACCEPTANCE_MISSING',
      tamperCode: GATE_FAILED,
      tamperReason: 'TEST_ACCEPTANCE_TAMPERED',
    });
  }
  try {
    resultReceipt = await readFileStrict(root, resultRel, {
      encoding: 'utf8',
      expectedSha256: plan.testAcceptance.result.sha256,
    });
  } catch (err) {
    throwRead(err, 'testAcceptance result', {
      missingCode: GATE_FAILED,
      missingReason: 'TEST_ACCEPTANCE_MISSING',
      tamperCode: GATE_FAILED,
      tamperReason: 'TEST_ACCEPTANCE_TAMPERED',
    });
  }
  let requirementsDoc;
  let resultDoc;
  try {
    requirementsDoc = JSON.parse(requirementsReceipt.content);
    resultDoc = JSON.parse(resultReceipt.content);
  } catch {
    throw new ReleaseError(GATE_FAILED, 'testAcceptance original is not valid JSON', {
      reason: 'TEST_ACCEPTANCE_TAMPERED',
    });
  }
  if (!validateRequirements(requirementsDoc)) {
    throw new ReleaseError(GATE_FAILED, 'testAcceptance requirements original no longer matches the intake schema', {
      reason: 'TEST_ACCEPTANCE_TAMPERED',
    });
  }
  if (!validateResult(resultDoc)) {
    throw new ReleaseError(GATE_FAILED, 'testAcceptance result original no longer matches the intake schema', {
      reason: 'TEST_ACCEPTANCE_TAMPERED',
    });
  }
  if (resultDoc.subjectDigest !== subjectDigest) {
    throw new ReleaseError(GATE_FAILED, 'testAcceptance result subjectDigest does not match the plan object', {
      reason: 'TEST_SUBJECT_MISMATCH',
    });
  }
  if (resultDoc.requirementsSha256 !== requirementsReceipt.sha256) {
    throw new ReleaseError(GATE_FAILED, 'testAcceptance result is not bound to the requirements original', {
      reason: 'TEST_REQUIREMENTS_DIGEST_MISMATCH',
    });
  }
  const accepted = [...plan.testAcceptance.acceptedRequirementIds].sort();
  const deferred = [...plan.testAcceptance.deferredRequirementIds].sort();
  if (
    accepted.join('\0') !== plan.testAcceptance.acceptedRequirementIds.join('\0')
    || deferred.join('\0') !== plan.testAcceptance.deferredRequirementIds.join('\0')
  ) {
    throw new ReleaseError(GATE_FAILED, 'testAcceptance requirement ids are not sorted', {
      reason: 'TEST_ACCEPTANCE_SUBJECT',
    });
  }
  for (const item of requirementsDoc.requirements) {
    await verifyFileRef(root, item.source, `requirement ${item.id} source`);
    await verifyFileRef(root, item.criterion, `requirement ${item.id} criterion`);
  }
  for (const item of resultDoc.results) {
    await verifyResultRefs(root, item);
  }
  return { applicable: true, testAcceptance: plan.testAcceptance };
}
