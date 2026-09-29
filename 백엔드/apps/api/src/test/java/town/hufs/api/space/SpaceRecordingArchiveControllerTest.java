package town.hufs.api.space;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.sun.net.httpserver.HttpServer;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.web.servlet.mvc.method.annotation.StreamingResponseBody;
import town.hufs.auth.TownPrincipal;

import java.io.ByteArrayOutputStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

class SpaceRecordingArchiveControllerTest {
    private static final String SPACE = "00000000-0000-4000-8000-000000000001";
    private static final String OTHER_SPACE = "00000000-0000-4000-8000-000000000002";
    private static final String RECORDING = "10000000-0000-4000-8000-000000000001";
    private static final String TRACK = "20000000-0000-4000-8000-000000000001";
    private static final String USER = "30000000-0000-4000-8000-000000000001";
    private static final String REQUESTER = "30000000-0000-4000-8000-000000000002";
    private static final String OTHER_USER = "30000000-0000-4000-8000-000000000009";
    private static final String MEDIA_TOKEN = "media-test-token-that-is-long-enough-000000000000";

    private HttpServer server;
    private ExecutorService executor;
    private Spaces spaces;
    private SpaceRecordingArchiveController controller;
    private final List<String> requests = new CopyOnWriteArrayList<>();
    private final AtomicBoolean wrongSpace = new AtomicBoolean();

    @BeforeEach
    void startMediaStub() throws Exception {
        server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        executor = Executors.newCachedThreadPool();
        server.setExecutor(executor);
        server.createContext("/", exchange -> {
            String path = exchange.getRequestURI().getPath();
            String range = exchange.getRequestHeaders().getFirst(HttpHeaders.RANGE);
            requests.add(exchange.getRequestMethod() + " " + path + " " + exchange.getRequestHeaders().getFirst(HttpHeaders.AUTHORIZATION)
                + " " + (range == null ? "" : range));
            if (path.equals("/v1/recording/list-space")) {
                respond(exchange, 200, listBody());
            } else if (path.equals("/v1/recording/metadata")) {
                respond(exchange, 200, recordingBody(wrongSpace.get() ? OTHER_SPACE : SPACE));
            } else if (path.equals("/v1/recording/delete-space")) {
                respond(exchange, 200, "{\"recordingId\":\"" + RECORDING + "\",\"deleted\":true}");
            } else if (path.equals("/v1/recording/transcript/" + RECORDING)) {
                respond(exchange, 200, "{\"recordingId\":\"" + RECORDING + "\",\"generatedAt\":12,\"notice\":\"AI generated\",\"segments\":[{\"startMs\":0,\"endMs\":500,\"speakerName\":\"Test\",\"text\":\"Hello\"}]}");
            } else if (path.equals("/v1/recording/file/" + RECORDING + "/" + TRACK)) {
                byte[] content = "webm-fragment".getBytes(StandardCharsets.UTF_8);
                exchange.getResponseHeaders().set("Content-Type", "application/octet-stream");
                exchange.getResponseHeaders().set("Content-Range", "bytes 0-12/13");
                exchange.getResponseHeaders().set("Content-Length", Integer.toString(content.length));
                exchange.sendResponseHeaders(206, content.length);
                exchange.getResponseBody().write(content);
                exchange.close();
            } else {
                respond(exchange, 404, "{}");
            }
        });
        server.start();
        spaces = mock(Spaces.class);
        when(spaces.detail(SPACE, USER)).thenAnswer(invocation -> space("MEMBER"));
        when(spaces.detail(SPACE, REQUESTER)).thenAnswer(invocation -> space("OWNER"));
        when(spaces.detail(SPACE, OTHER_USER)).thenAnswer(invocation -> space("MEMBER"));
        controller = new SpaceRecordingArchiveController(spaces, new ObjectMapper(),
            "http://127.0.0.1:" + server.getAddress().getPort(), MEDIA_TOKEN);
    }

