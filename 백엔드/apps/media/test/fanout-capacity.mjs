import { spawn } from 'node:child_process';
import dgram from 'node:dgram';
import os from 'node:os';
import { performance } from 'node:perf_hooks';
import { createWorker } from 'mediasoup';
import { MediaEngine } from '../src/engine.mjs';

function argumentsFrom(argv) {
  const values = { listeners: 99, durationSeconds: 8, minBytes: 5000 };
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!value || !key.startsWith('--')) throw new Error(`Invalid argument: ${key}`);
    if (key === '--listeners') values.listeners = Number(value);
    else if (key === '--duration-seconds') values.durationSeconds = Number(value);
    else if (key === '--min-bytes') values.minBytes = Number(value);
    else throw new Error(`Unknown argument: ${key}`);
    index += 1;
  }
  if (!Number.isInteger(values.listeners) || values.listeners < 1 || values.listeners > 99)
    throw new Error('--listeners must be from 1 to 99.');
  if (!Number.isInteger(values.durationSeconds) || values.durationSeconds < 2 || values.durationSeconds > 120)
    throw new Error('--duration-seconds must be from 2 to 120.');
  if (!Number.isInteger(values.minBytes) || values.minBytes < 1 || values.minBytes > 1_000_000)
    throw new Error('--min-bytes must be from 1 to 1000000.');
  return values;
}

const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

async function openUdpSink() {
  const socket = dgram.createSocket('udp4');
  await new Promise((resolve, reject) => {
    socket.once('error', reject);
    socket.bind(0, '127.0.0.1', resolve);
  });
  const sink = { socket, port: socket.address().port, bytes: 0, packets: 0, error: null };
  socket.on('error', error => { sink.error = error.message; });
  return sink;
}

function frame(worldId, sequence, people) {
  return { worldId, sequence, leaseMillis: 1900, people };
}

function sumStats(stats) {
  return stats.reduce((total, entry) => ({
    bytes: total.bytes + Number(entry.byteCount ?? entry.bytesReceived ?? entry.rtpBytesReceived ?? 0),
    packets: total.packets + Number(entry.packetCount ?? entry.packetsReceived ?? entry.rtpPacketsReceived ?? 0),
  }), { bytes: 0, packets: 0 });
}

