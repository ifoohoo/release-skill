/**
 * Foundation runtime resource projection for the self-contained bundle.
 *
 * WP-1 bundle closure (release-skill 0.8.0, Foundation 0.11.0): the esbuild
 * bundle inlines Foundation JavaScript, but three classes of runtime
 * resources are not carried by the bundle itself:
 *
 *   - kit  directory reads:   new URL("../data/hosts/", import.meta.url) and
 *                             new URL("../data/licensing/", import.meta.url)
 *                             (directory URLs)
 *   - harness path.join reads: prebuild-manifest.json + prebuilds/** fixed
 *                              matrix (invisible to the new URL regex)
 *   - contracts dynamic reads: ../${entry.file} schema documents driven by
 *                              src/registry.json (targets land outside bin/)
 *
 * One selection result drives everything (ruling 10 / B2-B4): the member set,
 * the verification scope and the on-disk binding record all derive from the
 * same computed projection. There is no `bin/` special case and no second
 * hand-written directory table — every bundle-adjacent and bundle-relative
 * read flows through the same selection; directory scopes are recorded by
 * the selection sections themselves.
 *
 * Write protection: the projection executes through the Foundation Kit
 * projection transaction (compileProjectionPlan + runProjection) with the
 * binding record bound as caller-provided authority bytes; the record itself
 * is published strictly (no-follow, byte + mode verified). The existing
 * record and every recorded member are re-read with Harness bound reads
 * (readFileStrict + expectedSha256), so symlinked parents, symlinked leaves,
 * symlinked records, missing members, size drift and byte drift all fail
 * closed before and during the write.
 *
 * B5 (ruling 11): the contracts `./fixtures/` tree is projected ONLY when the
 * formal bundle actually consumes it (readdirSync(FIXTURES_DIR) survives
 * tree-shaking iff the read is live). An unconsumed fixtures directory is
 * dropped from the selection and becomes an empty-member managed scope.
 *
 * License/NOTICE/third-party declarations of the three packages are projected
 * into bin/foundation-legal/<pkg>/ so the copied closure carries its own legal
 * notices without node_modules.
 *
 * All targets are relative posix paths under the package root; no absolute
 * machine path ever enters a public output.
 *
 * @module producers/foundation-resource-projection
 */

import { chmod, lstat, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve, sep, posix as pathPosix } from 'node:path';

import { buildProjectionClosure, compileProjectionPlan, runProjection } from 'skill-family-engineering-kit';
import { digestBytes, publishFileOrReplace, readFileStrict, withTemporaryWorkspace } from 'skill-family-harness-node';

import { canonicalJson } from '../core/digest.mjs';

export const FOUNDATION_PACKAGES = Object.freeze({
  'skill-family-contracts': '0.13.0',
  'skill-family-engineering-kit': '0.13.0',
  'skill-family-harness-node': '0.13.0',
});

export const BINDING_RECORD_PATH = 'bin/foundation-resource-binding.json';

// Projection plan constants (the plan binds the record as caller-provided
// authority bytes; the owner id marks the generated managed paths).
const AUTHORITY_ID = 'foundation-resource-binding';
const OWNER_ID = 'release-skill-build-bundle';

// Same patterns as scripts/build-bundle.mjs (keep in sync).
const MODULE_MARK_RE = /(?:\/\/\s*|")((?:\.\.\/)+[^\s"()]+\.(?:mjs|js|cjs))/g;
const RUNTIME_URL_READ_RE = /new URL\(\s*"([^"]+)"\s*,\s*import\.meta\.url\s*\)/g;

const LEGAL_FILES = Object.freeze(['LICENSE', 'NOTICE', 'THIRD_PARTY_NOTICES']);

const FOUNDATION_MODULE_RE = /node_modules\/(?:\.pnpm\/[^/]+\/node_modules\/)?(skill-family-[a-z-]+)\//;

/** Classify a bundle module path (posix, relative to pkgRoot) into a Foundation package. */
function foundationPackageOf(modulePath) {
  const match = FOUNDATION_MODULE_RE.exec(modulePath);
  return match ? match[1] : null;
}

