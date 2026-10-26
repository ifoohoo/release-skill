import { readdir, lstat, realpath } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { readTrustedPackageResourceSync } from './trusted-resource.mjs';
import { resolve, relative, sep, join } from 'node:path';
import { readFileStrict } from 'skill-family-harness-node';
import { validatePlan, computePlanDigest, assertImmutablePlanAuthority } from './plan.mjs';
import { canonicalJson } from './digest.mjs';
import { verifyTestAcceptance, normalizeIntakePath } from './test-intake.mjs';
import { loadRun, validateRunLineage, validateRunCheckpointMapping } from './run.mjs';
import { readRunRecovery } from './recovery.mjs';
import { isMarketplaceAction } from './checkpoints.mjs';
import { isProvenPreAuthorityFailure } from './pre-authority-failure.mjs';
import { ReleaseError, GATE_FAILED, CONFIG_INVALID } from './errors.mjs';

const unitIdSchema = JSON.parse(readTrustedPackageResourceSync('schemas/release-plan.schema.json').toString('utf8')).properties.units.items.properties.id;
const historyAjv = new Ajv({ strict: false });
addFormats(historyAjv);
const validUnitId = historyAjv.compile(unitIdSchema);
const validHistoryEvent = historyAjv.compile(JSON.parse(readTrustedPackageResourceSync('schemas/evidence-event-v2.schema.json').toString('utf8')));

function refused(message, details = {}) {
  throw new ReleaseError(GATE_FAILED, message, { reason: 'UNPUBLISHED_PLAN_REPLACEMENT_REFUSED', ...details });
}

export function canonicalFormalPlanPath(root, input) {
  if (typeof input !== 'string' || !input) refused('replacement requires an immutable plan path');
  // Resolve only the caller's project root. Project-owned authority components
  // are still read through readFileStrict and must never be realpath-washed.
  const physicalRoot = realpathSync(resolve(root));
  const selected = resolve(root, input);
  const anchor = `${sep}.release-skill${sep}`;
  const index = selected.lastIndexOf(anchor);
  if (index < 0 || realpathSync(selected.slice(0, index) || sep) !== physicalRoot) {
    refused('replacement plan must belong to this project immutable plans directory');
  }
  const rel = selected.slice(index + 1).split(sep).join('/');
  if (!/^\.release-skill\/plans\/[a-f0-9]{64}\.json$/.test(rel)) {
    refused('replacement plan must belong to this project immutable plans directory');
  }
  return rel;
}

async function readPlan(root, rel, currentSchema = true) {
  try {
    const entry = await lstat(resolve(root, rel));
    if (entry.isSymbolicLink() || !entry.isFile()) refused('formal plan authority must be an ordinary file', { path: rel });
    const receipt = await readFileStrict(root, rel, { encoding: 'utf8' });
    const plan = JSON.parse(receipt.content);
    targetVersions(plan);
    if (currentSchema) validatePlan(plan);
    assertImmutablePlanAuthority(resolve(root, rel), plan);
    if (rel !== `.release-skill/plans/${plan.digest}.json` || computePlanDigest(plan) !== plan.digest) refused('formal plan digest is invalid', { path: rel });
    return plan;
  } catch (error) {
    throw new ReleaseError(CONFIG_INVALID, 'formal plan authority is invalid', {
      reason: 'TEST_CANDIDATE_AUTHORITY_INVALID', path: rel, cause: error.code ?? error.message,
    });
  }
}

// This is target attribution only. It never certifies a legacy plan against a
// guessed historical schema or grants an unrelated record release authority.
function targetVersions(plan) {
  if (!plan || typeof plan !== 'object' || Array.isArray(plan) || !Array.isArray(plan.units) || plan.units.length === 0) {
    refused('formal plan target data is incomplete');
  }
  const byUnit = new Map();
  for (const unit of plan.units) {
    if (!unit || typeof unit !== 'object' || Array.isArray(unit)
      || !validUnitId(unit.id)
      || typeof unit.targetVersion !== 'string' || !unit.targetVersion || unit.targetVersion.trim() !== unit.targetVersion
      || byUnit.has(unit.id) || (Object.hasOwn(unit, 'version') && unit.version !== unit.targetVersion)) {
      refused('formal plan target data is malformed, duplicate or conflicting');
    }
    byUnit.set(unit.id, unit.targetVersion);
  }
  const versions = [...new Set(byUnit.values())].sort();
  if ((Object.hasOwn(plan, 'targetVersion') && (versions.length !== 1 || plan.targetVersion !== versions[0]))
    || (Object.hasOwn(plan, 'targetVersions') && (!Array.isArray(plan.targetVersions)
      || canonicalJson([...plan.targetVersions].sort()) !== canonicalJson(versions)))) {
    refused('formal plan explicit target versions conflict');
  }
  if (Object.hasOwn(plan, 'externalActions')) {
    if (!Array.isArray(plan.externalActions)) refused('formal plan external target data is malformed');
    for (const action of plan.externalActions) {
      if (!action || typeof action !== 'object' || Array.isArray(action)) refused('formal plan external target data is malformed');
      for (const value of [action.parameters, action.expected]) {
        if (value && Object.hasOwn(value, 'version') && value.version !== byUnit.get(action.unitId)) {
          refused('formal plan external target version conflicts with its unit');
        }
      }
    }
  }
  return versions;
}

