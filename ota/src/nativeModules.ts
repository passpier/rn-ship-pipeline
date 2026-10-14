import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const NAME = String.raw`\s*['"]([A-Za-z_$][\w$]*)['"]`;
const PATTERNS = [
  new RegExp(String.raw`\b(?:requireNativeModule|requireOptionalNativeModule|requireNativeViewManager)\(${NAME}`, 'g'),
  new RegExp(String.raw`\bTurboModuleRegistry\.(?:get|getEnforcing)(?:<[^>]*>)?\(${NAME}`, 'g'),
  /\bNativeModules\.([A-Za-z_$][\w$]*)/g,
  new RegExp(String.raw`\bNativeModules\[${NAME}\]`, 'g'),
];

/** Native module names a JS/TS source looks up at runtime. */
export function nativeModuleRefs(source: string): string[] {
  return PATTERNS.flatMap((re) => [...source.matchAll(re)].map((m) => m[1]!));
}

const SOURCE_EXT = /\.(?:[cm]?js|jsx|tsx?)$/;
const SKIP_DIRS = new Set(['node_modules', 'ios', 'android', 'Pods', 'build-tools']);

/** JS/TS files under `root`, skipping node_modules, native dirs, and dot dirs. */
export function sourceFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(path);
      } else if (SOURCE_EXT.test(entry.name) && !entry.name.endsWith('.d.ts')) {
        out.push(path);
      }
    }
  };
  walk(root);
  return out;
}

export function nativeModuleRefsIn(root: string): Map<string, string[]> {
  const refs = new Map<string, string[]>();
  for (const file of sourceFiles(root)) {
    for (const name of nativeModuleRefs(readFileSync(file, 'utf8'))) {
      refs.set(name, [...(refs.get(name) ?? []), file]);
    }
  }
  return refs;
}