function toPosix(p) {
  return p.split(sep).join('/');
}

/** Enumerate a directory tree (sorted, symlink-free) as absolute file paths. */
async function walkTree(dirPath, label) {
  const out = [];
  const entries = await readdir(dirPath, { withFileTypes: true });
  for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    const child = join(dirPath, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(`foundation-resource-projection: ${label} contains a symlink: ${child}`);
    }
    if (entry.isDirectory()) out.push(...(await walkTree(child, label)));
    else if (entry.isFile()) out.push(child);
    else throw new Error(`foundation-resource-projection: ${label} has a non-file member: ${child}`);
  }
  return out;
}

/** lstat a source file and fail closed on symlinks / non-files. */
async function lstatRegularFile(filePath, label) {
  const stat = await lstat(filePath);
  if (stat.isSymbolicLink()) {
    throw new Error(`foundation-resource-projection: ${label} is a symlink: ${filePath}`);
  }
  if (!stat.isFile()) {
    throw new Error(`foundation-resource-projection: ${label} is not a regular file: ${filePath}`);
  }
  return stat;
}

/**
 * Resolve the exact installed Foundation package roots.
 *
 * Uses createRequire (the same resolution the runtime uses), verifies the
 * installed version against both the declared dependency specifier and the
 * pinned FOUNDATION_PACKAGES constant — fail closed on any drift.
 *
 * @param {string} pkgRoot - Package root (absolute).
 * @returns {Object} Map of package name -> { root, version }.
 */
export function resolveFoundationPackages(pkgRoot) {
  const require = createRequire(join(pkgRoot, 'package.json'));
  const resolved = {};
  for (const [name, expectedVersion] of Object.entries(FOUNDATION_PACKAGES)) {
    let entryPoint;
    try {
      entryPoint = require.resolve(name);
    } catch (error) {
      throw new Error(`foundation-resource-projection: cannot resolve ${name}: ${error.message}`);
    }
    const root = resolve(dirname(entryPoint), '..');
    const pkgJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8'));
    if (pkgJson.version !== expectedVersion) {
      throw new Error(
        `foundation-resource-projection: ${name} version mismatch: installed ${pkgJson.version}, expected ${expectedVersion}`,
      );
    }
    const declared = require(`./package.json`).dependencies?.[name];
    if (declared !== expectedVersion) {
      throw new Error(
        `foundation-resource-projection: ${name} declared specifier "${declared}" does not match pinned ${expectedVersion}`,
      );
    }
    resolved[name] = { root, version: pkgJson.version };
  }
  return resolved;
}

/**
 * Strictly re-read the existing binding record and bind every recorded member
 * to its declared digest (Harness bound read). Returns the previous owned
 * closure entries {path, sha256, mode} derived from the live disk state, or
 * an empty closure when no record exists yet.
 *
 * Fail-closed on: missing/symlinked record, symlinked member (leaf or any
 * parent component), missing member, size drift, and byte drift.
 *
 * @param {string} pkgRoot - Package root (absolute).
 * @returns {Promise<{entries: Array<{path:string, sha256:string, mode:number}>, exists: boolean}>}
 */
