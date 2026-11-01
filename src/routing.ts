import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { win32 } from 'node:path';
import { fileURLToPath } from 'node:url';

const execute = promisify(execFile);
const utility = fileURLToPath(new URL('../tools/svcl/svcl.exe', import.meta.url));
export type SoundItem = Record<string, string>;
export function parseItems(raw: string): SoundItem[] {
  const items: unknown = JSON.parse(raw.replace(/^\uFEFF/, ''));
  if (!Array.isArray(items)) throw new Error('Windows returned an invalid sound device list.');
  return items;
}
export function inventory(items: SoundItem[]) {
  const outputs = items.filter(item => item.Type === 'Device' && item.Direction === 'Render' && item['Device State'] === 'Active');
  const cable = outputs.find(item => item.Name === 'CABLE Input' && /VB-Audio/i.test(item['Device Name']));
  const apps = new Map<string, { id: string; name: string }>();
  for (const item of items) {
    if (item.Type !== 'Application' || item.Direction !== 'Render' || !item['Process Path']) continue;
    const exe = win32.basename(item['Process Path']).toLowerCase();
    // Keep system processes, Discord, and Chappie out of the routing controls.
    if (!/^[\w .-]+\.exe$/.test(exe) || /^(discord.*|node|ffmpeg|svchost|system|audiodg|msedgewebview2)\.exe$/i.test(exe)) continue;
    apps.set(exe, { id: exe, name: item.Name || exe });
  }
  return { cableId: cable?.['Item ID'], apps: [...apps.values()].sort((a,b) => a.name.localeCompare(b.name)),
    privateOutputs: outputs.filter(item => !/VB-Audio/i.test(item['Device Name'])).map(item => ({
      id: item['Item ID'], name: `${item.Name} (${item['Device Name']})`, isDefault: item.Default === 'Render',
    })) };
}
export async function soundInventory() {
  const { stdout } = await execute(utility, ['/sjson', ''], { windowsHide: true, timeout: 10_000, maxBuffer: 4 * 1024 * 1024 });
  return inventory(parseItems(stdout));
}
export async function routeApp(app: string, device: string) {
  const info = await soundInventory();
  if (!info.apps.some(candidate => candidate.id === app)) throw new Error('Open your music browser/app and play a little audio, then refresh.');
  if (device !== 'DefaultRenderDevice' && device !== info.cableId && !info.privateOutputs.some(output => output.id === device)) {
    throw new Error('The requested audio output is unavailable. Reconnect your headphones and refresh.');
  }
  await execute(utility, ['/SetAppDefault', device, 'all', app], { windowsHide: true, timeout: 10_000 });
}
