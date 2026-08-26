/**
 * Structured evidence writer for release-skill.
 *
 * Creates append-only JSONL evidence streams (v2 schema) with automatic
 * redaction of sensitive keys, known token/credential shapes (anywhere in a
 * string, every occurrence), embedded URL userinfo, AND absolute filesystem
 * paths. The v1 schema (schemas/evidence-event.schema.json) was too strict
 * for the real event vocabulary and is retained only for legacy reads; every
 * NEW event is validated against schemas/evidence-event-v2.schema.json at
 * the write point (fail closed).
 *
 * v2 event shape (V4): the top level is closed — envelope fields, phase,
 * status, error, duration and details only. Every unknown top-level
 * extension field is relocated into `details` at the write point (single
 * choke point), and the schema type-constrains the declared location fields
 * (unitId, gate, hookName, actionId, step, hookId, tagCommit, ...) so
 * unregistered top-level fields and wrongly typed declared fields fail
 * closed.
 *
 * Error normalization (M1): diagnostic error fields are normalized before
 * validation — numeric child-process exit codes keep the real cause
 * (`EXIT_128` for a Git 128), free string errors become `UNKNOWN_ERROR`,
 * messages are coerced to strings. A real environment failure is never
 * replaced by a schema error.
 *
 * Writer lifecycle (R-06A, M2):
 * - `append(event)` returns the REAL monotonic sequence assigned to the
 *   event; the stream serializes concurrent appends through an internal
 *   mutex chain;
 * - `finish(summary)` is single-shot and runs INSIDE the same serial chain:
 *   the first call seals the summary and closes the stream, and every later
 *   finish — serial or concurrent — rejects without overwriting the seal;
 * - failure summaries are enriched (M5) with the FIRST specific failure
 *   location from the actual events: `stablePhase`, `failedUnitId`,
 *   `failedHook`, `failedAction`, `evidenceSequence`, the relative
 *   `evidencePath`, producer attribution and a table-driven
 *   `recoveryActionCode` (core/recovery.mjs). Long strings and arrays in
 *   summaries are bounded; missing information is explicitly "unknown".
 *
 * Producer identity (R-06B): every event carries `producer.name`/`version`
 * for attribution only — it is never an authority input.
 *
 * @module evidence
 */

import { open, mkdir, writeFile } from 'node:fs/promises';
import { basename } from 'node:path';

import Ajv from 'ajv';
import addFormats from 'ajv-formats';

import { redactEmbeddedUrlCredentials } from './git-url-policy.mjs';
import { redactSensitivePaths } from './redact.mjs';
import { recoveryActionCode } from './recovery.mjs';
import { ReleaseError, GATE_FAILED } from './errors.mjs';
import { readTrustedPackageResourceSync } from './trusted-resource.mjs';

/** Schema version for evidence events (v2 envelope). */
const SCHEMA_VERSION = 2;

/** v2 schema loaded from the package (trusted, no-follow read). */
const V2_SCHEMA = JSON.parse(readTrustedPackageResourceSync(
  'schemas/evidence-event-v2.schema.json',
).toString('utf8'));

const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);
const validateV2Event = ajv.compile(V2_SCHEMA);

/**
 * Key-name pattern that indicates a sensitive value requiring redaction.
 * Matches: token, secret, password, authorization, cookie (case-insensitive).
 */
const SENSITIVE_KEY_PATTERN = /token|secret|password|authorization|cookie/i;

/**
 * Known credential token shapes. Each pattern matches a credential VALUE
 * anywhere in a string (not only at the start) and every occurrence is
 * replaced, so a message carrying credentials in the middle — or several in
 * one string — still ends fully redacted on disk. The shapes stay
 * conservative by design:
 * - `ghp_`: GitHub classic PAT (36 base62 chars after the prefix);
 * - `github_pat_`: GitHub fine-grained PAT (20+ token chars after the prefix);
 * - `npm_`: npm access token shape (36+ base62 chars) — an ordinary
 *   `npm_config_*` setting name never matches and is not treated as a secret;
 * - `AKIA`: AWS access key id marker (16 uppercase alnum).
 */
