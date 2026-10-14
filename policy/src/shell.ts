// Turns a Bash tool command into the simple commands it would run, so the PreToolUse
// hook can match `eas submit` inside `sh -c`, `npx eas-cli`, `FOO=1 env …`, `$(…)` and
// pipelines. Shell is too rich to parse exactly; anything this can't follow is
// malformed, and the hook blocks malformed commands (fail closed).

/** One simple command: its words, plus the files its redirections write to. */
export type SimpleCommand = { words: string[]; writes: string[] };

export type ParsedCommand = { ok: true; commands: SimpleCommand[] } | { ok: false; error: string };

const MAX_DEPTH = 8;

export function parseCommand(source: string): ParsedCommand {
  try {
    return { ok: true, commands: expand(parse(source, 0), 0) };
  } catch (error) {
    if (error instanceof MalformedCommand) return { ok: false, error: error.message };
    throw error;
  }
}

class MalformedCommand extends Error {}

// --- tokenizer ----------------------------------------------------------------

type Raw = { words: string[]; writes: string[] };

const SEPARATORS = new Set([';', '&', '|', '\n', '(', ')']);

// Splits `source` into simple commands. Command substitutions become their own
// commands (the outer word keeps a placeholder).
function parse(source: string, depth: number): Raw[] {
  if (depth > MAX_DEPTH) throw new MalformedCommand('command nests too deeply');
  const commands: Raw[] = [];
  let current: Raw = { words: [], writes: [] };
  let word: string | undefined;
  // The next word is a redirection target: written (recorded) or read (dropped).
  let redirect: 'write' | 'read' | undefined;
  let i = 0;

  const endWord = () => {
    if (word === undefined) return;
    if (redirect) {
      if (redirect === 'write' && !/^&?\d*-?$/.test(word)) current.writes.push(word);
      redirect = undefined;
    } else {
      current.words.push(word);
    }
    word = undefined;
  };
  const endCommand = () => {
    endWord();
    if (current.words.length > 0 || current.writes.length > 0) commands.push(current);
    current = { words: [], writes: [] };
  };
  const substitution = (inner: string) => {
    commands.push(...parse(inner, depth + 1));
    word = (word ?? '') + '$SUB';
  };

  while (i < source.length) {
    const c = source[i]!;
    if (c === '\\') {
      if (source[i + 1] === '\n') {
        i += 2;
        continue;
      }
      word = (word ?? '') + (source[i + 1] ?? '');
      i += 2;
    } else if (c === "'") {
      const end = source.indexOf("'", i + 1);
      if (end < 0) throw new MalformedCommand('unterminated single quote');
      word = (word ?? '') + source.slice(i + 1, end);
      i = end + 1;
    } else if (c === '"') {
      i = doubleQuoted(source, i + 1, (text) => (word = (word ?? '') + text), substitution);
    } else if (c === '$' && source[i + 1] === '(') {
      const end = closingParen(source, i + 2);
      substitution(source.slice(i + 2, end));
      i = end + 1;
    } else if (c === '`') {
      const end = source.indexOf('`', i + 1);
      if (end < 0) throw new MalformedCommand('unterminated backtick');
      substitution(source.slice(i + 1, end));
      i = end + 1;
    } else if (c === '#' && word === undefined) {
      while (i < source.length && source[i] !== '\n') i++;
    } else if (c === '>' || c === '<') {
      // A word made only of digits right before the operator is a file descriptor.
      if (word !== undefined && /^\d+$/.test(word)) word = undefined;
      endWord();
      redirect = c === '>' ? 'write' : 'read';
      i++;
      while (source[i] === '>' || source[i] === '<' || source[i] === '&') i++;
    } else if (SEPARATORS.has(c)) {
      endCommand();
      i++;
    } else if (c === ' ' || c === '\t') {
      endWord();
      i++;
    } else {
      word = (word ?? '') + c;
      i++;
    }
  }
  endCommand();
  return commands;
}

function doubleQuoted(source: string, start: number, text: (s: string) => void, substitution: (inner: string) => void): number {
  let i = start;
  let buffer = '';
  while (i < source.length) {
    const c = source[i]!;
    if (c === '"') {
      text(buffer);
      return i + 1;
    }
    if (c === '\\' && i + 1 < source.length) {
      buffer += source[i + 1];
      i += 2;
    } else if (c === '$' && source[i + 1] === '(') {
      text(buffer);
      buffer = '';
      const end = closingParen(source, i + 2);
      substitution(source.slice(i + 2, end));
      i = end + 1;
    } else if (c === '`') {
      text(buffer);
      buffer = '';
      const end = source.indexOf('`', i + 1);
      if (end < 0) throw new MalformedCommand('unterminated backtick');
      substitution(source.slice(i + 1, end));
      i = end + 1;
    } else {
      buffer += c;
      i++;
    }
  }
  throw new MalformedCommand('unterminated double quote');
}

