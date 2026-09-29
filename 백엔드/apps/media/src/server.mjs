import { createWorker } from 'mediasoup';
import { MediaEngine } from './engine.mjs';
import { createControlServer } from './control.mjs';
import { createIceServersProvider } from './ice-servers.mjs';
const token = process.env.MEDIA_CONTROL_TOKEN ?? '';
if (token.length < 32) throw new Error('MEDIA_CONTROL_TOKEN must contain at least 32 characters');
const iceServers = createIceServersProvider(process.env.MEDIA_ICE_SERVERS_JSON ?? '[]', {
  sharedSecret: process.env.MEDIA_TURN_SHARED_SECRET ?? '',
  credentialTtlSeconds: process.env.MEDIA_TURN_CREDENTIAL_TTL_SECONDS
    ? Number(process.env.MEDIA_TURN_CREDENTIAL_TTL_SECONDS)
    : undefined,
});
const worker = await createWorker({ logLevel: 'warn' });
const rtcPort = Number(process.env.MEDIA_RTC_PORT ?? 44444);
const rtcServer = await worker.createWebRtcServer({ listenInfos: ['udp','tcp'].map(protocol => ({ protocol, ip: '0.0.0.0', announcedAddress: process.env.MEDIA_ANNOUNCED_ADDRESS ?? '127.0.0.1', port: rtcPort })) });
const engine = new MediaEngine(worker, rtcServer, { iceServers });
const server = createControlServer({ engine, token });
const timer = setInterval(() => engine.sweep(), 100);
let shutdownPromise;
const shutdown = async () => {
  if (shutdownPromise) return shutdownPromise;
  shutdownPromise = (async () => {
    clearInterval(timer);
    await engine.close().catch(() => {});
    await new Promise(resolve => server.close(() => resolve()));
    try { worker.close(); } catch { /* The native worker may already be dead. */ }
  })();
  return shutdownPromise;
};
worker.on('died', () => {
  console.error('Media worker stopped');
  void shutdown().finally(() => process.exit(1));
});
await engine.recordings.initialize().catch(error => console.error('Recording storage unavailable; recording will fail closed'));
server.listen(Number(process.env.PORT ?? 18082), '0.0.0.0', () => console.log('HUFS media control and WebRTC ready'));
process.on('SIGTERM', () => { void shutdown(); });
process.on('SIGINT', () => { void shutdown(); });
