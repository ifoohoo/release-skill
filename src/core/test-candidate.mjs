/**
 * One test-intake candidate: exclusive save, strict read, and the no-git
 * handoff decision shared by prepare and ship.
 *
 * Frozen git verification stays in prepare. This module does not run git.
 *
 * @module core/test-candidate
 */

import { lstat, readdir, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import {
  publishFileExclusive,
  readFileStrict,
  HARNESS_ERROR_KINDS,
} from 'skill-family-harness-node';
import { readTrustedPackageResourceSync } from './trusted-resource.mjs';
import { ReleaseError, CONFIG_INVALID, GATE_FAILED } from './errors.mjs';
import { computePlanDigest } from './plan.mjs';
import { acceptTestResults } from './test-intake.mjs';

const CANDIDATE_REL = /^\.release-skill\/runs\/[^/]+\/test-candidate\.json$/;
const TERMINAL_SHIP_STATUSES = new Set(['PARTIAL', 'PUBLISHED', 'VERIFIED']);

function writerVersion() {
  // Adapter closures do not ship package.json; use the package identity
  // injected by the bundle banner. Source mode still reads the trusted file.
  if (typeof __bundlePkg !== 'undefined' && __bundlePkg
    && typeof __bundlePkg.version === 'string' && __bundlePkg.version.length > 0) {
    return __bundlePkg.version;
  }
  const packageJson = JSON.parse(readTrustedPackageResourceSync('package.json').toString('utf8'));
  return packageJson.version;
}

export const WRITER_VERSION = writerVersion();

const INTAKE_SCHEMA = JSON.parse(readTrustedPackageResourceSync(
  'schemas/test-intake.schema.json',
).toString('utf8'));
const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);
ajv.addSchema(INTAKE_SCHEMA);
const validateCandidate = ajv.compile({ $ref: `${INTAKE_SCHEMA.$id}#/definitions/candidate` });

/**
 * Final plan content without release qualification fields.
 *
 * @param {object} plan
 * @returns {object}
 */
export function projectPrepared(plan) {
  const {
    status: _status,
    digest: _digest,
    testAcceptance: _testAcceptance,
    ...rest
  } = plan;
  return rest;
}

function forbidPreparedKeys(prepared) {
  for (const key of ['status', 'digest', 'testAcceptance']) {
    if (prepared && Object.prototype.hasOwnProperty.call(prepared, key)) {
      throw new ReleaseError(
        CONFIG_INVALID,
        `test candidate prepared must not include ${key}`,
        { field: 'prepared', reason: 'TEST_INTAKE_PATH' },
      );
    }
  }
}

/**
 * @param {string} root
 * @param {string} candidatePath
 * @returns {string}
 */
export function canonicalCandidatePath(root, candidatePath) {
  if (typeof root !== 'string' || root.length === 0 || typeof candidatePath !== 'string') {
    throw new ReleaseError(CONFIG_INVALID, 'candidate path must be .release-skill/runs/<run>/test-candidate.json', {
      reason: 'TEST_INTAKE_PATH',
      field: 'candidatePath',
    });
  }
  const absRoot = resolve(root);
  const abs = isAbsolute(candidatePath) ? resolve(candidatePath) : resolve(absRoot, candidatePath);
  const rel = relative(absRoot, abs).split(sep).join('/');
  if (!CANDIDATE_REL.test(rel)) {
    throw new ReleaseError(CONFIG_INVALID, 'candidate path must be .release-skill/runs/<run>/test-candidate.json', {
      reason: 'TEST_INTAKE_PATH',
      field: 'candidatePath',
    });
  }
  return rel;
}

function schemaFailure(validator) {
  const errors = validator.errors ?? [];
  const summary = errors.map((entry) => `${entry.instancePath || '/'} ${entry.message}`).join('; ');
  throw new ReleaseError(CONFIG_INVALID, `test candidate schema validation failed: ${summary}`, {
    field: 'test-candidate',
    validationErrors: errors.map((entry) => ({
      instancePath: entry.instancePath,
      message: entry.message,
    })),
  });
}

