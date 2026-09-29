package town.hufs.api.auth;

import org.junit.jupiter.api.*;
import org.springframework.http.*;
import org.springframework.test.web.client.MockRestServiceServer;
import org.springframework.web.client.RestClient;
import static org.assertj.core.api.Assertions.*;
import static org.springframework.test.web.client.match.MockRestRequestMatchers.*;
import static org.springframework.test.web.client.response.MockRestResponseCreators.*;

class SsoClientTest {
    final SsoSettings settings = new SsoSettings("https://api.gdghufs.com/v1/sso/authorize", "https://api.gdghufs.com/v1/sso/userinfo", "test-town", "test-secret", "http://localhost:5173/auth/callback");
    final RestClient.Builder builder = RestClient.builder();
    final MockRestServiceServer server = MockRestServiceServer.bindTo(builder).build();
    final SsoClient client = new SsoClient(settings, builder.build());

    @Test void usesReferenceSnakeCaseWireContractAndIgnoresUnneededPersonalData() {
        server.expect(requestTo(settings.userinfoUrl())).andExpect(method(HttpMethod.POST))
            .andExpect(content().json("{\"client_id\":\"test-town\",\"client_secret\":\"test-secret\",\"code\":\"one-time-test-code\"}"))
            .andRespond(withSuccess("{\"data\":{\"uuid\":\"11111111-1111-4111-8111-111111111111\",\"name\":\"테스터\",\"status\":\"ATTENDING\",\"institutional_id\":\"not-stored\",\"email\":\"test@example.invalid\"},\"error_code\":null}", MediaType.APPLICATION_JSON));
        assertThat(client.exchange("one-time-test-code").name()).isEqualTo("테스터");
        server.verify();
    }
    @Test void rejectsProviderErrorEnvelopeWithoutReflectingProviderMessage() {
        server.expect(requestTo(settings.userinfoUrl())).andRespond(withSuccess("{\"data\":null,\"error_code\":\"EXPIRED\",\"message\":\"private upstream detail\"}", MediaType.APPLICATION_JSON));
        assertThatThrownBy(() -> client.exchange("expired")).isInstanceOf(AuthFailure.class).hasMessageNotContaining("private upstream");
    }
    @Test void translatesUnavailableProvider() {
        server.expect(requestTo(settings.userinfoUrl())).andRespond(withServerError());
        assertThatThrownBy(() -> client.exchange("temporary")).isInstanceOfSatisfying(AuthFailure.class, e -> assertThat(e.status).isEqualTo(HttpStatus.BAD_GATEWAY));
    }
    @Test void distinguishesClientCredentialFailureFromExpiredCode() {
        server.expect(requestTo(settings.userinfoUrl())).andRespond(withStatus(HttpStatus.UNAUTHORIZED)
            .body("{\"error_code\":\"AUTH_001\",\"message\":\"Invalid client credentials\"}").contentType(MediaType.APPLICATION_JSON));
        assertThatThrownBy(() -> client.exchange("code")).isInstanceOfSatisfying(AuthFailure.class, e -> {
            assertThat(e.status).isEqualTo(HttpStatus.SERVICE_UNAVAILABLE);
            assertThat(e.code).isEqualTo("SSO_CREDENTIALS_REJECTED");
        });
    }
    @Test void rejectsMalformedSubjectAndRecognizesEveryHufsAccountType() {
        server.expect(requestTo(settings.userinfoUrl())).andRespond(withSuccess("{\"data\":{\"uuid\":\"invalid\",\"status\":\"ATTENDING\"}}", MediaType.APPLICATION_JSON));
        assertThatThrownBy(() -> client.exchange("invalid")).isInstanceOf(AuthFailure.class);
        assertThat(TownAccounts.allowedStatus("ENROLLED")).isEqualTo("ENROLLED");
        assertThat(TownAccounts.allowedStatus("LEAVE_OF_ABSENCE")).isEqualTo("LEAVE_OF_ABSENCE");
        assertThat(TownAccounts.allowedStatus("GRADUATED")).isEqualTo("GRADUATED");
        assertThat(TownAccounts.allowedStatus("FACULTY")).isEqualTo("FACULTY");
        assertThat(TownAccounts.allowedStatus("STAFF")).isEqualTo("STAFF");
        assertThat(TownAccounts.allowedStatus("COMMON_ACCOUNT")).isEqualTo("COMMON_ACCOUNT");
        assertThat(TownAccounts.allowedStatus("UNKNOWN")).isEqualTo("UNKNOWN");
        assertThat(TownAccounts.allowedStatus("COMMON_ID")).isEqualTo("COMMON_ACCOUNT");
        assertThat(TownAccounts.allowedStatus("재학")).isEqualTo("ENROLLED");
        assertThat(TownAccounts.allowedStatus("new SSO category")).isEqualTo("UNKNOWN");
        assertThatThrownBy(() -> TownAccounts.allowedStatus(" ")).isInstanceOf(AuthFailure.class);
    }
    @Test void validatesConfiguredEndpointsAndRedactsSettings() {
        settings.validate("http://localhost:5173");
        assertThat(settings.toString()).doesNotContain("test-secret");
        assertThatThrownBy(() -> settings.validate("https://different.example.invalid")).isInstanceOf(IllegalStateException.class);
    }
}
