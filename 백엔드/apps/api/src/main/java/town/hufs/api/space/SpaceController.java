package town.hufs.api.space;

import jakarta.servlet.http.HttpServletRequest;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.data.redis.core.script.DefaultRedisScript;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.*;
import town.hufs.auth.*;
import town.hufs.domain.Movement;
import town.hufs.protocol.MapDefinition;
import town.hufs.protocol.Portal;
import java.util.*;

@RestController
@RequestMapping("/api/v1/spaces")
@ConditionalOnProperty(name = "town.auth.mode", havingValue = "sso", matchIfMissing = true)
class SpaceController {
    private final Spaces spaces; private final SpaceCloner cloner; private final JoinTickets tickets; private final StringRedisTemplate redis;
    private final SpaceMaps maps; private final WorldNodeRouter worldNodes; private final RoomReservations roomReservations;
    private static final DefaultRedisScript<Long> LIMIT = new DefaultRedisScript<>("local n=redis.call('INCR',KEYS[1]); if n==1 then redis.call('EXPIRE',KEYS[1],60) end; return n", Long.class);
    SpaceController(Spaces spaces, SpaceCloner cloner, JoinTickets tickets, StringRedisTemplate redis, SpaceMaps maps,
                    WorldNodeRouter worldNodes, RoomReservations roomReservations) {
        this.spaces=spaces; this.cloner=cloner; this.tickets=tickets; this.redis=redis; this.maps=maps;
        this.worldNodes=worldNodes; this.roomReservations=roomReservations;
    }
    private void limit(TownPrincipal p) {
        Long count = redis.execute(LIMIT, List.of("hufs-town:space-limit:" + p.userId()));
        if (count == null || count > 60) throw new SpaceFailure(429, "SPACE_RATE_LIMIT", "요청이 많아요. 1분 뒤 다시 시도해 주세요.");
    }
    @GetMapping Spaces.SpacePage list(@AuthenticationPrincipal TownPrincipal p,
                                     @RequestParam(defaultValue = "") String q,
                                     @RequestParam(defaultValue = "browse") String view,
                                     @RequestParam(defaultValue = "1") int page,
                                     @RequestParam(defaultValue = "12") int pageSize) {
        return spaces.list(p.userId(), q, view, page, pageSize);
    }
    @GetMapping("/ownership-transfers/incoming") List<Spaces.IncomingOwnershipTransfer> incomingOwnershipTransfers(@AuthenticationPrincipal TownPrincipal p) {
        return spaces.incomingOwnershipTransfers(p.userId());
    }
    @GetMapping("/invitations/incoming") List<Spaces.IncomingSpaceInvite> incomingSpaceInvites(@AuthenticationPrincipal TownPrincipal p) {
        return spaces.incomingSpaceInvites(p.userId());
    }
    @GetMapping("/join-requests/incoming") Spaces.IncomingJoinRequestPage incomingJoinRequests(
            @AuthenticationPrincipal TownPrincipal p,
            @RequestParam(required = false) String cursor,
            @RequestParam(defaultValue = "50") int limit) {
        return spaces.incomingJoinRequests(p.userId(), cursor, limit);
    }
    @PostMapping("/invitations/{inviteId}/accept") Spaces.Space acceptSpaceInvite(@PathVariable String inviteId,
                                                                                     @AuthenticationPrincipal TownPrincipal p) {
        limit(p); return spaces.acceptIncomingSpaceInvite(inviteId,p.userId());
    }
    @PostMapping("/invitations/{inviteId}/decline") Map<String, Boolean> declineSpaceInvite(@PathVariable String inviteId,
                                                                                               @AuthenticationPrincipal TownPrincipal p) {
        limit(p); spaces.declineIncomingSpaceInvite(inviteId,p.userId()); return Map.of("declined",true);
    }
    @GetMapping("/{id}") Spaces.Space detail(@PathVariable String id, @AuthenticationPrincipal TownPrincipal p) { return spaces.detail(id, p.userId()); }
    @PostMapping("/{id}/archive") Spaces.ArchiveState archive(@PathVariable String id, @AuthenticationPrincipal TownPrincipal p) {
        limit(p); return spaces.archive(id, p.userId());
    }
    @PostMapping("/{id}/restore") Spaces.ArchiveState restore(@PathVariable String id, @AuthenticationPrincipal TownPrincipal p) {
        limit(p); return spaces.restore(id, p.userId());
    }
    @PostMapping("/{id}/clone") Spaces.Space cloneSpace(@PathVariable String id, @AuthenticationPrincipal TownPrincipal p,
                                                        @RequestBody CloneRequest request) {
        limit(p); return cloner.clone(id, p.userId(), request.name());
    }
    @PutMapping("/{id}/favorite") Spaces.FavoriteState favorite(@PathVariable String id, @AuthenticationPrincipal TownPrincipal p) {
        limit(p); return spaces.setFavorite(id, p.userId(), true);
    }
    @DeleteMapping("/{id}/favorite") Spaces.FavoriteState unfavorite(@PathVariable String id, @AuthenticationPrincipal TownPrincipal p) {
        limit(p); return spaces.setFavorite(id, p.userId(), false);
    }
    @GetMapping("/{id}/members") List<Spaces.Member> members(@PathVariable String id, @AuthenticationPrincipal TownPrincipal p) { return spaces.members(id, p.userId()); }
    @PatchMapping("/{id}/members/{userId}/role") Map<String, String> setMemberRole(@PathVariable String id, @PathVariable String userId,
                                                                                       @AuthenticationPrincipal TownPrincipal p,
                                                                                       @RequestBody MemberRoleChange change) {
        limit(p); spaces.setMemberRole(id, p.userId(), userId, change.role()); return Map.of("role", change.role());
    }
    @GetMapping("/{id}/ownership-transfer") List<Spaces.OwnershipTransfer> ownershipTransfer(@PathVariable String id, @AuthenticationPrincipal TownPrincipal p) {
        return spaces.ownershipTransfer(id, p.userId());
    }
    @PostMapping("/{id}/ownership-transfer") Spaces.OwnershipTransfer requestOwnershipTransfer(@PathVariable String id,
                                                                                                    @AuthenticationPrincipal TownPrincipal p,
                                                                                                    @RequestBody OwnershipTransferDraft draft) {
        limit(p); return spaces.requestOwnershipTransfer(id, p.userId(), draft.targetUserId());
    }
    @DeleteMapping("/{id}/ownership-transfer") Map<String, Boolean> cancelOwnershipTransfer(@PathVariable String id,
                                                                                               @AuthenticationPrincipal TownPrincipal p) {
        limit(p); spaces.cancelOwnershipTransfer(id, p.userId()); return Map.of("cancelled", true);
    }
    @PostMapping("/{id}/ownership-transfer/respond") Spaces.OwnershipTransferResult respondOwnershipTransfer(@PathVariable String id,
                                                                                                                   @AuthenticationPrincipal TownPrincipal p,
                                                                                                                   @RequestBody OwnershipTransferDecision decision) {
        limit(p); return spaces.respondOwnershipTransfer(id, p.userId(), decision.decision());
    }
    @GetMapping("/{id}/access-blocks") List<Spaces.AccessBlock> accessBlocks(@PathVariable String id, @AuthenticationPrincipal TownPrincipal p) { return spaces.accessBlocks(id, p.userId()); }
    @GetMapping("/{id}/join-requests") Spaces.JoinRequestPage joinRequests(
            @PathVariable String id, @AuthenticationPrincipal TownPrincipal p,
            @RequestParam(required = false) String cursor,
            @RequestParam(defaultValue = "50") int limit) {
        return spaces.joinRequests(id, p.userId(), cursor, limit);
    }
    @PostMapping("/{id}/join-requests") Spaces.JoinRequestState requestJoin(@PathVariable String id, @AuthenticationPrincipal TownPrincipal p) {
        limit(p); return spaces.requestJoin(id, p.userId());
    }
    @PostMapping("/{id}/join-requests/{requestId}/resolve") Map<String, Boolean> resolveJoinRequest(@PathVariable String id, @PathVariable String requestId,
                                                                                                      @AuthenticationPrincipal TownPrincipal p,
                                                                                                      @RequestBody JoinRequestDecision decision) {
        limit(p); spaces.resolveJoinRequest(id, p.userId(), requestId, decision.decision()); return Map.of("resolved", true);
    }
    @DeleteMapping("/{id}/members/{userId}") Map<String, Boolean> kickMember(@PathVariable String id, @PathVariable String userId,
                                                                                @AuthenticationPrincipal TownPrincipal p) {
        limit(p); spaces.kickMember(id, p.userId(), userId); return Map.of("removed", true, "accessBlocked", true);
    }
    @DeleteMapping("/{id}/access-blocks/{userId}") Map<String, Boolean> unblockMember(@PathVariable String id, @PathVariable String userId,
                                                                                         @AuthenticationPrincipal TownPrincipal p) {
        limit(p); spaces.unblockMember(id, p.userId(), userId); return Map.of("unblocked", true);
    }
    @PostMapping Spaces.Space create(@AuthenticationPrincipal TownPrincipal p, @RequestBody Spaces.Draft draft) { limit(p); return spaces.create(p.userId(), draft); }
    @PatchMapping("/{id}") Spaces.Space edit(@PathVariable String id, @AuthenticationPrincipal TownPrincipal p, @RequestBody Spaces.Edit edit) { limit(p); return spaces.edit(id, p.userId(), edit); }
    @PostMapping("/{id}/admission") Map<String, Object> admission(@PathVariable String id, @AuthenticationPrincipal TownPrincipal p, HttpServletRequest request,
                                                                    @RequestBody(required=false) AdmissionRequest body) {
        limit(p);
        boolean roomReservation = body != null && !blank(body.reservationId());
        boolean hasPortalProof = body != null && (body.sourceSpaceId()!=null || body.sourceMapId()!=null || body.portalId()!=null);
        if (roomReservation && hasPortalProof)
            throw new SpaceFailure(400, "ADMISSION_TARGET_CONFLICT", "예약 입장과 포털 입장을 함께 요청할 수 없어요.");
        Portal portal = roomReservation ? null : portalProof(id, p.userId(), body);
        var s = spaces.join(id, p.userId());
        RoomReservations.EntryMap reservation = roomReservation
            ? roomReservations.entryMap(id, body.reservationId(), p.userId()) : null;
        String mapId = reservation != null ? reservation.mapId() : portal == null
            ? body==null||body.mapId()==null||body.mapId().isBlank()?maps.entryMapId(id):body.mapId()
            : portal.targetMapId()==null||portal.targetMapId().isBlank()?maps.entryMapId(id):portal.targetMapId();
        if (reservation != null && body.mapId()!=null && !body.mapId().isBlank() && !body.mapId().equals(mapId))
            throw new SpaceFailure(400, "ROOM_RESERVATION_MAP_MISMATCH", "예약된 회의실 지도와 입장 요청이 일치하지 않아요.");
        if (portal != null && body.mapId()!=null && !body.mapId().isBlank() && !body.mapId().equals(mapId))
            throw new SpaceFailure(400, "MAP_PORTAL_DESTINATION_MISMATCH", "포털의 목적 지도와 입장 요청이 일치하지 않아요.");
        MapDefinition destination = maps.published(id,mapId,p.userId());
        if (reservation != null && (destination.zones()==null || destination.zones().stream().filter(Objects::nonNull)
            .noneMatch(zone -> reservation.zoneId().equals(zone.id()) && "PRIVATE".equals(zone.kind()))))
            throw new SpaceFailure(409, "ROOM_RESERVATION_ROOM_UNAVAILABLE", "예약한 회의실이 현재 게시된 지도에 없어요. 예약을 수정하거나 취소해 주세요.");
        Movement.Position spawn = portal == null ? null : safeSpawn(destination, portal);
        String resumeToken = body == null ? "" : body.resumeToken();
        if (resumeToken != null && !resumeToken.isBlank() && !resumeToken.matches("[A-Za-z0-9-]{1,100}"))
            throw new SpaceFailure(400, "RESUME_TOKEN_INVALID", "재접속 정보가 올바르지 않아요.");
        try {
            String ticket = tickets.issue(p.userId(), request.getSession(false).getId(), s.id(), mapId, s.capacity(),
                spawn == null ? -1 : spawn.x(), spawn == null ? -1 : spawn.y(), resumeToken);
            return Map.of("ticket", ticket, "expiresInSeconds", 30, "worldUrl", worldNodes.endpointFor(s.id()));
        } catch (JoinTickets.Full full) {
            throw new SpaceFailure(409, "SPACE_FULL", "공간 입장 정원이 가득 찼어요. 잠시 후 다시 시도해 주세요.");
        } catch (JoinTickets.Unavailable unavailable) {
            throw new SpaceFailure(503, "SPACE_RESERVATION_UNAVAILABLE", "입장 정원을 확인할 수 없어요. 잠시 후 다시 시도해 주세요.");
        }
    }
    private Portal portalProof(String destinationSpace, String userId, AdmissionRequest body) {
        if (body == null) return null;
        boolean any = body.sourceSpaceId()!=null || body.sourceMapId()!=null || body.portalId()!=null;
        if (!any) return null;
        if (blank(body.sourceSpaceId()) || blank(body.sourceMapId()) || blank(body.portalId()))
            throw new SpaceFailure(400, "MAP_PORTAL_PROOF_INVALID", "포털 입장 정보가 올바르지 않아요.");
        MapDefinition source = maps.published(body.sourceSpaceId(), body.sourceMapId(), userId);
        if (source.portals() == null) throw new SpaceFailure(400, "MAP_PORTAL_NOT_FOUND", "현재 지도에서 포털을 찾을 수 없어요.");
        return source.portals().stream().filter(Objects::nonNull)
            .filter(portal -> body.portalId().equals(portal.id()) && destinationSpace.equals(portal.targetSpaceId()))
            .findFirst().orElseThrow(() -> new SpaceFailure(400, "MAP_PORTAL_NOT_FOUND", "현재 지도에서 이 공간으로 연결되는 포털을 찾을 수 없어요."));
    }
    private static boolean blank(String value) { return value == null || value.isBlank(); }
    private static Movement.Position safeSpawn(MapDefinition map, Portal portal) {
        if (safePublicPosition(map, portal.targetSpawnX(), portal.targetSpawnY()))
            return new Movement.Position(portal.targetSpawnX(), portal.targetSpawnY());
        if (safePublicPosition(map, map.spawnX(), map.spawnY()))
            return new Movement.Position(map.spawnX(), map.spawnY());
        throw new SpaceFailure(409, "MAP_PORTAL_SPAWN_INVALID", "목적 지도에 안전한 공개 도착 위치가 없어요.");
    }
    private static boolean safePublicPosition(MapDefinition map, double x, double y) {
        if (!Movement.canStand(map, x, y)) return false;
        return map.zones()==null || map.zones().stream().filter(Objects::nonNull)
            .filter(zone -> Movement.inside(zone.bounds(), x, y))
            .noneMatch(zone -> "PRIVATE".equals(zone.kind()));
    }
    @GetMapping("/{id}/invites") List<Spaces.Invite> invites(@PathVariable String id, @AuthenticationPrincipal TownPrincipal p) { return spaces.invites(id, p.userId()); }
    @PostMapping("/{id}/invites") Spaces.CreatedInvite invite(@PathVariable String id, @AuthenticationPrincipal TownPrincipal p, @RequestBody InviteDraft draft) { limit(p); return spaces.invite(id, p.userId(), draft.hours(), draft.maxUses(), draft.targetUserId()); }
    @PostMapping("/{id}/invites/{inviteId}/revoke") Map<String, Boolean> revoke(@PathVariable String id, @PathVariable String inviteId, @AuthenticationPrincipal TownPrincipal p) { limit(p); spaces.revoke(id, inviteId, p.userId()); return Map.of("revoked", true); }
    @PostMapping("/redeem") Spaces.Space redeem(@AuthenticationPrincipal TownPrincipal p, @RequestBody Code code) { limit(p); return spaces.redeem(code.code(), p.userId()); }
    record InviteDraft(Integer hours, Integer maxUses, String targetUserId) {}
    record CloneRequest(String name) {}
    record AdmissionRequest(String mapId, String sourceSpaceId, String sourceMapId, String portalId, String resumeToken, String reservationId) {}
    record MemberRoleChange(String role) {}
    record OwnershipTransferDraft(String targetUserId) {}
    record OwnershipTransferDecision(String decision) {}
    record JoinRequestDecision(String decision) {}
    record Code(String code) { @Override public String toString() { return "InviteCode[redacted]"; } }
}
