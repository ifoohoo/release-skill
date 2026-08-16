#!/usr/bin/env node
/**
 * build-bundle.mjs
 *
 * Deterministic CLI bundle for self-contained plugin execution.
 * Bundles bin/release-skill.mjs + all npm dependencies into a single
 * ESM file that runs without node_modules.
 *
 * Schemas and native addons remain external (loaded at runtime from
 * the plugin root via PKG_ROOT). Runtime JSON resources read by inlined
 * dependency modules (new URL(<rel>, import.meta.url)) are emitted as
 * deterministic sidecars next to the bundle (see "Runtime sidecar
 * resources" section below).
 *
 * Usage:
 *   node scripts/build-bundle.mjs           # build mode
 *   node scripts/build-bundle.mjs --check   # check-only mode (exit 1 on drift)
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { createHash } from 'node:crypto';

const CHECK_MODE = process.argv.includes('--check');

const SCRIPT_DIR = dirname(new URL(import.meta.url).pathname);
const PKG_ROOT = join(SCRIPT_DIR, '..');
const ENTRY = join(PKG_ROOT, 'bin', 'release-skill-cli.mjs');
const OUTFILE = join(PKG_ROOT, 'bin', 'release-skill.bundle.mjs');

// Banner: compute PKG_ROOT deterministically from the bundle's own path.
// No env-var override — callers cannot hijack schema/native resolution.
// Uses import.meta.url only — process.argv[1] is not a reliable resource root.
//
// The banner also injects the package identity (__bundlePkg) as a build-time
// constant so the CLI --version probe carries no bundle-relative file
// dependency: the Claude and Codex adapter closures ship the bundle at a
// different depth with no package.json next to it, while the npm closure does.
// Reading package.json here (build input) keeps the output deterministic.
function buildBanner(pkgIdentity) {
  return `\
// --- release-skill bundle (deterministic build) ---
// Compute package root from the bundle's own file location (import.meta.url).
// The bundle lives at <PKG_ROOT>/bin/release-skill.bundle.mjs, so go up one level.
import { fileURLToPath as __bundleFileURLToPath } from 'node:url';
import { dirname as __bundleDirname, resolve as __bundleResolve } from 'node:path';
import { createRequire as __bundleCreateRequire } from 'node:module';
const __bundlePkgRoot = __bundleResolve(__bundleDirname(__bundleFileURLToPath(import.meta.url)), '..');
// Provide a real require() for CJS packages bundled into ESM (e.g. yaml, ajv).
const __bundleRealRequire = __bundleCreateRequire(import.meta.url);
// Package identity injected at build time — closure-independent --version probe.
const __bundlePkg = Object.freeze(${JSON.stringify(pkgIdentity)});
`;
}

// Pattern to replace esbuild's broken __require shim with a real require().
const REQUIRE_SHIM_PATTERN = /var __require = \/\* @__PURE__ \*\/ \(\(x\) => typeof require !== "undefined" \? require : typeof Proxy !== "undefined" \? new Proxy\(x, \{[\s\S]*?\}\) : x\)\(function\(x\) \{[\s\S]*?\}\);/;

const REQUIRE_SHIM_REPLACEMENT = `var __require = __bundleRealRequire;`;

// ─── Runtime sidecar resources for inlined dependencies ────────────────
//
// Dependencies bundled into the CLI (e.g. skill-family-contracts) can load
// JSON resources at module init via new URL(<rel>, import.meta.url). Once
// inlined into the bundle, import.meta.url is the bundle's own URL, so such
// reads resolve relative to the bundle directory (bin/). To keep the bundle
// self-contained in copied/installed closures (no node_modules), the build
// emits each referenced resource that is not already provided at that
// target as a deterministic sidecar next to the bundle. Reads whose target
// already exists (e.g. ../package.json resolving to the package's own
// package.json) are host-provided by design and are not emitted. --check
// verifies bundle bytes, every expected sidecar, and that every runtime
// read in the output resolves next to the bundle (fail-closed).

// Module markers esbuild leaves in the output: `// <path>` comments and
// `<path>() {` __esm keys, with <path> relative to the package root.
const MODULE_MARK_RE = /(?:\/\/\s*|")((?:\.\.\/)+[^\s"()]+\.(?:mjs|js|cjs))/g;
const RUNTIME_URL_READ_RE = /new URL\(\s*"([^"]+)"\s*,\s*import\.meta\.url\s*\)/g;

function isAbsoluteOrScheme(rel) {
  return rel.startsWith('/') || /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(rel);
}

/** Collect every relative runtime read (module source → rel) present in the output. */
function collectRuntimeReads(content, pkgRoot) {
  const reads = [];
  const seenModules = new Set();
  for (const mark of content.matchAll(MODULE_MARK_RE)) {
    const modulePath = mark[1];
    if (seenModules.has(modulePath)) continue;
    seenModules.add(modulePath);
    const sourceFile = join(pkgRoot, modulePath);
    if (!existsSync(sourceFile)) continue;
    const sourceText = readFileSync(sourceFile, 'utf-8');
    for (const read of sourceText.matchAll(RUNTIME_URL_READ_RE)) {
      const rel = read[1];
      if (isAbsoluteOrScheme(rel)) continue;
      reads.push({ modulePath, rel });
    }
  }
  return reads;
}