async function readPreviousRecord(pkgRoot) {
  const recordPath = join(pkgRoot, BINDING_RECORD_PATH);
  try {
    await lstat(recordPath);
  } catch (cause) {
    if (cause?.code === 'ENOENT') return { entries: [], exists: false };
    throw cause;
  }

  let receipt;
  try {
    receipt = await readFileStrict(pkgRoot, BINDING_RECORD_PATH, { encoding: 'utf8' });
  } catch (cause) {
    throw new Error(
      `foundation-resource-projection: cannot strictly read the existing binding record: ${cause?.message ?? cause}`,
    );
  }
  let record;
  try {
    record = JSON.parse(receipt.content);
  } catch {
    throw new Error(`foundation-resource-projection: existing binding record is not valid JSON: ${BINDING_RECORD_PATH}`);
  }

  const entries = [];
  for (const entry of Array.isArray(record.resources) ? record.resources : []) {
    if (!entry || typeof entry.path !== 'string' || typeof entry.sha256 !== 'string') {
      throw new Error(`foundation-resource-projection: existing binding record has a malformed resource entry`);
    }
    let member;
    try {
      member = await readFileStrict(pkgRoot, entry.path, { expectedSha256: entry.sha256 });
    } catch (cause) {
      throw new Error(
        `foundation-resource-projection: recorded member cannot be strictly re-read (${entry.path}): ${cause?.message ?? cause}`,
      );
    }
    if (member.bytes !== entry.size) {
      throw new Error(
        `foundation-resource-projection: recorded member size drift: ${entry.path} (recorded ${entry.size}, live ${member.bytes})`,
      );
    }
    entries.push({ path: entry.path, sha256: entry.sha256, mode: member.mode });
  }
  return { entries, exists: true };
}

/**
 * Compute the Foundation resource closure.
 *
 * @param {Object} options
 * @param {string} options.pkgRoot - Package root (absolute).
 * @param {string} options.bundleContent - Built bundle text (for module markers
 *        and the B5 fixtures-consumption evidence).
 * @returns {{
 *   resources: Array<{package:string, rel:string, path:string, sha256:string, size:number}>,
 *   bindingDocument: Object,
 *   managedScopes: Array<{dir:string, members:string[], allowedMembers:string[]}>,
 *   previousEntries: Array<{path:string, sha256:string, mode:number}>,
 *   sources: Map<string, {source:string, package:string, rel:string}>,
 * }}
 */
