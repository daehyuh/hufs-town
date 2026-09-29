package town.hufs.auth;

import java.net.URI;
import java.util.LinkedHashSet;
import java.util.List;
import org.springframework.core.env.Environment;
import org.springframework.core.env.Profiles;

public final class AuthRuntime {
    private final String mode;
    private final String publicOrigin;
    private final List<String> allowedOrigins;

    public AuthRuntime(Environment env) {
        this(
            env.getProperty("town.auth.mode", "sso"),
            env.getRequiredProperty("town.public-origin"),
            env.getProperty("town.allowed-origins", "")
        );
        if (preview() && !env.acceptsProfiles(Profiles.of("local", "preview", "test")))
            throw new IllegalStateException("Preview authentication is only allowed in explicit local/preview/test profiles");
    }

    public AuthRuntime(String mode, String publicOrigin) {
        this(mode, publicOrigin, "");
    }

    public AuthRuntime(String mode, String publicOrigin, String configuredAllowedOrigins) {
        if (!mode.equals("sso") && !mode.equals("preview")) throw new IllegalStateException("Unknown town.auth.mode");
        this.mode = mode;
        this.publicOrigin = validateOrigin(publicOrigin);

        var origins = new LinkedHashSet<String>();
        origins.add(this.publicOrigin);
        if (configuredAllowedOrigins != null && !configuredAllowedOrigins.isBlank()) {
            for (String origin : configuredAllowedOrigins.split(",")) {
                if (origin.isBlank()) continue;
                origins.add(validateOrigin(origin.trim()));
            }
        }
        this.allowedOrigins = List.copyOf(origins);
    }

    public String mode() { return mode; }
    public String publicOrigin() { return publicOrigin; }
    public List<String> allowedOrigins() { return allowedOrigins; }
    public boolean allowsOrigin(String origin) { return origin != null && allowedOrigins.contains(origin); }
    public boolean preview() { return mode.equals("preview"); }

    private static String validateOrigin(String value) {
        if (value == null || value.isBlank() || !value.equals(value.trim()))
            throw new IllegalStateException("Invalid allowed origin");
        try {
            URI uri = URI.create(value);
            String scheme = uri.getScheme();
            if (uri.isOpaque() || !("http".equals(scheme) || "https".equals(scheme))
                || uri.getHost() == null || uri.getUserInfo() != null
                || (uri.getRawPath() != null && !uri.getRawPath().isEmpty())
                || uri.getRawQuery() != null || uri.getRawFragment() != null
                || uri.getPort() == 0 || uri.getPort() > 65535)
                throw new IllegalArgumentException();
        } catch (IllegalArgumentException invalid) {
            throw new IllegalStateException("Invalid allowed origin", invalid);
        }
        return value;
    }
}
