/**
 * Adoption assessment domain logic (WP-6, release-skill 0.8.0).
 *
 * Answers "is this project fully adopted into the release workflow?" with a
 * four-category matrix and a stable machine-readable report. This module
 * holds ONLY the pure domain semantics — classification, status derivation,
 * hook-cost derivation, digest computation and deterministic report
 * assembly. All filesystem/process I/O (config loading, discovery, assess
 * checks, evidence reads) stays in the orchestrator
 * `assessAdoption` (src/commands/setup.mjs).
 *
 * R-11 boundaries enforced here (裁决 17-20):
 * - hook duration comes only from description-matching (normalized
 *   command/cwd), trusted-producer started/completed evidence pairs;
 *   "unknown" without evidence, for foreign producers, for missing or
 *   changed description fields, or for unpairable events — matching by
 *   name alone is never a duration; `timeoutMs` is never treated as
 *   actual cost;
 * - cached completions count as cache hits, never real cost;
 * - long-hook cost and check-only notes are non-blocking suggestions that
 *   never change the adopted status (removing them changes nothing about
 *   the adoption conclusion);
 * - check-only recommendations require an explicit `--check` argv token —
 *   script names never imply side-effect freedom;
 * - indirect package scripts (package-manager run/test delegation,
 *   interpreter script paths, shell/code-string evaluation) get manual
 *   judgment only, never an executable-looking draft;
 * - the cross-unit postPublish rule (one plan binds one declaration) is a
 *   single pure implementation shared with the assessment.
 *
 * Determinism contract (acceptance scenario 7): the report contains no
 * timestamps, findings are sorted by (category, code, fieldPath, unitId),
 * and `assessmentDigest` binds the config digest plus the full discovery
 * facts so any fact change invalidates earlier suggestion summaries for any
 * future write path. When host-coverage diagnosis is requested, the digest
 * also binds this invocation's complete JSON input, live observation records,
 * and load-error fact.
 *
 * @module adoption-assessment
 */

import { getPlatform, normalizeHostId } from '../platforms/registry.mjs';
import { canonicalJson, sha256Hex } from './digest.mjs';
import { resolveProducerVersion } from './evidence.mjs';

/** Four adoption statuses; never reuses ASSESSED (design §3.2). */
export const ASSESSMENT_STATUS = Object.freeze({
  NOT_CONFIGURED: 'NOT_CONFIGURED',
  PARTIALLY_ADOPTED: 'PARTIALLY_ADOPTED',
  ADOPTED_WITH_SUGGESTIONS: 'ADOPTED_WITH_SUGGESTIONS',
  ADOPTED: 'ADOPTED',
});

/** Four finding categories (design §3.2). */
export const FINDING_CATEGORY = Object.freeze({
  MANDATORY_GAP: 'mandatory-gap',
  SATISFIED: 'satisfied',
  OPTIONAL_SUGGESTION: 'optional-suggestion',
  NOT_APPLICABLE: 'not-applicable',
});

const CATEGORY_RANK = Object.freeze({
  'mandatory-gap': 0,
  'satisfied': 1,
  'optional-suggestion': 2,
  'not-applicable': 3,
});

/**
 * A hook whose last real (non-cached) run lasted at least this long counts
 * as a long-hook cost signal (motivated by observed multi-tens-of-minutes
 * full test runs). Pure observation: it is a non-blocking suggestion.
 */
export const LONG_HOOK_THRESHOLD_MS = 30 * 60 * 1000;

/**
 * Suggestion-only draft values. The design scenario 5 requires drafts to
 * carry timeoutMs and envAllowlist; these are documented defaults that every
 * draft marks as requiring human confirmation — never auto-registered.
 */
export const DRAFT_GATE_TIMEOUT_MS = 600_000;
export const DRAFT_GATE_ENV_ALLOWLIST = Object.freeze(['PATH', 'HOME']);

/**
 * Create a single finding entry of the four-category matrix.
 *
 * @param {Object} parts
 * @param {string} parts.category - One of FINDING_CATEGORY values.
 * @param {string} parts.code - Stable diagnostic code.
 * @param {string} [parts.unitId] - Declared unit id the finding belongs to.
 * @param {string} [parts.fieldPath] - Config path expression (e.g.
 *   "releaseUnits[].source") or null for assess-derived findings.
 * @param {string} parts.message - Chinese message.
 * @param {Object} [parts.evidence] - Machine-readable evidence.
 * @param {string} [parts.action] - Chinese suggested action (required for
 *   blocking findings).
 * @param {'blocking'|'info'|'suggestion'} [parts.severity]
 * @returns {Object} Frozen finding.
 */
export function createFinding({
  category,
  code,
  unitId,
  fieldPath,
  message,
  evidence,
  action,
  severity,
}) {
  const finding = { category, code, message };
  if (unitId !== undefined) finding.unitId = unitId;
  if (fieldPath !== undefined) finding.fieldPath = fieldPath;
  if (evidence !== undefined) finding.evidence = evidence;
  if (action !== undefined) finding.action = action;
  if (severity !== undefined) finding.severity = severity;
  return Object.freeze(finding);
}

/**
 * Map an assess gap severity onto the four-category matrix.
 *
 * @param {'error'|'warning'} severity
 * @returns {string} FINDING_CATEGORY value.
 */
export function classifyGapCategory(severity) {
  return severity === 'error' ? FINDING_CATEGORY.MANDATORY_GAP : FINDING_CATEGORY.OPTIONAL_SUGGESTION;
}

/**
 * Normalize a hook description for matching (裁决 18): the canonical JSON
 * of `{ command, cwd }` where a missing/empty cwd means project root. Both
 * the declared hook and the historical event are normalized the same way,
 * so command/cwd changes can never pair by name alone.
 *
 * @param {Array<string>} command
 * @param {string|null|undefined} cwd
 * @returns {string}
 */
function normalizeHookDescription(command, cwd) {
  return canonicalJson({
    command: Array.isArray(command) ? [...command] : null,
    cwd: typeof cwd === 'string' && cwd.length > 0 ? cwd : null,
  });
}

