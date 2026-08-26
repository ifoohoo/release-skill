/**
 * Adoption assessment domain logic (WP-6, release-skill 0.8.0).
 *
 * Answers "is this project fully adopted into the release workflow?" with a
 * four-category matrix and a stable machine-readable report. This module
 * holds ONLY the pure domain semantics — classification, status derivation,
 * hook-cost derivation, digest computation and deterministic report
 * assembly. All filesystem/process I/O (config loading, discovery, assess
 * checks, evidence reads) stays in the orchestrator
 * `assessAdoption` (src/commands/setup.mjs).
 *
 * R-11 boundaries enforced here (裁决 17-20):
 * - hook duration comes only from description-matching (normalized
 *   command/cwd), trusted-producer started/completed evidence pairs;
 *   "unknown" without evidence, for foreign producers, for missing or
 *   changed description fields, or for unpairable events — matching by
 *   name alone is never a duration; `timeoutMs` is never treated as
 *   actual cost;
 * - cached completions count as cache hits, never real cost;
 * - long-hook cost and check-only notes are non-blocking suggestions that
 *   never change the adopted status (removing them changes nothing about
 *   the adoption conclusion);
 * - check-only recommendations require an explicit `--check` argv token —
 *   script names never imply side-effect freedom;
 * - indirect package scripts (package-manager run/test delegation,
 *   interpreter script paths, shell/code-string evaluation) get manual
 *   judgment only, never an executable-looking draft;
 * - the cross-unit postPublish rule (one plan binds one declaration) is a
 *   single pure implementation shared with the assessment.
 *
 * Determinism contract (acceptance scenario 7): the report contains no
 * timestamps, findings are sorted by (category, code, fieldPath, unitId),
 * and `assessmentDigest` binds the config digest plus the full discovery
 * facts so any fact change invalidates earlier suggestion summaries for any
 * future write path.
 *
 * @module adoption-assessment
 */

import { canonicalJson, sha256Hex } from './digest.mjs';
import { resolveProducerVersion } from './evidence.mjs';

// Keep the assessment entry point compatible without duplicating the rule.
export { findPostPublishUnitConflict } from './hooks.mjs';

/** Four adoption statuses; never reuses ASSESSED (design §3.2). */
export const ASSESSMENT_STATUS = Object.freeze({
  NOT_CONFIGURED: 'NOT_CONFIGURED',
  PARTIALLY_ADOPTED: 'PARTIALLY_ADOPTED',
  ADOPTED_WITH_SUGGESTIONS: 'ADOPTED_WITH_SUGGESTIONS',
  ADOPTED: 'ADOPTED',
});

/** Four finding categories (design §3.2). */
export const FINDING_CATEGORY = Object.freeze({
  MANDATORY_GAP: 'mandatory-gap',
  SATISFIED: 'satisfied',
  OPTIONAL_SUGGESTION: 'optional-suggestion',
  NOT_APPLICABLE: 'not-applicable',
});

const CATEGORY_RANK = Object.freeze({
  'mandatory-gap': 0,
  'satisfied': 1,
  'optional-suggestion': 2,
  'not-applicable': 3,
});

/**
 * A hook whose last real (non-cached) run lasted at least this long counts
 * as a long-hook cost signal (motivated by observed multi-tens-of-minutes
 * full test runs). Pure observation: it is a non-blocking suggestion.
 */
export const LONG_HOOK_THRESHOLD_MS = 30 * 60 * 1000;

/**
 * Suggestion-only draft values. The design scenario 5 requires drafts to
 * carry timeoutMs and envAllowlist; these are documented defaults that every
 * draft marks as requiring human confirmation — never auto-registered.
 */
export const DRAFT_GATE_TIMEOUT_MS = 600_000;
export const DRAFT_GATE_ENV_ALLOWLIST = Object.freeze(['PATH', 'HOME']);

