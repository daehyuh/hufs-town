import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { RecordingFailure, RecordingManager } from '../src/recordings.mjs';
import { TranscriptionFailure } from '../src/transcription.mjs';

const DOMAIN = 'space-1:map-1/revision-7/private:meeting';
const WORLD_ID = 'world-1';
const RECORDING_ID = '123e4567-e89b-42d3-a456-426614174000';
const SPACE_ID = '123e4567-e89b-42d3-a456-426614174010';
const MAP_ID = '123e4567-e89b-42d3-a456-426614174011';
const MAP_REVISION = '123e4567-e89b-42d3-a456-426614174012';
const REQUESTER_ID = '123e4567-e89b-42d3-a456-426614174013';

async function fixture({ activeSources = { alice: ['MICROPHONE'], bob: ['MICROPHONE'] }, sources = ['MICROPHONE'], checkFfmpeg = async () => true, maxRecordingMs = 60_000, maxRecordingBytes = 4 * 1024 * 1024, spaceQuotaBytes = 10 * 1024 * 1024 * 1024, minFreeBytes = 1, maxRememberedStopResults, statfs, transcriber } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'hufs-recording-'));
  const now = { value: 1_800_000_000_000 };
  const files = [];
  const captures = [];
  const people = Object.entries(activeSources).map(([id, produced]) => {
    const producers = new Map(produced.map(source => [source, { id: `${id}-${source}`, closed: false }]));
    return {
      id,
      epoch: 1,
      domain: DOMAIN,
      sources: new Set(['MICROPHONE', 'CAMERA', 'SCREEN', 'SCREEN_AUDIO']),
      producers,
      world: null,
      expiresAt: now.value + 10_000,
      closed: false,
    };
  });
  const world = { id: WORLD_ID, peers: new Map(people.map(person => [person.id, person])) };
  for (const person of people) person.world = world;
  const manager = new RecordingManager({
    root,
    now: () => now.value,
    checkFfmpeg,
    maxRecordingMs,
    maxRecordingBytes,
    spaceQuotaBytes,
    minFreeBytes,
    ...(maxRememberedStopResults === undefined ? {} : { maxRememberedStopResults }),
    ...(transcriber ? { transcriber } : {}),
    ...(statfs ? { fsApi: { lstat, mkdir, open, realpath, statfs, readFile, readdir, rename, rm, stat, writeFile } } : {}),
    captureFactory: async context => {
      captures.push(context);
      return {
        async start() {},
        async stop() {
          const data = Buffer.from(`test-webm:${context.playerId}:${context.source}`);
          await writeFile(context.outputPath, data, { mode: 0o600 });
          files.push(context.outputPath);
          return { bytes: data.length, sha256: createHash('sha256').update(data).digest('hex') };
        },
      };
    },
  });
  const request = {
    recordingId: RECORDING_ID,
    worldId: WORLD_ID,
    domain: DOMAIN,
    spaceId: SPACE_ID,
    mapId: MAP_ID,
    mapRevision: MAP_REVISION,
    zoneId: 'meeting-a',
    requestedByUserId: REQUESTER_ID,
    sources,
    participants: people.map((person, index) => ({ playerId: person.id, userId: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`, name: person.id === 'alice' ? 'Alice' : person.id === 'bob' ? 'Bob' : person.id, epoch: person.epoch })),
  };
  const validPeer = peer => !peer.closed && peer.expiresAt > now.value && world.peers.get(peer.id) === peer;
  const getRouter = async () => ({});
  return { root, manager, world, people, request, validPeer, getRouter, files, captures, now };
}

async function dispose(root) { await rm(root, { recursive: true, force: true }); }

test('requires enabled transcription and a microphone source before requesting transcript consent', async () => {
  const disabled = await fixture();
  try {
    await assert.rejects(disabled.manager.start({ ...disabled.request, transcribe: true }, disabled.world, disabled.validPeer, disabled.getRouter), { code: 'RECORDING_TRANSCRIPTION_UNAVAILABLE' });
    await assert.rejects(disabled.manager.start({ ...disabled.request, sources: ['CAMERA'], transcribe: true }, disabled.world, disabled.validPeer, disabled.getRouter), { code: 'RECORDING_TRANSCRIPTION_UNAVAILABLE' });
    assert.deepEqual(await readdir(disabled.root), []);
  } finally { await dispose(disabled.root); }

  const enabled = await fixture({ transcriber: { enabled: true, transcribeTrack: async () => ({ segments: [] }) } });
  try {
    await assert.rejects(enabled.manager.start({ ...enabled.request, sources: ['CAMERA'], transcribe: true }, enabled.world, enabled.validPeer, enabled.getRouter), { code: 'RECORDING_TRANSCRIPTION_SOURCE_REQUIRED' });
    assert.deepEqual(await readdir(enabled.root), []);
  } finally { await dispose(enabled.root); }
});

test('queues opted-in microphone tracks, keeps speaker identity, and exposes a retained transcript', async () => {
  const calls = [];
  const f = await fixture({ transcriber: {
    enabled: true,
    async transcribeTrack(track) {
      calls.push(track);
      return { segments: [{ startMs: track.offsetMs + 10, endMs: track.offsetMs + 500, speakerName: track.speakerName, text: `Hello ${track.speakerName}` }] };
    },
  } });
  try {
    const request = { ...f.request, transcribe: true };
    await f.manager.start(request, f.world, f.validPeer, f.getRouter);
    await f.manager.stop({ recordingId: RECORDING_ID, worldId: WORLD_ID });
    await f.manager.transcriptionQueue;

    const listed = await f.manager.listSpaceCompleted({ spaceId: SPACE_ID });
    assert.equal(listed.transcriptionAvailable, true);
    assert.equal(listed.recordings[0].transcriptionStatus, 'READY');
    assert.deepEqual(calls.map(track => track.speakerName), ['Alice', 'Bob']);
    const transcript = await f.manager.transcript({ recordingId: RECORDING_ID });
    assert.equal(transcript.segments.length, 2);
    assert.deepEqual(transcript.segments.map(segment => segment.speakerName), ['Alice', 'Bob']);
    assert.match(transcript.notice, /AI/);
    const manifest = JSON.parse(await readFile(path.join(f.root, RECORDING_ID, 'manifest.json'), 'utf8'));
    assert.equal(manifest.transcriptionStatus, 'READY');
    assert.equal(manifest.transcriptionFailureCode, null);
    assert.ok((await stat(path.join(f.root, RECORDING_ID, 'transcript.json'))).size > 0);
  } finally { await dispose(f.root); }
});

test('records provider failures without exposing partial transcript output', async () => {
  const f = await fixture({ transcriber: {
    enabled: true,
    async transcribeTrack() { throw new TranscriptionFailure('TRANSCRIPTION_PROVIDER_FAILED'); },
  } });
  try {
    await f.manager.start({ ...f.request, transcribe: true }, f.world, f.validPeer, f.getRouter);
    await f.manager.stop({ recordingId: RECORDING_ID, worldId: WORLD_ID });
    await f.manager.transcriptionQueue;
    const listed = await f.manager.listSpaceCompleted({ spaceId: SPACE_ID });
    assert.equal(listed.recordings[0].transcriptionStatus, 'FAILED');
    await assert.rejects(f.manager.transcript({ recordingId: RECORDING_ID }), { code: 'RECORDING_TRANSCRIPT_NOT_READY' });
    await assert.rejects(stat(path.join(f.root, RECORDING_ID, 'transcript.json')), { code: 'ENOENT' });
  } finally { await dispose(f.root); }
});

test('cancels an in-flight transcription before deleting the retained recording', async () => {
  let started = false;
  const f = await fixture({ transcriber: {
    enabled: true,
    transcribeTrack: ({ signal }) => new Promise((resolve, reject) => {
      started = true;
      signal.addEventListener('abort', () => reject(new TranscriptionFailure('TRANSCRIPTION_CANCELLED')), { once: true });
    }),
  } });
  try {
    await f.manager.start({ ...f.request, transcribe: true }, f.world, f.validPeer, f.getRouter);
    await f.manager.stop({ recordingId: RECORDING_ID, worldId: WORLD_ID });
    for (let attempt = 0; attempt < 50 && !started; attempt++) await new Promise(resolve => setTimeout(resolve, 2));
    assert.equal(started, true);
    const deleted = await f.manager.deleteSpaceCompleted({ spaceId: SPACE_ID, recordingId: RECORDING_ID });
    assert.equal(deleted.deleted, true);
    await f.manager.transcriptionQueue;
    assert.deepEqual(await readdir(f.root), []);
    assert.equal(f.manager.transcriptionJobs.has(RECORDING_ID), false);
  } finally { await dispose(f.root); }
});

test('starts only for the exact private-room roster and records selected producers to private WebM files', async () => {
  const f = await fixture({ activeSources: { alice: ['MICROPHONE', 'CAMERA'], bob: ['MICROPHONE'] }, sources: ['MICROPHONE'] });
  try {
    const started = await f.manager.start(f.request, f.world, f.validPeer, f.getRouter);
    assert.deepEqual(started, { recordingId: RECORDING_ID, active: true, trackCount: 2, manifestKey: `${RECORDING_ID}/manifest.json` });
    assert.deepEqual(f.captures.map(capture => [capture.playerId, capture.source]), [['alice', 'MICROPHONE'], ['bob', 'MICROPHONE']]);
    const stopped = await f.manager.stop({ recordingId: RECORDING_ID, worldId: WORLD_ID });
    assert.equal(stopped.active, false);
    assert.equal(stopped.trackCount, 2);
    assert.equal(stopped.bytes, Buffer.byteLength('test-webm:alice:MICROPHONE') + Buffer.byteLength('test-webm:bob:MICROPHONE'));
    assert.match(stopped.sha256, /^[0-9a-f]{64}$/);
    for (const file of f.files) assert.ok((await stat(file)).size > 0);
    const manifest = JSON.parse(await readFile(path.join(f.root, RECORDING_ID, 'manifest.json'), 'utf8'));
    assert.equal(manifest.status, 'STOPPED');
    assert.equal(manifest.retentionDays, 30);
    assert.equal(manifest.retentionExpiresAt - manifest.startedAt, 30 * 24 * 60 * 60 * 1000);
    assert.equal(manifest.tracks.length, 2);
    assert.ok(manifest.tracks.every(track => track.status === 'FINALIZED' && track.source === 'MICROPHONE'));
    assert.ok(!JSON.stringify(stopped).includes(f.root));
  } finally { await dispose(f.root); }
});

test('rejects public, malformed, changed-roster, and disallowed-source requests before creating recording files', async () => {
  const f = await fixture();
  try {
    const publicRequest = { ...f.request, domain: 'space-1:map-1/revision-7/common' };
    await assert.rejects(f.manager.start(publicRequest, f.world, f.validPeer, f.getRouter), { code: 'RECORDING_PRIVATE_ROOM_REQUIRED' });
    await assert.rejects(f.manager.start({ ...f.request, sources: ['SCREEN_AUDIO'] }, f.world, f.validPeer, f.getRouter), { code: 'RECORDING_INVALID_REQUEST' });
    await assert.rejects(f.manager.start({ ...f.request, participants: f.request.participants.map((person, index) => ({ ...person, epoch: index === 0 ? 2 : person.epoch })) }, f.world, f.validPeer, f.getRouter), { code: 'RECORDING_ROSTER_CHANGED' });
    f.people[0].sources.delete('MICROPHONE');
    await assert.rejects(f.manager.start(f.request, f.world, f.validPeer, f.getRouter), { code: 'RECORDING_SOURCE_NOT_ALLOWED' });
    assert.deepEqual(await readdir(f.root), []);
  } finally { await dispose(f.root); }
});

test('does not create a directory when there is no selected active producer or FFmpeg is unavailable', async () => {
  const noTrack = await fixture({ activeSources: { alice: [], bob: [] } });
  try {
    await assert.rejects(noTrack.manager.start(noTrack.request, noTrack.world, noTrack.validPeer, noTrack.getRouter), { code: 'RECORDING_NO_ACTIVE_TRACKS' });
    assert.deepEqual(await readdir(noTrack.root), []);
  } finally { await dispose(noTrack.root); }

  const noFfmpeg = await fixture({ checkFfmpeg: async () => false });
  try {
    await assert.rejects(noFfmpeg.manager.start(noFfmpeg.request, noFfmpeg.world, noFfmpeg.validPeer, noFfmpeg.getRouter), { code: 'RECORDING_FFMPEG_UNAVAILABLE' });
    assert.deepEqual(await readdir(noFfmpeg.root), []);
  } finally { await dispose(noFfmpeg.root); }
});

test('applies server track limits and binds screen audio to the selected screen owner', async () => {
  const f = await fixture({ activeSources: { alice: ['SCREEN', 'SCREEN_AUDIO'], bob: ['SCREEN', 'SCREEN_AUDIO'] }, sources: ['SCREEN', 'SCREEN_AUDIO'] });
  try {
    const started = await f.manager.start(f.request, f.world, f.validPeer, f.getRouter);
    assert.equal(started.trackCount, 2);
    assert.deepEqual(f.captures.map(capture => [capture.playerId, capture.source]), [['alice', 'SCREEN'], ['alice', 'SCREEN_AUDIO']]);
  } finally {
    await f.manager.stop({ recordingId: RECORDING_ID, worldId: WORLD_ID });
    await dispose(f.root);
  }

  const activeSources = Object.fromEntries(Array.from({ length: 9 }, (_, index) => [`person-${index}`, ['CAMERA']]));
  const cameras = await fixture({ activeSources, sources: ['CAMERA'] });
  try {
    const started = await cameras.manager.start(cameras.request, cameras.world, cameras.validPeer, cameras.getRouter);
    assert.equal(started.trackCount, 8);
    assert.equal(cameras.captures.length, 8);
  } finally {
    await cameras.manager.stop({ recordingId: RECORDING_ID, worldId: WORLD_ID });
    await dispose(cameras.root);
  }
});

test('accepts the complete 100-person private-room roster while keeping recording output capped', async () => {
  const activeSources = Object.fromEntries(Array.from({ length: 100 }, (_, index) => [`person-${index}`, ['MICROPHONE']]));
  const f = await fixture({ activeSources, sources: ['MICROPHONE'] });
  try {
    const started = await f.manager.start(f.request, f.world, f.validPeer, f.getRouter);
    assert.equal(f.request.participants.length, 100);
    assert.equal(started.trackCount, 12);
    assert.equal(f.captures.length, 12);
    assert.ok(f.captures.every(capture => capture.maxBytes === 4 * 1024 * 1024));
  } finally {
    await f.manager.stop({ recordingId: RECORDING_ID, worldId: WORLD_ID });
    await dispose(f.root);
  }
});

test('stops and finalizes immediately when a participant epoch or selected producer changes', async () => {
  const f = await fixture();
  try {
    await f.manager.start(f.request, f.world, f.validPeer, f.getRouter);
    f.people[1].epoch += 1;
    f.manager.reconcile(f.world);
    await f.manager.sessions.get(RECORDING_ID).queue;
    const stopped = await f.manager.stop({ recordingId: RECORDING_ID, worldId: WORLD_ID });
    assert.equal(stopped.active, false);
    assert.equal(JSON.parse(await readFile(path.join(f.root, RECORDING_ID, 'manifest.json'), 'utf8')).endReason, 'participant-or-policy-changed');
  } finally { await dispose(f.root); }

  const producerGone = await fixture();
  try {
    await producerGone.manager.start(producerGone.request, producerGone.world, producerGone.validPeer, producerGone.getRouter);
    const peer = producerGone.people[0];
    const producer = peer.producers.get('MICROPHONE');
    producer.closed = true;
    await producerGone.manager.producerClosed(peer, 'MICROPHONE', producer);
    const stopped = await producerGone.manager.stop({ recordingId: RECORDING_ID, worldId: WORLD_ID });
    assert.equal(stopped.active, false);
    assert.equal(JSON.parse(await readFile(path.join(producerGone.root, RECORDING_ID, 'manifest.json'), 'utf8')).endReason, 'selected-producer-closed');
  } finally { await dispose(producerGone.root); }
});

test('max duration and low disk space finalize active recordings', async () => {
  const f = await fixture({ maxRecordingMs: 1000 });
  try {
    await f.manager.start(f.request, f.world, f.validPeer, f.getRouter);
    f.now.value += 1001;
    await f.manager.sweep();
    await f.manager.sessions.get(RECORDING_ID).queue;
    assert.equal(JSON.parse(await readFile(path.join(f.root, RECORDING_ID, 'manifest.json'), 'utf8')).endReason, 'maximum-duration');
  } finally { await dispose(f.root); }

  let freeBytes = 1_000_000;
  const lowDisk = await fixture({ statfs: async () => ({ bavail: freeBytes, bsize: 1 }), minFreeBytes: 10 });
  try {
    await lowDisk.manager.start(lowDisk.request, lowDisk.world, lowDisk.validPeer, lowDisk.getRouter);
    freeBytes = 0;
    lowDisk.now.value += 1001;
    await lowDisk.manager.sweep();
    await lowDisk.manager.sessions.get(RECORDING_ID).queue;
    assert.equal(JSON.parse(await readFile(path.join(lowDisk.root, RECORDING_ID, 'manifest.json'), 'utf8')).status, 'FAILED');
    assert.equal(JSON.parse(await readFile(path.join(lowDisk.root, RECORDING_ID, 'manifest.json'), 'utf8')).endReason, 'disk-space-low');
  } finally { await dispose(lowDisk.root); }
});

test('startup recovery marks unfinished recordings interrupted and purges artifacts after 30 days', async () => {
  const f = await fixture();
  try {
    await f.manager.start(f.request, f.world, f.validPeer, f.getRouter);
    const manifestPath = path.join(f.root, RECORDING_ID, 'manifest.json');
    const restarted = new RecordingManager({ root: f.root, now: () => f.now.value, checkFfmpeg: async () => true, captureFactory: async () => { throw new Error('must not capture'); } });
    await restarted.initialize();
    const recovered = JSON.parse(await readFile(manifestPath, 'utf8'));
    assert.equal(recovered.status, 'INTERRUPTED');
    assert.equal(recovered.endReason, 'service-restarted');

    recovered.retentionExpiresAt = f.now.value - 1;
    await writeFile(manifestPath, JSON.stringify(recovered));
    const expired = new RecordingManager({ root: f.root, now: () => f.now.value, checkFfmpeg: async () => true });
    await expired.initialize();
    assert.deepEqual(await readdir(f.root), []);
  } finally { await dispose(f.root); }
});

test('lists only retained completed files in the requested private-room scope and deletes the actual files', async () => {
  const f = await fixture();
  try {
    await f.manager.start(f.request, f.world, f.validPeer, f.getRouter);
    await assert.rejects(f.manager.deleteCompleted({ recordingId: RECORDING_ID, worldId: WORLD_ID, domain: DOMAIN }), { code: 'RECORDING_ACTIVE_DELETE_FORBIDDEN' });
    await assert.rejects(f.manager.listCompleted({ worldId: WORLD_ID, domain: 'space-1:map-1/revision-7/common' }), { code: 'RECORDING_INVALID_REQUEST' });
    const stopped = await f.manager.stop({ recordingId: RECORDING_ID, worldId: WORLD_ID });
    assert.equal(stopped.active, false);

    const listed = await f.manager.listCompleted({ worldId: WORLD_ID, domain: DOMAIN });
    assert.equal(listed.recordings.length, 1);
    assert.ok(listed.usedBytes > 0);
    assert.equal(listed.recordings[0].recordingId, RECORDING_ID);
    assert.equal(listed.recordings[0].trackCount, 2);
    assert.equal(listed.recordings[0].bytes, stopped.bytes);
    assert.equal(listed.usedBytes, stopped.bytes);
    assert.ok(!JSON.stringify(listed).includes(f.root));
    assert.deepEqual((await f.manager.listCompleted({ worldId: WORLD_ID, domain: 'space-1:map-1/revision-7/private:other' })).recordings, []);

    const deleted = await f.manager.deleteCompleted({ recordingId: RECORDING_ID, worldId: WORLD_ID, domain: DOMAIN });
    assert.deepEqual(deleted, { recordingId: RECORDING_ID, deleted: true });
    assert.equal(f.manager.sessions.has(RECORDING_ID), false);
    assert.deepEqual(await readdir(f.root), []);
    await assert.rejects(f.manager.deleteCompleted({ recordingId: RECORDING_ID, worldId: WORLD_ID, domain: DOMAIN }), { code: 'RECORDING_NOT_FOUND' });
  } finally { await dispose(f.root); }
});

test('persists World-trusted metadata and returns space-scoped metadata without player IDs', async () => {
  const f = await fixture();
  try {
    await f.manager.start(f.request, f.world, f.validPeer, f.getRouter);
    const activeManifest = JSON.parse(await readFile(path.join(f.root, RECORDING_ID, 'manifest.json'), 'utf8'));
    assert.equal(activeManifest.spaceId, SPACE_ID);
    assert.equal(activeManifest.mapId, MAP_ID);
    assert.equal(activeManifest.mapRevision, MAP_REVISION);
    assert.equal(activeManifest.zoneId, 'meeting-a');
    assert.equal(activeManifest.requestedByUserId, REQUESTER_ID);
    assert.deepEqual(activeManifest.participants.map(person => person.userId), f.request.participants.map(person => person.userId));
    await f.manager.stop({ recordingId: RECORDING_ID, worldId: WORLD_ID });

    const listed = await f.manager.listSpaceCompleted({ spaceId: SPACE_ID });
    assert.equal(listed.recordings.length, 1);
    assert.ok(listed.usedBytes > 0);
    assert.equal(listed.quotaBytes, 10 * 1024 * 1024 * 1024);
    const recording = listed.recordings[0];
    assert.deepEqual(Object.keys(recording).sort(), ['bytes', 'endedAt', 'mapId', 'mapRevision', 'participants', 'recordingId', 'requestedByUserId', 'retentionExpiresAt', 'sources', 'spaceId', 'startedAt', 'tracks', 'transcriptionStatus', 'zoneId'].sort());
    assert.equal(recording.recordingId, RECORDING_ID);
    assert.equal(recording.spaceId, SPACE_ID);
    assert.equal(recording.mapId, MAP_ID);
    assert.equal(recording.mapRevision, MAP_REVISION);
    assert.equal(recording.zoneId, 'meeting-a');
    assert.equal(recording.requestedByUserId, REQUESTER_ID);
    assert.equal(recording.transcriptionStatus, 'NOT_REQUESTED');
    assert.deepEqual(recording.participants, f.request.participants.map(person => person.userId));
    assert.ok(recording.tracks.every(track => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(track.trackId) && track.source === 'MICROPHONE' && track.bytes > 0 && /^[0-9a-f]{64}$/.test(track.sha256)));
    assert.ok(!JSON.stringify(recording).includes('playerId'));
    assert.ok(!JSON.stringify(recording).includes(f.root));
    assert.deepEqual(await f.manager.listSpaceCompleted({ spaceId: MAP_ID }), { recordings: [], usedBytes: 0, quotaBytes: 10 * 1024 * 1024 * 1024, transcriptionAvailable: false });
    assert.deepEqual(await f.manager.metadata({ recordingId: RECORDING_ID }), recording);
  } finally { await dispose(f.root); }
});

test('serializes per-space reservations so parallel recordings cannot exceed the storage quota', async () => {
  const f = await fixture({ spaceQuotaBytes: 4 * 1024 * 1024 });
  try {
    await f.manager.initialize();
    const peers = f.people.slice(0, 2);
    const worlds = peers.map(peer => ({ id: WORLD_ID, peers: new Map([[peer.id, peer]]) }));
    const requests = peers.map((peer, index) => {
      const domain = DOMAIN.replace('private:meeting', `private:meeting-${index}`);
      peer.domain = domain;
      return { ...f.request, recordingId: randomUUID(), domain, participants: [f.request.participants[index]] };
    });
    const results = await Promise.allSettled(requests.map((request, index) =>
      f.manager.start(request, worlds[index], f.validPeer, f.getRouter)));

    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    const rejected = results.find(result => result.status === 'rejected');
    assert.equal(rejected.reason.code, 'RECORDING_SPACE_QUOTA');
    assert.equal(f.manager.sessions.size, 1);
    const startedIndex = results.findIndex(result => result.status === 'fulfilled');
    await f.manager.stop({ recordingId: requests[startedIndex].recordingId, worldId: WORLD_ID });
  } finally { await dispose(f.root); }
});

test('space deletion enforces active, exact-space, and retention boundaries', async () => {
  const f = await fixture();
  try {
    await f.manager.start(f.request, f.world, f.validPeer, f.getRouter);
    await assert.rejects(f.manager.deleteSpaceCompleted({ spaceId: SPACE_ID, recordingId: RECORDING_ID }), { code: 'RECORDING_ACTIVE_DELETE_FORBIDDEN' });
    await f.manager.stop({ recordingId: RECORDING_ID, worldId: WORLD_ID });
    await assert.rejects(f.manager.deleteSpaceCompleted({ spaceId: MAP_ID, recordingId: RECORDING_ID }), { code: 'RECORDING_NOT_FOUND' });
    const manifestPath = path.join(f.root, RECORDING_ID, 'manifest.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    manifest.retentionExpiresAt = f.now.value - 1;
    await writeFile(manifestPath, JSON.stringify(manifest));
    await assert.rejects(f.manager.metadata({ recordingId: RECORDING_ID }), { code: 'RECORDING_NOT_FOUND' });
    await assert.rejects(f.manager.deleteSpaceCompleted({ spaceId: SPACE_ID, recordingId: RECORDING_ID }), { code: 'RECORDING_NOT_FOUND' });
  } finally { await dispose(f.root); }
});

test('rejects traversal or unsafe manifest track paths and opens only finalized retained tracks', async () => {
  const f = await fixture();
  try {
    await f.manager.start(f.request, f.world, f.validPeer, f.getRouter);
    const activeTrack = [...f.manager.sessions.get(RECORDING_ID).tracks.values()][0];
    await assert.rejects(f.manager.openCompletedTrack(RECORDING_ID, activeTrack.trackId), { code: 'RECORDING_NOT_FOUND' });
    await f.manager.stop({ recordingId: RECORDING_ID, worldId: WORLD_ID });
    const opened = await f.manager.openCompletedTrack(RECORDING_ID, activeTrack.trackId);
    try {
      assert.ok(opened.size > 0);
      assert.equal(opened.source, 'MICROPHONE');
      const buffer = Buffer.alloc(opened.size);
      await opened.handle.read(buffer, 0, buffer.length, 0);
      assert.ok(buffer.toString().startsWith('test-webm:'));
    } finally { await opened.handle.close(); }

    const manifestPath = path.join(f.root, RECORDING_ID, 'manifest.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    manifest.tracks[0].fileKey = `tracks/../../${activeTrack.trackId}.webm`;
    await writeFile(manifestPath, JSON.stringify(manifest));
    await assert.rejects(f.manager.openCompletedTrack(RECORDING_ID, activeTrack.trackId), { code: 'RECORDING_NOT_FOUND' });
  } finally { await dispose(f.root); }
});

test('strictly validates trusted metadata UUIDs and participant identities', async () => {
  const f = await fixture();
  try {
    for (const [key, value] of [['spaceId', '../space'], ['mapId', 'map-1'], ['mapRevision', 'revision-7'], ['requestedByUserId', 'alice']]) {
      await assert.rejects(f.manager.start({ ...f.request, [key]: value }, f.world, f.validPeer, f.getRouter), { code: 'RECORDING_INVALID_REQUEST' });
    }
    await assert.rejects(f.manager.start({ ...f.request, participants: [{ ...f.request.participants[0], userId: 'alice' }, f.request.participants[1]] }, f.world, f.validPeer, f.getRouter), { code: 'RECORDING_INVALID_REQUEST' });
    assert.deepEqual(await readdir(f.root), []);
  } finally { await dispose(f.root); }
});

test('releases completed media references and bounds idempotent stop results', async () => {
  const f = await fixture({ maxRememberedStopResults: 2 });
  const ids = [
    RECORDING_ID,
    '223e4567-e89b-42d3-a456-426614174001',
    '323e4567-e89b-42d3-a456-426614174002',
  ];
  try {
    const results = [];
    const completedSessions = [];
    for (const recordingId of ids) {
      const request = { ...f.request, recordingId };
      await f.manager.start(request, f.world, f.validPeer, f.getRouter);
      const session = f.manager.sessions.get(recordingId);
      const result = await f.manager.stop({ recordingId, worldId: WORLD_ID });
      results.push(result);
      completedSessions.push(session);

      assert.equal(f.manager.sessions.has(recordingId), false);
      assert.equal(session.world, null);
      assert.equal(session.validPeer, null);
      assert.equal(session.getRouter, null);
      assert.equal(session.tracks.size, 0);
      assert.deepEqual(session.participants, []);
      assert.deepEqual(session.sources, []);
      assert.deepEqual(await f.manager.stop({ recordingId, worldId: WORLD_ID }), result);
    }

    assert.equal(f.manager.completedStopResults.size, 2);
    await assert.rejects(f.manager.stop({ recordingId: ids[0], worldId: WORLD_ID }), { code: 'RECORDING_NOT_FOUND' });
    assert.deepEqual(await f.manager.stop({ recordingId: ids[1], worldId: WORLD_ID }), results[1]);
    assert.deepEqual(await f.manager.stop({ recordingId: ids[2], worldId: WORLD_ID }), results[2]);
    assert.ok(completedSessions.every(session => session.world === null && session.tracks.size === 0));
  } finally { await dispose(f.root); }
});

test('maps storage failures to stable errors without exposing filesystem paths', async () => {
  const f = await fixture({ statfs: async () => ({ bavail: 0, bsize: 1 }), minFreeBytes: 10 });
  try {
    await assert.rejects(f.manager.start(f.request, f.world, f.validPeer, f.getRouter), error => {
      assert.ok(error instanceof RecordingFailure);
      assert.equal(error.code, 'RECORDING_STORAGE_UNAVAILABLE');
      assert.ok(!error.message.includes(f.root));
      return true;
    });
    assert.deepEqual(await readdir(f.root), []);
  } finally { await dispose(f.root); }
});