function fileRefOf(requirements) {
  if (requirements?.file?.path && requirements?.file?.sha256) {
    return { path: requirements.file.path, sha256: requirements.file.sha256 };
  }
  if (requirements?.path && requirements?.sha256) {
    return { path: requirements.path, sha256: requirements.sha256 };
  }
  throw new ReleaseError(CONFIG_INVALID, 'test candidate requirements file reference is missing', {
    reason: 'TEST_INTAKE_PATH',
    field: 'requirements',
  });
}

function harnessKind(err) {
  return err?.details?.kind ?? null;
}

/**
 * @param {{ root: string, runDir: string, prepared: object, requirements: object, prepareOptions: object }} options
 */
export async function writeTestCandidate({ root, runDir, prepared, requirements, prepareOptions }) {
  const preparedBody = projectPrepared(prepared);
  forbidPreparedKeys(preparedBody);
  const runRel = relative(resolve(root), resolve(runDir)).split(sep).join('/');
  if (!runRel || runRel.startsWith('..') || runRel.split('/').includes('..')) {
    throw new ReleaseError(CONFIG_INVALID, 'test candidate run directory escapes the project root', {
      reason: 'TEST_INTAKE_PATH',
      field: 'runDir',
    });
  }
  const candidatePath = `${runRel}/test-candidate.json`;
  if (!CANDIDATE_REL.test(candidatePath)) {
    throw new ReleaseError(CONFIG_INVALID, 'test candidate path is not under .release-skill/runs/<run>/', {
      reason: 'TEST_INTAKE_PATH',
      field: 'candidatePath',
    });
  }
  const candidate = {
    candidateVersion: 1,
    writerVersion: WRITER_VERSION,
    prepareOptions,
    requirements: fileRefOf(requirements),
    prepared: preparedBody,
  };
  if (!validateCandidate(candidate)) schemaFailure(validateCandidate);
  let receipt;
  try {
    receipt = await publishFileExclusive(
      root,
      candidatePath,
      `${JSON.stringify(candidate, null, 2)}\n`,
      { mode: 0o600, createParents: false },
    );
  } catch (err) {
    const kind = harnessKind(err);
    if (kind === HARNESS_ERROR_KINDS.EXCLUSIVE_PUBLISH_CONFLICT) {
      throw new ReleaseError(GATE_FAILED, 'test candidate already exists and was not overwritten', {
        reason: 'TEST_CANDIDATE_REPREPARE',
        field: 'candidatePath',
        cause: kind,
      });
    }
    throw new ReleaseError(GATE_FAILED, 'test candidate could not be saved', {
      reason: kind ?? 'unknown',
      field: 'candidatePath',
      cause: kind ?? 'unknown',
    });
  }
  return { candidate, sha256: receipt.sha256, candidatePath };
}

/**
 * @param {{ root: string, candidatePath: string }} options
 */
export async function readTestCandidate({ root, candidatePath }) {
  const rel = canonicalCandidatePath(root, candidatePath);
  let receipt;
  try {
    receipt = await readFileStrict(root, rel, { encoding: 'utf8' });
  } catch (err) {
    const kind = harnessKind(err);
    const reason = kind === HARNESS_ERROR_KINDS.MISSING_RESOURCE
      ? 'TEST_ACCEPTANCE_MISSING'
      : (kind === HARNESS_ERROR_KINDS.CONTENT_GUARD_REJECTED || kind === HARNESS_ERROR_KINDS.UNSAFE_STATE_ENTRY)
        ? 'TEST_ACCEPTANCE_TAMPERED'
        : (kind ?? 'unknown');
    throw new ReleaseError(GATE_FAILED, 'test candidate could not be read', {
      reason,
      field: 'candidatePath',
      cause: kind ?? 'unknown',
    });
  }
  let candidate;
  try {
    candidate = JSON.parse(receipt.content);
  } catch {
    throw new ReleaseError(CONFIG_INVALID, 'test candidate is not valid JSON', {
      field: 'candidatePath',
    });
  }
  if (!validateCandidate(candidate)) schemaFailure(validateCandidate);
  forbidPreparedKeys(candidate.prepared);
  return { candidate, sha256: receipt.sha256, candidatePath: rel };
}