    @AfterEach
    void stopMediaStub() {
        controller.close();
        server.stop(0);
        executor.shutdownNow();
    }

    @Test
    void listsOnlyRecordingsTheMemberParticipatedInAndHidesAccountIds() {
        var result = controller.list(SPACE, principal(USER));

        assertThat(result.recordings()).hasSize(1);
        assertThat(result.recordings().getFirst().recordingId()).isEqualTo(RECORDING);
        assertThat(result.recordings().getFirst().canDelete()).isFalse();
        assertThat(result.usedBytes()).isEqualTo(13);
        assertThat(result.spaceUsedBytes()).isNull();
        assertThat(result.spaceQuotaBytes()).isNull();
        assertThat(result.transcriptionAvailable()).isTrue();
        assertThat(result.toString()).doesNotContain(USER, REQUESTER);
        assertThat(requests).singleElement().asString().contains("POST /v1/recording/list-space Bearer " + MEDIA_TOKEN);
    }

    @Test
    void managerCanSeeSpaceUsageAndQuota() {
        var result = controller.list(SPACE, principal(REQUESTER));

        assertThat(result.usedBytes()).isEqualTo(469);
        assertThat(result.spaceUsedBytes()).isEqualTo(456);
        assertThat(result.spaceQuotaBytes()).isEqualTo(1_000_000L);
    }

    @Test
    void participantCannotDeleteAnotherParticipantsRecording() {
        assertThatThrownBy(() -> controller.delete(SPACE, RECORDING, principal(USER)))
            .isInstanceOfSatisfying(SpaceFailure.class, failure -> {
                assertThat(failure.status).isEqualTo(403);
                assertThat(failure.code).isEqualTo("RECORDING_DELETE_FORBIDDEN");
            });

        assertThat(requests).noneMatch(value -> value.contains("/v1/recording/delete-space"));
    }

    @Test
    void managerCanDeleteAndTheSpaceIdIsPassedToMedia() {
        var result = controller.delete(SPACE, RECORDING, principal(REQUESTER));

        assertThat(result.deleted()).isTrue();
        assertThat(requests).anyMatch(value -> value.contains("POST /v1/recording/delete-space Bearer " + MEDIA_TOKEN));
    }

    @Test
    void playbackProxiesAValidatedSingleRangeWithoutExposingMediaHeaders() throws Exception {
        var response = controller.content(SPACE, RECORDING, TRACK, false, "bytes=0-12", principal(USER));
        var bytes = new ByteArrayOutputStream();
        ((StreamingResponseBody) response.getBody()).writeTo(bytes);

        assertThat(response.getStatusCode()).isEqualTo(HttpStatus.PARTIAL_CONTENT);
        assertThat(response.getHeaders().getContentType().toString()).isEqualTo("video/webm");
        assertThat(response.getHeaders().getFirst(HttpHeaders.CONTENT_RANGE)).isEqualTo("bytes 0-12/13");
        assertThat(response.getHeaders().getFirst(HttpHeaders.CONTENT_DISPOSITION)).contains("microphone-").contains(".webm");
        assertThat(response.getHeaders().getFirst(HttpHeaders.CACHE_CONTROL)).contains("no-store");
        assertThat(bytes.toString(StandardCharsets.UTF_8)).isEqualTo("webm-fragment");
        assertThat(requests).anyMatch(value -> value.endsWith("bytes=0-12"));
    }

