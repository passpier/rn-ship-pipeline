import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { recordBuild } from '../src/index.ts';

const FIXTURES = fileURLToPath(new URL('../../fixtures/', import.meta.url));
const APP = join(FIXTURES, 'app');
const EXTRAS = join(FIXTURES, 'extras');

export type Scenario = {
  base: string;
  candidate: string;
  artifacts: string;
  /** Make a package from fixtures/extras resolvable from the candidate (it isn't listed anywhere yet). */
  installExtra(name: string): void;
  edit(file: string, change: (text: string) => string): void;
  write(file: string, text: string): void;
};

// Copies the fixture app into sibling `base` and `candidate` dirs (same depth, so
// fingerprint source paths match), links the fixture's installed node_modules into
// each, and records the base as if it were the production build.
export async function scenario(): Promise<Scenario> {
  const root = mkdtempSync(join(tmpdir(), 'rnship-ota-'));
  const base = join(root, 'base');
  const candidate = join(root, 'candidate');
  const artifacts = join(root, 'artifacts');
  for (const dir of [base, candidate]) {
    cpSync(APP, dir, { recursive: true, filter: (src) => !src.startsWith(join(APP, 'node_modules')) });
    mkdirSync(join(dir, 'node_modules'));
    for (const entry of readdirSync(join(APP, 'node_modules'))) {
      symlinkSync(join(APP, 'node_modules', entry), join(dir, 'node_modules', entry));
    }
  }
  await recordBuild(base, artifacts, { buildId: 'fixture-build-1' });

  return {
    base,
    candidate,
    artifacts,
    installExtra(name) {
      symlinkSync(join(EXTRAS, 'node_modules', name), join(candidate, 'node_modules', name));
    },
    edit(file, change) {
      const path = join(candidate, file);
      writeFileSync(path, change(readFileSync(path, 'utf8')));
    },
    write(file, text) {
      mkdirSync(dirname(join(candidate, file)), { recursive: true });
      writeFileSync(join(candidate, file), text);
    },
  };
}
