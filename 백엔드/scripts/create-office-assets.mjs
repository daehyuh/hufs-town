import { mkdir, writeFile, copyFile, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.resolve(root, '../프론트/public/assets/office');
await mkdir(output, { recursive: true });
const C = { ink:'#34433f', dark:'#465751', wood:'#bd9469', edge:'#8a674d', top:'#e0c49a', light:'#f1e4c9', blue:'#7697a7', navy:'#465d73', sage:'#879e7c', cream:'#e8e6d8', gray:'#adb8b2', screen:'#87c9d0', leaf:'#60915c', pot:'#c68c67' };
const rect = (x,y,w,h,color) => `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${color}"/>`;
const parts = [];
function asset(id, name, category, w,h, collision, draw) {
  const svg=`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" shape-rendering="crispEdges">${draw}</svg>`;
  parts.push({id,name,category,width:w,height:h,footprint:collision, url:`/assets/office/${id}.svg`,source:'code-native pixel geometry', svg});
}
function desk(w=48,h=32) {
  let s=rect(1,9,w-2,h-10,C.ink)+rect(3,26,4,6,C.dark)+rect(w-7,26,4,6,C.dark)+rect(2,8,w-4,19,C.edge)+rect(2,6,w-4,17,C.top)+rect(4,7,w-8,1,C.light);
  for(let x=9;x<w-3;x+=12)s+=rect(x,8,1,13,'#d3b487'); return s;
}
const monitor=(x,y)=>rect(x,y,17,12,C.ink)+rect(x+2,y+2,13,8,C.screen)+rect(x+7,y+12,3,3,C.dark)+rect(x+3,y+15,11,2,C.gray)+rect(x+3,y+4,6,1,'#d4f0d9')+rect(x+3,y+6,9,1,'#addfda');
asset('desk-monitor','모니터 책상','업무',48,32,{x:0.0625,y:-1.625,width:2.875,height:1.5},desk()+monitor(8,0)+rect(9,19,15,4,C.cream)+rect(10,20,13,1,C.gray)+rect(30,17,5,5,C.light)+rect(31,16,3,2,C.edge)+rect(36,9,7,9,'#729180')+rect(37,10,5,6,'#a5bc95'));
asset('desk-clear','빈 책상','업무',48,32,{x:0.0625,y:-1.625,width:2.875,height:1.5},desk()+rect(7,10,8,10,C.cream)+rect(8,12,6,1,C.gray));
asset('desk-laptop','노트북 책상','업무',48,32,{x:0.0625,y:-1.625,width:2.875,height:1.5},desk()+rect(16,5,18,11,C.navy)+rect(18,7,14,7,'#91abbc')+rect(14,16,22,6,C.gray)+rect(16,17,18,2,C.cream)+rect(39,13,4,5,'#d9b874'));
for(const [dir,front] of [['front',true],['back',false]]) {
 let s=rect(6,22,2,8,C.ink)+rect(3,28,12,2,C.ink)+rect(1,27,3,3,C.dark)+rect(15,27,3,3,C.dark);
 s+=rect(2,12,15,11,C.ink)+rect(3,11,13,9,C.navy)+rect(5,12,9,6,C.blue);
 s+=front ? rect(3,1,13,14,C.ink)+rect(4,0,11,13,C.navy)+rect(5,2,9,9,C.blue) : rect(3,17,13,8,C.navy)+rect(4,18,11,5,C.blue);
 asset(`chair-${dir}`,front?'오피스 의자 · 앞':'오피스 의자 · 뒤','좌석',20,32,null,s);
}
asset('meeting-table','회의 테이블','회의',80,48,{x:0.125,y:-2.125,width:4.75,height:1.875},rect(3,13,74,29,C.ink)+rect(7,37,5,11,C.dark)+rect(68,37,5,11,C.dark)+rect(2,10,76,26,C.edge)+rect(2,7,76,25,C.top)+rect(4,8,72,1,C.light)+rect(39,9,1,21,'#d3b487')+rect(10,14,10,10,C.cream)+rect(12,16,6,1,C.gray)+rect(58,17,11,7,C.gray)+rect(58,9,11,9,C.navy)+rect(59,10,9,6,C.screen)+rect(32,15,4,5,'#b78365')+rect(33,13,2,3,C.leaf));
asset('whiteboard','화이트보드','회의',64,48,{x:0.125,y:-0.4,width:3.75,height:0.4},rect(6,33,3,15,C.gray)+rect(55,33,3,15,C.gray)+rect(2,44,12,3,C.dark)+rect(51,44,11,3,C.dark)+rect(1,2,62,34,C.dark)+rect(3,3,58,30,C.gray)+rect(5,5,54,26,'#f8f7e9')+rect(10,10,17,2,C.blue)+rect(10,17,8,7,'#a8b58d')+rect(22,17,11,7,'#e0ba74')+rect(37,17,15,7,'#a8c4c7')+rect(18,20,4,1,C.gray)+rect(33,20,4,1,C.gray)+rect(43,33,10,2,C.edge));
asset('sofa-sage','세이지 소파','라운지',64,40,{x:0.125,y:-1.5,width:3.75,height:1.5},rect(4,35,5,5,C.edge)+rect(55,35,5,5,C.edge)+rect(2,6,60,30,C.dark)+rect(4,2,56,24,'#597b68')+rect(6,4,52,16,C.sage)+rect(5,21,54,12,'#a5b394')+rect(31,4,2,29,'#6a8870')+rect(0,15,6,18,'#597b68')+rect(58,15,6,18,'#597b68')+rect(9,10,10,10,'#e1d1aa')+rect(45,9,9,10,'#c0c9a7'));
asset('armchair','라운지 의자','라운지',32,40,{x:0.125,y:-1.5,width:1.75,height:1.5},rect(5,35,4,5,C.edge)+rect(23,35,4,5,C.edge)+rect(2,6,28,30,C.navy)+rect(5,2,22,23,C.blue)+rect(6,22,20,10,'#a3bac4')+rect(0,16,6,18,C.navy)+rect(26,16,6,18,C.navy));
asset('coffee-table','낮은 테이블','라운지',48,32,{x:0.125,y:-1.0,width:2.75,height:1.0},rect(6,22,4,8,C.edge)+rect(38,22,4,8,C.edge)+rect(2,10,44,15,C.edge)+rect(2,7,44,14,C.top)+rect(5,8,38,1,C.light)+rect(9,10,12,9,C.cream)+rect(10,11,10,2,'#91a6a6')+rect(31,11,5,5,'#f9efda')+rect(32,10,3,2,C.edge));
asset('reception','리셉션 데스크','라운지',80,48,{x:0.0625,y:-2.0,width:4.875,height:2.0},rect(1,14,78,33,C.dark)+rect(2,13,76,29,C.edge)+rect(3,11,74,9,C.top)+rect(5,21,70,20,'#a67f58')+rect(7,23,66,1,'#c6a176')+rect(8,27,1,13,'#916b4d')+rect(20,27,1,13,'#916b4d')+rect(59,27,1,13,'#916b4d')+rect(71,27,1,13,'#916b4d')+monitor(49,0)+rect(9,11,12,5,C.cream));
asset('bookshelf','책장','수납',48,56,{x:0.0625,y:-1,width:2.875,height:1},rect(1,1,46,54,C.ink)+rect(2,0,44,53,C.edge)+rect(5,4,38,44,'#685741')+rect(3,21,42,3,C.top)+rect(3,42,42,3,C.top)+rect(3,49,42,3,C.top)+[7,14,21,28,35].map((x,i)=>rect(x,7+(i%2)*3,5,14-(i%2)*3,[C.blue,C.sage,'#ceab74','#b77e68',C.cream][i])).join('')+[7,13,22,29,35].map((x,i)=>rect(x,27,5,15,[C.cream,C.blue,'#ceab74',C.sage,C.cream][i])).join(''));
asset('cabinet','수납장','수납',48,40,{x:0.0625,y:-1,width:2.875,height:1},rect(1,1,46,37,C.ink)+rect(2,0,44,36,C.gray)+rect(4,4,40,28,C.cream)+rect(23,4,2,28,C.gray)+rect(19,15,2,6,C.dark)+rect(28,15,2,6,C.dark)+rect(5,36,5,4,C.dark)+rect(38,36,5,4,C.dark));
asset('pantry','커피 스테이션','라운지',64,48,{x:0.0625,y:-1.4,width:3.875,height:1.4},rect(1,22,62,25,C.ink)+rect(2,21,60,22,C.edge)+rect(3,25,58,17,C.top)+rect(23,25,2,17,C.edge)+rect(42,25,2,17,C.edge)+rect(2,19,60,5,C.cream)+rect(5,4,18,17,C.dark)+rect(7,6,14,7,C.ink)+rect(10,14,6,5,'#e5d9bd')+rect(27,15,6,5,C.light)+rect(35,15,6,5,C.light)+rect(46,11,10,9,C.gray)+rect(49,4,4,9,C.gray)+rect(49,3,8,3,C.gray));
asset('plant-large','큰 화분','식물',24,48,{x:0.1875,y:-0.5,width:1.125,height:0.5},rect(6,32,12,15,C.pot)+rect(4,31,16,4,'#deb18a')+rect(11,8,2,26,'#74814b')+rect(3,4,10,11,C.leaf)+rect(1,8,8,9,'#7da46e')+rect(12,12,10,11,'#497c55')+rect(9,1,10,11,'#7da46e')+rect(3,21,9,8,'#497c55')+rect(15,4,7,7,C.leaf));
asset('plant-small','책상 화분','장식',16,24,null,rect(5,16,7,8,C.pot)+rect(4,16,9,2,'#dfb48c')+rect(7,8,2,9,C.leaf)+rect(3,5,6,8,'#7ba769')+rect(8,1,5,10,C.leaf)+rect(10,8,5,5,'#497c55'));
asset('rug-sage','세이지 러그','바닥 장식',96,64,null,rect(0,0,96,64,'#80917a')+rect(2,2,92,60,'#b3b99a')+rect(5,5,86,54,'#a3ad8f')+rect(7,7,82,50,'#b8bea3'));
asset('rug-blue','블루 러그','바닥 장식',96,64,null,rect(0,0,96,64,'#627e8e')+rect(2,2,92,60,'#9aafba')+rect(5,5,86,54,'#879fae')+rect(7,7,82,50,'#a4b7bd'));
asset('water-cooler','정수기','라운지',24,48,{x:0.125,y:-0.75,width:1.25,height:0.75},rect(3,18,18,29,C.dark)+rect(4,17,16,27,C.cream)+rect(5,25,14,11,C.gray)+rect(9,28,3,3,C.blue)+rect(14,28,3,3,'#c47f6c')+rect(7,5,10,14,'#a0cbd2')+rect(9,1,6,5,'#76a1b4')+rect(8,7,2,9,'#cee9e0'));
asset('divider','낮은 파티션','회의',64,40,{x:0,y:-0.35,width:4,height:0.35},rect(3,33,4,7,C.dark)+rect(57,33,4,7,C.dark)+rect(1,2,62,31,C.ink)+rect(3,3,58,27,'#a5bbaa')+rect(5,5,54,23,'#c1d3c3')+rect(31,3,2,27,C.gray));
asset('screen','발표 화면','회의',64,48,{x:0.125,y:-0.35,width:3.75,height:0.35},rect(7,41,7,7,C.dark)+rect(50,41,7,7,C.dark)+rect(1,2,62,40,C.ink)+rect(4,5,56,32,'#e4ece0')+rect(8,9,22,3,C.navy)+rect(8,16,15,2,C.blue)+rect(8,21,44,2,'#b9c7b6')+rect(8,26,30,2,'#b9c7b6')+rect(43,10,7,7,'#7dad90')+rect(51,10,5,7,'#d7b271'));
for (const item of parts) await writeFile(path.join(output, `${item.id}.svg`), item.svg+'\n');
const catalog=parts.map(({svg,...item})=>({...item,layer:item.category==='바닥 장식'?'GROUND':'OBJECT'}));
const plantSource = path.resolve(root, '../디자인에셋/Pixel Art (6364)/RPG (1437)/Scenery (343)/Sprites (330)');
for(const [id,file] of [['original-plant','potted_plant_1.png'],['original-tree','tree_potted_1.png']]) {
 await copyFile(path.join(plantSource,file),path.join(output,file));
 catalog.push({id,name:id==='original-plant'?'도트 화분':'도트 실내 나무',category:'식물',width:16,height:id==='original-plant'?16:32,footprint:{x:0.125,y:-0.5,width:0.75,height:0.5},url:`/assets/office/${file}`,source:'user-provided RPG scenery',layer:'OBJECT'});
}
const sourceManifest = JSON.parse(await readFile(path.join(root, 'assets/source-manifest.json'), 'utf8'));
const sceneryPrefix = 'Pixel Art (6364)/RPG (1437)/Scenery (343)/Sprites (330)/';
const campusDecorations = [
 ['campus-tree-large','tree_deciduous_huge_1.png','큰 도트 나무',{x:1.125,y:-0.5,width:0.75,height:0.5}],
 ['campus-tree','tree_deciduous_1.png','도트 나무',{x:0.625,y:-0.5,width:0.75,height:0.5}],
 ['campus-tree-small','tree_deciduous_small_1.png','작은 도트 나무',{x:0.125,y:-0.5,width:0.75,height:0.5}],
 ['campus-bush','bush_1.png','도트 수풀',{x:0.125,y:-0.5,width:0.75,height:0.5}],
 ['campus-berries','bush_berries_1.png','열매 수풀',{x:0.125,y:-0.5,width:0.75,height:0.5}],
 ['campus-house','house_woodland_1.png','캠퍼스 작은 건물',{x:0.25,y:-1,width:2.5,height:1}],
 ['campus-house-large','house_woodland_big.png','캠퍼스 커뮤니티 하우스',{x:0.25,y:-1,width:2.5,height:1}],
 ['campus-sign','sign_1.png','도트 안내 표지판',{x:0.125,y:-0.5,width:0.75,height:0.5}],
];
for (const [id,file,name,footprint] of campusDecorations) {
 const source = `${sceneryPrefix}${file}`;
 const item = sourceManifest.find(asset => asset.source === source);
 if (!item?.runtime || !item.width || !item.height) throw Error(`Missing selected runtime asset: ${source}`);
 catalog.push({id,name,category:'캠퍼스',width:item.width,height:item.height,footprint,url:`/assets/${file}`,source:'user-provided RPG scenery',layer:'OBJECT'});
}
catalog.push({id:'gdg-sign',name:'GDG HUFS 로고',category:'장식',width:48,height:27,footprint:null,url:'/assets/gdg-mark.svg',source:'user-provided GDG logo',layer:'OBJECT'});
await writeFile(path.join(root,'assets/office-catalog.json'),JSON.stringify({version:1,items:catalog},null,2)+'\n');
await writeFile(path.join(output,'catalog.json'),JSON.stringify({version:1,items:catalog},null,2)+'\n');
await writeFile(path.join(root,'../프론트/src/generated/office-catalog.json'),JSON.stringify({version:1,items:catalog},null,2)+'\n');
console.log(`Office catalog: ${catalog.length} objects, supplied plants/brand and code-native pixel furniture`);
