/**
 * Lineage Repair Tool — handoff §2.2 option A (local rebuild, no ref writes)
 *
 * Rebuilds the published release commit chain inside the LOCAL object
 * database only:
 *
 *   - every rebuilt commit's tree hash equals the corresponding release tag
 *     commit's tree hash (published bytes are unchanged);
 *   - every rebuilt commit's parent is the previous version's rebuilt commit
 *     (the oldest version becomes the chain root);
 *   - original author/committer identity and dates (including synthetic
 *     dates) are preserved;
 *   - version gaps (e.g. v0.1.2 with no tag) are registered as ABSENT and are
 *     NEVER fabricated into fake tags;
 *   - zero ref writes (no tag update-ref, no branch), zero push — pushing a
 *     `release-history` branch is a separate, explicitly authorized action.
 *
 * Commands:
 *   - analyze  --root <path> [--json] : read-only lineage analysis
 *   - rebuild  --root <path> [--dry-run] [--json] : local chain rebuild +
 *     per-node tree verification report
 *
 * The tool is fully local: it never reads tokens, never calls the GitHub API,
 * never writes refs, and never pushes. Failures propagate to the caller
 * (fail-closed) instead of being swallowed into fake success.
 *
 * @module commands/lineage
 */

import { execFile as execFileCb, spawn } from 'node:child_process';
import { promisify } from 'node:util';

const execFile = promisify(execFileCb);

// ============================================================================
// Version parsing & comparison (with release-tag prefix support)
// ============================================================================

/**
 * Parse a semantic version string into components.
 *
 * @param {string} version - e.g. "1.2.3", "2.0.0-beta.1", "0.5.1"
 * @returns {{ major: number, minor: number, patch: number, prerelease?: string, original: string }}
 * @throws {Error} when the version is not a valid semver string.
 */
export function parseSemverVersion(version) {
  if (typeof version !== 'string') {
    throw new Error(`version must be a string, got ${typeof version}`);
  }

  const match = version.match(/^v?(\d+)\.(\d+)\.(\d+)(?:-([a-zA-Z0-9.-]+))?(?:\+([a-zA-Z0-9.-]+))?$/);
  if (!match) {
    throw new Error(`invalid semver version: "${version}"`);
  }

  if (version.match(/^\d+\.\d+\.\d+\.\d+/)) {
    throw new Error(`invalid semver version: "${version}"`);
  }

  const [, major, minor, patch, prereleaseRaw] = match;

  return {
    major: parseInt(major, 10),
    minor: parseInt(minor, 10),
    patch: parseInt(patch, 10),
    prerelease: prereleaseRaw || undefined,
    original: version,
  };
}

/**
 * Compare two semver versions.
 *
 * @returns {-1 | 0 | 1} -1 if v1 < v2, 0 if equal, 1 if v1 > v2
 */
export function compareSemverVersions(v1, v2) {
  const p1 = parseSemverVersion(v1);
  const p2 = parseSemverVersion(v2);

  if (p1.major !== p2.major) return p1.major < p2.major ? -1 : 1;
  if (p1.minor !== p2.minor) return p1.minor < p2.minor ? -1 : 1;
  if (p1.patch !== p2.patch) return p1.patch < p2.patch ? -1 : 1;

  if (!p1.prerelease && !p2.prerelease) return 0;
  if (!p1.prerelease) return 1;
  if (!p2.prerelease) return -1;

  if (p1.prerelease < p2.prerelease) return -1;
  if (p1.prerelease > p2.prerelease) return 1;
  return 0;
}

/**
 * Classify a git tag name as a release tag.
 *
 * Accepts `v0.1.0`, `0.1.0`, and product-prefixed forms such as
 * `release-skill-v0.5.0` (the tag shape used by release-skill's own public
 * repository). The version part must be the tail of the tag name.
 *
 * @param {string} tagName - a git tag name.
 * @returns {{ version: string, prefix: string | null } | null}
 *   null when the tag is not a release tag (e.g. `some-topic-tag`).
 */
