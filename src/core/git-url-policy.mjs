/**
 * Release-domain Git remote URL policy (architecture gap F-05, T5).
 *
 * The SINGLE boundary for every postPublish remote-write URL: allowed
 * protocols, the Git path shape, and the remote-write grading. Consumers:
 * core/postpublish.mjs (declaration re-validation), core/presets.mjs (preset
 * registry config), core/preset-gitwrite.mjs + core/proposal-inbox.mjs
 * (write transports), adapters/distribute-git.mjs (legacy target mirror).
 * The root JSON schemas are only the first gate; this runtime policy is the
 * final authority, so plans frozen by older schema versions cannot smuggle
 * unsafe URLs through.
 *
 * Boundary rules (what this module is NOT):
 * - Parsing is delegated to the standard WHATWG URL — this module expresses
 *   release-domain POLICY over the parse result; it implements no generic
 *   URL parser.
 * - Credential redaction is delegated to the Foundation
 *   `redactUrlCredentials` (skill-family-harness-node, FG-2) — this module
 *   implements no generic redactor; it only decides WHEN the Foundation
 *   redactor applies so non-URL strings are never collapsed into the opaque
 *   placeholder.
 *
 * Fail-closed vocabulary: every rejection reason is a stable token, and
 * failure text NEVER carries the original URL — a rejected URL may hold
 * userinfo credentials, and echoing it would defeat the boundary.
 *
 * @module core/git-url-policy
 */

import {
  redactUrlCredentials,
  REDACTED_URL_PLACEHOLDER,
} from 'skill-family-harness-node';

/**
 * Protocols allowed for postPublish remote writes: http(s) for real remotes,
 * file: strictly as the test transport.
 */
export const GIT_REMOTE_PROTOCOLS = Object.freeze(['http:', 'https:', 'file:']);

/**
 * Remote-write grading (发布领域远端写分级): the protocol decides the grade —
 * http(s) are real remote writes, file: is the test transport. Central here
 * so no consumer re-derives grading from its own protocol regex.
 */
export const GIT_REMOTE_WRITE_GRADES = Object.freeze({
  'http:': 'remote-write',
  'https:': 'remote-write',
  'file:': 'test-transport',
});

/** Rejection reason vocabulary; every entry is safe to surface (no URL). */
export const GIT_REMOTE_URL_REASONS = Object.freeze({
  NOT_A_STRING: 'not-a-string',
  CONTROL_CHARACTERS: 'control-characters',
  UNPARSEABLE: 'unparseable',
  PROTOCOL_NOT_ALLOWED: 'protocol-not-allowed',
  MISSING_HOST: 'missing-host',
  CREDENTIALS_PRESENT: 'credentials-present',
  QUERY_OR_FRAGMENT_REJECTED: 'query-or-fragment-rejected',
  NOT_A_GIT_PATH: 'not-a-git-path',
});

/**
 * Human-readable failure text per rejection reason. Deliberately carries NO
 * part of the offending URL (a credential-bearing URL must never be echoed
 * back through an error surface).
 */
const FAILURE_TEXT = Object.freeze({
  [GIT_REMOTE_URL_REASONS.NOT_A_STRING]: 'must be a non-empty string',
  [GIT_REMOTE_URL_REASONS.CONTROL_CHARACTERS]: 'contains control characters',
  [GIT_REMOTE_URL_REASONS.UNPARSEABLE]:
    'must be an absolute URL parseable by the standard URL parser',
  [GIT_REMOTE_URL_REASONS.PROTOCOL_NOT_ALLOWED]:
    'protocol must be http:, https:, or file: (file: is the test transport)',
  [GIT_REMOTE_URL_REASONS.MISSING_HOST]: 'http(s) URLs must carry a host',
  [GIT_REMOTE_URL_REASONS.CREDENTIALS_PRESENT]:
    'must never carry embedded credentials (username/password) — credentials belong to the host git credential helper, never to the URL',
  [GIT_REMOTE_URL_REASONS.QUERY_OR_FRAGMENT_REJECTED]:
    'must carry no query or fragment',
  [GIT_REMOTE_URL_REASONS.NOT_A_GIT_PATH]: 'pathname must end in .git',
});

/**
 * Describe one rejection reason for error messages (always URL-free).
 *
 * @param {string} reason - One of GIT_REMOTE_URL_REASONS.
 * @returns {string} Safe human-readable failure text.
 */
export function describeGitRemoteUrlFailure(reason) {
  return FAILURE_TEXT[reason] ?? 'is not an allowed Git remote URL';
}

/**
 * The runtime contract check for one postPublish remote-write URL:
 * 1. non-empty string, no control characters (checked on the RAW value —
 *    WHATWG parsing silently folds \t\r\n, so the raw check fails closed);
 * 2. `new URL()` parse (the standard parser is the only parser);
 * 3. protocol allowlist: http:, https:, file: (test transport);
 * 4. http(s) must carry a host;
 * 5. ALL protocols reject a non-empty username or password;
 * 6. no query or fragment (a git remote URL is a bare location);
 * 7. the PATHNAME ends in .git.
 *
 * @param {*} remoteUrl
 * @returns {{ ok: true, protocol: string, grade: string }
 *   | { ok: false, reason: string }} The verdict never carries the input.
 */
