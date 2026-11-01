import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile, writeFile, rename } from 'node:fs/promises';
import { PassThrough } from 'node:stream';
import { WebSocketServer, WebSocket, type RawData } from 'ws';

export interface RemoteChannel { guildId: string; guildName: string; channelId: string; channelName: string }
export interface RemoteController {
  context(userId: string): Promise<RemoteChannel[]>;
  start(guildId: string, userId: string, pcm: PassThrough, onEnded: () => void): Promise<void>;
  stop(guildId: string, pcm: PassThrough): void | Promise<void>;
}
export interface RemoteOptions {
  port?: number; bind?: string; devicesFile?: string | URL; now?: () => number;
  pairingTtlMs?: number; deviceTtlMs?: number; claimTtlMs?: number; idleMs?: number;
  quiet?: boolean;
}
interface Device { hash: string; userId: string; name: string; expiresAt: number }
interface Pairing { id: string; code: string; pollHash: string; expiresAt: number; device?: Device; token?: string; approving?: boolean }
interface Turn { guildId: string; userId: string; userName: string; expiresAt: number }
interface Lease {
  id: string; guildId: string; channelId: string; userId: string; userName: string;
  deviceHash: string; createdAt: number; lastSeen: number; pcm: PassThrough;
  socket?: WebSocket; startPromise?: Promise<void>; closing?: Promise<void>;
  budget: number; budgetAt: number; ready: boolean;
}

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const secret = () => randomBytes(32).toString('base64url');
const equal = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
class HttpError extends Error { constructor(readonly status: number, message: string) { super(message); } }

