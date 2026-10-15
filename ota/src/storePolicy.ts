import { existsSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { PLATFORMS } from './artifacts.ts';
import type { Reason } from './classify.ts';
import type { GapContext } from './gaps.ts';
import { sourceFiles } from './nativeModules.ts';

// Layer 3: JS-only changes that may change what the app does enough for store review.
// Apple restricts downloaded code that changes an app's purpose, so these go to a human
// to choose between OTA and a store submission.
export const STORE_RULES: Array<(ctx: GapContext) => Reason[]> = [permissionPrompt, newScreen];

const human = (ruleId: string, detail: string): Reason[] => [{ ruleId, platforms: [...PLATFORMS], verdict: 'HUMAN', detail }];

const PROMPT = /\b(?:request\w*PermissionsAsync|PermissionsAndroid\.request(?:Multiple)?|requestTrackingPermissionsAsync)\s*\(/g;

function permissionPrompt({ base, candidate }: GapContext): Reason[] {
  const count = (root: string) => sourceFiles(root).reduce((n, file) => n + (readFileSync(file, 'utf8').match(PROMPT)?.length ?? 0), 0);
  const added = count(candidate.root) - count(base.root);
  return added > 0 ? human('store.permission_prompt', `${added} new permission request call(s) in app JS`) : [];
}

const ROUTE_DIRS = ['app', 'src/app'];

function newScreen({ base, candidate }: GapContext): Reason[] {
  const routes = (root: string) =>
    ROUTE_DIRS.filter((dir) => existsSync(join(root, dir))).flatMap((dir) =>
      sourceFiles(join(root, dir)).map((file) => relative(root, file)),
    );
  const before = new Set(routes(base.root));
  const added = routes(candidate.root).filter((route) => !before.has(route) && !/(^|\/)_layout\.|\+/.test(route));
  return added.length > 0 ? human('store.new_screen', `new routes: ${added.sort().join(', ')}`) : [];
}