export async function computeFoundationProjection({ pkgRoot, bundleContent }) {
  const packages = resolveFoundationPackages(pkgRoot);
  const outDir = join(pkgRoot, 'bin');
  const resources = new Map(); // posix path -> {package, rel, path, sha256, size, source}
  const scopes = new Map(); // scope dir -> Set of member posix paths (new selection)

  const scopeOf = (dir) => {
    const posixDir = toPosix(dir);
    if (!scopes.has(posixDir)) scopes.set(posixDir, new Set());
    return scopes.get(posixDir);
  };

  // rel is always the real package-relative path of the source file (so the
  // writer can re-read it as join(pkgRoot-of-package, rel)); source is an
  // internal absolute path never serialised into the binding record.
  const addResource = async ({ package: pkg, rel, path, bytes }) => {
    const posixPath = toPosix(relative(pkgRoot, path));
    if (posixPath.startsWith('..')) {
      throw new Error(`foundation-resource-projection: target escapes package root: ${posixPath}`);
    }
    const existing = resources.get(posixPath);
    if (existing && (existing.rel !== rel || existing.package !== pkg)) {
      throw new Error(
        `foundation-resource-projection: target collision at ${posixPath} (${existing.package}/${existing.rel} vs ${pkg}/${rel})`,
      );
    }
    if (!existing) {
      resources.set(posixPath, {
        package: pkg,
        rel,
        path: posixPath,
        sha256: digestBytes(bytes),
        size: bytes.length,
        source: join(packages[pkg].root, rel),
      });
    }
  };

  // 1. Static new URL reads from every bundle-inlined Foundation module.
  //    File reads and directory reads are projected through the SAME path —
  //    no bin/ special case.
  const seenModules = new Set();
  for (const mark of bundleContent.matchAll(MODULE_MARK_RE)) {
    const modulePath = mark[1];
    const pkg = foundationPackageOf(modulePath);
    if (!pkg || seenModules.has(modulePath)) continue;
    seenModules.add(modulePath);
    const sourceFile = join(pkgRoot, modulePath);
    if (!existsSync(sourceFile)) continue;
    const sourceText = readFileSync(sourceFile, 'utf-8');
    const moduleDir = dirname(sourceFile);
    for (const read of sourceText.matchAll(RUNTIME_URL_READ_RE)) {
      const rel = read[1];
      if (rel.startsWith('/') || /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(rel)) continue;
      if (rel.endsWith('/')) {
        // Directory URL composition: project the whole tree.
        const sourceDir = resolve(moduleDir, rel);
        const targetDir = resolve(outDir, rel);
        const targetPosix = toPosix(relative(pkgRoot, targetDir));
        // Ruling 11 (B5): the contracts ./fixtures/ tree is projected only
        // when the formal bundle consumes it — readdirSync(FIXTURES_DIR)
        // survives tree-shaking iff the read is live. An unconsumed fixtures
        // directory is dropped from the selection and stays an empty-member
        // managed scope (any on-disk fixture member is then rejected).
        if (pkg === 'skill-family-contracts' && toPosix(rel) === './fixtures/') {
          if (!bundleContent.includes('readdirSync(FIXTURES_DIR)')) {
            scopeOf(targetPosix);
            continue;
          }
        }
        const files = await walkTree(sourceDir, `${pkg} directory read "${rel}"`);
        const members = [];
        for (const file of files) {
          const sub = relative(sourceDir, file);
          const bytes = await readFile(file);
          await addResource({
            package: pkg,
            rel: toPosix(relative(packages[pkg].root, file)),
            path: join(targetDir, sub),
            bytes,
          });
          members.push(toPosix(relative(pkgRoot, join(targetDir, sub))));
        }
        for (const member of members) scopeOf(targetPosix).add(member);
      } else {
        const source = resolve(moduleDir, rel);
        await lstatRegularFile(source, `read source "${rel}" in ${pkg}`);
        const target = resolve(outDir, rel);
        const bytes = await readFile(source);
        await addResource({
          package: pkg,
          rel: toPosix(relative(packages[pkg].root, source)),
          path: target,
          bytes,
        });
      }
    }
  }

  // 2. contracts: schema documents driven by the frozen registry (39 entries).
  {
    const contracts = packages['skill-family-contracts'];
    const registry = JSON.parse(readFileSync(join(contracts.root, 'src', 'registry.json'), 'utf-8'));
    for (const entry of registry.schemas) {
      const file = entry.file;
      const source = join(contracts.root, file);
      await lstatRegularFile(source, `registry schema "${file}"`);
      const target = resolve(pkgRoot, file);
      const relativeToPkgRoot = relative(pkgRoot, target);
      if (relativeToPkgRoot.startsWith('..') || pathPosix.isAbsolute(toPosix(relativeToPkgRoot))) {
        throw new Error(`foundation-resource-projection: registry schema escapes package root: ${file}`);
      }
      const bytes = await readFile(source);
      await addResource({ package: 'skill-family-contracts', rel: file, path: target, bytes });
      scopeOf(toPosix(relative(pkgRoot, dirname(target)))).add(toPosix(relative(pkgRoot, target)));
    }
  }

  // 3. harness: prebuild manifest + fixed-matrix prebuild binaries (bin/).
  {
    const harness = packages['skill-family-harness-node'];
    const manifestPath = join(harness.root, 'src', 'native', 'prebuild-manifest.json');
    await lstatRegularFile(manifestPath, 'harness prebuild manifest');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf-8'));
    const entries = Object.values(manifest.entries ?? {});
    const binaries = new Set();
    for (const entry of entries) {
      const binary = entry.binary;
      if (!binary || !binary.startsWith('prebuilds/')) {
        throw new Error(`foundation-resource-projection: unexpected prebuild binary: ${binary}`);
      }
      const source = join(harness.root, 'src', 'native', binary);
      await lstatRegularFile(source, `harness prebuild "${binary}"`);
      binaries.add(binary);
      const bytes = await readFile(source);
      await addResource({ package: 'skill-family-harness-node', rel: `src/native/${binary}`, path: join(outDir, binary), bytes });
      scopeOf(toPosix(relative(pkgRoot, join(outDir, binary.split('/')[0]))))
        .add(toPosix(relative(pkgRoot, join(outDir, binary))));
    }
    const manifestBytes = await readFile(manifestPath);
    await addResource({
      package: 'skill-family-harness-node',
      rel: 'src/native/prebuild-manifest.json',
      path: join(outDir, 'prebuild-manifest.json'),
      bytes: manifestBytes,
    });
    // Cross-check: the on-disk prebuilds tree must equal the manifest set.
    const onDisk = await walkTree(join(harness.root, 'src', 'native', 'prebuilds'), 'harness prebuilds tree');
    const onDiskRel = new Set(onDisk.map((f) => toPosix(relative(join(harness.root, 'src', 'native'), f))));
    const manifestRel = new Set([...binaries].map((b) => `prebuilds/${b.split('/').slice(1).join('/')}`));
    const unexpected = [...onDiskRel].filter((f) => !manifestRel.has(f));
    if (unexpected.length > 0) {
      throw new Error(`foundation-resource-projection: prebuilds tree has members outside the manifest: ${unexpected.join(', ')}`);
    }
    for (const binary of binaries) {
      if (!onDiskRel.has(binary)) {
        throw new Error(`foundation-resource-projection: manifest binary missing on disk: ${binary}`);
      }
    }
  }

  // 4. License / NOTICE / third-party declarations per package.
  {
    const nativeNotice = join(packages['skill-family-harness-node'].root, 'src', 'native', 'NOTICE');
    if (existsSync(nativeNotice)) {
      const bytes = await readFile(nativeNotice);
      await addResource({
        package: 'skill-family-harness-node',
        rel: 'src/native/NOTICE',
        path: join(outDir, 'foundation-legal', 'skill-family-harness-node', 'native-NOTICE'),
        bytes,
      });
      scopeOf(toPosix(relative(pkgRoot, join(outDir, 'foundation-legal'))))
        .add(toPosix(relative(pkgRoot, join(outDir, 'foundation-legal', 'skill-family-harness-node', 'native-NOTICE'))));
    }
    for (const [name, pkg] of Object.entries(packages)) {
      for (const legal of LEGAL_FILES) {
        const source = join(pkg.root, legal);
        if (!existsSync(source)) continue;
        const bytes = await readFile(source);
        const target = join(outDir, 'foundation-legal', name, legal);
        await addResource({ package: name, rel: legal, path: target, bytes });
        scopeOf(toPosix(relative(pkgRoot, join(outDir, 'foundation-legal'))))
          .add(toPosix(relative(pkgRoot, target)));
      }
    }
  }

  // 5. Previous owned closure: strictly re-read the existing binding record
  //    (bound reads against the declared digests). Dropped recorded paths
  //    (e.g. the B5 fixtures) become delete operations and keep their
  //    top-level directory under verification scope.
  const previous = await readPreviousRecord(pkgRoot);
  const newPaths = new Set(resources.keys());
  for (const prev of previous.entries) {
    if (newPaths.has(prev.path)) continue;
    const segments = prev.path.split('/');
    const scopeDir = segments.length >= 2 ? segments.slice(0, 2).join('/') : segments[0];
    scopeOf(scopeDir);
  }

  const sorted = [...resources.values()]
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .map(({ source, ...entry }) => entry);

  const bindingDocument = {
    schemaVersion: 1,
    kind: 'skill-family.foundation-resource-binding',
    sourcePackages: Object.fromEntries(
      Object.entries(packages).map(([name, pkg]) => [name, pkg.version]),
    ),
    resources: sorted,
  };

  // Managed scopes are DERIVED from the selection result: every directory
  // scope recorded by a selection section, plus the top-level directories of
  // dropped previous members. allowedMembers (new ∪ previous) drives the
  // write-mode preflight; members (new only) drives the --check verification.
  const managedScopes = [...scopes.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([dir, members]) => {
      const allowed = new Set(members);
      for (const prev of previous.entries) {
        if (prev.path.startsWith(`${dir}/`)) allowed.add(prev.path);
      }
      return { dir, members: [...members].sort(), allowedMembers: [...allowed].sort() };
    });

  return {
    resources: sorted,
    bindingDocument,
    managedScopes,
    previousEntries: previous.entries,
    sources: resources,
  };
}