/**
 * Create a single finding entry of the four-category matrix.
 *
 * @param {Object} parts
 * @param {string} parts.category - One of FINDING_CATEGORY values.
 * @param {string} parts.code - Stable diagnostic code.
 * @param {string} [parts.unitId] - Declared unit id the finding belongs to.
 * @param {string} [parts.fieldPath] - Config path expression (e.g.
 *   "releaseUnits[].source") or null for assess-derived findings.
 * @param {string} parts.message - Chinese message.
 * @param {Object} [parts.evidence] - Machine-readable evidence.
 * @param {string} [parts.action] - Chinese suggested action (required for
 *   blocking findings).
 * @param {'blocking'|'info'|'suggestion'} [parts.severity]
 * @returns {Object} Frozen finding.
 */
export function createFinding({
  category,
  code,
  unitId,
  fieldPath,
  message,
  evidence,
  action,
  severity,
}) {
  const finding = { category, code, message };
  if (unitId !== undefined) finding.unitId = unitId;
  if (fieldPath !== undefined) finding.fieldPath = fieldPath;
  if (evidence !== undefined) finding.evidence = evidence;
  if (action !== undefined) finding.action = action;
  if (severity !== undefined) finding.severity = severity;
  return Object.freeze(finding);
}

/**
 * Map an assess gap severity onto the four-category matrix.
 *
 * @param {'error'|'warning'} severity
 * @returns {string} FINDING_CATEGORY value.
 */
export function classifyGapCategory(severity) {
  return severity === 'error' ? FINDING_CATEGORY.MANDATORY_GAP : FINDING_CATEGORY.OPTIONAL_SUGGESTION;
}

/**
 * Normalize a hook description for matching (裁决 18): the canonical JSON
 * of `{ command, cwd }` where a missing/empty cwd means project root. Both
 * the declared hook and the historical event are normalized the same way,
 * so command/cwd changes can never pair by name alone.
 *
 * @param {Array<string>} command
 * @param {string|null|undefined} cwd
 * @returns {string}
 */
function normalizeHookDescription(command, cwd) {
  return canonicalJson({
    command: Array.isArray(command) ? [...command] : null,
    cwd: typeof cwd === 'string' && cwd.length > 0 ? cwd : null,
  });
}

/**
 * Derive per-hook duration facts from parsed evidence events (R-11, 裁决 18).
 *
 * Trust boundary: only events whose `producer` is `{name: 'release-skill',
 * version: currentProducerVersion}` are considered. Events without a
 * producer (v1-era) or from an older producer are ignored; missing evidence
 * therefore yields basis "unknown", never a guessed number.
 *
 * Description boundary: a real run is only derivable when the historical
 * event carries a sufficient description (`details.hookCommand` plus an
 * explicitly present, contract-valid `details.hookCwd`) whose normalized form matches the current declared
 * hook's normalized description. Command/cwd changes, missing fields,
 * unknown producers and unpairable started/completed events all yield
 * "unknown" — matching by name alone is never a duration (裁决 18). No
 * historical identity is fabricated and no duration database exists.
 *
 * A "real run" is a started/completed pair within one runId where the
 * completed event does NOT carry `cached: true` and both events carry the
 * same normalized description. Cached completions are counted as cache hits
 * and never contribute to cost. Failed runs are counted but never become a
 * duration. The reported durationMs is the latest real pair (highest
 * completed timestamp).
 *
 * @param {Object} options
 * @param {Array<Object>} options.events - Parsed evidence events (envelope
 *   fields present: runId, timestamp, phase, status, producer, hookName).
 * @param {Object<string, {command: string[], cwd?: string}>} options.declaredHooks -
 *   Currently declared hooks (config.hooks); the current normalized
 *   description each historical event must match.
 * @param {string} options.currentProducerVersion - Version that is trusted
 *   today (resolveProducerVersion()).
 * @returns {Array<{hookName: string, basis: 'evidence'|'unknown',
 *   durationMs: number|null, realRuns: number, cacheHits: number,
 *   failedRuns: number, lastObservedAt: string|null}>} Sorted by hookName.
 */