export function parseReleaseTag(tagName) {
  if (typeof tagName !== 'string' || tagName.length === 0) return null;
  const match = tagName.match(/(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)$/);
  if (!match) return null;
  const version = match[1];
  const rawPrefix = tagName.slice(0, match.index);
  // `v0.1.0` → prefix 'v' (bare version tag); `release-skill-v0.5.0` →
  // prefix 'release-skill' (trailing '-v' is the version separator, not part
  // of the product prefix). `1.0.0` (no prefix) → prefix null.
  let prefix = rawPrefix.replace(/-v$/, '');
  if (prefix === '') prefix = rawPrefix === 'v' ? 'v' : null;
  return { version, prefix };
}

// ============================================================================
// Local git operations (read-only except commit object creation in rebuild)
// ============================================================================

/**
 * Run a git command with the given cwd; returns trimmed stdout.
 */
async function git(root, args, options = {}) {
  const { stdout } = await execFile('git', args, {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    ...options,
  });
  return stdout.trim();
}

/**
 * Run a git command and return RAW stdout (no trimming). Trailing bytes are
 * significant for `cat-file commit` output: the message tail (trailing
 * whitespace / blank lines) must survive untouched.
 */
async function gitRaw(root, args, options = {}) {
  const { stdout } = await execFile('git', args, {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    ...options,
  });
  return stdout;
}

/**
 * Parse a commit ident line — the value of an `author`/`committer` header in
 * the raw commit object — of the canonical form `Name <email> ts tz`.
 *
 * The anchored regex uses a greedy `.*` so the LAST ` <email> ts tz` group at
 * the end of the line wins: names containing spaces (or even '<'/'>' — legal
 * in stored objects) still resolve correctly. This replaces the broken
 * `split(/\s+>/)` parsing, which never matched a legal ident line (there is
 * no whitespace before '>') and silently produced name=<entire line>,
 * email='' — corrupting identities written by `commit-tree` during rebuild
 * (SFA field report 2026-08-18).
 *
 * @param {string} line - e.g. `乌龙 <2505468+mzdbxqh@users.noreply.github.com> 1785824474 +0000`
 * @returns {{ name: string, email: string, ts: string, tz: string }}
 * @throws {Error} when the line is not a valid ident line. Fail-closed:
 *   rebuild must never fabricate or silently write an empty identity.
 */
export function parseCommitIdent(line) {
  if (typeof line !== 'string') {
    throw new Error(`commit ident line must be a string, got ${typeof line}`);
  }
  const match = line.match(/^(.*) <([^>]*)> (\d+) ([+-]\d{4})$/);
  if (!match) {
    throw new Error(`unparseable commit ident line (fail-closed): "${line}"`);
  }
  const [, name, email, ts, tz] = match;
  return { name, email, ts, tz };
}

/**
 * List all tags with their commit SHAs.
 *
 * @param {string} root - repository root
 * @returns {Promise<Array<{ name: string, commitSha: string }>>}
 */
export async function getLocalTags(root) {
  const output = await git(root, ['tag', '-l', '--format=%(refname:short) %(objectname)']);
  if (!output) return [];
  return output
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      const [name, commitSha] = line.split(/\s+/);
      return { name, commitSha };
    });
}

/**
 * List release tags (version-shaped) sorted by version ascending.
 *
 * @param {string} root - repository root
 * @returns {Promise<Array<{ name: string, commitSha: string, version: string, prefix: string | null }>>}
 */
export async function listReleaseTags(root) {
  const tags = await getLocalTags(root);
  const releases = [];
  for (const tag of tags) {
    const parsed = parseReleaseTag(tag.name);
    if (!parsed) continue;
    // Reject malformed version numbers (parse throws on invalid semver).
    parseSemverVersion(parsed.version);
    releases.push({ name: tag.name, commitSha: tag.commitSha, ...parsed });
  }
  releases.sort((a, b) => compareSemverVersions(a.version, b.version));
  return releases;
}

