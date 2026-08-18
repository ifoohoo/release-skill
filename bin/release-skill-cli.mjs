#!/usr/bin/env node

import { basename, dirname, join, resolve } from 'node:path';
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { parseNodeMajor, meetsMinimum, computeReadinessStatus } from '../src/core/node-version.mjs';
import { registerPathRedactor } from '../src/core/errors.mjs';
import { redactSensitivePaths } from '../src/core/redact.mjs';

// Install the path-redaction choke point eagerly and synchronously (static
// imports, no top-level await) so every ReleaseError constructed on any
// command path is redacted from the very first statement — in source mode and
// in the self-contained bundle alike. The bundle evaluates these static
// imports during its top level, before any lazy command initialization or
// handler runs; keeping this module graph free of top-level await is also
// what lets the bundled artifacts tree settle (AC-7: the launcher must never
// exit 13 "Detected unsettled top-level await" for a command it owns).
registerPathRedactor(redactSensitivePaths);

const execFile = promisify(execFileCb);

const COMMANDS = new Set(['help', 'setup', 'assess', 'prepare', 'approve', 'publish', 'reconcile', 'verify', 'ship', 'attest', 'hooks', 'artifacts', 'docs', 'distribute', 'route', 'lineage']);

/**
 * Check if a command is available and get its version.
 *
 * @param {string} command - The command to check.
 * @param {string[]} versionArgs - Arguments to get version (e.g., ['--version']).
 * @returns {Promise<{available: boolean, version: string|null, required: boolean, diagnostic: string}>}
 */
async function checkDependency(command, versionArgs = ['--version']) {
  try {
    const { stdout } = await execFile(command, versionArgs, {
      shell: false,
      encoding: 'utf8',
      timeout: 5000,
    });
    const version = stdout.trim().split('\n')[0];
    return {
      available: true,
      version,
      required: command === 'node',
      diagnostic: 'ok',
    };
  } catch (err) {
    return {
      available: false,
      version: null,
      required: command === 'node',
      diagnostic: err.code === 'ENOENT' ? 'not found' : err.message,
    };
  }
}

/** Known macOS bundled location of the codebuddy CLI shipped with WorkBuddy.app. */
const CODEBUDDY_MACOS_ABS_PATH = '/Applications/WorkBuddy.app/Contents/Resources/app.asar.unpacked/cli/bin/codebuddy';

/**
 * Detect the CodeBuddy CLI (`codebuddy`, alias `cbc`), which is NOT on PATH by
 * default: it ships bundled inside WorkBuddy.app. Probe in order — PATH
 * `codebuddy`, PATH `cbc`, then the known macOS absolute bundle path (read-only
 * `--version`) — and report the first available. The closed loop never execs
 * this CLI for install (the install cannot pin a frozen ref); detection only
 * powers the help/dependency report.
 *
 * @returns {Promise<{available: boolean, version: string|null, diagnostic: string, source: string|null}>}
 */
async function checkCodeBuddyDependency() {
  const candidates = [
    { source: 'PATH:codebuddy', command: 'codebuddy' },
    { source: 'PATH:cbc', command: 'cbc' },
    { source: 'macOS-bundle', command: CODEBUDDY_MACOS_ABS_PATH },
  ];
  const diagnostics = [];
  for (const { source, command } of candidates) {
    const result = await checkDependency(command, ['--version']);
    if (result.available) {
      return { available: true, version: result.version, diagnostic: 'ok', source };
    }
    diagnostics.push(`${source}: ${result.diagnostic}`);
  }
  return { available: false, version: null, diagnostic: diagnostics.join('; '), source: null };
}

/**
 * Perform environment and dependency checks.
 *
 * @returns {Promise<object>} Environment check results.
 */
async function performEnvironmentChecks() {
  const checks = {};

  // Node.js
  const nodeCheck = await checkDependency('node', ['--version']);
  checks.node = {
    ...nodeCheck,
    required: true,
    minimumVersion: '22.0.0',
    meetsMinimum: nodeCheck.available ? meetsMinimum(parseNodeMajor(nodeCheck.version), 22) : false,
  };

  // Git
  const gitCheck = await checkDependency('git', ['--version']);
  checks.git = {
    ...gitCheck,
    required: true,
    usage: '版本控制和 baseline 捕获',
  };

  // pnpm
  const pnpmCheck = await checkDependency('pnpm', ['--version']);
  checks.pnpm = {
    ...pnpmCheck,
    required: false,
    usage: '包管理（推荐）',
  };

  // npm
  const npmCheck = await checkDependency('npm', ['--version']);
  checks.npm = {
    ...npmCheck,
    required: false,
    usage: '包发布',
  };

  // GitHub CLI
  const ghCheck = await checkDependency('gh', ['--version']);
  checks.gh = {
    ...ghCheck,
    required: false,
    usage: 'GitHub 操作',
  };

  const claudeCheck = await checkDependency('claude', ['--version']);
  checks.claude = {
    ...claudeCheck,
    required: false,
    usage: '仅当计划声明 claude-plugin distribution 时用于消费者安装验证',
  };

  const codexCheck = await checkDependency('codex', ['--version']);
  checks.codex = {
    ...codexCheck,
    required: false,
    usage: '仅当计划声明 codex-plugin distribution 时用于消费者安装验证',
  };

  const kimiCheck = await checkDependency('kimi', ['--version']);
  checks.kimi = {
    ...kimiCheck,
    required: false,
    usage: '仅供发布后的人工安装使用；release-skill 不核验 Kimi 安装',
  };

  const codebuddyCheck = await checkCodeBuddyDependency();
  checks.codebuddy = {
    ...codebuddyCheck,
    required: false,
    usage: '仅供发布后的人工安装使用；release-skill 不核验 CodeBuddy/WorkBuddy 安装',
  };

  return checks;
}

/**
 * Get capability maturity information.
 *
 * @returns {object} Capability maturity information.
 */
