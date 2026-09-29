import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { FfmpegRtpCapture } from '../src/recordings.mjs';

const hasFfmpeg = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0;
const hasProbe = spawnSync('ffprobe', ['-version'], { stdio: 'ignore' }).status === 0;

test('FFmpeg RTP capture creates a playable WebM file from a selected producer', { skip: !hasFfmpeg || !hasProbe }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'hufs-recording-file-'));
  await mkdir(path.join(root, 'tracks'));
  const outputPath = path.join(root, 'tracks', 'selected.webm');
  const senderChildren = new Set();
  let senderError = '';
  let destinationPort;
  const startSender = () => {
    const sender = spawn('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-nostdin', '-re',
      '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
      '-t', '20', '-ac', '2', '-c:a', 'libopus', '-payload_type', '111',
      '-f', 'rtp', `rtp://127.0.0.1:${destinationPort}`,
    ], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    sender.stderr.on('data', chunk => { senderError = (senderError + chunk.toString()).slice(-2048); });
    senderChildren.add(sender);
    sender.once('close', () => senderChildren.delete(sender));
  };
  const transport = {
    async consume() {
      return {
        kind: 'audio',
        rtpParameters: { codecs: [{ mimeType: 'audio/opus', payloadType: 111, clockRate: 48000, channels: 2, parameters: {} }] },
        async resume() { await new Promise(resolve => setTimeout(resolve, 750)); startSender(); },
        close() {},
      };
    },
    async connect({ port }) { destinationPort = port; },
    close() { for (const child of senderChildren) child.kill('SIGKILL'); },
  };
  const router = { rtpCapabilities: {}, canConsume: () => true, createPlainTransport: async () => transport };
  const capture = new FfmpegRtpCapture({
    router,
    producer: { id: 'selected-producer' },
    outputPath,
    maxBytes: 1024 * 1024,
  });

  try {
    try { await capture.start(); }
    catch (error) { throw new Error(`${error.message}; ffmpeg: ${capture.stderr}`, { cause: error }); }
    await new Promise(resolve => setTimeout(resolve, 2500));
    const result = await capture.stop('proof');
    assert.ok(result.bytes > 0, `receiver=${capture.stderr}; sender=${senderError}; reason=${result.reason}`);
    const file = await stat(outputPath);
    assert.equal(result.bytes, file.size);
    assert.match(result.sha256, /^[0-9a-f]{64}$/);
    const probe = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=format_name,duration', '-of', 'json', outputPath], { encoding: 'utf8' });
    assert.equal(probe.status, 0, probe.stderr);
    const format = JSON.parse(probe.stdout).format;
    assert.match(format.format_name, /webm/);
    assert.ok(Number(format.duration) > 0, `expected non-empty playable duration: ${await readFile(outputPath).then(bytes => bytes.length)} bytes`);
  } finally {
    await capture.stop('cleanup').catch(() => {});
    for (const child of senderChildren) child.kill('SIGKILL');
    await rm(root, { recursive: true, force: true });
  }
});
