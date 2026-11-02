import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);
const keys = { playpause: 0xB3, next: 0xB0, previous: 0xB1 } as const;
export type MediaAction = keyof typeof keys;

/** Sends a standard Windows media key to the current media session; no player login or content data is read. */
export async function controlMedia(action: MediaAction, run = execFile): Promise<void> {
  const key = keys[action];
  if (key === undefined) throw new Error('Unknown media control.');
  const script = `$source=@'\nusing System;\nusing System.Runtime.InteropServices;\npublic static class ChappieMedia { [DllImport("user32.dll")] public static extern void keybd_event(byte key, byte scan, uint flags, UIntPtr extra); }\n'@; Add-Type -TypeDefinition $source; [ChappieMedia]::keybd_event(${key},0,0,[UIntPtr]::Zero); [ChappieMedia]::keybd_event(${key},0,2,[UIntPtr]::Zero)`;
  await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 5_000 });
}
