import { claudeSandboxSettings } from './sandbox.ts';
import type { Policy, Rule } from './schema.ts';

// Paths the executor may never write, whatever the policy says: its own guardrails,
// CI, and the Maestro flows that grade its work.
export const PROTECTED_PATHS = ['.claude/**', '.rnship/**', '.github/**', 'smoke/**'];

export type ClaudeSettings = { permissions: { deny: string[]; ask: string[] } };

/** The guard plugin's ID when loaded with `--plugin-dir plugin/`. */
export const GUARD_PLUGIN_ID = 'rnship@inline';

// S2: the agent can write project, local, and user settings, and any of them can turn
// hooks off (`disableAllHooks`) or unload the guard plugin (`enabledPlugins`). Every
// executor run therefore passes this file as `--settings <file> --setting-sources user`;
// `--settings` beats every file the agent can write. Keep it outside the agent's home,
// owned by your user. See docs/adr/0002-executor-settings-file.md.
export type ExecutorSettings = ClaudeSettings & {
  disableAllHooks: false;
  enabledPlugins: Record<string, true>;
  env: { RNSHIP_HOOK_RULES: string };
  sandbox: ReturnType<typeof claudeSandboxSettings>;
};

export type CompiledPolicy = {
  /** Merge into the executor's user-level Claude settings. Deny wins from any scope. */
  settings: ClaudeSettings;
  /** Full rule set for the PreToolUse hook (plugin/hooks/guard.ts). */
  hookRules: Policy;
  /** Passed to every executor run with `--settings`. Undefined when no hook-rules path is given. */
  executorSettings?: ExecutorSettings;
  /** Optional, for the GitHub profile only. Undefined when no owner is given. */
  codeowners?: string;
};

// `require_approval` compiles to `ask`, which `claude -p` in dontAsk mode turns into a
// denial that the orchestrator maps to awaiting_approval.
export function compilePolicy(policy: Policy, opts: { codeowner?: string; hookRulesPath?: string } = {}): CompiledPolicy {
  const deny = new Set<string>(PROTECTED_PATHS.map((path) => `Edit(${path})`));
  const ask = new Set<string>();

  for (const rule of policy.rules) {
    const target = rule.effect === 'deny' ? deny : ask;
    for (const entry of permissionEntries(rule)) target.add(entry);
  }
  for (const entry of deny) ask.delete(entry);

  const settings = { permissions: { deny: [...deny], ask: [...ask] } };
  return {
    settings,
    hookRules: policy,
    executorSettings: opts.hookRulesPath
      ? {
          ...settings,
          disableAllHooks: false,
          enabledPlugins: { [GUARD_PLUGIN_ID]: true },
          env: { RNSHIP_HOOK_RULES: opts.hookRulesPath },
          sandbox: claudeSandboxSettings(),
        }
      : undefined,
    codeowners: opts.codeowner ? codeowners(policy, opts.codeowner) : undefined,
  };
}

function permissionEntries(rule: Rule): string[] {
  const commands = rule.match.commands.map((command) => `Bash(${command})`);
  const files = rule.match.files.flatMap((glob) =>
    rule.effect === 'deny' ? [`Read(${glob})`, `Edit(${glob})`] : [`Edit(${glob})`],
  );
  return [...commands, ...files];
}

function codeowners(policy: Policy, owner: string): string {
  const globs = [...PROTECTED_PATHS, ...policy.rules.flatMap((rule) => rule.match.files), 'package.json', 'app.config.*', 'app.json'];
  return [...new Set(globs)].map((glob) => `${glob.startsWith('**/') ? glob.slice(3) : `/${glob}`} ${owner}`).join('\n') + '\n';
}
