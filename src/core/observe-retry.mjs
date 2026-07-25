/**
 * Bounded observe-with-retry for transient (PROPAGATING) remote states.
 *
 * After an `execute` writes to a remote system, the write may not be
 * immediately observable: package registries have eventual consistency
 * (e.g. `npm publish` succeeds but `npm view` cannot find the new
 * version for tens of seconds), and transient network errors happen.
 *
 * This module retries ONLY read-only `observe` calls while the remote
 * state is "information-insufficient" (missing / empty / threw). The
 * moment a concrete observation is read back, the caller classifies it
 * (CONSISTENT / CONFLICTING / TERMINAL_MISSING). A present-but-
 * mismatched observation (CONFLICTING) is NEVER retried: a conflict
 * is a real, authoritative disagreement that must fail closed and be
 * resolved by a human. This is exactly the safety semantics required by
 * the release-skill governance (fail-closed, observe stays read-only,
 * no execute retry, no auto-overwrite of remote state).
 *
 * Callers wire this into the four observe call sites (publish executeCheckpoint
 * and the three reconcile observation points). The retry policy is fixed and
 * not user-configurable on purpose: it never enters the frozen plan or the
 * approval record, so changing it cannot invalidate an approved release.
 *
 * @module core/observe-retry
 */

/**
 * Default retry policy.
 *
 * The first observe call happens immediately; each subsequent retry waits
 * the corresponding delay. With `maxAttempts: 5` and four delays the
 * total worst-case retry window is ~150s (10+20+40+80). That is the
 * cost of avoiding a manual reconcile loop (minutes of human time).
 *
 * @type {{ maxAttempts: number, delaysMs: ReadonlyArray<number> }}
 */
export const DEFAULT_OBSERVE_RETRY_POLICY = Object.freeze({
  maxAttempts: 5,
  delaysMs: Object.freeze([10_000, 20_000, 40_000, 80_000]),
});

/**
 * Reduce a retry policy so its total delay window fits inside a hard
 * timeout (e.g. a marketplace action's `timeoutMs`, valid range 30s-900s).
 *
 * If the policy already fits, it is returned unchanged. Otherwise delays are
 * dropped from the end (longest first) until the remaining sum fits, and
 * `maxAttempts` is recomputed as `delays.length + 1` (one immediate
 * observe plus one per remaining delay). Always leaves at least one attempt.
 *
 * @param {{ maxAttempts: number, delaysMs: ReadonlyArray<number> }} policy
 * @param {number|null|undefined} timeoutMs - Hard ceiling in milliseconds.
 * @returns {{ maxAttempts: number, delaysMs: number[] }}
 */
export function clampPolicyToTimeout(policy, timeoutMs) {
  if (timeoutMs == null || typeof timeoutMs !== 'number' || timeoutMs <= 0) {
    return policy;
  }
  const delays = [...policy.delaysMs];
  let total = delays.reduce((sum, ms) => sum + ms, 0);
  // Already fits the timeout: return the SAME policy object, unchanged.
  if (total <= timeoutMs) {
    return policy;
  }
  while (delays.length > 0 && total > timeoutMs) {
    const dropped = delays.pop();
    const newTotal = total - dropped;
    if (newTotal <= timeoutMs) {
      total = newTotal;
      break;
    }
    total = newTotal;
  }
  const maxAttempts = Math.max(1, delays.length + 1);
  return { maxAttempts, delaysMs: delays };
}

function defaultClock() {
  return new Date().toISOString();
}

/**
 * Default inter-attempt delay.
 *
 * Test escape hatch: when `RELEASE_SKILL_OBSERVE_RETRY_NO_WAIT=1` is set,
 * the delay resolves immediately. This ONLY skips the wall-clock wait for
 * spawned-CLI test sandboxes (in-process tests inject a sleep instead);
 * attempt counts, ordering, and PROPAGATING/CONFLICTING classification are
 * unchanged, so it cannot weaken any fail-closed decision.
 */
