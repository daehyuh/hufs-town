package town.hufs.api.space;

import jakarta.servlet.http.HttpServletRequest;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.*;
import town.hufs.auth.TownPrincipal;
import town.hufs.protocol.MapDefinition;
import java.util.List;
import java.util.Map;

@RestController
@RequestMapping("/api/v1/spaces/{spaceId}/maps")
@ConditionalOnProperty(name="town.auth.mode",havingValue="sso",matchIfMissing=true)
class SpaceMapCatalogController {
    private final SpaceMaps maps;
    private final SpaceMapEditPresence presence;
    SpaceMapCatalogController(SpaceMaps maps,SpaceMapEditPresence presence){this.maps=maps;this.presence=presence;}

    @GetMapping List<SpaceMaps.MapSummary> list(@PathVariable String spaceId,@AuthenticationPrincipal TownPrincipal p){return maps.catalog(spaceId,p.userId());}
    @PostMapping SpaceMaps.MapSummary create(@PathVariable String spaceId,@AuthenticationPrincipal TownPrincipal p,@RequestBody SpaceMaps.MapCreate body){return maps.create(spaceId,p.userId(),body);}
    @PostMapping("/{mapId}/clone") SpaceMaps.MapSummary clone(@PathVariable String spaceId,@PathVariable String mapId,@AuthenticationPrincipal TownPrincipal p,@RequestBody Clone body){return maps.clone(spaceId,mapId,p.userId(),body.name());}
    @DeleteMapping("/{mapId}") Map<String,Boolean> delete(@PathVariable String spaceId,@PathVariable String mapId,@AuthenticationPrincipal TownPrincipal p){maps.delete(spaceId,mapId,p.userId());return Map.of("deleted",true);}
    @PutMapping("/{mapId}/entry") List<SpaceMaps.MapSummary> entry(@PathVariable String spaceId,@PathVariable String mapId,@AuthenticationPrincipal TownPrincipal p){return maps.setEntry(spaceId,mapId,p.userId());}
    @PutMapping("/order") List<SpaceMaps.MapSummary> reorder(@PathVariable String spaceId,@AuthenticationPrincipal TownPrincipal p,@RequestBody Order body){return maps.reorder(spaceId,p.userId(),body.mapIds());}
    @GetMapping("/{mapId}/published") MapDefinition published(@PathVariable String spaceId,@PathVariable String mapId,@AuthenticationPrincipal TownPrincipal p){return maps.published(spaceId,mapId,p.userId());}
    @GetMapping("/{mapId}/editor") SpaceMaps.Editor editor(@PathVariable String spaceId,@PathVariable String mapId,@AuthenticationPrincipal TownPrincipal p){return maps.editor(spaceId,mapId,p.userId());}
    @GetMapping("/{mapId}/publication/{revisionId}") SpaceMaps.PublicationStatus publicationStatus(@PathVariable String spaceId,@PathVariable String mapId,@PathVariable String revisionId,@AuthenticationPrincipal TownPrincipal p){return maps.publicationStatus(spaceId,mapId,revisionId,p.userId());}
    @GetMapping("/{mapId}/history") List<SpaceMaps.Revision> history(@PathVariable String spaceId,@PathVariable String mapId,@AuthenticationPrincipal TownPrincipal p){return maps.history(spaceId,mapId,p.userId());}
    @PostMapping("/{mapId}/lease") SpaceMaps.Lease acquire(@PathVariable String spaceId,@PathVariable String mapId,@AuthenticationPrincipal TownPrincipal p,@RequestBody Acquire body,HttpServletRequest request){return maps.acquire(spaceId,mapId,p.userId(),request.getSession(false).getId(),body.clientId(),body.takeover());}
    @PostMapping("/{mapId}/lease/renew") Map<String,String> renew(@PathVariable String spaceId,@PathVariable String mapId,@AuthenticationPrincipal TownPrincipal p,@RequestBody SpaceMaps.Credentials body,HttpServletRequest request){return Map.of("expiresAt",maps.renew(spaceId,mapId,p.userId(),request.getSession(false).getId(),body));}
    @PostMapping("/{mapId}/lease/release") Map<String,Boolean> release(@PathVariable String spaceId,@PathVariable String mapId,@AuthenticationPrincipal TownPrincipal p,@RequestBody SpaceMaps.Credentials body,HttpServletRequest request){maps.release(spaceId,mapId,p.userId(),request.getSession(false).getId(),body);return Map.of("released",true);}
    @PostMapping("/{mapId}/draft") SpaceMaps.Editor save(@PathVariable String spaceId,@PathVariable String mapId,@AuthenticationPrincipal TownPrincipal p,@RequestBody SpaceMaps.Save body,HttpServletRequest request){return maps.save(spaceId,mapId,p.userId(),request.getSession(false).getId(),body);}
    @PostMapping("/{mapId}/publish") SpaceMaps.Editor publish(@PathVariable String spaceId,@PathVariable String mapId,@AuthenticationPrincipal TownPrincipal p,@RequestBody SpaceMaps.Publish body,HttpServletRequest request){return maps.publish(spaceId,mapId,p.userId(),request.getSession(false).getId(),body);}
    @PostMapping("/{mapId}/restore") SpaceMaps.Editor restore(@PathVariable String spaceId,@PathVariable String mapId,@AuthenticationPrincipal TownPrincipal p,@RequestBody SpaceMaps.Restore body,HttpServletRequest request){return maps.restore(spaceId,mapId,p.userId(),request.getSession(false).getId(),body);}
    @PostMapping("/{mapId}/edit/enable") SpaceMaps.CollaborativeSync enableCollaboration(@PathVariable String spaceId,@PathVariable String mapId,@AuthenticationPrincipal TownPrincipal p,@RequestBody EnableCollaboration body){return maps.enableCollaboration(spaceId,mapId,p.userId(),body.baseVersion());}
    @GetMapping("/{mapId}/edit/mode") SpaceMaps.EditMode editMode(@PathVariable String spaceId,@PathVariable String mapId,@AuthenticationPrincipal TownPrincipal p){return maps.editMode(spaceId,mapId,p.userId());}
    @GetMapping("/{mapId}/edit") SpaceMaps.CollaborativeSync collaborativeSync(@PathVariable String spaceId,@PathVariable String mapId,@AuthenticationPrincipal TownPrincipal p,@RequestParam(defaultValue="0") long afterSequence,@RequestParam(defaultValue="250") int limit){return maps.collaborativeSync(spaceId,mapId,p.userId(),afterSequence,limit);}
    @PostMapping("/{mapId}/edit/operations") SpaceMaps.OperationResult operation(@PathVariable String spaceId,@PathVariable String mapId,@AuthenticationPrincipal TownPrincipal p,@RequestBody com.fasterxml.jackson.databind.JsonNode body){return maps.editCollaboratively(spaceId,mapId,p.userId(),body);}
    @PostMapping("/{mapId}/edit/undo") SpaceMaps.OperationResult undo(@PathVariable String spaceId,@PathVariable String mapId,@AuthenticationPrincipal TownPrincipal p,@RequestBody com.fasterxml.jackson.databind.JsonNode body){return maps.undoCollaborative(spaceId,mapId,p.userId(),body);}
    @PostMapping("/{mapId}/edit/publish") SpaceMaps.CollaborativePublication publishCollaboratively(@PathVariable String spaceId,@PathVariable String mapId,@AuthenticationPrincipal TownPrincipal p,@RequestBody SpaceMaps.CollaborativePublish body){return maps.publishCollaborative(spaceId,mapId,p.userId(),body);}
    @PostMapping("/{mapId}/edit/presence") Map<String,Boolean> updatePresence(@PathVariable String spaceId,@PathVariable String mapId,@AuthenticationPrincipal TownPrincipal p,@RequestBody SpaceMapEditPresence.Update body){presence.update(spaceId,mapId,p,body);return Map.of("updated",true);}
    @GetMapping("/{mapId}/edit/presence") SpaceMapEditPresence.Snapshot presence(@PathVariable String spaceId,@PathVariable String mapId,@AuthenticationPrincipal TownPrincipal p,@RequestParam(required=false) String clientId){return presence.list(spaceId,mapId,p,clientId);}
    @DeleteMapping("/{mapId}/edit/presence") Map<String,Boolean> removePresence(@PathVariable String spaceId,@PathVariable String mapId,@AuthenticationPrincipal TownPrincipal p,@RequestParam String clientId){presence.remove(spaceId,mapId,p,clientId);return Map.of("removed",true);}
    record Order(List<String> mapIds) {}
    record Clone(String name) {}
    record Acquire(String clientId,boolean takeover) {}
    record EnableCollaboration(long baseVersion) {}
}
