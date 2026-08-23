/**
 * Frozen GitHub Release asset identities.
 *
 * This module owns only release-domain mapping: a plan freezes local asset
 * paths and their already-computed SHA-256 values, while remote observation
 * reduces the downloaded bytes to the same name/digest identity list.
 */

import { basename } from 'node:path';

import { canonicalJson, sha256Hex } from './digest.mjs';

const SHA256_RE = /^[a-f0-9]{64}$/u;
const SAFE_ASSET_NAME_RE = /^(?!\.{1,2}$)[A-Za-z0-9][A-Za-z0-9._-]*$/u;

/** Validate and normalize a plan's optional frozen Release assets. */
export function normalizeReleaseAssets(assets) {
  if (assets === undefined) return [];
  if (!Array.isArray(assets) || assets.length === 0) {
    throw new TypeError('releaseAssets must be a non-empty array when present');
  }
  const names = new Set();
  const normalized = assets.map((asset, index) => {
    if (!asset || typeof asset !== 'object' || Array.isArray(asset)) {
      throw new TypeError(`releaseAssets[${index}] must be an object`);
    }
    const keys = Object.keys(asset).sort();
    if (canonicalJson(keys) !== canonicalJson(['name', 'path', 'sha256'])) {
      throw new TypeError(`releaseAssets[${index}] must contain only name, path, and sha256`);
    }
    if (typeof asset.path !== 'string' || asset.path.length === 0) {
      throw new TypeError(`releaseAssets[${index}].path must be a non-empty project-relative path`);
    }
    if (!SAFE_ASSET_NAME_RE.test(asset.name ?? '') || basename(asset.path) !== asset.name) {
      throw new TypeError(`releaseAssets[${index}].name must be a safe basename matching path`);
    }
    if (!SHA256_RE.test(asset.sha256 ?? '')) {
      throw new TypeError(`releaseAssets[${index}].sha256 must be a lowercase SHA-256 digest`);
    }
    if (names.has(asset.name)) {
      throw new TypeError(`releaseAssets contains duplicate asset name "${asset.name}"`);
    }
    names.add(asset.name);
    return Object.freeze({ name: asset.name, path: asset.path, sha256: asset.sha256 });
  });
  normalized.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
  return Object.freeze(normalized);
}

/** Digest only public remote identity, never local paths. */
export function digestReleaseAssetIdentities(assets) {
  const identities = normalizeReleaseAssets(assets).map(({ name, sha256 }) => ({ name, sha256 }));
  return sha256Hex(canonicalJson(identities));
}
