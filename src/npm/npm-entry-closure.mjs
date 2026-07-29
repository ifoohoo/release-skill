import { tmpdir } from 'node:os';

import {
  buildNpmTarballFileIndex,
  computeFrozenSnapshot,
} from '../snapshot/frozen.mjs';

const SIMPLE_FIELDS = ['main', 'module', 'types', 'typings'];

function entryError(field, target, reason, message) {
  return { field, target, reason, message };
}

function validateRelativeTarget(target, field, { requireDotSlash = false } = {}) {
  if (typeof target !== 'string' || target.length === 0) {
    return {
      error: entryError(field, String(target ?? ''), 'invalid_type', `${field} target must be a non-empty string`),
    };
  }
  if (target.includes('\0')) {
    return { error: entryError(field, target, 'nul_in_path', `${field} target must not contain NUL`) };
  }
  if (
    target.startsWith('/') ||
    /^[A-Za-z]:[/\\]/.test(target) ||
    target.startsWith('\\\\')
  ) {
    return { error: entryError(field, target, 'absolute_path', `${field} target must be package-relative`) };
  }
  if (target.includes('\\')) {
    return { error: entryError(field, target, 'backslash_path', `${field} target must use forward slashes`) };
  }
  if (requireDotSlash && !target.startsWith('./')) {
    return {
      error: entryError(field, target, 'missing_dot_slash', `${field} target must start with "./"`),
    };
  }

  const relativeTarget = target.startsWith('./') ? target.slice(2) : target;
  const segments = relativeTarget.split('/');
  if (segments.includes('..')) {
    return {
      error: entryError(field, target, 'path_escape', `${field} target escapes the package root`),
    };
  }
  if (
    relativeTarget.length === 0 ||
    segments.some((segment) => segment === '' || segment === '.')
  ) {
    return {
      error: entryError(field, target, 'unsafe_segment', `${field} target contains an unsafe path segment`),
    };
  }
  if (requireDotSlash && segments.includes('node_modules')) {
    return {
      error: entryError(field, target, 'unsafe_segment', `${field} target must not contain node_modules`),
    };
  }
  return { target: relativeTarget };
}

function checkTarget({ field, target, fileIndex, requireDotSlash = false }) {
  const validated = validateRelativeTarget(target, field, { requireDotSlash });
  if (validated.error) return { errors: [validated.error], entries: [] };

  const indexed = fileIndex.get(validated.target);
  const found = indexed?.type === 'file';
  const entries = [{ field, target: validated.target, found }];
  if (found) return { entries, errors: [] };

  const reason = indexed === undefined ? 'entry_missing' : 'entry_not_regular_file';
  return {
    entries,
    errors: [
      entryError(
        field,
        validated.target,
        reason,
        indexed === undefined
          ? `${field} target "${validated.target}" is missing`
          : `${field} target "${validated.target}" is not a regular file`,
      ),
    ],
  };
}

function collectExports(value, location, result) {
  if (value === null) return;
  if (typeof value === 'string') {
    if (value.includes('*')) {
      result.errors.push(
        entryError(
          'exports',
          value,
          'unsupported_entry_shape',
          `${location} uses a wildcard target that the static gate cannot verify`,
        ),
      );
    } else {
      result.targets.push({ field: `exports ${location}`, target: value });
    }
    return;
  }
  if (Array.isArray(value)) {
    result.errors.push(
      entryError('exports', location, 'unsupported_entry_shape', `${location} uses unsupported fallback-array semantics`),
    );
    return;
  }
  if (typeof value !== 'object' || value === undefined) {
    result.errors.push(
      entryError('exports', String(value), 'invalid_exports_type', `${location} has an unsupported exports value`),
    );
    return;
  }

  for (const [key, child] of Object.entries(value)) {
    const childLocation = `${location}.${key}`;
    if (key.includes('*')) {
      result.errors.push(
        entryError(
          'exports',
          key,
          'unsupported_entry_shape',
          `${childLocation} uses a wildcard subpath that the static gate cannot verify`,
        ),
      );
      continue;
    }
    collectExports(child, childLocation, result);
  }
}

export function checkNpmEntryClosure(manifest, fileIndex) {
  const result = { entries: [], errors: [], diagnostics: [] };
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    result.errors.push(entryError('manifest', '', 'invalid_manifest', 'manifest must be an object'));
    return result;
  }
  if (!(fileIndex instanceof Map)) {
    result.errors.push(entryError('fileIndex', '', 'invalid_file_index', 'fileIndex must be a Map'));
    return result;
  }

  if (manifest.bin !== undefined && manifest.bin !== null) {
    if (typeof manifest.bin === 'string') {
      const checked = checkTarget({ field: 'bin', target: manifest.bin, fileIndex });
      result.entries.push(...checked.entries);
      result.errors.push(...checked.errors);
    } else if (typeof manifest.bin === 'object' && !Array.isArray(manifest.bin)) {
      for (const [name, target] of Object.entries(manifest.bin)) {
        const checked = checkTarget({ field: 'bin', target, fileIndex });
        result.entries.push(...checked.entries);
        result.errors.push(...checked.errors);
      }
    } else {
      result.errors.push(entryError('bin', String(manifest.bin), 'invalid_type', 'bin must be a string or object'));
    }
  }

  for (const field of SIMPLE_FIELDS) {
    if (manifest[field] === undefined || manifest[field] === null) continue;
    const checked = checkTarget({ field, target: manifest[field], fileIndex });
    result.entries.push(...checked.entries);
    result.errors.push(...checked.errors);
  }

  if (manifest.exports !== undefined) {
    const exportsResult = { targets: [], errors: [], diagnostics: [] };
    collectExports(manifest.exports, 'exports', exportsResult);
    result.errors.push(...exportsResult.errors);
    result.diagnostics.push(...exportsResult.diagnostics);
    for (const target of exportsResult.targets) {
      const checked = checkTarget({
        field: 'exports',
        target: target.target,
        fileIndex,
        requireDotSlash: true,
      });
      result.entries.push(...checked.entries);
      result.errors.push(...checked.errors);
    }
  }

  return result;
}

export async function buildTarballFileIndex(tarballBytes, tarballDir = tmpdir()) {
  return buildNpmTarballFileIndex({ tarballBytes, tarballDir });
}

export async function buildDirectoryFileIndex(packageDir) {
  const snapshot = await computeFrozenSnapshot(packageDir, { excludeRootEntries: ['.git'] });
  return new Map(snapshot.entries.map((entry) => [entry.path, { type: entry.type }]));
}
