import { spawn } from 'node:child_process';
import { generateDependencyReport, createAudioResource, StreamType } from '@discordjs/voice';
import { Capture, ffmpegPath, listDevices } from './capture.js';
import { discordConfig, required } from './config.js';

async function checkAudio() {
  const device = required('AUDIO_DEVICE');
  console.log('Checking your configured input for five seconds. Play music now. No audio is saved or sent to Discord.');
  await new Promise<void>((resolve, reject) => {
    let count = 0, square = 0, peak = 0;
    let capture: Capture;
    const timer = setTimeout(() => {
      capture.stop();
      if (!count) { reject(new Error('No samples received from the recording device.')); return; }
      const rms = Math.sqrt(square / count);
      console.log(`Received ${count} samples. Peak ${(peak / 32768 * 100).toFixed(1)}%; RMS ${(rms / 32768 * 100).toFixed(2)}%.`);
      if (peak < 20) console.log('Input is nearly silent. Route your music app to the virtual cable playback device, then try again.');
      else console.log('Audio detected. Local capture works; Discord playback still needs a live server test.');
      resolve();
    }, 5000);
    try {
      capture = new Capture(device, error => { clearTimeout(timer); capture.stop(); reject(error); });
      let pending = Buffer.alloc(0);
      capture.child.stdout.on('data', (chunk: Buffer) => {
        const data = Buffer.concat([pending, chunk]);
        const end = data.length - data.length % 2;
        for (let i = 0; i < end; i += 2) {
          const sample = data.readInt16LE(i);
          count++; square += sample * sample; peak = Math.max(peak, Math.abs(sample));
        }
        pending = data.subarray(end);
      });
    } catch (error) { clearTimeout(timer); reject(error); }
  });
}

async function doctor() {
  console.log(`Node ${process.version}; platform ${process.platform}; FFmpeg: ${ffmpegPath()}`);
  console.log(generateDependencyReport());
  try { discordConfig(); console.log('Discord configuration: present and IDs valid (not authenticated).'); }
  catch (error) { console.log((error as Error).message); }
  try {
    const devices = await listDevices();
    console.log(`${devices.length} audio input(s) found. Configured input ${devices.includes(process.env.AUDIO_DEVICE ?? '') ? 'found' : 'NOT found'}.`);
  } catch (error) { console.log(`Recording input check: ${(error as Error).message}`); }
  // Exercise Opus encoding with synthetic audio, without opening any real input.
  await new Promise<void>((resolve, reject) => {
    const child = spawn(ffmpegPath(), ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i',
      'sine=frequency=440:sample_rate=48000:duration=0.2', '-ac', '2', '-f', 's16le', 'pipe:1'], { windowsHide: true });
    let errorText = '', bytes = 0;
    let settled = false;
    let resource: ReturnType<typeof createAudioResource> | undefined;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      child.stdout.destroy();
      resource?.playStream.destroy();
      if (error) reject(error); else resolve();
    };
    const timer = setTimeout(() => finish(new Error('Synthetic encoder check timed out.')), 10_000);
    child.stderr.on('data', data => { errorText = (errorText + data).slice(-2000); });
    child.on('error', finish);
    try {
      resource = createAudioResource(child.stdout, { inputType: StreamType.Raw, inlineVolume: true });
    } catch (error) { finish(error as Error); return; }
    resource.playStream.on('data', (packet: Buffer) => { bytes += packet.length; });
    resource.playStream.on('error', finish);
    resource.playStream.on('end', () => finish(bytes ? undefined : new Error(`Opus encoder produced no packets. ${errorText}`)));
    child.on('close', code => { if (code !== 0 && !settled) finish(new Error(`Synthetic FFmpeg test failed: ${errorText}`)); });
  });
  console.log('Synthetic audio → PCM → Opus: passed. No Discord connection was made.');
}

try {
  switch (process.argv[2]) {
    case 'devices': console.log('Recording devices (copy the exact name into AUDIO_DEVICE):'); console.log((await listDevices()).join('\n')); break;
    case 'check-audio': await checkAudio(); break;
    case 'doctor': await doctor(); break;
    default: throw new Error('Use npm run devices, npm run doctor, or npm run check-audio.');
  }
} catch (error) { console.error((error as Error).message); process.exitCode = 1; }
