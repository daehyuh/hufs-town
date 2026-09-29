import { execFile } from 'node:child_process';
import { readFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const MAX_SEGMENTS = 10_000;
const MAX_SEGMENT_TEXT = 2_000;

export class TranscriptionFailure extends Error {
  constructor(code) {
    super(code);
    this.name = 'TranscriptionFailure';
    this.code = code;
  }
}

export class SpeechTranscriber {
  constructor({
    apiKey = process.env.MEDIA_TRANSCRIPTION_API_KEY || '',
    baseUrl = process.env.MEDIA_TRANSCRIPTION_API_BASE || 'https://api.openai.com/v1',
    model = process.env.MEDIA_TRANSCRIPTION_MODEL || 'gpt-4o-transcribe-diarize',
    ffmpegPath = process.env.MEDIA_FFMPEG_PATH || 'ffmpeg',
    fetchImpl = globalThis.fetch,
    convertAudio = convertToMp3,
    maxUploadBytes = Number(process.env.MEDIA_TRANSCRIPTION_MAX_UPLOAD_BYTES || 22 * 1024 * 1024),
    timeoutMs = Number(process.env.MEDIA_TRANSCRIPTION_TIMEOUT_MS || 180_000),
  } = {}) {
    const parsed = safeBaseUrl(baseUrl);
    this.apiKey = apiKey;
    this.endpoint = parsed ? `${parsed}/audio/transcriptions` : '';
    this.model = /^[a-zA-Z0-9._-]{1,80}$/.test(model) ? model : '';
    this.ffmpegPath = ffmpegPath;
    this.fetchImpl = fetchImpl;
    this.convertAudio = convertAudio;
    this.maxUploadBytes = maxUploadBytes;
    this.timeoutMs = timeoutMs;
    this.enabled = typeof apiKey === 'string' && apiKey.trim().length > 0
      && !!this.endpoint && !!this.model && typeof fetchImpl === 'function'
      && Number.isSafeInteger(maxUploadBytes) && maxUploadBytes > 0
      && Number.isSafeInteger(timeoutMs) && timeoutMs > 0;
  }

  async transcribeTrack({ audioPath, directory, trackId, speakerName, offsetMs = 0, signal }) {
    if (!this.enabled) throw new TranscriptionFailure('TRANSCRIPTION_DISABLED');
    if (typeof audioPath !== 'string' || typeof directory !== 'string'
      || typeof trackId !== 'string' || !/^[0-9a-f-]{36}$/i.test(trackId))
      throw new TranscriptionFailure('TRANSCRIPTION_INVALID_TRACK');

    const compressedPath = path.join(directory, `.transcription-${trackId}.mp3`);
    try {
      await this.convertAudio(this.ffmpegPath, audioPath, compressedPath);
      const info = await stat(compressedPath);
      if (!info.isFile() || info.size < 1 || info.size > this.maxUploadBytes)
        throw new TranscriptionFailure('TRANSCRIPTION_AUDIO_LIMIT');

      const form = new FormData();
      form.append('file', new Blob([await readFile(compressedPath)], { type: 'audio/mpeg' }), `track-${trackId}.mp3`);
      form.append('model', this.model);
      form.append('response_format', 'diarized_json');
      form.append('chunking_strategy', 'auto');
      const response = await this.fetchImpl(this.endpoint, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.apiKey}` },
        body: form,
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(this.timeoutMs)]) : AbortSignal.timeout(this.timeoutMs),
      });
      if (!response.ok) throw new TranscriptionFailure('TRANSCRIPTION_PROVIDER_FAILED');
      let payload;
      try { payload = await response.json(); }
      catch { throw new TranscriptionFailure('TRANSCRIPTION_INVALID_RESPONSE'); }
      return normalizeTranscript(payload, { speakerName, offsetMs });
    } catch (error) {
      if (error instanceof TranscriptionFailure) throw error;
      if (error?.name === 'TimeoutError' || error?.name === 'AbortError')
        throw new TranscriptionFailure('TRANSCRIPTION_TIMEOUT');
      throw new TranscriptionFailure('TRANSCRIPTION_PROVIDER_FAILED');
    } finally {
      await rm(compressedPath, { force: true }).catch(() => {});
    }
  }
}

export function normalizeTranscript(payload, { speakerName, offsetMs = 0 } = {}) {
  if (!payload || typeof payload !== 'object' || !Array.isArray(payload.segments)
    || payload.segments.length > MAX_SEGMENTS || !Number.isSafeInteger(offsetMs) || offsetMs < 0)
    throw new TranscriptionFailure('TRANSCRIPTION_INVALID_RESPONSE');
  const label = typeof speakerName === 'string' && speakerName.trim()
    ? [...speakerName.trim()].slice(0, 20).join('') : '참가자';
  const segments = [];
  for (const segment of payload.segments) {
    if (!segment || typeof segment.text !== 'string') throw new TranscriptionFailure('TRANSCRIPTION_INVALID_RESPONSE');
    const start = Number(segment.start);
    const end = Number(segment.end);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start)
      throw new TranscriptionFailure('TRANSCRIPTION_INVALID_RESPONSE');
    const text = [...segment.text.trim()].slice(0, MAX_SEGMENT_TEXT).join('');
    if (!text) continue;
    segments.push({
      startMs: offsetMs + Math.round(start * 1000),
      endMs: offsetMs + Math.round(end * 1000),
      speakerName: label,
      text,
    });
  }
  segments.sort((left, right) => left.startMs - right.startMs || left.endMs - right.endMs);
  return { text: typeof payload.text === 'string' ? payload.text.slice(0, 1_000_000) : '', segments };
}

function safeBaseUrl(value) {
  if (typeof value !== 'string' || value.length > 512) return '';
  try {
    const url = new URL(value);
    const localHttp = url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (url.protocol !== 'https:' && !localHttp) return '';
    if (url.username || url.password || url.search || url.hash) return '';
    return url.toString().replace(/\/+$/, '');
  } catch { return ''; }
}

async function convertToMp3(ffmpegPath, inputPath, outputPath) {
  try {
    await execFileAsync(ffmpegPath, [
      '-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-i', inputPath,
      '-map', '0:a:0', '-vn', '-ac', '1', '-ar', '16000', '-b:a', '24k', '-f', 'mp3', outputPath,
    ], { timeout: 120_000, windowsHide: true, maxBuffer: 32 * 1024 });
  } catch {
    throw new TranscriptionFailure('TRANSCRIPTION_AUDIO_CONVERSION_FAILED');
  }
}
