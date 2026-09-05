/** Best-effort cleanup of superseded, complete production run lineages. */

import { lstat, readFile, readdir, realpath, rm as fsRm } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { resolveContained } from 'skill-family-harness-node';
import { assertImmutablePlanAuthority, computePlanDigest, validatePlan } from './plan.mjs';
import { loadRun, validateRunCheckpointMapping, validateRunLineage, validateRunPlanDigest } from './run.mjs';
import { normalizePostPublishView, postPublishActionId } from './postpublish.mjs';

const NON_TERMINAL = new Set(['PUBLISHING', 'PARTIAL', 'NEEDS_INPUT', 'BLOCKED', 'DISTRIBUTING']);
const COMPLETED_CHECKPOINTS = new Set(['succeeded', 'skipped']);

function validDirectName(name) {
  return typeof name === 'string' && name.length > 0 && name !== '.' && name !== '..'
    && !isAbsolute(name) && !name.includes('/') && !name.includes('\\');
}

async function jsonFile(path) {
  try { return JSON.parse(await readFile(path, 'utf8')); } catch { return null; }
}

async function physicalContained(root, declaredPath) {
  if (typeof declaredPath !== 'string' || !isAbsolute(declaredPath)) return null;
  const lexicalRoot = resolve(root);
  const physicalRoot = await realpath(lexicalRoot);
  const lexical = relative(lexicalRoot, resolve(declaredPath));
  if (!lexical || isAbsolute(lexical) || lexical === '..' || lexical.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)) return null;
  try {
    const contained = await resolveContained(lexicalRoot, lexical);
    const target = await realpath(contained);
    const targetRel = relative(physicalRoot, target);
    if (!targetRel || isAbsolute(targetRel) || targetRel === '..' || targetRel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)) return null;
    return target;
  } catch { return null; }
}

async function loadPlanFromRun(releaseDir, run) {
  if (!run?.planPath) return null;
  const planPath = await physicalContained(releaseDir, run.planPath);
  if (!planPath || basename(dirname(planPath)) !== 'plans') return null;
  const plan = await jsonFile(planPath);
  if (!plan) return null;
  try {
    validatePlan(plan);
    assertImmutablePlanAuthority(planPath, plan);
    const digest = computePlanDigest(plan);
    if (run.planDigest !== digest || basename(planPath) !== `${digest}.json`) return null;
    return { plan, planPath, digest };
  } catch { return null; }
}

function postVerifyActions(plan) {
  return normalizePostPublishView(plan).flatMap((declaration) => (
    (declaration.hooks ?? []).filter((hook) => hook.phase === 'postVerify').map((hook) => ({
      id: postPublishActionId({ planVersion: plan.planVersion, unitId: declaration.unitId, localId: hook.id }),
      type: 'postpublish-hook',
    }))
  ));
}

function postVerificationComplete(run) {
  return run.checkpoints.every((checkpoint) => (
    checkpoint.status === 'succeeded' || checkpoint.status === 'NO_CHANGE'
  ));
}

function publicationComplete(run) {
  return run.checkpoints.every((cp) => COMPLETED_CHECKPOINTS.has(cp.status)
    || (['failed', 'deferred'].includes(cp.status)
      && ['claude-marketplace-install', 'codex-marketplace-install', 'kimi-marketplace-install', 'codebuddy-marketplace-install'].includes(cp.actionType)));
}

async function lineagePathsContained(run, runsRoot) {
  let cursor = run;
  for (let depth = 0; depth < 32; depth += 1) {
    if (!cursor.sourceRunPath) return true;
    const sourcePath = await physicalContained(runsRoot, cursor.sourceRunPath);
    if (!sourcePath) return false;
    cursor = await loadRun(sourcePath, { requireDigest: true });
  }
  return false;
}