export async function readFormalPlans(root, currentPlan) {
  root = await realpath(root);
  let names;
  try {
    for (const directory of ['.release-skill', '.release-skill/plans']) {
      const entry = await lstat(resolve(root, directory));
      if (entry.isSymbolicLink() || !entry.isDirectory()) refused('formal plan authority contains a symlink or non-directory');
    }
    names = await readdir(resolve(root, '.release-skill/plans'));
  }
  catch (error) {
    if (error.code === 'ENOENT') return [];
    throw new ReleaseError(CONFIG_INVALID, 'formal plans directory is invalid', { reason: 'TEST_CANDIDATE_AUTHORITY_INVALID', cause: error.code });
  }
  const plans = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    let rel;
    try { rel = canonicalFormalPlanPath(root, `.release-skill/plans/${name}`); }
    catch (error) { throw new ReleaseError(CONFIG_INVALID, 'formal plan filename is invalid', { reason: 'TEST_CANDIDATE_AUTHORITY_INVALID', cause: error.message }); }
    const plan = await readPlan(root, rel, false);
    plans.push({ planPath: rel, planDigest: plan.digest, status: plan.status,
      subjectDigest: plan.testAcceptance?.subjectDigest ?? null,
      targetVersions: targetVersions(plan), plan });
  }
  const byDigest = new Map(plans.map((p) => [p.planDigest, p]));
  const currentTargets = currentPlan ? targetVersions(currentPlan) : [];
  const required = new Set();
  for (const entry of plans) {
    if (Object.hasOwn(entry.plan, 'testAcceptance') || Object.hasOwn(entry.plan, 'replacesPlanDigest')
      || entry.targetVersions.some((version) => currentTargets.includes(version))) required.add(entry.planDigest);
    if (Object.hasOwn(entry.plan, 'replacesPlanDigest')) required.add(entry.plan.replacesPlanDigest);
  }
  for (const digest of required) {
    const entry = byDigest.get(digest);
    if (entry) validatePlan(entry.plan);
  }
  const successors = new Map();
  for (const entry of plans) {
    const parent = entry.plan.replacesPlanDigest;
    if (!parent) continue;
    if (parent === entry.planDigest || !byDigest.has(parent) || successors.has(parent)) {
      refused('formal replacement relationship is missing, self-referential or forked');
    }
    if (targetIdentity(entry.plan) !== targetIdentity(byDigest.get(parent).plan)) {
      refused('formal replacement changes release targets');
    }
    successors.set(parent, entry.planDigest);
  }
  for (const entry of plans) {
    const seen = new Set(); let cursor = entry.planDigest;
    while (cursor) {
      if (seen.has(cursor)) refused('formal replacement relationship contains a cycle');
      seen.add(cursor); cursor = byDigest.get(cursor)?.plan.replacesPlanDigest;
    }
  }
  return plans;
}

export async function assertPlanNotReplaced(root, plan, planPath) {
  if (planPath && plan.production) canonicalFormalPlanPath(root, planPath);
  const plans = await readFormalPlans(root, plan);
  if (plans.some((p) => p.plan.replacesPlanDigest === plan.digest)) {
    refused('release plan has been replaced', { planDigest: plan.digest });
  }
  return plans;
}

function targetIdentity(plan) {
  const destinationKeys = ['publicRepo', 'repo', 'branch', 'ref', 'tag', 'tagTemplate', 'package', 'registry',
    'version', 'marketplaceRepo', 'marketplaceBranch', 'marketplace', 'pluginName', 'platform', 'host',
    'publisher', 'access', 'provenance', 'githubHost', 'oldBranch', 'newBranch', 'consumer', 'plugin',
    'marketplaceSource', 'marketplaceSourceType', 'marketplaceForm'];
  const destinations = (value = {}) => Object.fromEntries(destinationKeys.filter((k) => value[k] !== undefined).map((k) => [k, value[k]]));
  return canonicalJson({
    units: plan.units.map((u) => ({ id: u.id, targetVersion: u.targetVersion,
      ...destinations(u), distributions: (u.distributions ?? []).map((d) => ({ type: d.type, ...destinations(d) })) })).sort((a, b) => a.id.localeCompare(b.id)),
    actions: (plan.externalActions ?? []).map((a) => ({ id: a.id, type: a.type, ...destinations(a.parameters) })).sort((a, b) => a.id.localeCompare(b.id)),
    source: plan.sourceAuthority ? { sourceRepository: plan.sourceAuthority.sourceRepository, defaultBranch: plan.sourceAuthority.defaultBranch } : null,
  });
}

