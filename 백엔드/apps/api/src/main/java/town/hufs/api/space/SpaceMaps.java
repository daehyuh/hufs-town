package town.hufs.api.space;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.scheduling.annotation.*;
import org.springframework.stereotype.Service;
import org.springframework.transaction.support.TransactionTemplate;
import town.hufs.auth.PublishedMaps;
import town.hufs.domain.MapRules;
import town.hufs.protocol.*;
import java.nio.charset.StandardCharsets;
import java.security.*;
import java.sql.Timestamp;
import java.time.*;
import java.util.*;

@Service
@EnableScheduling
@ConditionalOnProperty(name="town.auth.mode",havingValue="sso",matchIfMissing=true)
class SpaceMaps {
    private final Spaces spaces; private final SpaceAssets assets; private final SpaceBoardPosts boards; private final JdbcTemplate db; private final TransactionTemplate tx; private final PublishedMaps cache;
    private final ObjectMapper json=new ObjectMapper(); private final SecureRandom random=new SecureRandom();
    SpaceMaps(Spaces spaces,SpaceAssets assets,SpaceBoardPosts boards,JdbcTemplate db,TransactionTemplate tx,PublishedMaps cache){this.spaces=spaces;this.assets=assets;this.boards=boards;this.db=db;this.tx=tx;this.cache=cache;}
    record Editor(long version,MapDefinition map,String publishedRevision,List<String> issues,PublicationStatus publication) {
        Editor(long version,MapDefinition map,String publishedRevision,List<String> issues){this(version,map,publishedRevision,issues,null);}
    }
    record PublicationStatus(String revisionId,long sequence,String state,int targetNodes,int appliedNodes,int pendingNodes,int offlineNodes) {}
    record Lease(String token,long fence,String expiresAt,Editor editor) { @Override public String toString(){return "EditorLease[redacted]";} }
    record Credentials(String token,long fence,String clientId) { @Override public String toString(){return "EditorCredentials[redacted]";} }
    record Save(Credentials lease,long baseVersion,String operationId,MapDefinition map) {}
    record Publish(Credentials lease,long baseVersion) {}
    record Restore(Credentials lease,long baseVersion,String revisionId) {}
    record Revision(String id,long sequence,String createdAt,String reason,String name) {}
    record MapSummary(String mapId,String name,int sortOrder,boolean entry,long version,String publishedRevision,String updatedAt) {}
    record MapCreate(String name,String templateId) {}
    record CollaborativeSync(Editor editor,long sequence,List<OperationEvent> operations,boolean hasMore) {}
    record EditMode(String mode,long sequence,long version) {}
    record CollaborativePublish(String clientId,String operationId,long baseSequence,long baseVersion,String revisionId) {}
    record CollaborativePublication(Editor editor,long editSequence,long publishedEditSequence,boolean duplicate) {}
    record OperationEvent(String mapId,long sequence,String actorId,String actorName,String clientId,String operationId,
                          long baseSequence,Long undoOfSequence,JsonNode actions,String createdAt) {}
    record OperationResult(Editor editor,long sequence,OperationEvent operation,boolean duplicate) {}
    record CloneMap(String mapId,int sortOrder,boolean entry,MapDefinition draft,MapDefinition published) {}
    record ReservationRoom(String mapId,String mapName,String zoneId,String zoneName,Long capacity) {}
    private record Row(String mapId,String document,long version,String publishedId,long sequence,String token,String session,String client,long fence,Instant until,long editSequence,String editMode) {}
    private void owner(String space,String user){spaces.requireManager(space,user);}
    private Row lock(String space,String mapId,String user,boolean requireOwner) {
        if(requireOwner)owner(space,user);else spaces.detail(space,user);
        db.queryForList("SELECT id FROM town_space WHERE id=? FOR UPDATE",String.class,space);
        var rows=db.query("SELECT * FROM space_map WHERE space_id=? AND map_id=? FOR UPDATE",(r,n)->new Row(r.getString("map_id"),r.getString("draft_json"),r.getLong("draft_version"),r.getString("published_id"),r.getLong("published_sequence"),r.getString("lease_token"),r.getString("lease_session"),r.getString("lease_client"),r.getLong("lease_fence"),r.getTimestamp("lease_until")==null?null:r.getTimestamp("lease_until").toInstant(),r.getLong("edit_sequence"),r.getString("edit_mode")),space,mapId);
        if(!rows.isEmpty())return rows.getFirst();
        if(!space.equals(mapId))throw missingMap();
        String revision=UUID.randomUUID().toString();var map=MapRules.normalize(MapLoader.template(spaces.template(space)),mapId,revision);String document=encode(map);
        db.update("INSERT INTO space_map(space_id,map_id,sort_order,is_entry,draft_json,published_id) VALUES (?,?,0,TRUE,?,?)",space,mapId,document,revision);
        db.update("INSERT INTO map_revision(id,space_id,map_id,sequence_no,document,content_hash,actor_id,reason) VALUES (?,?,?,1,?,?,?,'INITIAL')",revision,space,mapId,document,hash(document),user);
        db.update("INSERT INTO map_outbox(space_id,map_id,revision_id,sequence_no) VALUES (?,?,?,1)",space,mapId,revision);
        return new Row(mapId,document,1,revision,1,null,null,null,0,null,0,"LEGACY");
    }
    private Editor editor(Row row) {var map=decode(row.document);return new Editor(row.version,map,row.publishedId,MapRules.issues(map));}
    Editor editor(String space,String user){return editor(space,space,user);}
    Editor editor(String space,String mapId,String user){return tx.execute(s->editor(lock(space,mapId,user,true)));}
    MapDefinition published(String space,String user){
        return published(space,space,user);
    }
    MapDefinition published(String space,String mapId,String user){
        var result=tx.execute(s->{var row=lock(space,mapId,user,false);return Map.entry(row.sequence,db.queryForObject("SELECT document FROM map_revision WHERE id=? AND space_id=? AND map_id=? FOR UPDATE",String.class,row.publishedId,space,mapId));});
        cache.publish(space,mapId,result.getKey(),result.getValue());return decode(result.getValue());
    }
    List<ReservationRoom> reservationRooms(String space,String user){
        spaces.detail(space,user);
        // Materialize the entry map for spaces that have not opened their editor yet.
        published(space,user);
        var rows=db.query("""
            SELECT current.map_id,revision.document
            FROM space_map current
            JOIN map_revision revision ON revision.id=current.published_id
                AND revision.space_id=current.space_id AND revision.map_id=current.map_id
            WHERE current.space_id=? ORDER BY current.sort_order,current.map_id
            """,(r,n)->new Object[]{r.getString("map_id"),decode(r.getString("document"))},space);
        List<ReservationRoom> rooms=new ArrayList<>();
        for(Object[] row:rows){
            String mapId=(String)row[0];MapDefinition map=(MapDefinition)row[1];
            if(map.zones()==null)continue;
            for(Zone zone:map.zones())if(zone!=null&&"PRIVATE".equals(zone.kind())&&zone.bounds()!=null){
                String zoneName=zone.name()==null||zone.name().isBlank()?"회의실":zone.name();
                rooms.add(new ReservationRoom(mapId,map.name(),zone.id(),zoneName,zone.capacity()));
            }
        }
        return List.copyOf(rooms);
    }
    List<MapSummary> catalog(String space,String user){
        owner(space,user);lock(space,space,user,true);
        return db.query("SELECT map_id,draft_json,draft_version,published_id,sort_order,is_entry,updated_at FROM space_map WHERE space_id=? ORDER BY sort_order,map_id",(r,n)->new MapSummary(r.getString("map_id"),decode(r.getString("draft_json")).name(),r.getInt("sort_order"),r.getBoolean("is_entry"),r.getLong("draft_version"),r.getString("published_id"),r.getTimestamp("updated_at").toInstant().toString()),space);
    }
    List<CloneMap> cloneSnapshot(String space,String user){
        owner(space,user);lock(space,space,user,true);
        return db.query("""
            SELECT current.map_id,current.sort_order,current.is_entry,current.draft_json,revision.document AS published_document
            FROM space_map current
            JOIN map_revision revision ON revision.id=current.published_id AND revision.space_id=current.space_id AND revision.map_id=current.map_id
            WHERE current.space_id=? ORDER BY current.sort_order,current.map_id
            """,(r,n)->new CloneMap(r.getString("map_id"),r.getInt("sort_order"),r.getBoolean("is_entry"),
                decode(r.getString("draft_json")),decode(r.getString("published_document"))),space);
    }
    MapSummary create(String space,String user,MapCreate request){
        owner(space,user);
        String name=request==null||request.name()==null?"":request.name().strip();
        String template=request==null||request.templateId()==null?spaces.template(space):request.templateId();
        if(name.isEmpty()||name.length()>60||name.codePoints().anyMatch(c->Character.isISOControl(c)||Character.getType(c)==Character.FORMAT))throw invalidMapRequest();
        MapDefinition source;try{source=MapLoader.template(template);}catch(IllegalArgumentException error){throw invalidMapRequest();}
        return tx.execute(s->{db.queryForList("SELECT id FROM town_space WHERE id=? FOR UPDATE",String.class,space);spaces.requireManager(space,user);lock(space,space,user,true);
            Integer count=db.queryForObject("SELECT COUNT(*) FROM space_map WHERE space_id=?",Integer.class,space);
            if(count!=null&&count>=50)throw new SpaceFailure(409,"MAP_LIMIT","공간에는 지도 50개까지 만들 수 있어요.");
            String mapId=UUID.randomUUID().toString(),revision=UUID.randomUUID().toString();
            var normalized=MapRules.normalize(source,mapId,revision);
            var map=new MapDefinition(normalized.schemaVersion(),normalized.id(),normalized.revision(),name,normalized.width(),normalized.height(),normalized.spawnX(),normalized.spawnY(),normalized.collisions(),normalized.objects(),normalized.zones(),normalized.floors(),normalized.walls(),normalized.labels(),normalized.portals());
            String document=encode(map);int order=count==null?0:count;
            db.update("INSERT INTO space_map(space_id,map_id,sort_order,is_entry,draft_json,published_id) VALUES (?,?,?,FALSE,?,?)",space,mapId,order,document,revision);
            db.update("INSERT INTO map_revision(id,space_id,map_id,sequence_no,document,content_hash,actor_id,reason) VALUES (?,?,?,1,?,?,?,'INITIAL')",revision,space,mapId,document,hash(document),user);
            db.update("INSERT INTO map_outbox(space_id,map_id,revision_id,sequence_no) VALUES (?,?,?,1)",space,mapId,revision);
            cache.publish(space,mapId,1,document);
            return new MapSummary(mapId,name,order,false,1,revision,Instant.now().toString());
        });
    }
    MapSummary clone(String space,String sourceMapId,String user,String requestedName){
        String name=validName(requestedName);
        MapSummary created=tx.execute(s->{
            db.queryForList("SELECT id FROM town_space WHERE id=? FOR UPDATE",String.class,space);spaces.requireManager(space,user);
            Row source=lock(space,sourceMapId,user,true);
            Integer count=db.queryForObject("SELECT COUNT(*) FROM space_map WHERE space_id=?",Integer.class,space);
            if(count!=null&&count>=50)throw new SpaceFailure(409,"MAP_LIMIT","공간에는 지도 50개까지 만들 수 있어요.");
            String mapId=UUID.randomUUID().toString(),revision=UUID.randomUUID().toString();MapDefinition original=decode(source.document);
            MapDefinition normalized=MapRules.normalize(original,mapId,revision,assets.definitions(space,original)::get);
            MapDefinition copy=new MapDefinition(normalized.schemaVersion(),mapId,revision,name,normalized.width(),normalized.height(),normalized.spawnX(),normalized.spawnY(),normalized.collisions(),normalized.objects(),normalized.zones(),normalized.floors(),normalized.walls(),normalized.labels(),normalized.portals());
            assets.assertReferences(space,copy);portalTargets(copy);
            var issues=MapRules.issues(copy);if(!issues.isEmpty())throw new SpaceFailure(409,"MAP_CLONE_INVALID","원본 지도의 오류를 먼저 수정한 뒤 복제해 주세요.");
            String document=encode(copy);int order=count==null?0:count;
            db.update("INSERT INTO space_map(space_id,map_id,sort_order,is_entry,draft_json,published_id) VALUES (?,?,?,FALSE,?,?)",space,mapId,order,document,revision);
            db.update("INSERT INTO map_revision(id,space_id,map_id,sequence_no,document,content_hash,actor_id,reason) VALUES (?,?,?,1,?,?,?,'CLONE')",revision,space,mapId,document,hash(document),user);
            db.update("INSERT INTO map_outbox(space_id,map_id,revision_id,sequence_no) VALUES (?,?,?,1)",space,mapId,revision);
            return new MapSummary(mapId,name,order,false,1,revision,Instant.now().toString());
        });
        cache.publish(space,created.mapId(),1,db.queryForObject("SELECT draft_json FROM space_map WHERE space_id=? AND map_id=?",String.class,space,created.mapId()));
        return created;
    }
    void delete(String space,String mapId,String user){
        if(space.equals(mapId))throw new SpaceFailure(409,"MAP_ENTRY_REQUIRED","공간의 기본 지도는 삭제할 수 없어요.");
        tx.executeWithoutResult(s->{
            db.queryForList("SELECT id FROM town_space WHERE id=? FOR UPDATE",String.class,space);spaces.requireManager(space,user);
            var rows=db.query("SELECT is_entry,sort_order FROM space_map WHERE space_id=? AND map_id=? FOR UPDATE",(r,n)->new int[]{r.getBoolean(1)?1:0,r.getInt(2)},space,mapId);
            if(rows.isEmpty())throw missingMap();
            if(rows.getFirst()[0]!=0)throw new SpaceFailure(409,"MAP_ENTRY_REQUIRED","먼저 다른 지도를 입장 지도로 지정해 주세요.");
            if(referencedByPortal(space,mapId))throw new SpaceFailure(409,"MAP_IN_USE","다른 지도의 포털이 이 지도를 가리키고 있어 삭제할 수 없어요.");
            int order=rows.getFirst()[1];
            db.update("DELETE FROM map_outbox WHERE space_id=? AND map_id=?",space,mapId);
            db.update("DELETE FROM map_draft_operation WHERE space_id=? AND map_id=?",space,mapId);
            db.update("DELETE FROM map_revision WHERE space_id=? AND map_id=?",space,mapId);
            db.update("DELETE FROM space_map WHERE space_id=? AND map_id=?",space,mapId);
            db.update("UPDATE space_map SET sort_order=sort_order-1 WHERE space_id=? AND sort_order>?",space,order);
            boards.removeOrphanedAfterMapDeletion(space,mapId);
            cache.remove(space,mapId);
        });
    }
    List<MapSummary> setEntry(String space,String mapId,String user){
        return tx.execute(s->{
            db.queryForList("SELECT id FROM town_space WHERE id=? FOR UPDATE",String.class,space);spaces.requireManager(space,user);
            if(db.queryForList("SELECT map_id FROM space_map WHERE space_id=? AND map_id=? FOR UPDATE",String.class,space,mapId).isEmpty())throw missingMap();
            db.update("UPDATE space_map SET is_entry=FALSE WHERE space_id=?",space);
            db.update("UPDATE space_map SET is_entry=TRUE WHERE space_id=? AND map_id=?",space,mapId);
            return catalog(space,user);
        });
    }
    String entryMapId(String space){
        var entries=db.queryForList("SELECT map_id FROM space_map WHERE space_id=? AND is_entry=TRUE ORDER BY sort_order LIMIT 1",String.class,space);
        return entries.isEmpty()?space:entries.getFirst();
    }
    List<MapSummary> reorder(String space,String user,List<String> mapIds){
        return tx.execute(s->{db.queryForList("SELECT id FROM town_space WHERE id=? FOR UPDATE",String.class,space);owner(space,user);
            var existing=db.queryForList("SELECT map_id FROM space_map WHERE space_id=? ORDER BY sort_order,map_id FOR UPDATE",String.class,space);
            if(mapIds==null||mapIds.size()!=existing.size()||new HashSet<>(mapIds).size()!=mapIds.size()||!new HashSet<>(mapIds).equals(new HashSet<>(existing)))throw invalidMapRequest();
            for(int i=0;i<mapIds.size();i++)db.update("UPDATE space_map SET sort_order=? WHERE space_id=? AND map_id=?",i,space,mapIds.get(i));
            return catalog(space,user);
        });
    }
    Lease acquire(String space,String user,String session,String client,boolean takeover){
        return acquire(space,space,user,session,client,takeover);
    }
    EditMode editMode(String space,String mapId,String user){return tx.execute(s->{var row=lock(space,mapId,user,true);return new EditMode(row.editMode,row.editSequence,row.version);});}
    Lease acquire(String space,String mapId,String user,String session,String client,boolean takeover){
        uuid(client);
        return tx.execute(s->{var row=lock(space,mapId,user,true);legacy(row);Instant now=Instant.now();String sessionHash=hash(session);
            boolean same=Objects.equals(row.session,sessionHash)&&Objects.equals(row.client,client);
            boolean active=row.until!=null&&row.until.isAfter(now);
            if(active&&!same&&!takeover)throw new SpaceFailure(409,"MAP_EDITOR_BUSY","다른 탭에서 편집 중이에요. 읽기 모드로 확인하거나 편집 권한을 가져오세요.");
            long fence=same&&active?row.fence:row.fence+1;String token=same&&active?row.token:token();Instant until=now.plusSeconds(45);
            db.update("UPDATE space_map SET lease_token=?,lease_session=?,lease_client=?,lease_fence=?,lease_until=? WHERE space_id=? AND map_id=?",token,sessionHash,client,fence,Timestamp.from(until),space,mapId);
            return new Lease(token,fence,until.toString(),editor(row));
        });
    }
    String renew(String space,String user,String session,Credentials credentials){return renew(space,space,user,session,credentials);}
    String renew(String space,String mapId,String user,String session,Credentials credentials){return tx.execute(s->{var row=lock(space,mapId,user,true);legacy(row);lease(row,session,credentials);Instant until=Instant.now().plusSeconds(45);db.update("UPDATE space_map SET lease_until=? WHERE space_id=? AND map_id=?",Timestamp.from(until),space,mapId);return until.toString();});}
    void release(String space,String user,String session,Credentials credentials){release(space,space,user,session,credentials);}
    void release(String space,String mapId,String user,String session,Credentials credentials){tx.executeWithoutResult(s->{var row=lock(space,mapId,user,true);legacy(row);lease(row,session,credentials);db.update("UPDATE space_map SET lease_until=NULL,lease_token=NULL WHERE space_id=? AND map_id=?",space,mapId);});}
    CollaborativeSync enableCollaboration(String space,String mapId,String user,long baseVersion){
        return tx.execute(s->{
            var row=lock(space,mapId,user,true);
            if("COLLABORATIVE".equals(row.editMode))return new CollaborativeSync(editor(row),row.editSequence,List.of(),false);
            version(row,baseVersion);
            if(row.until!=null&&row.until.isAfter(Instant.now()))throw new SpaceFailure(409,"MAP_EDITOR_BUSY","먼저 현재 맵 편집을 저장하고 닫아 주세요.");
            db.update("UPDATE space_map SET edit_mode='COLLABORATIVE',edit_sequence=0,lease_token=NULL,lease_session=NULL,lease_client=NULL,lease_until=NULL,lease_fence=lease_fence+1 WHERE space_id=? AND map_id=?",space,mapId);
            var enabled=new Row(row.mapId,row.document,row.version,row.publishedId,row.sequence,null,null,null,row.fence+1,null,0,"COLLABORATIVE");
            return new CollaborativeSync(editor(enabled),0,List.of(),false);
        });
    }
    CollaborativeSync collaborativeSync(String space,String mapId,String user,long afterSequence,int limit){
        if(afterSequence<0||limit<1||limit>250)throw invalidMapRequest();
        return tx.execute(s->{
            var row=lock(space,mapId,user,true);collaborative(row);
            if(afterSequence>row.editSequence)throw conflict(row,"요청한 맵 편집 위치가 현재보다 앞서 있어요.");
            var events=db.query("SELECT map_id,sequence_no,actor_id,actor_name,client_id,operation_id,base_sequence,undo_of_sequence,actions_json,created_at FROM map_edit_operation WHERE space_id=? AND map_id=? AND sequence_no>? ORDER BY sequence_no LIMIT ?",
                (r,n)->readEvent(r),space,mapId,afterSequence,limit+1);
            boolean more=events.size()>limit;
            if(more)events=events.subList(0,limit);
            return new CollaborativeSync(editor(row),row.editSequence,List.copyOf(events),more);
        });
    }
    OperationResult editCollaboratively(String space,String mapId,String user,JsonNode body){
        ParsedCommand command=parseCommand(body,mapId);
        return tx.execute(s->{var row=lock(space,mapId,user,true);collaborative(row);return appendOperation(space,mapId,user,row,command,null);});
    }
    OperationResult undoCollaborative(String space,String mapId,String user,JsonNode body){
        ParsedUndo undo=parseUndo(body,mapId);
        return tx.execute(s->{
            var row=lock(space,mapId,user,true);collaborative(row);
            var previous=findOperation(mapId,undo.operationId);
            if(previous!=null){
                if(!previous.contentHash.equals(undo.contentHash)||!user.equals(previous.event.actorId())||!undo.clientId.equals(previous.event.clientId()))throw conflict(row,"같은 작업 ID가 다른 편집 요청에 이미 사용됐어요.");
                return new OperationResult(editor(row),row.editSequence,previous.event,true);
            }
            if(undo.baseSequence!=row.editSequence)throw conflict(row,"최신 맵 상태를 받은 뒤 다시 실행 취소해 주세요.");
            var targets=db.query("SELECT actor_id,inverse_json FROM map_edit_operation WHERE space_id=? AND map_id=? AND sequence_no=?",
                (r,n)->new Object[]{r.getString("actor_id"),r.getString("inverse_json")},space,mapId,undo.undoSequence);
            if(targets.isEmpty())throw new SpaceFailure(404,"MAP_UNDO_MISSING","되돌릴 편집 기록을 찾을 수 없어요.");
            if(!user.equals(targets.getFirst()[0]))throw new SpaceFailure(403,"MAP_UNDO_FORBIDDEN","내가 수행한 편집만 되돌릴 수 있어요.");
            if(db.queryForObject("SELECT COUNT(*) FROM map_edit_operation WHERE map_id=? AND undo_of_sequence=?",Integer.class,mapId,undo.undoSequence)>0)
                throw new SpaceFailure(409,"MAP_UNDO_USED","이 편집은 이미 되돌렸어요.");
            ArrayNode inverse=readActions((String)targets.getFirst()[1]);
            ensureNoConflict(space,mapId,undo.undoSequence,inverse,row);
            var command=new ParsedCommand(undo.clientId,undo.operationId,undo.baseSequence,inverse,undo.contentHash);
            return appendOperation(space,mapId,user,row,command,undo.undoSequence);
        });
    }
    CollaborativePublication publishCollaborative(String space,String mapId,String user,CollaborativePublish request){
        if(request.baseSequence<0||request.baseVersion<1)throw invalidMapRequest();
        uuid(request.clientId);
        uuid(request.operationId);
        if(request.revisionId!=null)uuid(request.revisionId);
        String contentHash=hash(request.baseSequence+"|"+request.baseVersion+"|"+Objects.toString(request.revisionId,""));
        var result=tx.execute(s->{
            var row=lock(space,mapId,user,true);
            collaborative(row);
            var prior=db.query("SELECT actor_id,client_id,content_hash,edit_sequence,revision_id FROM map_publish_operation WHERE map_id=? AND operation_id=?",(r,n)->new Object[]{r.getString("actor_id"),r.getString("client_id"),r.getString("content_hash"),r.getLong("edit_sequence"),r.getString("revision_id")},mapId,request.operationId);
            if(!prior.isEmpty()){
                Object[] previous=prior.getFirst();
                if(!user.equals(previous[0])||!request.clientId.equals(previous[1])||!contentHash.equals(previous[2]))throw conflict(row,"같은 게시 요청 ID가 다른 변경에 이미 사용됐어요.");
                String revisionId=(String)previous[4];
                MapDefinition current=decode(row.document);
                return new CollaborativePublication(new Editor(row.version,current,revisionId,MapRules.issues(current)),row.editSequence,(long)previous[3],true);
            }
            if(row.editSequence!=request.baseSequence)throw conflict(row,"최신 공동 편집 순번을 확인한 뒤 다시 게시해 주세요.");
            version(row,request.baseVersion);
            MapDefinition input=decode(row.document);
            String reason="PUBLISH";
            if(request.revisionId!=null){
                var documents=db.queryForList("SELECT document FROM map_revision WHERE id=? AND space_id=? AND map_id=?",String.class,request.revisionId,space,mapId);
                if(documents.isEmpty())throw new SpaceFailure(404,"MAP_REVISION_MISSING","이 공간의 게시 이력이 아니에요.");
                input=decode(documents.getFirst());
                reason="ROLLBACK";
            }
            Editor editor=request.revisionId==null
                ?publishLocked(space,user,row,input,reason)
                :publishHistoricalLocked(space,user,row,input,reason);
            db.update("INSERT INTO map_publish_operation(space_id,map_id,actor_id,client_id,operation_id,content_hash,edit_sequence,revision_id) VALUES (?,?,?,?,?,?,?,?)",
                space,mapId,user,request.clientId,request.operationId,contentHash,row.editSequence,editor.publishedRevision());
            return new CollaborativePublication(editor,row.editSequence,row.editSequence,false);
        });
        dispatch();
        return new CollaborativePublication(withPublication(result.editor,space,mapId),result.editSequence,result.publishedEditSequence,result.duplicate);
    }
    private record ParsedCommand(String clientId,String operationId,long baseSequence,ArrayNode actions,String contentHash) {}
    private record ParsedUndo(String clientId,String operationId,long baseSequence,long undoSequence,String contentHash) {}
    private record StoredOperation(OperationEvent event,String contentHash) {}
    private OperationResult appendOperation(String space,String mapId,String user,Row row,ParsedCommand command,Long undoOfSequence){
        var prior=findOperation(mapId,command.operationId);
        if(prior!=null){
            if(!prior.contentHash.equals(command.contentHash)||!user.equals(prior.event.actorId())||!command.clientId.equals(prior.event.clientId()))throw conflict(row,"같은 작업 ID가 다른 편집 요청에 이미 사용됐어요.");
            return new OperationResult(editor(row),row.editSequence,prior.event,true);
        }
        if(command.baseSequence>row.editSequence)throw conflict(row,"요청한 맵 편집 위치가 현재보다 앞서 있어요.");
        validateActions(command.actions);
        ensureUniqueTouches(command.actions);
        ensureNoConflict(space,mapId,command.baseSequence,command.actions,row);
        var original=decode(row.document);
        var inverse=inverseActions(original,command.actions);
        var candidate=applyActions(original,command.actions);
        var normalized=MapRules.normalize(candidate,mapId,row.publishedId,assets.definitions(space,candidate)::get);
        assets.assertReferences(space,normalized);portalTargets(normalized);
        String document=encode(normalized),actionsDocument=write(command.actions),inverseDocument=write(inverse);
        long sequence=row.editSequence+1,version=row.version+1;
        String actorName=db.queryForObject("SELECT display_name FROM app_user WHERE id=? AND status='ACTIVE' AND deleted_at IS NULL",String.class,user);
        db.update("UPDATE space_map SET draft_json=?,draft_version=?,edit_sequence=?,updated_at=CURRENT_TIMESTAMP(6) WHERE space_id=? AND map_id=?",document,version,sequence,space,mapId);
        db.update("INSERT INTO map_edit_operation(space_id,map_id,sequence_no,actor_id,actor_name,client_id,operation_id,base_sequence,undo_of_sequence,content_hash,actions_json,inverse_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
            space,mapId,sequence,user,actorName,command.clientId,command.operationId,command.baseSequence,undoOfSequence,command.contentHash,actionsDocument,inverseDocument);
        var event=new OperationEvent(mapId,sequence,user,actorName,command.clientId,command.operationId,command.baseSequence,undoOfSequence,command.actions.deepCopy(),Instant.now().toString());
        var updated=new Row(row.mapId,document,version,row.publishedId,row.sequence,row.token,row.session,row.client,row.fence,row.until,sequence,row.editMode);
        return new OperationResult(new Editor(version,normalized,row.publishedId,MapRules.issues(normalized)),sequence,event,false);
    }
    private StoredOperation findOperation(String mapId,String operationId){
        var rows=db.query("SELECT map_id,sequence_no,actor_id,actor_name,client_id,operation_id,base_sequence,undo_of_sequence,actions_json,created_at,content_hash FROM map_edit_operation WHERE map_id=? AND operation_id=?",
            (r,n)->new Object[]{readEvent(r),r.getString("content_hash")},mapId,operationId);
        return rows.isEmpty()?null:new StoredOperation((OperationEvent)rows.getFirst()[0],(String)rows.getFirst()[1]);
    }
    private OperationEvent readEvent(java.sql.ResultSet row)throws java.sql.SQLException{
        return new OperationEvent(row.getString("map_id"),row.getLong("sequence_no"),row.getString("actor_id"),row.getString("actor_name"),row.getString("client_id"),row.getString("operation_id"),row.getLong("base_sequence"),row.getObject("undo_of_sequence",Long.class),readActions(row.getString("actions_json")),row.getTimestamp("created_at").toInstant().toString());
    }
    private void ensureNoConflict(String space,String mapId,long baseSequence,ArrayNode actions,Row row){
        if(baseSequence>row.editSequence)throw conflict(row,"요청한 맵 편집 위치가 현재보다 앞서 있어요.");
        Set<String> requested=touches(actions);
        if(baseSequence==row.editSequence)return;
        var changes=db.queryForList("SELECT actions_json FROM map_edit_operation WHERE space_id=? AND map_id=? AND sequence_no>? ORDER BY sequence_no",String.class,space,mapId,baseSequence);
        for(String document:changes){
            Set<String> changed=touches(readActions(document));
            if(!Collections.disjoint(requested,changed))throw conflict(row,"같은 맵 요소가 다른 관리자에 의해 먼저 수정됐어요. 최신 상태를 확인해 주세요.");
        }
    }
    private CollaborativeEditConflict conflict(Row row,String message){return new CollaborativeEditConflict(row.editSequence,editor(row),message);}
    private void collaborative(Row row){if(!"COLLABORATIVE".equals(row.editMode))throw new SpaceFailure(409,"MAP_EDIT_MODE_LEGACY","이 지도는 아직 단일 작성자 편집 모드예요.");}
    private void legacy(Row row){if(!"LEGACY".equals(row.editMode))throw new SpaceFailure(409,"MAP_EDIT_MODE_COLLABORATIVE","이 지도는 공동 편집 중이에요. 공동 편집 동기화를 사용해 주세요.");}
    private ParsedCommand parseCommand(JsonNode body,String expectedMapId){
        fields(body,Set.of("protocolVersion","mapId","clientId","operationId","baseSequence","actions"));
        if(body.path("protocolVersion").asInt(-1)!=1||!expectedMapId.equals(body.path("mapId").asText()))throw invalidEdit();
        String clientId=body.path("clientId").asText(null),operationId=body.path("operationId").asText(null);
        uuid(clientId);uuid(operationId);
        JsonNode base=body.get("baseSequence"),actions=body.get("actions");
        if(base==null||!base.isIntegralNumber()||base.longValue()<0||!(actions instanceof ArrayNode array)||array.isEmpty()||array.size()>128)throw invalidEdit();
        return new ParsedCommand(clientId,operationId,base.longValue(),array,hash(write(canonical(body))));
    }
    private ParsedUndo parseUndo(JsonNode body,String expectedMapId){
        fields(body,Set.of("protocolVersion","mapId","clientId","operationId","baseSequence","undoSequence"));
        if(body.path("protocolVersion").asInt(-1)!=1||!expectedMapId.equals(body.path("mapId").asText()))throw invalidEdit();
        String clientId=body.path("clientId").asText(null),operationId=body.path("operationId").asText(null);
        uuid(clientId);uuid(operationId);
        JsonNode base=body.get("baseSequence"),undo=body.get("undoSequence");
        if(base==null||!base.isIntegralNumber()||base.longValue()<0||undo==null||!undo.isIntegralNumber()||undo.longValue()<1)throw invalidEdit();
        return new ParsedUndo(clientId,operationId,base.longValue(),undo.longValue(),hash(write(canonical(body))));
    }
    private void validateActions(ArrayNode actions){
        for(JsonNode action:actions){
            String kind=action.path("kind").asText(""),collection=action.path("collection").asText("");
            if(kind.equals("ENTITY_ADD")||kind.equals("ENTITY_REPLACE")){
                Set<String> allowed=new HashSet<>(Set.of("kind","collection","entity"));
                if(kind.equals("ENTITY_ADD"))allowed.add("afterId");
                fields(action,allowed);
                if(!collections().contains(collection)||!action.path("entity").isObject())throw invalidEdit();
                Set<String> entityFields=switch(collection){
                    case "objects"->Set.of("id","asset","x","y","scale","direction","interaction");
                    case "floors","walls"->Set.of("id","material","bounds");
                    case "zones"->Set.of("id","name","kind","bounds","capacity");
                    case "labels"->Set.of("id","text","x","y","link");
                    case "portals"->Set.of("id","name","bounds","targetSpaceId","targetMapId","targetSpawnX","targetSpawnY");
                    default->Set.of();
                };
                JsonNode entity=action.get("entity");fields(entity,entityFields);
                if(!entity.path("id").isTextual()||entity.path("id").asText().isBlank())throw invalidEdit();
                if(entity.has("bounds"))fields(entity.get("bounds"),Set.of("x","y","width","height"));
                if(entity.has("interaction")&&!entity.get("interaction").isNull()){fields(entity.get("interaction"),Set.of("kind","title","body","url","assetId","radius","volume"));}
                if(action.has("afterId")&&!action.get("afterId").isNull()&&!action.get("afterId").isTextual())throw invalidEdit();
            }else if(kind.equals("ENTITY_DELETE")){
                fields(action,Set.of("kind","collection","entityId"));
                if(!collections().contains(collection)||!action.path("entityId").isTextual())throw invalidEdit();
            }else if(kind.equals("ENTITY_REORDER")){
                fields(action,Set.of("kind","collection","entityId","afterId"));
                if(!collections().contains(collection)||!action.path("entityId").isTextual()||!action.has("afterId")||(!action.get("afterId").isNull()&&!action.get("afterId").isTextual()))throw invalidEdit();
            }else if(kind.equals("MAP_FIELD_SET")){
                fields(action,Set.of("kind","field","value"));
                String field=action.path("field").asText("");JsonNode value=action.get("value");
                if(value==null)throw invalidEdit();
                if(field.equals("name")){if(!value.isTextual()||value.asText().isBlank()||value.asText().length()>60)throw invalidEdit();}
                else if(field.equals("spawnX")||field.equals("spawnY")){if(!value.isNumber()||!Double.isFinite(value.doubleValue()))throw invalidEdit();}
                else throw invalidEdit();
            }else throw invalidEdit();
        }
    }
    private static Set<String> collections(){return Set.of("objects","floors","walls","zones","labels","portals");}
    private static void fields(JsonNode node,Set<String> allowed){
        if(node==null||!node.isObject())throw invalidEdit();
        var names=node.fieldNames();while(names.hasNext())if(!allowed.contains(names.next()))throw invalidEdit();
    }
    private static SpaceFailure invalidEdit(){return new SpaceFailure(400,"MAP_EDIT_INVALID","공동 편집 명령의 형식이나 내용이 올바르지 않아요.");}
    private void ensureUniqueTouches(ArrayNode actions){
        var entityKinds=new HashMap<String,Set<String>>();var fields=new HashSet<String>();
        for(JsonNode action:actions){
            String kind=action.path("kind").asText();
            if(kind.equals("MAP_FIELD_SET")){if(!fields.add(action.path("field").asText()))throw invalidEdit();continue;}
            String collection=action.path("collection").asText();
            String id=(kind.equals("ENTITY_ADD")||kind.equals("ENTITY_REPLACE"))?action.path("entity").path("id").asText(""):action.path("entityId").asText("");
            String key=collection+":"+id;var kinds=entityKinds.computeIfAbsent(key,ignored->new HashSet<>());
            if(kinds.isEmpty()){kinds.add(kind);continue;}
            boolean replaceAndReorder=kinds.size()==1&&((kinds.contains("ENTITY_REPLACE")&&kind.equals("ENTITY_REORDER"))||(kinds.contains("ENTITY_REORDER")&&kind.equals("ENTITY_REPLACE")));
            if(!replaceAndReorder)throw invalidEdit();kinds.add(kind);
        }
    }
    private Set<String> touches(ArrayNode actions){
        var result=new HashSet<String>();
        for(JsonNode action:actions){
            String kind=action.path("kind").asText(),collection=action.path("collection").asText();
            if(kind.startsWith("ENTITY_")){
                String entityId=kind.equals("ENTITY_ADD")||kind.equals("ENTITY_REPLACE")?action.path("entity").path("id").asText(""):action.path("entityId").asText("");
                result.add("entity:"+entityId);
                if(kind.equals("ENTITY_REORDER")||(kind.equals("ENTITY_ADD")&&action.has("afterId"))){
                    result.add("order:"+collection);
                    if(action.has("afterId")&&!action.get("afterId").isNull())result.add("entity:"+action.path("afterId").asText());
                }
            }else result.add("map:"+action.path("field").asText());
        }
        return result;
    }
    private JsonNode canonical(JsonNode node){
        if(node.isObject()){
            ObjectNode sorted=json.createObjectNode();var names=new TreeSet<String>();node.fieldNames().forEachRemaining(names::add);
            for(String name:names)sorted.set(name,canonical(node.get(name)));
            return sorted;
        }
        if(node.isArray()){ArrayNode result=json.createArrayNode();node.forEach(value->result.add(canonical(value)));return result;}
        return node.deepCopy();
    }
    private String write(JsonNode node){try{return json.writeValueAsString(node);}catch(Exception e){throw new IllegalStateException(e);}}
    private ArrayNode readActions(String document){try{JsonNode value=json.readTree(document);if(!(value instanceof ArrayNode array))throw new IllegalStateException("Stored map operation is not an array");return array;}catch(Exception e){throw new IllegalStateException("Stored map operation is invalid",e);}}
    private MapDefinition applyActions(MapDefinition source,ArrayNode actions){
        var objects=new ArrayList<>(source.objects());var floors=new ArrayList<>(source.floors());var walls=new ArrayList<>(source.walls());
        var zones=new ArrayList<>(source.zones());var labels=new ArrayList<>(source.labels());var portals=new ArrayList<>(source.portals()==null?List.<Portal>of():source.portals());
        String name=source.name();double spawnX=source.spawnX(),spawnY=source.spawnY();
        for(JsonNode action:actions){
            String kind=action.path("kind").asText(),collection=action.path("collection").asText();
            if(kind.equals("MAP_FIELD_SET")){
                switch(action.path("field").asText()){
                    case "name"->name=action.path("value").asText();
                    case "spawnX"->spawnX=action.path("value").doubleValue();
                    case "spawnY"->spawnY=action.path("value").doubleValue();
                    default->throw invalidEdit();
                }
                continue;
            }
            String entityId=kind.equals("ENTITY_ADD")||kind.equals("ENTITY_REPLACE")?action.path("entity").path("id").asText():action.path("entityId").asText();
            String afterId=action.has("afterId")&&!action.get("afterId").isNull()?action.path("afterId").asText():null;
            boolean hasAnchor=action.has("afterId");
            switch(collection){
                case "objects"->{
                    if(kind.equals("ENTITY_ADD"))insert(objects,convert(action.get("entity"),MapObject.class),afterId,hasAnchor,MapObject::id);
                    else if(kind.equals("ENTITY_REPLACE"))replace(objects,convert(action.get("entity"),MapObject.class),MapObject::id);
                    else if(kind.equals("ENTITY_DELETE"))remove(objects,entityId,MapObject::id);
                    else reorder(objects,entityId,afterId,MapObject::id);
                }
                case "floors"->{
                    if(kind.equals("ENTITY_ADD"))insert(floors,convert(action.get("entity"),FloorPatch.class),afterId,hasAnchor,FloorPatch::id);
                    else if(kind.equals("ENTITY_REPLACE"))replace(floors,convert(action.get("entity"),FloorPatch.class),FloorPatch::id);
                    else if(kind.equals("ENTITY_DELETE"))remove(floors,entityId,FloorPatch::id);
                    else reorder(floors,entityId,afterId,FloorPatch::id);
                }
                case "walls"->{
                    if(kind.equals("ENTITY_ADD"))insert(walls,convert(action.get("entity"),Wall.class),afterId,hasAnchor,Wall::id);
                    else if(kind.equals("ENTITY_REPLACE"))replace(walls,convert(action.get("entity"),Wall.class),Wall::id);
                    else if(kind.equals("ENTITY_DELETE"))remove(walls,entityId,Wall::id);
                    else reorder(walls,entityId,afterId,Wall::id);
                }
                case "zones"->{
                    if(kind.equals("ENTITY_ADD"))insert(zones,convert(action.get("entity"),Zone.class),afterId,hasAnchor,Zone::id);
                    else if(kind.equals("ENTITY_REPLACE"))replace(zones,convert(action.get("entity"),Zone.class),Zone::id);
                    else if(kind.equals("ENTITY_DELETE"))remove(zones,entityId,Zone::id);
                    else reorder(zones,entityId,afterId,Zone::id);
                }
                case "labels"->{
                    if(kind.equals("ENTITY_ADD"))insert(labels,convert(action.get("entity"),MapLabel.class),afterId,hasAnchor,MapLabel::id);
                    else if(kind.equals("ENTITY_REPLACE"))replace(labels,convert(action.get("entity"),MapLabel.class),MapLabel::id);
                    else if(kind.equals("ENTITY_DELETE"))remove(labels,entityId,MapLabel::id);
                    else reorder(labels,entityId,afterId,MapLabel::id);
                }
                case "portals"->{
                    if(kind.equals("ENTITY_ADD"))insert(portals,convert(action.get("entity"),Portal.class),afterId,hasAnchor,Portal::id);
                    else if(kind.equals("ENTITY_REPLACE"))replace(portals,convert(action.get("entity"),Portal.class),Portal::id);
                    else if(kind.equals("ENTITY_DELETE"))remove(portals,entityId,Portal::id);
                    else reorder(portals,entityId,afterId,Portal::id);
                }
                default->throw invalidEdit();
            }
        }
        return new MapDefinition(source.schemaVersion(),source.id(),source.revision(),name,source.width(),source.height(),spawnX,spawnY,source.collisions(),objects,zones,floors,walls,labels,portals);
    }
    private <T> T convert(JsonNode value,Class<T> type){try{return json.treeToValue(value,type);}catch(Exception e){throw invalidEdit();}}
    private static <T> int index(List<T> values,String id,java.util.function.Function<T,String> idOf){for(int i=0;i<values.size();i++)if(Objects.equals(idOf.apply(values.get(i)),id))return i;return -1;}
    private static <T> void insert(ArrayList<T> values,T entity,String afterId,boolean hasAnchor,java.util.function.Function<T,String> idOf){
        int index=values.size();if(hasAnchor){if(afterId==null)index=0;else{int anchor=index(values,afterId,idOf);if(anchor<0||Objects.equals(idOf.apply(entity),afterId))throw invalidEdit();index=anchor+1;}}
        values.add(index,entity);
    }
    private static <T> void replace(ArrayList<T> values,T entity,java.util.function.Function<T,String> idOf){
        int index=index(values,idOf.apply(entity),idOf);if(index<0)throw invalidEdit();values.set(index,entity);
    }
    private static <T> void remove(ArrayList<T> values,String id,java.util.function.Function<T,String> idOf){int index=index(values,id,idOf);if(index<0)throw invalidEdit();values.remove(index);}
    private static <T> void reorder(ArrayList<T> values,String id,String afterId,java.util.function.Function<T,String> idOf){
        if(Objects.equals(id,afterId))throw invalidEdit();int old=index(values,id,idOf);if(old<0)throw invalidEdit();T value=values.remove(old);int target=afterId==null?-1:index(values,afterId,idOf);if(afterId!=null&&target<0)throw invalidEdit();values.add(target+1,value);
    }
    private ArrayNode inverseActions(MapDefinition source,ArrayNode actions){
        var deleted=new HashSet<String>();for(JsonNode action:actions)if("ENTITY_DELETE".equals(action.path("kind").asText()))deleted.add(action.path("entityId").asText());
        var inverses=new ArrayList<ObjectNode>();
        for(JsonNode action:actions){
            String kind=action.path("kind").asText(),collection=action.path("collection").asText();ObjectNode inverse=json.createObjectNode();
            if(kind.equals("ENTITY_ADD")){
                inverse.put("kind","ENTITY_DELETE");inverse.put("collection",collection);inverse.put("entityId",action.path("entity").path("id").asText());
            }else if(kind.equals("ENTITY_REPLACE")){
                String id=action.path("entity").path("id").asText();Object prior=findEntity(source,collection,id);if(prior==null)throw invalidEdit();
                inverse.put("kind","ENTITY_REPLACE");inverse.put("collection",collection);inverse.set("entity",withoutNulls(json.valueToTree(prior)));
            }else if(kind.equals("ENTITY_DELETE")){
                String id=action.path("entityId").asText();Object prior=findEntity(source,collection,id);if(prior==null)throw invalidEdit();
                inverse.put("kind","ENTITY_ADD");inverse.put("collection",collection);inverse.set("entity",withoutNulls(json.valueToTree(prior)));
                String after=previousId(source,collection,id,deleted);if(after==null)inverse.putNull("afterId");else inverse.put("afterId",after);
            }else if(kind.equals("ENTITY_REORDER")){
                String id=action.path("entityId").asText();if(findEntity(source,collection,id)==null)throw invalidEdit();
                inverse.put("kind","ENTITY_REORDER");inverse.put("collection",collection);inverse.put("entityId",id);
                String after=previousId(source,collection,id,Set.of());if(after==null)inverse.putNull("afterId");else inverse.put("afterId",after);
            }else{
                String field=action.path("field").asText();inverse.put("kind","MAP_FIELD_SET");inverse.put("field",field);
                inverse.set("value",switch(field){case "name"->json.valueToTree(source.name());case "spawnX"->json.valueToTree(source.spawnX());case "spawnY"->json.valueToTree(source.spawnY());default->throw invalidEdit();});
            }
            inverses.add(inverse);
        }
        Collections.reverse(inverses);ArrayNode result=json.createArrayNode();inverses.forEach(result::add);validateActions(result);ensureUniqueTouches(result);return result;
    }
    private Object findEntity(MapDefinition map,String collection,String id){
        return switch(collection){case "objects"->map.objects().stream().filter(x->x.id().equals(id)).findFirst().orElse(null);case "floors"->map.floors().stream().filter(x->x.id().equals(id)).findFirst().orElse(null);case "walls"->map.walls().stream().filter(x->x.id().equals(id)).findFirst().orElse(null);case "zones"->map.zones().stream().filter(x->x.id().equals(id)).findFirst().orElse(null);case "labels"->map.labels().stream().filter(x->x.id().equals(id)).findFirst().orElse(null);case "portals"->map.portals()==null?null:map.portals().stream().filter(x->x.id().equals(id)).findFirst().orElse(null);default->null;};
    }
    private String previousId(MapDefinition map,String collection,String id,Set<String> excluded){
        List<String> ids=switch(collection){case "objects"->map.objects().stream().map(MapObject::id).toList();case "floors"->map.floors().stream().map(FloorPatch::id).toList();case "walls"->map.walls().stream().map(Wall::id).toList();case "zones"->map.zones().stream().map(Zone::id).toList();case "labels"->map.labels().stream().map(MapLabel::id).toList();case "portals"->map.portals()==null?List.of():map.portals().stream().map(Portal::id).toList();default->List.of();};
        int index=ids.indexOf(id);for(int i=index-1;i>=0;i--)if(!excluded.contains(ids.get(i)))return ids.get(i);return null;
    }
    private JsonNode withoutNulls(JsonNode source){
        if(source.isObject()){ObjectNode result=json.createObjectNode();source.fields().forEachRemaining(entry->{if(!entry.getValue().isNull())result.set(entry.getKey(),withoutNulls(entry.getValue()));});return result;}
        if(source.isArray()){ArrayNode result=json.createArrayNode();source.forEach(value->result.add(withoutNulls(value)));return result;}
        return source.deepCopy();
    }
    Editor save(String space,String user,String session,Save request){
        return save(space,space,user,session,request);
    }
    Editor save(String space,String mapId,String user,String session,Save request){
        uuid(request.operationId);
        return tx.execute(s->{var row=lock(space,mapId,user,true);legacy(row);lease(row,session,request.lease);
            var map=MapRules.normalize(request.map,mapId,row.publishedId,assets.definitions(space,request.map)::get);assets.assertReferences(space,map);portalTargets(map);String document=encode(map),hash=hash(document);
            var old=db.queryForList("SELECT content_hash FROM map_draft_operation WHERE map_id=? AND operation_id=? FOR UPDATE",String.class,mapId,request.operationId);
            if(!old.isEmpty()){if(!old.getFirst().equals(hash))throw new SpaceFailure(409,"MAP_OPERATION_CONFLICT","같은 저장 요청의 내용이 달라요. 최신 초안을 확인해 주세요.");return editor(row);}
            version(row,request.baseVersion);long next=row.version+1;
            db.update("UPDATE space_map SET draft_json=?,draft_version=?,updated_at=CURRENT_TIMESTAMP(6) WHERE space_id=? AND map_id=?",document,next,space,mapId);
            db.update("INSERT INTO map_draft_operation(map_id,space_id,operation_id,content_hash,saved_version) VALUES (?,?,?,?,?)",mapId,space,request.operationId,hash,next);
            return new Editor(next,map,row.publishedId,MapRules.issues(map));
        });
    }
    Editor publish(String space,String user,String session,Publish request){
        return publish(space,space,user,session,request);
    }
    Editor publish(String space,String mapId,String user,String session,Publish request){
        Editor result=tx.execute(s->{var row=lock(space,mapId,user,true);legacy(row);lease(row,session,request.lease);version(row,request.baseVersion);return publishLocked(space,user,row,decode(row.document),"PUBLISH");});
        dispatch();return withPublication(result,space,mapId);
    }
    Editor restore(String space,String user,String session,Restore request){
        return restore(space,space,user,session,request);
    }
    Editor restore(String space,String mapId,String user,String session,Restore request){
        uuid(request.revisionId);
        Editor result=tx.execute(s->{var row=lock(space,mapId,user,true);legacy(row);lease(row,session,request.lease);version(row,request.baseVersion);
            var docs=db.queryForList("SELECT document FROM map_revision WHERE id=? AND space_id=? AND map_id=?",String.class,request.revisionId,space,mapId);
            if(docs.isEmpty())throw new SpaceFailure(404,"MAP_REVISION_MISSING","이 공간의 게시 이력이 아니에요.");
            return publishLocked(space,user,row,decode(docs.getFirst()),"ROLLBACK");
        });dispatch();return withPublication(result,space,mapId);
    }
    private Editor publishLocked(String space,String user,Row row,MapDefinition input,String reason){
        String id=UUID.randomUUID().toString();var map=MapRules.normalize(input,row.mapId,id,assets.definitions(space,input)::get);assets.assertReferences(space,map);portalTargets(map);var issues=MapRules.issues(map);
        if(!issues.isEmpty())throw new SpaceFailure(400,"MAP_INVALID",String.join(" ",issues));
        boards.removeOrphaned(space,row.mapId,map);
        String document=encode(map);long sequence=row.sequence+1,version=row.version+1;
        db.update("INSERT INTO map_revision(id,space_id,map_id,sequence_no,document,content_hash,actor_id,reason) VALUES (?,?,?,?,?,?,?,?)",id,space,row.mapId,sequence,document,hash(document),user,reason);
        db.update("UPDATE space_map SET draft_json=?,draft_version=?,published_id=?,published_sequence=?,updated_at=CURRENT_TIMESTAMP(6) WHERE space_id=? AND map_id=?",document,version,id,sequence,space,row.mapId);
        db.update("INSERT INTO map_outbox(space_id,map_id,revision_id,sequence_no) VALUES (?,?,?,?)",space,row.mapId,id,sequence);
        return new Editor(version,map,id,List.of());
    }
    private Editor publishHistoricalLocked(String space,String user,Row row,MapDefinition input,String reason){
        String id=UUID.randomUUID().toString();
        var map=MapRules.normalize(input,row.mapId,id,assets.definitions(space,input)::get);
        assets.assertReferences(space,map);portalTargets(map);
        var issues=MapRules.issues(map);
        if(!issues.isEmpty())throw new SpaceFailure(400,"MAP_INVALID",String.join(" ",issues));
        boards.removeOrphaned(space,row.mapId,map);
        String document=encode(map);long sequence=row.sequence+1,version=row.version+1;
        db.update("INSERT INTO map_revision(id,space_id,map_id,sequence_no,document,content_hash,actor_id,reason) VALUES (?,?,?,?,?,?,?,?)",id,space,row.mapId,sequence,document,hash(document),user,reason);
        db.update("UPDATE space_map SET draft_version=?,published_id=?,published_sequence=?,updated_at=CURRENT_TIMESTAMP(6) WHERE space_id=? AND map_id=?",version,id,sequence,space,row.mapId);
        db.update("INSERT INTO map_outbox(space_id,map_id,revision_id,sequence_no) VALUES (?,?,?,?)",space,row.mapId,id,sequence);
        var draft=decode(row.document);
        return new Editor(version,draft,id,MapRules.issues(draft));
    }
    private Editor withPublication(Editor editor,String space,String mapId){
        return new Editor(editor.version(),editor.map(),editor.publishedRevision(),editor.issues(),publicationStatus(space,mapId,editor.publishedRevision()));
    }
    PublicationStatus publicationStatus(String space,String mapId,String revisionId,String user){
        owner(space,user);
        return publicationStatus(space,mapId,revisionId);
    }
    private PublicationStatus publicationStatus(String space,String mapId,String revisionId){
        return tx.execute(status->{
            db.update("""
                UPDATE world_map_node_map
                SET active=FALSE
                WHERE space_id=? AND map_id=? AND active=TRUE
                  AND last_seen_at < DATE_SUB(CURRENT_TIMESTAMP(6),INTERVAL 10 SECOND)
                """,space,mapId);
            var events=db.query("SELECT id,sequence_no,delivered FROM map_outbox WHERE space_id=? AND map_id=? AND revision_id=? ORDER BY id DESC LIMIT 1",
                (r,n)->new Object[]{r.getLong("id"),r.getLong("sequence_no"),r.getBoolean("delivered")},space,mapId,revisionId);
            if(events.isEmpty())throw new SpaceFailure(404,"MAP_REVISION_MISSING","이 공간의 게시 이력이 아니에요.");
            Object[] event=events.getFirst();long outboxId=(long)event[0],sequence=(long)event[1];boolean delivered=(boolean)event[2];
            db.update("""
                UPDATE map_outbox_node_target target
                JOIN map_outbox event ON event.id=target.outbox_id
                LEFT JOIN world_map_node_map node ON node.node_id=target.node_id AND node.space_id=event.space_id AND node.map_id=event.map_id
                SET target.expired_at=CURRENT_TIMESTAMP(6)
                WHERE target.outbox_id=? AND target.acknowledged_at IS NULL AND target.expired_at IS NULL
                  AND (node.node_id IS NULL OR node.active=FALSE OR node.last_seen_at < DATE_SUB(CURRENT_TIMESTAMP(6),INTERVAL 10 SECOND))
                """,outboxId);
            int[] counts=db.queryForObject("""
                SELECT COUNT(*) AS targets,
                       COALESCE(SUM(acknowledged_at IS NOT NULL),0) AS applied,
                       COALESCE(SUM(acknowledged_at IS NULL AND expired_at IS NULL),0) AS pending,
                       COALESCE(SUM(acknowledged_at IS NULL AND expired_at IS NOT NULL),0) AS offline
                FROM map_outbox_node_target WHERE outbox_id=?
                """,(r,n)->new int[]{r.getInt("targets"),r.getInt("applied"),r.getInt("pending"),r.getInt("offline")},outboxId);
            String state=!delivered?"PUBLISHING":counts[2]>0?"APPLYING":counts[3]>0?"DEGRADED":"APPLIED";
            return new PublicationStatus(revisionId,sequence,state,counts[0],counts[1],counts[2],counts[3]);
        });
    }
    List<Revision> history(String space,String user){return history(space,space,user);}
    List<Revision> history(String space,String mapId,String user){owner(space,user);lock(space,mapId,user,true);return db.query("SELECT id,sequence_no,created_at,reason,document FROM map_revision WHERE space_id=? AND map_id=? ORDER BY sequence_no DESC LIMIT 20",(r,n)->new Revision(r.getString("id"),r.getLong("sequence_no"),r.getTimestamp("created_at").toInstant().toString(),r.getString("reason"),decode(r.getString("document")).name()),space,mapId);}
    private void lease(Row row,String session,Credentials credentials){
        if(credentials==null||credentials.token==null||row.token==null||!MessageDigest.isEqual(row.token.getBytes(StandardCharsets.UTF_8),credentials.token.getBytes(StandardCharsets.UTF_8))||row.fence!=credentials.fence||!Objects.equals(row.client,credentials.clientId)||!Objects.equals(row.session,hash(session))||row.until==null||!row.until.isAfter(Instant.now()))throw new SpaceFailure(409,"MAP_LEASE_LOST","편집 권한이 만료되었거나 다른 탭으로 넘어갔어요. 복구 파일을 저장한 뒤 다시 편집해 주세요.");
    }
    private void version(Row row,long version){if(row.version!=version)throw new SpaceFailure(409,"MAP_VERSION_CONFLICT","다른 변경이 먼저 저장됐어요. 최신 초안을 불러와 주세요.");}
    @Scheduled(fixedDelay=1000,initialDelay=3000) void dispatch(){
        // Retried from durable SQL outbox. Sequence comparison prevents delayed events from restoring an old map.
        try {var pending=db.queryForList("SELECT o.id,o.space_id,o.map_id,o.sequence_no,r.document FROM map_outbox o JOIN map_revision r ON r.id=o.revision_id WHERE o.delivered=FALSE ORDER BY o.id LIMIT 50");
            for(var event:pending){
                long outboxId=((Number)event.get("id")).longValue();long sequence=((Number)event.get("sequence_no")).longValue();
                String space=(String)event.get("space_id"),mapId=(String)event.get("map_id");
                cache.publish(space,mapId,sequence,(String)event.get("document"));
                tx.executeWithoutResult(status->{
                    db.update("""
                        INSERT INTO map_outbox_node_target(outbox_id,node_id,acknowledged_at)
                        SELECT ?,node.node_id,CASE WHEN node.applied_sequence>=? THEN CURRENT_TIMESTAMP(6) ELSE NULL END
                        FROM world_map_node_map node
                        WHERE node.space_id=? AND node.map_id=? AND node.active=TRUE
                          AND node.last_seen_at >= DATE_SUB(CURRENT_TIMESTAMP(6),INTERVAL 10 SECOND)
                        ON DUPLICATE KEY UPDATE
                          acknowledged_at=COALESCE(map_outbox_node_target.acknowledged_at,VALUES(acknowledged_at)),
                          expired_at=NULL
                        """,outboxId,sequence,space,mapId);
                    db.update("UPDATE map_outbox SET delivered=TRUE WHERE id=?",outboxId);
                });
            }
        }catch(RuntimeException unavailable){ /* Keep pending rows for the next attempt; never acknowledge a failed cache or target write. */ }
    }
    private MapDefinition decode(String doc){try{return json.readValue(doc,MapDefinition.class);}catch(Exception e){throw new IllegalStateException("Stored map invalid",e);}}
    private void portalTargets(MapDefinition map){
        for(var portal: map.portals()==null?List.<Portal>of():map.portals()){
            String targetSpace=portal.targetSpaceId();
            if(db.queryForList("SELECT id FROM town_space WHERE id=? FOR UPDATE",String.class,targetSpace).isEmpty())throw new SpaceFailure(400,"MAP_PORTAL_TARGET_MISSING","포털 대상 공간을 찾을 수 없어요: "+targetSpace);
            String targetMap=portal.targetMapId()==null||portal.targetMapId().isBlank()?entryMapId(targetSpace):portal.targetMapId();
            if(!targetMap.equals(targetSpace)&&db.queryForList("SELECT map_id FROM space_map WHERE space_id=? AND map_id=? FOR UPDATE",String.class,targetSpace,targetMap).isEmpty())
                throw new SpaceFailure(400,"MAP_PORTAL_TARGET_MISSING","포털 대상 지도를 찾을 수 없어요: "+targetMap);
        }
    }
    private boolean referencedByPortal(String space,String mapId){
        var documents=new ArrayList<String>();documents.addAll(db.queryForList("SELECT draft_json FROM space_map",String.class));
        documents.addAll(db.queryForList("SELECT revision.document FROM space_map current_map JOIN map_revision revision ON revision.id=current_map.published_id AND revision.space_id=current_map.space_id AND revision.map_id=current_map.map_id",String.class));
        for(String document:documents){MapDefinition candidate=decode(document);if(candidate.portals()!=null&&candidate.portals().stream().filter(Objects::nonNull).anyMatch(portal->space.equals(portal.targetSpaceId())&&mapId.equals(portal.targetMapId())))return true;}
        return false;
    }
    private static String validName(String value){
        String name=value==null?"":value.strip();
        if(name.isEmpty()||name.length()>60||name.codePoints().anyMatch(c->Character.isISOControl(c)||Character.getType(c)==Character.FORMAT))throw invalidMapRequest();
        return name;
    }
    private String encode(MapDefinition map){try{String value=json.writeValueAsString(map);if(value.length()>512_000)throw new MapRules.Invalid("맵 데이터가 너무 커요.");return value;}catch(com.fasterxml.jackson.core.JsonProcessingException e){throw new IllegalStateException(e);}}
    private String token(){byte[] bytes=new byte[32];random.nextBytes(bytes);return Base64.getUrlEncoder().withoutPadding().encodeToString(bytes);}
    private static void uuid(String value){try{if(value==null||!UUID.fromString(value).toString().equals(value))throw new IllegalArgumentException();}catch(IllegalArgumentException e){throw new SpaceFailure(400,"MAP_INVALID_REQUEST","편집 요청 형식을 확인해 주세요.");}}
    private static SpaceFailure missingMap(){return new SpaceFailure(404,"MAP_NOT_FOUND","이 공간에 해당 지도가 없어요.");}
    private static SpaceFailure invalidMapRequest(){return new SpaceFailure(400,"MAP_INVALID_REQUEST","지도 이름이나 정렬 순서를 확인해 주세요.");}
    private static String hash(String value){try{return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(value.getBytes(StandardCharsets.UTF_8)));}catch(NoSuchAlgorithmException e){throw new IllegalStateException(e);}}
}