/**
 * Derive per-hook duration facts from parsed evidence events (R-11, 裁决 18).
 *
 * Trust boundary: only events whose `producer` is `{name: 'release-skill',
 * version: currentProducerVersion}` are considered. Events without a
 * producer (v1-era) or from an older producer are ignored; missing evidence
 * therefore yields basis "unknown", never a guessed number.
 *
 * Description boundary: a real run is only derivable when the historical
 * event carries a sufficient description (`details.hookCommand` plus an
 * explicitly present, contract-valid `details.hookCwd`) whose normalized form matches the current declared
 * hook's normalized description. Command/cwd changes, missing fields,
 * unknown producers and unpairable started/completed events all yield
 * "unknown" — matching by name alone is never a duration (裁决 18). No
 * historical identity is fabricated and no duration database exists.
 *
 * A "real run" is a started/completed pair within one runId where the
 * completed event does NOT carry `cached: true` and both events carry the
 * same normalized description. Cached completions are counted as cache hits
 * and never contribute to cost. Failed runs are counted but never become a
 * duration. The reported durationMs is the latest real pair (highest
 * completed timestamp).
 *
 * @param {Object} options
 * @param {Array<Object>} options.events - Parsed evidence events (envelope
 *   fields present: runId, timestamp, phase, status, producer, hookName).
 * @param {Object<string, {command: string[], cwd?: string}>} options.declaredHooks -
 *   Currently declared hooks (config.hooks); the current normalized
 *   description each historical event must match.
 * @param {string} options.currentProducerVersion - Version that is trusted
 *   today (resolveProducerVersion()).
 * @returns {Array<{hookName: string, basis: 'evidence'|'unknown',
 *   durationMs: number|null, realRuns: number, cacheHits: number,
 *   failedRuns: number, lastObservedAt: string|null}>} Sorted by hookName.
 */
export function deriveHookDurations({ events, declaredHooks, currentProducerVersion }) {
  const hookNames = Object.keys(declaredHooks ?? {}).sort();
  const trusted = (event) => (
    event?.producer?.name === 'release-skill'
    && event?.producer?.version === currentProducerVersion
  );
  const byHook = new Map(hookNames.map((name) => [name, {
    hookName: name,
    basis: 'unknown',
    durationMs: null,
    realRuns: 0,
    cacheHits: 0,
    failedRuns: 0,
    lastObservedAt: null,
  }]));
  const declaredDescription = new Map(hookNames.map((name) => [
    name,
    normalizeHookDescription(declaredHooks[name]?.command, declaredHooks[name]?.cwd),
  ]));

  // V4: hook location and cache facts live inside `details` in v2 events;
  // the legacy top-level position is still tolerated so historical runs
  // stay consumable (migrated consumers retain the original information).
  const hookOf = (event) => {
    if (typeof event?.details?.hookName === 'string' && event.details.hookName.length > 0) {
      return event.details.hookName;
    }
    return typeof event?.hookName === 'string' ? event.hookName : null;
  };
  const wasCached = (event) => event?.cached === true || event?.details?.cached === true;
  // Description of an event, or null when the historical description is
  // insufficient (裁决 18: 字段不足就显示未知).
  const eventDescription = (event) => {
    const command = event?.details?.hookCommand;
    if (!Array.isArray(command) || command.length === 0
      || !command.every((token) => typeof token === 'string')) {
      return null;
    }
    // A missing historical cwd is not evidence of the default cwd. Only an
    // explicitly recorded contract value may normalize to the default.
    if (!event.details || !Object.prototype.hasOwnProperty.call(event.details, 'hookCwd')) {
      return null;
    }
    const cwd = event.details.hookCwd;
    if (cwd !== null && typeof cwd !== 'string') return null;
    return normalizeHookDescription(command, cwd);
  };

  for (const event of events ?? []) {
    if (event?.phase !== 'hooks') continue;
    const hookName = hookOf(event);
    if (hookName === null || !byHook.has(hookName)) continue;
    const record = byHook.get(hookName);
    if (!trusted(event)) continue;
    if (event.status === 'started') continue;
    if (event.status === 'failed') {
      record.failedRuns += 1;
      continue;
    }
    if (event.status !== 'completed') continue;
    if (wasCached(event)) {
      record.cacheHits += 1;
      continue;
    }
    // A real completion: the historical description must be sufficient and
    // match the current normalized description, and it must pair with the
    // run's started event carrying the SAME description.
    const completedDescription = eventDescription(event);
    if (completedDescription === null || completedDescription !== declaredDescription.get(hookName)) {
      continue;
    }
    const started = (events ?? []).find((candidate) => (
      candidate?.runId === event.runId
      && candidate?.phase === 'hooks'
      && candidate?.status === 'started'
      && hookOf(candidate) === hookName
      && trusted(candidate)
      && eventDescription(candidate) === completedDescription
    ));
    if (!started) continue;
    const startedTs = Date.parse(started.timestamp);
    const completedTs = Date.parse(event.timestamp);
    if (Number.isNaN(startedTs) || Number.isNaN(completedTs)) continue;
    const durationMs = Math.max(0, completedTs - startedTs);
    record.realRuns += 1;
    if (record.lastObservedAt === null || event.timestamp > record.lastObservedAt) {
      record.lastObservedAt = event.timestamp;
      record.durationMs = durationMs;
      record.basis = 'evidence';
    }
  }

  return [...byHook.values()].sort((a, b) => a.hookName.localeCompare(b.hookName));
}

/**
 * Derive the adoption status from findings (design §3.2, §7).
 *
 * Only mandatory gaps can move a project out of the adopted band; optional
 * suggestions choose between ADOPTED_WITH_SUGGESTIONS and ADOPTED.
 * not-applicable entries never affect the status.
 *
 * @param {Array<Object>} findings
 * @returns {string} ASSESSMENT_STATUS value (never NOT_CONFIGURED here).
 */
export function deriveStatus(findings) {
  if (findings.some((f) => f.category === FINDING_CATEGORY.MANDATORY_GAP)) {
    return ASSESSMENT_STATUS.PARTIALLY_ADOPTED;
  }
  if (findings.some((f) => f.category === FINDING_CATEGORY.OPTIONAL_SUGGESTION)) {
    return ASSESSMENT_STATUS.ADOPTED_WITH_SUGGESTIONS;
  }
  return ASSESSMENT_STATUS.ADOPTED;
}

