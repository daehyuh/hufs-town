import { createHash, randomUUID } from 'node:crypto';
import { SpeechTranscriber, TranscriptionFailure } from './transcription.mjs';
import { createSocket } from 'node:dgram';
import { constants as fsConstants } from 'node:fs';
import { lstat, mkdir, open, readFile, readdir, realpath, rename, rm, stat, statfs, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';

const SOURCE_KIND = new Map([
  ['MICROPHONE', 'audio'],
  ['CAMERA', 'video'],
  ['SCREEN', 'video'],
  ['SCREEN_AUDIO', 'audio'],
]);
const RECORDING_SOURCE_LIMITS = { MICROPHONE: 12, CAMERA: 8, SCREEN: 1, SCREEN_AUDIO: 1 };
const RECORDING_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MEDIA_ID = /^[a-zA-Z0-9_./:-]{1,256}$/;
const SPACE_METADATA_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ZONE_ID = /^[a-zA-Z0-9_.:-]{1,128}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const PRIVATE_DOMAIN = /^[a-zA-Z0-9_.:-]{1,256}:[a-zA-Z0-9_.:-]{1,256}\/[a-zA-Z0-9_.:-]{1,256}\/private:[a-zA-Z0-9_.:-]{1,128}$/;
const RETENTION_DAYS = 30;
const RETENTION_MS = RETENTION_DAYS * 24 * 60 * 60 * 1000;
const text = {
  RECORDING_INVALID_REQUEST: '녹화 요청 형식을 확인해 주세요.',
  RECORDING_PRIVATE_ROOM_REQUIRED: '비공개 회의실에서만 녹화할 수 있어요.',
  RECORDING_ROSTER_CHANGED: '회의 참가자나 미디어 권한이 바뀌었어요. 동의를 다시 받아 주세요.',
  RECORDING_SOURCE_NOT_ALLOWED: '선택한 미디어를 녹화할 권한이 없어요.',
  RECORDING_NO_ACTIVE_TRACKS: '녹화할 수 있는 활성 미디어가 없어요.',
  RECORDING_ALREADY_ACTIVE: '이 회의실은 이미 녹화 중이에요.',
  RECORDING_NOT_FOUND: '녹화 세션을 찾을 수 없어요.',
  RECORDING_ACTIVE_DELETE_FORBIDDEN: '진행 중인 녹화는 삭제할 수 없어요.',
  RECORDING_STORAGE_UNAVAILABLE: '녹화 저장소를 사용할 수 없어요.',
  RECORDING_QUOTA_EXCEEDED: '녹화 저장 한도에 도달했어요.',
  RECORDING_FFMPEG_UNAVAILABLE: '녹화 엔진을 사용할 수 없어요.',
  RECORDING_CAPTURE_FAILED: '미디어 녹화를 시작하거나 마무리하지 못했어요.',
  RECORDING_CAPACITY: '녹화 서버가 바빠요. 잠시 후 다시 시도해 주세요.',
  RECORDING_TRANSCRIPTION_UNAVAILABLE: '음성 자막 기능을 사용할 수 없어요.',
  RECORDING_TRANSCRIPTION_SOURCE_REQUIRED: '음성 자막을 만들려면 마이크 녹음을 선택해야 해요.',
  RECORDING_TRANSCRIPT_NOT_READY: '아직 자막을 불러올 수 없어요.',
};

export class RecordingFailure extends Error {
  constructor(code, status = 400) {
    super(text[code] ?? '녹화를 처리하지 못했어요.');
    this.code = code;
    this.status = status;
  }
}

function fail(code, status) { throw new RecordingFailure(code, status); }

function expiryFor(manifest, directoryMtime = 0) {
  const recordedExpiry = Number(manifest?.retentionExpiresAt);
  if (Number.isFinite(recordedExpiry) && recordedExpiry > 0) return recordedExpiry;
  const startedAt = Number(manifest?.startedAt);
  if (Number.isFinite(startedAt) && startedAt > 0) return startedAt + RETENTION_MS;
  return directoryMtime + RETENTION_MS;
}

function validateStart(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)
    || typeof body.recordingId !== 'string' || !RECORDING_ID.test(body.recordingId)
    || typeof body.worldId !== 'string' || !MEDIA_ID.test(body.worldId)
    || typeof body.domain !== 'string' || !MEDIA_ID.test(body.domain)
    || typeof body.spaceId !== 'string' || !SPACE_METADATA_ID.test(body.spaceId)
    || typeof body.mapId !== 'string' || !SPACE_METADATA_ID.test(body.mapId)
    || typeof body.mapRevision !== 'string' || !SPACE_METADATA_ID.test(body.mapRevision)
    || typeof body.zoneId !== 'string' || !ZONE_ID.test(body.zoneId)
    || typeof body.requestedByUserId !== 'string' || !SPACE_METADATA_ID.test(body.requestedByUserId)
    || !Array.isArray(body.sources) || body.sources.length < 1 || body.sources.length > 4
    || body.sources.some(source => !SOURCE_KIND.has(source)) || new Set(body.sources).size !== body.sources.length
    || (body.sources.includes('SCREEN_AUDIO') && !body.sources.includes('SCREEN'))
    || (body.transcribe !== undefined && typeof body.transcribe !== 'boolean')
    || !Array.isArray(body.participants) || body.participants.length < 1 || body.participants.length > 100) {
    fail('RECORDING_INVALID_REQUEST', 400);
  }
  const ids = new Set();
  const userIds = new Set();
  for (const participant of body.participants) {
    if (!participant || typeof participant.playerId !== 'string' || !MEDIA_ID.test(participant.playerId)
      || typeof participant.userId !== 'string' || !SPACE_METADATA_ID.test(participant.userId)
      || (participant.name !== undefined && (typeof participant.name !== 'string' || participant.name.length > 80))
      || !Number.isSafeInteger(participant.epoch) || participant.epoch < 1 || ids.has(participant.playerId)
      || userIds.has(participant.userId))
      fail('RECORDING_INVALID_REQUEST', 400);
    ids.add(participant.playerId);
    userIds.add(participant.userId);
  }
}

function validateStop(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)
    || typeof body.recordingId !== 'string' || !RECORDING_ID.test(body.recordingId)
    || typeof body.worldId !== 'string' || !MEDIA_ID.test(body.worldId))
    fail('RECORDING_INVALID_REQUEST', 400);
}

function validateRecordingScope(body, { requireId = false } = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)
    || typeof body.worldId !== 'string' || !MEDIA_ID.test(body.worldId)
    || typeof body.domain !== 'string' || !MEDIA_ID.test(body.domain)
    || !PRIVATE_DOMAIN.test(body.domain)
    || (requireId && (typeof body.recordingId !== 'string' || !RECORDING_ID.test(body.recordingId))))
    fail('RECORDING_INVALID_REQUEST', 400);
}

function validateSpaceScope(body, { requireId = false } = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)
    || typeof body.spaceId !== 'string' || !SPACE_METADATA_ID.test(body.spaceId)
    || (requireId && (typeof body.recordingId !== 'string' || !RECORDING_ID.test(body.recordingId))))
    fail('RECORDING_INVALID_REQUEST', 400);
}

