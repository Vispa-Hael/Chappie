import { randomUUID } from 'node:crypto';

export type SongStatus = 'requested' | 'accepted' | 'played' | 'declined' | 'cancelled';
export interface SongRequest {
  id: string; guildId: string; userId: string; userName: string; title: string;
  url?: string; note: string; status: SongStatus; createdAt: number; updatedAt: number; expiresAt: number;
}
export class SongRequestError extends Error { constructor(readonly status: number, message: string) { super(message); } }
const active = (request: SongRequest) => request.status === 'requested' || request.status === 'accepted';

/** In-memory requests, not a media resolver or automatic playback queue. */
export class SongRequestBoard {
  private requests = new Map<string, SongRequest>();
  constructor(private readonly now: () => number = Date.now) {}
  prune() {
    for (const [id, request] of this.requests) if (request.expiresAt <= this.now()) this.requests.delete(id);
  }
  list(guildIds: Set<string>) {
    this.prune();
    return [...this.requests.values()].filter(request => guildIds.has(request.guildId)).map(request => ({ ...request }));
  }
  create(guildId: string, userId: string, userName: string, data: { title?: unknown; url?: unknown; note?: unknown }) {
    this.prune();
    const text = (value: unknown, name: string, maximum: number) => {
      if (value === undefined) return '';
      if (typeof value !== 'string' || value.length > maximum || value.includes('\0')) throw new SongRequestError(400, `Invalid ${name}.`);
      return value.trim();
    };
    let title = text(data.title, 'song title (maximum 160 characters)', 160);
    const rawURL = text(data.url, 'song link (maximum 2048 characters)', 2048);
    const note = text(data.note, 'song note (maximum 300 characters)', 300);
    let url: string | undefined;
    if (rawURL) {
      try {
        const parsed = new URL(rawURL);
        if (parsed.protocol !== 'https:' || parsed.username || parsed.password || /[\r\n]/.test(rawURL)) throw new Error();
        url = parsed.href;
        if (url.length > 2048) throw new Error();
        if (!title) title = parsed.hostname.slice(0, 160);
      } catch { throw new SongRequestError(400, 'Song links must use HTTPS and contain no login information.'); }
    }
    if (!title) throw new SongRequestError(400, 'Enter a song title or HTTPS link.');
    const guild = [...this.requests.values()].filter(request => request.guildId === guildId);
    const pending = guild.filter(active);
    if (pending.some(request => request.userId === userId && (url ? request.url === url : !request.url && request.title.toLowerCase() === title.toLowerCase()))) {
      throw new SongRequestError(409, 'You already have an active request for that song.');
    }
    if (pending.filter(request => request.userId === userId).length >= 5) throw new SongRequestError(409, 'You can have five active song requests per server.');
    if (pending.length >= 50) throw new SongRequestError(409, 'The song request queue is full.');
    if (this.requests.size >= 5000) throw new SongRequestError(503, 'The host request board is full. Try again later.');
    const now = this.now();
    const request: SongRequest = { id: randomUUID(), guildId, userId, userName: userName.slice(0, 80), title, url, note,
      status: 'requested', createdAt: now, updatedAt: now, expiresAt: now + 24 * 60 * 60_000 };
    this.requests.set(request.id, request);
    return { ...request };
  }
  action(guildId: string, requestId: string, userId: string, broadcasterUserId: string | undefined, action: unknown) {
    this.prune();
    const request = this.requests.get(requestId);
    if (!request || request.guildId !== guildId) throw new SongRequestError(404, 'That song request was not found.');
    if (!['accept', 'played', 'decline', 'cancel'].includes(action as string)) throw new SongRequestError(400, 'Unknown song request action.');
    if (action === 'cancel') {
      if (request.userId !== userId) throw new SongRequestError(403, 'You can only cancel your own song requests.');
      if (!active(request)) throw new SongRequestError(409, 'That song request has already finished.');
      request.status = 'cancelled';
    } else {
      if (!broadcasterUserId || broadcasterUserId !== userId) throw new SongRequestError(403, 'Only the active broadcaster can review song requests.');
      if (action === 'accept') {
        if (request.status !== 'requested') throw new SongRequestError(409, 'Only new requests can be accepted.');
        request.status = 'accepted';
      } else if (action === 'played') {
        if (request.status !== 'accepted') throw new SongRequestError(409, 'Accept the request before marking it played.');
        request.status = 'played';
      } else {
        if (!active(request)) throw new SongRequestError(409, 'That song request has already finished.');
        request.status = 'declined';
      }
    }
    request.updatedAt = this.now();
    // Keep at most 100 completed entries per guild, dropping oldest history.
    const history = [...this.requests.values()].filter(row => row.guildId === guildId && !active(row)).sort((a, b) => a.updatedAt - b.updatedAt);
    for (const row of history.slice(0, Math.max(0, history.length - 100))) this.requests.delete(row.id);
    return { ...request };
  }
}
