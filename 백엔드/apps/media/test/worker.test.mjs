import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorker } from 'mediasoup';
import { MediaEngine } from '../src/engine.mjs';

test('native worker: revocation and expired policy close real producers, consumers and transports',async()=>{
 const worker=await createWorker({logLevel:'error'});
 const rtc=await worker.createWebRtcServer({listenInfos:[{protocol:'udp',ip:'127.0.0.1',port:0}]});
 let now=Date.now(),sequence=0;
 const engine=new MediaEngine(worker,rtc,{now:()=>now});
 const people=()=>['a','b'].map(id=>({id,epoch:1,domain:'test/common',peers:[id==='a'?'b':'a'],sources:['MICROPHONE']}));
 const apply=items=>engine.apply({worldId:'worker-test',sequence:++sequence,leaseMillis:1500,people:items});
 const rpc=(playerId,method,data={})=>engine.rpc({worldId:'worker-test',playerId,epoch:1,method,data});
 try {
  apply(people());
  const {routerRtpCapabilities}=await rpc('b','capabilities');
  const send=await rpc('a','createTransport',{direction:'send'}),recv=await rpc('b','createTransport',{direction:'recv'});
  const producer=await rpc('a','produce',{transportId:send.id,source:'MICROPHONE',kind:'audio',rtpParameters:{codecs:[{mimeType:'audio/opus',payloadType:111,clockRate:48000,channels:2}],encodings:[{ssrc:12345678}],rtcp:{cname:'synthetic-test'}}});
  const consumer=await rpc('b','consume',{transportId:recv.id,producerId:producer.id,rtpCapabilities:routerRtpCapabilities});
  const world=engine.worlds.get('worker-test'),a=world.peers.get('a'),b=world.peers.get('b'),resource=b.consumers.get(consumer.id).resource;
  assert.equal(resource.paused,true);await rpc('b','resumeConsumer',{consumerId:consumer.id});assert.equal(resource.paused,false);
  apply(people().map(p=>({...p,peers:[]})));assert.equal(resource.closed,true);assert.equal(b.consumers.size,0);
  const transport=a.transports.get(send.id).resource,source=a.producers.get('MICROPHONE');
  now+=1501;engine.sweep();assert.equal(transport.closed,true);assert.equal(source.closed,true);assert.equal(world.peers.size,0);
 }finally{engine.close();rtc.close();worker.close();}
});