const HOST_COVERAGE_OBSERVATION_STATES = Object.freeze(['installed', 'not-installed', 'unknown']);

export function emptyHostCoverage() {
  return Object.freeze({
    requested: false,
    complete: false,
    results: Object.freeze([]),
    findings: Object.freeze([]),
    binding: null,
  });
}

export function publicHostCoverage(coverage = emptyHostCoverage()) {
  return Object.freeze({
    requested: coverage.requested === true,
    complete: coverage.complete === true,
    results: coverage.results ?? Object.freeze([]),
  });
}

function platformIdOrNull(value) {
  try {
    return getPlatform(value).id;
  } catch {
    return null;
  }
}

async function canonicalizeHost(value) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return { ok: false, raw: value, reason: 'host id is missing' };
  }
  const trimmed = value.trim();
  let foundationId = null;
  try {
    foundationId = await normalizeHostId(trimmed);
  } catch (error) {
    const platformId = platformIdOrNull(trimmed);
    if (platformId) return { ok: true, raw: value, host: platformId };
    return {
      ok: false,
      raw: value,
      reason: error?.message ?? 'host id could not be normalized',
    };
  }
  const foundationPlatform = platformIdOrNull(foundationId);
  if (foundationPlatform) return { ok: true, raw: value, host: foundationPlatform };
  const rawPlatform = platformIdOrNull(trimmed);
  if (rawPlatform) return { ok: true, raw: value, host: rawPlatform };
  return { ok: true, raw: value, host: foundationId };
}

function uniquePush(list, value) {
  if (!list.includes(value)) list.push(value);
}

function applicableDistribution(unit, host) {
  let distributionType = null;
  try {
    distributionType = getPlatform(host).distributionType;
  } catch {
    distributionType = null;
  }
  if (distributionType == null) return null;
  return (unit?.distributions ?? []).find((item) => item.type === distributionType) ?? null;
}