/**
 * Read the first run's candidate digest from evidence.jsonl.
 * Missing evidence returns null. This reader does not run git.
 *
 * @param {string} root
 * @param {string} candidatePath
 * @returns {Promise<string|null>}
 */
export async function readCandidateEvidenceSha256(root, candidatePath) {
  const rel = canonicalCandidatePath(root, candidatePath);
  const evidenceRel = rel.replace(/\/test-candidate\.json$/, '/evidence.jsonl');
  let receipt;
  try {
    receipt = await readFileStrict(root, evidenceRel, { encoding: 'utf8' });
  } catch (err) {
    if (harnessKind(err) === HARNESS_ERROR_KINDS.MISSING_RESOURCE) return null;
    throw new ReleaseError(GATE_FAILED, 'test candidate evidence could not be read', {
      reason: 'TEST_CANDIDATE_EVIDENCE_MISSING',
      cause: harnessKind(err) ?? 'unknown',
    });
  }
  let sha = null;
  for (const line of receipt.content.split('\n')) {
    if (!line.trim()) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event?.phase === 'test-candidate' && event?.status === 'saved') {
      const found = event.details?.candidateSha256;
      if (typeof found === 'string' && found.length > 0) sha = found;
    }
  }
  return sha;
}

function sameStringList(left, right) {
  const a = [...(left ?? [])].sort();
  const b = [...(right ?? [])].sort();
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function sameVersions(left, right) {
  const leftKeys = Object.keys(left ?? {}).sort();
  const rightKeys = Object.keys(right ?? {}).sort();
  if (leftKeys.join('\0') !== rightKeys.join('\0')) return false;
  return leftKeys.every((key) => left[key] === right[key]);
}

function targetVersionsOf(plan) {
  return [...new Set((Array.isArray(plan?.units) ? plan.units : [])
    .map((unit) => unit?.targetVersion)
    .filter((version) => typeof version === 'string' && version.length > 0))];
}

function sameTargetVersions(left, right) {
  return left.length === right.length && left.every((version) => right.includes(version));
}

/**
 * Formal plans under `.release-skill/plans`. The convenience pointer is not
 * an acceptance basis. Does not run git.
 *
 * @param {string} root
 */
async function readFormalPlans(root) {
  const plansPath = resolve(root, '.release-skill', 'plans');
  let names;
  try {
    names = await readdir(plansPath);
  } catch (err) {
    if (err?.code === 'ENOENT') {
      try {
        await lstat(plansPath);
      } catch (statError) {
        if (statError?.code === 'ENOENT') return [];
        throw new ReleaseError(CONFIG_INVALID, 'formal test acceptance plans could not be read', {
          reason: 'TEST_CANDIDATE_AUTHORITY_INVALID',
          field: 'plansPath',
          cause: statError?.code ?? 'unknown',
        });
      }
    }
    throw new ReleaseError(CONFIG_INVALID, 'formal test acceptance plans could not be read', {
      reason: 'TEST_CANDIDATE_AUTHORITY_INVALID',
      field: 'plansPath',
      cause: err?.code ?? 'unknown',
    });
  }
  const plans = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const rel = `.release-skill/plans/${name}`;
    let receipt;
    try {
      receipt = await readFileStrict(root, rel, { encoding: 'utf8' });
    } catch (err) {
      const cause = harnessKind(err) ?? 'unknown';
      throw new ReleaseError(CONFIG_INVALID, 'formal test acceptance plan could not be read', {
        reason: 'TEST_CANDIDATE_AUTHORITY_INVALID',
        field: 'planPath',
        path: rel,
        cause,
      });
    }
    let plan;
    try {
      plan = JSON.parse(receipt.content);
    } catch {
      throw new ReleaseError(CONFIG_INVALID, 'formal test acceptance plan is not valid JSON', {
        reason: 'TEST_CANDIDATE_AUTHORITY_INVALID',
        field: 'planPath',
        path: rel,
      });
    }
    plans.push({
      planPath: rel,
      planDigest: typeof plan?.digest === 'string' ? plan.digest : name.slice(0, -'.json'.length),
      status: plan?.status,
      subjectDigest: typeof plan?.testAcceptance?.subjectDigest === 'string'
        ? plan.testAcceptance.subjectDigest
        : null,
      targetVersions: targetVersionsOf(plan),
    });
  }
  return plans;
}

