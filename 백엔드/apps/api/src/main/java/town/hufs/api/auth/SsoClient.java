package town.hufs.api.auth;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonProperty;
import org.springframework.stereotype.Component;
import org.springframework.http.*;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.web.client.*;
import java.util.UUID;

@Component
public class SsoClient {
    private final SsoSettings settings;
    private final RestClient client;
    public SsoClient(SsoSettings settings, @Qualifier("ssoRestClient") RestClient client) {
        this.settings = settings;
        this.client = client;
    }
    public UserInfo exchange(String code) {
        if (!settings.configured()) throw new AuthFailure(HttpStatus.SERVICE_UNAVAILABLE, "SSO_NOT_CONFIGURED", "SSO 관리자 연결 설정을 기다리고 있어요.");
        try {
            Envelope response = client.post().uri(settings.userinfoUrl()).contentType(MediaType.APPLICATION_JSON)
                .body(new Exchange(settings.clientId(), settings.clientSecret(), code)).retrieve().body(Envelope.class);
            if (response == null || response.errorCode() != null || response.data() == null) throw AuthFailure.login();
            var user = response.data();
            if (user.uuid() == null || !UUID.fromString(user.uuid()).toString().equalsIgnoreCase(user.uuid())) throw AuthFailure.login();
            return user;
        } catch (RestClientResponseException ex) {
            if (ex.getStatusCode().value() == 401)
                throw new AuthFailure(HttpStatus.SERVICE_UNAVAILABLE, "SSO_CREDENTIALS_REJECTED", "SSO 연결 설정을 확인해야 해요. 운영자에게 문의해 주세요.");
            if (ex.getStatusCode().is4xxClientError() && ex.getStatusCode().value() != 429) throw AuthFailure.login();
            throw upstream();
        } catch (RestClientException ex) { throw upstream(); }
        catch (IllegalArgumentException ex) { throw AuthFailure.login(); }
    }
    private AuthFailure upstream() { return new AuthFailure(HttpStatus.BAD_GATEWAY, "SSO_UNAVAILABLE", "HUFS 인증 서버에 연결하지 못했어요. 잠시 후 다시 로그인해 주세요."); }
    record Exchange(@JsonProperty("client_id") String clientId, @JsonProperty("client_secret") String clientSecret, String code) {
        @Override public String toString() { return "SsoExchange[redacted]"; }
    }
    @JsonIgnoreProperties(ignoreUnknown = true)
    record Envelope(UserInfo data, @JsonProperty("error_code") String errorCode) {}
    @JsonIgnoreProperties(ignoreUnknown = true)
    public record UserInfo(String uuid, String name, String status, String email) {
        @Override public String toString() { return "SsoUserInfo[redacted]"; }
    }
}