function nonemptyString(value) {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function declaredPluginIdentity(unit, host) {
  const localPlugin = nonemptyString(unit?.postPublish?.localHostUpdate?.plugin);
  if (localPlugin) return localPlugin;
  return nonemptyString(applicableDistribution(unit, host)?.plugin);
}

function declaredMarketplaceIdentity(unit, host) {
  const localMarketplace = nonemptyString(unit?.postPublish?.localHostUpdate?.hub?.name);
  if (localMarketplace) return localMarketplace;
  return nonemptyString(applicableDistribution(unit, host)?.marketplace);
}

function wiringFacts(config, unitId, host) {
  if (!config) return { available: false };
  const unit = (config.releaseUnits ?? []).find((item) => item.id === unitId);
  if (!unit) return { available: false, unitFound: false };
  let distributionType = null;
  try {
    distributionType = getPlatform(host).distributionType;
  } catch {
    distributionType = null;
  }
  const hasLocalUpdate = Array.isArray(unit.postPublish?.localHostUpdate?.hosts)
    && unit.postPublish.localHostUpdate.hosts.includes(host);
  if (distributionType == null) {
    return { available: false, unitFound: true, hasLocalUpdate };
  }
  const hasDistribution = (unit.distributions ?? []).some((item) => item.type === distributionType);
  return {
    available: true,
    unitFound: true,
    hasDistribution,
    hasLocalUpdate,
    distributionType,
  };
}

function observationKey(unitId, host) {
  return `${unitId}\u0000${host}`;
}

function validObservedAt(value) {
  const observedAt = nonemptyString(value);
  if (observedAt == null || Number.isNaN(Date.parse(observedAt))) return null;
  return observedAt;
}

function normalizeObservationRecord(observation, host) {
  return {
    host,
    plugin: nonemptyString(observation?.plugin),
    marketplace: nonemptyString(observation?.marketplace),
    state: HOST_COVERAGE_OBSERVATION_STATES.includes(observation?.state) ? observation.state : null,
    source: nonemptyString(observation?.source),
    observedAt: validObservedAt(observation?.observedAt),
    version: nonemptyString(observation?.version),
  };
}

function observationFactsIssue(observation) {
  if (!observation || observation.state == null) return 'install observation is missing';
  if (observation.plugin == null) return 'observation plugin is missing';
  if (observation.marketplace == null) return 'observation marketplace is missing';
  if (observation.source == null) return 'observation source is missing';
  if (observation.observedAt == null) return 'observation observedAt is missing or not a valid timestamp';
  if (observation.state === 'installed' && observation.version == null) {
    return 'installed observation version is missing';
  }
  return null;
}

function mergeObservation(fileObservation, liveObservation) {
  if (!fileObservation && !liveObservation) return null;
  if (!liveObservation) return fileObservation;
  if (!fileObservation) return liveObservation;
  const identityConflict = (
    (fileObservation.plugin && liveObservation.plugin && fileObservation.plugin !== liveObservation.plugin)
    || (fileObservation.marketplace && liveObservation.marketplace && fileObservation.marketplace !== liveObservation.marketplace)
  );
  if (identityConflict) {
    return {
      ...liveObservation,
      state: 'unknown',
      reason: 'file and live observations disagree on plugin identity',
    };
  }
  if (
    fileObservation.state
    && fileObservation.state !== 'unknown'
    && liveObservation.state
    && liveObservation.state !== 'unknown'
    && fileObservation.state !== liveObservation.state
  ) {
    return {
      ...liveObservation,
      state: 'unknown',
      reason: 'file and live observations disagree on install state',
    };
  }
  return liveObservation;
}

/**
 * Compare explicit host-coverage input with project wiring and observations.
 * Support facts come only from the input declaration, never from distributions
 * or localHostUpdate.
 *
 * @param {object} options
 * @returns {Promise<object>}
 */
export async function evaluateHostCoverage({
  requested = false,
  input = null,
  loadError = null,
  config = null,
  liveObservations = [],
} = {}) {
  if (!requested) return emptyHostCoverage();

  const issues = [];
  const results = [];
  const binding = { input, liveObservations, loadError };
  if (loadError) issues.push(loadError);
  if (input == null) {
    return finishHostCoverage({ requested: true, complete: false, results, issues, binding });
  }
  if (input.schemaVersion !== 1) issues.push('schemaVersion must be 1');
  if (!Array.isArray(input.units)) {
    issues.push('units must be an array');
    return finishHostCoverage({
      requested: true,
      complete: false,
      results,
      issues,
      binding,
    });
  }

  const seenUnitIds = new Set();
  for (const unit of input.units) {
    const unitId = typeof unit?.unitId === 'string' ? unit.unitId : null;
    if (unitId == null || unitId.length === 0) {
      issues.push('unitId is missing');
      continue;
    }
    const duplicatedUnit = seenUnitIds.has(unitId);
    if (duplicatedUnit) {
      issues.push(`unitId "${unitId}" is duplicated`);
    } else {
      seenUnitIds.add(unitId);
    }

    const supportSource = typeof unit?.support?.source === 'string' ? unit.support.source.trim() : '';
    if (supportSource.length === 0) issues.push(`unit "${unitId}" is missing support.source`);

    const supportHosts = [];
    for (const raw of Array.isArray(unit?.support?.hosts) ? unit.support.hosts : []) {
      const canonical = await canonicalizeHost(raw);
      if (!canonical.ok) {
        issues.push(`unit "${unitId}" has unresolvable support host ${JSON.stringify(raw)}`);
        if (typeof raw === 'string' && raw.length > 0) uniquePush(supportHosts, raw);
        continue;
      }
      uniquePush(supportHosts, canonical.host);
    }
    if (!Array.isArray(unit?.support?.hosts)) issues.push(`unit "${unitId}" is missing support.hosts`);

    const includeHosts = [];
    if (!Array.isArray(unit?.delivery?.include)) {
      issues.push(`unit "${unitId}" is missing delivery.include`);
    } else {
      for (const raw of unit.delivery.include) {
        const canonical = await canonicalizeHost(raw);
        if (!canonical.ok) {
          issues.push(`unit "${unitId}" has unresolvable include host ${JSON.stringify(raw)}`);
          if (typeof raw === 'string' && raw.length > 0) uniquePush(includeHosts, raw);
          continue;
        }
        uniquePush(includeHosts, canonical.host);
      }
    }

    const excludeByHost = new Map();
    if (!Array.isArray(unit?.delivery?.exclude)) {
      issues.push(`unit "${unitId}" is missing delivery.exclude`);
    } else {
      for (const entry of unit.delivery.exclude) {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry) || typeof entry.reason !== 'string' || entry.reason.length === 0) {
          issues.push(`unit "${unitId}" exclude entries must be {host, reason} objects`);
          continue;
        }
        const canonical = await canonicalizeHost(entry.host);
        if (!canonical.ok) {
          issues.push(`unit "${unitId}" has unresolvable exclude host ${JSON.stringify(entry.host)}`);
          continue;
        }
        if (excludeByHost.has(canonical.host)) {
          issues.push(`unit "${unitId}" host "${canonical.host}" is excluded more than once`);
          continue;
        }
        excludeByHost.set(canonical.host, entry.reason);
      }
    }

    const installIfMissing = [];
    if (!Array.isArray(unit?.delivery?.installIfMissing)) {
      issues.push(`unit "${unitId}" is missing delivery.installIfMissing`);
    } else {
      for (const raw of unit.delivery.installIfMissing) {
        const canonical = await canonicalizeHost(raw);
        if (!canonical.ok) {
          issues.push(`unit "${unitId}" has unresolvable installIfMissing host ${JSON.stringify(raw)}`);
          continue;
        }
        uniquePush(installIfMissing, canonical.host);
      }
    }

    const fileObservations = new Map();
    const duplicateHosts = new Set();
    if (!Array.isArray(unit?.observations)) {
      issues.push(`unit "${unitId}" is missing observations`);
    } else {
      for (const observation of unit.observations) {
        const canonical = await canonicalizeHost(observation?.host);
        if (!canonical.ok) {
          issues.push(`unit "${unitId}" has unresolvable observation host ${JSON.stringify(observation?.host)}`);
          continue;
        }
        const key = observationKey(unitId, canonical.host);
        if (fileObservations.has(key) || duplicateHosts.has(canonical.host)) {
          duplicateHosts.add(canonical.host);
          fileObservations.delete(key);
          issues.push(`unit "${unitId}" has duplicate observations for host "${canonical.host}"`);
          continue;
        }
        const normalized = normalizeObservationRecord(observation, canonical.host);
        if (normalized.state == null) {
          issues.push(`unit "${unitId}" observation for "${canonical.host}" has invalid state`);
        }
        fileObservations.set(key, normalized);
      }
    }

    const liveByHost = new Map();
    for (const observation of liveObservations) {
      if (observation?.unitId !== unitId) continue;
      const canonical = await canonicalizeHost(observation.host);
      if (!canonical.ok) continue;
      liveByHost.set(canonical.host, {
        ...normalizeObservationRecord(observation, canonical.host),
        reason: observation.reason,
      });
    }

    const declaredHosts = [];
    for (const host of [...supportHosts, ...includeHosts, ...excludeByHost.keys(), ...installIfMissing]) {
      uniquePush(declaredHosts, host);
    }
    for (const observation of [...fileObservations.values(), ...liveByHost.values()]) {
      uniquePush(declaredHosts, observation.host);
    }
    declaredHosts.sort((a, b) => a.localeCompare(b));

    const unitConfig = (config?.releaseUnits ?? []).find((item) => item.id === unitId) ?? null;
    if (config != null && unitConfig == null) {
      issues.push(`requested unit "${unitId}" is not declared in config.releaseUnits`);
    }

    for (const host of declaredHosts) {
      const excluded = excludeByHost.has(host);
      const included = includeHosts.includes(host);
      const supported = supportHosts.includes(host);
      const firstInstall = installIfMissing.includes(host);
      const fileObservation = fileObservations.get(observationKey(unitId, host));
      const liveObservation = liveByHost.get(host);
      const observation = mergeObservation(fileObservation, liveObservation);
      const duplicate = duplicateHosts.has(host);
      const wiring = wiringFacts(config, unitId, host);
      const expectedPlugin = declaredPluginIdentity(unitConfig, host);
      const expectedMarketplace = declaredMarketplaceIdentity(unitConfig, host);
      const identityConflict = Boolean(
        (observation?.plugin && expectedPlugin && observation.plugin !== expectedPlugin)
        || (observation?.marketplace && expectedMarketplace && observation.marketplace !== expectedMarketplace),
      );
      const factsIssue = observationFactsIssue(observation);

      let status = 'unknown';
      let reason = 'host coverage facts are incomplete';
      if (duplicate) {
        reason = 'duplicate observations for the same host';
      } else if (config != null && unitConfig == null) {
        reason = 'requested unit is not declared in config.releaseUnits';
      } else if (excluded && included) {
        reason = 'host is both included and excluded';
        issues.push(`unit "${unitId}" host "${host}" is both included and excluded`);
      } else if (excluded) {
        status = FINDING_CATEGORY.NOT_APPLICABLE;
        reason = `已排除：${excludeByHost.get(host)}`;
      } else if (supportSource.length === 0) {
        reason = 'support.source is missing';
      } else if (!supported) {
        reason = 'host is not declared in support.hosts; support cannot be inferred from wiring';
      } else if (!included) {
        reason = 'supported host is not included and has no exclusion reason';
      } else if (identityConflict) {
        reason = 'observation identity conflicts with the unit distribution or local-update identity';
      } else if (factsIssue) {
        reason = factsIssue;
      } else if (observation.state === 'unknown') {
        reason = observation.reason ?? 'install observation is unknown';
      } else if (observation.state === 'not-installed' && !firstInstall) {
        status = FINDING_CATEGORY.NOT_APPLICABLE;
        reason = 'host is not installed and this round has no first-install duty';
      } else if (!wiring.available) {
        reason = 'project wiring facts are unavailable';
      } else if (!wiring.hasDistribution || !wiring.hasLocalUpdate) {
        status = FINDING_CATEGORY.MANDATORY_GAP;
        const missing = [
          wiring.hasDistribution ? null : 'applicable distribution',
          wiring.hasLocalUpdate ? null : 'localHostUpdate host wiring',
        ].filter(Boolean);
        reason = `supported in-scope host is missing ${missing.join(' and ')}`;
      } else {
        status = FINDING_CATEGORY.SATISFIED;
        reason = observation.state === 'not-installed'
          ? 'first-install duty has complete wiring'
          : 'supported in-scope host is installed and wired';
      }

      if (!duplicatedUnit && status === 'unknown') {
        issues.push(`unit "${unitId}" host "${host}": ${reason}`);
      }

      const evidence = {
        support: { hosts: [...supportHosts], source: supportSource || null },
        delivery: {
          include: [...includeHosts],
          exclude: [...excludeByHost.entries()].map(([excludeHost, excludeReason]) => ({
            host: excludeHost,
            reason: excludeReason,
          })),
          installIfMissing: [...installIfMissing],
        },
        observation: observation ?? null,
        wiring,
      };
      if (!duplicatedUnit) {
        results.push(Object.freeze({
          unitId,
          host,
          status,
          reason,
          evidence,
        }));
      }
    }
  }

  results.sort((a, b) => a.unitId.localeCompare(b.unitId) || a.host.localeCompare(b.host));
  const complete = issues.length === 0 && results.every((item) => item.status !== 'unknown');
  return finishHostCoverage({
    requested: true,
    complete,
    results,
    issues,
    binding,
  });
}