/** Single-process authority for device identity, one live broadcaster per guild, and bounded PCM ingest. */
export async function createRemoteService(controller: RemoteController, options: RemoteOptions = {}) {
  const now = options.now ?? Date.now;
  const devicesFile = options.devicesFile ?? new URL('../../.remote-devices.json', import.meta.url);
  const ttl = options.pairingTtlMs ?? 5 * 60_000;
  const claimTtl = options.claimTtlMs ?? 10_000;
  const idleMs = options.idleMs ?? 10_000;
  const devices = new Map<string, Device>();
  const pairings = new Map<string, Pairing>();
  const leases = new Map<string, Lease>();
  const byGuild = new Map<string, Lease>();
  const turns = new Map<string, Turn[]>();
  const reservations = new Map<string, { userId: string; expiresAt: number }>();
  const limits = new Map<string, { at: number; count: number }>();
  let persistence = Promise.resolve();
  let closed = false;
  try {
    const saved: unknown = JSON.parse(await readFile(devicesFile, 'utf8'));
    if (!Array.isArray(saved)) throw new Error('Invalid paired-device store.');
    for (const row of saved.slice(0, 1000)) {
      if (row && /^[a-f0-9]{64}$/.test(row.hash) && /^\d{17,20}$/.test(row.userId)
        && typeof row.name === 'string' && Number.isFinite(row.expiresAt) && row.expiresAt > now()) {
        devices.set(row.hash, { hash: row.hash, userId: row.userId, name: row.name.slice(0, 80), expiresAt: row.expiresAt });
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Could not read the paired-device store. Fix or move the private file before starting.');
  }
  function persist() {
    persistence = persistence.catch(() => {}).then(async () => {
      const temporary = `${devicesFile instanceof URL ? (await import('node:url')).fileURLToPath(devicesFile) : devicesFile}.tmp`;
      await writeFile(temporary, JSON.stringify([...devices.values()]), { encoding: 'utf8', mode: 0o600 });
      await rename(temporary, devicesFile);
    });
    return persistence;
  }
  function prune() {
    for (const [key, device] of devices) if (device.expiresAt <= now()) devices.delete(key);
    for (const [id, pair] of pairings) if (pair.expiresAt <= now()) pairings.delete(id);
    for (const [id, reservation] of reservations) if (reservation.expiresAt <= now()) reservations.delete(id);
    for (const [guild, queue] of turns) { const live = queue.filter(turn => turn.expiresAt > now()); if (live.length) turns.set(guild, live); else turns.delete(guild); }
    for (const [key, bucket] of limits) if (bucket.at + 60_000 <= now()) limits.delete(key);
  }
  function rate(key: string, max: number) {
    prune();
    const bucket = limits.get(key) ?? { at: now(), count: 0 };
    if (++bucket.count > max) throw new HttpError(429, 'Too many requests. Please wait a minute.');
    if (limits.size >= 2000 && !limits.has(key)) throw new HttpError(503, 'Service is busy. Try again shortly.');
    limits.set(key, bucket);
  }
  function authenticate(request: IncomingMessage): Device {
    const authorization = request.headers.authorization ?? '';
    if (!authorization.startsWith('Bearer ') || authorization.length > 256) throw new HttpError(401, 'Pair this companion with Discord first.');
    const device = devices.get(hash(authorization.slice(7)));
    if (!device || device.expiresAt <= now()) throw new HttpError(401, 'Device pairing expired or was revoked. Pair again.');
    return device;
  }
  async function eligible(userId: string, guildId: string, channelId?: string) {
    const channels = await controller.context(userId);
    const channel = channels.find(item => item.guildId === guildId && (!channelId || item.channelId === channelId));
    if (!channel) throw new HttpError(403, 'Join that server’s voice channel before sharing.');
    return channel;
  }
  function send(response: ServerResponse, status: number, data: unknown) {
    response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    response.end(JSON.stringify(data));
  }
  async function body(request: IncomingMessage): Promise<Record<string, string>> {
    let size = 0; const chunks: Buffer[] = [];
    for await (const chunk of request) { size += chunk.length; if (size > 4096) throw new HttpError(413, 'Request too large.'); chunks.push(chunk); }
    try {
      const result = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error();
      return result;
    } catch { throw new HttpError(400, 'Invalid request.'); }
  }
  function input(value: unknown, name: string) {
    if (typeof value !== 'string' || !value || value.length > 128) throw new HttpError(400, `Invalid ${name}.`);
    return value;
  }
  async function closeLease(lease: Lease, reason = 'Sharing stopped.') {
    if (lease.closing) return lease.closing;
    // Keep the guild slot occupied until all in-flight player startup has settled.
    lease.closing = Promise.resolve().then(async () => {
      leases.delete(lease.id);
      lease.socket?.close?.(1000, reason.slice(0, 100));
      lease.pcm.destroy();
      if (lease.startPromise) {
        try { await controller.stop(lease.guildId, lease.pcm); } catch { /* Still release the slot. */ }
      }
      try { await lease.startPromise; } catch { /* Failed starts are already closed. */ }
      if (lease.startPromise) {
        try { await controller.stop(lease.guildId, lease.pcm); } catch { /* Best effort after interrupted startup. */ }
      }
      if (byGuild.get(lease.guildId) === lease) byGuild.delete(lease.guildId);
    });
    return lease.closing;
  }
  const server = createServer(async (request, response) => {
    try {
      if (closed) throw new HttpError(503, 'Host is shutting down.');
      // Native companion sends credentials from its main process, never a remote webpage.
      if (request.headers.origin) throw new HttpError(403, 'Browser requests are not accepted.');
      const ip = request.socket.remoteAddress ?? 'unknown';
      rate(`all:${ip}`, 1200);
      const path = new URL(request.url ?? '/', 'http://local').pathname;
      if (path === '/health' && request.method === 'GET') return send(response, 200, { service: 'chappie-remote', protocol: 1 });
      if (path === '/v1/pair' && request.method === 'POST') {
        rate(`pair:${ip}`, 12);
        if (pairings.size >= 100) throw new HttpError(503, 'Pairing is busy. Try again shortly.');
        const id = secret(), pollSecret = secret();
        let code: string;
        do { code = randomBytes(5).toString('hex').slice(0, 8).toUpperCase(); }
        while ([...pairings.values()].some(pair => pair.code === code));
        const pair: Pairing = { id, code, pollHash: hash(pollSecret), expiresAt: now() + ttl };
        pairings.set(id, pair);
        return send(response, 201, { requestId: id, code, pollSecret, expiresAt: pair.expiresAt });
      }
      if (path === '/v1/pair/status' && request.method === 'POST') {
        const data = await body(request);
        const pair = pairings.get(input(data.requestId, 'pairing request'));
        if (!pair || !equal(pair.pollHash, hash(input(data.pollSecret, 'pairing proof')))) throw new HttpError(404, 'Pairing expired or was not found.');
        return send(response, 200, pair.device ? { status: 'approved', token: pair.token, user: { id: pair.device.userId, name: pair.device.name }, expiresAt: pair.device.expiresAt } : { status: 'pending' });
      }
      const device = authenticate(request);
      rate(`user:${device.userId}`, 300);
      if (path === '/v1/context' && request.method === 'GET') {
        const channels = await controller.context(device.userId);
        const visible = new Set(channels.map(channel => channel.guildId));
        return send(response, 200, { user: { id: device.userId, name: device.name }, channels,
          sharing: [...byGuild.values()].filter(lease => visible.has(lease.guildId)).map(lease => ({ guildId: lease.guildId, userId: lease.userId, userName: lease.userName,
            ...(lease.userId === device.userId ? { leaseId: lease.id } : {}), closing: !!lease.closing })),
          requests: [...turns.values()].flat().filter(turn => turn.userId === device.userId || byGuild.get(turn.guildId)?.userId === device.userId),
          reservations: [...reservations].filter(([, value]) => value.userId === device.userId).map(([guildId, value]) => ({ guildId, ...value })) });
      }
      const data = await body(request);
      if (path === '/v1/claim' && request.method === 'POST') {
        const guildId = input(data.guildId, 'server');
        const channel = await eligible(device.userId, guildId);
        if (byGuild.has(guildId)) throw new HttpError(409, 'Someone is already sharing in that server. Request a turn.');
        const reserved = reservations.get(guildId);
        if (reserved && reserved.userId !== device.userId) throw new HttpError(409, 'A turn is reserved for another person.');
        if (leases.size >= 25) throw new HttpError(503, 'Host is at its stream limit.');
        const lease: Lease = { id: secret(), guildId, channelId: channel.channelId, userId: device.userId, userName: device.name,
          deviceHash: device.hash, createdAt: now(), lastSeen: now(), pcm: new PassThrough({ highWaterMark: 128 * 1024 }),
          budget: 384_000, budgetAt: now(), ready: false };
        lease.pcm.on('error', () => {});
        leases.set(lease.id, lease); byGuild.set(guildId, lease); reservations.delete(guildId);
        turns.set(guildId, (turns.get(guildId) ?? []).filter(turn => turn.userId !== device.userId));
        return send(response, 201, { leaseId: lease.id, websocketPath: `/v1/audio?leaseId=${lease.id}`,
          format: { sampleRate: 48000, channels: 2, sampleFormat: 's16le' } });
      }
      if (path === '/v1/release' && request.method === 'POST') {
        const lease = leases.get(input(data.leaseId, 'lease'));
        if (!lease || lease.deviceHash !== device.hash) throw new HttpError(403, 'That sharing session is not yours.');
        await closeLease(lease);
        return send(response, 200, { stopped: true });
      }
      if (path === '/v1/request-turn' && request.method === 'POST') {
        const guildId = input(data.guildId, 'server'); await eligible(device.userId, guildId);
        const sharing = byGuild.get(guildId);
        if (!sharing) throw new HttpError(409, 'Nobody is sharing. You can turn Chappie on now.');
        if (sharing.userId === device.userId) throw new HttpError(409, 'You are already sharing.');
        const queue = turns.get(guildId) ?? [];
        if (!queue.some(turn => turn.userId === device.userId)) {
          if (queue.length >= 25) throw new HttpError(409, 'The turn queue is full.');
          queue.push({ guildId, userId: device.userId, userName: device.name, expiresAt: now() + 5 * 60_000 });
          turns.set(guildId, queue);
        }
        return send(response, 200, { requested: true, position: queue.findIndex(turn => turn.userId === device.userId) + 1 });
      }
      if (path === '/v1/handoff' && request.method === 'POST') {
        const guildId = input(data.guildId, 'server'), userId = input(data.userId, 'next user');
        const lease = byGuild.get(guildId);
        if (!lease || lease.deviceHash !== device.hash) throw new HttpError(403, 'Only the current broadcaster can hand over playback.');
        if (!(turns.get(guildId) ?? []).some(turn => turn.userId === userId)) throw new HttpError(400, 'That user has not requested a turn.');
        await eligible(device.userId, guildId, lease.channelId); await eligible(userId, guildId);
        reservations.set(guildId, { userId, expiresAt: now() + 30_000 });
        await closeLease(lease, 'Playback handed to another person.');
        return send(response, 200, { handedOff: true, userId, expiresAt: reservations.get(guildId)?.expiresAt });
      }
      throw new HttpError(404, 'Not found.');
    } catch (error) {
      const known = error instanceof HttpError;
      send(response, known ? error.status : 500, { error: known ? error.message : 'Host operation failed. Check the host console.' });
    }
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  const websocket = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024, perMessageDeflate: false });
  server.on('upgrade', async (request, socket, head) => {
    try {
      if (closed || request.headers.origin) throw new Error('Rejected');
      const path = new URL(request.url ?? '/', 'http://local');
      if (path.pathname !== '/v1/audio') throw new Error('Rejected');
      const device = authenticate(request), lease = leases.get(path.searchParams.get('leaseId') ?? '');
      if (!lease || lease.deviceHash !== device.hash || lease.socket || lease.createdAt + claimTtl <= now()) throw new Error('Rejected');
      // Reserve attachment synchronously before the async membership check.
      const sentinel = {} as WebSocket;
      lease.socket = sentinel;
      try { await eligible(device.userId, lease.guildId, lease.channelId); }
      catch (error) { lease.socket = undefined; throw error; }
      if (lease.closing || !leases.has(lease.id)) throw new Error('Rejected');
      websocket.handleUpgrade(request, socket, head, ws => {
        lease.socket = ws; lease.lastSeen = now();
        ws.on('error', () => { void closeLease(lease, 'Audio connection failed.'); });
        ws.on('close', () => { void closeLease(lease); });
        // Pongs do not extend an audio lease: a connected but silent sender must
        // still transmit PCM silence frames, or release after the idle timeout.
        ws.on('message', (raw: RawData, binary: boolean) => {
          const bytes = Buffer.isBuffer(raw) ? raw : Array.isArray(raw) ? Buffer.concat(raw) : Buffer.from(raw as ArrayBuffer);
          if (!binary || bytes.length % 4 || !bytes.length || bytes.length > 64 * 1024) { ws.close(1008, 'Expected stereo PCM audio.'); void closeLease(lease); return; }
          const time = now();
          lease.budget = Math.min(384_000, lease.budget + (time - lease.budgetAt) * 192);
          lease.budgetAt = time;
          if (bytes.length > lease.budget || lease.pcm.writableLength + bytes.length > 1024 * 1024) {
            ws.close(1008, 'Audio exceeded the realtime buffer limit.'); void closeLease(lease); return;
          }
          lease.budget -= bytes.length; lease.lastSeen = time;
          lease.pcm.write(bytes);
        });
        ws.send(JSON.stringify({ type: 'accepted' }));
        lease.startPromise = Promise.resolve().then(() => {
          if (lease.closing) return;
          return controller.start(lease.guildId, lease.userId, lease.pcm, () => { void closeLease(lease, 'Discord playback ended.'); });
        });
        void lease.startPromise.then(() => {
          if (lease.closing) return;
          lease.ready = true;
          if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'ready' }));
        }).catch(() => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'error', message: 'Could not start Discord playback.' })); void closeLease(lease); });
      });
    } catch { if (!socket.destroyed) { socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n'); socket.destroy(); } }
  });
  let checking = false;
  const sweep = setInterval(() => {
    prune();
    for (const lease of leases.values()) {
      if (!devices.has(lease.deviceHash)) void closeLease(lease, 'Device pairing expired.');
      else if ((!lease.socket && lease.createdAt + claimTtl <= now()) || lease.lastSeen + idleMs <= now()) void closeLease(lease, 'Sharing connection timed out.');
      else if (lease.socket instanceof WebSocket && lease.socket.readyState === WebSocket.OPEN) lease.socket.ping();
    }
    if (checking) return;
    checking = true;
    void Promise.all([...leases.values()].filter(lease => lease.ready).map(async lease => {
      try { await eligible(lease.userId, lease.guildId, lease.channelId); }
      catch { await closeLease(lease, 'Broadcaster left the voice channel.'); }
    })).finally(() => { checking = false; });
  }, Math.min(2000, idleMs / 2));
  sweep.unref();
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(options.port ?? 37842, options.bind ?? '127.0.0.1', resolve); });
  if (!options.quiet) console.log(`Chappie remote audio host listening on ${options.bind ?? '127.0.0.1'}:${(server.address() as { port: number }).port}. Publish only behind HTTPS.`);
  return {
    server,
    async approvePair(code: string, userId: string, displayName: string) {
      prune(); rate(`approve:${userId}`, 10);
      if (!/^\d{17,20}$/.test(userId)) throw new Error('Invalid Discord identity.');
      const pair = [...pairings.values()].find(item => item.code === code.trim().toUpperCase());
      if (!pair || pair.device || pair.approving) throw new Error('Pairing code expired or already used. Open a new pairing request.');
      if (devices.size >= 1000) throw new Error('Device limit reached. Revoke unused pairings first.');
      const token = secret();
      pair.approving = true;
      const device: Device = { hash: hash(token), userId, name: displayName.slice(0, 80), expiresAt: now() + (options.deviceTtlMs ?? 30 * 24 * 60 * 60_000) };
      devices.set(device.hash, device);
      try { await persist(); } catch { devices.delete(device.hash); pair.approving = false; throw new Error('Could not save pairing. Try again.'); }
      pair.device = device; pair.token = token;
      return { userId, expiresAt: device.expiresAt };
    },
    isPaired(userId: string) { return [...devices.values()].some(device => device.userId === userId && device.expiresAt > now()); },
    async revokeUser(userId: string) {
      for (const [key, device] of devices) if (device.userId === userId) devices.delete(key);
      for (const [id, pair] of pairings) if (pair.device?.userId === userId) pairings.delete(id);
      await Promise.all([...leases.values()].filter(lease => lease.userId === userId).map(lease => closeLease(lease, 'Device access revoked.')));
      await persist();
    },
    hasGuildLease(guildId: string) { return byGuild.has(guildId); },
    getGuildLease(guildId: string) {
      const lease = byGuild.get(guildId);
      return lease ? { userId: lease.userId, userName: lease.userName, channelId: lease.channelId } : undefined;
    },
    async stopGuild(guildId: string) { const lease = byGuild.get(guildId); if (lease) await closeLease(lease); },
    async shutdown() {
      if (closed) return;
      closed = true; clearInterval(sweep);
      await Promise.all([...byGuild.values()].map(lease => closeLease(lease, 'Host shutting down.')));
      for (const ws of websocket.clients) ws.terminate();
      await new Promise<void>(resolve => websocket.close(() => resolve()));
      await new Promise<void>(resolve => server.close(() => resolve()));
      await persistence;
    },
  };
}
