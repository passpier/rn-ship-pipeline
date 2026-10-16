// Prompt text helpers shared by the adapters. Untrusted text (task bodies, failure digests)
// only ever goes inside a fence longer than any backtick run in it, so it can't close the
// fence and pose as a header, checkbox or signal of ours.

export function fenced(text: string): string {
  const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  const fence = '`'.repeat(longest + 1);
  return `${fence}text\n${text.trimEnd()}\n${fence}`;
}

export const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim();