function finishHostCoverage({ requested, complete, results, issues, binding }) {
  const findings = [];
  if (requested && !complete) {
    findings.push(createFinding({
      category: FINDING_CATEGORY.MANDATORY_GAP,
      code: 'HOST_COVERAGE_FACTS_MISSING',
      fieldPath: 'hostCoverage',
      message: `宿主覆盖诊断已请求，但完成本次检查所需事实缺失：${issues[0] ?? 'unknown facts remain'}`,
      evidence: { issues, complete: false },
      action: '补齐支持出处、范围、观察或接线事实后重新评估；未知不得写成未安装或已通过。',
      severity: 'blocking',
    }));
  }
  for (const result of results) {
    if (result.status !== FINDING_CATEGORY.MANDATORY_GAP) continue;
    findings.push(createFinding({
      category: FINDING_CATEGORY.MANDATORY_GAP,
      code: 'HOST_COVERAGE_WIRING_GAP',
      unitId: result.unitId,
      fieldPath: `hostCoverage.${result.unitId}.${result.host}`,
      message: `发布单元 "${result.unitId}" 宿主 "${result.host}" 覆盖不足：${result.reason}`,
      evidence: result.evidence,
      action: '补齐适用分发或 localHostUpdate 宿主接线后重新评估；安装观察不能证明加载成功。',
      severity: 'blocking',
    }));
  }
  return Object.freeze({
    requested,
    complete,
    results: Object.freeze(results),
    findings: Object.freeze(findings),
    binding,
  });
}

/**
 * Derive gate suggestions from setup's gate candidates (scenarios 5 & 6).
 *
 * Draft condition (design §3.3 + §6 scenario 5/6, 裁决 19): the script's
 * argv is a direct command declaration (`inspectedArgv !== null`), carries
 * no positive side-effect signal from classifyScript (no network, no
 * interactivity, no file writes, not high-cost, not consumer-context), and
 * is NOT an identified indirect script (package-manager run/test
 * delegation, interpreter script path, shell/code-string evaluation —
 * `gate.indirectScript === true`). Indirect scripts get a
 * needsManualJudgment suggestion with NO executable-looking draft: the
 * actual behavior and side-effect boundary of an indirect script cannot be
 * proven from the declaration, and "no danger signals found" is never a
 * side-effect safety proof. No recursive script dependency graph or
 * general-purpose command safety analyzer is built.
 *
 * Side-effect FREEDOM is never claimed even for drafts: every draft states
 * that registration requires human confirmation (classifyScript's
 * fail-closed stance — see `eligibleForRecommendation` which is
 * intentionally always false because discovery cannot prove side effects;
 * SIDE_EFFECTS_UNPROVEN on a DIRECT command is therefore the benign case
 * that still gets a draft, with the caveat spelled out).
 *
 * Suggestions map onto a declared unit by matching candidate unit source to
 * a declared unit source; candidates without a declared counterpart are
 * skipped (no config position to suggest into).
 *
 * @param {Object} options
 * @param {Array<Object>} options.declaredUnits - config.releaseUnits.
 * @param {Array<Object>} options.candidates - buildCandidates(facts) result
 *   ({units, gates}).
 * @returns {Array<Object>} Suggestions sorted by (unitId, script).
 */