function getCapabilityMaturity() {
  return {
    setup: {
      available: true,
      mode: 'read-only dry-run / confirmed create-once',
      description: 'Discover first-use facts and create an absent config only after exact setupDigest confirmation',
    },
    assess: {
      available: true,
      mode: 'read-only',
      description: 'Read-only assessment of project release readiness',
    },
    prepare: {
      available: true,
      mode: 'offline local writes',
      description: 'Freeze a release plan with snapshots and gates; the command invocation authorizes hook and gate execution',
    },
    docs: {
      available: true,
      mode: 'read-only dry-run / explicit local document write',
      description: 'Refresh declared README managed regions and CHANGELOG current-version entries from one structured notes source; write requires --write, exact --confirm-refresh, and --ack-local-document-write; never commits, pushes, or publishes',
    },
    publish: {
      available: true,
      mode: 'controlled production (protocol-tested; no OS/network sandbox)',
      description: 'Publishes frozen GitHub/npm artifacts after one readable-plan approval, runs automated Claude/Codex checkpoints, and emits non-blocking Kimi/CodeBuddy manual follow-ups',
    },
    reconcile: {
      available: true,
      mode: 'evidence-based recovery (protocol-tested; no OS/network sandbox)',
      description: 'Reconcile PARTIAL runs, retry safe missing checkpoints, and stop for human decisions on conflicts',
    },
    verify: {
      available: true,
      mode: 'fresh consumer verification (protocol-tested; no OS/network sandbox)',
      description: 'Recheck remote state, exact npm installation, CLI help, and automated Claude/Codex installs before VERIFIED; Kimi/CodeBuddy remain unverified manual follow-ups',
    },
    distribute: {
      available: true,
      mode: 'controlled production (protocol-tested; no OS/network sandbox)',
      description: 'Distribute frozen artifacts to configured post-publish targets (git mirrors + marketplace index) after PUBLISHED; reconciles PARTIAL runs; requires plan.postPublish config; verification gate before VERIFIED',
    },
    route: {
      available: true,
      mode: 'read-only classification with workflow recommendation',
      description: 'Deterministic quickstart routing: classify git diff changes and recommend workflow profile (docs-only/config-only/marketplace-only/full-happy-end)',
    },
    lineage: {
      available: true,
      mode: 'diagnostic and repair tool for git tag lineage',
      description: 'Lineage Repair Tool (§2.2 option A of handoff): analyze git tag lineage, identify missing/dangling tags, verify version ordering, and repair tag consistency',
    },
  };
}

function printHelp() {
  console.log(`release-skill - Release governance Skill family

Usage:
  release-skill <command> [options]

Commands:
  help       Show this help message and exit
  setup      Discover first-use configuration and gate candidates (dry-run by default)
  assess     Read-only assessment of project release readiness
  prepare    Freeze a release plan (release-skill output to .release-skill/; hooks may do remote ops)
  approve    Record local approval for a frozen release plan
  publish    Publish frozen GitHub/npm artifacts after approval
  reconcile  Resume PARTIAL state from evidence; conflicts require a human
  verify     Fresh remote and consumer verification; only this reaches VERIFIED
  ship       Resume one durable prepare -> approve -> publish -> verify flow
  attest     Legacy only: record a Kimi/CodeBuddy result for an old frozen plan
  hooks      Run declared development hooks and populate reusable receipts
  artifacts  Artifact status, inspect, update/apply, resolution, and diagnostics
  docs       Refresh declared release documents (read-only dry-run by default)
  distribute Distribute releases to post-publish targets (git mirror + marketplace) after PUBLISHED; plan.postPublish required; reconciles PARTIAL runs; verification gate before VERIFIED
  route      Deterministic quickstart routing: classify git diff changes and recommend workflow profile (docs-only/config-only/marketplace-only/full-happy-end)
  lineage    Lineage Repair Tool (§2.2 option A of handoff): analyze git tag lineage, identify missing/dangling tags, verify version ordering, repair consistency

Options:
  --root <path>    Project root directory (default: cwd)
  --plan <path>    Path to the release plan file
  --run <path>     Path to the release run file (required for reconcile/verify)
  --approval <path> Path to the approval record
  --production     Prepare immutable Git/npm production artifacts
  --output <path>  Override prepare/approve output path (non-production only)
  --run-dir <path> Override prepare run directory; production requires one direct child of .release-skill/runs
  --workflow <full|docs|config|marketplace> Workflow profile for prepare (default full). docs/config/marketplace
                   deterministically trim code-class gates (declared hooks, snapshot-verify gates,
                   source-authority closure, skill-resource-closure) and record workflowDecision in the plan;
                   config also reports whether the public bytes are unchanged (no publish path)
  --test-selection <full|incremental> Test selection for the test hook (prepare). Only 'full' is accepted at
                   freeze time; 'incremental' is reserved for a future preflight mode and is rejected
                   ('incremental selection is not allowed at freeze time')
  --answers <path> Human-reviewed setup answers JSON
  --write          Create an absent project.yaml during setup; never overwrites
  --confirm-setup <digest> Confirm exact setup facts and answers before create
  --unit <id>      Release unit whose declared release documents are refreshed (docs refresh)
  --confirm-refresh <sha256:...> Confirm the exact dry-run refreshDigest before any document write
  --ack-local-document-write Acknowledge the explicit local release-document write (docs refresh --write)
  --platform <id>   Legacy attestation platform: kimi or codebuddy
  --plugin <id>     Plugin id for a generated manual requirement
  --actor <name>    Person confirming an approval or manual result
  --result <value>  Manual result: passed or failed
  --install-path <path> Actual managed plugin path when closure verification requires it
  --install-channel <desktop|cli> CodeBuddy installation channel when required
  --approve         Approve the ship plan (boolean; plan digest is auto-resolved)
  --state <path>    Override the durable ship state file
  --no-hook-cache  Force every prepare hook to run in full; neither read nor write the hook cache
  --json           Output results as JSON
  --version        Show version and exit
  -h, --help       Show this help message and exit

Safety:
  Safe default: help -> setup (when config is absent) -> assess -> prepare --offline -> human review.
  Production happy end: ship --target-version <ver> -> ship --approve --actor <name>.
  The ship command runs configured hooks and gates automatically; the only human gate is plan approval.
  Kimi/CodeBuddy installations are non-blocking manual follow-up tasks (not verified by system).
  prepare copies current public files into a local snapshot; it does not rewrite source files.
  - Default mode is offline (release-skill pipeline does no remote writes)
  - prepare output goes to .release-skill/ directory only
  - User-configured hooks may write anywhere and perform remote operations
  - To ensure zero remote writes, disable hooks or audit them separately
  - docs refresh --write rewrites only declared README managed regions and the current CHANGELOG entry after exact refreshDigest confirmation; it never commits, pushes, tags, publishes, or installs.
  - publish requires explicit approval; plan digest is auto-read from the plan file
  - publish consumes frozen Git/npm artifacts, never the live workspace
  - existing remote objects and uncertain checks stop for human intervention
  - production-equivalent protocol sandbox is verified; a real remote canary is not

First safe command:
  release-skill help --json    # Environment check (read-only)
  release-skill setup --root <path> --json  # First-use discovery (read-only)
  release-skill assess --root <path> --offline --json  # Project assessment`);
}

const args = process.argv.slice(2);
const hasJson = args.includes('--json');
const positional = args.filter(a => !a.startsWith('--'));
const command = positional[0];

if (!command && (args.includes('--version') || args.includes('-v'))) {
  // The version probe must be install-closure independent: the npm closure
  // resolves ../package.json from bin/, but the Claude and Codex adapter
  // closures ship the bundle at a different depth with no package.json at
  // all. Bundled closures therefore carry the package identity as a
  // build-time constant (__bundlePkg) injected by the esbuild banner in
  // scripts/build-bundle.mjs; only source mode reads the file.
  let pkg;
  if (typeof __bundlePkg !== 'undefined') {
    pkg = __bundlePkg;
  } else {
    // Source mode only (the bundle always carries __bundlePkg). Deliberately
    // not a require('../package.json'): esbuild would inline it into the
    // bundle as the one remaining bundle-relative file dependency, which is
    // exactly what breaks the adapter closures.
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const pkgPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json');
    pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  }
  if (hasJson) {
    console.log(JSON.stringify({
      command: 'version',
      status: 'READY',
      name: pkg.name,
      version: pkg.version,
    }, null, 2));
  } else {
    console.log(pkg.version);
  }
  process.exit(0);
}

