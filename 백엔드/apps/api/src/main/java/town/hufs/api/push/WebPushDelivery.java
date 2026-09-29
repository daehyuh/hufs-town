package town.hufs.api.push;

import com.interaso.webpush.VapidKeys;
import com.interaso.webpush.WebPush;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.Base64;

@Component
public class WebPushDelivery {
    public record DeliveryResponse(int statusCode) {}

    private final WebPush service;
    private final String applicationServerKey;
    private final HttpClient http = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(3)).build();

    WebPushDelivery(
        @Value("${town.web-push.public-key:}") String publicKey,
        @Value("${town.web-push.private-key:}") String privateKey,
        @Value("${town.web-push.subject:}") String subject
    ) {
        if (publicKey.isBlank() || privateKey.isBlank() || subject.isBlank()) {
            service = null;
            applicationServerKey = "";
            return;
        }
        VapidKeys keys = VapidKeys.create(publicKey, privateKey);
        service = new WebPush(subject, keys);
        applicationServerKey = Base64.getUrlEncoder().withoutPadding().encodeToString(keys.getApplicationServerKey());
    }

    public boolean enabled() { return service != null; }
    public String applicationServerKey() { return applicationServerKey; }

    public DeliveryResponse send(String endpoint, String p256dh, String auth, String payload) throws Exception {
        if (service == null) throw new IllegalStateException("Web Push is not configured");
        byte[] body = service.getBody(payload.getBytes(StandardCharsets.UTF_8),
            Base64.getUrlDecoder().decode(p256dh), Base64.getUrlDecoder().decode(auth));
        HttpRequest.Builder request = HttpRequest.newBuilder(URI.create(endpoint))
            .timeout(Duration.ofSeconds(8)).POST(HttpRequest.BodyPublishers.ofByteArray(body));
        service.getHeaders(endpoint, 300, null, null).forEach(request::header);
        HttpResponse<Void> response = http.send(request.build(), HttpResponse.BodyHandlers.discarding());
        return new DeliveryResponse(response.statusCode());
    }
}