export function overlaps(left, right) {
  return left.units.some((a) => right.units.some((b) => a.id === b.id && a.targetVersion === b.targetVersion));
}

async function exists(path) {
  try { await lstat(path); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

async function validateBoundRun(root, path, oldPlan) {
  const initial = await loadRun(path, { requireDigest: true });
  const rel = canonicalFormalPlanPath(root, initial.planPath);
  const plan = await readPlan(root, rel);
  // Attribution consumes immutable run/plan lineage, not permission to retry
  // an unrelated historical release with an approval that may have expired.
  let run = initial;
  if (['publish', 'reconcile', 'verify'].includes(initial.command)) {
    await validateRunLineage(initial, { plan, planPath: initial.planPath, runPath: path, production: Boolean(plan.production) });
    let cursor = initial;
    for (;;) {
      validateRunCheckpointMapping(cursor, plan.externalActions ?? []);
      if (cursor.command === 'publish') break;
      cursor = await loadRun(cursor.sourceRunPath, { requireDigest: true });
    }
  } else {
    const recovery = initial.command === 'postverify'
      ? await (await import('../commands/route.mjs')).readLegacyPostverifyRecovery(path)
      : await readRunRecovery(path);
    if (!recovery.run || !recovery.plan || recovery.diagnostic) refused('run authority or lineage is invalid', { runPath: path, cause: recovery.diagnostic });
    run = recovery.run;
  }
  if (overlaps(plan, oldPlan)) refused('a release run authority already exists for the replacement target', { runPath: path });
  return { run, plan };
}

// These four failed writers have no final child authority. Their sealed
// prefixes attribute them to a complete, unrelated parent; this is not the
// publish pre-authority zero-write proof (verify may install an isolated consumer).
async function attributeHistoricalChild(root, name, events, summary, oldPlan) {
  const command = events[0]?.command;
  const producer = events[0]?.producer;
  const versions = command === 'reconcile' ? ['0.9.22', '0.9.27']
    : command === 'verify' ? ['0.9.7', '0.9.12'] : [];
  if (!versions.includes(producer?.version) || producer.name !== 'release-skill') return false;
  const terminal = events.at(-1);
  const failure = events.find((event) => event.status === 'failed');
  const recovery = command === 'reconcile' ? 'RECONCILE' : 'VERIFY';
  const summaryKeys = ['status', 'recoveryActionCode', 'error', 'details', 'failedAt', 'stablePhase', 'failedUnitId', 'failedHook', 'failedAction', 'evidenceSequence', 'evidencePath', 'producer'];
  if (!summary || Object.keys(summary).some((key) => !summaryKeys.includes(key))
    || summary.status !== 'FAILED' || summary.evidencePath !== 'evidence.jsonl'
    || summary.evidenceSequence !== failure?.sequence || summary.stablePhase !== failure?.phase
    || !Number.isFinite(Date.parse(summary.failedAt)) || Date.parse(summary.failedAt) < Date.parse(terminal?.timestamp) || !summary.error || typeof summary.error.code !== 'string'
    || typeof summary.error.message !== 'string' || canonicalJson(summary.producer) !== canonicalJson(producer)
    || canonicalJson(summary.details) !== canonicalJson({ recoveryActionCode: recovery })
    || summary.recoveryActionCode !== recovery || terminal?.phase !== command || terminal.status !== 'failed'
    || terminal.details?.recoveryActionCode !== recovery || canonicalJson(terminal.error) !== canonicalJson(summary.error)
    || !events.every((event, index) => validHistoryEvent(event) && event.command === command && event.runId === name
      && event.sequence === index + 1 && canonicalJson(event.producer) === canonicalJson(producer))) return false;
  const sourceLoads = events.filter((event) => event.phase === (command === 'verify' ? 'verify' : 'safety-gate')
    && event.status === 'passed' && (event.details?.step ?? event.details?.gate) === 'source-run-load');
  if (sourceLoads.length !== 1 || !/^[A-Za-z0-9._-]+$/.test(sourceLoads[0].details.sourceRunId)
    || ['.', '..'].includes(sourceLoads[0].details.sourceRunId)) return false;
  const sourceId = sourceLoads[0].details.sourceRunId;
  const { run: source, plan } = await validateBoundRun(root, join(root, '.release-skill/runs', sourceId, 'release-run.json'), oldPlan);
  if (source.runId !== sourceId) return false;
  const actions = new Map(plan.externalActions.map((action) => [action.id, action]));
  if (!events.every((event) => {
    const details = event.details ?? {};
    if (Object.hasOwn(details, 'sourceRunId') && details.sourceRunId !== sourceId) return false;
    if (Object.hasOwn(details, 'sourceRunDigest') && (command === 'verify' || details.sourceRunDigest !== source.runDigest)) return false;
    if (Object.hasOwn(details, 'actionId') || Object.hasOwn(details, 'actionType')) {
      const action = actions.get(details.actionId);
      return Boolean(action) && action.type === details.actionType;
    }
    return true;
  })) return false;
  let cursor = 0;
  const take = (phase, status, field, value) => {
    const event = events[cursor];
    if (!event || event.phase !== phase || event.status !== status || (field && event.details?.[field] !== value)) return false;
    cursor += 1; return true;
  };
  if (command === 'verify') {
    if (source.command !== 'publish' || source.status !== 'PUBLISHED'
      || !source.checkpoints.every((checkpoint) => ['succeeded', 'skipped'].includes(checkpoint.status)
        || isMarketplaceAction(checkpoint.actionType) && ['failed', 'deferred'].includes(checkpoint.status))
      || !take('verify', 'started', 'step', 'plan-load') || !take('verify', 'passed', 'step', 'plan-load')
      || !take('verify', 'started', 'step', 'source-run-load')
      || !take('source-authority-receipt', 'started') || !take('source-authority-receipt', 'passed')
      || !take('verify', 'passed', 'step', 'source-run-load') || !take('verify', 'started', 'step', 'adapter-verify')) return false;
    return events.slice(cursor, -1).length > 0 && events.slice(cursor, -1).every((event) =>
      Object.hasOwn(event.details ?? {}, 'actionId') && (
        event.phase === 'verify-marketplace-bootstrap-index' && ['observed', 'needs-input'].includes(event.status)
        || event.phase === 'verify-adapter' && event.status === 'PASSED_AUTOMATIC'
        || event.phase === 'verify-marketplace' && event.status === 'FAILED'));
  }
  for (const [gate, status] of [['plan-load', 'started'], ['plan-schema', 'passed'], ['plan-digest', 'started'],
    ['plan-digest', 'passed'], ['action-completeness', 'started'], ['action-completeness', 'passed']]) {
    if (!take('safety-gate', status, 'gate', gate)) return false;
  }
  for (const unit of plan.units.filter((unit) => unit.distributions?.some((dist) => dist.type === 'npm'))) {
    for (const status of ['started', 'passed']) {
      if (events[cursor]?.details?.unitId !== unit.id || !take('safety-gate', status, 'gate', 'npm-entry-closure')) return false;
    }
  }
  if (!take('safety-gate', 'started', 'gate', 'source-run-load') || !take('safety-gate', 'passed', 'gate', 'source-run-load')
    || !take('safety-gate', 'started', 'gate', 'baseline-check')) return false;
  if (events[cursor]?.phase === 'safety-gate' && events[cursor]?.status === 'warning') {
    if (!take('safety-gate', 'warning', 'gate', 'baseline-check')) return false;
  }
  if (!take('safety-gate', 'passed', 'gate', 'baseline-check')) return false;
  for (const unit of plan.units.filter((unit) => unit.previousPublicBaseline?.mode === 'bound')) {
    const event = events[cursor]; const baseline = unit.previousPublicBaseline;
    if (event?.details?.repo !== baseline.repo || event.details.ref !== baseline.ref
      || event.details.baselineCommit !== baseline.commit
      || !take('re-observe-previous-public-baseline', 'consistent-planned-successor')) return false;
  }
  if (!take('safety-gate', 'started', 'gate', 'adapter-availability') || !take('safety-gate', 'passed', 'gate', 'adapter-availability')
    || events[cursor]?.details?.actionCount !== actions.size
    || events[cursor]?.details?.sourceRunDigest !== source.runDigest || !take('reconcile', 'started')) return false;
  return events.slice(cursor, -1).length > 0 && events.slice(cursor, -1).every((event) =>
    Object.hasOwn(event.details ?? {}, 'actionId') && (
      event.phase === 'reconcile-observe' && event.status === 'observed'
      || event.phase === 'reconcile-observe-retry' && ['resolved', 'propagating'].includes(event.status)));
}

async function verifyHistory(root, oldPlan) {
  const runs = resolve(root, '.release-skill/runs');
  let names;
  try { names = await readdir(runs); }
  catch (error) { if (error.code === 'ENOENT') refused('old test candidate originals are missing'); throw error; }
  let originalCandidate = false;
  for (const name of names) {
    const dir = join(runs, name);
    const kind = await lstat(dir);
    if (kind.isSymbolicLink()) refused('run history contains a symbolic link', { runDirectory: name });
    if (!kind.isDirectory()) continue;
    if (await exists(join(dir, 'test-candidate.json'))) {
      const { readTestCandidate, readCandidateEvidenceSha256 } = await import('./test-candidate.mjs');
      const loaded = await readTestCandidate({ root, candidatePath: join(dir, 'test-candidate.json') });
      if (computePlanDigest(loaded.candidate.prepared) === oldPlan.testAcceptance.subjectDigest) {
        const evidenceDigest = await readCandidateEvidenceSha256(root, loaded.candidatePath);
        if (evidenceDigest !== loaded.sha256
          || canonicalJson(loaded.candidate.requirements) !== canonicalJson(oldPlan.testAcceptance.requirements)) {
          refused('old test candidate original or evidence has changed');
        }
        originalCandidate = true;
      }
    }
    const final = join(dir, 'release-run.json');
    if (await exists(final)) { await validateBoundRun(root, final, oldPlan); continue; }
    const states = join(dir, 'states');
    if (await exists(states)) {
      const slots = await readdir(states);
      if (!slots.length || slots.some((s) => !/^\d{6}\.json$/.test(s))) refused('unknown or incomplete run state authority');
      await validateBoundRun(root, join(states, slots.sort().at(-1)), oldPlan); continue;
    }
    if (!(await exists(join(dir, 'evidence.jsonl'))) && !(await exists(join(dir, 'summary.json')))) continue;
    const receipt = await readFileStrict(root, relative(root, join(dir, 'evidence.jsonl')).split(sep).join('/'), { encoding: 'utf8' });
    const events = receipt.content.trim().split('\n').filter(Boolean).map((s) => JSON.parse(s));
    if (events.length && events.every((e) => ['prepare', 'assess', 'hooks-validate', 'discover'].includes(e.command))) continue;
    // Existing candidate-only test streams have no release authority.
    if (events.length && events.every((e) => e.phase === 'test-candidate') && await exists(join(dir, 'test-candidate.json'))) continue;
    if (await isProvenPreAuthorityFailure(dir, name, { strictHistory: true })) continue;
    const summaryReceipt = await readFileStrict(root, relative(root, join(dir, 'summary.json')).split(sep).join('/'), { encoding: 'utf8' });
    const summary = JSON.parse(summaryReceipt.content);
    if (await attributeHistoricalChild(root, name, events, summary, oldPlan)) continue;
    refused('unbound run history cannot establish a safe replacement boundary', { runDirectory: name });
  }
  if (!originalCandidate) refused('old test candidate original is unavailable');
}

export async function bindReplacement({ root, prepared, replaceUnpublishedPlan, resultFile }) {
  const rel = replaceUnpublishedPlan !== undefined
    ? canonicalFormalPlanPath(root, replaceUnpublishedPlan)
    : prepared.replacesPlanDigest ? `.release-skill/plans/${prepared.replacesPlanDigest}.json` : null;
  if (!rel) return prepared;
  root = await realpath(root);
  const plans = await readFormalPlans(root, prepared);
  const previous = plans.find((p) => p.planPath === rel);
  if (!previous) refused('replacement predecessor is unavailable');
  if (prepared.replacesPlanDigest && prepared.replacesPlanDigest !== previous.planDigest) refused('replacement selection differs from frozen candidate');
  const body = { ...prepared, replacesPlanDigest: previous.planDigest };
  if (targetIdentity(previous.plan) !== targetIdentity(body)) refused('replacement must preserve release units, versions and external targets');
  if (previous.status !== 'PREPARED' || !previous.plan.testAcceptance) refused('only an accepted PREPARED plan can be replaced');
  if (plans.some((p) => p.plan.replacesPlanDigest === previous.planDigest)) refused('predecessor plan is already replaced');
  if (!resultFile || normalizeIntakePath(resultFile) === normalizeIntakePath(previous.plan.testAcceptance.result.path)) refused('replacement requires a different fixed resultFile');
  await verifyTestAcceptance({ root, plan: previous.plan });
  await verifyHistory(root, previous.plan);
  return body;
}
