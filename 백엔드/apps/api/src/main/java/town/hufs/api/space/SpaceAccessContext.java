package town.hufs.api.space;

import org.springframework.stereotype.Component;
import org.springframework.web.context.request.RequestContextHolder;
import org.springframework.web.context.request.ServletRequestAttributes;
import town.hufs.auth.SsoIdentityClaims;

/** Reads the transient domain assertion attached to this authenticated HTTP session. */
@Component
class SpaceAccessContext {
    String emailDomain() {
        if (!(RequestContextHolder.getRequestAttributes() instanceof ServletRequestAttributes attributes)) return null;
        var session = attributes.getRequest().getSession(false);
        if (session == null) return null;
        Object value = session.getAttribute(SsoIdentityClaims.EMAIL_DOMAIN_SESSION_ATTRIBUTE);
        return value instanceof String domain ? domain : null;
    }
}