export function deriveHookDurations({ events, declaredHooks, currentProducerVersion }) {
  const hookNames = Object.keys(declaredHooks ?? {}).sort();
  const trusted = (event) => (
    event?.producer?.name === 'release-skill'
    && event?.producer?.version === currentProducerVersion
  );
  const byHook = new Map(hookNames.map((name) => [name, {
    hookName: name,
    basis: 'unknown',
    durationMs: null,
    realRuns: 0,
    cacheHits: 0,
    failedRuns: 0,
    lastObservedAt: null,
  }]));
  const declaredDescription = new Map(hookNames.map((name) => [
    name,
    normalizeHookDescription(declaredHooks[name]?.command, declaredHooks[name]?.cwd),
  ]));

  // V4: hook location and cache facts live inside `details` in v2 events;
  // the legacy top-level position is still tolerated so historical runs
  // stay consumable (migrated consumers retain the original information).
  const hookOf = (event) => {
    if (typeof event?.details?.hookName === 'string' && event.details.hookName.length > 0) {
      return event.details.hookName;
    }
    return typeof event?.hookName === 'string' ? event.hookName : null;
  };
  const wasCached = (event) => event?.cached === true || event?.details?.cached === true;
  // Description of an event, or null when the historical description is
  // insufficient (裁决 18: 字段不足就显示未知).
  const eventDescription = (event) => {
    const command = event?.details?.hookCommand;
    if (!Array.isArray(command) || command.length === 0
      || !command.every((token) => typeof token === 'string')) {
      return null;
    }
    // A missing historical cwd is not evidence of the default cwd. Only an
    // explicitly recorded contract value may normalize to the default.
    if (!event.details || !Object.prototype.hasOwnProperty.call(event.details, 'hookCwd')) {
      return null;
    }
    const cwd = event.details.hookCwd;
    if (cwd !== null && typeof cwd !== 'string') return null;
    return normalizeHookDescription(command, cwd);
  };

  for (const event of events ?? []) {
    if (event?.phase !== 'hooks') continue;
    const hookName = hookOf(event);
    if (hookName === null || !byHook.has(hookName)) continue;
    const record = byHook.get(hookName);
    if (!trusted(event)) continue;
    if (event.status === 'started') continue;
    if (event.status === 'failed') {
      record.failedRuns += 1;
      continue;
    }
    if (event.status !== 'completed') continue;
    if (wasCached(event)) {
      record.cacheHits += 1;
      continue;
    }
    // A real completion: the historical description must be sufficient and
    // match the current normalized description, and it must pair with the
    // run's started event carrying the SAME description.
    const completedDescription = eventDescription(event);
    if (completedDescription === null || completedDescription !== declaredDescription.get(hookName)) {
      continue;
    }
    const started = (events ?? []).find((candidate) => (
      candidate?.runId === event.runId
      && candidate?.phase === 'hooks'
      && candidate?.status === 'started'
      && hookOf(candidate) === hookName
      && trusted(candidate)
      && eventDescription(candidate) === completedDescription
    ));
    if (!started) continue;
    const startedTs = Date.parse(started.timestamp);
    const completedTs = Date.parse(event.timestamp);
    if (Number.isNaN(startedTs) || Number.isNaN(completedTs)) continue;
    const durationMs = Math.max(0, completedTs - startedTs);
    record.realRuns += 1;
    if (record.lastObservedAt === null || event.timestamp > record.lastObservedAt) {
      record.lastObservedAt = event.timestamp;
      record.durationMs = durationMs;
      record.basis = 'evidence';
    }
  }

  return [...byHook.values()].sort((a, b) => a.hookName.localeCompare(b.hookName));
}

/**
 * Derive the adoption status from findings (design §3.2, §7).
 *
 * Only mandatory gaps can move a project out of the adopted band; optional
 * suggestions choose between ADOPTED_WITH_SUGGESTIONS and ADOPTED.
 * not-applicable entries never affect the status.
 *
 * @param {Array<Object>} findings
 * @returns {string} ASSESSMENT_STATUS value (never NOT_CONFIGURED here).
 */
export function deriveStatus(findings) {
  if (findings.some((f) => f.category === FINDING_CATEGORY.MANDATORY_GAP)) {
    return ASSESSMENT_STATUS.PARTIALLY_ADOPTED;
  }
  if (findings.some((f) => f.category === FINDING_CATEGORY.OPTIONAL_SUGGESTION)) {
    return ASSESSMENT_STATUS.ADOPTED_WITH_SUGGESTIONS;
  }
  return ASSESSMENT_STATUS.ADOPTED;
}