/**
 * Get the tree hash of a commit.
 *
 * @param {string} root - repository root
 * @param {string} commitSha - commit SHA
 * @returns {Promise<string>} tree hash
 */
export async function getCommitTreeHash(root, commitSha) {
  return git(root, ['rev-parse', `${commitSha}^{tree}`]);
}

/**
 * Check whether an object exists in the local object database.
 *
 * @param {string} root - repository root
 * @param {string} sha - object SHA
 * @returns {Promise<boolean>}
 */
export async function objectExists(root, sha) {
  try {
    await git(root, ['cat-file', '-e', `${sha}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Read the raw commit object and extract identity/date fields.
 *
 * The cat-file output is NOT trimmed: the header block and the message are
 * split at the first blank line and the message tail bytes (trailing
 * whitespace / blank lines) are preserved exactly, so a rebuilt commit can
 * carry byte-identical message bytes.
 *
 * @param {string} root - repository root
 * @param {string} commitSha - commit SHA
 * @returns {Promise<{ message: string, author: { name: string, email: string, date: string }, committer: { name: string, email: string, date: string } }>}
 * @throws {Error} when the object is malformed or an ident line does not
 *   parse (fail-closed — never fabricate or silently write empty identity).
 */
export async function readCommitMeta(root, commitSha) {
  const raw = await gitRaw(root, ['cat-file', 'commit', commitSha]);
  const separator = raw.indexOf('\n\n');
  if (separator === -1) {
    throw new Error(`malformed commit object ${commitSha}: missing header/message separator`);
  }
  const message = raw.slice(separator + 2);
  const headers = {};
  for (const line of raw.slice(0, separator).split('\n')) {
    if (line.startsWith(' ')) continue; // continuation line (e.g. gpgsig)
    const space = line.indexOf(' ');
    if (space === -1) continue;
    headers[line.slice(0, space)] = line.slice(space + 1);
  }
  const author = parseCommitIdent(headers.author ?? '');
  const committer = parseCommitIdent(headers.committer ?? '');
  return {
    message,
    author: {
      name: author.name,
      email: author.email,
      date: `${author.ts} ${author.tz}`,
    },
    committer: {
      name: committer.name,
      email: committer.email,
      date: `${committer.ts} ${committer.tz}`,
    },
  };
}

/**
 * Read the parent commit of a commit (`<sha>^`); empty string when the commit
 * is a root.
 *
 * @param {string} root - repository root
 * @param {string} commitSha - commit SHA
 * @returns {Promise<string>} parent commit SHA or ''
 */
export async function getParentCommit(root, commitSha) {
  try {
    return await git(root, ['rev-parse', `${commitSha}^`]);
  } catch {
    return '';
  }
}

/**
 * Check whether a commit is an ancestor of a ref.
 *
 * @param {string} root - repository root
 * @param {string} commitSha - commit SHA
 * @param {string} ref - ref name, e.g. 'main'
 * @returns {Promise<boolean>}
 */
export async function isAncestorOf(root, commitSha, ref = 'main') {
  try {
    await git(root, ['merge-base', '--is-ancestor', commitSha, ref]);
    return true;
  } catch {
    return false;
  }
}

// ============================================================================
// Analyze (read-only)
// ============================================================================

/**
 * Analyze the release-tag lineage of a repository (read-only).
 *
 * Reports, in version order:
 *   - tag name, tag commit, commit tree hash;
 *   - chain relation (parent of tag commit);
 *   - orphan roots (tag commits without a parent) and chain breaks (tag
 *     commit parent is not the previous version's tag commit);
 *   - version gaps (missing versions between the oldest and newest release
 *     tag) registered as ABSENT — never fabricated.
 *
 * @param {string} root - repository root
 * @returns {Promise<{
 *   nodes: Array<{ version: string, tag: string, commitSha: string, treeHash: string, parentCommit: string, chainRoot: boolean, chainBreak: boolean, ancestorOfMain: boolean }>,
 *   gaps: Array<{ version: string, status: 'ABSENT' }>,
 *   summary: { releaseTagCount: number, gapCount: number, chainBreakCount: number, orphanRootCount: number }
 * }>}
 */
export async function analyzeLineage(root) {
  const releases = await listReleaseTags(root);
  const nodes = [];
  const gaps = [];

  for (let i = 0; i < releases.length; i += 1) {
    const release = releases[i];
    const treeHash = await getCommitTreeHash(root, release.commitSha);
    const parentCommit = await getParentCommit(root, release.commitSha);
    let ancestorOfMain = false;
    try {
      ancestorOfMain = await isAncestorOf(root, release.commitSha, 'main');
    } catch {
      ancestorOfMain = false;
    }

    const chainRoot = parentCommit === '';
    let chainBreak = false;
    if (!chainRoot && i > 0) {
      // Previous release tag commit should be this commit's parent.
      chainBreak = parentCommit !== releases[i - 1].commitSha;
    } else if (!chainRoot && i === 0) {
      // Oldest release tag should be a root (or at least not chained to
      // anything else) — a parent on the first release is reported.
      chainBreak = true;
    }

    nodes.push({
      version: release.version,
      tag: release.name,
      commitSha: release.commitSha,
      treeHash,
      parentCommit,
      chainRoot,
      chainBreak,
      ancestorOfMain,
    });
  }

  // Version gaps between consecutive release tags (bounded enumeration).
  // Same major.minor → skipped patches (0.1.1 → 0.1.3 registers 0.1.2).
  // Minor jump → skipped minors' .0 (0.1.0 → 0.3.0 registers 0.2.0).
  // Major jump → skipped majors' 0.0 (0.1.0 → 2.0.0 registers 1.0.0).
  // Prereleases are excluded from gap detection.
  if (releases.length >= 2) {
    for (let i = 1; i < releases.length; i += 1) {
      const prev = parseSemverVersion(releases[i - 1].version);
      const curr = parseSemverVersion(releases[i].version);
      if (prev.prerelease || curr.prerelease) continue;
      if (curr.major === prev.major && curr.minor === prev.minor) {
        for (let p = prev.patch + 1; p < curr.patch; p += 1) {
          gaps.push({ version: `${curr.major}.${curr.minor}.${p}`, status: 'ABSENT' });
        }
      } else if (curr.major === prev.major) {
        for (let m = prev.minor + 1; m < curr.minor; m += 1) {
          gaps.push({ version: `${curr.major}.${m}.0`, status: 'ABSENT' });
        }
      } else {
        for (let M = prev.major + 1; M < curr.major; M += 1) {
          gaps.push({ version: `${M}.0.0`, status: 'ABSENT' });
        }
      }
    }
  }

  return {
    nodes,
    gaps,
    summary: {
      releaseTagCount: releases.length,
      gapCount: gaps.length,
      chainBreakCount: nodes.filter((n) => n.chainBreak).length,
      orphanRootCount: nodes.filter((n) => n.chainRoot).length,
    },
  };
}

// ============================================================================
// Rebuild (handoff §2.2 option A — local object database only)
// ============================================================================

/**
 * Create a rebuilt commit object with `commit-tree`, preserving the original
 * author/committer identity and dates via environment variables.
 *
 * The message is delivered via stdin (`-F -`) rather than `-m`: `commit-tree
 * -m` strips trailing blank lines, while stdin preserves the original message
 * bytes exactly (including trailing whitespace), so a rebuilt node can be
 * byte-identical to the original commit.
 *
 * Writes ONLY a commit object into the local object database. Never writes a
 * ref and never pushes.
 *
 * @param {string} root - repository root
 * @param {string} treeSha - tree hash for the rebuilt commit
 * @param {string|null} parentSha - parent commit (null → chain root)
 * @param {string} message - commit message (exact bytes)
 * @param {{ author: {name: string, email: string, date: string}, committer: {name: string, email: string, date: string} }} identity
 * @returns {Promise<string>} rebuilt commit SHA
 */
export async function createRebuiltCommit(root, treeSha, parentSha, message, identity) {
  const args = ['commit-tree', treeSha];
  if (parentSha) args.push('-p', parentSha);
  args.push('-F', '-');
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: identity.author.name,
    GIT_AUTHOR_EMAIL: identity.author.email,
    GIT_AUTHOR_DATE: identity.author.date,
    GIT_COMMITTER_NAME: identity.committer.name,
    GIT_COMMITTER_EMAIL: identity.committer.email,
    GIT_COMMITTER_DATE: identity.committer.date,
  };
  // Async execFile has no stdin-input support (options.input would be ignored
  // and the child would hang waiting on an open stdin), so spawn is used to
  // deliver the exact message bytes on stdin.
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn('git', args, { cwd: root, env });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', rejectPromise);
    child.on('close', (code) => {
      if (code !== 0) {
        rejectPromise(new Error(`git commit-tree failed (exit ${code}): ${stderr.trim()}`));
        return;
      }
      resolvePromise(stdout.trim());
    });
    child.stdin.on('error', () => {}); // EPIPE after early exit is reported via close
    child.stdin.write(message);
    child.stdin.end();
  });
}

/**
 * Rebuild the release commit chain in the local object database (方案 A).
 *
 * For every release tag in version order:
 *   1. read the tag commit's tree (published bytes) and identity;
 *   2. create a rebuilt commit with that exact tree, parent = previous
 *      rebuilt commit (oldest version = chain root), original identity/date;
 *   3. verify: rebuilt tree hash === tag commit tree hash.
 *
 * Version gaps (missing tags such as v0.1.2) are registered as ABSENT and are
 * never fabricated into tags. Zero ref writes, zero push — pushing a
 * `release-history` branch remains a separately authorized action.
 *
 * @param {string} root - repository root
 * @param {{ dryRun?: boolean }} [options]
 * @returns {Promise<{
 *   status: 'REBUILT' | 'DRY_RUN',
 *   nodes: Array<{
 *     version: string, tag: string, originalCommit: string, originalTree: string,
 *     rebuiltCommit: string | null, rebuiltTree: string | null,
 *     parentCommit: string | null, chainRoot: boolean,
 *     verified: boolean | null, error?: string
 *   }>,
 *   gaps: Array<{ version: string, status: 'ABSENT' }>,
 *   summary: { rebuiltCount: number, verifiedCount: number, failedCount: number, absentCount: number },
 *   note: string
 * }>}
 */
export async function rebuildLineage(root, options = {}) {
  const { dryRun = false } = options;
  const analysis = await analyzeLineage(root);
  const nodes = [];
  let previousRebuiltCommit = null;

  for (const release of analysis.nodes) {
    const treeHash = release.treeHash;
    const meta = await readCommitMeta(root, release.commitSha);
    const identity = {
      author: meta.author,
      committer: meta.committer,
    };

    const node = {
      version: release.version,
      tag: release.tag,
      originalCommit: release.commitSha,
      originalTree: treeHash,
      rebuiltCommit: null,
      rebuiltTree: null,
      parentCommit: previousRebuiltCommit,
      chainRoot: previousRebuiltCommit === null,
      verified: null,
    };

    try {
      if (dryRun) {
        node.verified = null;
      } else {
        const rebuiltCommit = await createRebuiltCommit(
          root,
          treeHash,
          previousRebuiltCommit,
          meta.message || `Release ${release.version}`,
          identity,
        );
        const rebuiltTree = await getCommitTreeHash(root, rebuiltCommit);
        node.rebuiltCommit = rebuiltCommit;
        node.rebuiltTree = rebuiltTree;
        node.verified = rebuiltTree === treeHash;
        if (!node.verified) {
          throw new Error(
            `rebuilt commit tree mismatch: rebuilt=${rebuiltTree} expected=${treeHash} (version ${release.version})`,
          );
        }
        previousRebuiltCommit = rebuiltCommit;
      }
    } catch (err) {
      node.error = err.message;
      // Fail-closed: record the failed node, then stop the chain — the
      // failed node must appear in the report (failedCount ≥ 1) and no
      // later node may be created on top of a broken chain.
      nodes.push(node);
      break;
    }

    nodes.push(node);
  }

  const rebuiltNodes = nodes.filter((n) => n.rebuiltCommit !== null);
  const failedNodes = nodes.filter((n) => n.error);

  return {
    status: dryRun ? 'DRY_RUN' : 'REBUILT',
    nodes,
    gaps: analysis.gaps,
    summary: {
      rebuiltCount: rebuiltNodes.length,
      verifiedCount: rebuiltNodes.filter((n) => n.verified).length,
      failedCount: failedNodes.length,
      absentCount: analysis.gaps.length,
    },
    note: '本地对象库内重建（不写任何 ref、不推送）。推送 release-history 分支属独立授权动作，未授权前不执行。',
  };
}

// ============================================================================
// CLI entry
// ============================================================================

/**
 * Parse command-line arguments for the lineage command.
 *
 * @param {string[]} args
 * @returns {{ command: 'analyze' | 'rebuild', root: string, dryRun: boolean, json: boolean, help: boolean }}
 */
export function parseArgs(args) {
  const result = {
    command: 'analyze',
    root: process.cwd(),
    dryRun: false,
    json: false,
    help: false,
  };

  let i = 0;
  while (i < args.length) {
    const arg = args[i];
    if (arg === 'analyze' || arg === 'rebuild') {
      result.command = arg;
    } else if (arg === '--root' && i + 1 < args.length) {
      result.root = args[++i];
    } else if (arg === '--dry-run') {
      result.dryRun = true;
    } else if (arg === '--json') {
      result.json = true;
    } else if (arg === '--help' || arg === '-h') {
      result.help = true;
    }
    i += 1;
  }

  return result;
}

const HELP_TEXT = `Lineage Repair Tool — handoff §2.2 option A (local rebuild)

在本地对象库内重建发布提交链（方案 A）：每个重建提交的 tree = 对应 tag 提交的
tree（发布字节不变），parent = 前一版本的重建提交（最老版本为链根），保留原始
author/committer 身份与日期。零 ref 写入、零推送；推送 release-history 分支
属独立授权动作。

Usage:
  release-skill lineage <command> [options]

Commands:
  analyze   只读分析发布标签血缘：版本序、链关系、孤儿根、链断裂、版本缺口
  rebuild   本地重建发布提交链 + 逐节点 tree 校验报告（--dry-run 仅演练）

Options:
  --root <path>   仓库根目录（默认当前目录）
  --dry-run       只演练，不创建任何 git 对象
  --json          输出 JSON
  -h, --help      显示本帮助
`;

/**
 * Main entry point for the lineage command.
 *
 * Errors propagate to the caller (fail-closed); no error is swallowed into a
 * fake success result.
 *
 * @param {string[]} args
 * @returns {Promise<{ status: string, [key: string]: unknown }>}
 */
export async function runLineageCommand(args = []) {
  const parsed = parseArgs(args);

  if (parsed.help) {
    console.log(HELP_TEXT);
    return { status: 'HELP_SHOWN' };
  }

  if (parsed.command === 'analyze') {
    const analysis = await analyzeLineage(parsed.root);
    const output = analysis;
    console.log(parsed.json ? JSON.stringify(output, null, 2) : JSON.stringify(output, null, 2));
    return { status: 'ANALYZED', ...analysis.summary };
  }

  if (parsed.command === 'rebuild') {
    const result = await rebuildLineage(parsed.root, { dryRun: parsed.dryRun });
    console.log(JSON.stringify(result, null, 2));
    if (!parsed.json) {
      console.log(`\n重建节点：${result.summary.rebuiltCount}（校验通过 ${result.summary.verifiedCount}，失败 ${result.summary.failedCount}，缺席版本 ${result.summary.absentCount}）`);
      console.log(result.note);
    }
    return { status: result.status, ...result.summary };
  }

  throw new Error(`Unknown lineage subcommand: ${parsed.command}`);
}

export default runLineageCommand;