async function sameAuthorityFile(left, right) {
  const identity = async (value) => {
    const absolute = resolve(value);
    try {
      return await realpath(absolute);
    } catch {
      return absolute;
    }
  };
  return (await identity(left)) === (await identity(right));
}

async function authoritativeRunStatus(root, hit, targetVersions) {
  const targetVersion = targetVersions.length === 1 ? targetVersions[0] : undefined;
  let routing;
  try {
    const { readRunRouting } = await import('../commands/route.mjs');
    routing = await readRunRouting(root, targetVersion ? { targetVersion } : {});
  } catch {
    return hit.status;
  }
  const formal = resolve(root, hit.planPath);
  const bound = [];
  for (const run of routing?.observedRuns ?? []) {
    if (!run?.planPath || !run.status) continue;
    if (await sameAuthorityFile(run.planPath, formal)) bound.push(run);
  }
  // A finished verify sits beside its PUBLISHED parent. The parent is lineage,
  // not a second acceptance status. postverify is a later local finishing
  // fact: a completed DISTRIBUTED leaf must not replace VERIFIED or ask for
  // a new approval, and a failed or unfinished postverify must not be
  // reported as DISTRIBUTED. It is not a ship terminal status.
  const releaseRuns = bound.filter((run) => run.command !== 'postverify');
  const leaves = [];
  for (const run of releaseRuns) {
    let ancestor = false;
    for (const child of releaseRuns) {
      if (child === run || !child.sourceRunPath || !run.runPath) continue;
      if (await sameAuthorityFile(child.sourceRunPath, run.runPath)) {
        ancestor = true;
        break;
      }
    }
    if (!ancestor) leaves.push(run.status);
  }
  const statuses = [...new Set(leaves)];
  if (statuses.length > 1) {
    throw new ReleaseError(GATE_FAILED, 'formal plan runs disagree on the authoritative status', {
      reason: 'TEST_CANDIDATE_REPREPARE',
      drifts: ['acceptance-basis'],
      statuses,
    });
  }
  return statuses.length === 1 ? statuses[0] : hit.status;
}

/**
 * Plans already accepted for this subject. Does not run git.
 *
 * @param {string} root
 * @param {string} subjectDigest
 * @returns {Promise<Array<{ planPath: string, planDigest: string, status: string }>>}
 */
export async function locateAcceptedPlans(root, subjectDigest) {
  const plans = await readFormalPlans(root);
  return plans
    .filter((plan) => plan.subjectDigest === subjectDigest)
    .map(({ planPath, planDigest, status }) => ({ planPath, planDigest, status }));
}

/**
 * Pure handoff over already loaded documents. Does not run git and does not
 * allocate a second candidate on reattach.
 */
