package town.hufs.api.space;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.Arrays;
import java.util.Comparator;
import java.util.List;

/** Stable space-to-world routing. Every participant in a space receives the same public WebSocket endpoint. */
@Component
final class WorldNodeRouter {
    private final List<String> endpoints;

    WorldNodeRouter(@Value("${town.world.endpoints:}") String configuredEndpoints) {
        endpoints = Arrays.stream(configuredEndpoints.split(","))
            .map(String::strip)
            .filter(endpoint -> !endpoint.isEmpty())
            .peek(WorldNodeRouter::validate)
            .sorted(Comparator.naturalOrder())
            .toList();
    }

    String endpointFor(String spaceId) {
        if (endpoints.isEmpty()) return "";
        String selected = endpoints.getFirst();
        byte[] best = null;
        for (String endpoint : endpoints) {
            byte[] score = digest(spaceId + "|" + endpoint);
            if (best == null || Arrays.compareUnsigned(score, best) > 0) {
                best = score;
                selected = endpoint;
            }
        }
        return selected;
    }

    private static void validate(String endpoint) {
        URI uri;
        try { uri = URI.create(endpoint); }
        catch (IllegalArgumentException invalid) { throw new IllegalArgumentException("Invalid town.world.endpoints URL", invalid); }
        if (!("ws".equalsIgnoreCase(uri.getScheme()) || "wss".equalsIgnoreCase(uri.getScheme()))
            || uri.getHost() == null || uri.getUserInfo() != null || uri.getQuery() != null || uri.getFragment() != null
            || !"/world/socket".equals(uri.getPath()))
            throw new IllegalArgumentException("World node endpoints must be ws(s) URLs ending in /world/socket");
    }

    private static byte[] digest(String value) {
        try { return MessageDigest.getInstance("SHA-256").digest(value.getBytes(StandardCharsets.UTF_8)); }
        catch (NoSuchAlgorithmException impossible) { throw new IllegalStateException(impossible); }
    }
}
