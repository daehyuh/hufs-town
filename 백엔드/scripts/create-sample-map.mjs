import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const catalog = JSON.parse(await readFile(path.join(root,'assets/office-catalog.json'),'utf8')).items;
const map = { schemaVersion:2, id:'hufs-office', revision:'office-v2', name:'GDG HUFS 훕스타운', width:48,height:34,spawnX:24,spawnY:29.5,collisions:[],objects:[],zones:[],floors:[],walls:[],labels:[] };
const rect=(x,y,width,height)=>({x,y,width,height});
const floor=(material,x,y,w,h)=>map.floors.push({id:`floor-${map.floors.length}`,material,bounds:rect(x,y,w,h)});
const wall=(x,y,w,h,material='CREAM')=>{const bounds=rect(x,y,w,h);map.walls.push({id:`wall-${map.walls.length}`,material,bounds});map.collisions.push(bounds);};
const object=(asset,x,y,scale=2)=>{
 const info=catalog.find(a=>a.id===asset);if(!info)throw Error(asset);
 map.objects.push({id:`object-${map.objects.length}`,asset,x,y,scale});
 const f=info.footprint,s=scale/2;if(f)map.collisions.push(rect(x+(f.x-info.width/32)*s,y+f.y*s,f.width*s,f.height*s));
};
const zone=(id,name,kind,x,y,w,h)=>map.zones.push({id,name,kind,bounds:rect(x,y,w,h)});
floor('OAK',1,1,46,32);
floor('CARPET_BLUE',1.5,1.5,13.5,10.5);floor('CARPET_SAGE',33.5,1.5,13,10.5);
floor('WOOD',16.5,2,15,22);floor('TILE',1.5,13,13.5,8);floor('CARPET_SAGE',1.5,21,13.5,11.5);
floor('CARPET_BLUE',33.5,20.5,13,12);floor('CONCRETE',18,25,12,8);
wall(1,1,46,.5);wall(1,1,.5,32);wall(46.5,1,.5,32);wall(1,32.5,20,.5);wall(27,32.5,20,.5);
wall(15,1,.5,11.5,'GLASS');wall(1,12,5,.5,'GLASS');wall(9,12,6.5,.5,'GLASS');
wall(33,1,.5,11.5,'GLASS');wall(33,12,5,.5,'GLASS');wall(41,12,6,.5,'GLASS');
wall(15,18,.5,7,'SAGE');wall(15,28,.5,5,'SAGE');wall(1,18,9,.5,'SAGE');
wall(33,20,14,.5,'GLASS');wall(33,20,.5,5,'GLASS');wall(33,28,.5,5,'GLASS');
object('whiteboard',8,4);object('meeting-table',8,8.7);
for(const x of [5.7,8,10.3]){object('chair-back',x,6);object('chair-front',x,10.6);}
object('plant-large',3,5);object('plant-large',13.5,11);
object('screen',40,4);object('meeting-table',40,8.7);
for(const x of [37.7,40,42.3]){object('chair-back',x,6);object('chair-front',x,10.6);}
object('plant-large',35,5);object('bookshelf',44.6,5.3);
for(const y of [8.5,15.5,22.5]) for(const x of [19,29]) {
 object('desk-monitor',x,y);object('chair-front',x,y+1.5);object('plant-small',x+1.05,y-.9);
}
object('cabinet',19,4);object('cabinet',29,4);object('gdg-sign',24,3.9);
object('plant-large',16.8,13);object('plant-large',31,20.5);
object('pantry',5,16.3);object('water-cooler',9,16.5);object('bookshelf',12.5,16.8);
object('original-plant',3,17.5);object('original-plant',13.5,17.5);
object('rug-sage',8,31.5);object('sofa-sage',7.5,24.5);object('coffee-table',8,28);object('armchair',4,30);object('armchair',12,30);
object('plant-large',3,22.5);object('original-tree',13.2,31.8);
for(const x of [35.6,40,44.4]) {object('desk-laptop',x,24.8);object('chair-front',x,26.5);}
object('divider',36.6,29);object('divider',43,29);object('bookshelf',36,32);object('cabinet',44,32);object('plant-large',40,32);
object('reception',24,27.5);object('gdg-sign',24,27.6,1);object('chair-back',24,25);
object('plant-large',18.2,29);object('plant-large',29.8,29);object('armchair',18.5,32);object('armchair',29.5,32);
zone('meeting-a','회의실 A','PRIVATE',1.5,1.5,13.5,10.5);zone('meeting-b','회의실 B','PRIVATE',33.5,1.5,13,10.5);
zone('focus','집중 업무실','SILENT',33.5,20.5,13,12);zone('lounge','카페 라운지','PUBLIC',1.5,18.5,13.5,14);
await writeFile(path.join(root,'contracts/fixtures/campus-map.json'),JSON.stringify(map,null,2)+'\n');
await writeFile(path.join(root,'../프론트/public/assets/office/default-map.json'),JSON.stringify(map,null,2)+'\n');
console.log(`Office map: ${map.width}×${map.height}, ${map.objects.length} furniture, ${map.zones.length} zones`);
