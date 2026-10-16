import { describe, expect, it } from 'vitest';
import { evaluateToolCall, loadBasePolicy, parseCommand } from '../src/index.ts';

const policy = loadBasePolicy();
const CWD = '/work/app';

const bash = (command: string) => evaluateToolCall(policy, { tool_name: 'Bash', tool_input: { command }, cwd: CWD });
const edit = (file_path: string, tool_name = 'Edit') => evaluateToolCall(policy, { tool_name, tool_input: { file_path }, cwd: CWD });

describe('parseCommand', () => {
  const words = (command: string) => {
    const parsed = parseCommand(command);
    if (!parsed.ok) throw new Error(parsed.error);
    return parsed.commands.map((c) => c.words.join(' '));
  };

  it('splits pipelines and lists and keeps quoted words whole', () => {
    expect(words(`echo "a; b" && eas whoami | cat; ls`)).toEqual(['echo a; b', 'eas whoami', 'cat', 'ls']);
  });

  it('unwraps shells, env prefixes, package runners, and absolute paths', () => {
    expect(words(`sh -c 'eas submit --platform ios'`)).toContain('eas submit --platform ios');
    expect(words('FOO=1 env BAR=2 /usr/local/bin/eas submit')).toContain('eas submit');
    expect(words('npx -y eas-cli@latest submit')).toContain('eas submit');
    expect(words('pnpm exec eas submit')).toContain('eas submit');
  });

  it('parses command substitutions as their own commands', () => {
    expect(words('echo "$(eas submit)"')).toContain('eas submit');
    expect(words('echo `eas submit`')).toContain('eas submit');
  });

  it('records redirection targets as written files', () => {
    const parsed = parseCommand(`printf '{}' > .claude/settings.json 2>&1`);
    expect(parsed).toEqual({ ok: true, commands: [{ words: ['printf', '{}'], writes: ['.claude/settings.json'] }] });
  });

  it('reports unbalanced quotes as malformed', () => {
    expect(parseCommand(`eas submit "oops`)).toMatchObject({ ok: false });
    expect(parseCommand('echo $(eas submit')).toMatchObject({ ok: false });
  });
});

describe('evaluateToolCall', () => {
  it.each([
    'eas submit --platform ios',
    `sh -c "eas submit"`,
    `bash -lc 'cd app && eas submit'`,
    'npx eas-cli submit',
    'FOO=1 eas update --channel production',
    'eas update --branch main --channel=production --message x',
    'eas build --platform ios --profile production',
    'eas update:republish --group abc --destination-channel production',
    'npx expo install react-native-purchases',
    'pnpm add left-pad',
    'eas credentials',
    'cat ios/AuthKey_ABC.p8',
  ])('blocks %s', (command) => {
    expect(bash(command)).toMatchObject({ block: true });
  });

  it.each(['eas whoami', 'eas update --channel staging --message fix', 'npx tsc --noEmit', 'git status', 'cat .github/workflows/ci.yml'])(
    'allows %s',
    (command) => {
      expect(bash(command)).toEqual({ block: false });
    },
  );

  it('names the rule and tells the agent to stop for approval', () => {
    const decision = bash('eas submit');
    expect(decision).toMatchObject({ block: true, ruleId: 'store.release' });
    if (decision.block) expect(decision.reason).toContain('approval');
  });

  it('blocks malformed commands', () => {
    expect(bash(`eas whoami "`)).toMatchObject({ block: true, ruleId: 'malformed_command' });
  });

  it('blocks writes to protected paths through tools and shell', () => {
    expect(edit('/work/app/.claude/settings.json', 'Write')).toMatchObject({ block: true, ruleId: 'protected_path' });
    expect(edit('/home/agent/.claude/settings.json', 'Write')).toMatchObject({ block: true, ruleId: 'protected_path' });
    expect(edit('/work/app/.github/workflows/ci.yml')).toMatchObject({ block: true });
    expect(edit('/work/app/smoke/login.yaml')).toMatchObject({ block: true });
    expect(bash(`printf '{"disableAllHooks": true}' > .claude/settings.json`)).toMatchObject({ block: true, ruleId: 'protected_path' });
    expect(bash('mkdir -p .rnship/state')).toMatchObject({ block: true, ruleId: 'protected_path' });
  });

  it("ignores protected names in the project's own location, but not inside it or outside it", () => {
    const wt = '/Users/rnship-agent/.rnship/worktrees/run-1';
    const at = (file_path: string, tool_name = 'Edit') => evaluateToolCall(policy, { tool_name, tool_input: { file_path }, cwd: wt });
    expect(at(`${wt}/src/Counter.tsx`, 'Write')).toEqual({ block: false });
    expect(evaluateToolCall(policy, { tool_name: 'Bash', tool_input: { command: 'touch src/a.ts' }, cwd: wt })).toEqual({ block: false });
    expect(at(`${wt}/.rnship/policy.yaml`)).toMatchObject({ block: true, ruleId: 'protected_path' });
    expect(at(`${wt}/../run-2/.claude/settings.json`)).toMatchObject({ block: true, ruleId: 'protected_path' });
    expect(at('/Users/rnship-agent/.claude/settings.json', 'Write')).toMatchObject({ block: true, ruleId: 'protected_path' });
    expect(evaluateToolCall(policy, { tool_name: 'Bash', tool_input: { command: 'cp x ../../.claude/settings.json' }, cwd: wt })).toMatchObject({ block: true });
  });

  it('blocks edits to gated files and reads of signing material', () => {
    expect(edit('/work/app/store/products.yaml')).toMatchObject({ block: true, ruleId: 'iap.pricing' });
    expect(edit('/work/app/.env.local')).toMatchObject({ block: true, ruleId: 'keys.signing' });
    expect(evaluateToolCall(policy, { tool_name: 'Read', tool_input: { file_path: '/work/app/certs/dist.p12' }, cwd: CWD })).toMatchObject({
      block: true,
      ruleId: 'keys.signing',
    });
  });

  it('allows ordinary source edits and reads', () => {
    expect(edit('/work/app/src/App.js')).toEqual({ block: false });
    expect(evaluateToolCall(policy, { tool_name: 'Read', tool_input: { file_path: '/work/app/store/products.yaml' }, cwd: CWD })).toEqual({ block: false });
    expect(evaluateToolCall(policy, { tool_name: 'Glob', tool_input: { pattern: '**/*' }, cwd: CWD })).toEqual({ block: false });
  });
});