if (!command || command === 'help') {
  if (hasJson) {
    // Perform environment checks for --json mode
    const checks = await performEnvironmentChecks();
    const capabilities = getCapabilityMaturity();

    // Compute readiness: Node >=22 and Git are required; pnpm/npm/gh are optional
    const readiness = computeReadinessStatus({
      nodeAvailable: checks.node.available,
      nodeMeetsMinimum: checks.node.meetsMinimum,
      gitAvailable: checks.git.available,
    });
    const missingRequired = [];
    if (!checks.node.available || !checks.node.meetsMinimum) missingRequired.push('node>=22');
    if (!checks.git.available) missingRequired.push('git');
    const productionMissing = [
      ...missingRequired,
      ...(!checks.npm.available ? ['npm'] : []),
      ...(!checks.gh.available ? ['gh'] : []),
    ];

    const output = {
      command: 'help',
      mode: 'environment-check',
      status: readiness.status,
      missingRequired,
      readiness: {
        localPreparation: {
          status: readiness.status,
          missingRequired,
        },
        productionPublish: {
          status: productionMissing.length > 0 ? 'NOT_READY' : 'AUTH_CHECK_REQUIRED',
          missingRequired: productionMissing,
          authentication: '运行生产发布前还需验证 gh auth、Git HTTPS credential 与 npm auth；help 不发起网络认证检查。',
          conditionalConsumers: {
            claude: '声明 claude-plugin distribution 时必须可用',
            codex: '声明 codex-plugin distribution 时必须可用',
            kimi: '发布后人工安装待办；不影响生产发布就绪度，系统不核验',
            codebuddy: '发布后人工安装待办；不影响生产发布就绪度，系统不核验',
          },
        },
      },
      checks,
      capabilities,
      maturity: {
        setup: 'read-only by default; create-once requires answers plus exact setupDigest confirmation',
        assess: 'read-only (default); --output writes local report',
        prepare: 'offline local writes; the command invocation authorizes configured hook and gate execution',
        docs: 'read-only dry-run by default; write requires --write, exact --confirm-refresh, and --ack-local-document-write; never commits, pushes, or publishes',
        onlinePrepare: 'previous-public-baseline observation available; production mode freezes publish artifacts and fails closed on drift or unknown state',
        publish: 'GitHub/npm plus automated Claude/Codex consumer checkpoints are protocol-tested without an OS/network sandbox; one approval is required and the internal plan digest is checked automatically',
        reconcile: 'PARTIAL recovery is protocol-tested without an OS/network sandbox; remote conflicts require human intervention',
        verify: 'fresh exact npm and Claude/Codex consumer installation checks are protocol-tested without an OS/network sandbox; Kimi/CodeBuddy are unverified manual follow-ups; command invocation authorizes configured gates',
      },
      recommendations: [],
    };

    // Add recommendations based on checks
    if (!checks.node.available) {
      output.recommendations.push('Install Node.js >= 22.0.0');
    } else if (checks.node.available && !checks.node.meetsMinimum) {
      output.recommendations.push('Upgrade Node.js to version 22 or later');
    }

    if (!checks.git.available) {
      output.recommendations.push('Install Git for version control operations');
    }

    if (!checks.pnpm.available) {
      output.recommendations.push('Install pnpm for package management (optional)');
    }

    if (!checks.npm.available) {
      output.recommendations.push('Install npm for package publishing (optional)');
    }

    if (!checks.gh.available) {
      output.recommendations.push('Install GitHub CLI for GitHub operations (optional)');
    }

    if (!checks.claude.available) {
      output.recommendations.push('Install Claude CLI before releasing a configured claude-plugin distribution');
    }

    if (!checks.codex.available) {
      output.recommendations.push('Install Codex CLI before releasing a configured codex-plugin distribution');
    }

    // Kimi/CodeBuddy are post-release manual follow-ups. Their local CLI
    // availability is informational and never blocks release readiness.

    console.log(JSON.stringify(output, null, 2));
    process.exit(readiness.status === 'READY' ? 0 : 1);
  } else {
    printHelp();
    process.exit(0);
  }
}

if (!COMMANDS.has(command)) {
  if (hasJson) {
    const output = {
      error: 'UNKNOWN_COMMAND',
      message: `Unknown command: ${command}`,
      exitCode: 2
    };
    console.log(JSON.stringify(output));
  } else {
    console.error(`Error: Unknown command '${command}'`);
    console.error('Run "release-skill help" for available commands.');
  }
  process.exit(2);
}

// --- Setup command routing ---
if (command === 'setup') {
  const rootIdx = args.indexOf('--root');
  const rawRoot = rootIdx !== -1 && args[rootIdx + 1] ? args[rootIdx + 1] : process.cwd();
  const root = resolve(rawRoot);
  const answersIdx = args.indexOf('--answers');
  const answersPath = answersIdx !== -1 && args[answersIdx + 1] ? args[answersIdx + 1] : undefined;
  const confirmationIdx = args.indexOf('--confirm-setup');
  const confirmSetup = confirmationIdx !== -1 && args[confirmationIdx + 1]
    ? args[confirmationIdx + 1]
    : undefined;
  const write = args.includes('--write');
  try {
    const { setupProject } = await import('../src/commands/setup.mjs');
    const report = await setupProject({ root, answersPath, write, confirmSetup });
    if (hasJson) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log(`Setup status: ${report.status}`);
      if (report.setupDigest) console.log(`Setup digest: ${report.setupDigest}`);
      if (report.configPath) console.log(`Config: ${report.configPath}`);
      if (report.next) console.log(`Next: ${report.next}`);
    }
    process.exit(['READY_TO_WRITE', 'CONFIG_CREATED', 'ALREADY_CONFIGURED'].includes(report.status) ? 0 : 2);
  } catch (err) {
    if (hasJson) {
      console.log(JSON.stringify({
        error: err.code ?? 'UNKNOWN_ERROR',
        message: err.message,
        details: err.details ?? {},
        exitCode: err.exitCode ?? 1,
      }));
    } else {
      console.error(`Error: ${err.message}`);
    }
    process.exit(err.exitCode ?? 1);
  }
}

