import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, matchesGlob } from 'node:path';
import { capabilityVocabulary, PROTECTED_PATHS, type Policy, type Suitability } from '@rnship/policy';
import { findApproval, stateDir, type Baseline } from '@rnship/release';
import { parseAllDocuments, stringify } from 'yaml';
import { parseTasks, type TasksFile } from '../tasks.ts';
import { changeDigest, checkRequest, FILES, IntakeError, loadDelta, loadImpact, loadRequest, loadScreens } from './folder.ts';
import { deltaIsEmpty, impactGate } from './impact.ts';
import { designPrompt, proposePrompt, tasksPrompt } from './prompts.ts';
import { PlanSchema, ProposalSchema, SMOKE_COMMANDS, ScreensSchema, type BaselineDelta, type ChangeRequest, type Impact, type Plan, type Screens } from './schema.ts';
import type { StageRunner } from './stage.ts';

// `rnship change intake` (A1–A4) and `rnship change tasks` (A5). Stages that lint their
// answer get one retry with the problems listed, then go back to you (design §2).

type Env = Record<string, string | undefined>;

export type IntakeInput = {
  dir: string;
  repo: string;
  policy: Policy;
  suitability: Suitability;
  baseline: Baseline;
  packageDeps: Record<string, string>;
  bundled?: Record<string, string>;
  run: StageRunner;
};

export type IntakeReport = { change: string; digest: string; verdict: Impact['verdict']; impact: Impact; delta: BaselineDelta; baselineApprovalNeeded: boolean };

export async function runIntake(input: IntakeInput): Promise<IntakeReport> {
  const request = loadRequest(input.dir);
  const problems = checkRequest(request, input.repo);
  if (problems.length > 0) throw new IntakeError(`change ${request.id} needs your fixes:\n- ${problems.join('\n- ')}`);

  const proposal = await input.run(
    'propose',
    proposePrompt({ request, vocabulary: capabilityVocabulary(input.suitability), baselineDeps: input.baseline.dependencies, packageDeps: input.packageDeps }),
    ProposalSchema,
  );
  const { impact, delta } = impactGate({ proposal, baseline: input.baseline, packageDeps: input.packageDeps, policy: input.policy, suitability: input.suitability, bundled: input.bundled });
  writeFileSync(join(input.dir, FILES.impact), JSON.stringify(impact, null, 2) + '\n');
  writeFileSync(join(input.dir, FILES.delta), stringify(delta));

  const screensPath = join(input.dir, FILES.screens);
  if (impact.verdict === 'stop') {
    rmSync(screensPath, { force: true });
  } else {
    const screens = await withRetry(designPrompt({ request, impact }), (prompt) => input.run('design', prompt, ScreensSchema), (s) => lintScreens(s, request));
    writeFileSync(screensPath, stringify(screens));
  }
  return { change: request.id, digest: changeDigest(input.dir), verdict: impact.verdict, impact, delta, baselineApprovalNeeded: !deltaIsEmpty(delta) };
}

async function withRetry<T>(prompt: string, ask: (prompt: string) => Promise<T>, lint: (value: T) => string[]): Promise<T> {
  let problems: string[] = [];
  for (const attempt of [1, 2]) {
    const value = await ask(attempt === 1 ? prompt : `${prompt}\nYour previous answer had these problems; fix them:\n${problems.map((p) => `- ${p}`).join('\n')}\n`);
    problems = lint(value);
    if (problems.length === 0) return value;
  }
  throw new IntakeError(`the answer still fails its checks after a retry; take over:\n- ${problems.join('\n- ')}`);
}

export function lintScreens(screens: Screens, request: ChangeRequest): string[] {
  const ids = new Set(request.acceptance_criteria.map((ac) => ac.id));
  const covered = new Set(screens.routes.flatMap((r) => r.acceptance_criteria));
  return [
    ...[...covered].filter((id) => !ids.has(id)).map((id) => `a route names unknown acceptance criterion ${id}`),
    ...[...ids].filter((id) => !covered.has(id)).map((id) => `acceptance criterion ${id} has no route`),
  ];
}

// --- A5 ---------------------------------------------------------------------------

export type ScopeCheck = { ok: true; digest: string; approvedBy: string } | { ok: false; digest: string; reason: string };