const POSITIVE_SIDE_EFFECT_REASONS = new Set([
  'NETWORK_LIKELY',
  'INTERACTIVE',
  'HIGH_COST',
  'MAY_WRITE_FILES',
  'CONSUMER_CONTEXT_UNPROVEN',
]);

export function deriveGateSuggestions({ declaredUnits, candidates }) {
  const declaredBySource = new Map(declaredUnits.map((unit) => [unit.source, unit]));
  const candidateUnits = candidates?.units ?? [];
  const suggestions = [];
  for (const gate of candidates?.gates ?? []) {
    if (typeof gate.script !== 'string' || !gate.scope?.unit) continue;
    const candidateUnit = candidateUnits.find((unit) => unit.id === gate.scope.unit);
    const declaredUnit = candidateUnit ? declaredBySource.get(candidateUnit.source) : undefined;
    if (!declaredUnit) continue;
    const base = {
      id: gate.id,
      unitId: declaredUnit.id,
      script: gate.script,
    };
    const positiveSignal = POSITIVE_SIDE_EFFECT_REASONS.has(gate.ineligibilityReason);
    if (gate.inspectedArgv === null || positiveSignal || gate.indirectScript === true) {
      suggestions.push({
        ...base,
        needsManualJudgment: true,
        ineligibilityReason: gate.ineligibilityReason ?? 'UNPARSEABLE_COMMAND',
        draft: null,
        rationale: gate.inspectedArgv === null
          ? `package.json 脚本 "${gate.script}" 无法解析为直接命令（间接脚本或自然语言）；需要人工判断，不生成草案。`
          : gate.indirectScript === true
            ? `package.json 脚本 "${gate.script}" 是间接脚本（实际执行的命令与副作用边界无法从声明证明）；需要人工判断，不生成可执行草案。`
            : `package.json 脚本 "${gate.script}" 携带正向副作用信号（${gate.ineligibilityReason}）；不能机械确认其安全性，需要人工判断，不生成可执行草案。`,
      });
    } else {
      suggestions.push({
        ...base,
        needsManualJudgment: false,
        draft: {
          phase: gate.recommendedPhase,
          scope: {
            unit: declaredUnit.id,
            ...(gate.scope.distribution ? { distribution: gate.scope.distribution } : {}),
          },
          command: [...gate.inspectedArgv],
          cwd: declaredUnit.source,
          timeoutMs: DRAFT_GATE_TIMEOUT_MS,
          envAllowlist: [...DRAFT_GATE_ENV_ALLOWLIST],
        },
        rationale: `package.json 脚本 "${gate.script}" 可直接解析为命令 ["${gate.inspectedArgv.join('", "')}"]（无网络/交互/写文件信号）。副作用是否可接受、timeoutMs 与 envAllowlist 为建议值，均需人工确认；评估未写入配置。`,
      });
    }
  }
  suggestions.sort((a, b) => (a.unitId.localeCompare(b.unitId) || a.script.localeCompare(b.script)));
  return suggestions;
}

/**
 * Scan EVERY declared verification gate for the three semantic rules that
 * make a declaration invalid (design §3.1.4, scenario 4): duplicate ids,
 * unknown unit, and consumer-verify gates over an undeclared distribution.
 *
 * Config loading stops at the FIRST offending gate; this scan reports all of
 * them so the report lists every invalid declaration instead of one at a
 * time. Mirror of the load-time rules in core/config.mjs, scoped to the
 * adoption report (no schema re-validation here).
 *
 * @param {Object} options
 * @param {Array<Object>} options.units - config.releaseUnits.
 * @param {Array<Object>} options.gates - config.verificationGates.
 * @returns {Array<Object>} GATE_DECLARATION_INVALID findings (sorted).
 */
export function scanGateDeclarationFindings({ units, gates }) {
  const findings = [];
  const unitsById = new Map((units ?? []).map((unit) => [unit.id, unit]));
  const seenIds = new Set();
  for (const gate of gates ?? []) {
    const gateId = gate?.id;
    if (typeof gateId !== 'string') continue;
    if (seenIds.has(gateId)) {
      findings.push(createFinding({
        category: FINDING_CATEGORY.MANDATORY_GAP,
        code: 'GATE_DECLARATION_INVALID',
        fieldPath: 'verificationGates[]',
        message: `verification gate id "${gateId}" 重复声明；id 必须唯一。`,
        evidence: { gateId },
        action: '修正 verificationGates 声明（单元/渠道必须存在，id 不得重复）后重新评估。',
        severity: 'blocking',
      }));
      continue;
    }
    seenIds.add(gateId);
    const unit = unitsById.get(gate?.scope?.unit);
    if (!unit) {
      findings.push(createFinding({
        category: FINDING_CATEGORY.MANDATORY_GAP,
        code: 'GATE_DECLARATION_INVALID',
        fieldPath: 'verificationGates[]',
        message: `verification gate "${gateId}" 引用不存在的发布单元 "${gate.scope.unit}"。`,
        evidence: { gateId, unitId: gate.scope.unit },
        action: '修正 verificationGates 声明（单元/渠道必须存在，id 不得重复）后重新评估。',
        severity: 'blocking',
      }));
      continue;
    }
    if (
      gate.phase === 'consumer-verify'
      && !(unit.distributions ?? []).some((distribution) => distribution.type === gate.scope?.distribution)
    ) {
      findings.push(createFinding({
        category: FINDING_CATEGORY.MANDATORY_GAP,
        code: 'GATE_DECLARATION_INVALID',
        unitId: unit.id,
        fieldPath: 'verificationGates[]',
        message: `verification gate "${gateId}" 引用发布单元 "${unit.id}" 未声明的分发渠道 "${gate.scope.distribution}"。`,
        evidence: { gateId, unitId: unit.id, distribution: gate.scope.distribution },
        action: '修正 verificationGates 声明（单元/渠道必须存在，id 不得重复）后重新评估。',
        severity: 'blocking',
      }));
    }
  }
  findings.sort((a, b) => (
    (a.evidence?.gateId ?? '').localeCompare(b.evidence?.gateId ?? '')
  ));
  return findings;
}

