import type { Readable } from 'node:stream';
import { createAudioResource, StreamType } from '@discordjs/voice';

export const MUSIC_BITRATE = 128_000;

export function createMusicResource(input: Readable, volume: number) {
  const resource = createAudioResource(input, { inputType: StreamType.Raw, inlineVolume: true });
  resource.volume!.setVolume(volume / 100);
  resource.encoder!.setBitrate(MUSIC_BITRATE);
  return resource;
}
