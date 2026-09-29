import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const schema = JSON.parse(await readFile(path.join(root, 'contracts/world.schema.json'), 'utf8'));
const check = process.argv.includes('--check');
function type(s, java = false) {
  if (s.$ref) return s.$ref.split('/').at(-1);
  if (java && s['x-java-type']) return s['x-java-type'];
  if (!java && s.const !== undefined) return JSON.stringify(s.const);
  if (!java && s.enum) return s.enum.map(x => JSON.stringify(x)).join(' | ');
  if (s.type === 'array') {
    if (!java) return `Array<${type(s.items)}>`;
    const itemType = type(s.items, true);
    // Java generics cannot use primitive type arguments (List<long> is invalid).
    const boxed = { long: 'Long', double: 'Double', boolean: 'Boolean' }[itemType] ?? itemType;
    return `java.util.List<${boxed}>`;
  }
  const found = (java ? { string: 'String', integer: 'long', number: 'double', boolean: 'boolean' } : { string: 'string', integer: 'number', number: 'number', boolean: 'boolean' })[s.type];
  if (!found) throw Error(`Unsupported schema type: ${s.type}`);
  return found;
}
async function emit(file, content) {
  if (check) {
    if (await readFile(file, 'utf8').catch(() => '') !== content) throw Error(`Stale generated file: ${file}`);
  } else { await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, content); }
}
let ts = '// Generated from contracts/world.schema.json. Do not edit.\n';
for (const [name, s] of Object.entries(schema.$defs)) {
  const required = new Set(s.required ?? []);
  ts += `export interface ${name} {\n${Object.entries(s.properties).map(([key, value]) => `  ${key}${required.has(key) ? '' : '?'}: ${type(value)};`).join('\n')}\n}\n`;
  const fields = Object.entries(s.properties).map(([key, value]) => `${type(value, true)} ${key}`).join(', ');
  await emit(path.join(root, `modules/protocol/src/main/java/town/hufs/protocol/${name}.java`), `// Generated from contracts/world.schema.json. Do not edit.\npackage town.hufs.protocol;\npublic record ${name}(${fields}) {}\n`);
}
ts += `export type ServerMessage =
  | Welcome
  | Snapshot
  | ErrorMessage
  | MapChanged
  | MediaState
  | MediaReply
  | ChatAck
  | ChatEvent
  | DirectMessageMutationAck
  | DirectMessageMutationEvent
  | DirectMessageReadAck
  | DirectMessageReadEvent
  | PokeAck
  | PlayerReportAck
  | PokePreferenceState
  | PokeEvent
  | BlockAck
  | BlockState
  | PresenceAck
  | JoinRequestAck
  | JoinRequestEvent
  | JoinResult
  | DirectConversationResult
  | GroupInvitationAck
  | GroupInvitationEvent
  | RoomActionAck
  | RoomKnockEvent
  | RoomKnockResult
  | RoomNoteState
  | RoomNoteAck
  | RoomRecordingAck
  | RoomRecordingState
  | EventActionAck
  | EventState
  | EventEngagementAck
  | EventEngagementState
  | SpaceParticipants
  | ProfileDetails;
export type ClientMessage =
  | Join
  | ProfileUpdate
  | ProfileRequest
  | Move
  | SnapshotAck
  | Emote
  | PresenceSet
  | MicrophoneSet
  | Poke
  | PlayerReportRequest
  | PokePreference
  | BlockAction
  | JoinRequest
  | JoinResponse
  | RoomAction
  | RoomKnockResponse
  | RoomNoteRequest
  | RoomRecordingRequest
  | MediaRequest
  | ChatSend
  | DirectMessageMutationRequest
  | DirectMessageReadRequest
  | DirectConversationRequest
  | GroupConversationRequest
  | GroupInvitationRequest
  | EventAction
  | EventEngagement;
`;
await emit(path.join(root, '../프론트/src/generated/protocol.ts'), ts);
console.log(`Contracts ${check ? 'verified' : 'generated'}: ${Object.keys(schema.$defs).length} Java records + TypeScript types`);
