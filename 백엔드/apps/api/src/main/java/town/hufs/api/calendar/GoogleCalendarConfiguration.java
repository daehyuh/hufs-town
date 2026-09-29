package town.hufs.api.calendar;

import org.springframework.boot.context.properties.EnableConfigurationProperties;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.http.client.JdkClientHttpRequestFactory;
import org.springframework.web.client.RestClient;

import java.net.http.HttpClient;
import java.time.Duration;

@Configuration(proxyBeanMethods = false)
@EnableConfigurationProperties(GoogleCalendarSettings.class)
class GoogleCalendarConfiguration {
    @Bean
    RestClient googleCalendarRestClient() {
        var client = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(3))
            .followRedirects(HttpClient.Redirect.NEVER).build();
        var factory = new JdkClientHttpRequestFactory(client);
        factory.setReadTimeout(Duration.ofSeconds(8));
        return RestClient.builder().requestFactory(factory).defaultHeader("User-Agent", "HUFS-Town/0.1")
            .build();
    }
}