// --- Assess command routing ---
if (command === 'assess') {
  const rootIdx = args.indexOf('--root');
  const rawRoot = rootIdx !== -1 && args[rootIdx + 1] ? args[rootIdx + 1] : process.cwd();
  const root = resolve(rawRoot);
  const offline = args.includes('--offline') || !args.includes('--online');
  const outputIdx = args.indexOf('--output');
  const output = outputIdx !== -1 && args[outputIdx + 1] ? args[outputIdx + 1] : undefined;

  try {
    const { assessProject } = await import('../src/commands/assess.mjs');
    const report = await assessProject({ root, offline, output });

    if (hasJson) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log(report.summary);
    }

    process.exit(report.status === 'ASSESSED' ? 0 : 1);
  } catch (err) {
    if (hasJson) {
      const errOutput = {
        error: err.code ?? 'UNKNOWN_ERROR',
        message: err.message,
        details: err.details ?? {},
        exitCode: err.exitCode ?? 1,
      };
      console.log(JSON.stringify(errOutput));
    } else {
      console.error(`Error: ${err.message}`);
    }
    process.exit(err.exitCode ?? 1);
  }
}

// --- Reusable hook receipt routing ---
if (command === 'hooks') {
  const subcommand = positional[1];
  const rootIdx = args.indexOf('--root');
  const root = resolve(rootIdx !== -1 && args[rootIdx + 1] ? args[rootIdx + 1] : process.cwd());
  if (subcommand !== 'validate') {
    const message = 'hooks requires subcommand: hooks validate';
    if (hasJson) console.log(JSON.stringify({ error: 'MISSING_PARAMETERS', message }));
    else console.error(`Error: ${message}`);
    process.exit(1);
  }
  try {
    const { validateDeclaredHooks } = await import('../src/commands/hooks.mjs');
    const result = await validateDeclaredHooks({
      root,
      // --acknowledge-hook-side-effects is accepted as a no-effect compatibility input
      hooksAuthorized: args.includes('--acknowledge-hook-side-effects'),
      hookCache: !args.includes('--no-hook-cache'),
    });
    if (hasJson) console.log(JSON.stringify(result, null, 2));
    else {
      console.log(`Declared hooks: ${result.status}`);
      console.log(`Reusable receipt evidence: ${result.evidenceDir}`);
    }
    process.exit(0);
  } catch (err) {
    if (hasJson) {
      console.log(JSON.stringify({
        error: err.code ?? 'UNKNOWN_ERROR',
        message: err.message,
        details: err.details ?? {},
        exitCode: err.exitCode ?? 1,
      }));
    } else console.error(`Error: ${err.message}`);
    process.exit(err.exitCode ?? 1);
  }
}

// --- Durable end-to-end ship routing ---
if (command === 'ship') {
  const value = (flag) => {
    const idx = args.indexOf(flag);
    return idx !== -1 && args[idx + 1] ? args[idx + 1] : undefined;
  };
  const root = resolve(value('--root') ?? process.cwd());
  try {
    const [
      { advanceShip },
      { createGitGithubAdapter },
      { createNpmAdapter },
      { createPluginMarketplaceAdapter },
      { createPushSnapshotAdapter },
      { createAdapterRegistry },
    ] = await Promise.all([
      import('../src/commands/ship.mjs'),
      import('../src/adapters/git-github.mjs'),
      import('../src/adapters/npm.mjs'),
      import('../src/adapters/plugin-marketplace.mjs'),
      import('../src/adapters/push-snapshot.mjs'),
      import('../src/adapters/contract.mjs'),
    ]);
    const adapterRegistry = createAdapterRegistry([
      createGitGithubAdapter(),
      createNpmAdapter(),
      createPluginMarketplaceAdapter(),
      createPushSnapshotAdapter(),
    ]);
    const result = await advanceShip({
      root,
      statePath: value('--state'),
      targetVersion: value('--target-version') ?? value('--version'),
      approve: args.includes('--approve'),
      planApprovalDigest: value('--approve-plan'),
      actor: value('--actor'),
      adapterRegistry,
    });
    if (hasJson) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(`Ship status: ${result.status}`);
      console.log(`State: ${result.statePath}`);
      if (result.planDigest && result.status === 'NEEDS_PLAN_APPROVAL') {
        console.log(`Approve plan: ship --approve --actor <person>`);
      }
      for (const followUp of result.manualFollowUps ?? []) {
        console.log(`Manual follow-up [${followUp.platform}] ${followUp.plugin}: not verified by system`);
      }
      for (const requirement of result.requirements ?? []) {
        console.log(`Manual requirement [${requirement.platform}]: ${requirement.requirementPath}`);
      }
    }
    process.exit(0);
  } catch (err) {
    if (hasJson) {
      console.log(JSON.stringify({
        error: err.code ?? 'UNKNOWN_ERROR',
        message: err.message,
        details: err.details ?? {},
        exitCode: err.exitCode ?? 1,
      }));
    } else {
      console.error(`Error: ${err.message}`);
    }
    process.exit(err.exitCode ?? 1);
  }
}

// --- Manual attestation command routing ---
if (command === 'attest') {
  const value = (flag) => {
    const idx = args.indexOf(flag);
    return idx !== -1 && args[idx + 1] ? args[idx + 1] : undefined;
  };
  const root = resolve(value('--root') ?? process.cwd());
  try {
    const { recordManualAttestation } = await import('../src/commands/attest.mjs');
    const result = await recordManualAttestation({
      root,
      platform: value('--platform'),
      plugin: value('--plugin'),
      actor: value('--actor'),
      result: value('--result'),
      installPath: value('--install-path'),
      installChannel: value('--install-channel'),
      note: value('--note'),
    });
    if (hasJson) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(`Manual attestation recorded: ${result.platform}/${result.plugin} ${result.version}`);
      console.log(`Bound plan digest: ${result.planDigest}`);
      console.log(`Receipt: ${result.attestationPath}`);
    }
    process.exit(0);
  } catch (err) {
    if (hasJson) {
      console.log(JSON.stringify({
        error: err.code ?? 'UNKNOWN_ERROR',
        message: err.message,
        details: err.details ?? {},
        exitCode: err.exitCode ?? 1,
      }));
    } else {
      console.error(`Error: ${err.message}`);
    }
    process.exit(err.exitCode ?? 1);
  }
}