export async function decideTestCandidateHandoff({
  root,
  runDir,
  config,
  production,
  candidatePath,
  prepared,
  requirements,
  prepareOptions,
  evidenceCandidateSha256,
  expectedCandidateSha256,
  expectedSubjectDigest,
  configDigest,
  extraDrifts = [],
}) {
  if (!config?.testIntake) {
    if (candidatePath) {
      throw new ReleaseError(CONFIG_INVALID, 'candidate path requires testIntake', {
        reason: 'TEST_CANDIDATE_WITHOUT_INTAKE',
        field: 'candidatePath',
      });
    }
    return { kind: 'legacy', writePlan: true, rebuild: true };
  }
  if (production !== true) {
    throw new ReleaseError(CONFIG_INVALID, 'testIntake is unsupported outside production prepare', {
      reason: 'TEST_INTAKE_NON_PRODUCTION',
      field: 'testIntake',
    });
  }
  if (!candidatePath) {
    const saved = await writeTestCandidate({ root, runDir, prepared, requirements, prepareOptions });
    const subjectDigest = computePlanDigest(saved.candidate.prepared);
    return {
      kind: 'save-candidate',
      status: 'NEEDS_INPUT',
      writePlan: false,
      rebuild: false,
      code: 'GATE_FAILED',
      candidatePath: saved.candidatePath,
      candidateSha256: saved.sha256,
      subjectDigest,
    };
  }

  const loaded = await readTestCandidate({ root, candidatePath });
  if (expectedCandidateSha256 && expectedCandidateSha256 !== loaded.sha256) {
    throw new ReleaseError(GATE_FAILED, 'test candidate digest does not match the ship record', {
      reason: 'TEST_CANDIDATE_DIGEST_MISMATCH',
      field: 'candidatePath',
    });
  }
  if (!evidenceCandidateSha256) {
    throw new ReleaseError(GATE_FAILED, 'test candidate evidence digest is missing', {
      reason: 'TEST_CANDIDATE_EVIDENCE_MISSING',
      field: 'candidatePath',
    });
  }
  if (evidenceCandidateSha256 !== loaded.sha256) {
    throw new ReleaseError(GATE_FAILED, 'test candidate evidence digest does not match the candidate bytes', {
      reason: 'TEST_CANDIDATE_DIGEST_MISMATCH',
      field: 'candidatePath',
    });
  }

  const options = loaded.candidate.prepareOptions;
  const drifts = [...extraDrifts];
  if (loaded.candidate.writerVersion !== WRITER_VERSION) drifts.push('writerVersion');
  if (loaded.candidate.prepared?.configDigest !== configDigest) drifts.push('configDigest');
  const requirementsRef = fileRefOf(requirements);
  if (requirementsRef.sha256 !== loaded.candidate.requirements.sha256) drifts.push('requirements.sha256');
  if (requirementsRef.path !== loaded.candidate.requirements.path) drifts.push('requirements.path');
  if (prepareOptions.workflow !== options.workflow) drifts.push('prepareOptions.workflow');
  if (prepareOptions.offline !== options.offline) drifts.push('prepareOptions.offline');
  if (prepareOptions.production !== options.production) drifts.push('prepareOptions.production');
  if (!sameStringList(prepareOptions.unitIds, options.unitIds)) drifts.push('prepareOptions.unitIds');
  if (!sameVersions(prepareOptions.unitVersions, options.unitVersions)) drifts.push('prepareOptions.unitVersions');
  if (drifts.length > 0) {
    throw new ReleaseError(GATE_FAILED, `test candidate requires a new prepare: ${drifts.join(', ')}`, {
      reason: 'TEST_CANDIDATE_REPREPARE',
      drifts,
    });
  }

  const subjectDigest = computePlanDigest(loaded.candidate.prepared);
  if (expectedSubjectDigest && expectedSubjectDigest !== subjectDigest) {
    throw new ReleaseError(GATE_FAILED, 'test candidate subjectDigest does not match the ship record', {
      reason: 'TEST_CANDIDATE_DIGEST_MISMATCH',
      field: 'subjectDigest',
    });
  }

  const formalPlans = await readFormalPlans(root);
  const targetVersions = targetVersionsOf(loaded.candidate.prepared);
  const differentBasis = formalPlans.filter((plan) => (
    sameTargetVersions(plan.targetVersions, targetVersions) && plan.subjectDigest !== subjectDigest
  ));
  if (differentBasis.length > 0) {
    throw new ReleaseError(GATE_FAILED, 'a different formal acceptance basis already exists for this target', {
      reason: 'TEST_CANDIDATE_REPREPARE',
      drifts: ['acceptance-basis'],
      planPaths: differentBasis.map((plan) => plan.planPath),
    });
  }
  const hits = formalPlans.filter((plan) => plan.subjectDigest === subjectDigest);
  if (hits.length > 1) {
    throw new ReleaseError(GATE_FAILED, 'multiple formal plans match this test candidate subject', {
      reason: 'TEST_CANDIDATE_REPREPARE',
      drifts: ['multiple-accepted-plans'],
    });
  }
  if (hits.length === 1) {
    return {
      kind: 'already-accepted',
      status: await authoritativeRunStatus(root, hits[0], targetVersions),
      writePlan: false,
      rebuild: false,
      planPath: hits[0].planPath,
      planDigest: hits[0].planDigest,
      candidatePath: loaded.candidatePath,
      candidateSha256: loaded.sha256,
      subjectDigest,
    };
  }

  const acceptance = await acceptTestResults({
    root,
    requirements,
    prepared: loaded.candidate.prepared,
  });
  if (!acceptance.accepted) {
    return {
      kind: 'await-results',
      status: 'NEEDS_INPUT',
      writePlan: false,
      rebuild: false,
      code: 'GATE_FAILED',
      candidatePath: loaded.candidatePath,
      candidateSha256: loaded.sha256,
      subjectDigest,
      gaps: acceptance.gaps,
    };
  }
  return {
    kind: 'accept',
    status: 'PREPARED',
    writePlan: true,
    rebuild: false,
    testAcceptance: acceptance.testAcceptance,
    prepared: loaded.candidate.prepared,
    candidatePath: loaded.candidatePath,
    candidateSha256: loaded.sha256,
    subjectDigest,
  };
}