/** Is the change folder, exactly as it is now, approved through `rnship change approve`? */
export function scopeApproved(dir: string, repo: string, env: Env = process.env): ScopeCheck {
  const request = loadRequest(dir);
  const digest = changeDigest(dir);
  const approval = findApproval(stateDir(repo, env), 'change', digest, env);
  if (!approval.ok) return { ok: false, digest, reason: `change ${request.id} at ${digest} isn't approved (${approval.reason}); edited after approval?` };
  if (approval.record.subject !== request.id) return { ok: false, digest, reason: `the approval of ${digest} is for change ${approval.record.subject}, not ${request.id}` };
  return { ok: true, digest, approvedBy: approval.record.approved_by.user };
}

export type PlanInput = { dir: string; repo: string; run: StageRunner; validation: string[]; appId: string; env?: Env };
export type PlanReport = { change: string; digest: string; tasksPath: string; flows: string[]; file: TasksFile };

export async function planChange(input: PlanInput): Promise<PlanReport> {
  const scope = scopeApproved(input.dir, input.repo, input.env);
  if (!scope.ok) throw new IntakeError(`A5 refuses: ${scope.reason}`);
  const request = loadRequest(input.dir);
  const impact = loadImpact(input.dir);
  const screens = loadScreens(input.dir);
  if (impact?.verdict === 'stop') throw new IntakeError(`change ${request.id} was stopped by ${impact.rule_hits.filter((h) => h.effect === 'stop').map((h) => h.ruleId).join(', ')}`);
  if (!impact || !screens) throw new IntakeError(`change ${request.id} has no impact.json or screens.yaml; run rnship change intake first`);

  const plan = await withRetry(tasksPrompt({ request, impact, screens }), (prompt) => input.run('tasks', prompt, PlanSchema), (p) => lintPlan(p, request, input.appId));
  const file = tasksFile(plan, { id: request.id, digest: scope.digest }, input.validation);
  const out = join(input.dir, FILES.tasksDir);
  rmSync(out, { recursive: true, force: true });
  mkdirSync(join(out, 'smoke'), { recursive: true });
  const tasksPath = join(out, 'tasks.yaml');
  writeFileSync(tasksPath, stringify(file));
  for (const flow of plan.flows) writeFileSync(join(out, 'smoke', `${flow.name}.yaml`), renderFlow(input.appId, flow));
  // The tasks file must pass the same parse `rnship tasks import` runs.
  parseTasks(readFileSync(tasksPath, 'utf8'));
  return { change: request.id, digest: scope.digest, tasksPath, flows: plan.flows.map((f) => f.name), file };
}

function tasksFile(plan: Plan, change: { id: string; digest: string } | undefined, validation: string[]): TasksFile {
  return {
    version: 1,
    ...(change ? { change } : {}),
    tasks: plan.tasks.map((t) => ({
      id: t.id,
      title: t.title,
      tier: t.tier,
      deps: t.deps,
      files: t.files,
      validation,
      native: t.native,
      body: t.body,
      acceptance_criteria: t.acceptance_criteria,
      smoke_flows: t.smoke_flows,
      risk: t.risk,
    })),
  };
}

