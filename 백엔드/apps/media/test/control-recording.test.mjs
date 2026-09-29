import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, open, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createControlServer } from '../src/control.mjs';
import { RecordingFailure } from '../src/recordings.mjs';

const TOKEN = 'media-control-test-token-which-is-long-enough';

test('recording control routes require bearer auth and keep public file routes unavailable', async () => {
  const calls = [];
  const engine = {
    apply: body => ({ sequence: body.sequence }),
    revoke: body => ({ revoked: true, playerId: body.playerId }),
    rpc: body => ({ method: body.method }),
    startRecording: async body => { calls.push(['start', body]); return { recordingId: body.recordingId, active: true, trackCount: 1, manifestKey: `${body.recordingId}/manifest.json` }; },
    stopRecording: async body => { calls.push(['stop', body]); throw new RecordingFailure('RECORDING_NOT_FOUND', 404); },
    listRecordings: async body => { calls.push(['list', body]); return { recordings: [], usedBytes: 0 }; },
    deleteRecording: async body => { calls.push(['delete', body]); return { recordingId: body.recordingId, deleted: true }; },
    listSpaceRecordings: async body => { calls.push(['list-space', body]); return { recordings: [], usedBytes: 0 }; },
    recordingMetadata: async body => { calls.push(['metadata', body]); throw new RecordingFailure('RECORDING_NOT_FOUND', 404); },
    recordingTranscript: async body => { calls.push(['transcript', body]); return { recordingId: body.recordingId, generatedAt: 1, segments: [] }; },
    deleteSpaceRecording: async body => { calls.push(['delete-space', body]); return { recordingId: body.recordingId, deleted: true }; },
    openRecordingTrack: async () => { throw new RecordingFailure('RECORDING_NOT_FOUND', 404); },
  };
  const server = createControlServer({ engine, token: TOKEN });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const unauthenticated = await fetch(`${base}/v1/recording/start`, { method: 'POST', body: '{}' });
    assert.equal(unauthenticated.status, 401);
    assert.deepEqual(calls, []);

    const body = { recordingId: '123e4567-e89b-42d3-a456-426614174000', worldId: 'world-1', domain: 'space-1:map-1/revision-7/private:meeting', sources: ['MICROPHONE'], participants: [{ playerId: 'alice', epoch: 1 }] };
    const started = await fetch(`${base}/v1/recording/start`, { method: 'POST', headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal(started.status, 200);
    assert.deepEqual(await started.json(), { recordingId: body.recordingId, active: true, trackCount: 1, manifestKey: `${body.recordingId}/manifest.json` });
    assert.deepEqual(calls[0], ['start', body]);

    const stopped = await fetch(`${base}/v1/recording/stop`, { method: 'POST', headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ recordingId: body.recordingId, worldId: body.worldId }) });
    assert.equal(stopped.status, 404);
    assert.deepEqual(await stopped.json(), { code: 'RECORDING_NOT_FOUND', message: '녹화 세션을 찾을 수 없어요.' });
    assert.equal(calls[1][0], 'stop');

    const scope = { worldId: body.worldId, domain: body.domain };
    const listed = await fetch(`${base}/v1/recording/list`, { method: 'POST', headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify(scope) });
    assert.equal(listed.status, 200);
    assert.deepEqual(await listed.json(), { recordings: [], usedBytes: 0 });
    assert.deepEqual(calls[2], ['list', scope]);

    const deleted = await fetch(`${base}/v1/recording/delete`, { method: 'POST', headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ ...scope, recordingId: body.recordingId }) });
    assert.equal(deleted.status, 200);
    assert.deepEqual(await deleted.json(), { recordingId: body.recordingId, deleted: true });
    assert.deepEqual(calls[3], ['delete', { ...scope, recordingId: body.recordingId }]);

    const spaceScope = { spaceId: '123e4567-e89b-42d3-a456-426614174010' };
    const spaceList = await fetch(`${base}/v1/recording/list-space`, { method: 'POST', headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify(spaceScope) });
    assert.equal(spaceList.status, 200);
    assert.deepEqual(await spaceList.json(), { recordings: [], usedBytes: 0 });
    assert.deepEqual(calls[4], ['list-space', spaceScope]);

    const metadataBody = { recordingId: body.recordingId };
    const metadata = await fetch(`${base}/v1/recording/metadata`, { method: 'POST', headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify(metadataBody) });
    assert.equal(metadata.status, 404);
    assert.deepEqual(calls[5], ['metadata', metadataBody]);

    const transcript = await fetch(`${base}/v1/recording/transcript/${body.recordingId}`, { headers: { Authorization: `Bearer ${TOKEN}` } });
    assert.equal(transcript.status, 200);
    assert.deepEqual(await transcript.json(), { recordingId: body.recordingId, generatedAt: 1, segments: [] });
    assert.deepEqual(calls[6], ['transcript', metadataBody]);

    const deleteSpaceBody = { ...spaceScope, recordingId: body.recordingId };
    const deleteSpace = await fetch(`${base}/v1/recording/delete-space`, { method: 'POST', headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify(deleteSpaceBody) });
    assert.equal(deleteSpace.status, 200);
    assert.deepEqual(await deleteSpace.json(), { recordingId: body.recordingId, deleted: true });
    assert.deepEqual(calls[7], ['delete-space', deleteSpaceBody]);

    const noPublicFileRoute = await fetch(`${base}/v1/recording/${body.recordingId}`, { headers: { Authorization: `Bearer ${TOKEN}` } });
    assert.equal(noPublicFileRoute.status, 404);
    const noPublicTrackRoute = await fetch(`${base}/recording/file/${body.recordingId}/123e4567-e89b-42d3-a456-426614174099`, { headers: { Authorization: `Bearer ${TOKEN}` } });
    assert.equal(noPublicTrackRoute.status, 404);
    const health = await fetch(`${base}/health`);
    assert.equal(health.status, 200);
  } finally {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
test('space recording and file routes require bearer auth', async () => {
  const engine = {
    apply: body => body,
    revoke: body => body,
    rpc: body => body,
    listSpaceRecordings: async () => ({ recordings: [], usedBytes: 0 }),
    recordingMetadata: async () => ({}),
    deleteSpaceRecording: async () => ({}),
    openRecordingTrack: async () => { throw new Error('must not be called'); },
  };
  const server = createControlServer({ engine, token: TOKEN });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const headers = { 'Content-Type': 'application/json' };
    for (const [url, body] of [
      ['/v1/recording/list-space', { spaceId: '123e4567-e89b-42d3-a456-426614174010' }],
      ['/v1/recording/metadata', { recordingId: '123e4567-e89b-42d3-a456-426614174000' }],
      ['/v1/recording/delete-space', { spaceId: '123e4567-e89b-42d3-a456-426614174010', recordingId: '123e4567-e89b-42d3-a456-426614174000' }],
    ]) {
      const response = await fetch(`${base}${url}`, { method: 'POST', headers, body: JSON.stringify(body) });
      assert.equal(response.status, 401);
    }
    const file = await fetch(`${base}/v1/recording/file/123e4567-e89b-42d3-a456-426614174000/123e4567-e89b-42d3-a456-426614174099`);
    assert.equal(file.status, 401);
    const transcript = await fetch(`${base}/v1/recording/transcript/123e4567-e89b-42d3-a456-426614174000`);
    assert.equal(transcript.status, 401);
  } finally {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});

test('aggregate media metrics are public to the internal scraper and omit identifiers', async () => {
  const worldId = 'private-world-id';
  const playerId = 'private-player-id';
  const engine = {
    worlds: new Map([[worldId, { peers: new Map([
      [playerId, {
        closed: false,
        producers: new Map([
          ['MICROPHONE', { closed: false }],
          ['CAMERA', { closed: true }],
          ['SCREEN', { closed: false }],
        ]),
        consumers: new Map([
          ['consumer-active', { source: 'MICROPHONE', resource: { closed: false }, producer: { closed: false } }],
          ['consumer-ended', { source: 'CAMERA', resource: { closed: true }, producer: { closed: false } }],
        ]),
      }],
      ['stale-player-id', { closed: true, producers: new Map([['MICROPHONE', { closed: false }]]), consumers: new Map() }],
    ]) }]]),
    valid: peer => !peer.closed,
    recordings: {
      sessions: new Map([
        ['recording-active-id', { state: 'RECORDING' }],
        ['recording-complete-id', { state: 'COMPLETED' }],
      ]),
      maxActiveRecordings: 4,
      transcriptionJobs: new Map([['transcript-private-id', {}]]),
    },
  };
  const server = createControlServer({ engine, token: TOKEN });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/metrics`);
    const body = await response.text();
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /^text\/plain; version=0\.0\.4/);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.match(body, /hufs_media_active_worlds 1\n/);
    assert.match(body, /hufs_media_active_peers 1\n/);
    assert.match(body, /hufs_media_active_producers\{source="microphone"\} 1\n/);
    assert.match(body, /hufs_media_active_producers\{source="camera"\} 0\n/);
    assert.match(body, /hufs_media_active_producers\{source="screen"\} 1\n/);
    assert.match(body, /hufs_media_active_consumers\{source="microphone"\} 1\n/);
    assert.match(body, /hufs_media_active_consumers\{source="camera"\} 0\n/);
    assert.match(body, /hufs_media_active_recordings 1\n/);
    assert.match(body, /hufs_media_recording_capacity 4\n/);
    assert.match(body, /hufs_media_transcription_jobs_active 1\n/);
    for (const privateValue of [worldId, playerId, 'stale-player-id', 'recording-active-id', 'transcript-private-id', TOKEN])
      assert.equal(body.includes(privateValue), false, `metrics exposed ${privateValue}`);
  } finally {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});

test('internal finalized WebM route streams bytes and handles single, suffix, and invalid ranges', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'hufs-media-control-'));
  const content = Buffer.from('video-webm-range-payload');
  const file = path.join(root, 'track.webm');
  await writeFile(file, content);
  const calls = [];
  const engine = {
    apply: body => body,
    revoke: body => body,
    rpc: body => body,
    openRecordingTrack: async (recordingId, trackId) => {
      calls.push([recordingId, trackId]);
      return { handle: await open(file, 'r'), size: content.length, source: 'CAMERA', sha256: 'f'.repeat(64) };
    },
  };
  const server = createControlServer({ engine, token: TOKEN });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}/v1/recording/file/123e4567-e89b-42d3-a456-426614174000/123e4567-e89b-42d3-a456-426614174099`;
  const headers = { Authorization: `Bearer ${TOKEN}` };
  try {
    const full = await fetch(base, { headers });
    assert.equal(full.status, 200);
    assert.equal(full.headers.get('content-type'), 'video/webm');
    assert.equal(full.headers.get('accept-ranges'), 'bytes');
    assert.deepEqual(Buffer.from(await full.arrayBuffer()), content);

    const partial = await fetch(base, { headers: { ...headers, Range: 'bytes=2-6' } });
    assert.equal(partial.status, 206);
    assert.equal(partial.headers.get('content-range'), `bytes 2-6/${content.length}`);
    assert.equal(partial.headers.get('content-length'), '5');
    assert.deepEqual(Buffer.from(await partial.arrayBuffer()), content.subarray(2, 7));

    const suffix = await fetch(base, { headers: { ...headers, Range: 'bytes=-4' } });
    assert.equal(suffix.status, 206);
    assert.deepEqual(Buffer.from(await suffix.arrayBuffer()), content.subarray(content.length - 4));

    for (const rangeHeader of ['bytes=999-', 'bytes=1-2,4-5', 'items=1-2', 'bytes=-0']) {
      const invalid = await fetch(base, { headers: { ...headers, Range: rangeHeader } });
      assert.equal(invalid.status, 416);
      assert.equal(invalid.headers.get('content-range'), `bytes */${content.length}`);
      assert.equal(await invalid.text(), '');
    }
    assert.equal(calls.length, 7);
  } finally {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
