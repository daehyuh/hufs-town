import { randomUUID } from 'node:crypto';
import { FfmpegRtpCapture, RecordingFailure, RecordingManager } from './recordings.mjs';
export class MediaFailure extends Error { constructor(code, message) { super(message); this.code = code; } }
const check = (value, message = '요청을 확인해 주세요.') => { if (!value) throw new MediaFailure('MEDIA_INVALID', message); };
const id = value => typeof value === 'string' && /^[a-zA-Z0-9_./:-]{1,256}$/.test(value);
const SOURCES = new Map([['MICROPHONE', 'audio'], ['CAMERA', 'video'], ['SCREEN', 'video'], ['SCREEN_AUDIO', 'audio']]);
const LIMITS = { MICROPHONE: 12, CAMERA: 8, SCREEN: 8, SCREEN_AUDIO: 8 };
const EVENT_DOMAIN = /^[a-zA-Z0-9_-]{1,128}\/event\/[a-zA-Z0-9_-]{1,128}$/;
const peerLimit = domain => EVENT_DOMAIN.test(domain) ? 100 : 12;
export const codecs = [
  { kind: 'audio', mimeType: 'audio/opus', clockRate: 48000, channels: 2 },
  { kind: 'video', mimeType: 'video/VP8', clockRate: 90000, parameters: {} },
];