function isWithin(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function rosterMatches(world, domain, participants, validPeer) {
  const expected = new Map(participants.map(person => [person.playerId, person.epoch]));
  const actual = [...world.peers.values()].filter(person => validPeer(person) && person.domain === domain);
  return actual.length === expected.size && actual.every(person => expected.get(person.id) === person.epoch);
}

function selectedActiveProducers(participants, sources) {
  const requested = new Set(sources);
  const candidates = new Map();
  for (const source of requested) candidates.set(source, participants
    .map(peer => ({ peer, source, producer: peer.producers.get(source) }))
    .filter(entry => entry.producer && !entry.producer.closed)
    .sort((left, right) => left.peer.id.localeCompare(right.peer.id)));
  const screenOwner = candidates.get('SCREEN')?.[0]?.peer.id;
  const selected = [];
  for (const source of ['MICROPHONE', 'CAMERA', 'SCREEN', 'SCREEN_AUDIO']) {
    if (!requested.has(source)) continue;
    let options = candidates.get(source) ?? [];
    if (source === 'SCREEN_AUDIO') options = screenOwner ? options.filter(entry => entry.peer.id === screenOwner) : [];
    selected.push(...options.slice(0, RECORDING_SOURCE_LIMITS[source]));
  }
  return selected;
}

function formatSdp(consumer, port) {
  const codec = consumer.rtpParameters?.codecs?.find(value => !/\/rtx$/i.test(value.mimeType ?? ''));
  if (!codec || !Number.isInteger(codec.payloadType) || !Number.isInteger(codec.clockRate))
    fail('RECORDING_CAPTURE_FAILED', 503);
  const kind = consumer.kind;
  const channels = kind === 'audio' ? `/${codec.clockRate}/${codec.channels || 2}` : `/${codec.clockRate}`;
  const lines = [
    'v=0',
    'o=- 0 0 IN IP4 127.0.0.1',
    's=HUFS Town private-room recording',
    'c=IN IP4 127.0.0.1',
    't=0 0',
    `m=${kind} ${port} RTP/AVP ${codec.payloadType}`,
    `a=rtpmap:${codec.payloadType} ${codec.mimeType.split('/')[1]}${channels}`,
    'a=recvonly',
    'a=rtcp-mux',
  ];
  const parameters = codec.parameters && typeof codec.parameters === 'object'
    ? Object.entries(codec.parameters).filter(([key, value]) => /^[a-zA-Z0-9_-]+$/.test(key) && /^[a-zA-Z0-9_.-]+$/.test(String(value))).map(([key, value]) => `${key}=${value}`).join(';')
    : '';
  if (parameters) lines.push(`a=fmtp:${codec.payloadType} ${parameters}`);
  return `${lines.join('\r\n')}\r\n`;
}

async function reserveUdpPort() {
  const socket = createSocket('udp4');
  await new Promise((resolve, reject) => {
    socket.once('error', reject);
    socket.bind(0, '127.0.0.1', resolve);
  });
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  return port;
}

/** One FFmpeg process and one private WebM file per currently selected producer. */
export class FfmpegRtpCapture {
  constructor({ router, producer, outputPath, maxBytes, ffmpegPath = process.env.MEDIA_FFMPEG_PATH || 'ffmpeg', spawnProcess = spawn, fsApi = { writeFile, rm, stat, rename }, onFailure = () => {} }) {
    Object.assign(this, { router, producer, outputPath, maxBytes, ffmpegPath, spawnProcess, fsApi, onFailure });
    this.transport = null;
    this.consumer = null;
    this.child = null;
    this.sdpPath = null;
    this.started = false;
    this.stopping = false;
    this.stderr = '';
  }

  async start() {
    const port = await reserveUdpPort();
    const temporaryPath = `${this.outputPath}.part`;
    const sdpPath = `${this.outputPath}.${randomUUID()}.sdp`;
    this.sdpPath = sdpPath;
    try {
      this.transport = await this.router.createPlainTransport({
        listenInfo: { protocol: 'udp', ip: '127.0.0.1' },
        rtcpMux: true,
        comedia: false,
      });
      if (!this.router.canConsume({ producerId: this.producer.id, rtpCapabilities: this.router.rtpCapabilities }))
        fail('RECORDING_CAPTURE_FAILED', 503);
      this.consumer = await this.transport.consume({
        producerId: this.producer.id,
        rtpCapabilities: this.router.rtpCapabilities,
        paused: true,
      });
      await this.fsApi.writeFile(sdpPath, formatSdp(this.consumer, port), { mode: 0o600 });
      const args = [
        '-hide_banner', '-loglevel', 'error', '-stdin',
        '-protocol_whitelist', 'file,udp,rtp',
        '-i', sdpPath,
        '-map', '0', '-c', 'copy', '-f', 'webm', '-fs', String(this.maxBytes), '-y', temporaryPath,
      ];
      this.child = this.spawnProcess(this.ffmpegPath, args, { stdio: ['pipe', 'ignore', 'pipe'], windowsHide: true });
      this.child.stdin?.on('error', () => {});
      const spawned = new Promise((resolve, reject) => {
        this.child.once('spawn', resolve);
        this.child.once('error', reject);
      });
      this.child.stderr?.on('data', chunk => { this.stderr = (this.stderr + chunk.toString()).slice(-2048); });
      this.closed = new Promise(resolve => this.child.once('close', (code, signal) => {
        resolve({ code, signal });
        if (!this.stopping && this.started) this.onFailure(code === 0 ? 'quota' : 'process-exit');
      }));
      await spawned;
      await this.transport.connect({ ip: '127.0.0.1', port });
      await this.consumer.resume();
      if (this.child.exitCode != null || this.child.signalCode != null) fail('RECORDING_CAPTURE_FAILED', 503);
      this.started = true;
    } catch (error) {
      await this.fsApi.rm(sdpPath, { force: true }).catch(() => {});
      await this.stop('start-failed').catch(() => {});
      if (error instanceof RecordingFailure) throw error;
      fail('RECORDING_CAPTURE_FAILED', 503);
    }
  }

  async stop(reason = 'stopped') {
    if (this.stopping) return this.stopping;
    this.stopping = (async () => {
      if (this.child && this.child.exitCode == null && this.child.signalCode == null) {
        try { this.child.stdin?.write('q\n'); this.child.stdin?.end(); } catch { /* The process may have already exited. */ }
        let timer;
        const timeout = new Promise(resolve => { timer = setTimeout(() => resolve('timeout'), 3000); });
        const outcome = await Promise.race([this.closed.then(() => 'closed'), timeout]);
        clearTimeout(timer);
        if (outcome === 'timeout' && this.child.exitCode == null && this.child.signalCode == null) {
          this.child.kill('SIGINT');
          let secondTimer;
          const secondTimeout = new Promise(resolve => { secondTimer = setTimeout(() => resolve('timeout'), 3000); });
          const secondOutcome = await Promise.race([this.closed.then(() => 'closed'), secondTimeout]);
          clearTimeout(secondTimer);
          if (secondOutcome === 'timeout' && this.child.exitCode == null && this.child.signalCode == null) {
            this.child.kill('SIGKILL');
            await this.closed;
          }
        }
      }
      const stats = await this.consumer?.getStats?.().catch(() => []) ?? [];
      const rtpPackets = stats.reduce((sum, item) => sum + Number(item.packetCount ?? item.rtpPacketsReceived ?? 0), 0);
      const rtpBytes = stats.reduce((sum, item) => sum + Number(item.byteCount ?? item.rtpBytesReceived ?? 0), 0);
      this.consumer?.close();
      this.transport?.close();
      if (this.sdpPath) await this.fsApi.rm(this.sdpPath, { force: true }).catch(() => {});
      const temporaryPath = `${this.outputPath}.part`;
      try {
        const info = await this.fsApi.stat(temporaryPath);
        if (info.size > 0) await this.fsApi.rename(temporaryPath, this.outputPath);
        else await this.fsApi.rm(temporaryPath, { force: true });
      } catch { /* A failed start may have no output yet. */ }
      try {
        const info = await this.fsApi.stat(this.outputPath);
        if (!info.isFile() || info.size < 1) return { bytes: 0, sha256: '', reason, rtpPackets, rtpBytes };
        const data = await readFile(this.outputPath);
        return { bytes: info.size, sha256: createHash('sha256').update(data).digest('hex'), reason, rtpPackets, rtpBytes };
      } catch {
        return { bytes: 0, sha256: '', reason, rtpPackets, rtpBytes };
      }
    })();
    return this.stopping;
  }
}

export class RecordingManager {
  constructor({
    root = process.env.MEDIA_RECORDINGS_ROOT || '/data/recordings',
    ffmpegPath = process.env.MEDIA_FFMPEG_PATH || 'ffmpeg',
    now = Date.now,
    fsApi = { lstat, mkdir, open, readFile, readdir, realpath, rename, rm, stat, statfs, writeFile },
    checkFfmpeg = () => checkExecutable(ffmpegPath),
    captureFactory,
    maxRecordingMs = Number(process.env.MEDIA_RECORDING_MAX_DURATION_MS || 60 * 60 * 1000),
    maxRecordingBytes = Number(process.env.MEDIA_RECORDING_MAX_BYTES || 1024 * 1024 * 1024),
    spaceQuotaBytes = Number(process.env.MEDIA_RECORDING_SPACE_MAX_BYTES || 10 * 1024 * 1024 * 1024),
    minFreeBytes = Number(process.env.MEDIA_RECORDING_MIN_FREE_BYTES || 128 * 1024 * 1024),
    maxActiveRecordings = Number(process.env.MEDIA_RECORDING_MAX_ACTIVE || 4),
    maxRememberedStopResults = 128,
    retentionSweepMs = 60 * 60 * 1000,
    transcriber,
  } = {}) {
    Object.assign(this, { root, ffmpegPath, now, fsApi, checkFfmpeg, captureFactory, maxRecordingMs, maxRecordingBytes, spaceQuotaBytes, minFreeBytes, maxActiveRecordings, maxRememberedStopResults, retentionSweepMs });
    this.sessions = new Map();
    this.completedStopResults = new Map();
    this.byDomain = new Map();
    this.spaceReservationLocks = new Map();
    this.pendingSpaceReservations = new Map();
    this.transcriber = transcriber ?? new SpeechTranscriber({ ffmpegPath });
    this.transcriptionJobs = new Map();
    this.cancelledTranscriptions = new Set();
    this.transcriptionQueue = Promise.resolve();
    this.initialized = false;
    this.lastRetentionSweepAt = 0;
  }

  async initialize() {
    try {
      await this.fsApi.mkdir(this.root, { recursive: true, mode: 0o700 });
      const entries = await this.fsApi.readdir(this.root, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory() || !RECORDING_ID.test(entry.name)) continue;
        const directory = path.resolve(this.root, entry.name);
        if (path.dirname(directory) !== path.resolve(this.root)) continue;
        const file = path.join(directory, 'manifest.json');
        try {
          const manifest = JSON.parse(await this.fsApi.readFile(file, 'utf8'));
          if (manifest.recordingId !== entry.name) continue;
          if (expiryFor(manifest, (await this.fsApi.stat(directory)).mtimeMs) <= this.now()) {
            await this.fsApi.rm(directory, { recursive: true, force: true });
            continue;
          }
          if (['QUEUED', 'PROCESSING'].includes(manifest.transcriptionStatus)) {
            manifest.transcriptionStatus = 'FAILED';
            manifest.transcriptionFailureCode = 'TRANSCRIPTION_INTERRUPTED';
            await this.writeManifestAt(file, manifest);
          }
          if (!['STARTING', 'RECORDING', 'STOPPING'].includes(manifest.status)) continue;
          manifest.status = 'INTERRUPTED';
          manifest.endedAt = this.now();
          manifest.endReason = 'service-restarted';
          await this.writeManifestAt(file, manifest);
        } catch {
          try {
            if ((await this.fsApi.stat(directory)).mtimeMs + RETENTION_MS <= this.now())
              await this.fsApi.rm(directory, { recursive: true, force: true });
          } catch { /* Keep an unreadable recent artifact private; never expose it. */ }
        }
      }
      this.initialized = true;
    } catch {
      fail('RECORDING_STORAGE_UNAVAILABLE', 507);
    }
  }

  async start(body, world, validPeer, getRouter) {
    validateStart(body);
    if (!PRIVATE_DOMAIN.test(body.domain)) fail('RECORDING_PRIVATE_ROOM_REQUIRED', 403);
    if (body.transcribe === true && !this.transcriber?.enabled) fail('RECORDING_TRANSCRIPTION_UNAVAILABLE', 503);
    if (body.transcribe === true && !body.sources.includes('MICROPHONE')) fail('RECORDING_TRANSCRIPTION_SOURCE_REQUIRED', 400);
    if (!world || world.id !== body.worldId) fail('RECORDING_ROSTER_CHANGED', 409);
    if (!this.initialized) await this.initialize();
    const domainKey = `${body.worldId}/${body.domain}`;
    if (this.byDomain.has(domainKey)) fail('RECORDING_ALREADY_ACTIVE', 409);
    if ([...this.sessions.values()].filter(session => session.state === 'RECORDING' || session.state === 'STARTING').length >= this.maxActiveRecordings)
      fail('RECORDING_CAPACITY', 503);
    const participants = body.participants.map(person => ({
      playerId: person.playerId,
      userId: person.userId,
      name: typeof person.name === 'string' ? [...person.name.trim()].slice(0, 20).join('') : '',
      epoch: person.epoch,
    }));
    if (!rosterMatches(world, body.domain, participants, validPeer)) fail('RECORDING_ROSTER_CHANGED', 409);
    const participantPeers = participants.map(person => world.peers.get(person.playerId));
    if (participantPeers.some(peer => body.sources.some(source => !peer.sources.has(source)))) fail('RECORDING_SOURCE_NOT_ALLOWED', 403);
    const activeProducers = selectedActiveProducers(participantPeers, body.sources);
    if (!activeProducers.length) fail('RECORDING_NO_ACTIVE_TRACKS', 409);

    await this.reserveSpace(body);
    let reservationPending = true;
    try {
      try {
        await this.ensureStorage();
        if (!await this.checkFfmpeg()) fail('RECORDING_FFMPEG_UNAVAILABLE', 503);
      } catch (error) {
        if (error instanceof RecordingFailure) throw error;
        fail('RECORDING_STORAGE_UNAVAILABLE', 507);
      }

      const directory = path.join(this.root, body.recordingId);
      try { await this.fsApi.mkdir(directory, { recursive: false, mode: 0o700 }); }
      catch { fail('RECORDING_STORAGE_UNAVAILABLE', 507); }
      const session = {
        id: body.recordingId,
        worldId: body.worldId,
        domain: body.domain,
        spaceId: body.spaceId,
        spaceReservationBytes: this.maxRecordingBytes + (body.transcribe === true ? 8 * 1024 * 1024 : 0),
        transcribe: body.transcribe === true,
        transcriptionStatus: body.transcribe === true ? 'QUEUED' : 'NOT_REQUESTED',
        transcriptionFailureCode: '',
        mapId: body.mapId,
        mapRevision: body.mapRevision,
        zoneId: body.zoneId,
        requestedByUserId: body.requestedByUserId,
        sources: [...body.sources],
        participants,
        createdAt: this.now(),
        retentionExpiresAt: this.now() + RETENTION_MS,
        directory,
        manifestKey: `${body.recordingId}/manifest.json`,
        state: 'STARTING',
        endReason: '',
        tracks: new Map(),
        queue: Promise.resolve(),
        stopResult: null,
        lastQuotaCheckAt: 0,
        validPeer,
        world,
        getRouter,
      };
      this.sessions.set(session.id, session);
      this.byDomain.set(domainKey, session.id);
      this.pendingSpaceReservations.delete(body.recordingId);
      reservationPending = false;
      return this.serial(session, async () => {
        try {
          await this.writeManifest(session);
          for (const entry of activeProducers) await this.attachTrack(session, entry.peer, entry.source, entry.producer);
          if (!session.tracks.size) fail('RECORDING_NO_ACTIVE_TRACKS', 409);
          session.state = 'RECORDING';
          await this.writeManifest(session);
          return { recordingId: session.id, active: true, trackCount: session.tracks.size, manifestKey: session.manifestKey };
        } catch (error) {
          await this.finalize(session, 'start-failed', 'FAILED', { rememberStopResult: false });
          await this.fsApi.rm(directory, { recursive: true, force: true }).catch(() => {});
          this.sessions.delete(session.id);
          if (error instanceof RecordingFailure) throw error;
          fail('RECORDING_CAPTURE_FAILED', 503);
        }
      });
    } finally {
      if (reservationPending) this.pendingSpaceReservations.delete(body.recordingId);
    }
  }

  async reserveSpace(body) {
    if (!Number.isSafeInteger(this.maxRecordingBytes) || this.maxRecordingBytes < 1
      || !Number.isSafeInteger(this.spaceQuotaBytes) || this.spaceQuotaBytes < 0)
      fail('RECORDING_STORAGE_UNAVAILABLE', 507);
    return this.withSpaceReservationLock(body.spaceId, async () => {
      const { usedBytes } = await this.listSpaceCompleted({ spaceId: body.spaceId });
      let reservedBytes = 0;
      for (const session of this.sessions.values()) {
        if (session.spaceId === body.spaceId && ['STARTING', 'RECORDING', 'STOPPING'].includes(session.state))
          reservedBytes += session.spaceReservationBytes ?? this.maxRecordingBytes;
      }
      for (const reservation of this.pendingSpaceReservations.values())
        if (reservation.spaceId === body.spaceId) reservedBytes += reservation.bytes;
      const reservationBytes = this.maxRecordingBytes + (body.transcribe === true ? 8 * 1024 * 1024 : 0);
      if (reservationBytes > this.spaceQuotaBytes
        || usedBytes + reservedBytes + reservationBytes > this.spaceQuotaBytes)
        fail('RECORDING_SPACE_QUOTA', 409);
      this.pendingSpaceReservations.set(body.recordingId, { spaceId: body.spaceId, bytes: reservationBytes });
    });
  }

  async withSpaceReservationLock(spaceId, task) {
    const previous = this.spaceReservationLocks.get(spaceId) ?? Promise.resolve();
    let release;
    const current = new Promise(resolve => { release = resolve; });
    this.spaceReservationLocks.set(spaceId, current);
    await previous;
    try { return await task(); }
    finally {
      release();
      if (this.spaceReservationLocks.get(spaceId) === current) this.spaceReservationLocks.delete(spaceId);
    }
  }

  async stop(body) {
    validateStop(body);
    const session = this.sessions.get(body.recordingId);
    if (!session) {
      const completed = this.completedStopResults.get(body.recordingId);
      if (completed?.worldId === body.worldId) return completed.result;
      fail('RECORDING_NOT_FOUND', 404);
    }
    if (session.worldId !== body.worldId) fail('RECORDING_NOT_FOUND', 404);
    return this.serial(session, async () => {
      if (session.stopResult) return session.stopResult;
      await this.finalize(session, 'requested', 'STOPPED');
      return session.stopResult;
    });
  }

  async listCompleted(body) {
    validateRecordingScope(body);
    if (!this.initialized) await this.initialize();
    let entries;
    try { entries = await this.fsApi.readdir(this.root, { withFileTypes: true }); }
    catch { fail('RECORDING_STORAGE_UNAVAILABLE', 507); }
    const recordings = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !RECORDING_ID.test(entry.name)) continue;
      const directory = path.resolve(this.root, entry.name);
      if (path.dirname(directory) !== path.resolve(this.root)) continue;
      const session = this.sessions.get(entry.name);
      if (session && ['STARTING', 'RECORDING', 'STOPPING'].includes(session.state)) continue;
      try {
        const manifest = JSON.parse(await this.fsApi.readFile(path.join(directory, 'manifest.json'), 'utf8'));
        if (manifest.recordingId !== entry.name || manifest.worldId !== body.worldId || manifest.domain !== body.domain
          || !['STOPPED', 'FAILED', 'INTERRUPTED'].includes(manifest.status)
          || expiryFor(manifest, (await this.fsApi.stat(directory)).mtimeMs) <= this.now()) continue;
        const tracks = [];
        for (const track of Array.isArray(manifest.tracks) ? manifest.tracks : []) {
          if (!SOURCE_KIND.has(track?.source) || typeof track.fileKey !== 'string'
            || !/^tracks\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.webm$/i.test(track.fileKey)) continue;
          const file = path.resolve(directory, track.fileKey);
          if (path.dirname(file) !== path.resolve(directory, 'tracks')) continue;
          try {
            const info = await this.fsApi.stat(file);
            if (info.isFile() && info.size > 0) tracks.push({ source: track.source, bytes: info.size });
          } catch { /* An incomplete track is not offered for playback. */ }
        }
        const bytes = tracks.reduce((sum, track) => sum + track.bytes, 0);
        if (bytes < 1) continue;
        recordings.push({
          recordingId: entry.name,
          status: manifest.status,
          startedAt: Number(manifest.startedAt) || 0,
          endedAt: Number(manifest.endedAt) || 0,
          retentionExpiresAt: expiryFor(manifest),
          trackCount: tracks.length,
          tracks,
          bytes,
        });
      } catch { /* Ignore malformed private manifests without exposing filesystem details. */ }
    }
    recordings.sort((left, right) => right.startedAt - left.startedAt || left.recordingId.localeCompare(right.recordingId));
    return { recordings, usedBytes: recordings.reduce((sum, recording) => sum + recording.bytes, 0) };
  }

  async deleteCompleted(body) {
    validateRecordingScope(body, { requireId: true });
    const active = this.sessions.get(body.recordingId);
    if (active && active.worldId === body.worldId && active.domain === body.domain
      && ['STARTING', 'RECORDING', 'STOPPING'].includes(active.state))
      fail('RECORDING_ACTIVE_DELETE_FORBIDDEN', 409);
    const { recordings } = await this.listCompleted({ worldId: body.worldId, domain: body.domain });
    if (!recordings.some(recording => recording.recordingId === body.recordingId)) fail('RECORDING_NOT_FOUND', 404);
    await this.cancelTranscription(body.recordingId);
    const root = path.resolve(this.root);
    const directory = path.resolve(root, body.recordingId);
    if (path.dirname(directory) !== root) fail('RECORDING_INVALID_REQUEST', 400);
    try { await this.fsApi.rm(directory, { recursive: true, force: false }); }
    catch { fail('RECORDING_STORAGE_UNAVAILABLE', 507); }
    this.sessions.delete(body.recordingId);
    this.completedStopResults.delete(body.recordingId);
    return { recordingId: body.recordingId, deleted: true };
  }

  async listSpaceCompleted(body) {
    validateSpaceScope(body);
    if (!this.initialized) await this.initialize();
    let entries;
    try { entries = await this.fsApi.readdir(this.root, { withFileTypes: true }); }
    catch { fail('RECORDING_STORAGE_UNAVAILABLE', 507); }
    const recordings = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !RECORDING_ID.test(entry.name)) continue;
      const session = this.sessions.get(entry.name);
      if (session && ['STARTING', 'RECORDING', 'STOPPING'].includes(session.state)) continue;
      try {
        const loaded = await this.readRetainedManifest(entry.name);
        if (!loaded || loaded.manifest.spaceId !== body.spaceId) continue;
        const recording = await this.publicSpaceMetadata(loaded);
        if (recording && recording.tracks.length) recordings.push(recording);
      } catch (error) {
        if (error instanceof RecordingFailure && error.status === 507) throw error;
        /* A malformed private manifest or missing file is never exposed. */
      }
    }
    recordings.sort((left, right) => right.startedAt - left.startedAt || left.recordingId.localeCompare(right.recordingId));
    return {
      recordings,
      usedBytes: recordings.reduce((sum, recording) => sum + recording.bytes, 0),
      quotaBytes: this.spaceQuotaBytes,
      transcriptionAvailable: this.transcriber?.enabled === true,
    };
  }

  async metadata(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)
      || typeof body.recordingId !== 'string' || !RECORDING_ID.test(body.recordingId))
      fail('RECORDING_INVALID_REQUEST', 400);
    const loaded = await this.readRetainedManifest(body.recordingId);
    if (!loaded) fail('RECORDING_NOT_FOUND', 404);
    const recording = await this.publicSpaceMetadata(loaded);
    if (!recording || !recording.tracks.length) fail('RECORDING_NOT_FOUND', 404);
    return recording;
  }

  async transcript(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)
      || typeof body.recordingId !== 'string' || !RECORDING_ID.test(body.recordingId))
      fail('RECORDING_INVALID_REQUEST', 400);
    const loaded = await this.readRetainedManifest(body.recordingId);
    if (!loaded) fail('RECORDING_NOT_FOUND', 404);
    if (loaded.manifest.transcriptionStatus !== 'READY') fail('RECORDING_TRANSCRIPT_NOT_READY', 409);
    const file = path.join(loaded.directory, 'transcript.json');
    try {
      const [fileInfo, fileReal, directoryReal] = await Promise.all([
        this.fsApi.lstat(file), this.fsApi.realpath(file), this.fsApi.realpath(loaded.directory),
      ]);
      if (!fileInfo.isFile() || fileInfo.isSymbolicLink() || fileInfo.size < 1 || fileInfo.size > 8 * 1024 * 1024
        || !isWithin(directoryReal, fileReal)) fail('RECORDING_NOT_FOUND', 404);
      const value = JSON.parse(await this.fsApi.readFile(file, 'utf8'));
      if (value.recordingId !== body.recordingId || !Array.isArray(value.segments) || value.segments.length > 10_000)
        fail('RECORDING_NOT_FOUND', 404);
      const segments = [];
      for (const segment of value.segments) {
        if (!segment || !Number.isSafeInteger(segment.startMs) || !Number.isSafeInteger(segment.endMs)
          || segment.startMs < 0 || segment.endMs < segment.startMs
          || typeof segment.speakerName !== 'string' || typeof segment.text !== 'string') continue;
        segments.push({
          startMs: segment.startMs,
          endMs: segment.endMs,
          speakerName: [...segment.speakerName.trim()].slice(0, 20).join('') || '참가자',
          text: [...segment.text.trim()].slice(0, 2_000).join(''),
        });
      }
      return {
        recordingId: body.recordingId,
        generatedAt: Number(value.generatedAt) || 0,
        notice: 'AI가 생성한 자막입니다. 정확하지 않은 표현이 있을 수 있습니다.',
        segments: segments.filter(segment => segment.text),
      };
    } catch (error) {
      if (error instanceof RecordingFailure) throw error;
      if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR' || error?.code === 'ELOOP' || error instanceof SyntaxError)
        fail('RECORDING_NOT_FOUND', 404);
      fail('RECORDING_STORAGE_UNAVAILABLE', 507);
    }
  }

  async deleteSpaceCompleted(body) {
    validateSpaceScope(body, { requireId: true });
    const active = this.sessions.get(body.recordingId);
    if (active?.spaceId === body.spaceId && ['STARTING', 'RECORDING', 'STOPPING'].includes(active.state))
      fail('RECORDING_ACTIVE_DELETE_FORBIDDEN', 409);
    const loaded = await this.readRetainedManifest(body.recordingId);
    if (!loaded || loaded.manifest.spaceId !== body.spaceId) fail('RECORDING_NOT_FOUND', 404);
    const recording = await this.publicSpaceMetadata(loaded);
    if (!recording || !recording.tracks.length) fail('RECORDING_NOT_FOUND', 404);
    await this.cancelTranscription(body.recordingId);
    try { await this.fsApi.rm(loaded.directory, { recursive: true, force: false }); }
    catch { fail('RECORDING_STORAGE_UNAVAILABLE', 507); }
    this.sessions.delete(body.recordingId);
    this.completedStopResults.delete(body.recordingId);
    return { recordingId: body.recordingId, deleted: true };
  }

  async openCompletedTrack(recordingId, trackId) {
    if (typeof recordingId !== 'string' || !RECORDING_ID.test(recordingId)
      || typeof trackId !== 'string' || !RECORDING_ID.test(trackId)) fail('RECORDING_NOT_FOUND', 404);
    const loaded = await this.readRetainedManifest(recordingId);
    if (!loaded) fail('RECORDING_NOT_FOUND', 404);
    const { manifest, directory } = loaded;
    const track = Array.isArray(manifest.tracks)
      ? manifest.tracks.find(value => value?.trackId === trackId && value?.status === 'FINALIZED') : null;
    if (!track || !SOURCE_KIND.has(track.source) || track.fileKey !== `tracks/${trackId}.webm`
      || !SHA256.test(track.sha256 ?? '')) fail('RECORDING_NOT_FOUND', 404);
    const tracksDirectory = path.resolve(directory, 'tracks');
    const file = path.resolve(directory, track.fileKey);
    if (!isWithin(directory, tracksDirectory) || !isWithin(tracksDirectory, file)) fail('RECORDING_NOT_FOUND', 404);
    let handle;
    try {
      const rootReal = await this.fsApi.realpath(this.root);
      const directoryReal = await this.fsApi.realpath(directory);
      const tracksReal = await this.fsApi.realpath(tracksDirectory);
      const fileReal = await this.fsApi.realpath(file);
      if (!isWithin(rootReal, directoryReal) || !isWithin(directoryReal, tracksReal) || !isWithin(tracksReal, fileReal))
        fail('RECORDING_NOT_FOUND', 404);
      const [directoryInfo, tracksInfo, fileInfo] = await Promise.all([
        this.fsApi.lstat(directory), this.fsApi.lstat(tracksDirectory), this.fsApi.lstat(file),
      ]);
      if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()
        || !tracksInfo.isDirectory() || tracksInfo.isSymbolicLink()
        || !fileInfo.isFile() || fileInfo.isSymbolicLink() || fileInfo.size < 1) fail('RECORDING_NOT_FOUND', 404);
      handle = await this.fsApi.open(file, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
      const info = await handle.stat();
      if (!info.isFile() || info.size < 1) fail('RECORDING_NOT_FOUND', 404);
      return { handle, size: info.size, source: track.source, sha256: track.sha256 };
    } catch (error) {
      await handle?.close().catch(() => {});
      if (error instanceof RecordingFailure) throw error;
      if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR' || error?.code === 'ELOOP') fail('RECORDING_NOT_FOUND', 404);
      fail('RECORDING_STORAGE_UNAVAILABLE', 507);
    }
  }

  async readRetainedManifest(recordingId) {
    if (!this.initialized) await this.initialize();
    const root = path.resolve(this.root);
    const directory = path.resolve(root, recordingId);
    if (path.dirname(directory) !== root) return null;
    try {
      const [rootReal, directoryInfo, directoryReal] = await Promise.all([
        this.fsApi.realpath(root), this.fsApi.lstat(directory), this.fsApi.realpath(directory),
      ]);
      if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink() || !isWithin(rootReal, directoryReal)) return null;
      const manifestPath = path.join(directory, 'manifest.json');
      const manifestInfo = await this.fsApi.lstat(manifestPath);
      if (!manifestInfo.isFile() || manifestInfo.isSymbolicLink()) return null;
      const manifestReal = await this.fsApi.realpath(manifestPath);
      if (!isWithin(directoryReal, manifestReal)) return null;
      const manifest = JSON.parse(await this.fsApi.readFile(manifestPath, 'utf8'));
      if (manifest.recordingId !== recordingId || !['STOPPED', 'FAILED', 'INTERRUPTED'].includes(manifest.status)
        || expiryFor(manifest, directoryInfo.mtimeMs) <= this.now() || !this.hasTrustedMetadata(manifest)) return null;
      return { manifest, directory };
    } catch (error) {
      if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR' || error?.code === 'ELOOP' || error instanceof SyntaxError) return null;
      fail('RECORDING_STORAGE_UNAVAILABLE', 507);
    }
  }

  hasTrustedMetadata(manifest) {
    return typeof manifest.spaceId === 'string' && SPACE_METADATA_ID.test(manifest.spaceId)
      && typeof manifest.mapId === 'string' && SPACE_METADATA_ID.test(manifest.mapId)
      && typeof manifest.mapRevision === 'string' && SPACE_METADATA_ID.test(manifest.mapRevision)
      && typeof manifest.zoneId === 'string' && ZONE_ID.test(manifest.zoneId)
      && typeof manifest.requestedByUserId === 'string' && SPACE_METADATA_ID.test(manifest.requestedByUserId)
      && Array.isArray(manifest.participants) && manifest.participants.length > 0 && manifest.participants.length <= 100
      && manifest.participants.every(person => person && typeof person.userId === 'string' && SPACE_METADATA_ID.test(person.userId));
  }

  async publicSpaceMetadata({ manifest, directory }) {
    const tracks = [];
    for (const track of Array.isArray(manifest.tracks) ? manifest.tracks : []) {
      const trackId = track?.trackId;
      if (track?.status !== 'FINALIZED' || typeof trackId !== 'string' || !RECORDING_ID.test(trackId)
        || track.fileKey !== `tracks/${trackId}.webm` || !SOURCE_KIND.has(track.source) || !SHA256.test(track.sha256 ?? '')) continue;
      const file = path.resolve(directory, track.fileKey);
      const tracksDir = path.resolve(directory, 'tracks');
      if (!isWithin(directory, tracksDir) || !isWithin(tracksDir, file)) continue;
      try {
        const [directoryReal, tracksInfo, tracksReal, info, fileReal] = await Promise.all([
          this.fsApi.realpath(directory), this.fsApi.lstat(tracksDir), this.fsApi.realpath(tracksDir),
          this.fsApi.lstat(file), this.fsApi.realpath(file),
        ]);
        if (isWithin(directoryReal, tracksReal) && isWithin(tracksReal, fileReal)
          && tracksInfo.isDirectory() && !tracksInfo.isSymbolicLink()
          && info.isFile() && !info.isSymbolicLink() && info.size > 0)
          tracks.push({ trackId, source: track.source, bytes: info.size, sha256: track.sha256 });
      } catch { /* Missing or unsafe files are never offered. */ }
    }
    if (!tracks.length) return null;
    let transcriptBytes = 0;
    if (manifest.transcriptionStatus === 'READY') {
      const transcriptPath = path.join(directory, 'transcript.json');
      try {
        const [fileInfo, fileReal, directoryReal] = await Promise.all([
          this.fsApi.lstat(transcriptPath), this.fsApi.realpath(transcriptPath), this.fsApi.realpath(directory),
        ]);
        if (fileInfo.isFile() && !fileInfo.isSymbolicLink() && fileInfo.size > 0 && fileInfo.size <= 8 * 1024 * 1024
          && isWithin(directoryReal, fileReal)) transcriptBytes = fileInfo.size;
      } catch { /* A missing transcript is never included in archive usage. */ }
    }
    return {
      recordingId: manifest.recordingId,
      spaceId: manifest.spaceId,
      mapId: manifest.mapId,
      mapRevision: manifest.mapRevision,
      zoneId: manifest.zoneId,
      requestedByUserId: manifest.requestedByUserId,
      participants: [...new Set(manifest.participants.map(person => person.userId))],
      startedAt: Number(manifest.startedAt) || 0,
      endedAt: Number(manifest.endedAt) || 0,
      retentionExpiresAt: expiryFor(manifest),
      sources: Array.isArray(manifest.sources) ? manifest.sources.filter(source => SOURCE_KIND.has(source)) : [],
      transcriptionStatus: ['QUEUED', 'PROCESSING', 'READY', 'FAILED'].includes(manifest.transcriptionStatus)
        ? manifest.transcriptionStatus : 'NOT_REQUESTED',
      tracks,
      bytes: tracks.reduce((sum, track) => sum + track.bytes, 0) + transcriptBytes,
    };
  }

  producerAdded(peer, source, producer) {
    const session = this.sessions.get(this.byDomain.get(`${peer.world.id}/${peer.domain}`));
    if (!session || session.state !== 'RECORDING' || !session.sources.includes(source)) return Promise.resolve();
    return this.serial(session, async () => {
      if (session.state !== 'RECORDING') return;
      if (!this.isCurrent(session)) return this.finalize(session, 'participant-or-policy-changed', 'STOPPED');
      try {
        const participants = session.participants.map(person => session.world.peers.get(person.playerId));
        for (const entry of selectedActiveProducers(participants, session.sources))
          await this.attachTrack(session, entry.peer, entry.source, entry.producer);
        await this.writeManifest(session);
      }
      catch { await this.finalize(session, 'capture-failed', 'FAILED'); }
    });
  }

  producerClosed(peer, source, producer) {
    const session = this.sessions.get(this.byDomain.get(`${peer.world.id}/${peer.domain}`));
    if (!session || session.state !== 'RECORDING' || !session.sources.includes(source)) return Promise.resolve();
    const track = session.tracks.get(`${peer.id}/${source}`);
    if (!track || track.producer !== producer) return Promise.resolve();
    return this.serial(session, async () => this.finalize(session, 'selected-producer-closed', 'STOPPED'));
  }

  reconcile(world) {
    for (const session of this.sessions.values()) {
      if (session.worldId !== world.id || session.state !== 'RECORDING') continue;
      if (!this.isCurrent(session)) void this.serial(session, () => this.finalize(session, 'participant-or-policy-changed', 'STOPPED'));
    }
  }

  async sweep() {
    const now = this.now();
    if (now - this.lastRetentionSweepAt >= this.retentionSweepMs) {
      this.lastRetentionSweepAt = now;
      await this.cleanupExpired().catch(() => {});
    }
    for (const session of this.sessions.values()) {
      if (session.state !== 'RECORDING') continue;
      if (!this.isCurrent(session)) {
        void this.serial(session, () => this.finalize(session, 'participant-or-policy-changed', 'STOPPED'));
        continue;
      }
      if (now - session.createdAt >= this.maxRecordingMs) {
        void this.serial(session, () => this.finalize(session, 'maximum-duration', 'STOPPED'));
        continue;
      }
      if (now - session.lastQuotaCheckAt < 250) continue;
      session.lastQuotaCheckAt = now;
      try {
        const [space, tracks] = await Promise.all([
          this.fsApi.statfs(this.root),
          Promise.all([...session.tracks.values()].map(track => this.fsApi.stat(track.temporaryPath).catch(() => ({ size: 0 })))),
        ]);
        const freeBytes = Number(space.bavail) * Number(space.bsize);
        const usedBytes = tracks.reduce((total, item) => total + item.size, 0);
        if (freeBytes < this.minFreeBytes) void this.serial(session, () => this.finalize(session, 'disk-space-low', 'FAILED'));
        else if (usedBytes >= this.maxRecordingBytes) void this.serial(session, () => this.finalize(session, 'recording-quota', 'STOPPED'));
      } catch {
        void this.serial(session, () => this.finalize(session, 'storage-unavailable', 'FAILED'));
      }
    }
  }

  async close() {
    const sessions = [...this.sessions.values()].filter(session => ['STARTING', 'RECORDING', 'STOPPING'].includes(session.state));
    await Promise.all(sessions.map(session => this.serial(session, () => this.finalize(session, 'service-shutdown', 'INTERRUPTED'))));
    await Promise.all([...this.transcriptionJobs.keys()].map(recordingId => this.cancelTranscription(recordingId)));
  }

  isCurrent(session) {
    const world = session.world;
    if (!world || !rosterMatches(world, session.domain, session.participants, session.validPeer)) return false;
    for (const person of session.participants) {
      const peer = world.peers.get(person.playerId);
      if (!peer || peer.epoch !== person.epoch || session.sources.some(source => !peer.sources.has(source))) return false;
    }
    const selected = selectedActiveProducers(session.participants.map(person => world.peers.get(person.playerId)), session.sources);
    for (const track of session.tracks.values()) {
      const peer = world.peers.get(track.playerId);
      if (!peer || peer.producers.get(track.source) !== track.producer || track.producer.closed
        || !selected.some(entry => entry.peer.id === track.playerId && entry.source === track.source && entry.producer === track.producer)) return false;
    }
    return true;
  }

  async attachTrack(session, peer, source, producer) {
    if (session.state === 'STOPPING' || session.state === 'STOPPED' || producer.closed) return;
    const key = `${peer.id}/${source}`;
    if (session.tracks.has(key)) return;
    const router = await session.getRouter(peer);
    if (session.state === 'STOPPING' || session.state === 'STOPPED' || producer.closed) return;
    const fileId = randomUUID();
    const relativePath = `tracks/${fileId}.webm`;
    const outputPath = path.join(session.directory, relativePath);
    await this.fsApi.mkdir(path.dirname(outputPath), { recursive: true, mode: 0o700 });
    const maxBytesPerTrack = this.maxRecordingBytes;
    const capture = await this.captureFactory({
      router, producer, source, playerId: peer.id, epoch: peer.epoch,
      outputPath, maxBytes: maxBytesPerTrack, ffmpegPath: this.ffmpegPath,
      onFailure: reason => { void this.serial(session, () => this.finalize(session, reason === 'quota' ? 'recording-quota' : 'capture-failed', reason === 'quota' ? 'STOPPED' : 'FAILED')); },
    });
    const participant = session.participants.find(person => person.playerId === peer.id);
    const track = { trackId: fileId, playerId: peer.id, epoch: peer.epoch, speakerName: participant?.name || '', offsetMs: Math.max(0, this.now() - session.createdAt), source, producer, fileKey: relativePath.replaceAll('\\', '/'), temporaryPath: `${outputPath}.part`, capture, bytes: 0, sha256: '', status: 'RECORDING' };
    session.tracks.set(key, track);
    try {
      await capture.start();
      if (!this.isCurrent(session)) fail('RECORDING_ROSTER_CHANGED', 409);
    } catch (error) {
      session.tracks.delete(key);
      await capture.stop('start-failed').catch(() => {});
      throw error;
    }
  }

  async finalize(session, reason, finalState, { rememberStopResult = true } = {}) {
    if (session.stopResult) return session.stopResult;
    if (['STOPPED', 'FAILED', 'INTERRUPTED'].includes(session.state)) return session.stopResult;
    session.state = 'STOPPING';
    session.endReason = reason;
    await this.writeManifest(session).catch(() => {});
    const results = await Promise.all([...session.tracks.values()].map(async track => {
      const result = await track.capture.stop(reason).catch(() => ({ bytes: 0, sha256: '', rtpPackets: 0, rtpBytes: 0 }));
      track.bytes = result.bytes;
      track.sha256 = result.sha256;
      track.rtpPackets = result.rtpPackets ?? 0;
      track.rtpBytes = result.rtpBytes ?? 0;
      track.status = result.bytes > 0 ? 'FINALIZED' : 'EMPTY';
      if (!result.bytes)
        console.warn(`[recording] Empty ${track.source} capture: ${track.rtpPackets} RTP packets / ${track.rtpBytes} bytes; ${track.capture.stderr.slice(-512)}`);
      return track;
    }));
    session.state = finalState;
    const bytes = results.reduce((sum, track) => sum + track.bytes, 0);
    const digest = createHash('sha256').update(results.map(track => `${track.fileKey}:${track.sha256}`).sort().join('\n')).digest('hex');
    if (session.transcribe) {
      const microphoneTracks = results.filter(track => track.status === 'FINALIZED' && track.source === 'MICROPHONE')
        .map(track => ({ trackId: track.trackId, path: path.join(session.directory, track.fileKey), speakerName: track.speakerName, offsetMs: track.offsetMs }));
      if (finalState === 'STOPPED' && microphoneTracks.length) {
        session.transcriptionStatus = 'QUEUED';
        session.transcriptionFailureCode = '';
      } else {
        session.transcriptionStatus = 'FAILED';
        session.transcriptionFailureCode = finalState === 'STOPPED'
          ? 'TRANSCRIPTION_NO_AUDIO' : 'TRANSCRIPTION_RECORDING_INTERRUPTED';
      }
    }
    await this.writeManifest(session).catch(() => {});
    if (session.transcriptionStatus === 'QUEUED') {
      const microphoneTracks = results.filter(track => track.status === 'FINALIZED' && track.source === 'MICROPHONE')
        .map(track => ({ trackId: track.trackId, path: path.join(session.directory, track.fileKey), speakerName: track.speakerName, offsetMs: track.offsetMs }));
      this.enqueueTranscription({ recordingId: session.id, directory: session.directory, tracks: microphoneTracks });
    }
    this.byDomain.delete(`${session.worldId}/${session.domain}`);
    session.stopResult = {
      recordingId: session.id,
      active: false,
      trackCount: results.filter(track => track.bytes > 0).length,
      manifestKey: session.manifestKey,
      bytes,
      sha256: digest,
    };
    this.sessions.delete(session.id);
    if (rememberStopResult && this.maxRememberedStopResults > 0) {
      this.completedStopResults.delete(session.id);
      this.completedStopResults.set(session.id, { worldId: session.worldId, result: session.stopResult });
      while (this.completedStopResults.size > this.maxRememberedStopResults)
        this.completedStopResults.delete(this.completedStopResults.keys().next().value);
    }
    session.tracks.clear();
    session.participants = [];
    session.sources = [];
    session.world = null;
    session.validPeer = null;
    session.getRouter = null;
    session.queue = Promise.resolve();
    return session.stopResult;
  }

  async ensureStorage() {
    await this.fsApi.mkdir(this.root, { recursive: true, mode: 0o700 });
    const info = await this.fsApi.statfs(this.root);
    if (Number(info.bavail) * Number(info.bsize) < this.minFreeBytes) fail('RECORDING_STORAGE_UNAVAILABLE', 507);
  }

  async cleanupExpired() {
    const entries = await this.fsApi.readdir(this.root, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || !RECORDING_ID.test(entry.name)) continue;
      const directory = path.resolve(this.root, entry.name);
      if (path.dirname(directory) !== path.resolve(this.root)) continue;
      if ([...this.sessions.values()].some(session => session.id === entry.name && ['STARTING', 'RECORDING', 'STOPPING'].includes(session.state))) continue;
      try {
        const manifest = JSON.parse(await this.fsApi.readFile(path.join(directory, 'manifest.json'), 'utf8'));
        if (manifest.recordingId !== entry.name) continue;
        if (expiryFor(manifest, (await this.fsApi.stat(directory)).mtimeMs) <= this.now()) {
          await this.cancelTranscription(entry.name);
          await this.fsApi.rm(directory, { recursive: true, force: true });
          this.sessions.delete(entry.name);
        }
      } catch {
        try {
          if ((await this.fsApi.stat(directory)).mtimeMs + RETENTION_MS <= this.now()) await this.fsApi.rm(directory, { recursive: true, force: true });
        } catch { /* Keep recent unreadable artifacts private. */ }
      }
    }
  }

  async writeManifest(session) {
    const tracks = [...session.tracks.values()].map(({ trackId, playerId, epoch, source, speakerName, offsetMs, fileKey, bytes, sha256, rtpPackets, rtpBytes, status }) => ({ trackId, playerId, epoch, source, speakerName, offsetMs, fileKey, bytes, sha256, rtpPackets, rtpBytes, status }));
    const manifest = {
      version: 1,
      recordingId: session.id,
      worldId: session.worldId,
      domain: session.domain,
      spaceId: session.spaceId,
      mapId: session.mapId,
      mapRevision: session.mapRevision,
      zoneId: session.zoneId,
      requestedByUserId: session.requestedByUserId,
      sources: session.sources,
      participants: session.participants,
      status: session.state,
      startedAt: session.createdAt,
      retentionDays: RETENTION_DAYS,
      retentionExpiresAt: session.retentionExpiresAt,
      endedAt: ['STOPPED', 'FAILED', 'INTERRUPTED'].includes(session.state) ? this.now() : null,
      endReason: session.endReason || null,
      transcribe: session.transcribe === true,
      transcriptionStatus: session.transcriptionStatus ?? 'NOT_REQUESTED',
      transcriptionFailureCode: session.transcriptionFailureCode || null,
      tracks,
    };
    await this.writeManifestAt(path.join(session.directory, 'manifest.json'), manifest);
  }

  enqueueTranscription(job) {
    const record = { controller: new AbortController(), promise: null, cancelled: false, started: false };
    this.transcriptionJobs.set(job.recordingId, record);
    const run = async () => {
      if (record.cancelled) return;
      record.started = true;
      let status = 'PROCESSING';
      let failureCode = '';
      try {
        await this.updateTranscriptionManifest(job, status, failureCode);
        const segments = [];
        for (const track of job.tracks) {
          if (record.cancelled) return;
          const transcript = await this.transcriber.transcribeTrack({
            audioPath: track.path, directory: job.directory, trackId: track.trackId,
            speakerName: track.speakerName, offsetMs: track.offsetMs, signal: record.controller.signal,
          });
          segments.push(...transcript.segments);
        }
        segments.sort((left, right) => left.startMs - right.startMs || left.endMs - right.endMs);
        const contents = `${JSON.stringify({
          recordingId: job.recordingId,
          generatedAt: this.now(),
          notice: 'AI가 생성한 자막입니다. 정확하지 않은 표현이 있을 수 있습니다.',
          segments,
        })}\n`;
        if (Buffer.byteLength(contents) > 8 * 1024 * 1024) throw new TranscriptionFailure('TRANSCRIPTION_OUTPUT_LIMIT');
        await this.fsApi.writeFile(path.join(job.directory, 'transcript.json.tmp'), contents, { mode: 0o600 });
        if (record.cancelled) return;
        await this.fsApi.rename(path.join(job.directory, 'transcript.json.tmp'), path.join(job.directory, 'transcript.json'));
        status = 'READY';
      } catch (error) {
        if (record.cancelled) return;
        status = 'FAILED';
        failureCode = error instanceof TranscriptionFailure && /^[A-Z0-9_]{1,64}$/.test(error.code)
          ? error.code : 'TRANSCRIPTION_PROVIDER_FAILED';
      } finally {
        if (record.cancelled) {
          await this.fsApi.rm(path.join(job.directory, 'transcript.json.tmp'), { force: true }).catch(() => {});
        } else {
          if (status !== 'READY') await this.fsApi.rm(path.join(job.directory, 'transcript.json.tmp'), { force: true }).catch(() => {});
          await this.updateTranscriptionManifest(job, status, failureCode).catch(() => {});
          if (this.transcriptionJobs.get(job.recordingId) === record) this.transcriptionJobs.delete(job.recordingId);
        }
      }
    };
    const pending = this.transcriptionQueue.then(run, run);
    record.promise = pending;
    this.transcriptionQueue = pending.catch(() => {});
  }

  async updateTranscriptionManifest(job, status, failureCode) {
    const file = path.join(job.directory, 'manifest.json');
    const manifest = JSON.parse(await this.fsApi.readFile(file, 'utf8'));
    if (manifest.recordingId !== job.recordingId || !['STOPPED', 'FAILED', 'INTERRUPTED'].includes(manifest.status))
      throw new TranscriptionFailure('TRANSCRIPTION_RECORDING_UNAVAILABLE');
    manifest.transcriptionStatus = status;
    manifest.transcriptionFailureCode = failureCode || null;
    await this.writeManifestAt(file, manifest);
  }

  async cancelTranscription(recordingId) {
    const job = this.transcriptionJobs.get(recordingId);
    if (!job) return;
    job.cancelled = true;
    job.controller.abort();
    if (job.started) await job.promise?.catch(() => {});
    if (this.transcriptionJobs.get(recordingId) === job) this.transcriptionJobs.delete(recordingId);
  }

  async writeManifestAt(file, manifest) {
    const temporary = `${file}.tmp`;
    await this.fsApi.writeFile(temporary, `${JSON.stringify(manifest)}\n`, { mode: 0o600 });
    await this.fsApi.rename(temporary, file);
  }

  serial(session, action) {
    const pending = session.queue.then(action);
    session.queue = pending.catch(() => {});
    return pending;
  }
}

async function checkExecutable(binary) {
  return new Promise(resolve => {
    let child;
    try { child = spawn(binary, ['-version'], { stdio: 'ignore', windowsHide: true }); }
    catch { resolve(false); return; }
    const timeout = setTimeout(() => { child.kill('SIGKILL'); resolve(false); }, 3000);
    child.once('error', () => { clearTimeout(timeout); resolve(false); });
    child.once('close', code => { clearTimeout(timeout); resolve(code === 0); });
  });
}
