import { spawnSync } from 'node:child_process';

// Tells you a task needs you. The bundle on disk holds the detail; the notification only
// points at it. A GitHub issue would need a broker operation, which comes later, and is
// never an approval channel (design §4).

export type Notice = { title: string; message: string; taskIds: number[]; bundle?: string };
export type Notify = (notice: Notice) => void;

// osascript gets the text as argv to `on run`, never spliced into the script source.
const SCRIPT = 'on run argv\n  display notification (item 2 of argv) with title (item 1 of argv)\nend run';

export const desktopNotify: Notify = (notice) => {
  const line = `rnship: ${notice.title}: ${notice.message}${notice.bundle ? ` (${notice.bundle})` : ''}`;
  console.error(line);
  if (process.platform === 'darwin') spawnSync('osascript', ['-e', SCRIPT, `rnship: ${notice.title}`, notice.message], { stdio: 'ignore' });
};