// --- Prepare command routing ---
if (command === 'prepare') {
  const rootIdx = args.indexOf('--root');
  const rawRoot = rootIdx !== -1 && args[rootIdx + 1] ? args[rootIdx + 1] : process.cwd();
  const root = resolve(rawRoot);
  const offline = args.includes('--offline') || !args.includes('--online');

  // Resolve target version from --target-version or --version flag
  let targetVersion;
  for (const flag of ['--target-version', '--version']) {
    const idx = args.indexOf(flag);
    if (idx !== -1 && args[idx + 1]) {
      targetVersion = args[idx + 1];
      break;
    }
  }

  const hooksAuthorized = args.includes('--acknowledge-hook-side-effects');
  const verificationGatesAuthorized = args.includes('--acknowledge-gate-side-effects');
  const hookCache = !args.includes('--no-hook-cache');
  const production = args.includes('--production');
  const workflowIdx = args.indexOf('--workflow');
  const workflow = workflowIdx !== -1 && args[workflowIdx + 1] ? args[workflowIdx + 1] : 'full';
  // Test-selection flag (2026-08-18 investigation §4.4): reserved for a
  // future preflight mode. prepare rejects 'incremental' at freeze time;
  // the flag is parsed here only so the CLI surface matches the contract.
  const testSelectionIdx = args.indexOf('--test-selection');
  const testSelection = testSelectionIdx !== -1 && args[testSelectionIdx + 1]
    ? args[testSelectionIdx + 1]
    : undefined;
  const outputIdx = args.indexOf('--output');
  const output = outputIdx !== -1 && args[outputIdx + 1] ? resolve(args[outputIdx + 1]) : undefined;
  const runDirIdx = args.indexOf('--run-dir');
  const runDir = runDirIdx !== -1 && args[runDirIdx + 1] ? resolve(args[runDirIdx + 1]) : undefined;

  try {
    const { prepareRelease } = await import('../src/commands/prepare.mjs');
    const { readFile: readFileFs } = await import('node:fs/promises');
    const result = await prepareRelease({
      root,
      version: targetVersion,
      offline,
      hooksAuthorized,
      verificationGatesAuthorized,
      hookCache,
      production,
      workflow,
      testSelection,
      output,
      runDir,
    });

    // Keep stdout compact and stable. The immutable plan remains the single
    // authority at planPath; callers should not have to carry its full
    // source closure, manifests and action payloads through chat/logs.
    const planContent = await readFileFs(result.planPath, 'utf8');
    const plan = JSON.parse(planContent);

    if (hasJson) {
      console.log(JSON.stringify({
        command: 'prepare',
        status: plan.status,
        planPath: result.planPath,
        planDigest: result.planDigest,
        evidenceDir: result.evidenceDir,
        workflowKind: plan.workflowKind ?? 'full',
        ...(plan.workflowDecision ? { workflowDecision: plan.workflowDecision } : {}),
        units: (plan.units ?? []).map((unit) => ({
          id: unit.id,
          targetVersion: unit.targetVersion ?? unit.version,
        })),
        actionCount: (plan.externalActions ?? []).length,
        actions: (plan.externalActions ?? []).map((action) => ({
          id: action.id,
          type: action.type,
          unitId: action.unitId,
        })),
        warnings: result.warnings,
      }, null, 2));
    } else {
      for (const warning of result.warnings) {
        console.log(`Warning [${warning.code}] ${warning.message}`);
      }
      console.log(`Plan frozen at: ${result.planPath}`);
      console.log(`Plan digest: ${result.planDigest}`);
      console.log(`Evidence: ${result.evidenceDir}`);
      if (plan.workflowKind && plan.workflowKind !== 'full') {
        console.log(`Workflow: ${plan.workflowKind}`);
      }
      if (plan.workflowDecision) {
        console.log(`Workflow decision: ${plan.workflowDecision.decision} (publish: ${plan.workflowDecision.publishPath})`);
        if (plan.workflowDecision.decision === 'public-bytes-unchanged') {
          console.log('Public bytes unchanged — no publish path; external actions omitted from this plan.');
        }
      }
    }

    process.exit(0);
  } catch (err) {
    if (hasJson) {
      const errOutput = {
        error: err.code ?? 'UNKNOWN_ERROR',
        message: err.message,
        details: err.details ?? {},
        exitCode: err.exitCode ?? 1,
      };
      console.log(JSON.stringify(errOutput));
    } else {
      console.error(`Error: ${err.message}`);
    }
    process.exit(err.exitCode ?? 1);
  }
}

// --- Approve command routing ---
if (command === 'approve') {

  const planIdx = args.indexOf('--plan');
  const planPath = planIdx !== -1 && args[planIdx + 1] ? args[planIdx + 1] : undefined;
  const digestIdx = args.indexOf('--digest');
  const expectedDigest = digestIdx !== -1 && args[digestIdx + 1] ? args[digestIdx + 1] : undefined;
  const actorIdx = args.indexOf('--actor');
  const actor = actorIdx !== -1 && args[actorIdx + 1] ? args[actorIdx + 1] : undefined;
  const outputIdx = args.indexOf('--output');
  const outputPath = outputIdx !== -1 && args[outputIdx + 1] ? resolve(args[outputIdx + 1]) : undefined;

  if (!planPath || !actor) {
    const msg = 'approve requires --plan <path> and --actor <name>';
    if (hasJson) {
      console.log(JSON.stringify({ error: 'MISSING_PARAMETERS', message: msg, exitCode: 1 }));
    } else {
      console.error(`Error: ${msg}`);
    }
    process.exit(1);
  }

  try {
    const { approvePlan } = await import('../src/commands/approve.mjs');
    const { computePlanDigest } = await import('../src/core/plan.mjs');
    const { readFile: readFileFs } = await import('node:fs/promises');

    // Auto-read digest from plan when --digest is omitted
    let resolvedDigest = expectedDigest;
    if (!resolvedDigest) {
      const planRaw = await readFileFs(resolve(planPath), 'utf8');
      const planObj = JSON.parse(planRaw);
      resolvedDigest = computePlanDigest(planObj);
    }

    const resolvedPlanPath = resolve(planPath);
    const planDir = dirname(resolvedPlanPath);
    const releaseDir = basename(planDir) === 'plans' && basename(resolvedPlanPath) === `${resolvedDigest}.json`
      ? dirname(planDir)
      : planDir;
    const approvalPath = outputPath ?? join(releaseDir, 'approval-record.json');
    const record = await approvePlan({ planPath, expectedDigest: resolvedDigest, actor, outputPath: approvalPath });

    if (hasJson) {
      console.log(JSON.stringify(record, null, 2));
    } else {
      console.log(`Plan approved by ${record.actor}`);
      console.log(`Approval record: ${record.approvalPath}`);
      console.log(`Expires at: ${record.expiresAt}`);
    }

    process.exit(0);
  } catch (err) {
    if (hasJson) {
      const errOutput = {
        error: err.code ?? 'UNKNOWN_ERROR',
        message: err.message,
        exitCode: err.exitCode ?? 1,
      };
      console.log(JSON.stringify(errOutput));
    } else {
      console.error(`Error: ${err.message}`);
    }
    process.exit(err.exitCode ?? 1);
  }
}

