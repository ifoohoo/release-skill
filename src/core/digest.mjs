/**
 * Deterministic canonical JSON serialisation and SHA-256 digest.
 *
 * 机制已委托 Foundation（skill-family-foundation-adoption-20260815 节点 1.6）：
 * - `canonicalJson` 的权威序列化由 `skill-family-contracts` 的 canonicalJson
 *   承担（键递归排序 + JSON.stringify，严格 JSON 数据域）；本地保留宽松输入域
 *   归一化包装（undefined 对象属性省略 / 数组 undefined→null / Date→ISO 字符串 /
 *   Buffer→{data,type} / NaN→null），与迁移前的本地宽松字节语义完全一致。
 * - `sha256Hex` 委托 `skill-family-harness-node` 的 digestBytes（同一
 *   createHash('sha256') 实现，字节一致）。
 *
 * `canonicalJson` recursively sorts object keys (deep-first) while preserving
 * array element order, then serialises the result as a UTF-8 JSON string.
 * Two objects with the same logical content but different key insertion order
 * always produce the identical output.
 *
 * `sha256Hex` computes the SHA-256 hash of a UTF-8 string (or Buffer) and
 * returns the lowercase hex encoding.
 *
 * @module digest
 */

import { canonicalJson as contractsCanonicalJson } from 'skill-family-contracts';
import { digestBytes } from 'skill-family-harness-node';

/**
 * Recursively sort every object key in depth-first order and serialise as
 * a deterministic UTF-8 JSON string.
 *
 * Rules (本地宽松语义，迁移前后字节一致):
 * - Object keys are sorted lexicographically (same order as `Array.sort()`).
 * - Array element order is preserved.
 * - Primitives (`null`, booleans, numbers, strings) pass through unchanged.
 * - `undefined` values in objects are omitted (matching `JSON.stringify`).
 * - `undefined` values inside arrays become `null` (matching `JSON.stringify`).
 * - `BigInt` values throw (matching `JSON.stringify`).
 * - `Date` objects are serialised via `.toISOString()` (matching
 *   `JSON.stringify`).
 * - `NaN`/`Infinity` become `null`; function/symbol object properties are
 *   omitted, array elements become `null` (matching `JSON.stringify`).
 *
 * 输入域适配后再委托 Foundation contracts 的严格权威序列化，因此对纯 JSON
 * 输入与 Foundation `digestDocument` 完全同构。
 *
 * @param {*} obj - Any JSON-serialisable value.
 * @returns {string} A UTF-8 JSON string whose key ordering is deterministic.
 */
export function canonicalJson(obj) {
  const normalized = normalizeLenient(obj);
  // JSON.stringify 顶层对 undefined/function/symbol 返回 undefined（本地原语义）。
  if (normalized === undefined || typeof normalized === 'function' || typeof normalized === 'symbol') {
    return undefined;
  }
  return contractsCanonicalJson(normalized);
}

/**
 * Compute the SHA-256 digest of a UTF-8 string or Buffer.
 *
 * 委托 Foundation harness-node `digestBytes`（实现与本地 createHash 完全一致）。
 *
 * @param {string | Buffer} input - The data to hash.
 * @returns {string} Lowercase hexadecimal SHA-256 digest (64 hex chars).
 */
export function sha256Hex(input) {
  return digestBytes(input);
}

// ---- internal helpers (not exported) ----

/**
 * 宽松输入域归一化：把本地历史接受的、非严格 JSON 的值转换为与
 * `JSON.stringify` 一致的严格 JSON 兼容值，再交由 Foundation 权威序列化。
 * 该函数产生的字节序列与迁移前的本地 canonicalise + JSON.stringify 完全一致。
 *
 * @param {*} value
 * @returns {*}
 */
function normalizeLenient(value) {
  if (value === null || value === undefined) {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => {
      const normalized = normalizeLenient(item);
      // JSON.stringify 把数组中的 undefined/function/symbol 序列化为 null。
      return (normalized === undefined || typeof normalized === 'function' || typeof normalized === 'symbol')
        ? null
        : normalized;
    });
  }

  // Date gets its own branch so we can call toISOString() before the
  // typeof === 'object' check swallows it.
  if (value instanceof Date) {
    return value.toISOString();
  }

  // Buffer gets its own branch: toJSON() returns {type:'Buffer', data:[...]}
  // which matches JSON.stringify and survives a JSON roundtrip.
  if (Buffer.isBuffer(value)) {
    return normalizeLenient(value.toJSON());
  }

  if (typeof value === 'object') {
    const sorted = {};
    for (const key of Object.keys(value).sort()) {
      const v = value[key];
      // JSON.stringify 语义：对象中 undefined/function/symbol 属性被省略。
      if (v === undefined || typeof v === 'function' || typeof v === 'symbol') continue;
      sorted[key] = normalizeLenient(v);
    }
    return sorted;
  }

  // JSON.stringify 把 NaN/±Infinity 序列化为 null。
  if (typeof value === 'number' && !Number.isFinite(value)) {
    return null;
  }

  // Primitives: string, number, boolean, null, bigint (bigint 由 Foundation
  // 严格序列化抛 TypeError，与本地 JSON.stringify 抛 TypeError 一致)。
  return value;
}
