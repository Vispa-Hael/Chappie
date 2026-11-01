import { performance } from 'node:perf_hooks';
import { RTP_OPUS_PAYLOAD_TYPE, type Networking, type VoiceConnection, type VoiceUDPSocket, type VoiceWebSocket } from '@discordjs/voice';

/** Microphone activity only; no audio is decoded, saved, or transcribed. */
export class SpeechDucker {
  gain = 1;
  private speakers = new Map<string, { started: number; expiry: number }>();
  private ramp?: { from: number; to: number; at: number; duration: number };
  constructor(readonly depth = 0.5, readonly releaseMs = 2000, readonly tailMs = 250, readonly attackMs = 500,
    readonly longSpeechMs = 5000, readonly longDepth = 0.25) {}
  private duck(now: number) {
    const target = [...this.speakers.values()].some(speaker => now - speaker.started >= this.longSpeechMs)
      ? this.longDepth : this.depth;
    if (this.ramp?.to === target) return;
    if (this.gain === target) this.ramp = undefined;
    else this.fade(target, now, this.attackMs);
  }
  private advance(now: number) {
    if (!this.ramp) return;
    const progress = Math.min(1, Math.max(0, (now - this.ramp.at) / this.ramp.duration));
    // Smoothstep S-curve: zero slope at either end avoids hard starts/stops.
    const eased = progress * progress * (3 - 2 * progress);
    this.gain = this.ramp.from + (this.ramp.to - this.ramp.from) * eased;
    if (progress === 1) this.ramp = undefined;
  }
  private fade(to: number, now: number, duration: number) {
    this.advance(now);
    this.ramp = { from: this.gain, to, at: now, duration };
  }
  activity(userId: string, now: number) {
    this.tick(now);
    const started = this.speakers.get(userId)?.started ?? now;
    this.speakers.set(userId, { started, expiry: now + this.tailMs });
    // Repeated microphone packets extend activity without restarting the fade.
    this.duck(now);
  }
  remove(userId: string, now: number) {
    this.tick(now);
    if (this.speakers.delete(userId) && !this.speakers.size) this.fade(1, now, this.releaseMs);
  }
  tick(now: number) {
    let lastExpiry = 0;
    for (const [userId, { expiry }] of this.speakers) {
      lastExpiry = Math.max(lastExpiry, expiry);
      if (expiry <= now) this.speakers.delete(userId);
    }
    // A short utterance releases smoothly from the gain reached so far.
    if (!this.speakers.size && lastExpiry) this.fade(1, lastExpiry, this.releaseMs);
    this.advance(now);
    if (this.speakers.size) this.duck(now);
    return this.gain;
  }
}

export class MicrophoneActivity {
  private sources = new Map<number, { userId: string; microphone: boolean }>();
  constructor(readonly isHuman: (userId: string) => boolean, readonly onSpeech: (userId: string) => void) {}
  control(packet: { op: number; d?: { user_id?: string; ssrc?: number; speaking?: number } }) {
    const data = packet.d;
    if (packet.op === 13 && data?.user_id) {
      for (const [ssrc, source] of this.sources) if (source.userId === data.user_id) this.sources.delete(ssrc);
    }
    if (packet.op !== 5 || !data?.user_id || !Number.isInteger(data.ssrc) || !Number.isInteger(data.speaking)) return;
    const flags = data.speaking!;
    // Discord flags: Microphone=1, Soundshare=2. Unknown/mixed sources fail closed.
    this.sources.set(data.ssrc!, { userId: data.user_id, microphone: (flags & 1) !== 0 && (flags & 2) === 0 });
  }
  media(packet: Buffer) {
    // Only inspect the unencrypted RTP header, never the audio payload.
    if (packet.length < 12 || (packet[0] >> 6) !== 2 || (packet[1] & 0x7f) !== RTP_OPUS_PAYLOAD_TYPE) return;
    const source = this.sources.get(packet.readUInt32BE(8));
    if (source?.microphone && this.isHuman(source.userId)) this.onSpeech(source.userId);
  }
  clear() { this.sources.clear(); }
}

export function attachDucking(connection: VoiceConnection, isHuman: (id: string) => boolean, apply: (gain: number) => void) {
  const ducker = new SpeechDucker();
  const activity = new MicrophoneActivity(isHuman, id => { ducker.activity(id, performance.now()); apply(ducker.gain); });
  let network: Networking | undefined;
  let ws: VoiceWebSocket | undefined;
  let udp: VoiceUDPSocket | undefined;
  const onControl = (packet: Parameters<MicrophoneActivity['control']>[0]) => activity.control(packet);
  const onMedia = (packet: Buffer) => activity.media(packet);
  const bindSockets = () => {
    const state = network?.state;
    const nextWs = state && 'ws' in state ? state.ws : undefined;
    const nextUdp = state && 'udp' in state ? state.udp : undefined;
    if (nextWs !== ws) {
      ws?.off('packet', onControl);
      activity.clear();
      ws = nextWs;
      ws?.on('packet', onControl);
    }
    if (nextUdp !== udp) { udp?.off('message', onMedia); udp = nextUdp; udp?.on('message', onMedia); }
  };
  const bindNetwork = () => {
    const state = connection.state;
    const next = 'networking' in state ? state.networking : undefined;
    if (next !== network) {
      network?.off('stateChange', bindSockets);
      network = next;
      network?.on('stateChange', bindSockets);
    }
    bindSockets();
  };
  connection.on('stateChange', bindNetwork);
  bindNetwork();
  const timer = setInterval(() => apply(ducker.tick(performance.now())), 20);
  timer.unref();
  return {
    get gain() { return ducker.gain; },
    remove(id: string) { ducker.remove(id, performance.now()); },
    dispose() {
      clearInterval(timer);
      connection.off('stateChange', bindNetwork);
      network?.off('stateChange', bindSockets);
      ws?.off('packet', onControl);
      udp?.off('message', onMedia);
      activity.clear();
      apply(1);
    },
  };
}
