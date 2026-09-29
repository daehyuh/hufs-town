package town.hufs.world;

import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.context.annotation.Configuration;
import org.springframework.web.socket.config.annotation.EnableWebSocket;
import org.springframework.web.socket.config.annotation.WebSocketConfigurer;
import org.springframework.web.socket.config.annotation.WebSocketHandlerRegistry;

@Configuration
@EnableWebSocket
class WorldConfiguration implements WebSocketConfigurer {
    private final WorldHandler handler;
    private final WorldAuthentication auth;
    private final town.hufs.auth.AuthRuntime runtime;
    WorldConfiguration(WorldHandler handler, WorldAuthentication auth, town.hufs.auth.AuthRuntime runtime) { this.handler = handler; this.auth = auth; this.runtime = runtime; }
    @Override public void registerWebSocketHandlers(WebSocketHandlerRegistry registry) {
        registry.addHandler(handler, "/world/socket").addInterceptors(auth)
            .setAllowedOrigins(runtime.allowedOrigins().toArray(String[]::new));
    }
}