/** Sidecars to emit: reads whose target next to the bundle is not already provided. */
function computeSidecars(reads, pkgRoot, outDir) {
  const sidecars = [];
  for (const { modulePath, rel } of reads) {
    if (rel.endsWith('/')) continue; // directory URL composition; not a file load
    const target = resolve(outDir, rel);
    const source = resolve(join(pkgRoot, modulePath), '..', rel);
    if (!existsSync(source)) {
      throw new Error(
        `build-bundle: runtime read "${rel}" in ${modulePath} has no source resource (${source})`,
      );
    }
    // Host-provided targets (e.g. ../package.json resolving to the package's
    // own package.json) lie outside the bundle directory and must not be
    // emitted or freshened. Targets inside the bundle directory are
    // sidecar-managed: an existing target is NOT host-provided — a stale
    // sidecar from a previous dependency generation must be freshened in
    // write mode and must fail the --check byte comparison.
    const relativeToOutDir = relative(outDir, target);
    if (relativeToOutDir.startsWith('..') || isAbsolute(relativeToOutDir)) {
      continue;
    }
    if (!sidecars.some((s) => s.target === target)) {
      sidecars.push({ target, source });
    }
  }
  return sidecars;
}

/** Fail-closed check: every relative runtime read in the output must resolve next to the bundle. */
function verifyRuntimeReadsResolve(content, outDir) {
  const missing = new Set();
  for (const read of content.matchAll(RUNTIME_URL_READ_RE)) {
    const rel = read[1];
    if (isAbsoluteOrScheme(rel) || rel.endsWith('/')) continue;
    if (!existsSync(resolve(outDir, rel))) missing.add(rel);
  }
  return [...missing].sort();
}

// Inlined Foundation modules must not perform bundle-relative runtime reads
// of files that adapter closures do not ship. skill-family-harness-node's
// report.mjs reads its own package.json at module init
// (readFileSync(new URL("../package.json", import.meta.url))); once inlined
// into the bundle that read resolves next to the bundle and breaks in
// adapter closures (which ship no package.json by design — the banner
// injects __bundlePkg instead). Neutralize the read at build time with the
// same injected package identity, fail-closed if Foundation changes shape.
const REPORT_PACKAGE_META_READ_RE =
  /JSON\.parse\(readFileSync\(new URL\("\.\.\/package\.json", import\.meta\.url\), "utf8"\)\)/;