async function main() {
  const options = argumentsFrom(process.argv.slice(2));
  const startedAt = performance.now();
  const processUsageStart = process.resourceUsage();
  const processMemoryStart = process.memoryUsage();
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  const worldId = `fanout-${suffix}`;
  const domain = `${worldId}/event/attendee-load`;
  const publisherId = 'publisher';
  const listenerIds = Array.from({ length: options.listeners }, (_, index) => `listener-${String(index + 1).padStart(3, '0')}`);
  const people = [
    { id: publisherId, epoch: 1, domain, peers: listenerIds, sources: ['MICROPHONE'] },
    ...listenerIds.map(id => ({ id, epoch: 1, domain, peers: [publisherId], sources: [] })),
  ];

  let worker;
  let engine;
  let publisherTransport;
  let producer;
  let ffmpeg;
  let policyRefresh;
  let sweep;
  const sinks = [];
  const listeners = [];
  let exitCode = 0;

  try {
    worker = await createWorker({ logLevel: 'error' });
    engine = new MediaEngine(worker, null);
    engine.apply(frame(worldId, 1, people));
    const world = engine.worlds.get(worldId);
    const publisher = world.peers.get(publisherId);
    const router = await engine.router(publisher);
    const audioCodec = router.rtpCapabilities.codecs.find(codec => codec.kind === 'audio');
    if (!audioCodec) throw new Error('The SFU router did not expose an audio codec.');

    const workerUsageStart = await worker.getResourceUsage();
    for (const listenerId of listenerIds) sinks.push(await openUdpSink());
    sinks.forEach(sink => sink.socket.on('message', packet => {
      sink.bytes += packet.length;
      sink.packets += 1;
    }));

    publisherTransport = await router.createPlainTransport({
      listenInfo: { protocol: 'udp', ip: '127.0.0.1' },
      rtcpMux: true,
      comedia: true,
    });
    publisher.transports.set(publisherTransport.id, { resource: publisherTransport, direction: 'send' });
    const ssrc = 42_424_242;
    producer = await publisherTransport.produce({
      kind: 'audio',
      paused: true,
      appData: { source: 'MICROPHONE' },
      rtpParameters: {
        codecs: [{
          mimeType: audioCodec.mimeType,
          payloadType: audioCodec.preferredPayloadType,
          clockRate: audioCodec.clockRate,
          channels: audioCodec.channels,
          parameters: audioCodec.parameters ?? {},
          rtcpFeedback: [],
        }],
        headerExtensions: [],
        encodings: [{ ssrc }],
        rtcp: { cname: `hufs-town-${worldId}` },
      },
    });
    publisher.producers.set('MICROPHONE', producer);
    producer.observer?.on('close', () => {
      if (publisher.producers.get('MICROPHONE') === producer) publisher.producers.delete('MICROPHONE');
    });
    await producer.resume();

    const consumeStartedAt = performance.now();
    for (let index = 0; index < listenerIds.length; index += 1) {
      const peer = world.peers.get(listenerIds[index]);
      const offer = engine.offers(peer).find(value => value.playerId === publisherId && value.source === 'MICROPHONE');
      if (!offer) throw new Error(`SFU policy did not offer audio to ${peer.id}.`);
      const transport = await router.createPlainTransport({
        listenInfo: { protocol: 'udp', ip: '127.0.0.1' },
        rtcpMux: true,
      });
      peer.transports.set(transport.id, { resource: transport, direction: 'recv' });
      await transport.connect({ ip: '127.0.0.1', port: sinks[index].port });
      const consumer = await transport.consume({
        producerId: producer.id,
        rtpCapabilities: router.rtpCapabilities,
        paused: true,
      });
      peer.consumers.set(consumer.id, { resource: consumer, sender: publisher, source: 'MICROPHONE', producer });
      consumer.on('transportclose', () => peer.consumers.delete(consumer.id));
      consumer.on('producerclose', () => peer.consumers.delete(consumer.id));
      listeners.push({ id: peer.id, peer, transport, consumer, sink: sinks[index] });
      await consumer.resume();
    }
    const consumeSetupMs = performance.now() - consumeStartedAt;

    let sequence = 1;
    policyRefresh = setInterval(() => engine.apply(frame(worldId, ++sequence, people)), 800);
    sweep = setInterval(() => engine.sweep(), 100);

    const ffmpegArgs = [
      '-hide_banner', '-loglevel', 'error', '-re',
      '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
      '-t', String(options.durationSeconds), '-vn', '-ac', '2', '-ar', '48000',
      '-c:a', 'libopus', '-application', 'voip', '-b:a', '32k',
      '-payload_type', String(audioCodec.preferredPayloadType), '-ssrc', String(ssrc),
      '-f', 'rtp', `rtp://127.0.0.1:${publisherTransport.tuple.localPort}?pkt_size=1200`,
    ];
    ffmpeg = spawn(process.env.MEDIA_FFMPEG_PATH || 'ffmpeg', ffmpegArgs, { stdio: ['ignore', 'ignore', 'pipe'] });
    let ffmpegStderr = '';
    ffmpeg.stderr.setEncoding('utf8');
    ffmpeg.stderr.on('data', chunk => { ffmpegStderr += chunk; });
    const ffmpegDone = new Promise(resolve => ffmpeg.once('close', (code, signal) => resolve({ code, signal })));

    const deadline = performance.now() + options.durationSeconds * 1000 + 8000;
    let done;
    while (performance.now() < deadline) {
      const received = sinks.every(sink => sink.bytes >= options.minBytes);
      if (received) break;
      const socketFailure = sinks.find(sink => sink.error);
      if (socketFailure) throw new Error(`UDP listener ${socketFailure.port} failed: ${socketFailure.error}`);
      if (ffmpeg.exitCode !== null || ffmpeg.signalCode !== null) break;
      await wait(100);
    }
    done = await ffmpegDone;
    if (done.code !== 0) throw new Error(`FFmpeg exited with ${done.code ?? done.signal}: ${ffmpegStderr}`);
    const elapsedSeconds = (performance.now() - startedAt) / 1000;
    const belowThreshold = listeners.filter(listener => listener.sink.bytes < options.minBytes);
    const consumerStats = await Promise.all(listeners.map(listener => listener.consumer.getStats()));
    const listenerStats = listeners.map((listener, index) => ({
      id: listener.id,
      udpPackets: listener.sink.packets,
      udpBytes: listener.sink.bytes,
      consumerRtp: sumStats(consumerStats[index]),
    }));
    const receivedBytes = listenerStats.map(value => value.udpBytes);
    const producerStats = sumStats(await producer.getStats());
    const workerUsageEnd = await worker.getResourceUsage();
    const processUsageEnd = process.resourceUsage();
    const processMemoryEnd = process.memoryUsage();
    const workerCpuMs = workerUsageEnd.ru_utime - workerUsageStart.ru_utime
      + workerUsageEnd.ru_stime - workerUsageStart.ru_stime;
    const processCpuMs = (processUsageEnd.userCPUTime - processUsageStart.userCPUTime
      + processUsageEnd.systemCPUTime - processUsageStart.systemCPUTime) / 1000;
    const summary = {
      schemaVersion: 1,
      mode: 'isolated-plain-rtp-sfu-fanout',
      limits: { listeners: options.listeners, durationSeconds: options.durationSeconds, minimumBytesPerListener: options.minBytes },
      participants: { total: options.listeners + 1, publishers: 1, listeners: options.listeners },
      policyDomain: domain,
      policyRefreshIntervalMs: 800,
      rtp: {
        codec: audioCodec.mimeType,
        payloadType: audioCodec.preferredPayloadType,
        publisherRtpPackets: producerStats.packets,
        publisherRtpBytes: producerStats.bytes,
        listenersReceiving: listenerStats.filter(value => value.udpPackets > 0).length,
        listenerPacketTotal: listenerStats.reduce((total, value) => total + value.udpPackets, 0),
        listenerByteTotal: listenerStats.reduce((total, value) => total + value.udpBytes, 0),
        minimumListenerBytes: Math.min(...receivedBytes),
        maximumListenerBytes: Math.max(...receivedBytes),
        consumersWithRtp: listenerStats.filter(value => value.consumerRtp.packets > 0).length,
        minimumConsumerRtpBytes: Math.min(...listenerStats.map(value => value.consumerRtp.bytes)),
        allListenersMeetThreshold: belowThreshold.length === 0,
        listenersBelowThreshold: belowThreshold.map(value => value.id),
        perListener: listenerStats,
      },
      timings: {
        elapsedSeconds: Number(elapsedSeconds.toFixed(3)),
        consumerSetupMs: Number(consumeSetupMs.toFixed(2)),
      },
      resources: {
        logicalCpuCount: os.availableParallelism?.() ?? os.cpus().length,
        processCpuMs: Number(processCpuMs.toFixed(2)),
        processCpuPercentOfOneCore: Number((processCpuMs / (elapsedSeconds * 1000) * 100).toFixed(2)),
        processRssMiBAtStart: Number((processMemoryStart.rss / 1024 / 1024).toFixed(2)),
        processRssMiBAtEnd: Number((processMemoryEnd.rss / 1024 / 1024).toFixed(2)),
        processHeapUsedMiBAtEnd: Number((processMemoryEnd.heapUsed / 1024 / 1024).toFixed(2)),
        processMaxRssMiB: Number((processUsageEnd.maxRSS / 1024).toFixed(2)),
        nativeWorkerPid: worker.pid,
        nativeWorkerCpuMs: Number(workerCpuMs.toFixed(2)),
        nativeWorkerCpuPercentOfOneCore: Number((workerCpuMs / (elapsedSeconds * 1000) * 100).toFixed(2)),
        nativeWorkerMaxRssMiB: Number((workerUsageEnd.ru_maxrss / 1024).toFixed(2)),
      },
    };
    console.log(`MEDIA_FANOUT_SUMMARY ${JSON.stringify(summary)}`);
    if (belowThreshold.length) {
      console.error(`MEDIA_FANOUT_ASSERTION_FAILED ${belowThreshold.length}/${options.listeners} listeners received less than ${options.minBytes} bytes.`);
      exitCode = 1;
    }
    if (!summary.rtp.publisherRtpBytes || summary.rtp.consumersWithRtp !== options.listeners) {
      console.error('MEDIA_FANOUT_ASSERTION_FAILED SFU RTP counters did not advance for every consumer.');
      exitCode = 1;
    }
  } catch (error) {
    console.error(`MEDIA_FANOUT_FAILURE ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
    exitCode = 1;
  } finally {
    clearInterval(policyRefresh);
    clearInterval(sweep);
    if (ffmpeg && ffmpeg.exitCode === null && ffmpeg.signalCode === null) ffmpeg.kill('SIGTERM');
    for (const sink of sinks) sink.socket.close();
    await engine?.close().catch(() => {});
    if (worker && !worker.closed) worker.close();
  }
  process.exitCode = exitCode;
}

await main();
