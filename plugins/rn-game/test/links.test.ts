import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SKILL = fileURLToPath(new URL('../skills/rn-2d-game/', import.meta.url));
const docs = ['SKILL.md', ...readdirSync(join(SKILL, 'references')).map((f) => join('references', f))];

describe('rn-2d-game skill', () => {
  it.each(docs)('%s links only to files that exist', (doc) => {
    const text = readFileSync(join(SKILL, doc), 'utf8');
    const targets = [...text.matchAll(/\]\(([^)#\s]+)(?:#[^)]*)?\)/g)]
      .map((m) => m[1]!)
      .filter((t) => !/^[a-z]+:/.test(t));
    const missing = targets.filter((t) => !existsSync(join(SKILL, dirname(doc), t)));
    expect(missing).toEqual([]);
  });
});
