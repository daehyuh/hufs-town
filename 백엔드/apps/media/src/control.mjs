import http from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { MediaFailure } from './engine.mjs';
import { RecordingFailure } from './recordings.mjs';

const ROUTES = new Set(['/v1/policy', '/v1/revoke', '/v1/rpc', '/v1/recording/start', '/v1/recording/stop', '/v1/recording/list', '/v1/recording/delete', '/v1/recording/list-space', '/v1/recording/metadata', '/v1/recording/delete-space']);
const METRIC_SOURCES = [
  ['MICROPHONE', 'microphone'],
  ['CAMERA', 'camera'],
  ['SCREEN', 'screen'],
  ['SCREEN_AUDIO', 'screen_audio'],
];

function renderMetrics(engine) {
  let activeWorlds = 0;
  let activePeers = 0;
  const producers = Object.fromEntries(METRIC_SOURCES.map(([source]) => [source, 0]));
  const consumers = Object.fromEntries(METRIC_SOURCES.map(([source]) => [source, 0]));
  for (const world of engine.worlds?.values?.() ?? []) {
    let worldPeers = 0;
    for (const peer of world.peers?.values?.() ?? []) {
      const active = typeof engine.valid === 'function' ? engine.valid(peer) : !peer.closed;
      if (!active) continue;
      worldPeers++;
      activePeers++;
      for (const [source, producer] of peer.producers ?? [])
        if (producers[source] !== undefined && !producer.closed) producers[source]++;
      for (const consumer of peer.consumers?.values?.() ?? [])
        if (consumers[consumer.source] !== undefined && !consumer.resource?.closed && !consumer.producer?.closed)
          consumers[consumer.source]++;
    }
    if (worldPeers) activeWorlds++;
  }
  const recordings = engine.recordings;
  const activeRecordings = [...(recordings?.sessions?.values?.() ?? [])]
    .filter(session => ['STARTING', 'RECORDING', 'STOPPING'].includes(session.state)).length;
  const transcriptionJobs = recordings?.transcriptionJobs?.size ?? 0;
  const lines = [
    '# HELP hufs_media_active_worlds Worlds with at least one active media peer.',
    '# TYPE hufs_media_active_worlds gauge',
    `hufs_media_active_worlds ${activeWorlds}`,
    '# HELP hufs_media_active_peers Active media peers without player or world labels.',
    '# TYPE hufs_media_active_peers gauge',
    `hufs_media_active_peers ${activePeers}`,
    '# HELP hufs_media_active_producers Active media tracks by source.',
    '# TYPE hufs_media_active_producers gauge',
    ...METRIC_SOURCES.map(([source, label]) => `hufs_media_active_producers{source="${label}"} ${producers[source]}`),
    '# HELP hufs_media_active_consumers Active received media tracks by source.',
    '# TYPE hufs_media_active_consumers gauge',
    ...METRIC_SOURCES.map(([source, label]) => `hufs_media_active_consumers{source="${label}"} ${consumers[source]}`),
    '# HELP hufs_media_active_recordings Active private-room recording sessions.',
    '# TYPE hufs_media_active_recordings gauge',
    `hufs_media_active_recordings ${activeRecordings}`,
    '# HELP hufs_media_recording_capacity Maximum simultaneous active recordings.',
    '# TYPE hufs_media_recording_capacity gauge',
    `hufs_media_recording_capacity ${recordings?.maxActiveRecordings ?? 0}`,
    '# HELP hufs_media_transcription_jobs_active Active recording transcription jobs.',
    '# TYPE hufs_media_transcription_jobs_active gauge',
    `hufs_media_transcription_jobs_active ${transcriptionJobs}`,
  ];
  return `${lines.join('\n')}\n`;
}

function parseRange(header, size) {
  if (header === undefined) return { start: 0, end: size - 1, partial: false };
  if (typeof header !== 'string' || !header.startsWith('bytes=') || header.includes(',')) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!match || (!match[1] && !match[2])) return null;
  let start;
  let end;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix < 1) return null;
    start = Math.max(size - suffix, 0);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Number(match[2]) : size - 1;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= size || end < start) return null;
    end = Math.min(end, size - 1);
  }
  return { start, end, partial: true };
}

