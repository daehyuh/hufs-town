import test from 'node:test';
import assert from 'node:assert/strict';
import { MediaEngine } from '../src/engine.mjs';
const person=(id,epoch=1,domain='office/common',peers=['a','b'])=>({id,epoch,domain,peers:peers.filter(p=>p!==id),sources:['MICROPHONE','CAMERA','SCREEN','SCREEN_AUDIO']});
function setup(){let time=1000;const engine=new MediaEngine({}, {}, {now:()=>time});let seq=0;return {engine,advance:ms=>time+=ms,frame:people=>engine.apply({worldId:'world',sequence:++seq,leaseMillis:1500,people})};}
test('event domains allow 100 receiver peers while nearby domains stay capped at 12',()=>{
 const domain='space/event/event-1';
 const eventPerson=(id,peers)=>({id,epoch:1,domain,peers,sources:[]});
 const {frame}=setup();
 const speakers=Array.from({length:100},(_,i)=>`speaker-${i}`);
 const people=[eventPerson('listener',speakers),...speakers.map(id=>eventPerson(id,['listener']))];
 const result=frame(people);
 assert.equal(result.people.length,101);
 assert.equal(result.people.find(person=>person.id==='listener').peers.length,100);
 assert.throws(()=>frame([eventPerson('listener',[...speakers,'speaker-100']),...speakers.map(id=>eventPerson(id,['listener']))]),{message:'통화 허용 대상 목록이 올바르지 않아요.'});
 const ordinaryDomain='space:map/event/common';
 assert.throws(()=>frame([{...eventPerson('listener',Array.from({length:13},(_,i)=>`nearby-${i}`)),domain:ordinaryDomain}]),{message:'통화 허용 대상 목록이 올바르지 않아요.'});
});
test('only canonical event keys receive the 100 peer allowance',()=>{
 const {frame}=setup();
 const malformed=['fake:event/event-1','space/event/event/extra','space/event/event.1','space:map/event/common','/event/event-1'];
 for(const domain of malformed){
  const people=[{id:'listener',epoch:1,domain,peers:Array.from({length:13},(_,i)=>`peer-${i}`),sources:[]}];
  assert.throws(()=>frame(people),{message:'통화 허용 대상 목록이 올바르지 않아요.'},domain);
 }
});
test('policy application computes one offer snapshot per participant and reuses it for the response',()=>{
 const {engine,frame}=setup();
 const people=Array.from({length:12},(_,index)=>({
  id:`peer-${index}`,
  epoch:1,
  domain:'office/common',
  peers:Array.from({length:12},(_,other)=>`peer-${other}`).filter(id=>id!==`peer-${index}`),
  sources:['MICROPHONE'],
 }));
 let calls=0;
 const offers=engine.offers.bind(engine);
 engine.offers=peer=>{calls++;return offers(peer);};
 const result=frame(people);
 assert.equal(result.people.length,12);
 assert.equal(calls,12);
});
test('simulcast camera consumers use the lowest video layer for bandwidth headroom',async()=>{
 const {engine,frame}=setup();
 const domain='space/event/event-1';
 frame([person('speaker',1,domain,['listener']),person('listener',1,domain,['speaker'])]);
 const world=engine.worlds.get('world'),speaker=world.peers.get('speaker'),listener=world.peers.get('listener');
 speaker.producers.set('CAMERA',{id:'camera-producer',kind:'video',closed:false});
 let preferredLayers;
 const consumer={id:'camera-consumer',kind:'video',type:'simulcast',rtpParameters:{},on(){},close(){},async setPreferredLayers(layers){preferredLayers=layers;}};
 listener.transports.set('recv',{direction:'recv',resource:{closed:false,consume:async()=>consumer}});
 engine.router=async()=>({canConsume:()=>true});
 const reply=await engine.rpc({worldId:'world',playerId:'listener',epoch:1,method:'consume',data:{transportId:'recv',producerId:'camera-producer',rtpCapabilities:{}}});
 assert.equal(reply.source,'CAMERA');
 assert.deepEqual(preferredLayers,{spatialLayer:0});
 await engine.rpc({worldId:'world',playerId:'listener',epoch:1,method:'setPreferredLayers',data:{consumerId:'camera-consumer',spatialLayer:1}});
 assert.deepEqual(preferredLayers,{spatialLayer:1});
 await engine.rpc({worldId:'world',playerId:'listener',epoch:1,method:'setPreferredLayers',data:{consumerId:'camera-consumer',spatialLayer:0}});
 assert.deepEqual(preferredLayers,{spatialLayer:0});
});
test('preferred-layer response is stale when its consumer is revoked during the SFU request',async()=>{
 const {engine,frame}=setup();
 const domain='space/event/event-1';
 frame([person('speaker',1,domain,['listener']),person('listener',1,domain,['speaker'])]);
 const world=engine.worlds.get('world'),speaker=world.peers.get('speaker'),listener=world.peers.get('listener');
 let finishLayerChange,closed=false;
 const resource={type:'simulcast',closed:false,currentLayers:{spatialLayer:1,temporalLayer:2},close(){closed=true;this.closed=true;},setPreferredLayers:()=>new Promise(resolve=>{finishLayerChange=resolve;})};
 const consumer={resource,sender:speaker,source:'CAMERA',producer:{closed:false}};
 listener.consumers.set('camera-consumer',consumer);
 const pending=engine.rpc({worldId:'world',playerId:'listener',epoch:1,method:'setPreferredLayers',data:{consumerId:'camera-consumer',spatialLayer:1}});
 await new Promise(resolve=>setImmediate(resolve));
 frame([person('speaker',1,domain,[]),person('listener',1,domain,[])]);
 frame([person('speaker',1,domain,['listener']),person('listener',1,domain,['speaker'])]);
 finishLayerChange();
 await assert.rejects(pending,{code:'MEDIA_STALE'});
 assert.equal(closed,true);
 assert.equal(listener.consumers.has('camera-consumer'),false);
});
test('consumer is removed and closed when preferred simulcast layer selection fails',async()=>{
 const {engine,frame}=setup();
 const domain='space/event/event-1';
 frame([person('speaker',1,domain,['listener']),person('listener',1,domain,['speaker'])]);
 const world=engine.worlds.get('world'),speaker=world.peers.get('speaker'),listener=world.peers.get('listener');
 speaker.producers.set('CAMERA',{id:'camera-producer',kind:'video',closed:false});
 let closed=false;
 const consumer={id:'camera-consumer',kind:'video',type:'simulcast',rtpParameters:{},on(){},close(){closed=true;},async setPreferredLayers(){throw new Error('layer unavailable');}};
 listener.transports.set('recv',{direction:'recv',resource:{closed:false,consume:async()=>consumer}});
 engine.router=async()=>({canConsume:()=>true});
 await assert.rejects(engine.rpc({worldId:'world',playerId:'listener',epoch:1,method:'consume',data:{transportId:'recv',producerId:'camera-producer',rtpCapabilities:{}}}),/layer unavailable/);
 assert.equal(closed,true);
 assert.equal(listener.consumers.size,0);
});
test('server policy revokes consumers immediately on privacy boundary changes',()=>{
 const {engine,frame}=setup();frame([person('a'),person('b')]);const world=engine.worlds.get('world'),a=world.peers.get('a'),b=world.peers.get('b');let closed=false;
 a.consumers.set('c',{sender:b,source:'SCREEN_AUDIO',producer:{closed:false},resource:{close:()=>closed=true}});
 frame([person('a'),person('b',2,'office/private')]);assert.equal(closed,true);assert.equal(a.consumers.size,0);assert.deepEqual(engine.view(world).people.find(p=>p.id==='a').offers,[]);
});
test('revoke fencing and sequence prevent delayed policy from restoring old sessions',()=>{
 const {engine,frame}=setup();frame([person('a')]);engine.revoke({worldId:'world',playerId:'a',epoch:2});frame([person('a',1)]);assert.equal(engine.worlds.get('world').peers.size,0);
 frame([person('a',2)]);engine.apply({worldId:'world',sequence:1,leaseMillis:1500,people:[]});assert.equal(engine.worlds.get('world').peers.get('a').epoch,2);
});
test('expired control leases close transports without browser cooperation',()=>{
 const {engine,frame,advance}=setup();frame([person('a')]);const p=engine.worlds.get('world').peers.get('a');let closed=false;p.transports.set('t',{resource:{close:()=>closed=true}});advance(1501);engine.sweep();assert.equal(closed,true);assert.equal(p.closed,true);
});