// --- Reconcile command routing ---
if (command === 'reconcile') {

  const rootIdx = args.indexOf('--root');
  const rawRoot = rootIdx !== -1 && args[rootIdx + 1] ? args[rootIdx + 1] : process.cwd();
  const root = resolve(rawRoot);
  const planIdx = args.indexOf('--plan');
  const planPath = planIdx !== -1 && args[planIdx + 1] ? resolve(args[planIdx + 1]) : undefined;
  const runIdx = args.indexOf('--run');
  const runPath = runIdx !== -1 && args[runIdx + 1] ? resolve(args[runIdx + 1]) : undefined;
  const approvalIdx = args.indexOf('--approval');
  const approvalPath = approvalIdx !== -1 && args[approvalIdx + 1] ? resolve(args[approvalIdx + 1]) : undefined;

  if (!planPath || !runPath) {
    const msg = 'reconcile requires --plan <path> and --run <path>';
    if (hasJson) {
      console.log(JSON.stringify({ error: 'MISSING_PARAMETERS', message: msg, exitCode: 1 }));
    } else {
      console.error(`Error: ${msg}`);
    }
    process.exit(1);
  }

  try {
    const { reconcileRelease } = await import('../src/commands/reconcile.mjs');
    const { createGitGithubAdapter } = await import('../src/adapters/git-github.mjs');
    const { createNpmAdapter } = await import('../src/adapters/npm.mjs');
    const { createPluginMarketplaceAdapter } = await import('../src/adapters/plugin-marketplace.mjs');
    const { createPushSnapshotAdapter } = await import('../src/adapters/push-snapshot.mjs');
    const { createAdapterRegistry } = await import('../src/adapters/contract.mjs');

    const registry = createAdapterRegistry([
      createGitGithubAdapter(),
      createNpmAdapter(),
      createPluginMarketplaceAdapter(),
      createPushSnapshotAdapter(),
    ]);

    const result = await reconcileRelease({
      planPath,
      sourceRunPath: runPath,
      approvalPath,
      adapterRegistry: registry,
      root,
    });

    if (hasJson) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(`Reconcile status: ${result.status}`);
      for (const cp of result.checkpoints) {
        console.log(`  ${cp.actionId}: ${cp.status}`);
      }
    }

    process.exit(result.status === 'PUBLISHED' ? 0 : 1);
  } catch (err) {
    if (hasJson) {
      const errOutput = {
        error: err.code ?? 'UNKNOWN_ERROR',
        message: err.message,
        exitCode: err.exitCode ?? 1,
      };
      console.log(JSON.stringify(errOutput));
    } else {
      console.error(`Error: ${err.message}`);
    }
    process.exit(err.exitCode ?? 1);
  }
}

// --- Verify command routing ---
if (command === 'verify') {

  const rootIdx = args.indexOf('--root');
  const rawRoot = rootIdx !== -1 && args[rootIdx + 1] ? args[rootIdx + 1] : process.cwd();
  const root = resolve(rawRoot);
  const planIdx = args.indexOf('--plan');
  const planPath = planIdx !== -1 && args[planIdx + 1] ? resolve(args[planIdx + 1]) : undefined;
  const runIdx = args.indexOf('--run');
  const runPath = runIdx !== -1 && args[runIdx + 1] ? resolve(args[runIdx + 1]) : undefined;
  const verificationGatesAuthorized = args.includes('--acknowledge-gate-side-effects');

  if (!planPath || !runPath) {
    const msg = 'verify requires --plan <path> and --run <path>';
    if (hasJson) {
      console.log(JSON.stringify({ error: 'MISSING_PARAMETERS', message: msg, exitCode: 1 }));
    } else {
      console.error(`Error: ${msg}`);
    }
    process.exit(1);
  }

  try {
    const { verifyRelease } = await import('../src/commands/verify.mjs');
    const { createGitGithubAdapter } = await import('../src/adapters/git-github.mjs');
    const { createNpmAdapter } = await import('../src/adapters/npm.mjs');
    const { createPluginMarketplaceAdapter } = await import('../src/adapters/plugin-marketplace.mjs');
    const { createPushSnapshotAdapter } = await import('../src/adapters/push-snapshot.mjs');
    const { createAdapterRegistry } = await import('../src/adapters/contract.mjs');
    const registry = createAdapterRegistry([
      createGitGithubAdapter(),
      createNpmAdapter(),
      createPluginMarketplaceAdapter(),
      createPushSnapshotAdapter(),
    ]);

    const result = await verifyRelease({
      planPath,
      sourceRunPath: runPath,
      adapterRegistry: registry,
      root,
      verificationGatesAuthorized,
    });

    if (hasJson) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(`Verify status: ${result.status}`);
      console.log(`Adapter checks: ${result.adapterChecks.length} passed`);
      console.log(`Smoke test: ${result.smokeTest.passed ? 'PASSED' : 'FAILED'}`);
      if (result.baselineAdvance) {
        if (result.baselineAdvance.failed) {
          console.log(`Baseline advance: FAILED (${result.baselineAdvance.error}); update previousPublicBaseline manually`);
        } else if (!result.baselineAdvance.changed) {
          console.log('Baseline advance: already current');
        } else {
          console.log(`Baseline advance: ${result.baselineAdvance.committed ? 'advanced and committed' : 'advanced (uncommitted — commit .release-skill/project.yaml manually)'}`);
        }
      }
    }

    process.exit(result.status === 'VERIFIED' ? 0 : 1);
  } catch (err) {
    if (hasJson) {
      const errOutput = {
        error: err.code ?? 'UNKNOWN_ERROR',
        message: err.message,
        exitCode: err.exitCode ?? 1,
      };
      console.log(JSON.stringify(errOutput));
    } else {
      console.error(`Error: ${err.message}`);
    }
    process.exit(err.exitCode ?? 1);
  }
}

// --- Publish command routing ---
if (command === 'publish') {

  const rootIdx = args.indexOf('--root');
  const rawRoot = rootIdx !== -1 && args[rootIdx + 1] ? args[rootIdx + 1] : process.cwd();
  const root = resolve(rawRoot);
  const planIdx = args.indexOf('--plan');
  const planPath = planIdx !== -1 && args[planIdx + 1] ? resolve(args[planIdx + 1]) : undefined;
  const approvalIdx = args.indexOf('--approval');
  const approvalPath = approvalIdx !== -1 && args[approvalIdx + 1] ? resolve(args[approvalIdx + 1]) : undefined;

  if (!planPath || !approvalPath) {
    const msg = 'publish requires --plan <path> and --approval <path>';
    if (hasJson) {
      console.log(JSON.stringify({ error: 'MISSING_PARAMETERS', message: msg, exitCode: 1 }));
    } else {
      console.error(`Error: ${msg}`);
    }
    process.exit(1);
  }

  try {
    const { publishRelease } = await import('../src/commands/publish.mjs');
    const { createGitGithubAdapter } = await import('../src/adapters/git-github.mjs');
    const { createNpmAdapter } = await import('../src/adapters/npm.mjs');
    const { createPluginMarketplaceAdapter } = await import('../src/adapters/plugin-marketplace.mjs');
    const { createPushSnapshotAdapter } = await import('../src/adapters/push-snapshot.mjs');
    const { createAdapterRegistry } = await import('../src/adapters/contract.mjs');

    const registry = createAdapterRegistry([
      createGitGithubAdapter(),
      createNpmAdapter(),
      createPluginMarketplaceAdapter(),
      createPushSnapshotAdapter(),
    ]);

    const result = await publishRelease({
      planPath,
      approvalPath,
      adapterRegistry: registry,
      root,
      productionMode: true,
    });

    if (hasJson) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(`Publish status: ${result.status}`);
      for (const cp of result.checkpoints) {
        console.log(`  ${cp.actionId}: ${cp.status}`);
      }
    }

    process.exit(result.status === 'PUBLISHED' ? 0 : 1);
  } catch (err) {
    if (hasJson) {
      const errOutput = {
        error: err.code ?? 'UNKNOWN_ERROR',
        message: err.message,
        exitCode: err.exitCode ?? 1,
      };
      console.log(JSON.stringify(errOutput));
    } else {
      console.error(`Error: ${err.message}`);
    }
    process.exit(err.exitCode ?? 1);
  }
}