export function lintPlan(plan: Plan, request: ChangeRequest, appId = 'com.example.app'): string[] {
  const problems: string[] = [];
  const acs = new Set(request.acceptance_criteria.map((ac) => ac.id));
  const flows = new Map(plan.flows.map((f) => [f.name, f]));
  try {
    parseTasks(stringify(tasksFile(plan, undefined, ['true'])));
  } catch (error) {
    problems.push(error instanceof Error ? error.message : String(error));
  }
  for (const task of plan.tasks) {
    for (const ac of task.acceptance_criteria) if (!acs.has(ac)) problems.push(`task ${task.id} names unknown acceptance criterion ${ac}`);
    for (const name of task.smoke_flows) if (!flows.has(name)) problems.push(`task ${task.id} names unknown flow ${name}`);
    for (const file of task.files) {
      if (PROTECTED_PATHS.some((glob) => matchesGlob(file, glob) || matchesGlob(`${file}/x`, glob))) problems.push(`task ${task.id} may not touch protected path ${file}`);
    }
  }
  const covered = new Set(plan.tasks.flatMap((t) => t.acceptance_criteria));
  for (const ac of acs) if (!covered.has(ac)) problems.push(`acceptance criterion ${ac} has no task`);
  const checked = new Set(plan.flows.flatMap((f) => f.acceptance_criteria));
  for (const ac of request.acceptance_criteria) if (ac.user_facing && !checked.has(ac.id)) problems.push(`user-facing acceptance criterion ${ac.id} has no smoke flow`);
  const names = new Set<string>();
  for (const flow of plan.flows) {
    if (names.has(flow.name)) problems.push(`flow ${flow.name} is listed twice`);
    names.add(flow.name);
    for (const ac of flow.acceptance_criteria) if (!acs.has(ac)) problems.push(`flow ${flow.name} names unknown acceptance criterion ${ac}`);
    if (flow.steps[0]?.command !== 'launchApp') problems.push(`flow ${flow.name} must start with launchApp`);
    flow.steps.forEach((step, i) => {
      const needsTarget = step.command !== 'launchApp' && step.command !== 'back';
      if (needsTarget && !step.text && !step.id) problems.push(`flow ${flow.name} step ${i + 1} (${step.command}) needs text or id`);
      if (step.command === 'inputText' && !step.text) problems.push(`flow ${flow.name} step ${i + 1} (inputText) needs text`);
    });
    problems.push(...checkFlow(renderFlow(appId, flow)).map((p) => `flow ${flow.name}: ${p}`));
  }
  return problems;
}

// --- Maestro flows ------------------------------------------------------------------

/** A Maestro flow file: a config document with appId, then the command list. */
export function renderFlow(appId: string, flow: Plan['flows'][number]): string {
  const commands = flow.steps.map((step) => {
    if (step.command === 'launchApp' || step.command === 'back') return step.command;
    if (step.command === 'inputText') return { inputText: step.text! };
    return { [step.command]: step.id ? { id: step.id } : { text: step.text! } };
  });
  return `${stringify({ appId, name: flow.name })}---\n${stringify(commands)}`;
}

/** Structural parse of a Maestro flow: problems, or [] when it parses. Doesn't need Maestro installed. */
export function checkFlow(text: string): string[] {
  const docs = parseAllDocuments(text);
  if (!Array.isArray(docs)) return ['not YAML documents'];
  const errors = docs.flatMap((d) => d.errors.map((e) => e.message));
  if (errors.length > 0) return errors;
  if (docs.length !== 2) return [`expected a config document and a command list, found ${docs.length} document(s)`];
  const config = docs[0]!.toJS() as unknown;
  const commands = docs[1]!.toJS() as unknown;
  const problems: string[] = [];
  if (typeof (config as { appId?: unknown })?.appId !== 'string') problems.push('the config document has no appId');
  if (!Array.isArray(commands) || commands.length === 0) return [...problems, 'the command list is empty'];
  commands.forEach((command, i) => {
    const name = typeof command === 'string' ? command : typeof command === 'object' && command !== null && Object.keys(command).length === 1 ? Object.keys(command)[0] : undefined;
    if (!name || !(SMOKE_COMMANDS as readonly string[]).includes(name)) problems.push(`command ${i + 1} isn't one of ${SMOKE_COMMANDS.join(', ')}`);
  });
  return problems;
}

/** Problems with the change folder as `rnship change status` shows them. */
export function changeStatus(dir: string, repo: string, env: Env = process.env) {
  const request = loadRequest(dir);
  const impact = loadImpact(dir);
  const delta = loadDelta(dir);
  const scope = scopeApproved(dir, repo, env);
  return {
    change: request.id,
    digest: scope.digest,
    intake: impact ? (impact.verdict === 'stop' || loadScreens(dir) ? 'done' : 'partial') : 'not run',
    verdict: impact?.verdict,
    rule_hits: impact?.rule_hits ?? [],
    install: impact?.install ?? [],
    baseline_delta: delta,
    approved: scope.ok ? `by ${scope.approvedBy}` : scope.reason,
    tasks: existsSync(join(dir, FILES.tasksDir, 'tasks.yaml')) ? join(dir, FILES.tasksDir, 'tasks.yaml') : undefined,
  };
}