function defaultSleep(ms) {
  if (process.env.RELEASE_SKILL_OBSERVE_RETRY_NO_WAIT === '1') {
    return Promise.resolve();
  }
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Decide whether an observe/verify result is "information-insufficient"
 * (PROPAGATING) and therefore a candidate for retry.
 *
 * Returns `true` when the remote state is unknown or explicitly absent:
 * - the call threw (no result at all)
 * - the observation is missing or an empty object
 * - an explicit absence marker is present (`exists:false`, `published:false`,
 *   `installed:false`, empty commit strings)
 *
 * Returns `false` when a concrete observation was read back. A present
 * observation — even if it does NOT match the expected state — is a
 * CONFLICTING signal, not a propagation delay, and must NOT be retried.
 *
 * @param {{ observation?: Object|null, error?: string|null }|null} result
 * @returns {boolean}
 */
export function isPropagatingMissing(result) {
  if (result == null) return true;
  const { observation } = result;
  if (observation == null) return true;
  if (Object.keys(observation).length === 0) return true;
  if (observation.exists === false) return true;
  if (observation.remoteCommit === '') return true;
  if (observation.commit === '') return true;
  if (observation.published === false) return true;
  if (observation.installed === false) return true;
  // NOTE: a thrown observe surfaces as `error` with a null-ish observation,
  // which is already covered by the `observation == null` / empty checks above.
  return false;
}

/**
 * Retry a read-only `observe` (or `verify`, which is observe+match) while
 * the remote state is information-insufficient.
 *
 * @param {Object} options
 * @param {Function} options.observe - `(action, context) => Promise<result>`.
 *   The result must expose `.observation` and `.error` (the `createResult`
 *   shape). Throwing is treated as a propagating miss and retried.
 * @param {Object} options.action - Adapter action passed through to `observe`.
 * @param {Object} options.context - Adapter context passed through to `observe`.
 * @param {Function} [options.isMissing] - Override for the missing check
 *   (defaults to {@link isPropagatingMissing}).
 * @param {Object} [options.policy] - Retry policy (defaults to
 *   {@link DEFAULT_OBSERVE_RETRY_POLICY}).
 * @param {Function} [options.clock] - `() => string` timestamp for evidence.
 * @param {Function} [options.sleep] - `(ms) => Promise` delay (injected in tests).
 * @param {Function} [options.onAttempt] - `async (info) => void` evidence hook,
 *   called once per attempt with `{ attempt, maxAttempts, missing, delayMs,
 *   threw, observation, error, timestamp }`.
 * @returns {Promise<{ result: Object|null, missing: boolean, attempts: number, exhausted: boolean, threw: boolean }>}
 *   `result` is the last raw observe/verify result (or a normalized
 *   `{ observation: null, error }` when the final attempt threw). It is
 *   handed back to the caller so the caller can run its own
 *   CONSISTENT/CONFLICTING/TERMINAL_MISSING classification unchanged.
 */
export async function observeWithRetry({
  observe,
  action,
  context,
  isMissing = isPropagatingMissing,
  policy = DEFAULT_OBSERVE_RETRY_POLICY,
  clock = defaultClock,
  sleep = defaultSleep,
  onAttempt,
} = {}) {
  const delays = [...(policy.delaysMs ?? [])];
  const maxAttempts = policy.maxAttempts ?? delays.length + 1;

  let lastResult = null;
  let lastThrew = false;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    let result;
    let threw = false;
    try {
      result = await observe(action, context);
    } catch (error) {
      threw = true;
      lastThrew = true;
      result = { observation: null, error: error?.message ?? String(error) };
    }
    lastResult = result;

    const missing = isMissing(result);
    // The delay that will actually be applied AFTER this attempt: only when
    // the state is still missing and a delay remains. On the final attempt
    // (or a resolved attempt) this is 0, reported truthfully.
    const willSleep = missing && attempt < delays.length;
    const delayMs = willSleep ? delays[attempt] : 0;

    if (onAttempt) {
      await onAttempt({
        attempt: attempt + 1,
        maxAttempts,
        missing,
        delayMs,
        threw,
        observation: result?.observation ?? null,
        error: result?.error ?? null,
        timestamp: clock(),
      });
    }

    // A concrete observation was read back: not a propagation delay.
    // Return immediately so the caller can classify it (including a real
    // CONFLICTING mismatch, which must never be retried).
    if (!missing) {
      return { result, missing: false, attempts: attempt + 1, exhausted: false, threw: false };
    }

    // Still missing: wait before the next attempt (unless this was the last).
    if (willSleep) {
      await sleep(delays[attempt]);
    }
  }

  return {
    result: lastResult,
    missing: true,
    attempts: maxAttempts,
    exhausted: true,
    threw: lastThrew,
  };
}
