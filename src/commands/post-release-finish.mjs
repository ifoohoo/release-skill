import { realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, normalize, resolve } from 'node:path';

import { readFileStrict } from 'skill-family-harness-node';

import { loadProjectConfig } from '../core/config.mjs';
import {
  derivePostReleaseChecklist,
  runLocalFinishCommand,
  updateLocalHostPlugins,
} from './post-release-local.mjs';

const STEP_STATUSES = new Set(['COMPLETE', 'PENDING', 'FAILED', 'SKIPPED']);
const FEEDBACK_FIELDS = new Set(['planDigest', 'configDigest', 'projectRoot', 'merge', 'hosts', 'setup']);
const MERGE_FIELDS = new Set(['outcome', 'summary']);
const HOST_FIELDS = new Set(['unitId', 'host', 'installation', 'loaded', 'plugin', 'version', 'skillFile', 'summary']);
const SETUP_FIELDS = new Set(['host', 'unitId', 'skillFile', 'outcome', 'summary']);

function fail(message) {
  const error = new Error(message);
  error.code = 'POST_RELEASE_FINISH_INVALID';
  error.exitCode = 1;
  throw error;
}

function assertPlainObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object`);
}

function assertClosed(value, allowed, label) {
  assertPlainObject(value, label);
  const unknown = Object.keys(value).filter((field) => !allowed.has(field));
  if (unknown.length > 0) fail(`${label} contains unknown fields: ${unknown.join(', ')}`);
}

function nonEmptyString(value, label) {
  if (typeof value !== 'string' || value.trim().length === 0) fail(`${label} must be a non-empty string`);
  return value;
}

function normalizedAbsolutePath(value, label) {
  nonEmptyString(value, label);
  if (!isAbsolute(value) || normalize(value) !== value) fail(`${label} must be a normalized absolute path`);
  return value;
}

async function readFeedback(feedbackPath) {
  if (feedbackPath === undefined) return null;
  normalizedAbsolutePath(feedbackPath, 'finish feedback path');
  let receipt;
  try {
    receipt = await readFileStrict(dirname(feedbackPath), basename(feedbackPath), { encoding: 'utf8' });
  } catch (cause) {
    fail(`cannot strictly read finish feedback: ${cause.message}`);
  }
  let value;
  try {
    value = JSON.parse(receipt.content);
  } catch (cause) {
    fail(`finish feedback is not valid JSON: ${cause.message}`);
  }
  return value;
}

function targetKey(unitId, host) {
  return `${unitId}\u0000${host}`;
}

function validateFeedback(raw, { projectRoot, planDigest, configDigest, selectedTargets, setupSkill }) {
  if (raw === null) return { merge: null, hosts: [], setup: null };
  assertClosed(raw, FEEDBACK_FIELDS, 'finish feedback');
  for (const field of ['planDigest', 'configDigest', 'projectRoot']) nonEmptyString(raw[field], `finish feedback.${field}`);
  if (raw.planDigest !== planDigest) fail('finish feedback planDigest does not match the frozen plan');
  if (raw.configDigest !== configDigest) fail('finish feedback configDigest does not match the current project configuration');
  if (normalizedAbsolutePath(raw.projectRoot, 'finish feedback.projectRoot') !== projectRoot) {
    fail('finish feedback projectRoot does not match the current project root');
  }

  let merge = null;
  if (raw.merge !== undefined) {
    assertClosed(raw.merge, MERGE_FIELDS, 'finish feedback.merge');
    if (!['completed', 'skipped', 'pending'].includes(raw.merge.outcome)) fail('finish feedback.merge.outcome is invalid');
    nonEmptyString(raw.merge.summary, 'finish feedback.merge.summary');
    merge = { ...raw.merge, basis: 'agent-reported' };
  }

  const targetsByKey = new Map(selectedTargets.map((target) => [targetKey(target.unitId, target.host), target]));
  const hosts = [];
  const seen = new Set();
  if (raw.hosts !== undefined && !Array.isArray(raw.hosts)) fail('finish feedback.hosts must be an array');
  for (const [index, host] of (raw.hosts ?? []).entries()) {
    assertClosed(host, HOST_FIELDS, `finish feedback.hosts[${index}]`);
    for (const field of ['unitId', 'host', 'plugin', 'version', 'summary']) {
      nonEmptyString(host[field], `finish feedback.hosts[${index}].${field}`);
    }
    if (!['current', 'pending', 'failed'].includes(host.installation)) fail(`finish feedback.hosts[${index}].installation is invalid`);
    if (typeof host.loaded !== 'boolean') fail(`finish feedback.hosts[${index}].loaded must be boolean`);
    if (host.installation !== 'current' && host.loaded) fail(`finish feedback.hosts[${index}] cannot be loaded unless installation is current`);
    if (host.skillFile !== undefined) normalizedAbsolutePath(host.skillFile, `finish feedback.hosts[${index}].skillFile`);
    const key = targetKey(host.unitId, host.host);
    if (seen.has(key)) fail(`finish feedback contains duplicate host result for ${host.unitId}/${host.host}`);
    seen.add(key);
    const target = targetsByKey.get(key);
    if (!target) fail(`finish feedback host ${host.unitId}/${host.host} is outside the selected frozen targets`);
    if (host.plugin !== target.plugin || host.version !== target.version) {
      fail(`finish feedback host ${host.unitId}/${host.host} does not match the frozen plugin identity`);
    }
    hosts.push({ ...host, basis: 'agent-reported' });
  }

  let setup = null;
  if (raw.setup !== undefined) {
    if (!setupSkill) fail('finish feedback.setup is not allowed when releaseFinish.setupSkill is not configured');
    assertClosed(raw.setup, SETUP_FIELDS, 'finish feedback.setup');
    for (const field of ['host', 'unitId', 'skillFile', 'summary']) nonEmptyString(raw.setup[field], `finish feedback.setup.${field}`);
    normalizedAbsolutePath(raw.setup.skillFile, 'finish feedback.setup.skillFile');
    if (!['completed', 'pending', 'failed'].includes(raw.setup.outcome)) fail('finish feedback.setup.outcome is invalid');
    const host = hosts.find((entry) => entry.host === raw.setup.host && entry.unitId === raw.setup.unitId);
    if (!host || host.installation !== 'current' || host.loaded !== true || host.skillFile !== raw.setup.skillFile) {
      fail('finish feedback.setup is not bound to one selected, current, loaded host and matching skillFile');
    }
    setup = { ...raw.setup, basis: 'agent-reported' };
  }
  return { merge, hosts, setup };
}

function step(status, summary, extra = {}) {
  if (!STEP_STATUSES.has(status)) throw new Error(`unknown finish step status: ${status}`);
  return { status, summary, ...extra };
}

function resultToInstallation(result, target) {
  if (!result) return null;
  if (['UPDATED', 'ALREADY_CURRENT'].includes(result.status) && result.version !== target.version) {
    return {
      unitId: target.unitId, host: target.host, plugin: target.plugin, version: target.version,
      installation: 'failed', loaded: false,
      summary: `宿主更新结果版本 ${result.version ?? '(missing)'} 与冻结版本 ${target.version} 不一致。`,
      basis: 'script-observed', updateStatus: result.status,
    };
  }
  if (['UPDATED', 'ALREADY_CURRENT'].includes(result.status)) {
    return {
      unitId: target.unitId,
      host: target.host,
      plugin: target.plugin,
      version: target.version,
      installation: 'current',
      loaded: false,
      summary: result.status === 'UPDATED'
        ? '脚本已更新并复验安装载荷；仍需由当前智能体确认宿主实际加载。'
        : '脚本已确认安装载荷与冻结版本一致；仍需由当前智能体确认宿主实际加载。',
      basis: 'script-observed',
      updateStatus: result.status,
      ...(result.restartRequired ? { restartRequired: true } : {}),
    };
  }
  return {
    unitId: target.unitId,
    host: target.host,
    plugin: target.plugin,
    version: target.version,
    installation: result.status === 'FAILED' ? 'failed' : 'pending',
    loaded: false,
    summary: result.reason ?? result.error ?? `宿主更新结果为 ${result.status}。`,
    basis: 'script-observed',
    updateStatus: result.status,
  };
}

function gitReadEnvironment() {
  const env = { GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' };
  for (const key of ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL']) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return env;
}

async function observeGitCommand({ root, args, run }) {
  const argv = ['git', ...args];
  try {
    const result = await run('git', args, { cwd: root, env: gitReadEnvironment() });
    return { argv, status: 'SUCCEEDED', exitStatus: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (cause) {
    return {
      argv,
      status: 'FAILED',
      exitStatus: cause?.exitStatus ?? cause?.code ?? null,
      stdout: cause?.stdout ?? cause?.foundationStdout ?? '',
      stderr: cause?.stderr ?? cause?.foundationStderr ?? '',
      message: cause?.message ?? String(cause),
    };
  }
}

async function inspectSourceBranch({ root, config, run }) {
  const policy = config.releaseFinish?.sourceBranchCheck ?? 'remind';
  const targetBranch = config.project.defaultBranch;
  if (policy === 'skip') {
    return step('SKIPPED', '项目配置已关闭源码分支检查。', { policy, targetBranch, basis: 'script-observed' });
  }
  const branchResult = await observeGitCommand({ root, args: ['branch', '--show-current'], run });
  const statusResult = await observeGitCommand({ root, args: ['status', '--short', '--branch'], run });
  const commands = [branchResult, statusResult];
  if (commands.some((command) => command.status === 'FAILED')) {
    return step('FAILED', '源码分支只读检查至少一条 Git 命令失败。', {
      policy, targetBranch, commands, basis: 'script-observed',
    });
  }
  try {
    const currentBranch = branchResult.stdout.trim();
    const lines = statusResult.stdout.replace(/\r/gu, '').split('\n').filter(Boolean);
    const tracking = lines[0]?.startsWith('## ') ? lines[0].slice(3) : '';
    const changed = (lines[0]?.startsWith('## ') ? lines.slice(1) : lines).length > 0;
    const detached = currentBranch.length === 0;
    const aligned = !detached && currentBranch === targetBranch;
    return step('COMPLETE', detached
      ? '已完成只读检查；当前为 detached HEAD，未猜测后续 Git 操作。'
      : aligned
        ? `已完成只读检查；当前分支为目标分支 ${targetBranch}。`
        : `已完成只读检查；当前分支 ${currentBranch} 与目标分支 ${targetBranch} 不同。`, {
      policy,
      targetBranch,
      currentBranch: detached ? null : currentBranch,
      detached,
      aligned,
      changed,
      tracking: tracking || null,
      rawStatus: statusResult.stdout,
      commands,
      basis: 'script-observed',
    });
  } catch (cause) {
    return step('FAILED', `源码分支只读检查失败：${cause.message}`, {
      policy, targetBranch, commands, basis: 'script-observed',
    });
  }
}

function finishStatus(steps) {
  const statuses = Object.values(steps).map((entry) => entry.status);
  if (statuses.includes('FAILED')) return 'FAILED';
  if (statuses.includes('PENDING')) return 'PENDING';
  return 'COMPLETE';
}

export async function runPostReleaseFinish({
  root = process.cwd(),
  plan,
  planPath,
  runPath,
  selectedHosts = [],
  updateRequested = false,
  skipLocalHosts = false,
  confirmPlanDigest,
  cursorPluginsRoot,
  feedbackPath,
  updateLocalHostPluginsFn = updateLocalHostPlugins,
  run = runLocalFinishCommand,
} = {}) {
  const projectRoot = await realpath(resolve(root));
  const loaded = await loadProjectConfig({ root: projectRoot });
  const checklist = derivePostReleaseChecklist(plan, {
    root: projectRoot,
    planPath,
    runPath,
    postVerifyComplete: true,
  });
  const selected = new Set(selectedHosts);
  const unknownHosts = [...selected].filter((host) => !checklist.localHostUpdate.hosts.includes(host));
  if (unknownHosts.length > 0) fail(`selected hosts are not declared by the plan: ${unknownHosts.join(', ')}`);
  const selectedTargets = checklist.localHostUpdate.targets.filter((target) => selected.has(target.host));
  const feedback = validateFeedback(await readFeedback(feedbackPath), {
    projectRoot,
    planDigest: plan.digest,
    configDigest: loaded.configDigest,
    selectedTargets,
    setupSkill: loaded.config.releaseFinish?.setupSkill,
  });

  let update = null;
  if (updateRequested) {
    update = await updateLocalHostPluginsFn({
      planPath,
      runPath,
      root: projectRoot,
      confirmPlanDigest,
      selectedHosts,
      cursorPluginsRoot,
    });
  }

  const nextActions = [];
  let mergeStep;
  if (!checklist.merge.promptRequired) {
    mergeStep = step('COMPLETE', '发布流程已覆盖分支推进，无需额外合并决定。', { basis: 'script-observed' });
  } else if (!feedback.merge) {
    mergeStep = step('PENDING', '尚未提供剩余发布分支的处理结果。');
    nextActions.push({ type: 'decide-merge', units: checklist.merge.units });
  } else {
    const status = feedback.merge.outcome === 'completed' ? 'COMPLETE'
      : feedback.merge.outcome === 'skipped' ? 'SKIPPED' : 'PENDING';
    mergeStep = step(status, feedback.merge.summary, { basis: feedback.merge.basis, outcome: feedback.merge.outcome });
    if (status === 'PENDING') nextActions.push({ type: 'decide-merge', units: checklist.merge.units });
  }

  const observations = [];
  const feedbackByKey = new Map(feedback.hosts.map((entry) => [targetKey(entry.unitId, entry.host), entry]));
  const updateByKey = new Map((update?.results ?? []).map((entry) => [targetKey(entry.unitId, entry.host), entry]));
  const updateKeepsFeedback = !updateRequested || selectedTargets.every((target) => {
    const result = updateByKey.get(targetKey(target.unitId, target.host));
    return result?.status === 'ALREADY_CURRENT' && result.version === target.version;
  });
  for (const target of selectedTargets) {
    const reported = feedbackByKey.get(targetKey(target.unitId, target.host));
    const updateResult = updateByKey.get(targetKey(target.unitId, target.host));
    const scriptObservation = resultToInstallation(updateResult, target);
    if (!scriptObservation) {
      if (reported) observations.push(reported);
      continue;
    }
    if (scriptObservation.installation === 'current'
      && scriptObservation.updateStatus === 'ALREADY_CURRENT'
      && reported?.installation === 'current') {
      observations.push({
        ...scriptObservation,
        loaded: reported.loaded,
        ...(reported.skillFile ? { skillFile: reported.skillFile } : {}),
        loadSummary: reported.summary,
        loadBasis: 'agent-reported',
      });
    } else {
      observations.push(scriptObservation);
    }
  }

  let hostUpdateStep;
  let hostLoadStep;
  const hasTargets = checklist.localHostUpdate.targets.length > 0;
  if (skipLocalHosts) {
    hostUpdateStep = step('SKIPPED', '调用者已明确跳过本轮宿主更新。');
    hostLoadStep = step('SKIPPED', '本轮跳过宿主更新，因此不检查目标插件加载。');
  } else if (!hasTargets) {
    hostUpdateStep = step('SKIPPED', '冻结计划没有适用的本机宿主目标。');
    hostLoadStep = step('SKIPPED', '没有适用的宿主加载目标。');
  } else if (selectedTargets.length === 0) {
    hostUpdateStep = step('PENDING', '尚未选择本轮要处理的宿主。', { availableHosts: checklist.localHostUpdate.hosts });
    hostLoadStep = step('PENDING', '需先选择宿主并确认安装结果。');
    nextActions.push({ type: 'choose-local-hosts', hosts: checklist.localHostUpdate.hosts, targets: checklist.localHostUpdate.targets });
  } else {
    const failed = observations.filter((entry) => entry.installation === 'failed');
    const current = observations.filter((entry) => entry.installation === 'current');
    const missing = selectedTargets.filter((target) => !observations.some((entry) => entry.unitId === target.unitId && entry.host === target.host));
    const pending = observations.filter((entry) => entry.installation === 'pending');
    hostUpdateStep = step(failed.length > 0 ? 'FAILED' : (missing.length > 0 || pending.length > 0 ? 'PENDING' : 'COMPLETE'),
      failed.length > 0 ? '至少一个所选宿主的安装或更新失败。'
        : missing.length > 0 || pending.length > 0 ? '部分所选宿主缺少安装结果或仍待处理。'
          : '所选宿主的安装均已确认为目标版本。',
      { observations });
    const unloaded = observations.filter((entry) => entry.installation === 'current' && entry.loaded !== true);
    const loadedHosts = observations.filter((entry) => entry.installation === 'current' && entry.loaded === true);
    hostLoadStep = step(failed.length > 0 ? 'FAILED' : (loadedHosts.length !== selectedTargets.length ? 'PENDING' : 'COMPLETE'),
      failed.length > 0 ? '宿主安装失败，无法完成加载确认。'
        : loadedHosts.length !== selectedTargets.length ? '尚未确认全部所选宿主已实际加载目标插件和入口。'
          : '当前智能体已报告全部所选宿主加载目标入口。',
      { observations });
    if (missing.length > 0 || pending.length > 0) nextActions.push({ type: 'observe-host-installation', targets: [...missing, ...pending] });
    if (unloaded.length > 0) nextActions.push({ type: 'check-host-load', projectRoot, observations: unloaded });
  }

  const setupSkill = loaded.config.releaseFinish?.setupSkill;
  const candidates = observations.filter((entry) => (
    entry.installation === 'current' && entry.loaded === true && typeof entry.skillFile === 'string'
  ));
  const candidateOwners = new Set(candidates.map((entry) => `${entry.plugin}\u0000${entry.version}\u0000${entry.skillFile}`));
  const effectiveSetup = updateKeepsFeedback ? feedback.setup : null;
  let setupStep;
  if (!setupSkill) {
    setupStep = step('SKIPPED', '项目未配置 releaseFinish.setupSkill。');
  } else if (skipLocalHosts) {
    setupStep = step('SKIPPED', '调用者已明确跳过宿主更新和加载，本轮不执行 setup。', { setupSkill });
  } else if (candidateOwners.size > 1) {
    setupStep = step('PENDING', `目标入口 ${setupSkill} 存在多个插件身份归属，不能用单个 setup 反馈完整收尾。`, {
      setupSkill, candidates,
    });
    nextActions.push({ type: 'disambiguate-setup', setupSkill, projectRoot, candidates });
  } else if (effectiveSetup) {
    const status = effectiveSetup.outcome === 'completed' ? 'COMPLETE'
      : effectiveSetup.outcome === 'failed' ? 'FAILED' : 'PENDING';
    setupStep = step(status, effectiveSetup.summary, {
      setupSkill,
      result: effectiveSetup,
      basis: 'agent-reported',
    });
    if (status === 'PENDING') nextActions.push({ type: 'invoke-setup', setupSkill, projectRoot, resume: effectiveSetup });
  } else {
    setupStep = step('PENDING', candidates.length > 0
      ? `目标入口 ${setupSkill} 已有可用宿主，但未收到实际 setup 结果。`
      : `目标入口 ${setupSkill} 尚缺可用的已加载宿主与技能元数据。`, { setupSkill, candidates });
    if (candidates.length > 0) {
      nextActions.push({
        type: 'invoke-setup',
        setupSkill,
        projectRoot,
        intent: 'read-only-diagnosis',
        authorization: 'No new write authority is granted by this request.',
        candidates: candidates.map((entry) => ({
          unitId: entry.unitId,
          host: entry.host,
          plugin: entry.plugin,
          version: entry.version,
          skillFile: entry.skillFile,
        })),
        hostObservations: observations,
      });
    } else {
      nextActions.push({
        type: 'resolve-setup-target',
        setupSkill,
        projectRoot,
        reason: hasTargets ? 'no-loaded-candidates' : 'no-host-targets',
        targets: checklist.localHostUpdate.targets,
      });
    }
  }

  const sourceBranchStep = await inspectSourceBranch({ root: projectRoot, config: loaded.config, run });
  const steps = {
    merge: mergeStep,
    'host-update': hostUpdateStep,
    'host-load': hostLoadStep,
    setup: setupStep,
    'source-branch': sourceBranchStep,
  };
  return {
    command: 'post-release',
    ...(update ? { operation: 'finish-with-local-host-update', localHostUpdate: update } : { checklist }),
    finish: {
      status: finishStatus(steps),
      projectRoot,
      planDigest: plan.digest,
      configDigest: loaded.configDigest,
      steps,
      nextActions,
      releaseStatusChanged: false,
    },
  };
}
