package town.hufs.api.auth;

import org.springframework.boot.context.properties.ConfigurationProperties;
import java.net.URI;

@ConfigurationProperties("town.auth.sso")
public record SsoSettings(String authorizeUrl, String userinfoUrl, String clientId, String clientSecret, String redirectUri) {
    public boolean configured() {
        return clientId != null && !clientId.isBlank() && clientSecret != null && !clientSecret.isBlank();
    }
    public void validate(String origin) {
        if (!configured()) return;
        for (String url : new String[]{authorizeUrl, userinfoUrl}) {
            var uri = URI.create(url);
            if (!"https".equals(uri.getScheme()) || uri.getHost() == null || uri.getUserInfo() != null || uri.getFragment() != null || uri.getQuery() != null)
                throw new IllegalStateException("SSO endpoints must be HTTPS URLs without credentials, query or fragment");
        }
        if (!redirectUri.equals(origin + "/auth/callback"))
            throw new IllegalStateException("SSO redirect URI must equal town.public-origin + /auth/callback");
        var uri = URI.create(origin);
        boolean loopback = "127.0.0.1".equals(uri.getHost()) || "localhost".equals(uri.getHost());
        if (!("https".equals(uri.getScheme()) || (loopback && "http".equals(uri.getScheme())))
            || uri.getHost() == null || uri.getUserInfo() != null || uri.getFragment() != null || uri.getQuery() != null || !uri.getPath().isEmpty())
            throw new IllegalStateException("Invalid town.public-origin");
    }
    // Never include the client secret in a generated record toString().
    @Override public String toString() { return "SsoSettings[configured=" + configured() + "]"; }
}