/**
 * Ship continuation for a persisted NEW record. Terminal external successes
 * are never reattached.
 */
export function resolveShipCandidateContinuation({ state, loadedConfigDigest, requestedUnitIds }) {
  if (TERMINAL_SHIP_STATUSES.has(state?.status)) {
    return { kind: 'leave-external-success', rebuild: false };
  }
  if (state?.status !== 'NEW' || !state.testCandidate) {
    return { kind: 'legacy-new', rebuild: true, refreshConfigDigest: true };
  }
  if (state.configDigest !== loadedConfigDigest) {
    return { kind: 'conflict', rebuild: false, reason: 'TEST_CANDIDATE_CONFIG_CONFLICT' };
  }
  if (requestedUnitIds !== undefined) {
    if (!sameStringList(requestedUnitIds, state.selectedUnitIds ?? [])) {
      return { kind: 'conflict', rebuild: false, reason: 'TEST_CANDIDATE_UNIT_CONFLICT' };
    }
  }
  return {
    kind: 'reattach',
    rebuild: false,
    refreshConfigDigest: false,
    candidatePath: state.testCandidate.path,
    candidateSha256: state.testCandidate.sha256,
    subjectDigest: state.testCandidate.subjectDigest,
  };
}

/**
 * Map a prepare return onto the persisted ship record.
 * NEEDS_INPUT stays NEW and keeps the same candidate.
 * PARTIAL, PUBLISHED, and VERIFIED keep that external status and the candidate.
 */
export function applyShipPrepareOutcome(state, prepared) {
  if (prepared?.status === 'NEEDS_INPUT') {
    const next = {
      ...state,
      status: 'NEW',
      testCandidate: prepared.testCandidate ?? state.testCandidate ?? {
        path: prepared.candidatePath,
        sha256: prepared.candidateSha256,
        subjectDigest: prepared.subjectDigest,
        evidenceDir: prepared.evidenceDir,
      },
      pendingTestRequirements: prepared.requirements ?? prepared.pendingTestRequirements ?? state.pendingTestRequirements,
    };
    delete next.planPath;
    delete next.planDigest;
    return next;
  }
  if (TERMINAL_SHIP_STATUSES.has(prepared?.status)) {
    return {
      ...state,
      status: prepared.status,
      planPath: prepared.planPath,
      planDigest: prepared.planDigest,
      evidenceDir: prepared.evidenceDir ?? state.evidenceDir,
      warnings: prepared.warnings ?? state.warnings,
    };
  }
  const next = {
    ...state,
    status: 'NEEDS_PLAN_APPROVAL',
    planPath: prepared.planPath,
    planDigest: prepared.planDigest,
    evidenceDir: prepared.evidenceDir ?? state.evidenceDir,
    warnings: prepared.warnings ?? state.warnings,
  };
  delete next.testCandidate;
  delete next.pendingTestRequirements;
  return next;
}