test('control policy lease is relative to SFU receive time and capped at two seconds',()=>{
 const time=1000;const engine=new MediaEngine({}, {}, {now:()=>time});
 assert.doesNotThrow(()=>engine.apply({worldId:'lease-boundary',sequence:1,leaseMillis:2000,people:[]}));
 assert.throws(()=>engine.apply({worldId:'lease-boundary',sequence:2,leaseMillis:2001,people:[]}),/통화 정책의 유효 시간이 지났어요/);
 assert.throws(()=>engine.apply({worldId:'lease-boundary',sequence:2,leaseMillis:0,people:[]}),/통화 정책의 유효 시간이 지났어요/);
});
test('consumer creation rechecks policy after asynchronous SFU creation and before resume',async()=>{
 const {engine,frame}=setup();frame([person('a'),person('b')]);const w=engine.worlds.get('world'),a=w.peers.get('a'),b=w.peers.get('b');b.producers.set('CAMERA',{id:'producer',kind:'video',closed:false,close(){this.closed=true}});
 let resolve,closed=false;const pending=new Promise(r=>resolve=r);a.transports.set('recv',{direction:'recv',resource:{closed:false,consume:()=>pending,close(){}}});engine.router=async()=>({canConsume:()=>true});
 const call=engine.rpc({worldId:'world',playerId:'a',epoch:1,method:'consume',data:{transportId:'recv',producerId:'producer',rtpCapabilities:{}}});
 await new Promise(r=>setImmediate(r));frame([person('a',1,'office/common',[]),person('b',1,'office/common',[])]);resolve({id:'consumer',close:()=>closed=true});
 await assert.rejects(call,{code:'MEDIA_STALE'});assert.equal(closed,true);assert.equal(a.consumers.size,0);
});
test('client source and receiver requests cannot widen server policy',async()=>{
 const {engine,frame}=setup();frame([{...person('a'),sources:[]},person('b',1,'office/private')]);
 await assert.rejects(engine.rpc({worldId:'world',playerId:'a',epoch:1,method:'produce',data:{source:'MICROPHONE'}}),{code:'MEDIA_DENIED'});
 await assert.rejects(engine.rpc({worldId:'world',playerId:'a',epoch:1,method:'consume',data:{producerId:'unavailable'}}),{code:'MEDIA_DENIED'});
});

test('shared-screen audio always belongs to the selected screen owner',()=>{
 const {engine,frame}=setup();frame(['a','b','c'].map(n=>person(n,1,'office/common',['a','b','c'])));
 const w=engine.worlds.get('world'),a=w.peers.get('a'),b=w.peers.get('b'),c=w.peers.get('c');
 b.producers.set('SCREEN_AUDIO',{id:'b-audio',kind:'audio',closed:false});
 c.producers.set('SCREEN',{id:'c-video',kind:'video',closed:false});c.producers.set('SCREEN_AUDIO',{id:'c-audio',kind:'audio',closed:false});
 assert.deepEqual(engine.offers(a).map(o=>o.id).sort(),['c-audio','c-video']);
});

test('inactive fences are reclaimed even while the world remains occupied',()=>{
 const {engine,frame,advance}=setup();frame([person('a'),person('b')]);frame([person('b')]);advance(61_000);frame([person('b')]);
 assert.deepEqual([...engine.worlds.get('world').fences.keys()],['b']);
});