/**
 * Derive gate suggestions from setup's gate candidates (scenarios 5 & 6).
 *
 * Draft condition (design §3.3 + §6 scenario 5/6, 裁决 19): the script's
 * argv is a direct command declaration (`inspectedArgv !== null`), carries
 * no positive side-effect signal from classifyScript (no network, no
 * interactivity, no file writes, not high-cost, not consumer-context), and
 * is NOT an identified indirect script (package-manager run/test
 * delegation, interpreter script path, shell/code-string evaluation —
 * `gate.indirectScript === true`). Indirect scripts get a
 * needsManualJudgment suggestion with NO executable-looking draft: the
 * actual behavior and side-effect boundary of an indirect script cannot be
 * proven from the declaration, and "no danger signals found" is never a
 * side-effect safety proof. No recursive script dependency graph or
 * general-purpose command safety analyzer is built.
 *
 * Side-effect FREEDOM is never claimed even for drafts: every draft states
 * that registration requires human confirmation (classifyScript's
 * fail-closed stance — see `eligibleForRecommendation` which is
 * intentionally always false because discovery cannot prove side effects;
 * SIDE_EFFECTS_UNPROVEN on a DIRECT command is therefore the benign case
 * that still gets a draft, with the caveat spelled out).
 *
 * Suggestions map onto a declared unit by matching candidate unit source to
 * a declared unit source; candidates without a declared counterpart are
 * skipped (no config position to suggest into).
 *
 * @param {Object} options
 * @param {Array<Object>} options.declaredUnits - config.releaseUnits.
 * @param {Array<Object>} options.candidates - buildCandidates(facts) result
 *   ({units, gates}).
 * @returns {Array<Object>} Suggestions sorted by (unitId, script).
 */
const POSITIVE_SIDE_EFFECT_REASONS = new Set([
  'NETWORK_LIKELY',
  'INTERACTIVE',
  'HIGH_COST',
  'MAY_WRITE_FILES',
  'CONSUMER_CONTEXT_UNPROVEN',
]);

export function deriveGateSuggestions({ declaredUnits, candidates }) {
  const declaredBySource = new Map(declaredUnits.map((unit) => [unit.source, unit]));
  const candidateUnits = candidates?.units ?? [];
  const suggestions = [];
  for (const gate of candidates?.gates ?? []) {
    if (typeof gate.script !== 'string' || !gate.scope?.unit) continue;
    const candidateUnit = candidateUnits.find((unit) => unit.id === gate.scope.unit);
    const declaredUnit = candidateUnit ? declaredBySource.get(candidateUnit.source) : undefined;
    if (!declaredUnit) continue;
    const base = {
      id: gate.id,
      unitId: declaredUnit.id,
      script: gate.script,
    };
    const positiveSignal = POSITIVE_SIDE_EFFECT_REASONS.has(gate.ineligibilityReason);
    if (gate.inspectedArgv === null || positiveSignal || gate.indirectScript === true) {
      suggestions.push({
        ...base,
        needsManualJudgment: true,
        ineligibilityReason: gate.ineligibilityReason ?? 'UNPARSEABLE_COMMAND',
        draft: null,
        rationale: gate.inspectedArgv === null
          ? `package.json 脚本 "${gate.script}" 无法解析为直接命令（间接脚本或自然语言）；需要人工判断，不生成草案。`
          : gate.indirectScript === true
            ? `package.json 脚本 "${gate.script}" 是间接脚本（实际执行的命令与副作用边界无法从声明证明）；需要人工判断，不生成可执行草案。`
            : `package.json 脚本 "${gate.script}" 携带正向副作用信号（${gate.ineligibilityReason}）；不能机械确认其安全性，需要人工判断，不生成可执行草案。`,
      });
    } else {
      suggestions.push({
        ...base,
        needsManualJudgment: false,
        draft: {
          phase: gate.recommendedPhase,
          scope: {
            unit: declaredUnit.id,
            ...(gate.scope.distribution ? { distribution: gate.scope.distribution } : {}),
          },
          command: [...gate.inspectedArgv],
          cwd: declaredUnit.source,
          timeoutMs: DRAFT_GATE_TIMEOUT_MS,
          envAllowlist: [...DRAFT_GATE_ENV_ALLOWLIST],
        },
        rationale: `package.json 脚本 "${gate.script}" 可直接解析为命令 ["${gate.inspectedArgv.join('", "')}"]（无网络/交互/写文件信号）。副作用是否可接受、timeoutMs 与 envAllowlist 为建议值，均需人工确认；评估未写入配置。`,
      });
    }
  }
  suggestions.sort((a, b) => (a.unitId.localeCompare(b.unitId) || a.script.localeCompare(b.script)));
  return suggestions;
}