    @Test
    void participantCanViewTranscriptButOtherMembersCannot() {
        var response = controller.transcript(SPACE, RECORDING, principal(USER));
        assertThat(response.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(response.getHeaders().getCacheControl()).contains("no-store");
        assertThat(response.getBody().path("segments").get(0).path("text").asText()).isEqualTo("Hello");
        assertThat(requests).anyMatch(value -> value.contains("GET /v1/recording/transcript/" + RECORDING + " Bearer " + MEDIA_TOKEN));

        assertThatThrownBy(() -> controller.transcript(SPACE, RECORDING, principal(OTHER_USER)))
            .isInstanceOfSatisfying(SpaceFailure.class, failure -> assertThat(failure.status).isEqualTo(403));
        assertThat(requests.stream().filter(value -> value.contains("GET /v1/recording/transcript/")).count()).isEqualTo(1);
    }

    @Test
    void rejectsCrossSpaceMetadataAndMalformedRangesBeforeOpeningAFile() {
        wrongSpace.set(true);
        assertThatThrownBy(() -> controller.content(SPACE, RECORDING, TRACK, false, "bytes=0-12", principal(USER)))
            .isInstanceOf(SpaceFailure.class);
        assertThat(requests).noneMatch(value -> value.contains("/v1/recording/file/"));

        wrongSpace.set(false);
        assertThatThrownBy(() -> controller.content(SPACE, RECORDING, TRACK, false, "bytes=0-1,3-4", principal(USER)))
            .isInstanceOfSatisfying(SpaceFailure.class, failure -> assertThat(failure.status).isEqualTo(400));
        assertThat(requests.stream().filter(value -> value.contains("/v1/recording/metadata")).count()).isEqualTo(1);
    }

    private static Spaces.Space space(String role) {
        return new Spaces.Space(SPACE, "Test", "", "PRIVATE", 100, "OFFICE", role, false, false, "", false, List.of(), false);
    }

    private static TownPrincipal principal(String userId) {
        return new TownPrincipal(userId, "Test", 0);
    }

    private static String listBody() {
        return "{\"usedBytes\":456,\"quotaBytes\":1000000,\"transcriptionAvailable\":true,\"recordings\":[" + recordingBody(SPACE) + ","
            + "{\"recordingId\":\"10000000-0000-4000-8000-000000000002\",\"spaceId\":\"" + SPACE
            + "\",\"mapId\":\"40000000-0000-4000-8000-000000000001\",\"mapRevision\":\"50000000-0000-4000-8000-000000000001\","
            + "\"zoneId\":\"meeting\",\"requestedByUserId\":\"" + REQUESTER + "\",\"participants\":[\""
            + "30000000-0000-4000-8000-000000000003\"],\"startedAt\":1,\"endedAt\":2,\"retentionExpiresAt\":3,"
            + "\"sources\":[\"MICROPHONE\"],\"transcriptionStatus\":\"NOT_REQUESTED\",\"tracks\":[{\"trackId\":\"" + TRACK + "\",\"source\":\"MICROPHONE\",\"bytes\":456}],\"bytes\":456}] }";
    }

    private static String recordingBody(String spaceId) {
        return "{\"recordingId\":\"" + RECORDING + "\",\"spaceId\":\"" + spaceId
            + "\",\"mapId\":\"40000000-0000-4000-8000-000000000001\",\"mapRevision\":\"50000000-0000-4000-8000-000000000001\","
            + "\"zoneId\":\"meeting\",\"requestedByUserId\":\"" + REQUESTER + "\",\"participants\":[\"" + USER
            + "\",\"" + REQUESTER + "\"],\"startedAt\":10,\"endedAt\":20,\"retentionExpiresAt\":30,"
            + "\"sources\":[\"MICROPHONE\"],\"transcriptionStatus\":\"READY\",\"tracks\":[{\"trackId\":\"" + TRACK + "\",\"source\":\"MICROPHONE\",\"bytes\":13}],\"bytes\":13}";
    }

    private static void respond(com.sun.net.httpserver.HttpExchange exchange, int status, String content) throws java.io.IOException {
        byte[] bytes = content.getBytes(StandardCharsets.UTF_8);
        exchange.getResponseHeaders().set("Content-Type", "application/json");
        exchange.sendResponseHeaders(status, bytes.length);
        exchange.getResponseBody().write(bytes);
        exchange.close();
    }
}