/**
 * Check-only (R-11 item 4): recommend only when the declared hook command
 * explicitly carries a `--check` token. Script names never imply check-only
 * semantics.
 *
 * @param {Object} hooks - config.hooks (declared hooks by name).
 * @returns {Array<Object>} CHECK_MODE_DECLARED suggestions.
 */
export function deriveCheckOnlySuggestions(hooks) {
  const findings = [];
  for (const [hookName, hook] of Object.entries(hooks ?? {})) {
    if (!Array.isArray(hook?.command)) continue;
    if (!hook.command.some((token) => token === '--check')) continue;
    findings.push(createFinding({
      category: FINDING_CATEGORY.OPTIONAL_SUGGESTION,
      code: 'CHECK_MODE_DECLARED',
      fieldPath: `hooks.${hookName}.command`,
      message: `hook "${hookName}" 的命令明确提供 --check 只读检查模式；如需降低重复执行成本，可在人工确认后评估（评估不会自动修改配置）。`,
      evidence: { hookName, argv: [...hook.command] },
      action: '人工确认命令只读语义后再考虑采用；不构成跳过完整检查的依据。',
      severity: 'suggestion',
    }));
  }
  return findings;
}

/**
 * Derive the long-hook cost suggestion (R-11 item 1) from durations.
 *
 * The suggestion is observation-layer only: it never changes the adoption
 * status and never proposes cacheable/cacheInputs — those require the
 * project's own completeness proof plus Foundation 0.11 capabilities.
 *
 * @param {Array<Object>} hookDurations - deriveHookDurations() output.
 * @returns {Array<Object>} LONG_HOOK_COST suggestions.
 */
export function deriveLongHookSuggestions(hookDurations) {
  const findings = [];
  for (const duration of hookDurations) {
    if (duration.basis !== 'evidence' || duration.durationMs === null) continue;
    if (duration.durationMs < LONG_HOOK_THRESHOLD_MS) continue;
    const minutes = Math.round(duration.durationMs / 60_000);
    findings.push(createFinding({
      category: FINDING_CATEGORY.OPTIONAL_SUGGESTION,
      code: 'LONG_HOOK_COST',
      fieldPath: `hooks.${duration.hookName}`,
      message: `hook "${duration.hookName}" 最近一次实际运行约 ${minutes} 分钟（来自受信运行证据）。长时间重复执行会拉长发布周期；cacheable/cacheInputs 需项目证明完整闭包、并等待 Foundation 0.11 能力发布后再评估，评估不会代写。`,
      evidence: { hookName: duration.hookName, durationMs: duration.durationMs, realRuns: duration.realRuns },
      action: '人工评估是否缩小输入范围、调整 testSelection 或拆分检查；不构成跳过完整测试或发布批准的依据。',
      severity: 'suggestion',
    }));
  }
  return findings;
}

/**
 * Report the opt-in R93-01 pre-hook public-surface check without changing the
 * base adoption conclusion. A candidate is based only on hookDurations that
 * already passed the current-producer, command/cwd-matching and real
 * started/completed-pair checks above; timeout, cache hits and labels are not
 * consulted here.
 *
 * @param {object} options
 * @param {object} options.config - Loaded project configuration.
 * @param {Array<object>} options.hookDurations - Trusted duration facts.
 * @returns {object} One adoption finding for the policy field.
 */
export function derivePreHookPublicSurfaceFinding({ config, hookDurations }) {
  const fieldPath = 'policy.preHookPublicSurfaceCheck';
  if (config?.policy?.preHookPublicSurfaceCheck === true) {
    return createFinding({
      category: FINDING_CATEGORY.SATISFIED,
      code: 'PRE_HOOK_PUBLIC_SURFACE_CHECK_ADOPTED',
      fieldPath,
      message: '已启用 Hook 前公开表面检查；prepare 会在首个 Hook 前验证候选公开表面，并在 Hook 后重新执行正式检查。',
      evidence: { enabled: true },
    });
  }

  const candidate = (hookDurations ?? [])
    .filter((duration) => (
      duration?.basis === 'evidence'
      && Number.isFinite(duration.durationMs)
      && duration.durationMs >= LONG_HOOK_THRESHOLD_MS
      && duration.realRuns >= 1
    ))
    .sort((a, b) => (
      (b.durationMs - a.durationMs) || a.hookName.localeCompare(b.hookName)
    ))[0];
  if (candidate) {
    return createFinding({
      category: FINDING_CATEGORY.OPTIONAL_SUGGESTION,
      code: 'PRE_HOOK_PUBLIC_SURFACE_CHECK_CANDIDATE',
      fieldPath,
      message: `当前 hook "${candidate.hookName}" 有可信的实际运行证据（至少 30 分钟）；可人工评估是否启用 Hook 前公开表面检查。`,
      evidence: {
        hookName: candidate.hookName,
        durationMs: candidate.durationMs,
        realRuns: candidate.realRuns,
        lastObservedAt: candidate.lastObservedAt,
      },
      action: '确认公开文件不会由 Hook 生成或修复后，再在配置中将 policy.preHookPublicSurfaceCheck 设为 true；评估不会自动修改配置。',
      severity: 'suggestion',
    });
  }

  return createFinding({
    category: FINDING_CATEGORY.NOT_APPLICABLE,
    code: 'PRE_HOOK_PUBLIC_SURFACE_CHECK_NOT_APPLICABLE',
    fieldPath,
    message: '当前没有可信且匹配当前 Hook 的至少 30 分钟实际运行证据，暂不建议启用 Hook 前公开表面检查。',
  });
}

const STATUS_LABEL = Object.freeze({
  NOT_CONFIGURED: '尚未配置',
  PARTIALLY_ADOPTED: '部分接入（存在必选缺口）',
  ADOPTED_WITH_SUGGESTIONS: '已接入（存在可选建议）',
  ADOPTED: '已接入（当前无建议）',
});