const CREDENTIAL_PATTERNS = [
  { pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}/g, label: 'github_pat_' },
  { pattern: /\bghp_[A-Za-z0-9]{36}/g, label: 'ghp_' },
  { pattern: /\bnpm_[A-Za-z0-9]{36,}/g, label: 'npm_' },
  { pattern: /\bAKIA[0-9A-Z]{16}\b/g, label: 'AKIA' },
];

const REDACTED = '[REDACTED]';

/** Envelope fields owned by the writer; callers may never override them. */
const ENVELOPE_KEYS = new Set(['schemaVersion', 'runId', 'sequence', 'timestamp', 'command', 'producer']);

/**
 * Top-level fields declared by the v2 schema. Every other top-level key an
 * event carries is a phase-specific extension and is relocated into
 * `details` at the write point (V4): the top level stays closed, and the
 * schema rejects any unregistered residue or wrongly typed declared field.
 */
const DECLARED_TOP_LEVEL_FIELDS = new Set([
  ...ENVELOPE_KEYS,
  'phase',
  'status',
  'error',
  'duration',
  'details',
]);

/**
 * Merge the schema-visible event: declared fields stay top-level (error
 * normalized per M1), every unknown top-level extension key moves into
 * `details` together with any explicitly supplied details object (explicit
 * details win on name conflicts). A wrongly typed `details` (string, array)
 * is kept raw so the schema rejects it instead of silently mangling it.
 *
 * @param {Object} event - The caller-supplied event payload.
 * @returns {Object} The relocated, error-normalized payload.
 */
function relocateExtensions(event) {
  const extensions = {};
  for (const [key, value] of Object.entries(event)) {
    if (!DECLARED_TOP_LEVEL_FIELDS.has(key)) extensions[key] = value;
  }
  const rawDetails = event.details;
  const plainDetails = rawDetails !== null
    && typeof rawDetails === 'object'
    && !Array.isArray(rawDetails)
    ? rawDetails
    : null;
  const merged = { ...extensions, ...(plainDetails ?? {}) };
  return {
    phase: event.phase,
    status: event.status,
    ...(event.error !== undefined ? { error: normalizeError(event.error) } : {}),
    ...(event.duration !== undefined ? { duration: event.duration } : {}),
    ...(rawDetails !== undefined && plainDetails === null
      ? { details: rawDetails }
      : Object.keys(merged).length > 0 ? { details: merged } : {}),
  };
}

/**
 * Recursively redact sensitive values in an object.
 *
 * Redaction rules:
 * 1. If a key name matches `SENSITIVE_KEY_PATTERN`, its value is replaced
 *    with `[REDACTED]`.
 * 2. If a string value starts with a known credential prefix, it is replaced
 *    with `[REDACTED:<PREFIX>]`.
 * 3. Absolute filesystem paths are replaced with the stable placeholder
 *    `<redacted-path>` (composed from core/redact.mjs, the single redaction
 *    authority).
 * 4. Embedded URL userinfo is stripped before any other string handling.
 *
 * @param {*} obj - The value to redact (object, array, string, or primitive).
 * @returns {*} A new value with sensitive data redacted.
 */
export function redact(obj) {
  if (obj === null || obj === undefined) {
    return obj;
  }

  if (Array.isArray(obj)) {
    return obj.map((item) => redact(item));
  }

  if (typeof obj === 'object') {
    const result = {};
    for (const [key, value] of Object.entries(obj)) {
      if (SENSITIVE_KEY_PATTERN.test(key)) {
        result[key] = REDACTED;
      } else {
        result[key] = redact(value);
      }
    }
    return result;
  }

  if (typeof obj === 'string') {
    // F-05: strip any embedded URL userinfo before the value reaches disk.
    // Only credential-bearing URL spans are rewritten; ordinary strings and
    // credential-free URLs pass through unchanged.
    const urlRedacted = redactEmbeddedUrlCredentials(obj);
    // M3: every credential-shaped token in the string is redacted — the
    // match is not anchored to the start, so credentials in the middle of a
    // message and several credentials in one string are all covered.
    const credentialRedacted = CREDENTIAL_PATTERNS.reduce(
      (text, { pattern, label }) => text.replace(pattern, `[REDACTED:${label}]`),
      urlRedacted,
    );
    // Defect #3 composition: absolute filesystem paths never reach the
    // evidence stream or summary (release-identity data stays in relative
    // form; absolute paths are reconstructible diagnostics at best).
    return redactSensitivePaths(credentialRedacted);
  }

  return obj;
}