async function validatePublicationCheckpoints(run, plan, runsRoot) {
  let cursor = run;
  for (let depth = 0; depth < 32; depth += 1) {
    if (cursor.command === 'publish') {
      validateRunCheckpointMapping(cursor, plan.externalActions ?? []);
      return cursor.status === 'PUBLISHED' ? publicationComplete(cursor) : true;
    }
    if (!cursor.sourceRunPath) return false;
    const sourcePath = await physicalContained(runsRoot, cursor.sourceRunPath);
    if (!sourcePath) return false;
    cursor = await loadRun(sourcePath, { requireDigest: true });
    if (cursor.command === 'reconcile') validateRunCheckpointMapping(cursor, plan.externalActions ?? []);
  }
  return false;
}

async function validateTerminal({ candidate, planInfo, runsRoot }) {
  const { run, runPath } = candidate;
  if (!run || !planInfo) return false;
  const { plan, planPath } = planInfo;
  try {
    if (!(await lineagePathsContained(run, runsRoot))) return false;
    await validateRunLineage(run, { plan, planPath, runPath, production: Boolean(plan.production) });
    validateRunPlanDigest(run, plan, { planPath });
    if (run.command === 'verify' && run.status === 'VERIFIED') {
      return validatePublicationCheckpoints(run, plan, runsRoot);
    }
    if (run.command !== 'postverify' || run.status !== 'DISTRIBUTED') return false;
    validateRunCheckpointMapping(run, postVerifyActions(plan));
    return postVerificationComplete(run)
      && validatePublicationCheckpoints(run, plan, runsRoot);
  } catch { return false; }
}

async function scanCandidate(runsRoot, name) {
  const dir = join(runsRoot, name);
  const summary = await jsonFile(join(dir, 'summary.json'));
  const runPath = join(dir, 'release-run.json');
  let run = null;
  let runExists = false;
  let runCorrupt = false;
  try {
    const stat = await lstat(runPath);
    runExists = true;
    if (stat.isSymbolicLink() || !stat.isFile()) runCorrupt = true;
    else run = await loadRun(runPath, { requireDigest: true });
  } catch { if (runExists) runCorrupt = true; }
  const statesExists = await lstat(join(dir, 'states')).then(() => true).catch(() => false);
  let sealedFailedPrepare = false;
  if (summary?.status === 'FAILED' && !runExists) {
    try {
      const evidence = await readFile(join(dir, 'evidence.jsonl'), 'utf8');
      sealedFailedPrepare = evidence.split('\n').some((line) => JSON.parse(line)?.command === 'prepare');
    } catch { sealedFailedPrepare = false; }
  }
  return {
    dir, name, summary, run, runPath, runExists, runCorrupt, statesExists, sealedFailedPrepare,
    planDigest: run?.planDigest ?? summary?.planDigest ?? null,
  };
}

async function deleteCandidate(runsRoot, candidate, rmFn) {
  const contained = await physicalContained(runsRoot, join(runsRoot, candidate.name));
  const physicalRoot = await realpath(runsRoot);
  if (!contained || dirname(contained) !== physicalRoot) throw new Error('run path containment failed');
  const stat = await lstat(contained);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('run candidate is not a real directory');
  await rmFn(contained, { recursive: true, force: false });
}