/**
 * Scan EVERY declared verification gate for the three semantic rules that
 * make a declaration invalid (design §3.1.4, scenario 4): duplicate ids,
 * unknown unit, and consumer-verify gates over an undeclared distribution.
 *
 * Config loading stops at the FIRST offending gate; this scan reports all of
 * them so the report lists every invalid declaration instead of one at a
 * time. Mirror of the load-time rules in core/config.mjs, scoped to the
 * adoption report (no schema re-validation here).
 *
 * @param {Object} options
 * @param {Array<Object>} options.units - config.releaseUnits.
 * @param {Array<Object>} options.gates - config.verificationGates.
 * @returns {Array<Object>} GATE_DECLARATION_INVALID findings (sorted).
 */
export function scanGateDeclarationFindings({ units, gates }) {
  const findings = [];
  const unitsById = new Map((units ?? []).map((unit) => [unit.id, unit]));
  const seenIds = new Set();
  for (const gate of gates ?? []) {
    const gateId = gate?.id;
    if (typeof gateId !== 'string') continue;
    if (seenIds.has(gateId)) {
      findings.push(createFinding({
        category: FINDING_CATEGORY.MANDATORY_GAP,
        code: 'GATE_DECLARATION_INVALID',
        fieldPath: 'verificationGates[]',
        message: `verification gate id "${gateId}" 重复声明；id 必须唯一。`,
        evidence: { gateId },
        action: '修正 verificationGates 声明（单元/渠道必须存在，id 不得重复）后重新评估。',
        severity: 'blocking',
      }));
      continue;
    }
    seenIds.add(gateId);
    const unit = unitsById.get(gate?.scope?.unit);
    if (!unit) {
      findings.push(createFinding({
        category: FINDING_CATEGORY.MANDATORY_GAP,
        code: 'GATE_DECLARATION_INVALID',
        fieldPath: 'verificationGates[]',
        message: `verification gate "${gateId}" 引用不存在的发布单元 "${gate.scope.unit}"。`,
        evidence: { gateId, unitId: gate.scope.unit },
        action: '修正 verificationGates 声明（单元/渠道必须存在，id 不得重复）后重新评估。',
        severity: 'blocking',
      }));
      continue;
    }
    if (
      gate.phase === 'consumer-verify'
      && !(unit.distributions ?? []).some((distribution) => distribution.type === gate.scope?.distribution)
    ) {
      findings.push(createFinding({
        category: FINDING_CATEGORY.MANDATORY_GAP,
        code: 'GATE_DECLARATION_INVALID',
        unitId: unit.id,
        fieldPath: 'verificationGates[]',
        message: `verification gate "${gateId}" 引用发布单元 "${unit.id}" 未声明的分发渠道 "${gate.scope.distribution}"。`,
        evidence: { gateId, unitId: unit.id, distribution: gate.scope.distribution },
        action: '修正 verificationGates 声明（单元/渠道必须存在，id 不得重复）后重新评估。',
        severity: 'blocking',
      }));
    }
  }
  findings.sort((a, b) => (
    (a.evidence?.gateId ?? '').localeCompare(b.evidence?.gateId ?? '')
  ));
  return findings;
}

/**
 * Check-only (R-11 item 4): recommend only when the declared hook command
 * explicitly carries a `--check` token. Script names never imply check-only
 * semantics.
 *
 * @param {Object} hooks - config.hooks (declared hooks by name).
 * @returns {Array<Object>} CHECK_MODE_DECLARED suggestions.
 */
