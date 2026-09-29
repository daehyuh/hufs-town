import assert from 'node:assert/strict';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { normalizeTranscript, SpeechTranscriber, TranscriptionFailure } from '../src/transcription.mjs';

const TRACK_ID = '123e4567-e89b-42d3-a456-426614174010';

test('uploads compressed audio only after configuration and maps diarized segments to the recorded speaker', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'hufs-transcription-'));
  let request;
  try {
    const transcriber = new SpeechTranscriber({
      apiKey: 'test-transcription-key',
      baseUrl: 'http://127.0.0.1:43117/v1',
      convertAudio: async (_ffmpeg, _source, destination) => writeFile(destination, Buffer.from('compressed-audio')),
      fetchImpl: async (url, options) => {
        request = { url, ...options };
        return {
          ok: true,
          async json() {
            return {
              text: 'later first',
              segments: [
                { start: 1.25, end: 2.5, speaker: 'A', text: 'later' },
                { start: 0, end: 0.5, speaker: 'B', text: 'first' },
              ],
            };
          },
        };
      },
    });

    const result = await transcriber.transcribeTrack({
      audioPath: path.join(directory, 'private.webm'),
      directory,
      trackId: TRACK_ID,
      speakerName: 'Mina',
      offsetMs: 3_000,
    });

    assert.deepEqual(result.segments, [
      { startMs: 3_000, endMs: 3_500, speakerName: 'Mina', text: 'first' },
      { startMs: 4_250, endMs: 5_500, speakerName: 'Mina', text: 'later' },
    ]);
    assert.equal(request.url, 'http://127.0.0.1:43117/v1/audio/transcriptions');
    assert.equal(request.headers.Authorization, 'Bearer test-transcription-key');
    assert.equal(request.body.get('model'), 'gpt-4o-transcribe-diarize');
    assert.equal(request.body.get('response_format'), 'diarized_json');
    assert.equal(request.body.get('chunking_strategy'), 'auto');
    assert.equal(await request.body.get('file').text(), 'compressed-audio');
    await assert.rejects(stat(path.join(directory, `.transcription-${TRACK_ID}.mp3`)), { code: 'ENOENT' });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('fails closed when transcription is disabled, an upload is oversized, or the provider response is untrusted', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'hufs-transcription-'));
  try {
    const disabled = new SpeechTranscriber({ apiKey: '' });
    await assert.rejects(disabled.transcribeTrack({ audioPath: 'a.webm', directory, trackId: TRACK_ID }), { code: 'TRANSCRIPTION_DISABLED' });

    const tooLarge = new SpeechTranscriber({
      apiKey: 'test-key',
      baseUrl: 'http://127.0.0.1:43117/v1',
      maxUploadBytes: 1,
      convertAudio: async (_ffmpeg, _source, destination) => writeFile(destination, Buffer.from('larger')),
      fetchImpl: async () => assert.fail('oversized audio must not leave the server'),
    });
    await assert.rejects(tooLarge.transcribeTrack({ audioPath: 'a.webm', directory, trackId: TRACK_ID }), { code: 'TRANSCRIPTION_AUDIO_LIMIT' });

    assert.throws(() => normalizeTranscript({ segments: [{ start: 2, end: 1, text: 'invalid' }] }), { code: 'TRANSCRIPTION_INVALID_RESPONSE' });
    assert.equal(new SpeechTranscriber({ apiKey: 'key', baseUrl: 'http://example.com/v1' }).enabled, false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