/** All consumers are created here, paused, after checking the latest server policy. */
export class MediaEngine {
  constructor(worker, rtcServer, { now = Date.now, iceServers = [], recordingManager, recordingOptions = {} } = {}) {
    this.worker = worker; this.rtcServer = rtcServer; this.now = now; this.iceServers = iceServers; this.worlds = new Map(); this.routers = new Map(); this.sourceReservations = new Map(); this.instanceId=randomUUID();
    this.recordings = recordingManager ?? new RecordingManager({
      captureFactory: options => new FfmpegRtpCapture(options),
      now,
      ...recordingOptions,
    });
    this.closePromise = null;
  }
  world(worldId) {
    check(id(worldId)); let world = this.worlds.get(worldId);
    if (!world) { check(this.worlds.size < 16, '미디어 서버가 바빠요.'); world = { id: worldId, sequence: 0, peers: new Map(), fences: new Map(), touched: this.now() }; this.worlds.set(worldId, world); }
    return world;
  }
  apply(frame) {
    check(frame && id(frame.worldId) && Number.isSafeInteger(frame.sequence) && frame.sequence > 0 && Number.isSafeInteger(frame.leaseMillis), '통화 정책 프레임이 올바르지 않아요.');
    const now = this.now();
    check(frame.leaseMillis > 0 && frame.leaseMillis <= 2000, '통화 정책의 유효 시간이 지났어요.');
    const expiresAt = now + frame.leaseMillis;
    check(Array.isArray(frame.people) && frame.people.length <= 300, '통화 참가자 목록이 올바르지 않아요.');
    const ids = new Set();
    for (const p of frame.people) {
      check(p && id(p.id) && !ids.has(p.id) && id(p.domain) && Number.isSafeInteger(p.epoch) && p.epoch > 0, '통화 참가자 ID·구역·접속 번호가 올바르지 않아요.');
      check(Array.isArray(p.peers) && p.peers.length <= peerLimit(p.domain) && p.peers.every(id), '통화 허용 대상 목록이 올바르지 않아요.');
      check(Array.isArray(p.sources) && p.sources.length <= 4 && p.sources.every(s => SOURCES.has(s)), '미디어 송출 허용 목록이 올바르지 않아요.');
      ids.add(p.id);
    }
    const world = this.world(frame.worldId); world.touched = now;
    if (frame.sequence <= world.sequence) return this.view(world);
    world.sequence = frame.sequence;
    for (const [peerId, p] of world.peers) if (!ids.has(peerId)) this.closePeer(world, p);
    for (const value of frame.people) {
      const fence = world.fences.get(value.id)?.epoch ?? 0;
      if (value.epoch < fence) continue;
      let p = world.peers.get(value.id);
      if (p && (p.epoch !== value.epoch || p.domain !== value.domain)) { this.closePeer(world, p); p = undefined; }
      if (!p) {
        p = { world, id: value.id, epoch: value.epoch, domain: value.domain, peers: new Set(), sources: new Set(), expiresAt, transports: new Map(), producers: new Map(), consumers: new Map(), queue: Promise.resolve(), waiting: 0, closed: false };
        world.peers.set(p.id, p);
      }
      world.fences.set(value.id, { epoch: value.epoch, touched: now }); p.expiresAt = expiresAt; p.peers = new Set(value.peers); p.sources = new Set(value.sources);
    }
    // Revoke first. An update never relies on the receiving browser to unsubscribe.
    for (const p of world.peers.values())
      for (const [source, producer] of p.producers)
        if (!p.sources.has(source)) {
          producer.close();
          p.producers.delete(source);
        }
    const offersByPeer = new Map(
      [...world.peers.values()].map(peer => [peer, this.offers(peer)]),
    );
    for (const p of world.peers.values()) {
      const offered = new Set((offersByPeer.get(p) ?? []).map(offer => offer.id));
      for (const [consumerId, c] of p.consumers)
        if (!this.permitted(p, c.sender, c.source) || c.producer.closed || !offered.has(c.producer.id)) {
          c.resource.close();
          p.consumers.delete(consumerId);
        }
    }
    this.recordings.reconcile(world);
    this.sweep(); return this.view(world, offersByPeer);
  }
  revoke({ worldId, playerId, epoch }) {
    check(id(worldId) && id(playerId) && Number.isSafeInteger(epoch) && epoch > 0);
    const world = this.world(worldId); world.touched = this.now();
    world.fences.set(playerId, { epoch: Math.max(world.fences.get(playerId)?.epoch ?? 0, epoch), touched: this.now() });
    const p = world.peers.get(playerId); if (p && p.epoch < epoch) this.closePeer(world, p);
    this.recordings.reconcile(world);
    return { revoked: true, epoch };
  }
  startRecording(body) {
    const world = body && this.worlds.get(body.worldId);
    if (!world) throw new RecordingFailure('RECORDING_ROSTER_CHANGED', 409);
    return this.recordings.start(body, world, peer => this.valid(peer), peer => this.router(peer));
  }
  stopRecording(body) { return this.recordings.stop(body); }
  listRecordings(body) { return this.recordings.listCompleted(body); }
  deleteRecording(body) { return this.recordings.deleteCompleted(body); }
  listSpaceRecordings(body) { return this.recordings.listSpaceCompleted(body); }
  recordingMetadata(body) { return this.recordings.metadata(body); }
  recordingTranscript(body) { return this.recordings.transcript(body); }
  deleteSpaceRecording(body) { return this.recordings.deleteSpaceCompleted(body); }
  openRecordingTrack(recordingId, trackId) { return this.recordings.openCompletedTrack(recordingId, trackId); }
  valid(p) { return !p.closed && p.world.peers.get(p.id) === p && p.expiresAt > this.now(); }
  require(p) { if (!this.valid(p)) throw new MediaFailure('MEDIA_STALE', '통화 연결이 바뀌었어요. 다시 연결하고 있어요.'); }
  permitted(receiver, sender, source) {
    return this.valid(receiver) && this.valid(sender) && receiver !== sender && receiver.world === sender.world && receiver.domain === sender.domain && receiver.peers.has(sender.id) && sender.peers.has(receiver.id) && sender.sources.has(source);
  }
  reserveSourceSlot(peer, source) {
    const key = `${peer.world.id}/${peer.domain}/${source}`;
    let reservations = this.sourceReservations.get(key);
    if (!reservations) {
      reservations = new Set();
      this.sourceReservations.set(key, reservations);
    }
    const active = [...peer.world.peers.values()].filter(sender =>
      this.valid(sender) && sender.domain === peer.domain &&
      !sender.producers.get(source)?.closed && sender.producers.has(source),
    ).length;
    if (active + reservations.size >= LIMITS[source]) {
      if (reservations.size === 0) this.sourceReservations.delete(key);
      throw new MediaFailure('MEDIA_SCREEN_CAPACITY', '이 대화 범위에서는 화면 공유를 최대 8개까지 동시에 표시할 수 있어요.');
    }
    const reservation = Symbol(source);
    reservations.add(reservation);
    return () => {
      reservations.delete(reservation);
      if (reservations.size === 0) this.sourceReservations.delete(key);
    };
  }
  offers(p) {
    if (!this.valid(p)) return [];
    const retained = new Set([...p.consumers.values()].map(c => c.producer.id)), list = [], counts = {};
    for (const sender of p.world.peers.values()) for (const [source, producer] of sender.producers) if (!producer.closed && this.permitted(p, sender, source)) list.push({ id: producer.id, playerId: sender.id, source, kind: producer.kind });
    list.sort((a, b) => Number(retained.has(b.id)) - Number(retained.has(a.id)) || a.playerId.localeCompare(b.playerId) || a.source.localeCompare(b.source));
    const screenOwners = new Set(
      list.filter(item => item.source === 'SCREEN')
        .slice(0, LIMITS.SCREEN)
        .map(item => item.playerId),
    );
    return list.filter(item => {
      if (item.source === 'SCREEN_AUDIO' && !screenOwners.has(item.playerId)) return false;
      counts[item.source] = (counts[item.source] ?? 0) + 1; return counts[item.source] <= LIMITS[item.source];
    });
  }
  view(world, offersByPeer) {
    return { instanceId:this.instanceId, sequence: world.sequence, people: [...world.peers.values()].filter(p => this.valid(p)).map(p => ({ id: p.id, epoch: p.epoch, peers: [...p.peers].filter(peer => { const other = world.peers.get(peer); return other && this.valid(other) && p.domain === other.domain && other.peers.has(p.id); }), offers: offersByPeer?.get(p) ?? this.offers(p) })) };
  }
  async router(p) {
    this.require(p); const key = `${p.world.id}/${p.domain}`;
    let pending = this.routers.get(key);
    if (!pending) {
      check(this.routers.size < 160, '통화 공간이 가득 찼어요.');
      pending = this.worker.createRouter({ mediaCodecs: codecs }); this.routers.set(key, pending);
      pending.catch(() => { if (this.routers.get(key) === pending) this.routers.delete(key); });
    }
    const router = await pending; this.require(p);
    if (router.closed || this.routers.get(key) !== pending) throw new MediaFailure('MEDIA_STALE', '통화 공간을 다시 연결하고 있어요.');
    return router;
  }
  async rpc(request) {
    check(request && id(request.worldId) && id(request.playerId) && Number.isSafeInteger(request.epoch));
    const p = this.worlds.get(request.worldId)?.peers.get(request.playerId);
    if (!p || p.epoch !== request.epoch) throw new MediaFailure('MEDIA_STALE', '통화 연결을 준비하고 있어요.');
    this.require(p); check(p.waiting < 8, '통화 요청이 너무 많아요.'); p.waiting++;
    const operation = p.queue.then(() => { this.require(p); return this.perform(p, request.method, request.data ?? {}); });
    p.queue = operation.catch(() => {}); return operation.finally(() => { p.waiting--; });
  }
  async perform(p, method, data) {
    check(data && typeof data === 'object' && !Array.isArray(data));
    if (method === 'capabilities') return { routerRtpCapabilities: (await this.router(p)).rtpCapabilities, iceServers: typeof this.iceServers === 'function' ? this.iceServers() : this.iceServers };
    if (method === 'createTransport') {
      check(['send', 'recv'].includes(data.direction));
      // Reconnect replaces its own old transport, including a browser that closed without an RPC acknowledgement.
      for(const [transportId,existing] of p.transports)if(existing.direction===data.direction){existing.resource.close();p.transports.delete(transportId);}
      const router = await this.router(p);
      const transport = await router.createWebRtcTransport({ webRtcServer: this.rtcServer, enableUdp: true, enableTcp: true, preferUdp: true, enableSctp: false, initialAvailableOutgoingBitrate: 1_000_000 });
      if (!this.valid(p)) { transport.close(); this.require(p); }
      p.transports.set(transport.id, { resource: transport, direction: data.direction });
      transport.on('dtlsstatechange', state => { if (state === 'closed') { transport.close(); p.transports.delete(transport.id); } });
      return { id: transport.id, iceParameters: transport.iceParameters, iceCandidates: transport.iceCandidates, dtlsParameters: transport.dtlsParameters };
    }
    if (method === 'connectTransport') {
      const t = this.transport(p, data.transportId); await t.resource.connect({ dtlsParameters: data.dtlsParameters }); this.require(p); return {};
    }
    if (method === 'produce') {
      if (!p.sources.has(data.source)) throw new MediaFailure('MEDIA_DENIED', '이 구역에서는 송출할 수 없어요.');
      check(SOURCES.get(data.source) === data.kind && !p.producers.has(data.source));
      const t = this.transport(p, data.transportId, 'send');
      if (data.source === 'SCREEN_AUDIO' && !p.producers.has('SCREEN'))
        throw new MediaFailure('MEDIA_INVALID', '화면 공유를 먼저 시작해 주세요.');
      const releaseSlot = ['SCREEN', 'SCREEN_AUDIO'].includes(data.source)
        ? this.reserveSourceSlot(p, data.source)
        : () => {};
      try {
        const producer = await t.resource.produce({ kind: data.kind, rtpParameters: data.rtpParameters, paused: true, appData: { source: data.source } });
        if (!this.valid(p) || !p.sources.has(data.source)) { producer.close(); throw new MediaFailure('MEDIA_STALE', '송출 권한이 바뀌었어요.'); }
        p.producers.set(data.source, producer);
        const removeProducer = () => {
          if (p.producers.get(data.source) === producer) p.producers.delete(data.source);
          void this.recordings.producerClosed(p, data.source, producer);
        };
        producer.on('transportclose', removeProducer);
        producer.observer?.on('close', removeProducer);
        await producer.resume();
        if (!this.valid(p) || !p.sources.has(data.source)) { producer.close(); p.producers.delete(data.source); throw new MediaFailure('MEDIA_STALE', '송출 권한이 바뀌었어요.'); }
        await this.recordings.producerAdded(p, data.source, producer);
        return { id: producer.id };
      } finally {
        releaseSlot();
      }
    }
    if (method === 'closeProducer') { const producer = p.producers.get(data.source); if (producer) { producer.close(); p.producers.delete(data.source); } return {}; }
    if (method === 'consume') {
      const offer = this.offers(p).find(o => o.id === data.producerId);
      if (!offer) throw new MediaFailure('MEDIA_DENIED', '지금 대화 범위에 있는 사람만 연결할 수 있어요.');
      check(![...p.consumers.values()].some(c => c.producer.id === offer.id));
      check([...p.consumers.values()].filter(c => c.source === offer.source).length < LIMITS[offer.source]);
      const sender = p.world.peers.get(offer.playerId), producer = sender.producers.get(offer.source), t = this.transport(p, data.transportId, 'recv');
      const router = await this.router(p);
      check(router.canConsume({ producerId: producer.id, rtpCapabilities: data.rtpCapabilities }), '호환되는 미디어 코덱이 없어요.');
      const consumer = await t.resource.consume({ producerId: producer.id, rtpCapabilities: data.rtpCapabilities, paused: true });
      if (!this.permitted(p, sender, offer.source) || producer.closed) { consumer.close(); throw new MediaFailure('MEDIA_STALE', '대화 범위가 바뀌었어요.'); }
      p.consumers.set(consumer.id, { resource: consumer, sender, source: offer.source, producer });
      const remove = () => { consumer.close(); p.consumers.delete(consumer.id); }; consumer.on('transportclose', remove); consumer.on('producerclose', remove);
      try {
        if (consumer.type === 'simulcast') await consumer.setPreferredLayers({ spatialLayer: offer.source === 'CAMERA' ? 0 : 2 });
        return { id: consumer.id, producerId: producer.id, kind: consumer.kind, rtpParameters: consumer.rtpParameters, playerId: sender.id, source: offer.source };
      } catch (error) {
        consumer.close();
        p.consumers.delete(consumer.id);
        throw error;
      }
    }
    if (method === 'resumeConsumer') {
      const c = p.consumers.get(data.consumerId);
      if (!c || c.producer.closed || !this.permitted(p, c.sender, c.source)) throw new MediaFailure('MEDIA_DENIED', '대화 범위가 바뀌었어요.');
      await c.resource.resume();
      if (!this.permitted(p, c.sender, c.source)) { c.resource.close(); p.consumers.delete(data.consumerId); throw new MediaFailure('MEDIA_STALE', '대화 범위가 바뀌었어요.'); }
      return {};
    }
    if (method === 'setPreferredLayers') {
      check(id(data.consumerId) && Number.isInteger(data.spatialLayer) && data.spatialLayer >= 0 && data.spatialLayer <= 1);
      const c = p.consumers.get(data.consumerId);
      if (!c || c.source !== 'CAMERA' || !this.permitted(p, c.sender, c.source))
        throw new MediaFailure('MEDIA_DENIED', '수신 중인 카메라를 찾을 수 없어요.');
      if (c.resource.type === 'simulcast')
        await c.resource.setPreferredLayers({ spatialLayer: data.spatialLayer });
      this.require(p);
      if (p.consumers.get(data.consumerId) !== c || c.resource.closed)
        throw new MediaFailure('MEDIA_STALE', '수신 연결이 바뀌었어요.');
      if (!this.permitted(p, c.sender, c.source)) {
        c.resource.close(); p.consumers.delete(data.consumerId);
        throw new MediaFailure('MEDIA_STALE', '대화 범위가 바뀌었어요.');
      }
      return { currentLayers: c.resource.currentLayers ?? null };
    }
    if (method === 'closeConsumer') { const c = p.consumers.get(data.consumerId); if (c) { c.resource.close(); p.consumers.delete(data.consumerId); } return {}; }
    if (method === 'stats') {
      const stats = [];
      for (const c of p.consumers.values()) { const entries = await c.resource.getStats(); this.require(p); stats.push(...entries.map(s => ({ type: s.type, kind: s.kind, byteCount: s.byteCount, packetCount: s.packetCount, source: c.source, playerId: c.sender.id, currentLayers: c.resource.currentLayers ?? null }))); }
      return { consumers: stats, transports: p.transports.size, producers: p.producers.size };
    }
    throw new MediaFailure('MEDIA_INVALID', '지원하지 않는 통화 요청이에요.');
  }
  transport(p, transportId, direction) { const t = p.transports.get(transportId); if (!t || t.resource.closed || (direction && t.direction !== direction)) throw new MediaFailure('MEDIA_STALE', '통화 전송을 다시 준비하고 있어요.'); return t; }
  closePeer(world, p) { p.closed = true; for (const t of p.transports.values()) t.resource.close(); for (const c of p.consumers.values()) c.resource.close(); for (const producer of p.producers.values()) producer.close(); p.transports.clear(); p.consumers.clear(); p.producers.clear(); world.peers.delete(p.id); this.recordings.reconcile(world); }
  sweep() {
    const now = this.now(), active = new Set();
    for (const [worldId, world] of this.worlds) {
      for (const p of world.peers.values()) { if (!this.valid(p)) this.closePeer(world, p); else active.add(`${worldId}/${p.domain}`); }
      for (const [peerId, fence] of world.fences) if (!world.peers.has(peerId) && now - fence.touched > 60_000) world.fences.delete(peerId);
      if (!world.peers.size && now - world.touched > 60_000) this.worlds.delete(worldId);
    }
    for (const [key, pending] of this.routers) if (!active.has(key)) { this.routers.delete(key); void pending.then(r => r.close()).catch(() => {}); }
    void this.recordings.sweep();
  }
  close() {
    if (this.closePromise) return this.closePromise;
    this.closePromise = (async () => {
      await this.recordings.close();
      for (const w of this.worlds.values()) for (const p of [...w.peers.values()]) this.closePeer(w, p);
      for (const r of this.routers.values()) void r.then(r => r.close()).catch(() => {});
      this.sourceReservations.clear(); this.routers.clear(); this.worlds.clear();
    })();
    return this.closePromise;
  }
}
