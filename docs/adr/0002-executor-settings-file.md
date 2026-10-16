# 0002: Every executor run carries an orchestrator-owned settings file

Date: 2026-10-14. Status: accepted.

## Context
S2 (`docs/spikes/S2.md`) showed that the guard plugin's `PreToolUse` hook blocks `eas submit` under `--dangerously-skip-permissions` and `dontAsk`, and that `onFailure: "block"` holds on a timeout. The same spike also showed that an agent running as the executor can switch enforcement off:
- writing `{"disableAllHooks": true}` to `.claude/settings.json` takes effect mid-session (the file is hot-reloaded), and a file left by an earlier task takes effect at startup
- `enabledPlugins: {"rnship@inline": false}` in project settings unloads a `--plugin-dir` plugin, with no error

The agent runs as the same OS user as its own Claude settings, so it can also write user settings. It can't change the command line of the *next* run.

## Decision
- `rnship policy compile` writes `executor-settings.json`. It contains:
  - `disableAllHooks: false` and `enabledPlugins: {"rnship@inline": true}`
  - the compiled `permissions` (deny and ask), plus `allow` for the tools a task needs, scoped to the session's cwd (`Edit(./**)`, `Read(./**)`, `Bash`, `Glob`, `Grep`, `Skill`). Sessions run `--permission-mode dontAsk`, which denies any call no allow rule covers, so without these every write and Bash call is denied (M3, 2026-10-16). Edits are never allowed bare, and `Edit(~/.claude/**)` is denied: `--setting-sources user` still loads the agent's user settings, and their arrays merge into these.
  - `env.RNSHIP_HOOK_RULES`, set to the absolute path of `hook-rules.json`
  - a locked Bash `sandbox` (`allowUnsandboxedCommands: false`, `failIfUnavailable: true`, secret and persistence path denies, and a network allowlist from `policy/src/sandbox.ts`)
- Every executor adapter runs Claude with `--plugin-dir <repo>/plugin --settings <executor-settings.json> --setting-sources user`.
  - **ralphex:** its `claude_args` splitter strips quotes, so the file form is required, never inline JSON. Its plan file sits outside the worktree, so `claude_args` also carries `--allowedTools Read(//<plan>),Edit(//<plan>)` for that one file, never its directory, which holds the ralphex config and its `claude_command`.
- The settings file and `hook-rules.json` live outside the agent's home. They're owned by the human user and readable by `rnship-agent`.
- The adapter fails the run (`crashed: plugin_missing`) unless `system/init.plugins` lists `rnship` and `plugin_errors` is empty.
- The guard fails closed. A missing `RNSHIP_HOOK_RULES`, unreadable rules, bad stdin, or a crash all exit 2.

## Consequences
- Hooks stay early feedback (D1). `rnship policy check` and identity separation remain the gate, and `rnship policy check` flags any `.claude/**` change in the worktree.
- If a Claude Code release stops passing settings `env` to hook processes, the guard blocks every call. That breaks loudly, never silently, and the S2 harness catches it on upgrade.
- Re-run the S2 harness after every Claude Code upgrade.
