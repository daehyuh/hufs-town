import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const catalog = JSON.parse(await readFile(path.join(root, 'assets/office-catalog.json'), 'utf8')).items;
const assets = new Map(catalog.map(asset => [asset.id, asset]));
const rect = (x, y, width, height) => ({ x, y, width, height });

function makeMap(id, name, spawnX, spawnY) {
  const map = { schemaVersion: 2, id, revision: `${id}-v2`, name, width: 48, height: 34, spawnX, spawnY, collisions: [], objects: [], zones: [], floors: [], walls: [], labels: [] };
  const add = (list, value, prefix) => list.push({ id: `${prefix}-${list.length}`, ...value });
  const floor = (material, x, y, width, height) => add(map.floors, { material, bounds: rect(x, y, width, height) }, 'floor');
  const wall = (x, y, width, height, material = 'SAGE') => add(map.walls, { material, bounds: rect(x, y, width, height) }, 'wall');
  const object = (asset, x, y, scale = 2) => add(map.objects, { asset, x, y, scale }, 'object');
  const zone = (id, name, kind, x, y, width, height) => map.zones.push({ id, name, kind, bounds: rect(x, y, width, height) });
  const border = () => {
    wall(1, 1, 46, 0.5, 'CREAM'); wall(1, 1, 0.5, 32, 'CREAM'); wall(46.5, 1, 0.5, 32, 'CREAM');
    wall(1, 32.5, 20, 0.5, 'CREAM'); wall(27, 32.5, 20, 0.5, 'CREAM');
  };
  map.helpers = { floor, wall, object, zone, border };
  return map;
}

const square = makeMap('campus-square', '캠퍼스 광장', 24, 30);
{
  const { floor, wall, object, zone, border } = square.helpers;
  floor('GRASS', 1.5, 1.5, 45, 31);
  floor('PAVERS', 20, 2, 8, 30);
  floor('PAVERS', 2, 27, 44, 3);
  floor('WOOD', 16, 3, 16, 6);
  floor('CARPET_SAGE', 2, 20, 12, 8);
  border();
  // A small open doorway keeps the covered conversation pavilion reachable.
  wall(31.5, 19.5, 13.5, 0.5); wall(31.5, 19.5, 0.5, 9.5); wall(45, 19.5, 0.5, 9.5);
  wall(31.5, 28.5, 4.5, 0.5); wall(40.5, 28.5, 4.5, 0.5);
  for (const [asset, x, y] of [
    ['campus-tree-large', 4.5, 5], ['campus-tree', 11, 4.5],
    ['campus-tree', 37, 4.5], ['campus-tree-large', 43.5, 5],
    ['campus-tree-small', 4, 16], ['campus-tree-small', 14, 16],
    ['campus-tree', 16, 23], ['campus-tree-small', 16, 29],
    ['campus-tree-small', 30, 16], ['campus-tree', 44, 15],
  ]) object(asset, x, y);
  object('campus-house-large', 7, 10);
  object('campus-house', 41, 10);
  for (const [asset, x, y] of [
    ['campus-bush', 3, 24], ['campus-berries', 7, 26], ['campus-bush', 11, 24],
    ['campus-bush', 4, 28], ['campus-berries', 10, 28], ['campus-bush', 14, 22],
  ]) object(asset, x, y);
  object('gdg-sign', 24, 4.4); object('screen', 24, 7.4); object('reception', 24, 9.8);
  for (const y of [13, 16.5, 19]) for (const x of [8, 14, 20, 28, 34, 40]) object('chair-front', x, y);
  object('sofa-sage', 37, 23); object('armchair', 34, 27); object('armchair', 41, 27); object('coffee-table', 37.5, 27);
  object('campus-sign', 3, 12); object('campus-sign', 45, 12);
  zone('plaza', '캠퍼스 광장', 'PUBLIC', 2, 10, 44, 9);
  zone('garden', '조용한 정원', 'SILENT', 2, 20, 12, 8);
  zone('pavilion', '대화 정자', 'PRIVATE', 32, 20, 12, 8);
}

const study = makeMap('study-space', '스터디 라운지', 24, 30);
{
  const { floor, wall, object, zone, border } = study.helpers;
  floor('OAK', 1.5, 1.5, 45, 31);
  floor('CARPET_BLUE', 2, 2, 44, 7);
  floor('TILE', 2, 9, 44, 3);
  floor('CARPET_SAGE', 2, 12, 20, 19);
  floor('WOOD', 26, 12, 20, 19);
  border();
  wall(1.5, 11.5, 9, 0.5, 'GLASS'); wall(13.5, 11.5, 8.5, 0.5, 'GLASS');
  wall(26, 11.5, 8, 0.5, 'GLASS'); wall(36, 11.5, 10, 0.5, 'GLASS');
  object('sofa-sage', 12, 7); object('armchair', 6, 8); object('armchair', 18, 8); object('coffee-table', 12, 9);
  object('bookshelf', 3.5, 16); object('bookshelf', 3.5, 23); object('bookshelf', 3.5, 30);
  for (const y of [16, 23, 29]) for (const x of [9, 16]) { object('desk-laptop', x, y); object('chair-front', x, y + 1.5); }
  object('meeting-table', 35.5, 17); object('meeting-table', 35.5, 26);
  for (const y of [14, 19.5, 23, 28.5]) for (const x of [31, 35.5, 40]) object('chair-front', x, y);
  object('plant-large', 20.5, 15); object('plant-large', 27.5, 15); object('whiteboard', 35.5, 14);
  zone('lounge', '스터디 라운지', 'PUBLIC', 2, 2, 44, 7);
  zone('focus', '집중 학습실', 'SILENT', 2, 12, 20, 19);
  zone('group-study', '그룹 스터디룸', 'PRIVATE', 26, 12, 20, 19);
}

const meetup = makeMap('meetup-hall', 'GDG 밋업 홀', 24, 30);
{
  const { floor, object, zone, border } = meetup.helpers;
  floor('OAK', 1.5, 1.5, 45, 31);
  floor('TILE', 2, 2, 44, 7);
  floor('CARPET_BLUE', 2, 10, 44, 21);
  floor('WOOD', 15, 3, 18, 6);
  border();
  object('gdg-sign', 24, 4); object('screen', 24, 7.7); object('reception', 24, 9.8);
  for (const y of [14, 18, 22, 26]) for (const x of [7, 12, 18, 30, 36, 41]) object('chair-front', x, y);
  for (const [x, y] of [[4, 5], [44, 5], [4, 29], [44, 29]]) object('plant-large', x, y);
  object('water-cooler', 5, 9); object('water-cooler', 43, 9);
  zone('hall', '밋업 홀', 'PUBLIC', 2, 2, 44, 29);
}

function finalize(map) {
  const result = { ...map };
  delete result.helpers;
  result.collisions = result.walls.map(w => ({ ...w.bounds }));
  for (const item of result.objects) {
    const asset = assets.get(item.asset);
    if (!asset?.footprint) continue;
    const scale = item.scale / 2, footprint = asset.footprint;
    result.collisions.push({ x: item.x + (footprint.x - asset.width / 32) * scale, y: item.y + footprint.y * scale, width: footprint.width * scale, height: footprint.height * scale });
  }
  return result;
}

for (const [file, map] of [['campus-square-map.json', square], ['study-space-map.json', study], ['meetup-hall-map.json', meetup]]) {
  await writeFile(path.join(root, 'contracts/fixtures', file), JSON.stringify(finalize(map), null, 2) + '\n');
}
console.log('Created campus square, study lounge, and meetup hall starter maps.');