// --- Artifacts command routing ---
if (command === 'artifacts') {
  const rootIdx = args.indexOf('--root');
  const rawRoot = rootIdx !== -1 && args[rootIdx + 1] ? args[rootIdx + 1] : process.cwd();
  const root = resolve(rawRoot);
  const outputIdx = args.indexOf('--output');
  const output = outputIdx !== -1 && args[outputIdx + 1] ? resolve(args[outputIdx + 1]) : undefined;

  const subcommand = positional[1] ?? 'status';

  try {
    const { runArtifactsCommand } = await import('../src/commands/artifacts.mjs');
    const result = await runArtifactsCommand({ subcommand, args, root });

    if (hasJson) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(`Status: ${result.status}`);
      console.log(`Safe to write: ${result.safeToWrite}`);
      console.log(`Target unchanged: ${result.targetUnchanged}`);
      if (result.nextAction) {
        console.log(`Next action: ${result.nextAction.command}`);
      }
    }

    // Exit code: 0 if clean/safe/drift-detected (dry-run), 1 if blocking
    const blockingStatuses = new Set([
      'BASE_UNAVAILABLE', 'POLICY_INVALID', 'PATH_UNSAFE',
      'CONFLICT', 'DIRTY_SCOPE_CONFLICT',
    ]);
    process.exit(blockingStatuses.has(result.status) ? 1 : 0);
  } catch (err) {
    if (hasJson) {
      const errOutput = {
        error: err.code ?? 'UNKNOWN_ERROR',
        message: err.message,
        status: err.code ?? 'UNKNOWN_ERROR',
        safeToWrite: false,
        targetUnchanged: true,
        evidenceDir: null,
        nextAction: { command: 'artifacts inspect --root <path>' },
        exitCode: err.exitCode ?? 1,
      };
      console.log(JSON.stringify(errOutput));
    } else {
      console.error(`Error: ${err.message}`);
    }
    process.exit(err.exitCode ?? 1);
  }
}

// --- Docs command routing ---
if (command === 'docs') {
  try {
    const { ReleaseError, MISSING_PARAMETERS } = await import('../src/core/errors.mjs');

    // --root is extracted and validated here (the router resolves the project
    // root): a following flag is never accepted as the path, and a duplicated
    // --root is an explicit parameter error (previously silently ignored).
    const rootIndexes = [];
    for (let i = 0; i < args.length; i += 1) {
      if (args[i] === '--root') rootIndexes.push(i);
    }
    if (rootIndexes.length > 1) {
      throw new ReleaseError(
        MISSING_PARAMETERS,
        'docs received --root more than once',
        { reason: 'DUPLICATE_PARAMETER', field: '--root' },
      );
    }
    let rawRoot = process.cwd();
    if (rootIndexes.length === 1) {
      rawRoot = args[rootIndexes[0] + 1];
      if (typeof rawRoot !== 'string' || rawRoot.length === 0 || rawRoot.startsWith('-')) {
        throw new ReleaseError(
          MISSING_PARAMETERS,
          'docs --root requires a path value',
          { reason: 'MISSING_VALUE', field: '--root' },
        );
      }
    }
    const root = resolve(rawRoot);

    // The docs subcommand is the first bare positional token after the `docs`
    // command token itself. Valued flags and their values are skipped so
    // `--root <path>` can never be mistaken for the subcommand; any flag
    // outside the recognized docs set (including unregistered valued flags)
    // is rejected here so its value can never be mistaken for the subcommand.
    const valuedDocsFlags = new Set(['--root', '--unit', '--confirm-refresh']);
    const booleanDocsFlags = new Set(['--json', '--write', '--ack-local-document-write']);
    let docsSubcommand;
    let sawCommandToken = false;
    for (let i = 0; i < args.length; i += 1) {
      const token = args[i];
      if (typeof token !== 'string') continue;
      if (token.startsWith('--')) {
        const eq = token.indexOf('=');
        const flag = eq === -1 ? token : token.slice(0, eq);
        if (valuedDocsFlags.has(flag)) {
          if (eq === -1) i += 1; // space-separated form: skip the value too
          continue;
        }
        if (booleanDocsFlags.has(flag)) continue;
        throw new ReleaseError(
          MISSING_PARAMETERS,
          `docs does not accept ${flag}`,
          { reason: 'UNRECOGNIZED_PARAMETER', parameter: flag },
        );
      }
      if (token.startsWith('-') && token.length > 1) {
        throw new ReleaseError(
          MISSING_PARAMETERS,
          `docs does not accept ${token}`,
          { reason: 'UNRECOGNIZED_PARAMETER', parameter: token },
        );
      }
      if (!sawCommandToken) {
        sawCommandToken = true; // the `docs` command token itself
        continue;
      }
      docsSubcommand = token;
      break;
    }

    const { runDocsCommand } = await import('../src/commands/docs.mjs');
    const result = await runDocsCommand({ subcommand: docsSubcommand, args, root });

    if (hasJson) {
      console.log(JSON.stringify(result, null, 2));
    } else if (result.mode === 'dry-run') {
      console.log(`Status: ${result.status}`);
      console.log(`Unit: ${result.unitId}`);
      console.log(`Version: ${result.version}`);
      console.log(`Refresh digest: ${result.refreshDigest}`);
      for (const file of result.files) {
        const marker = file.changed ? '' : ' (unchanged)';
        console.log(`  ${file.path} ${file.kind} ${file.locale} ${file.change}${marker}`);
      }
      if (result.nextCommand?.argv) {
        console.log(`Next: ${result.nextCommand.argv.join(' ')}`);
      }
      if (result.nextCommand?.writeArgv) {
        console.log(`Next (write): ${result.nextCommand.writeArgv.join(' ')}`);
      }
    } else {
      console.log(`Status: ${result.status}`);
      console.log(`Unit: ${result.unitId}`);
      console.log(`Version: ${result.version}`);
      console.log(`Refresh digest: ${result.refreshDigest}`);
      if (result.refreshed) {
        console.log(`Transaction: ${result.transactionId}`);
        for (const path of result.refreshedPaths ?? []) {
          console.log(`  refreshed ${path}`);
        }
      }
    }

    process.exit(0);
  } catch (err) {
    // docs parameter errors must surface the stable JSON error shape even in
    // text mode (CLI parameter validation precedes any service I/O).
    console.log(JSON.stringify({
      error: err.code ?? 'UNKNOWN_ERROR',
      message: err.message,
      details: err.details ?? {},
      exitCode: err.exitCode ?? 1,
    }));
    process.exit(err.exitCode ?? 1);
  }
}