export function createControlServer({ engine, token, maxBodyBytes = 512_000 }) {
  if (typeof token !== 'string' || token.length < 32) throw new Error('MEDIA_CONTROL_TOKEN must contain at least 32 characters');
  const tokenHash = createHash('sha256').update(`Bearer ${token}`).digest();
  return http.createServer({ requestTimeout: 5000, headersTimeout: 5000, maxHeaderSize: 8192 }, async (req, res) => {
    const reply = (status, body) => {
      res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(body));
    };
    if (req.method === 'GET' && req.url === '/health') return reply(200, { status: 'UP' });
    if (req.method === 'GET' && req.url === '/metrics') {
      res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(renderMetrics(engine));
    }
    const authorizationHash = createHash('sha256').update(req.headers.authorization ?? '').digest();
    if (!timingSafeEqual(authorizationHash, tokenHash)) return reply(401, { code: 'MEDIA_AUTH_REQUIRED', message: 'Control authentication required' });
    const fileMatch = /^\/v1\/recording\/file\/([^/]+)\/([^/]+)$/.exec(req.url ?? '');
    if (req.method === 'GET' && fileMatch) {
      let opened;
      try {
        opened = await engine.openRecordingTrack(fileMatch[1], fileMatch[2]);
        const range = parseRange(req.headers.range, opened.size);
        if (!range) {
          await opened.handle.close();
          res.writeHead(416, { 'Content-Range': `bytes */${opened.size}`, 'Accept-Ranges': 'bytes', 'Cache-Control': 'private, no-store' });
          return res.end();
        }
        const length = range.end - range.start + 1;
        const headers = {
          'Content-Type': 'video/webm',
          'Content-Length': String(length),
          'Accept-Ranges': 'bytes',
          'Cache-Control': 'private, no-store',
          'X-Content-Type-Options': 'nosniff',
        };
        if (range.partial) headers['Content-Range'] = `bytes ${range.start}-${range.end}/${opened.size}`;
        res.writeHead(range.partial ? 206 : 200, headers);
        await pipeline(opened.handle.createReadStream({ start: range.start, end: range.end, autoClose: true }), res);
        return;
      } catch (error) {
        await opened?.handle.close().catch(() => {});
        if (res.headersSent) { res.destroy(); return; }
        const known = error instanceof MediaFailure || error instanceof RecordingFailure;
        const code = known ? error.code : 'MEDIA_INVALID';
        const status = known && Number.isInteger(error.status) ? error.status : code === 'MEDIA_STALE' ? 409 : 400;
        return reply(status, { code, message: known ? error.message : '통화 요청을 처리하지 못했어요.' });
      }
    }
    const transcriptMatch = /^\/v1\/recording\/transcript\/([^/]+)$/.exec(req.url ?? '');
    if (req.method === 'GET' && transcriptMatch) {
      try {
        return reply(200, await engine.recordingTranscript({ recordingId: transcriptMatch[1] }));
      } catch (error) {
        const known = error instanceof MediaFailure || error instanceof RecordingFailure;
        const code = known ? error.code : 'MEDIA_INVALID';
        const status = known && Number.isInteger(error.status) ? error.status : code === 'MEDIA_STALE' ? 409 : 400;
        return reply(status, { code, message: known ? error.message : '통화 요청을 처리하지 못했어요.' });
      }
    }
    if (req.method !== 'POST' || !ROUTES.has(req.url)) return reply(404, {});
    try {
      const startedAt = performance.now();
      let length = 0;
      const chunks = [];
      for await (const chunk of req) {
        length += chunk.length;
        if (length > maxBodyBytes) return reply(413, { code: 'MEDIA_INVALID', message: 'Request too large' });
        chunks.push(chunk);
      }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const result = req.url === '/v1/policy' ? engine.apply(body)
        : req.url === '/v1/revoke' ? engine.revoke(body)
          : req.url === '/v1/recording/start' ? await engine.startRecording(body)
            : req.url === '/v1/recording/stop' ? await engine.stopRecording(body)
              : req.url === '/v1/recording/list' ? await engine.listRecordings(body)
                : req.url === '/v1/recording/delete' ? await engine.deleteRecording(body)
                  : req.url === '/v1/recording/list-space' ? await engine.listSpaceRecordings(body)
                    : req.url === '/v1/recording/metadata' ? await engine.recordingMetadata(body)
                      : req.url === '/v1/recording/delete-space' ? await engine.deleteSpaceRecording(body)
              : await engine.rpc(body);
      const durationMs = performance.now() - startedAt;
      if (durationMs >= 100)
        console.warn(`[media-control] slow route=${req.url} durationMs=${Math.round(durationMs)}`);
      return reply(200, result);
    } catch (error) {
      const known = error instanceof MediaFailure || error instanceof RecordingFailure;
      const code = known ? error.code : 'MEDIA_INVALID';
      const status = known && Number.isInteger(error.status) ? error.status : code === 'MEDIA_STALE' ? 409 : 400;
      return reply(status, { code, message: known ? error.message : '통화 요청을 처리하지 못했어요.' });
    }
  });
}