export function deriveCheckOnlySuggestions(hooks) {
  const findings = [];
  for (const [hookName, hook] of Object.entries(hooks ?? {})) {
    if (!Array.isArray(hook?.command)) continue;
    if (!hook.command.some((token) => token === '--check')) continue;
    findings.push(createFinding({
      category: FINDING_CATEGORY.OPTIONAL_SUGGESTION,
      code: 'CHECK_MODE_DECLARED',
      fieldPath: `hooks.${hookName}.command`,
      message: `hook "${hookName}" 的命令明确提供 --check 只读检查模式；如需降低重复执行成本，可在人工确认后评估（评估不会自动修改配置）。`,
      evidence: { hookName, argv: [...hook.command] },
      action: '人工确认命令只读语义后再考虑采用；不构成跳过完整检查的依据。',
      severity: 'suggestion',
    }));
  }
  return findings;
}

/**
 * Derive the long-hook cost suggestion (R-11 item 1) from durations.
 *
 * The suggestion is observation-layer only: it never changes the adoption
 * status and never proposes cacheable/cacheInputs — those require the
 * project's own completeness proof plus Foundation 0.11 capabilities.
 *
 * @param {Array<Object>} hookDurations - deriveHookDurations() output.
 * @returns {Array<Object>} LONG_HOOK_COST suggestions.
 */
export function deriveLongHookSuggestions(hookDurations) {
  const findings = [];
  for (const duration of hookDurations) {
    if (duration.basis !== 'evidence' || duration.durationMs === null) continue;
    if (duration.durationMs < LONG_HOOK_THRESHOLD_MS) continue;
    const minutes = Math.round(duration.durationMs / 60_000);
    findings.push(createFinding({
      category: FINDING_CATEGORY.OPTIONAL_SUGGESTION,
      code: 'LONG_HOOK_COST',
      fieldPath: `hooks.${duration.hookName}`,
      message: `hook "${duration.hookName}" 最近一次实际运行约 ${minutes} 分钟（来自受信运行证据）。长时间重复执行会拉长发布周期；cacheable/cacheInputs 需项目证明完整闭包、并等待 Foundation 0.11 能力发布后再评估，评估不会代写。`,
      evidence: { hookName: duration.hookName, durationMs: duration.durationMs, realRuns: duration.realRuns },
      action: '人工评估是否缩小输入范围、调整 testSelection 或拆分检查；不构成跳过完整测试或发布批准的依据。',
      severity: 'suggestion',
    }));
  }
  return findings;
}

const STATUS_LABEL = Object.freeze({
  NOT_CONFIGURED: '尚未配置',
  PARTIALLY_ADOPTED: '部分接入（存在必选缺口）',
  ADOPTED_WITH_SUGGESTIONS: '已接入（存在可选建议）',
  ADOPTED: '已接入（当前无建议）',
});

/**
 * Build the deterministic adoption report from prepared inputs.
 *
 * @param {Object} options
 * @param {Object} options.config - Loaded config.
 * @param {string} options.configPath - Absolute config path.
 * @param {string} options.configDigest - Config digest.
 * @param {Object} options.facts - discoverFacts() output.
 * @param {Array<Object>} options.findings - Combined findings (field-level
 *   gaps, satisfied/not-applicable entries, assess-derived findings,
 *   cost/check-only suggestions). Sorted before assembly.
 * @param {Array<Object>} options.hookDurations - deriveHookDurations output.
 * @param {Array<Object>} options.gateSuggestions - deriveGateSuggestions output.
 * @param {string} [options.next] - Precise next step.
 * @returns {Object} Frozen report.
 */
