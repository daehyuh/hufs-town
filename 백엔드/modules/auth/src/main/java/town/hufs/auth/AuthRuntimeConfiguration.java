package town.hufs.auth;

import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.core.env.Environment;
import org.springframework.session.data.redis.config.annotation.web.http.EnableRedisIndexedHttpSession;
import org.springframework.session.web.http.CookieSerializer;
import org.springframework.session.web.http.DefaultCookieSerializer;

@Configuration(proxyBeanMethods = false)
public class AuthRuntimeConfiguration {
    @Bean AuthRuntime authRuntime(Environment env) { return new AuthRuntime(env); }

    @Configuration(proxyBeanMethods = false)
    @ConditionalOnProperty(name = "town.auth.mode", havingValue = "sso", matchIfMissing = true)
    @EnableRedisIndexedHttpSession(redisNamespace = "hufs-town:session", maxInactiveIntervalInSeconds = 28800)
    static class Sessions {
        @Bean JoinTickets joinTickets(org.springframework.data.redis.core.StringRedisTemplate redis) { return new JoinTickets(redis); }
        @Bean PublishedMaps publishedMaps(org.springframework.data.redis.core.StringRedisTemplate redis) { return new PublishedMaps(redis); }
        @Bean CookieSerializer cookieSerializer(Environment env) {
            var cookie = new DefaultCookieSerializer();
            cookie.setCookieName("HUFS_TOWN_SESSION");
            cookie.setCookiePath("/");
            cookie.setUseHttpOnlyCookie(true);
            cookie.setSameSite("Lax");
            cookie.setUseSecureCookie(env.getProperty("town.auth.cookie-secure", Boolean.class, true));
            return cookie;
        }
    }
}
