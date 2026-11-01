import { createServer, type IncomingMessage } from 'node:http';
import { randomBytes } from 'node:crypto';
import { readFile, writeFile, unlink } from 'node:fs/promises';
import { soundInventory, routeApp } from './routing.js';

export interface PanelController {
  start(): Promise<string>;
  stop(): void;
  status(): { broadcasting: boolean; channels: string[] };
}
export async function startPanel(controller: PanelController, options: {
  port?: number; stateFile?: URL; inventory?: typeof soundInventory; route?: typeof routeApp; quiet?: boolean;
} = {}) {
  const stateFile = options.stateFile ?? new URL('../.routing-state.json', import.meta.url);
  const getInventory = options.inventory ?? soundInventory;
  const setRoute = options.route ?? routeApp;
  const key = randomBytes(32).toString('hex');
  let origin = `http://127.0.0.1:${options.port ?? 37841}`;
  const html = (await readFile(new URL('../ui/index.html', import.meta.url), 'utf8')).replace('__SESSION_KEY__', key);
  let pending: { app: string; privateOutput: string } | undefined;
  try { pending = JSON.parse(await readFile(stateFile, 'utf8')); } catch { /* No routing to recover. */ }
  let busy = false;
  async function body(request: IncomingMessage) {
    let data = '';
    for await (const chunk of request) {
      data += chunk;
      if (data.length > 4096) throw new Error('Request too large.');
    }
    return JSON.parse(data || '{}') as Record<string, string>;
  }
  const server = createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('X-Frame-Options', 'DENY');
    response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'");
    const send = (status: number, value: unknown) => { response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(value)); };
    if (request.headers.host !== new URL(origin).host) return send(403, { error: 'Local access only.' });
    if (request.url === '/health' && request.method === 'GET') return send(200, { app: 'chappie-panel' });
    if (request.url === '/' && request.method === 'GET') {
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); response.end(html); return;
    }
    if (request.headers['x-chappie-key'] !== key || (request.headers.origin && request.headers.origin !== origin)) return send(403, { error: 'Reopen the Chappie panel.' });
    try {
      if (request.url === '/api/state' && request.method === 'GET') {
        return send(200, { ...await getInventory(), ...controller.status(), pending, busy });
      }
      if (request.url !== '/api/toggle' || request.method !== 'POST') return send(404, { error: 'Not found.' });
      if (busy) return send(409, { error: 'Chappie is still switching. Please wait.' });
      busy = true;
      try {
        const data = await body(request);
        if (data.action === 'off') {
          controller.stop();
          if (pending) {
            await setRoute(pending.app, pending.privateOutput);
            await unlink(stateFile);
            pending = undefined;
          }
          return send(200, { message: 'Chappie is off. Your music app is back on your private output.' });
        }
        if (data.action !== 'on') throw new Error('Unknown action.');
        if (pending) throw new Error('Turn Chappie off first to restore the previous routing.');
        const info = await getInventory();
        if (!info.cableId) throw new Error('CABLE Input was not found. Check the VB-CABLE driver.');
        if (!info.apps.some(app => app.id === data.app)) throw new Error('Choose your music browser/app. Start playing audio so it appears.');
        const privateOutput = data.privateOutput || 'DefaultRenderDevice';
        if (privateOutput === 'DefaultRenderDevice' && !info.privateOutputs.some(output => output.isDefault)) {
          throw new Error('Your Windows default output is a virtual cable. Choose your headphones under Setup first.');
        }
        if (privateOutput !== 'DefaultRenderDevice' && !info.privateOutputs.some(output => output.id === privateOutput)) throw new Error('Choose an available private output.');
        pending = { app: data.app, privateOutput };
        await writeFile(stateFile, JSON.stringify(pending), 'utf8');
        try {
          await setRoute(pending.app, info.cableId);
          const channel = await controller.start();
          return send(200, { message: `Chappie is on in ${channel}. Everyone there can hear your music.` });
        } catch (error) {
          controller.stop();
          try { await setRoute(pending.app, pending.privateOutput); await unlink(stateFile); pending = undefined; }
          catch { /* Keep the recovery record so Off can retry. */ }
          throw error;
        }
      } finally { busy = false; }
    } catch (error) { send(400, { error: error instanceof Error ? error.message : 'Could not switch audio.' }); }
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(options.port ?? 37841, '127.0.0.1', resolve); });
  const address = server.address();
  if (address && typeof address !== 'string') origin = `http://127.0.0.1:${address.port}`;
  if (!options.quiet) console.log(`Chappie On/Off panel: ${origin}`);
  return server;
}