/**
 * Verify the projected closure on disk against the computed projection.
 *
 * Fail-closed on: missing or drifted binding record, missing resource,
 * byte/size drift, symlink or non-file member (leaf or parent component),
 * dropped resources still present, and unknown extra members inside managed
 * scopes.
 *
 * @param {string} pkgRoot
 * @param {{resources: Array, bindingDocument: Object, managedScopes: Array, previousEntries: Array}} projection
 * @returns {Promise<void>} Resolves when the closure is byte-exact.
 */
export async function verifyFoundationProjection(pkgRoot, projection) {
  let recordReceipt;
  try {
    recordReceipt = await readFileStrict(pkgRoot, BINDING_RECORD_PATH, { encoding: 'utf8' });
  } catch (cause) {
    throw new Error(`foundation-resource-projection: binding record missing or unreadable: ${cause?.message ?? cause}`);
  }
  const expectedRecord = canonicalJson(projection.bindingDocument);
  if (recordReceipt.content !== expectedRecord) {
    throw new Error(`foundation-resource-projection: binding record drift: ${BINDING_RECORD_PATH}`);
  }

  for (const entry of projection.resources) {
    let receipt;
    try {
      receipt = await readFileStrict(pkgRoot, entry.path, { expectedSha256: entry.sha256 });
    } catch (cause) {
      throw new Error(`foundation-resource-projection: resource check failed for ${entry.path}: ${cause?.message ?? cause}`);
    }
    if (receipt.bytes !== entry.size) {
      throw new Error(`foundation-resource-projection: resource size drift: ${entry.path}`);
    }
  }

  const newPaths = new Set(projection.resources.map((entry) => entry.path));
  for (const prev of projection.previousEntries) {
    if (newPaths.has(prev.path)) continue;
    const present = await lstat(join(pkgRoot, prev.path)).catch(() => null);
    if (present) {
      throw new Error(`foundation-resource-projection: dropped resource still present: ${prev.path}`);
    }
  }

  for (const scope of projection.managedScopes) {
    const dirPath = join(pkgRoot, scope.dir);
    const dirStat = await lstat(dirPath).catch(() => null);
    if (!dirStat) {
      if (scope.members.length === 0) continue; // dropped scope: absent is the expected state
      throw new Error(`foundation-resource-projection: managed directory missing: ${scope.dir}`);
    }
    if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) {
      throw new Error(`foundation-resource-projection: managed directory is not a real directory: ${scope.dir}`);
    }
    const expectedMembers = new Set(scope.members);
    const files = await walkTree(dirPath, `managed directory ${scope.dir}`);
    for (const file of files) {
      const relPath = toPosix(relative(pkgRoot, file));
      if (!expectedMembers.has(relPath)) {
        throw new Error(`foundation-resource-projection: unknown extra member in ${scope.dir}: ${relPath}`);
      }
    }
  }
}