async function buildBundle() {
  // Dynamic import so the script works even if esbuild is not yet installed.
  let esbuild;
  try {
    esbuild = await import('esbuild');
  } catch {
    console.error('Error: esbuild not installed. Run: npm install');
    process.exit(1);
  }

  const pkgJson = JSON.parse(await readFile(join(PKG_ROOT, 'package.json'), 'utf-8'));
  const banner = buildBanner({ name: pkgJson.name, version: pkgJson.version });

  const identity = Object.freeze({ name: pkgJson.name, version: pkgJson.version });

  const identityPlugins = [{
    name: 'inline-foundation-package-identity',
    setup(build) {
      build.onLoad({ filter: /skill-family-harness-node[\\/]src[\\/]report\.mjs$/ }, async (args) => {
        const source = await readFile(args.path, 'utf-8');
        const injected = source.replace(REPORT_PACKAGE_META_READ_RE, () =>
          `Object.freeze(${JSON.stringify(identity)})`);
        if (injected === source) {
          throw new Error(
            'build-bundle: could not neutralize Foundation report.mjs package.json read',
          );
        }
        return { contents: injected, loader: 'js' };
      });
    },
  }];

  const result = await esbuild.build({
    entryPoints: [ENTRY],
    absWorkingDir: PKG_ROOT,
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node22',
    outfile: OUTFILE,
    banner: { js: banner },
    plugins: identityPlugins,
    // External: Node.js builtins, native addon loader, and the native addon itself.
    external: [
      'node:*',
      '*/safe_write.node',
      '*.node',
    ],
    // Keep names for stack traces; deterministic across runs for same input.
    keepNames: true,
    // No minification — preserve readable output for debugging.
    minify: false,
    // Sourcemap not needed for production bundle.
    sourcemap: false,
    // Tree-shake unused code.
    treeShaking: true,
    // Write to outfile.
    write: false,
  });

  let content = result.outputFiles[0].text;

  // Replace esbuild's broken __require shim with a real require().
  if (REQUIRE_SHIM_PATTERN.test(content)) {
    content = content.replace(REQUIRE_SHIM_PATTERN, REQUIRE_SHIM_REPLACEMENT);
  }

  // Generated dependency comments may contain editor-authored trailing spaces.
  // Normalize them so committed bundles pass repository whitespace checks.
  content = content.replace(/[ \t]+$/gm, '');

  // Compute runtime sidecars (resources read by inlined dependency modules
  // via new URL(<rel>, import.meta.url), resolved next to the bundle).
  const sidecars = computeSidecars(
    collectRuntimeReads(content, PKG_ROOT),
    PKG_ROOT,
    dirname(OUTFILE),
  );

  return { content, sidecars };
}

async function main() {
  const { content, sidecars } = await buildBundle();
  const outDir = dirname(OUTFILE);

  if (CHECK_MODE) {
    let existing;
    try {
      existing = await readFile(OUTFILE, 'utf-8');
    } catch {
      console.error('Bundle drift: output file does not exist.');
      process.exit(1);
    }
    if (existing !== content) {
      console.error('Bundle drift: output differs from expected.');
      const existingHash = createHash('sha256').update(existing).digest('hex');
      const expectedHash = createHash('sha256').update(content).digest('hex');
      console.error(`  existing: sha256:${existingHash}`);
      console.error(`  expected: sha256:${expectedHash}`);
      process.exit(1);
    }
    for (const { target, source } of sidecars) {
      let existingSidecar;
      try {
        existingSidecar = await readFile(target);
      } catch {
        console.error(`Bundle drift: runtime sidecar missing: ${relative(PKG_ROOT, target)}`);
        process.exit(1);
      }
      const expectedSidecar = await readFile(source);
      if (!existingSidecar.equals(expectedSidecar)) {
        console.error(`Bundle drift: runtime sidecar differs: ${relative(PKG_ROOT, target)}`);
        process.exit(1);
      }
    }
    const unresolved = verifyRuntimeReadsResolve(content, outDir);
    if (unresolved.length > 0) {
      console.error(`Bundle drift: runtime resource reads unresolved next to bundle: ${unresolved.join(', ')}`);
      process.exit(1);
    }
    console.log('Bundle in sync.');
    process.exit(0);
  }

  for (const { target, source } of sidecars) {
    const bytes = await readFile(source);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, bytes);
    const hash = createHash('sha256').update(bytes).digest('hex');
    console.log(`Sidecar written: ${relative(PKG_ROOT, target)}`);
    console.log(`  sha256:${hash}`);
  }
  await mkdir(outDir, { recursive: true });
  await writeFile(OUTFILE, content, 'utf-8');
  const hash = createHash('sha256').update(content).digest('hex');
  console.log(`Bundle written: ${OUTFILE}`);
  console.log(`  sha256:${hash}`);
  console.log(`  size: ${content.length} bytes`);
}

main().catch((err) => {
  console.error(`build-bundle failed: ${err.message}`);
  process.exit(1);
});