/**
 * Resolve the producer version for attribution.
 *
 * Bundled mode: the esbuild banner injects `__bundlePkg` (build-time
 * package identity) so the closure needs no package.json next to it.
 * Source mode: read the package.json through the trusted no-follow reader.
 *
 * Exported for consumers that must establish the current trusted-producer
 * version before judging historical evidence (adoption assessment R-11:
 * hook durations are only derived from events produced by the current
 * version).
 */
export function resolveProducerVersion() {
  if (typeof __bundlePkg !== 'undefined' && __bundlePkg && typeof __bundlePkg.version === 'string') {
    return __bundlePkg.version;
  }
  try {
    const pkg = JSON.parse(readTrustedPackageResourceSync('package.json').toString('utf8'));
    return typeof pkg.version === 'string' ? pkg.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/** Producer identity — attribution only (R-06B), never an authority. */
const PRODUCER = Object.freeze({ name: 'release-skill', version: resolveProducerVersion() });

/**
 * Normalize a diagnostic error value into the v2 error shape
 * `{code, message}` without losing the real cause (M1). Numeric
 * child-process exit codes (a Git 128, a hook exit code) become stable
 * `EXIT_<n>` codes, free strings become `UNKNOWN_ERROR` diagnostics, and the
 * message is coerced to a string. Values that cannot be meaningfully
 * normalized (wrong types) are returned untouched so the schema rejects them
 * fail closed.
 *
 * Applied by the writer at the write point (events and failure summaries),
 * so a raw environment failure is never replaced by a schema error.
 *
 * @param {*} error - Raw error value (Error instance, plain object, string).
 * @returns {{code: string, message?: string}|null|*}
 */
export function normalizeError(error) {
  if (error === null || error === undefined) return null;
  if (typeof error === 'string') {
    return { code: 'UNKNOWN_ERROR', message: error };
  }
  if (typeof error !== 'object' || Array.isArray(error)) return error;
  const rawCode = error.code;
  let code;
  if (typeof rawCode === 'string' && rawCode.length > 0) {
    code = rawCode;
  } else if (typeof rawCode === 'number' && Number.isInteger(rawCode) && rawCode >= 0) {
    code = `EXIT_${rawCode}`;
  } else {
    code = 'UNKNOWN_ERROR';
  }
  const normalized = { code };
  const rawMessage = error.message;
  if (typeof rawMessage === 'string') {
    normalized.message = rawMessage;
  } else if (rawMessage !== null && rawMessage !== undefined) {
    normalized.message = String(rawMessage);
  }
  return normalized;
}

/**
 * Shape a diagnostic error value for an evidence event (v2 schema: `error`
 * must be `{code, message}` or null). Callers pass the free string they
 * already carry (or null/undefined for success); the code is attribution
 * only — recovery codes come from the summary, not events. The result is
 * normalized like every other error diagnostic (M1).
 *
 * @param {string|number} code - Stable diagnostic code for this failure class.
 * @param {string|null|undefined} value - The free-form error message.
 * @returns {{code: string, message: string}|null}
 */
export function asError(code, value) {
  if (value === null || value === undefined) return null;
  const message = typeof value === 'string' ? value : String(value);
  return normalizeError({ code, message });
}

/**
 * Create an evidence writer that appends structured JSONL events and
 * produces a summary JSON file.
 *
 * @param {Object} options
 * @param {string} options.runDir - Absolute path to the run directory. The
 *   directory name (last segment) is used as the `runId`.
 * @param {string} options.command - The top-level command being executed
 *   (e.g. "prepare", "publish").
 * @param {() => string} [options.clock] - Optional clock function returning
 *   an ISO-8601 timestamp string. Defaults to `() => new Date().toISOString()`.
 * @returns {{ append: (event: Object) => Promise<number>, finish: (summary: Object) => Promise<void> }}
 */
export function createEvidenceWriter({ runDir, command, clock }) {
  const clockFn = typeof clock === 'function' ? clock : () => new Date().toISOString();
  const runId = basename(runDir);
  const evidencePath = `${runDir}/evidence.jsonl`;
  const summaryPath = `${runDir}/summary.json`;

  // Sequences start at 1, matching schemas/evidence-event-v2.schema.json
  // (`sequence.minimum: 1`).
  let sequence = 1;
  let handle = null;
  let sealed = false;
  // Last started/observed phase, used to attribute a later failure to a
  // stable stage (R-07). Updated from every appended event.
  let lastPhase = null;
  // Location of the FIRST failed-status event (R-07, M5). Commands append a
  // generic `<command>` failed event in their final catch BEFORE finish; that
  // wrapper must not overwrite the stage/unit/hook/action the failure
  // actually occurred in. The first failed event carries the real location;
  // when no phase-specific failure was evidenced, the generic wrapper itself
  // becomes the stable stage.
  let firstFailure = null;
  let appendedCount = 0;
  // Mutex chain serializing every append. Same-tier checkpoints run
  // concurrently, so multiple `append` calls can be in flight at once; even
  // under JS single-threading their awaits would interleave and could tear a
  // line. Chaining each append behind the previous one guarantees a complete
  // line is written before the next event starts.
  let appendChain = Promise.resolve();

  /**
   * Lazily open the evidence file for appending.
   * Creates the run directory if it does not exist.
   * Must only be called from inside the serialized append chain.
   */
  async function ensureHandle() {
    if (handle === null) {
      await mkdir(runDir, { recursive: true });
      handle = await open(evidencePath, 'a');
    }
  }

  /**
   * Append a single event to the evidence JSONL stream.
   *
   * The event is enriched with automatic metadata:
   * - `schemaVersion`: always 2 (v2 envelope)
   * - `runId`: extracted from the run directory name
   * - `sequence`: real auto-incrementing integer starting at 1
   * - `timestamp`: ISO-8601 string from the clock
   * - `command`: the command passed at creation time
   * - `producer`: {name, version} for attribution (R-06B)
   *
   * Envelope fields cannot be overridden by callers; an event attempting to
   * spoof them fails closed. The enriched event is validated against the v2
   * schema BEFORE it is written (fail closed), then redacted, then appended.
   *
   * @param {Object} event - The event data. Must include `phase` and `status`.
   * @returns {Promise<number>} The real sequence number assigned to the event.
   * @throws {ReleaseError} GATE_FAILED on schema violation, envelope spoofing,
   *   or append after `finish` sealed the stream.
   */
  async function appendOnce(event) {
    if (sealed) {
      // Sealed stream: appends after finish are silent no-ops — a late
      // failure (or a concurrent checkpoint completion) must never be able
      // to write into a stream that was already sealed by finish.
      return undefined;
    }
    if (event === null || typeof event !== 'object' || Array.isArray(event)) {
      throw new ReleaseError(GATE_FAILED, 'evidence event must be a plain object');
    }
    for (const key of ENVELOPE_KEYS) {
      if (key in event) {
        throw new ReleaseError(
          GATE_FAILED,
          `evidence event violates the v2 schema: "${key}" is an envelope field owned by the writer`,
          { field: key },
        );
      }
    }

    await ensureHandle();

    const enriched = {
      ...relocateExtensions(event),
      schemaVersion: SCHEMA_VERSION,
      runId,
      sequence,
      timestamp: clockFn(),
      command,
      producer: PRODUCER,
    };

    // Fail closed at the write point: every new event must pass the v2
    // schema. The v1 schema is never used for new writes (legacy reads only).
    const valid = validateV2Event(enriched);
    if (!valid) {
      const detail = (validateV2Event.errors ?? [])
        .map((e) => `${e.instancePath || '/'}: ${e.message}`)
        .join('; ');
      throw new ReleaseError(
        GATE_FAILED,
        `evidence event violates the v2 schema: ${detail}`,
      );
    }

    if (typeof enriched.phase === 'string' && enriched.phase.length > 0) {
      lastPhase = enriched.phase;
    }
    if (enriched.status === 'failed' && firstFailure === null) {
      // M5: remember the FIRST specific failure location from the actual
      // events so a later generic wrapper failure cannot hide it.
      firstFailure = {
        phase: typeof enriched.phase === 'string' && enriched.phase.length > 0
          ? enriched.phase
          : null,
        unitId: typeof enriched.details?.unitId === 'string' ? enriched.details.unitId : null,
        hookName: typeof enriched.details?.hookName === 'string' ? enriched.details.hookName : null,
        actionId: typeof enriched.details?.actionId === 'string' ? enriched.details.actionId : null,
        gate: typeof enriched.details?.gate === 'string' ? enriched.details.gate : null,
        sequence: enriched.sequence,
      };
    }

    sequence += 1;
    appendedCount += 1;

    const redacted = redact(enriched);
    const line = JSON.stringify(redacted);

    await handle.write(`${line}\n`, null, 'utf8');
    return enriched.sequence;
  }

  function append(event) {
    const result = appendChain.then(() => appendOnce(event));
    // Keep the chain alive even if one append rejects; the caller still
    // receives that rejection through `result`.
    appendChain = result.then(() => undefined, () => undefined);
    return result;
  }

  /**
   * Write the final summary file and close the evidence stream (single-shot).
   *
   * The seal runs INSIDE the same serial chain as the appends (M2), so the
   * first call wins deterministically: every queued append is drained first,
   * and any later finish — serial or concurrent — observes `sealed` inside
   * the chain and rejects without overwriting the first summary or
   * double-closing the handle.
   *
   * Failure summaries (status FAILED) are enriched (R-07/M5) from the actual
   * first failed event: `stablePhase`, `failedUnitId`, `failedHook`,
   * `failedAction`, `evidenceSequence` (the real writer-assigned sequence),
   * the relative `evidencePath`, producer attribution and a table-driven
   * `recoveryActionCode` (core/recovery.mjs); undeterminable fields are
   * explicitly "unknown"/null. Error diagnostics are normalized (M1) and all
   * long strings and arrays in the summary are bounded.
   *
   * @param {Object} summary - The run summary object.
   * @param {Object} [recoveryContext] - Optional context for the recovery
   *   action table (R-08): `{ succeededCheckpointCount }` — external
   *   checkpoints that already succeeded before the failure. Commands pass
   *   it so the code never suggests re-running succeeded external steps.
   * @throws {ReleaseError} GATE_FAILED if the writer is already sealed.
   */
  function finish(summary, recoveryContext = {}) {
    const result = appendChain.then(() => finishOnce(summary, recoveryContext));
    // Keep the chain alive even if the seal rejects; the caller still
    // receives that rejection through `result`.
    appendChain = result.then(() => undefined, () => undefined);
    return result;
  }

  async function finishOnce(summary, recoveryContext = {}) {
    if (sealed) {
      throw new ReleaseError(GATE_FAILED, 'evidence stream is already sealed; finish may only be called once');
    }
    await ensureHandle();

    const isFailure = summary?.status === 'FAILED';
    const normalizedError = normalizeError(summary?.error);
    // The stable failure location is the first failed-status event; the
    // generic `<command>` failed wrapper appended by the catch is only the
    // location when no phase-specific failure was evidenced first.
    const failurePhase = firstFailure?.phase ?? lastPhase;
    // Domain advice is supplied by the caller's readRunRecovery result.
    // Compatibility details only mirror it; absent advice keeps the fallback.
    const failureRecoveryCode = isFailure
      ? (appendedCount > 0 ? summary.recoveryActionCode : undefined) ?? recoveryActionCode({
          command,
          errorCode: normalizedError?.code,
          phase: failurePhase ?? undefined,
          succeededCheckpointCount: recoveryContext.succeededCheckpointCount ?? 0,
          hasEvidence: appendedCount > 0,
        })
      : undefined;
    const enrichedSummary = isFailure
      ? {
          ...summary,
          error: normalizedError,
          stablePhase: failurePhase ?? 'unknown',
          failedUnitId: firstFailure?.unitId ?? 'unknown',
          failedHook: firstFailure?.hookName ?? 'unknown',
          failedAction: firstFailure?.actionId ?? firstFailure?.gate ?? 'unknown',
          // The real writer-assigned sequence of the first failed event
          // (null when no failure event could be appended).
          evidenceSequence: firstFailure?.sequence ?? null,
          // Relative pointer: the summary sits in the same run directory as
          // the evidence stream, so the basename is the stable diagnostic
          // location (an absolute path would be redacted as <redacted-path>).
          evidencePath: basename(evidencePath),
          // Attribution only (R-06B): never an authority input.
          producer: PRODUCER,
          recoveryActionCode: failureRecoveryCode,
          ...(summary.details?.recoveryActionCode !== undefined
            ? { details: { ...summary.details, recoveryActionCode: failureRecoveryCode } }
            : {}),
        }
      : { ...summary, ...(summary?.error !== undefined ? { error: normalizedError } : {}) };

    const redacted = redact(boundSummaryValue(enrichedSummary));
    await writeFile(summaryPath, JSON.stringify(redacted, null, 2), 'utf8');

    if (handle !== null) {
      await handle.close();
      handle = null;
    }
    sealed = true;
  }

  return { append, finish };
}

/** Byte cap for any string value persisted into a summary (M5). */
const SUMMARY_STRING_MAX_BYTES = 2048;
/** Item cap for any array value persisted into a summary (M5). */
const SUMMARY_ARRAY_MAX_ITEMS = 50;
/** Marker appended to a truncated summary string. */
const SUMMARY_TRUNCATION_MARKER = '…[truncated]';

/**
 * Truncate a UTF-8 string to `maxBytes` without splitting a surrogate pair.
 *
 * @param {string} text
 * @param {number} maxBytes
 * @param {string} marker
 * @returns {string}
 */
function truncateUtf8(text, maxBytes, marker) {
  const budget = maxBytes - Buffer.byteLength(marker, 'utf8');
  if (budget <= 0) return marker;
  let out = Buffer.from(text, 'utf8').subarray(0, budget).toString('utf8');
  if (out.endsWith('�')) out = out.slice(0, -1);
  return out + marker;
}

/**
 * Bound a summary value for persistence (M5): strings are capped at
 * `SUMMARY_STRING_MAX_BYTES` (with an explicit truncation marker), arrays
 * are capped at `SUMMARY_ARRAY_MAX_ITEMS`, and the recursion covers nested
 * objects. The complete values stay in the evidence event stream — the
 * summary is only a diagnostic projection.
 *
 * @param {*} value
 * @returns {*}
 */
export function boundSummaryValue(value) {
  if (typeof value === 'string') {
    if (Buffer.byteLength(value, 'utf8') > SUMMARY_STRING_MAX_BYTES) {
      return truncateUtf8(value, SUMMARY_STRING_MAX_BYTES, SUMMARY_TRUNCATION_MARKER);
    }
    return value;
  }
  if (Array.isArray(value)) {
    const items = value.length > SUMMARY_ARRAY_MAX_ITEMS
      ? value.slice(0, SUMMARY_ARRAY_MAX_ITEMS)
      : value;
    return items.map(boundSummaryValue);
  }
  if (value !== null && typeof value === 'object') {
    const out = {};
    for (const [key, val] of Object.entries(value)) {
      out[key] = boundSummaryValue(val);
    }
    return out;
  }
  return value;
}