// --- Distribute command routing ---
if (command === 'distribute') {
  const value = (flag) => {
    const idx = args.indexOf(flag);
    return idx !== -1 && args[idx + 1] ? args[idx + 1] : undefined;
  };
  const root = resolve(value('--root') ?? process.cwd());
  const planPath = value('--plan');
  const approvalPath = value('--approval');
  const runPath = value('--run');
  const dryRun = args.includes('--dry-run');
  
  // Handle --help explicitly
  if (args.includes('--help')) {
    const helpText = `Distribute command: Distributes frozen artifacts to post-publish targets
  
Usage: release-skill distribute --plan <path> --run <path> [options]

Options:
  --root     Project root directory (default: cwd)
  --plan     Path to the release plan file (required)
  --run      Path to the release run file (required)
  --approval Path to the approval record (optional but recommended)
  --dry-run  Preview distribution steps without executing (default: false)

Description:
  After PUBLISHED state, distributes to configured postPublish targets:
  - Git repository mirrors
  - Marketplace index updates
  Requires plan.postPublish configuration. Reconciles PARTIAL runs.`;
    if (hasJson) {
      console.log(JSON.stringify({
        command: 'distribute',
        description: 'Distributes frozen artifacts to post-publish targets (git mirror + marketplace) after PUBLISHED',
        usage: 'release-skill distribute --plan <path> --run <path> [options]',
        options: {
          '--root': 'Project root directory (default: cwd)',
          '--plan': 'Path to the release plan file (required)',
          '--run': 'Path to the release run file (required)',
          '--approval': 'Path to the approval record (optional but recommended)',
          '--dry-run': 'Preview distribution steps without executing (default: false)',
        },
        description: 'After PUBLISHED state, distributes to configured postPublish targets: git mirrors + marketplace index updates. Requires plan.postPublish config. Reconciles PARTIAL runs.',
      }, null, 2));
    } else {
      console.log(helpText);
    }
    process.exit(0);
  }

  if (!planPath || !runPath) {
    const msg = 'distribute requires --plan <path> and --run <path>';
    if (hasJson) {
      console.log(JSON.stringify({ error: 'MISSING_PARAMETERS', message: msg, exitCode: 1 }));
    } else {
      console.error(`Error: ${msg}`);
    }
    process.exit(1);
  }

  try {
    const { distributeRelease } = await import('../src/commands/distribute.mjs');
    const { createGitGithubAdapter } = await import('../src/adapters/git-github.mjs');
    const { createNpmAdapter } = await import('../src/adapters/npm.mjs');
    const { createPluginMarketplaceAdapter } = await import('../src/adapters/plugin-marketplace.mjs');
    const { createPushSnapshotAdapter } = await import('../src/adapters/push-snapshot.mjs');
    const { createAdapterRegistry } = await import('../src/adapters/contract.mjs');

    const registry = createAdapterRegistry([
      createGitGithubAdapter(),
      createNpmAdapter(),
      createPluginMarketplaceAdapter(),
      createPushSnapshotAdapter(),
    ]);

    const result = await distributeRelease({
      sourceRunPath: runPath,
      approvalPath,
      adapterRegistry: registry,
      root,
      dryRun,
      planPath,
    });

    if (hasJson) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(`Distribute status: ${result.status}`);
      for (const cp of result.checkpoints) {
        console.log(`  ${cp.actionId}: ${cp.status}`);
      }
      if (result.distributeRunPath) {
        console.log(`Distribute run: ${result.distributeRunPath}`);
      }
    }

    process.exit(result.status === 'DISTRIBUTED' ? 0 : 1);
  } catch (err) {
    if (hasJson) {
      const errOutput = {
        error: err.code ?? 'UNKNOWN_ERROR',
        message: err.message,
        details: err.details ?? {},
        exitCode: err.exitCode ?? 1,
      };
      console.log(JSON.stringify(errOutput));
    } else {
      console.error(`Error: ${err.message}`);
    }
    process.exit(err.exitCode ?? 1);
  }
}

// --- Route command routing (workflow profile quickstart) ---
if (command === 'route') {
  // Pass the full arg list after the command name through to the command's own
  // parser (route.mjs parseArgs handles --root/--target-version/--publish-authorized/
  // --json/-h). The --vs flag never existed in the command's interface and is
  // not forwarded; route reads the real worktree state itself.
  try {
    const { default: routeMain } = await import('../src/commands/route.mjs');
    const result = await routeMain(args.slice(1));

    if (!hasJson) {
      if (result.status === 'SUCCESS') {
        console.log('\n✅ Classification complete.');
        console.log('Next steps: Follow the recommendation in the output above.');
      } else if (result.status === 'ERROR') {
        console.error(`\n❌ Route command failed with status: ${result.error}`);
      }
    }

    process.exit(result.exitCode ?? 0);
  } catch (err) {
    if (hasJson) {
      console.log(JSON.stringify({
        error: err.code ?? 'UNKNOWN_ERROR',
        message: err.message,
        details: err.details ?? {},
        exitCode: err.exitCode ?? 1,
      }, null, 2));
    } else {
      console.error(`Error: ${err.message}`);
    }
    process.exit(err.exitCode ?? 1);
  }
}

// --- Lineage command routing (lineage repair tool) ---
if (command === 'lineage') {
  // Pass the full arg list after the command name through to the command's own
  // parser. Never filter positional args here: filtering drops the VALUES of
  // --root/--repo (they do not start with '--') and also drops --dry-run
  // itself, silently turning a dry run into a real one.
  try {
    const { runLineageCommand } = await import('../src/commands/lineage.mjs');
    const result = await runLineageCommand(args.slice(1));

    if (!hasJson) {
      if (['ANALYZED', 'REBUILT', 'DRY_RUN', 'HELP_SHOWN'].includes(result.status)) {
        console.log(`\n✅ Lineage operation complete (${result.status.toLowerCase()}).`);
      } else if (result.status === 'ERROR') {
        console.error(`\n❌ Lineage command failed: ${result.error}`);
      }
    }

    process.exit(result.status === 'ERROR' ? 1 : 0);
  } catch (err) {
    if (hasJson) {
      console.log(JSON.stringify({
        error: err.code ?? 'UNKNOWN_ERROR',
        message: err.message,
        details: err.details ?? {},
        exitCode: err.exitCode ?? 1,
      }, null, 2));
    } else {
      console.error(`Error: ${err.message}`);
    }
    process.exit(err.exitCode ?? 1);
  }
}

// Placeholder: remaining commands will be wired in later commands
console.error(`Command '${command}' is not yet implemented.`);
process.exit(1);