/**
 * Build the deterministic adoption report from prepared inputs.
 *
 * @param {Object} options
 * @param {Object} options.config - Loaded config.
 * @param {string} options.configPath - Absolute config path.
 * @param {string} options.configDigest - Config digest.
 * @param {Object} options.facts - discoverFacts() output.
 * @param {Array<Object>} options.findings - Combined findings (field-level
 *   gaps, satisfied/not-applicable entries, assess-derived findings,
 *   cost/check-only suggestions). Sorted before assembly.
 * @param {Array<Object>} options.hookDurations - deriveHookDurations output.
 * @param {Array<Object>} options.gateSuggestions - Actionable gate drafts.
 * @param {Array<Object>} options.gateDiagnostics - Non-actionable discovered
 *   scripts retained for explicit diagnosis without affecting status/summary.
 * @param {string} [options.next] - Precise next step.
 * @param {Object} [options.hostCoverage] - Host-coverage diagnosis result.
 * @returns {Object} Frozen report.
 */
export function buildAssessmentReport({
  config,
  configPath,
  configDigest,
  facts,
  findings,
  hookDurations,
  gateSuggestions,
  gateDiagnostics = [],
  next = null,
  hostCoverage = emptyHostCoverage(),
}) {
  const sortedFindings = [...findings].sort((a, b) => (
    (CATEGORY_RANK[a.category] ?? 9) - (CATEGORY_RANK[b.category] ?? 9)
    || a.code.localeCompare(b.code)
    || (a.fieldPath ?? '').localeCompare(b.fieldPath ?? '')
    || (a.unitId ?? '').localeCompare(b.unitId ?? '')
  ));
  const mandatoryCount = sortedFindings.filter((f) => f.category === FINDING_CATEGORY.MANDATORY_GAP).length;
  // Only actionable gate drafts are optional suggestions. Non-actionable
  // discovery facts remain in gateDiagnostics and must not create a false
  // "suggestions" status or summary line.
  const status = deriveStatus([
    ...sortedFindings,
    ...(gateSuggestions.length > 0 ? [{ category: FINDING_CATEGORY.OPTIONAL_SUGGESTION }] : []),
  ]);
  const topology = {
    type: 'unknown',
    releaseUnits: (config.releaseUnits ?? []).map((unit) => ({
      id: unit.id,
      source: unit.source,
      distributions: (unit.distributions ?? []).map((d) => d.type),
    })),
    distributions: [...new Set(
      (config.releaseUnits ?? []).flatMap((unit) => (unit.distributions ?? []).map((d) => d.type)),
    )].sort(),
  };
  const hasPlugin = topology.distributions.some((type) => type.endsWith('-plugin'));
  const mandatoryMet = mandatoryCount === 0;
  const workflowPrerequisites = {
    full: { met: mandatoryMet, note: 'workflow 分类由 release-route 的 diff 分类决定；此处只报告配置前提，不复制 diff 分类。' },
    docs: { met: mandatoryMet, note: 'docs-only 工作流的分类与裁剪由 release-route 决定；配置前提与 full 相同。' },
    config: { met: mandatoryMet, note: 'config 工作流除配置前提外还会裁剪 gate 集合；此处只报告配置前提。' },
    marketplace: {
      met: mandatoryMet && hasPlugin,
      note: hasPlugin ? '需要至少一个插件分发渠道，且该渠道的权威事实完整。' : '当前拓扑无插件分发渠道，不适用。',
    },
  };
  const unobserved = [{
    field: '远端前提（npm/GitHub 可用性、发布标签序列）',
    note: '评估默认离线，未观测远端；不能据此否定本地接入，也不代表具备生产发布条件。',
  }];

  const digestPayload = hostCoverage.requested
    ? { configDigest, discoveryFacts: facts, hostCoverage: hostCoverage.binding }
    : { configDigest, discoveryFacts: facts };
  const publicCoverage = publicHostCoverage(hostCoverage);
  const report = {
    command: 'release-setup',
    mode: 'adoption-assessment',
    status,
    configPath,
    configDigest,
    assessmentDigest: sha256Hex(canonicalJson(digestPayload)),
    topology,
    findings: sortedFindings,
    hookDurations,
    gateSuggestions,
    gateDiagnostics,
    workflowPrerequisites,
    unobserved,
    hostCoverage: publicCoverage,
    next,
    summary: renderSummary({
      config,
      status,
      findings: sortedFindings,
      topology,
      hookDurations,
      gateSuggestions,
      next,
      hostCoverage: publicCoverage,
    }),
  };
  return Object.freeze(report);
}

/**
 * Deterministic Chinese summary over the sorted findings.
 *
 * @param {Object} input
 * @returns {string}
 */
function renderSummary({ config, status, findings, topology, gateSuggestions, next, hostCoverage }) {
  const lines = [];
  lines.push(`项目: ${config.project?.name ?? '(未命名)'}`);
  lines.push(`拓扑: ${topology.type}，发布单元 ${topology.releaseUnits.length} 个${topology.distributions.length > 0 ? `，分发渠道 ${topology.distributions.join(', ')}` : ''}`);
  lines.push(`接入状态: ${STATUS_LABEL[status] ?? status}`);
  const count = (category) => findings.filter((f) => f.category === category).length;
  lines.push(`必选缺口 ${count('mandatory-gap')} | 已满足 ${count('satisfied')} | 可选建议 ${count('optional-suggestion')} | 不适用 ${count('not-applicable')}`);
  if (hostCoverage?.requested) {
    lines.push(`宿主覆盖: 已请求，${hostCoverage.complete ? '事实完整' : '事实不完整'}，${hostCoverage.results.length} 项结果`);
  }
  const blocking = findings.filter((f) => f.category === FINDING_CATEGORY.MANDATORY_GAP);
  if (blocking.length > 0) {
    lines.push('阻断项:');
    for (const f of blocking) {
      lines.push(`  - [${f.code}] ${f.fieldPath ?? ''} ${f.message}`);
    }
  }
  const suggestions = findings.filter((f) => f.category === FINDING_CATEGORY.OPTIONAL_SUGGESTION);
  if (suggestions.length > 0) {
    lines.push('可选建议（不影响接入结论）:');
    for (const f of suggestions) {
      lines.push(`  - [${f.code}] ${f.fieldPath ?? ''} ${f.message}`);
    }
  }
  if (gateSuggestions.length > 0) {
    lines.push(`可执行 gate 草案 ${gateSuggestions.length} 条（需人工确认，未写入配置）`);
  }
  if (next) {
    lines.push(`下一步: ${next}`);
  }
  lines.push('注意: 评估默认离线且只读，未访问远端，未修改任何文件。');
  return lines.join('\n');
}