// Index of the `)` that closes a `$(` whose body starts at `start`.
function closingParen(source: string, start: number): number {
  let depth = 1;
  for (let i = start; i < source.length; i++) {
    const c = source[i];
    if (c === "'") {
      const end = source.indexOf("'", i + 1);
      if (end < 0) break;
      i = end;
    } else if (c === '\\') {
      i++;
    } else if (c === '(') {
      depth++;
    } else if (c === ')' && --depth === 0) {
      return i;
    }
  }
  throw new MalformedCommand('unterminated $(');
}

// --- unwrapping -----------------------------------------------------------------

const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish']);
// Prefix commands that run their arguments as a command. Value: flags that take an argument.
const PREFIXES: Record<string, string[]> = {
  env: ['-u', '-C', '-S'],
  sudo: ['-u', '-g', '-h', '-p', '-C', '-D', '-R', '-T'],
  command: [],
  exec: ['-a'],
  nohup: [],
  time: [],
  nice: ['-n'],
  timeout: ['-s', '-k'],
  caffeinate: ['-t', '-w'],
  xargs: ['-I', '-n', '-P', '-L', '-d', '-s', '-E', '-a'],
  '{': [],
};
const PACKAGE_RUNNERS: Record<string, string[]> = { npx: ['-p', '--package', '-c', '--call'], bunx: ['-p', '--package'], pnpx: [] };
// `<tool> <subcommand> <bin>`: pnpm exec eas, yarn dlx eas-cli, npm exec -- eas.
const RUNNER_SUBCOMMANDS: Record<string, string[]> = { pnpm: ['exec', 'dlx'], yarn: ['exec', 'dlx'], npm: ['exec', 'x'], bun: ['x'] };
const ALIASES: Record<string, string> = { 'eas-cli': 'eas' };

// Each raw command yields the command as written plus every unwrapped form, so both
// `npx expo install*` and `eas submit*` style patterns can match.
function expand(raws: Raw[], depth: number): SimpleCommand[] {
  return raws.flatMap((raw) => variants(raw.words, depth).map((words) => ({ words, writes: raw.writes })));
}

function variants(input: string[], depth: number): string[][] {
  if (depth > MAX_DEPTH) throw new MalformedCommand('command nests too deeply');
  let words = input;
  while (words.length > 0 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0]!)) words = words.slice(1);
  if (words.length === 0) return [];
  const name = binaryName(words[0]!);
  words = [name, ...words.slice(1)];
  if (words.at(-1) === '}') words = words.slice(0, -1);
  const out: string[][] = [words];

  if (SHELLS.has(name)) {
    const flag = words.findIndex((w, i) => i > 0 && /^-[a-z]*c[a-z]*$/.test(w));
    if (flag > 0) {
      const script = words[flag + 1];
      if (script === undefined) throw new MalformedCommand(`${name} -c without a command`);
      for (const command of parseCommandOrThrow(script, depth + 1)) out.push(command.words);
    }
  } else if (name === 'eval') {
    for (const command of parseCommandOrThrow(words.slice(1).join(' '), depth + 1)) out.push(command.words);
  } else if (name in PREFIXES) {
    const rest = skipFlags(words.slice(1), PREFIXES[name]!, name === 'env');
    const tail = name === 'timeout' ? rest.slice(1) : rest;
    if (tail.length > 0) out.push(...variants(tail, depth + 1));
  } else if (name in PACKAGE_RUNNERS) {
    const rest = skipFlags(words.slice(1), PACKAGE_RUNNERS[name]!, false);
    if (rest.length > 0) out.push(...variants([packageBinary(rest[0]!), ...rest.slice(1)], depth + 1));
  } else if (RUNNER_SUBCOMMANDS[name]?.includes(words[1] ?? '')) {
    const rest = skipFlags(words.slice(2), ['-p', '--package'], false);
    if (rest.length > 0) out.push(...variants([packageBinary(rest[0]!), ...rest.slice(1)], depth + 1));
  } else if (name in ALIASES) {
    out.push([ALIASES[name]!, ...words.slice(1)]);
  }
  return out.map(splitLongFlags);
}

function parseCommandOrThrow(source: string, depth: number): SimpleCommand[] {
  return expand(parse(source, depth), depth);
}

function binaryName(word: string): string {
  return word.includes('/') ? word.slice(word.lastIndexOf('/') + 1) : word;
}

// `eas-cli@latest` → `eas`, `@scope/pkg@1` → `pkg`.
function packageBinary(spec: string): string {
  const at = spec.lastIndexOf('@');
  const bare = at > 0 ? spec.slice(0, at) : spec;
  const name = binaryName(bare);
  return ALIASES[name] ?? name;
}

function skipFlags(words: string[], takesValue: string[], skipAssignments: boolean): string[] {
  let i = 0;
  while (i < words.length) {
    const w = words[i]!;
    if (w === '--') return words.slice(i + 1);
    if (skipAssignments && /^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) i++;
    else if (takesValue.includes(w)) i += 2;
    else if (w.startsWith('-')) i++;
    else break;
  }
  return words.slice(i);
}

// `--channel=production` → `--channel production`.
function splitLongFlags(words: string[]): string[] {
  return words.flatMap((w) => {
    const m = /^(--[A-Za-z0-9-]+)=(.*)$/.exec(w);
    return m ? [m[1]!, m[2]!] : [w];
  });
}