/** @returns {Promise<{scanned:number,deleted:number,errors:number,diagnostics:Array}>} */
export async function cleanupRunRetention({ releaseDir, currentRunDir, rmFn = fsRm } = {}) {
  const result = { scanned: 0, deleted: 0, errors: 0, diagnostics: [] };
  if (!releaseDir) return result;
  const runsRoot = resolve(releaseDir, 'runs');
  let rootStat;
  try { rootStat = await lstat(runsRoot); } catch { return result; }
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) return result;
  const physicalRunsRoot = await realpath(runsRoot).catch(() => null);
  if (!physicalRunsRoot) return result;
  let entries;
  try { entries = await readdir(physicalRunsRoot, { withFileTypes: true }); } catch { return result; }
  const candidates = [];
  for (const entry of entries) {
    result.scanned += 1;
    if (!entry.isDirectory() || entry.isSymbolicLink() || !validDirectName(entry.name)) continue;
    candidates.push(await scanCandidate(physicalRunsRoot, entry.name));
  }
  const protectedNames = new Set();
  if (currentRunDir) protectedNames.add(basename(resolve(currentRunDir)));
  const currentPlan = await jsonFile(join(releaseDir, 'release-plan.json'));
  let currentPlanDigest = null;
  try { if (currentPlan) currentPlanDigest = computePlanDigest(currentPlan); } catch { currentPlanDigest = null; }
  const groups = new Map();
  for (const candidate of candidates) {
    if (!candidate.planDigest) continue;
    if (!groups.has(candidate.planDigest)) groups.set(candidate.planDigest, []);
    groups.get(candidate.planDigest).push(candidate);
    if (currentPlanDigest && candidate.planDigest === currentPlanDigest) protectedNames.add(candidate.name);
  }
  const completeGroups = [];
  for (const [planDigest, group] of groups) {
    const authority = group.find((item) => item.run?.planDigest === planDigest);
    const planInfo = authority ? await loadPlanFromRun(releaseDir, authority.run) : null;
    const requiresPostVerify = Boolean(planInfo && normalizePostPublishView(planInfo.plan)
      .some((declaration) => (declaration.hooks ?? []).some((hook) => hook.phase === 'postVerify')));
    const terminals = group.filter((item) => requiresPostVerify
      ? item.run?.status === 'DISTRIBUTED'
      : item.run?.status === 'VERIFIED');
    const terminalResults = planInfo
      ? await Promise.all(terminals.map((item) => validateTerminal({ candidate: item, planInfo, runsRoot })))
      : [];
    const terminalValid = terminalResults.some(Boolean);
    const unsafe = group.some((item) => item.runCorrupt
      || (!item.run && item.summary?.status !== 'PREPARED')
      || (item.run && NON_TERMINAL.has(item.run.status))
      || (item.run?.status === 'PUBLISHED' && !publicationComplete(item.run))
      || (item.run && ((requiresPostVerify && item.run.status === 'DISTRIBUTED')
        || (!requiresPostVerify && item.run.status === 'VERIFIED'))
        && !terminalResults[terminals.indexOf(item)]));
    if (!terminalValid || unsafe) {
      for (const item of group) protectedNames.add(item.name);
    } else {
      completeGroups.push({ group, createdAt: planInfo.plan.createdAt ?? '', planDigest });
    }
  }
  completeGroups.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)) || b.planDigest.localeCompare(a.planDigest));
  for (const old of completeGroups.slice(1)) {
    for (const item of old.group) {
      if (protectedNames.has(item.name)) continue;
      try { await deleteCandidate(physicalRunsRoot, item, rmFn); result.deleted += 1; }
      catch (error) { result.errors += 1; result.diagnostics.push({ name: item.name, code: error?.code ?? 'RUN_RETENTION_DELETE_FAILED' }); }
    }
  }
  for (const candidate of candidates) {
    const hasPlanTrace = Boolean(candidate.planDigest || candidate.summary?.planPath || candidate.summary?.externalActions || candidate.summary?.checkpoints);
    const isFailedPrepare = candidate.name.startsWith('prepare-') && candidate.summary?.status === 'FAILED'
      && candidate.sealedFailedPrepare && !candidate.runExists && !candidate.statesExists && !hasPlanTrace;
    if (!isFailedPrepare || protectedNames.has(candidate.name)) continue;
    try { await deleteCandidate(physicalRunsRoot, candidate, rmFn); result.deleted += 1; }
    catch (error) { result.errors += 1; result.diagnostics.push({ name: candidate.name, code: error?.code ?? 'RUN_RETENTION_DELETE_FAILED' }); }
  }
  return result;
}
