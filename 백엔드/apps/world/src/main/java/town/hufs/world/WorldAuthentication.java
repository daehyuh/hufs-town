package town.hufs.world;

import org.springframework.beans.factory.ObjectProvider;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.*;
import org.springframework.http.server.*;
import org.springframework.session.Session;
import org.springframework.session.SessionRepository;
import org.springframework.stereotype.Component;
import org.springframework.web.socket.WebSocketHandler;
import org.springframework.web.socket.server.HandshakeInterceptor;
import org.springframework.web.util.UriComponentsBuilder;
import town.hufs.auth.*;
import java.util.Map;

@Component
public class WorldAuthentication implements HandshakeInterceptor {
    static final String PRINCIPAL = "town.principal";
    static final String GUEST = "town.guest";
    static final String SESSION_ID = "town.sessionId";
    static final String ADMISSION = "town.admission";
    static final String MAP = "town.map";
    private final AuthRuntime runtime;
    private final ObjectProvider<SessionRepository<? extends Session>> sessions;
    private final ObjectProvider<JoinTickets> tickets;
    private final ObjectProvider<PublishedMaps> maps;
    @Value("${town.auth.preview-multimap-enabled:false}")
    private boolean previewMultimapEnabled;
    @Value("${town.auth.preview-identities-enabled:false}")
    private boolean previewIdentitiesEnabled;
    public WorldAuthentication(AuthRuntime runtime, ObjectProvider<SessionRepository<? extends Session>> sessions, ObjectProvider<JoinTickets> tickets, ObjectProvider<PublishedMaps> maps) {
        this.runtime = runtime; this.sessions = sessions; this.tickets = tickets; this.maps = maps;
    }
    boolean preview() { return runtime.preview(); }
    @Override public boolean beforeHandshake(ServerHttpRequest request, ServerHttpResponse response, WebSocketHandler handler, Map<String, Object> attributes) {
        // Require Origin even for non-browser clients; do not allow cookie-based cross-site sockets.
        if (!runtime.allowsOrigin(request.getHeaders().getOrigin())) { response.setStatusCode(HttpStatus.FORBIDDEN); return false; }
        if (runtime.preview()) {
            if (previewIdentitiesEnabled) {
                String identity = UriComponentsBuilder.fromUri(request.getURI()).build()
                    .getQueryParams().getFirst("townPreviewUser");
                if (identity != null && identity.matches("preview-[A-Za-z0-9_-]{1,72}")) {
                    attributes.put(PRINCIPAL, new TownPrincipal(identity, identity, 0));
                    attributes.put(SESSION_ID, "preview-identity-" + identity);
                }
            }
            if (previewMultimapEnabled) {
                String mapId = UriComponentsBuilder.fromUri(request.getURI()).build()
                    .getQueryParams().getFirst("townMapId");
                if (mapId != null && mapId.matches("[A-Za-z0-9_-]{1,80}")) {
                    attributes.put(ADMISSION, new JoinTickets.Admission(
                        "preview-multimap", "", "", "preview", mapId, 100,
                        -1, -1, "", false, ""));
                }
            }
            return true;
        }
        if (request instanceof ServletServerHttpRequest servlet) {
            var session = servlet.getServletRequest().getSession(false);
            var principal = session == null ? null : TownPrincipal.from(session.getAttribute(TownPrincipal.CONTEXT_KEY));
            var guest = session == null ? null : session.getAttribute(GuestIdentity.SESSION_ATTRIBUTE) instanceof GuestIdentity identity ? identity : null;
            if (principal != null || guest != null) {
                String token = request.getHeaders().getOrEmpty("Sec-WebSocket-Protocol").stream()
                    .flatMap(value -> java.util.Arrays.stream(value.split(","))).map(String::trim)
                    .filter(value -> value.startsWith("hufs-ticket.")).map(value -> value.substring(12)).findFirst().orElse(null);
                JoinTickets.Admission admission;
                String userId = principal != null ? principal.userId() : guest.guestId();
                try { admission = tickets.getObject().consume(token, userId, session.getId()); }
                catch (RuntimeException unavailable) { response.setStatusCode(HttpStatus.SERVICE_UNAVAILABLE); return false; }
                if (admission == null) { response.setStatusCode(HttpStatus.FORBIDDEN); return false; }
                try {
                    var published = maps.getObject().read(admission.spaceId(),admission.mapId());
                    if (published == null) { response.setStatusCode(HttpStatus.SERVICE_UNAVAILABLE); return false; }
                    attributes.put(MAP, published);
                } catch (RuntimeException unavailable) { response.setStatusCode(HttpStatus.SERVICE_UNAVAILABLE); return false; }
                attributes.put(ADMISSION, admission);
                attributes.put(PRINCIPAL, principal != null ? principal : guest.principal());
                attributes.put(GUEST, guest != null);
                attributes.put(SESSION_ID, session.getId()); return true;
            }
        }
        response.setStatusCode(HttpStatus.UNAUTHORIZED); return false;
    }
    public boolean active(String sessionId, TownPrincipal expected) {
        if (runtime.preview()) return true;
        if (sessionId == null || expected == null) return false;
        var session = sessions.getObject().findById(sessionId);
        Object guestValue = session == null ? null : session.getAttribute(GuestIdentity.SESSION_ATTRIBUTE);
        if (guestValue instanceof GuestIdentity guest)
            return guest.guestId().equals(expected.userId());
        var current = session == null ? null : TownPrincipal.from(session.getAttribute(TownPrincipal.CONTEXT_KEY));
        return current != null && current.userId().equals(expected.userId());
    }
    public PublishedMaps.Published map(String spaceId) { return map(spaceId,spaceId); }
    public PublishedMaps.Published map(String spaceId,String mapId) { return runtime.preview() ? null : maps.getObject().read(spaceId,mapId); }
    public void release(JoinTickets.Admission admission) {
        if (runtime.preview() || admission == null) return;
        try { tickets.getObject().release(admission); } catch (RuntimeException ignored) { }
    }
    public void releaseSeat(String spaceId, String seatId, String resumeToken) {
        if (runtime.preview()) return;
        tickets.getObject().releaseSeat(spaceId, seatId, resumeToken);
    }
    public void releaseSeat(JoinTickets.SeatLease lease) {
        if (runtime.preview()) return;
        tickets.getObject().releaseSeat(lease.spaceId(), lease.seatId(), lease.resumeToken(), lease.userId(),
            lease.sessionId(), lease.nodeId(), lease.fence());
    }
    public JoinTickets.Ownership claimSeat(String spaceId, String seatId, String resumeToken,
                                           String userId, String sessionId, String nodeId) {
        return claimSeat(spaceId, seatId, resumeToken, userId, sessionId, nodeId, false);
    }
    public JoinTickets.Ownership claimSeat(String spaceId, String seatId, String resumeToken,
                                           String userId, String sessionId, String nodeId, boolean forceTakeover) {
        if (runtime.preview()) return null;
        return tickets.getObject().claimSeat(spaceId, seatId, resumeToken, userId, sessionId, nodeId, forceTakeover);
    }
    public void releaseOwnership(JoinTickets.Ownership ownership) {
        if (runtime.preview()) return;
        tickets.getObject().releaseOwnership(ownership);
    }
    public JoinTickets.SeatRenewal renewSeats(String spaceId, java.util.Collection<JoinTickets.SeatLease> seats) {
        if (runtime.preview()) return new JoinTickets.SeatRenewal(Long.MAX_VALUE, java.util.Set.of());
        return tickets.getObject().renewSeats(spaceId, seats);
    }
    @Override public void afterHandshake(ServerHttpRequest request, ServerHttpResponse response, WebSocketHandler handler, Exception exception) {}
}
