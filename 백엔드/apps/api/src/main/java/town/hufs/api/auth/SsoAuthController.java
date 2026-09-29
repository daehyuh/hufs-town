package town.hufs.api.auth;

import jakarta.servlet.http.*;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.http.HttpStatus;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.security.web.context.HttpSessionSecurityContextRepository;
import org.springframework.security.web.csrf.HttpSessionCsrfTokenRepository;
import org.springframework.session.data.redis.RedisIndexedSessionRepository;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.util.UriComponentsBuilder;
import town.hufs.auth.TownPrincipal;
import town.hufs.auth.GuestIdentity;
import town.hufs.auth.SsoIdentityClaims;
import java.util.*;

@RestController
@RequestMapping("/api/v1/auth")
@ConditionalOnProperty(name = "town.auth.mode", havingValue = "sso", matchIfMissing = true)
class SsoAuthController {
    private final SsoSettings settings;
    private final SsoClient sso;
    private final LoginFlows flows;
    private final TownAccounts accounts;
    private final AccountDeletionService accountDeletion;
    private final GuestModerationUpgrade guestModeration;
    private final RedisIndexedSessionRepository sessions;
    private final HttpSessionSecurityContextRepository contexts;
    SsoAuthController(SsoSettings settings, SsoClient sso, LoginFlows flows, TownAccounts accounts,
                      AccountDeletionService accountDeletion, GuestModerationUpgrade guestModeration,
                      RedisIndexedSessionRepository sessions,
                      HttpSessionSecurityContextRepository contexts) {
        this.settings = settings; this.sso = sso; this.flows = flows; this.accounts = accounts;
        this.accountDeletion = accountDeletion; this.guestModeration = guestModeration;
        this.sessions = sessions; this.contexts = contexts;
    }
    @PostMapping("/start") Map<String, String> start(HttpServletRequest request) {
        if (!settings.configured()) throw new AuthFailure(HttpStatus.SERVICE_UNAVAILABLE, "SSO_NOT_CONFIGURED", "SSO 관리자 연결 설정을 기다리고 있어요.");
        flows.limit("start", request.getRemoteAddr());
        String state = flows.start(request.getSession().getId());
        String url = UriComponentsBuilder.fromUriString(settings.authorizeUrl()).queryParam("client_id", settings.clientId())
            .queryParam("redirect_uri", settings.redirectUri()).queryParam("state", state).queryParam("select_account", true).build().encode().toUriString();
        return Map.of("authorizationUrl", url);
    }
    @PostMapping("/exchange") TownPrincipal exchange(@RequestBody Exchange request, HttpServletRequest servlet, HttpServletResponse response) {
        flows.limit("exchange", servlet.getRemoteAddr());
        HttpSession session = servlet.getSession(false);
        flows.consume(session == null ? null : session.getId(), request.state(), request.code());
        // Network I/O is outside the account transaction. Raw codes/profile responses are never logged.
        SsoClient.UserInfo identity = sso.exchange(request.code());
        TownPrincipal user = accounts.login(identity);
        GuestIdentity previousGuest = session == null ? null
            : session.getAttribute(GuestIdentity.SESSION_ATTRIBUTE) instanceof GuestIdentity guest ? guest : null;
        if (previousGuest != null) guestModeration.transfer(previousGuest.guestId(), user.userId());
        servlet.changeSessionId();
        HttpSession authenticatedSession = servlet.getSession(false);
        if (authenticatedSession != null) {
            // A browser may upgrade its ephemeral guest session to an SSO account.
            // Never let the old guest marker override the authenticated identity at the world handshake.
            authenticatedSession.removeAttribute(GuestIdentity.SESSION_ATTRIBUTE);
            String emailDomain = SsoIdentityClaims.emailDomain(identity.email());
            if (emailDomain == null) authenticatedSession.removeAttribute(SsoIdentityClaims.EMAIL_DOMAIN_SESSION_ATTRIBUTE);
            else authenticatedSession.setAttribute(SsoIdentityClaims.EMAIL_DOMAIN_SESSION_ATTRIBUTE, emailDomain);
        }
        new HttpSessionCsrfTokenRepository().saveToken(null, servlet, response);
        save(user, servlet, response);
        return user;
    }
    @GetMapping("/me") TownPrincipal me(@AuthenticationPrincipal TownPrincipal principal, HttpServletRequest request, HttpServletResponse response) {
        TownPrincipal fresh;
        try { fresh = accounts.current(principal.userId()); }
        catch (AuthFailure failure) {
            HttpSession session = request.getSession(false);
            if (session != null) session.invalidate();
            SecurityContextHolder.clearContext();
            throw failure;
        }
        save(fresh, request, response);
        return fresh;
    }
    @PatchMapping("/profile") TownPrincipal profile(@AuthenticationPrincipal TownPrincipal principal, @RequestBody Profile profile, HttpServletRequest request, HttpServletResponse response) {
        TownPrincipal fresh = accounts.update(principal.userId(), profile.displayName(), profile.avatar(),
            profile.skin() == null ? principal.skin() : profile.skin(),
            profile.clothing() == null ? principal.clothing() : profile.clothing(),
            profile.hair() == null ? principal.hair() : profile.hair(),
            profile.bio() == null ? principal.bio() : profile.bio(),
            profile.links() == null ? principal.links() : profile.links());
        save(fresh, request, response);
        return fresh;
    }
    @PatchMapping("/preferences") TownPrincipal preferences(@AuthenticationPrincipal TownPrincipal principal, @RequestBody Preferences preferences, HttpServletRequest request, HttpServletResponse response) {
        TownPrincipal fresh = accounts.updatePokePreference(principal.userId(), preferences == null ? null : preferences.allowPokes());
        save(fresh, request, response);
        return fresh;
    }
    @GetMapping("/account/deletion-impact") AccountDeletionService.Impact deletionImpact(@AuthenticationPrincipal TownPrincipal principal) {
        return accountDeletion.impact(principal.userId());
    }
    @DeleteMapping("/account") Map<String, Boolean> deleteAccount(@AuthenticationPrincipal TownPrincipal principal,
                                                                     @RequestBody DeleteAccount request,
                                                                     HttpServletRequest servlet) {
        HttpSession current = servlet.getSession(false);
        String currentId = current == null ? null : current.getId();
        accountDeletion.delete(principal.userId(), request == null ? null : request.confirmation(), () ->
            sessions.findByPrincipalName(principal.userId()).keySet().stream()
                .filter(id -> !id.equals(currentId))
                .forEach(sessions::deleteById));
        if (current != null) current.invalidate();
        SecurityContextHolder.clearContext();
        return Map.of("deleted", true);
    }
    @PostMapping("/logout") Map<String, Boolean> logout(HttpServletRequest request) {
        HttpSession session = request.getSession(false);
        if (session != null) session.invalidate();
        SecurityContextHolder.clearContext();
        return Map.of("loggedOut", true);
    }
    @DeleteMapping("/sessions") Map<String, Boolean> logoutEverywhere(
            @AuthenticationPrincipal TownPrincipal principal, HttpServletRequest request) {
        HttpSession current = request.getSession(false);
        String currentId = current == null ? null : current.getId();
        sessions.findByPrincipalName(principal.userId()).keySet().stream()
            .filter(id -> !id.equals(currentId))
            .forEach(sessions::deleteById);
        if (current != null) current.invalidate();
        SecurityContextHolder.clearContext();
        return Map.of("loggedOut", true);
    }
    private void save(TownPrincipal user, HttpServletRequest request, HttpServletResponse response) {
        var context = SecurityContextHolder.createEmptyContext();
        context.setAuthentication(UsernamePasswordAuthenticationToken.authenticated(user, null, List.of()));
        SecurityContextHolder.setContext(context);
        contexts.saveContext(context, request, response);
    }
    record Exchange(String code, String state) { @Override public String toString() { return "LoginCallback[redacted]"; } }
    record Profile(String displayName, Integer avatar, String skin, String clothing, String hair, String bio, List<String> links) {}
    record Preferences(Boolean allowPokes) {}
    record DeleteAccount(String confirmation) {}
}
