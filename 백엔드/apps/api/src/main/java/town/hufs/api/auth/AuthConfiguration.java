package town.hufs.api.auth;

import org.springframework.boot.context.properties.EnableConfigurationProperties;
import org.springframework.context.annotation.*;
import org.springframework.http.client.JdkClientHttpRequestFactory;
import org.springframework.http.HttpMethod;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.web.SecurityFilterChain;
import org.springframework.security.web.context.HttpSessionSecurityContextRepository;
import org.springframework.security.web.header.writers.ReferrerPolicyHeaderWriter.ReferrerPolicy;
import org.springframework.web.client.RestClient;
import town.hufs.auth.AuthRuntime;
import java.net.http.HttpClient;
import java.time.Duration;

@Configuration(proxyBeanMethods = false)
@EnableConfigurationProperties(SsoSettings.class)
class AuthConfiguration {
    @Bean HttpSessionSecurityContextRepository securityContexts() { return new HttpSessionSecurityContextRepository(); }
    @Bean SecurityFilterChain security(HttpSecurity http, HttpSessionSecurityContextRepository contexts) throws Exception {
        return http
            .securityContext(c -> c.securityContextRepository(contexts))
            .authorizeHttpRequests(c -> c
                .requestMatchers("/api/v1/bootstrap", "/api/v1/auth/config", "/api/v1/auth/csrf", "/api/v1/auth/start", "/api/v1/auth/exchange", "/actuator/health", "/actuator/prometheus", "/error").permitAll()
                .requestMatchers(HttpMethod.GET, "/api/v1/guest/spaces/*").permitAll()
                .requestMatchers(HttpMethod.POST, "/api/v1/guest/spaces/*/admission").permitAll()
                .requestMatchers(HttpMethod.DELETE, "/api/v1/guest/session").permitAll()
                .anyRequest().authenticated())
            .requestCache(c -> c.disable())
            .formLogin(c -> c.disable()).httpBasic(c -> c.disable()).logout(c -> c.disable())
            .headers(c -> c.referrerPolicy(p -> p.policy(ReferrerPolicy.NO_REFERRER)))
            .exceptionHandling(c -> c
                .authenticationEntryPoint((req, res, ex) -> {
                    res.setStatus(401); res.setContentType("application/json;charset=UTF-8");
                    res.getWriter().write("{\"code\":\"AUTH_REQUIRED\",\"message\":\"로그인이 필요해요. 다시 로그인해 주세요.\"}");
                })
                .accessDeniedHandler((req, res, ex) -> {
                    res.setStatus(403); res.setContentType("application/json;charset=UTF-8");
                    res.getWriter().write("{\"code\":\"REQUEST_REJECTED\",\"message\":\"요청을 확인할 수 없어요. 새로고침 후 다시 시도해 주세요.\"}");
                }))
            .build();
    }
    @Bean RestClient ssoRestClient(SsoSettings settings, AuthRuntime runtime) {
        settings.validate(runtime.publicOrigin());
        var client = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(3)).followRedirects(HttpClient.Redirect.NEVER).build();
        var factory = new JdkClientHttpRequestFactory(client);
        factory.setReadTimeout(Duration.ofSeconds(8));
        return RestClient.builder().requestFactory(factory).defaultHeader("User-Agent", "HUFS-Town/0.1")
            .defaultHeader("Accept", "application/json").build();
    }
}