export function buildAssessmentReport({
  config,
  configPath,
  configDigest,
  facts,
  findings,
  hookDurations,
  gateSuggestions,
  next = null,
}) {
  const sortedFindings = [...findings].sort((a, b) => (
    (CATEGORY_RANK[a.category] ?? 9) - (CATEGORY_RANK[b.category] ?? 9)
    || a.code.localeCompare(b.code)
    || (a.fieldPath ?? '').localeCompare(b.fieldPath ?? '')
    || (a.unitId ?? '').localeCompare(b.unitId ?? '')
  ));
  const mandatoryCount = sortedFindings.filter((f) => f.category === FINDING_CATEGORY.MANDATORY_GAP).length;
  // Gate drafts are optional suggestions even though they live in their own
  // report section (they are never blocking and never change the adopted
  // band, mirroring deriveStatus' rules for optional-suggestion findings).
  const status = deriveStatus([
    ...sortedFindings,
    ...(gateSuggestions.length > 0 ? [{ category: FINDING_CATEGORY.OPTIONAL_SUGGESTION }] : []),
  ]);
  const topology = {
    type: 'unknown',
    releaseUnits: (config.releaseUnits ?? []).map((unit) => ({
      id: unit.id,
      source: unit.source,
      distributions: (unit.distributions ?? []).map((d) => d.type),
    })),
    distributions: [...new Set(
      (config.releaseUnits ?? []).flatMap((unit) => (unit.distributions ?? []).map((d) => d.type)),
    )].sort(),
  };
  const hasPlugin = topology.distributions.some((type) => type.endsWith('-plugin'));
  const mandatoryMet = mandatoryCount === 0;
  const workflowPrerequisites = {
    full: { met: mandatoryMet, note: 'workflow 分类由 release-route 的 diff 分类决定；此处只报告配置前提，不复制 diff 分类。' },
    docs: { met: mandatoryMet, note: 'docs-only 工作流的分类与裁剪由 release-route 决定；配置前提与 full 相同。' },
    config: { met: mandatoryMet, note: 'config 工作流除配置前提外还会裁剪 gate 集合；此处只报告配置前提。' },
    marketplace: {
      met: mandatoryMet && hasPlugin,
      note: hasPlugin ? '需要至少一个插件分发渠道，且该渠道的权威事实完整。' : '当前拓扑无插件分发渠道，不适用。',
    },
  };
  const unobserved = [{
    field: '远端前提（npm/GitHub 可用性、发布标签序列）',
    note: '评估默认离线，未观测远端；不能据此否定本地接入，也不代表具备生产发布条件。',
  }];

  const report = {
    command: 'release-setup',
    mode: 'adoption-assessment',
    status,
    configPath,
    configDigest,
    assessmentDigest: sha256Hex(canonicalJson({ configDigest, discoveryFacts: facts })),
    topology,
    findings: sortedFindings,
    hookDurations,
    gateSuggestions,
    workflowPrerequisites,
    unobserved,
    next,
    summary: renderSummary({ config, status, findings: sortedFindings, topology, hookDurations, gateSuggestions, next }),
  };
  return Object.freeze(report);
}

/**
 * Deterministic Chinese summary over the sorted findings.
 *
 * @param {Object} input
 * @returns {string}
 */
function renderSummary({ config, status, findings, topology, gateSuggestions, next }) {
  const lines = [];
  lines.push(`项目: ${config.project?.name ?? '(未命名)'}`);
  lines.push(`拓扑: ${topology.type}，发布单元 ${topology.releaseUnits.length} 个${topology.distributions.length > 0 ? `，分发渠道 ${topology.distributions.join(', ')}` : ''}`);
  lines.push(`接入状态: ${STATUS_LABEL[status] ?? status}`);
  const count = (category) => findings.filter((f) => f.category === category).length;
  lines.push(`必选缺口 ${count('mandatory-gap')} | 已满足 ${count('satisfied')} | 可选建议 ${count('optional-suggestion')} | 不适用 ${count('not-applicable')}`);
  const blocking = findings.filter((f) => f.category === FINDING_CATEGORY.MANDATORY_GAP);
  if (blocking.length > 0) {
    lines.push('阻断项:');
    for (const f of blocking) {
      lines.push(`  - [${f.code}] ${f.fieldPath ?? ''} ${f.message}`);
    }
  }
  const suggestions = findings.filter((f) => f.category === FINDING_CATEGORY.OPTIONAL_SUGGESTION);
  if (suggestions.length > 0) {
    lines.push('可选建议（不影响接入结论）:');
    for (const f of suggestions) {
      lines.push(`  - [${f.code}] ${f.fieldPath ?? ''} ${f.message}`);
    }
  }
  if (gateSuggestions.length > 0) {
    lines.push(`gate 候选建议 ${gateSuggestions.length} 条（需人工确认，未写入配置）`);
  }
  if (next) {
    lines.push(`下一步: ${next}`);
  }
  lines.push('注意: 评估默认离线且只读，未访问远端，未修改任何文件。');
  return lines.join('\n');
}
