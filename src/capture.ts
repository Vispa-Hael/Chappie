import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import ffmpegStatic from 'ffmpeg-static';
import 'dotenv/config';

export function ffmpegPath(): string {
  const path = process.env.FFMPEG_PATH?.trim() || ffmpegStatic;
  if (typeof path !== 'string' || !isAbsolute(path) || !existsSync(path)) {
    throw new Error('FFmpeg not found. Run npm install or set FFMPEG_PATH to an absolute ffmpeg.exe path.');
  }
  return path;
}

export function captureArgs(device: string): string[] {
  if (!device.trim() || /[\r\n\0]/.test(device)) throw new Error('AUDIO_DEVICE is empty or invalid.');
  // No shell: device names are passed as a single argument, never interpreted as commands.
  return ['-hide_banner', '-loglevel', 'warning', '-nostdin', '-f', 'dshow',
    '-rtbufsize', '16M', '-i', `audio=${device}`, '-vn',
    '-ac', '2', '-ar', '48000', '-c:a', 'pcm_s16le', '-f', 's16le', 'pipe:1'];
}

export function listDevices(): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath(), ['-hide_banner', '-list_devices', 'true', '-f', 'dshow', '-i', 'dummy'],
      { windowsHide: true });
    let stderr = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('Audio device discovery timed out.')); }, 15_000);
    child.stdout.resume();
    child.stderr.on('data', (data: Buffer) => { stderr = (stderr + data).slice(-64_000); });
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('close', () => {
      clearTimeout(timer);
      // FFmpeg intentionally exits nonzero after listing devices.
      const devices = [...stderr.matchAll(/"([^"\r\n]+)"\s+\(audio\)/g)].map(match => match[1]);
      if (!devices.length) reject(new Error('No DirectShow audio inputs found. Install a virtual audio device or enable a recording input.'));
      else resolve([...new Set(devices)]);
    });
  });
}

export class Capture {
  readonly child: ChildProcessWithoutNullStreams;
  private diagnostic = '';
  private intentionalStop = false;
  private killTimer?: NodeJS.Timeout;
  constructor(device: string, onFailure: (error: Error) => void) {
    this.child = spawn(ffmpegPath(), captureArgs(device), { windowsHide: true });
    this.child.stdin.end();
    let reported = false;
    const fail = (error: Error) => {
      if (!this.intentionalStop && !reported) { reported = true; onFailure(error); }
    };
    this.child.stderr.on('data', (data: Buffer) => { this.diagnostic = (this.diagnostic + data).slice(-4000); });
    this.child.once('error', fail);
    this.child.once('close', code => {
      clearTimeout(this.killTimer);
      fail(new Error(`Audio capture ended (exit ${code}). Check the recording device and npm run check-audio. ${this.diagnostic.trim()}`));
    });
  }
  stop(): void {
    if (this.intentionalStop) return;
    this.intentionalStop = true;
    if (this.child.exitCode === null && this.child.signalCode === null) {
      this.child.kill();
      this.killTimer = setTimeout(() => this.child.kill('SIGKILL'), 2000);
      this.killTimer.unref();
    }
    this.child.stdout.destroy();
  }
}
