import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorker } from 'mediasoup';
import { MediaEngine } from '../src/engine.mjs';

const sources = ['MICROPHONE', 'CAMERA', 'SCREEN', 'SCREEN_AUDIO'];

test('native worker closes a reported participant media sources and their active consumers', async () => {
  const worker = await createWorker({ logLevel: 'error' });
  const rtcServer = await worker.createWebRtcServer({
    listenInfos: [{ protocol: 'udp', ip: '127.0.0.1', port: 0 }],
  });
  let now = Date.now();
  let sequence = 0;
  const engine = new MediaEngine(worker, rtcServer, { now: () => now });
  const policy = (targetSources, policySequence = ++sequence) =>
    engine.apply({
      worldId: 'moderation-worker-test',
      sequence: policySequence,
      leaseMillis: 1500,
      people: [
        {
          id: 'reported-user',
          epoch: 1,
          domain: 'space/common',
          peers: ['listener'],
          sources: targetSources,
        },
        {
          id: 'listener',
          epoch: 1,
          domain: 'space/common',
          peers: ['reported-user'],
          sources,
        },
      ],
    });
  const rpc = (playerId, method, data = {}) =>
    engine.rpc({
      worldId: 'moderation-worker-test',
      playerId,
      epoch: 1,
      method,
      data,
    });

  try {
    policy(sources);
    const { routerRtpCapabilities } = await rpc('listener', 'capabilities');
    const send = await rpc('reported-user', 'createTransport', {
      direction: 'send',
    });
    const receive = await rpc('listener', 'createTransport', {
      direction: 'recv',
    });
    const rtp = (source, index) => {
      const audio = source === 'MICROPHONE' || source === 'SCREEN_AUDIO';
      return {
        codecs: [
          audio
            ? {
                mimeType: 'audio/opus',
                payloadType: 111,
                clockRate: 48000,
                channels: 2,
              }
            : {
                mimeType: 'video/VP8',
                payloadType: 96,
                clockRate: 90000,
              },
        ],
        encodings: [{ ssrc: 12340000 + index }],
        rtcp: { cname: `moderation-source-${index}` },
      };
    };

    const producerIds = new Map();
    const consumerResources = [];
    for (const [index, source] of sources.entries()) {
      const kind = source === 'MICROPHONE' || source === 'SCREEN_AUDIO'
        ? 'audio'
        : 'video';
      const producer = await rpc('reported-user', 'produce', {
        transportId: send.id,
        source,
        kind,
        rtpParameters: rtp(source, index),
      });
      producerIds.set(source, producer.id);
      const consumer = await rpc('listener', 'consume', {
        transportId: receive.id,
        producerId: producer.id,
        rtpCapabilities: routerRtpCapabilities,
      });
      await rpc('listener', 'resumeConsumer', { consumerId: consumer.id });
      consumerResources.push(
        engine.worlds
          .get('moderation-worker-test')
          .peers.get('listener')
          .consumers.get(consumer.id).resource,
      );
    }

    const reportedPeer = engine.worlds
      .get('moderation-worker-test')
      .peers.get('reported-user');
    const listenerPeer = engine.worlds
      .get('moderation-worker-test')
      .peers.get('listener');
    const producerResources = sources.map((source) =>
      reportedPeer.producers.get(source),
    );
    assert.deepEqual(
      engine.view(reportedPeer.world).people.find((person) => person.id === 'listener')
        .offers.map((offer) => offer.source).sort(),
      [...sources].sort(),
    );
    assert.equal(listenerPeer.consumers.size, sources.length);

    policy([]);

    assert.deepEqual(producerResources.map((producer) => producer.closed),
      sources.map(() => true));
    assert.deepEqual(consumerResources.map((consumer) => consumer.closed),
      sources.map(() => true));
    assert.equal(reportedPeer.producers.size, 0);
    assert.equal(listenerPeer.consumers.size, 0);
    assert.deepEqual(
      engine.view(reportedPeer.world).people.find((person) => person.id === 'listener')
        .offers,
      [],
    );
    await assert.rejects(
      rpc('reported-user', 'produce', {
        transportId: send.id,
        source: 'MICROPHONE',
        kind: 'audio',
        rtpParameters: rtp('MICROPHONE', 0),
      }),
      { code: 'MEDIA_DENIED' },
    );

    const stalePolicy = policy(sources, 1);
    assert.equal(stalePolicy.people.find((person) => person.id === 'reported-user')
      .offers.length, 0);
    assert.equal(reportedPeer.producers.size, 0);
  } finally {
    engine.close();
    rtcServer.close();
    worker.close();
  }
});
