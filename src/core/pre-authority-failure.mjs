import { readFile, lstat } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { resolveProducerVersion } from './evidence.mjs';

export async function isProvenPreAuthorityFailure(runDir, runName, { strictHistory = false } = {}) {
  if (!/^publish-/.test(runName)) return false;
  const summaryPath = join(runDir, 'summary.json');
  const evidencePath = join(runDir, 'evidence.jsonl');
  let summary;
  let events;
  try {
    summary = JSON.parse(await readFile(summaryPath, 'utf8'));
    events = (await readFile(evidencePath, 'utf8')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
  } catch {
    return false;
  }

  // The v1 writer (used before the producer-bound v2 envelope) created the
  // run directory and appended safety-gate events before its first
  // `release-run.json` state. A failed global preflight then appended only a
  // generic `publish` failure and sealed a summary. This branch deliberately
  // accepts that historical shape only when every byte still proves the same
  // pre-authority boundary. It never infers safety from a directory name,
  // mtime, summary alone, or a loosely similar phase.
  const legacyPreAuthorityPhases = new Set([
    'safety-gate',
    'global-preflight-arbitration',
    're-observe-previous-public-baseline',
  ]);
  const legacyInputFailure = /(?:global preflight failed|source authority .*failed|cannot read (?:release plan|approval record)|production (?:publish|commands) require|plan (?:digest mismatch|action completeness gate failed|is not valid|requires)|baseline (?:changed|check failed)|previous-public-baseline|adapter .*failed)/i;
  const legacyUnsafeFailure = /(?:remote (?:tag|branch|release) .*already exists|human intervention required|remote conflict|external write)/i;
  const legacyPreAuthorityGates = new Set([
    'plan-load',
    'plan-schema',
    'plan-digest',
    'action-completeness',
    'approval-load',
    'adapter-availability',
    'baseline-check',
    'source-authority',
  ]);
  const validLegacyTimestamp = (value) => typeof value === 'string'
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
    && Number.isFinite(Date.parse(value));
  const validLegacyError = (error) => error && typeof error === 'object' && !Array.isArray(error)
    && typeof error.code === 'string' && error.code.length > 0
    && (error.message === undefined || typeof error.message === 'string');
  const validLegacyEvent = (event, runId) => event && typeof event === 'object' && !Array.isArray(event)
    && event.schemaVersion === 1
    && !Object.hasOwn(event, 'producer')
    && typeof event.runId === 'string' && event.runId === runId
    && Number.isSafeInteger(event.sequence) && event.sequence >= 1
    && validLegacyTimestamp(event.timestamp)
    && event.command === 'publish'
    && typeof event.phase === 'string'
    && (legacyPreAuthorityPhases.has(event.phase) || event.phase === 'publish')
    && typeof event.status === 'string' && event.status.length > 0
    && (event.error === undefined || event.error === null || validLegacyError(event.error))
    && (event.duration === undefined || Number.isSafeInteger(event.duration) && event.duration >= 0)
    && (event.details === undefined || event.details !== null
      && typeof event.details === 'object' && !Array.isArray(event.details));
  const legacyRunId = basename(runDir);
  const legacyTerminal = events.at(-1);
  const legacyValid = summary && summary.status === 'FAILED'
    && validLegacyError(summary.error)
    && typeof summary.error.message === 'string' && legacyInputFailure.test(summary.error.message)
    && !legacyUnsafeFailure.test(summary.error.message)
    && (summary.recoveryActionCode === undefined || summary.recoveryActionCode === 'RETRY_COMMAND')
    && summary.runPath === undefined
    && summary.finalRunDigest === undefined
    && summary.latestStatePath === undefined
    && summary.checkpointStatuses === undefined
    && Array.isArray(events) && events.length >= 2
    && events.every((event, index) => validLegacyEvent(event, legacyRunId)
      && event.sequence === index + 1)
    && legacyTerminal.phase === 'publish'
    && legacyTerminal.status === 'failed'
    && validLegacyError(legacyTerminal.error)
    && legacyTerminal.error.code === summary.error.code
    && events.slice(0, -1).filter((event) => event.status === 'failed').every((event) =>
      event.phase === 'safety-gate'
      && legacyPreAuthorityGates.has(event.gate)
      && validLegacyError(event.error))
    && !events.some((event) => event.phase === 'global-preflight-arbitration'
      && event.status !== 'pre-observe')
    && !events.slice(0, -1).some((event) => event.phase === 'publish'
      || /checkpoint|execute|postpublish/i.test(event.phase)
      || Object.hasOwn(event, 'prePersistedRunPath')
      || Object.hasOwn(event, 'checkpointCount')
      || Object.hasOwn(event, 'checkpointStatuses'));
  if (legacyValid) return !strictHistory && await hasNoState(runDir);

  const producerVersion = summary?.producer?.version;
  const historical = ['0.9.3', '0.9.14', '0.9.17', '0.9.33', '0.9.37', '0.9.38'].includes(producerVersion);
  if (!historical && producerVersion !== resolveProducerVersion()) return false;
  const sameProducer = (value) => value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === 2
    && value.name === 'release-skill' && value.version === producerVersion;
  const envelopeKeys = new Set([
    'schemaVersion', 'runId', 'sequence', 'timestamp', 'command', 'producer',
    'phase', 'status', 'error', 'duration', 'details',
  ]);
  const validTimestamp = (value) => typeof value === 'string'
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
    && Number.isFinite(Date.parse(value));
  const detailValidators = {
    unitId: (value) => typeof value === 'string',
    gate: (value) => typeof value === 'string',
    hookName: (value) => typeof value === 'string',
    actionId: (value) => typeof value === 'string',
    step: (value) => typeof value === 'string',
    hookId: (value) => typeof value === 'string',
    tagCommit: (value) => typeof value === 'string',
    cached: (value) => typeof value === 'boolean',
    testSelection: (value) => typeof value === 'string',
    cacheKey: (value) => typeof value === 'string',
    durationMs: (value) => value === null || Number.isSafeInteger(value) && value >= 0,
    exitCode: (value) => Number.isSafeInteger(value),
    findingCount: (value) => Number.isSafeInteger(value) && value >= 0,
  };
  const validDetails = (value) => value === undefined
    || value !== null && typeof value === 'object' && !Array.isArray(value)
      && Object.entries(value).every(([key, detail]) => !detailValidators[key] || detailValidators[key](detail));
  const validEnvelope = (event) => event && typeof event === 'object'
    && Object.keys(event).every((key) => envelopeKeys.has(key))
    && event.schemaVersion === 2
    && typeof event.runId === 'string' && event.runId === basename(runDir)
    && Number.isSafeInteger(event.sequence) && event.sequence >= 1
    && validTimestamp(event.timestamp)
    && event.command === 'publish'
    && typeof event.phase === 'string' && event.phase.length > 0
    && typeof event.status === 'string' && event.status.length > 0
    && sameProducer(event.producer)
    && (event.error === undefined || event.error === null
      || (typeof event.error === 'object' && !Array.isArray(event.error)
        && Object.keys(event.error).every((key) => key === 'code' || key === 'message')
        && typeof event.error.code === 'string' && event.error.code.length > 0
        && (event.error.message === undefined || typeof event.error.message === 'string')))
    && (event.duration === undefined || Number.isSafeInteger(event.duration) && event.duration >= 0)
    && validDetails(event.details);
  const summaryKeys = new Set(['status', 'recoveryActionCode', 'error', 'details', 'failedAt', 'stablePhase', 'failedUnitId', 'failedHook', 'failedAction', 'evidenceSequence', 'evidencePath', 'producer']);
  if (!summary || Object.keys(summary).some((key) => !summaryKeys.has(key))
    || !summary.error || typeof summary.error.code !== 'string' || !summary.error.code
    || typeof summary.error.message !== 'string'
    || Object.keys(summary.error).some((key) => !['code', 'message'].includes(key))
    || !summary.details || Object.keys(summary.details).length !== 1
    || summary.status !== 'FAILED' || !['RETRY_COMMAND', 'DIAGNOSE'].includes(summary.recoveryActionCode)
    || summary.evidencePath !== 'evidence.jsonl' || !sameProducer(summary.producer)
    || !Array.isArray(events) || events.length === 0) return false;
  let previousSequence = 0;
  let firstFailure = null;
  let genericFailure = null;
  for (const event of events) {
    if (!validEnvelope(event) || event.sequence !== previousSequence + 1) return false;
    previousSequence = event.sequence;
    if (event.status === 'failed' && firstFailure === null) firstFailure = event;
    if (event.phase === 'publish') {
      if (event.status !== 'failed' || genericFailure !== null || event.details?.prePersistedRunPath
        || event.details?.recoveryActionCode !== summary.recoveryActionCode) return false;
      genericFailure = event;
    } else if (!['safety-gate', 'global-preflight-arbitration', 're-observe-previous-public-baseline'].includes(event.phase)) {
      return false;
    }
  }
  if (!firstFailure || !genericFailure || events.at(-1) !== genericFailure
    || summary.evidenceSequence !== firstFailure.sequence
    || summary.stablePhase !== firstFailure.phase
    || summary.failedAction !== (firstFailure.details?.actionId ?? firstFailure.details?.gate ?? 'unknown')
    || summary.failedUnitId !== (firstFailure.details?.unitId ?? 'unknown')
    || summary.failedHook !== (firstFailure.details?.hookName ?? 'unknown')) return false;
  return Number.isFinite(Date.parse(summary.failedAt))
    && !events.some((event) => ['prePersistedRunPath', 'checkpointCount', 'checkpointStatuses'].some((key) => Object.hasOwn(event.details ?? {}, key)))
    && await hasNoState(runDir)
    && ((!strictHistory && producerVersion === resolveProducerVersion()) || closedPublishPrefix(events, summary, producerVersion));
}


async function hasNoState(runDir) {
  for (const name of ['states', 'release-run.json']) {
    try { await lstat(join(runDir, name)); return false; }
    catch (error) { if (error.code !== 'ENOENT') return false; }
  }
  return true;
}

// A finite prefix of the audited publish writer, not a target inference.
function closedPublishPrefix(events, summary, version) {
  const auditedCurrentPrefix = ['0.9.38', '0.10.0'].includes(version);
  let i = 0;
  const take = (phase, status, gate) => {
    const e = events[i];
    if (!e || e.phase !== phase || e.status !== status || e.details?.gate !== gate) return false;
    i += 1; return true;
  };
  const gate = (name, status) => take('safety-gate', status, name);
  for (const [name, status] of [
    ['plan-load', 'started'], ['plan-schema', 'passed'],
    ['plan-digest', 'started'], ['plan-digest', 'passed'],
    ['action-completeness', 'started'], ['action-completeness', 'passed'],
  ]) if (!gate(name, status)) return false;
  if (!auditedCurrentPrefix || events[i]?.details?.gate === 'frozen-artifacts') {
    if (!gate('frozen-artifacts', 'started') || !gate('frozen-artifacts', 'passed')) return false;
  }
  if (!auditedCurrentPrefix || events[i]?.details?.gate === 'skill-resource-closure') {
    if (!gate('skill-resource-closure', 'started') || !gate('skill-resource-closure', 'passed')) return false;
  }
  if (!gate('approval-load', 'started')) return false;
  const terminal = () => {
    const e = events[i];
    return i === events.length - 1 && e?.phase === 'publish' && e.status === 'failed'
      && JSON.stringify(e.error) === JSON.stringify(summary.error)
      && summary.details?.recoveryActionCode === summary.recoveryActionCode;
  };
  if ((version === '0.9.33' || auditedCurrentPrefix) && summary.recoveryActionCode === 'DIAGNOSE') return terminal();
  if (summary.recoveryActionCode !== 'RETRY_COMMAND' || !gate('approval-validated', 'passed')) return false;
  for (const name of ['adapter-availability', 'baseline-check']) {
    if (!gate(name, 'started') || !gate(name, 'passed')) return false;
  }
  while (events[i]?.details?.gate === 'previous-public-baseline') {
    const unit = events[i].details.unitId;
    if (auditedCurrentPrefix && events[i].status === 'passed' && events[i].details.reason === 'fresh repository') {
      if (typeof unit !== 'string' || !gate('previous-public-baseline', 'passed')) return false;
      continue;
    }
    if (typeof unit !== 'string' || !gate('previous-public-baseline', 'started')
      || !take('re-observe-previous-public-baseline', 'consistent', undefined)
      || events[i]?.details?.unitId !== unit || !gate('previous-public-baseline', 'passed')) return false;
  }
  const sourceGate = events[i]?.details?.gate === 'source-authority';
  if ((sourceGate || !auditedCurrentPrefix) && !gate('source-authority', 'started')) return false;
  if ((['0.9.3', '0.9.14', '0.9.33', '0.9.37'].includes(version) || auditedCurrentPrefix)
    && events[i]?.status === 'failed') {
    return gate('source-authority', 'failed') && terminal();
  }
  if (!(version === '0.9.17' || auditedCurrentPrefix) || (sourceGate && !gate('source-authority', 'passed')) || !gate('global-preflight', 'started')) return false;
  let observed = 0;
  while (events[i]?.phase === 'global-preflight-arbitration') {
    if (!take('global-preflight-arbitration', 'pre-observe', undefined)) return false;
    observed += 1;
  }
  return (auditedCurrentPrefix || observed > 0) && terminal();
}
