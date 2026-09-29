package town.hufs.api.space;

import jakarta.servlet.http.HttpServletRequest;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.*;
import town.hufs.auth.TownPrincipal;
import town.hufs.protocol.MapDefinition;
import java.util.*;

@RestController
@RequestMapping("/api/v1/spaces/{id}/map")
@ConditionalOnProperty(name="town.auth.mode",havingValue="sso",matchIfMissing=true)
class MapController {
    private final SpaceMaps maps;
    MapController(SpaceMaps maps){this.maps=maps;}
    @GetMapping MapDefinition published(@PathVariable String id,@AuthenticationPrincipal TownPrincipal p){return maps.published(id,p.userId());}
    @GetMapping("/editor") SpaceMaps.Editor editor(@PathVariable String id,@AuthenticationPrincipal TownPrincipal p){return maps.editor(id,p.userId());}
    @GetMapping("/history") List<SpaceMaps.Revision> history(@PathVariable String id,@AuthenticationPrincipal TownPrincipal p){return maps.history(id,p.userId());}
    @PostMapping("/lease") SpaceMaps.Lease acquire(@PathVariable String id,@AuthenticationPrincipal TownPrincipal p,@RequestBody Acquire body,HttpServletRequest request){return maps.acquire(id,p.userId(),request.getSession(false).getId(),body.clientId,body.takeover);}
    @PostMapping("/lease/renew") Map<String,String> renew(@PathVariable String id,@AuthenticationPrincipal TownPrincipal p,@RequestBody SpaceMaps.Credentials body,HttpServletRequest request){return Map.of("expiresAt",maps.renew(id,p.userId(),request.getSession(false).getId(),body));}
    @PostMapping("/lease/release") Map<String,Boolean> release(@PathVariable String id,@AuthenticationPrincipal TownPrincipal p,@RequestBody SpaceMaps.Credentials body,HttpServletRequest request){maps.release(id,p.userId(),request.getSession(false).getId(),body);return Map.of("released",true);}
    @PostMapping("/draft") SpaceMaps.Editor save(@PathVariable String id,@AuthenticationPrincipal TownPrincipal p,@RequestBody SpaceMaps.Save body,HttpServletRequest request){return maps.save(id,p.userId(),request.getSession(false).getId(),body);}
    @PostMapping("/publish") SpaceMaps.Editor publish(@PathVariable String id,@AuthenticationPrincipal TownPrincipal p,@RequestBody SpaceMaps.Publish body,HttpServletRequest request){return maps.publish(id,p.userId(),request.getSession(false).getId(),body);}
    @PostMapping("/restore") SpaceMaps.Editor restore(@PathVariable String id,@AuthenticationPrincipal TownPrincipal p,@RequestBody SpaceMaps.Restore body,HttpServletRequest request){return maps.restore(id,p.userId(),request.getSession(false).getId(),body);}
    record Acquire(String clientId,boolean takeover) {}
}