/**
 * Write the projected closure (resources + binding record).
 *
 * The write executes through the Foundation Kit projection transaction:
 * candidates are staged in an external temporary root (re-read from the exact
 * installed package sources with size and byte-digest re-verification),
 * compileProjectionPlan binds the record as caller-provided authority bytes,
 * and runProjection verifies the live target, candidate and previous closure
 * before every mutation and rolls back the complete closure on failure. The
 * binding record is then published strictly (no-follow, byte + mode
 * verified). Unknown extra members inside managed scopes fail the write
 * preflight; a symlink never gets followed or overwritten.
 *
 * @param {string} pkgRoot
 * @param {{resources: Array, bindingDocument: Object, managedScopes: Array, previousEntries: Array, sources: Map}} projection
 * @returns {Promise<void>}
 */
export async function writeFoundationProjection(pkgRoot, projection) {
  // --- Preflight: no unknown extra members inside any managed scope. ---
  for (const scope of projection.managedScopes) {
    const dirPath = join(pkgRoot, scope.dir);
    const dirStat = await lstat(dirPath).catch(() => null);
    if (!dirStat) continue;
    if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) {
      throw new Error(`foundation-resource-projection: managed directory is not a real directory: ${scope.dir}`);
    }
    const allowed = new Set(scope.allowedMembers);
    const files = await walkTree(dirPath, `managed directory ${scope.dir}`);
    for (const file of files) {
      const relPath = toPosix(relative(pkgRoot, file));
      if (!allowed.has(relPath)) {
        throw new Error(`foundation-resource-projection: unknown extra member in ${scope.dir}: ${relPath}`);
      }
    }
  }

  // --- Candidate staging: re-read every selected resource from the exact
  // installed package sources and re-verify size + byte digest. ---
  await withTemporaryWorkspace(async ({ root: candidateDir }) => {
    const candidateRecords = [];
    for (const entry of projection.resources) {
      const internal = projection.sources.get(entry.path);
      await lstatRegularFile(internal.source, `projection source ${entry.package}/${entry.rel}`);
      const bytes = await readFile(internal.source);
      if (bytes.length !== entry.size) {
        throw new Error(
          `foundation-resource-projection: source changed size since projection: ${entry.package}/${entry.rel}`,
        );
      }
      const sha = digestBytes(bytes);
      if (sha !== entry.sha256) {
        throw new Error(
          `foundation-resource-projection: source digest drift since projection: ${entry.package}/${entry.rel}`,
        );
      }
      const stagePath = join(candidateDir, entry.path);
      await mkdir(dirname(stagePath), { recursive: true });
      await writeFile(stagePath, bytes, { mode: 0o644 });
      await chmod(stagePath, 0o644);
      candidateRecords.push({ path: entry.path, sha256: entry.sha256, mode: 0o644 });
    }

    // --- Pure compile: the record rides the plan as caller-provided
    // authority bytes — no target-local authority fact is read or forged. ---
    const rootBinding = await realpath(pkgRoot);
    const recordBytes = Buffer.from(canonicalJson(projection.bindingDocument), 'utf8');
    let prepared;
    try {
      prepared = compileProjectionPlan({
        rootBinding,
        authoritySources: [{
          id: AUTHORITY_ID,
          path: BINDING_RECORD_PATH,
          type: 'file',
          sha256: digestBytes(recordBytes),
          mode: 0o644,
        }],
        ownership: [
          ...projection.resources.map((entry) => ({
            path: entry.path,
            source: entry.path,
            authoritySource: AUTHORITY_ID,
            owner: { kind: 'managed', id: OWNER_ID },
          })),
          ...projection.previousEntries
            .filter((prev) => !projection.resources.some((entry) => entry.path === prev.path))
            .map((prev) => ({
              path: prev.path,
              authoritySource: AUTHORITY_ID,
              owner: { kind: 'managed', id: OWNER_ID },
            })),
        ],
        handwrittenPolicy: { authoritySource: AUTHORITY_ID, patterns: [] },
        previousOwnedClosure: buildProjectionClosure(projection.previousEntries),
        externalCandidateClosure: buildProjectionClosure(candidateRecords),
        authorityBinding: {
          kind: 'caller-bytes',
          bytes: { [AUTHORITY_ID]: recordBytes.toString('base64') },
        },
      });
    } catch (cause) {
      throw new Error(`foundation-resource-projection: cannot compile the projection plan: ${cause?.message ?? cause}`);
    }

    // --- Foundation managed projection transaction. ---
    try {
      await runProjection({
        root: pkgRoot,
        manifest: prepared.manifest,
        candidateRoot: candidateDir,
        preparedProjection: prepared,
      });
    } catch (cause) {
      throw new Error(`foundation-resource-projection: projection execution refused: ${cause?.message ?? cause}`);
    }

    // --- Publish the binding record strictly (no-follow, byte + mode verified). ---
    try {
      await publishFileOrReplace(pkgRoot, BINDING_RECORD_PATH, recordBytes, { mode: 0o644 });
    } catch (cause) {
      throw new Error(`foundation-resource-projection: binding record publish failed: ${cause?.message ?? cause}`);
    }
  }, { prefix: 'release-skill-projection-' });
}
