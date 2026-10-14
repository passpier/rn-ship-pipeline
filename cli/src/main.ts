#!/usr/bin/env node
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { classify, recordBuild } from '@rnship/ota';
import { compilePolicy, loadBasePolicy, loadPolicy, mergePolicy, type Policy } from '@rnship/policy';

const USAGE = `usage:
  rnship policy merge <project-policy.yaml> [--base <base.yaml>]
  rnship policy compile <project-policy.yaml> --out <dir> [--base <base.yaml>] [--codeowner <@handle>]
  rnship ota record <project-root> --out <dir> --build-id <id>
  rnship ota classify --base <project-root> --artifacts <dir> --candidate <project-root> [--policy <project-policy.yaml>]`;

class UsageError extends Error {}

function merged(projectPath: string, basePath?: string): Policy {
  const result = mergePolicy(basePath ? loadPolicy(basePath) : loadBasePolicy(), loadPolicy(projectPath));
  if (!result.ok) {
    for (const error of result.errors) console.error(`rnship: ${error.code}: ${error.message}`);
    process.exit(1);
  }
  return result.policy;
}

function required(values: Record<string, unknown>, ...names: string[]): void {
  for (const name of names) if (typeof values[name] !== 'string') throw new UsageError(`missing --${name}`);
}

async function main(argv: string[]): Promise<void> {
  const [group, command, ...rest] = argv;
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      base: { type: 'string' },
      out: { type: 'string' },
      codeowner: { type: 'string' },
      'build-id': { type: 'string' },
      artifacts: { type: 'string' },
      candidate: { type: 'string' },
      policy: { type: 'string' },
    },
  });

  switch (`${group} ${command}`) {
    case 'policy merge': {
      if (!positionals[0]) throw new UsageError('missing <project-policy.yaml>');
      console.log(JSON.stringify(merged(positionals[0], values.base), null, 2));
      return;
    }
    case 'policy compile': {
      if (!positionals[0]) throw new UsageError('missing <project-policy.yaml>');
      required(values, 'out');
      const compiled = compilePolicy(merged(positionals[0], values.base), { codeowner: values.codeowner });
      mkdirSync(values.out!, { recursive: true });
      writeFileSync(join(values.out!, 'settings.json'), JSON.stringify(compiled.settings, null, 2) + '\n');
      writeFileSync(join(values.out!, 'hook-rules.json'), JSON.stringify(compiled.hookRules, null, 2) + '\n');
      if (compiled.codeowners) writeFileSync(join(values.out!, 'CODEOWNERS'), compiled.codeowners);
      return;
    }
    case 'ota record': {
      if (!positionals[0]) throw new UsageError('missing <project-root>');
      required(values, 'out', 'build-id');
      await recordBuild(positionals[0], values.out!, { buildId: values['build-id']! });
      return;
    }
    case 'ota classify': {
      required(values, 'base', 'artifacts', 'candidate');
      const result = await classify({
        base: values.base!,
        artifacts: values.artifacts!,
        candidate: values.candidate!,
        policy: values.policy ? merged(values.policy) : undefined,
      });
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    default:
      throw new UsageError(`unknown command: ${[group, command].filter(Boolean).join(' ') || '(none)'}`);
  }
}

main(process.argv.slice(2)).catch((error: unknown) => {
  if (error instanceof UsageError) {
    console.error(`rnship: ${error.message}\n${USAGE}`);
    process.exit(2);
  }
  console.error(error);
  process.exit(1);
});
