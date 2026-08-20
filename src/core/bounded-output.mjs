/**
 * Bounded hook-output tails (v0.6.3 R1 tail unification).
 *
 * Single authority for the "last 50 lines, capped at 8 KiB" tail semantics
 * used everywhere a captured child-output stream is persisted as evidence:
 * prepare hook failures (original home) and distribute postPublish hook
 * failures (R1; previously a 4000-character slice). Keeping both call sites
 * on one implementation means triage output can never diverge between the
 * prepare and distribute phases.
 *
 * @module core/bounded-output
 */

/** Maximum number of output lines preserved in a hook-failure tail. */
export const HOOK_OUTPUT_TAIL_MAX_LINES = 50;
/** Maximum bytes preserved in a hook-failure tail. */
export const HOOK_OUTPUT_TAIL_MAX_BYTES = 8 * 1024;

/**
 * Bound a captured child-output stream to the tail that matters for triage:
 * the last 50 lines, further capped at 8 KB — whichever is smaller.
 *
 * @param {string} [text] - Captured stdout/stderr text.
 * @returns {string} The bounded tail ('' for empty/absent input).
 */
export function boundedOutputTail(text) {
  if (typeof text !== 'string' || text.length === 0) return '';
  let lines = text.split('\n');
  // A trailing newline produces an empty final element; drop it so the line
  // budget counts real output lines.
  if (lines.length > 1 && lines[lines.length - 1] === '') {
    lines = lines.slice(0, -1);
  }
  let tail = lines.slice(-HOOK_OUTPUT_TAIL_MAX_LINES);
  let joined = tail.join('\n');
  while (tail.length > 1 && Buffer.byteLength(joined, 'utf8') > HOOK_OUTPUT_TAIL_MAX_BYTES) {
    tail = tail.slice(1);
    joined = tail.join('\n');
  }
  if (Buffer.byteLength(joined, 'utf8') > HOOK_OUTPUT_TAIL_MAX_BYTES) {
    // A single line exceeds the byte cap: keep the trailing bytes.
    const buf = Buffer.from(joined, 'utf8');
    joined = buf.subarray(buf.length - HOOK_OUTPUT_TAIL_MAX_BYTES).toString('utf8');
  }
  return joined;
}