export function checkGitRemoteUrl(remoteUrl) {
  if (typeof remoteUrl !== 'string' || remoteUrl.length === 0) {
    return { ok: false, reason: GIT_REMOTE_URL_REASONS.NOT_A_STRING };
  }
  if (/[\x00-\x1f\x7f]/.test(remoteUrl)) {
    return { ok: false, reason: GIT_REMOTE_URL_REASONS.CONTROL_CHARACTERS };
  }
  let url;
  try {
    url = new URL(remoteUrl);
  } catch {
    return { ok: false, reason: GIT_REMOTE_URL_REASONS.UNPARSEABLE };
  }
  if (!GIT_REMOTE_PROTOCOLS.includes(url.protocol)) {
    return { ok: false, reason: GIT_REMOTE_URL_REASONS.PROTOCOL_NOT_ALLOWED };
  }
  if (url.protocol !== 'file:' && url.hostname === '') {
    return { ok: false, reason: GIT_REMOTE_URL_REASONS.MISSING_HOST };
  }
  if (url.username !== '' || url.password !== '') {
    return { ok: false, reason: GIT_REMOTE_URL_REASONS.CREDENTIALS_PRESENT };
  }
  if (url.search !== '' || url.hash !== '') {
    return { ok: false, reason: GIT_REMOTE_URL_REASONS.QUERY_OR_FRAGMENT_REJECTED };
  }
  if (!url.pathname.endsWith('.git')) {
    return { ok: false, reason: GIT_REMOTE_URL_REASONS.NOT_A_GIT_PATH };
  }
  return { ok: true, protocol: url.protocol, grade: GIT_REMOTE_WRITE_GRADES[url.protocol] };
}

/**
 * Boolean form of the policy check (cross-check skip decisions, probes).
 *
 * @param {*} remoteUrl
 * @returns {boolean} True only for policy-allowed Git remote URLs.
 */
export function isAllowedGitRemoteUrl(remoteUrl) {
  return checkGitRemoteUrl(remoteUrl).ok === true;
}

/**
 * Remote-write grade for one policy-allowed URL; null when the URL does not
 * pass the policy (grading never applies to rejected URLs).
 *
 * @param {*} remoteUrl
 * @returns {'remote-write'|'test-transport'|null}
 */
export function resolveGitRemoteWriteGrade(remoteUrl) {
  const verdict = checkGitRemoteUrl(remoteUrl);
  return verdict.ok ? verdict.grade : null;
}

/**
 * Guarded credential redaction for long-lived outputs (evidence, error
 * messages/details, preset observations). Delegates the actual redaction to
 * the Foundation `redactUrlCredentials`:
 * - values that parse as an absolute URL carrying userinfo come back as the
 *   Foundation's credential-free serialization;
 * - unparseable `scheme://...@...` authority shapes cannot be proven
 *   credential-free and fail closed to the opaque placeholder (the same
 *   stance as the Foundation's degraded path);
 * - every other value returns UNCHANGED (blindly applying the Foundation
 *   redactor would collapse ordinary non-URL strings into the placeholder).
 *
 * @param {*} value
 * @returns {*} The credential-free value (or the input, unchanged).
 */
export function redactUrlCredentialsIfPresent(value) {
  if (typeof value !== 'string' || value.length === 0) return value;
  let url;
  try {
    url = new URL(value);
  } catch {
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^/]*@/.test(value)) {
      return REDACTED_URL_PLACEHOLDER;
    }
    return value;
  }
  if (url.username === '' && url.password === '') return value;
  return redactUrlCredentials(url);
}

/**
 * Candidate URL-span tokenizer for prose (log lines, error messages). It only
 * LOCATES spans shaped like `scheme://...`; the credential decision and the
 * redaction itself are delegated to the standard URL parser + the Foundation
 * redactor via redactUrlCredentialsIfPresent. This is what makes the error
 * and evidence chokepoints safe "even if a validation misses" (F-05): a
 * credential-bearing URL embedded mid-sentence cannot survive to disk.
 */
const URL_SPAN_RE = /\b[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^\s'"<>`]+/g;

/**
 * Redact credential-bearing URL spans anywhere inside a string (whole value
 * or embedded in prose). Credential-free spans and all non-URL text return
 * byte-for-byte unchanged.
 *
 * @param {*} text
 * @returns {*} The credential-free string (or the input, unchanged).
 */
export function redactEmbeddedUrlCredentials(text) {
  if (typeof text !== 'string' || text.length === 0) return text;
  if (!text.includes('://')) return text;
  return text.replace(URL_SPAN_RE, (span) => redactUrlCredentialsIfPresent(span));
}
