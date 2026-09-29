package town.hufs.api.auth;

import com.fasterxml.jackson.databind.*;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import org.junit.jupiter.api.*;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.boot.test.context.*;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.boot.test.web.server.LocalManagementPort;
import org.springframework.context.annotation.*;
import org.springframework.http.MediaType;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.context.bean.override.mockito.MockitoSpyBean;
import org.springframework.test.web.client.MockRestServiceServer;
import org.springframework.web.client.RestClient;
import org.testcontainers.containers.GenericContainer;
import org.testcontainers.containers.MariaDBContainer;
import org.testcontainers.junit.jupiter.*;
import town.hufs.api.ApiApplication;
import town.hufs.api.push.WebPushDelivery;
import town.hufs.api.push.WebPushOutboxDispatcher;
import town.hufs.api.space.EventResultsRetention;
import town.hufs.api.space.SpaceAssets;
import town.hufs.protocol.MapLoader;
import java.net.*;
import java.net.http.*;
import java.sql.Timestamp;
import java.time.Instant;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.function.Predicate;
import static org.assertj.core.api.Assertions.*;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.doAnswer;
import static org.springframework.test.web.client.match.MockRestRequestMatchers.*;
import static org.springframework.test.web.client.response.MockRestResponseCreators.*;

/** Real API + real World + ephemeral MariaDB/Redis; only the external IdP transport is mocked. */
@Tag("infrastructure")
@Testcontainers
@SpringBootTest(classes = {ApiApplication.class, SsoIntegrationTest.TransportConfig.class}, webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT,
    properties = {"management.server.port=0", "town.web-push.poll-ms=3600000"})
class SsoIntegrationTest {
    @Container static MariaDBContainer<?> database = new MariaDBContainer<>("mariadb:11.4.10");
    @Container static GenericContainer<?> redis = new GenericContainer<>("redis:7.4.8-alpine").withExposedPorts(6379);
    static final String ORIGIN = "http://localhost:5173";
    static final String TEST_WORLD_ENDPOINTS = "wss://world-a.test/world/socket,wss://world-b.test/world/socket";
    static final String CAMPUS = "00000000-0000-4000-8000-000000000001";
    static final String RETENTION_ADMIN_ID = "88888888-8888-4888-8888-888888888888";
    static final String RETENTION_ADMIN_SUBJECT = "99999999-9999-4999-8999-999999999999";
    static final String REPORT_ADMIN_ID = "77777777-7777-4777-8777-777777777777";
    static final String REPORT_ADMIN_SUBJECT = "66666666-6666-4666-8666-666666666666";
    static final String ARCHIVE_RECORDING_ID = "10000000-0000-4000-8000-000000000001";
    static final String ARCHIVE_TRACK_ID = "20000000-0000-4000-8000-000000000001";
    static final String ARCHIVE_MEDIA_TOKEN = "hufs-town-integration-media-token-0123456789";
    static final java.nio.file.Path assetRoot = java.nio.file.Path.of(System.getProperty("java.io.tmpdir"), "hufs-town-assets-it-" + UUID.randomUUID());
    static RecordingArchiveControl recordingArchiveControl;
    @LocalServerPort int port;
    @LocalManagementPort int managementPort;
    @Autowired Transport transport;
    @Autowired EventResultsRetention eventResultsRetention;
    @MockitoSpyBean JdbcTemplate db;
    @MockitoSpyBean WebPushDelivery webPushDelivery;
    @Autowired WebPushOutboxDispatcher webPushOutboxDispatcher;
    @Autowired SpaceAssets spaceAssets;
    @Autowired org.springframework.session.data.redis.RedisIndexedSessionRepository sessions;
    @Autowired org.springframework.data.redis.core.StringRedisTemplate strings;
    @MockitoSpyBean town.hufs.auth.PublishedMaps publishedMaps;
    final ObjectMapper json = new ObjectMapper();
    static Process worldProcess;
    static int worldPort;
    static java.nio.file.Path worldLog;

    @Test void exposesPrometheusMetricsWithoutOpeningTheActuatorInfoEndpoint() throws Exception {
        var metrics = HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + managementPort + "/actuator/prometheus"))
            .GET().build();
        var response = HttpClient.newHttpClient().send(metrics, HttpResponse.BodyHandlers.ofString());

        assertThat(response.statusCode()).isEqualTo(200);
        assertThat(response.body()).contains("jvm_memory_used_bytes");

        var applicationPort = HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + port + "/actuator/prometheus"))
            .GET().build();
        assertThat(HttpClient.newHttpClient().send(applicationPort, HttpResponse.BodyHandlers.ofString()).statusCode()).isEqualTo(404);

        var info = HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + managementPort + "/actuator/info"))
            .GET().build();
        assertThat(HttpClient.newHttpClient().send(info, HttpResponse.BodyHandlers.ofString()).statusCode()).isEqualTo(401);
    }

    @Test void recordingArchiveUsesMemberParticipantAndManagerAccessAndStreamsThroughTheSessionApi() throws Exception {
        Browser owner = signedIn();
        Browser participant = signedIn();
        Browser outsider = signedIn();
        String spaceId = createSpace(owner, "녹화 보관 권한", "PUBLIC", 10).path("id").asText();
        String otherSpaceId = createSpace(owner, "다른 녹화 공간", "PRIVATE", 10).path("id").asText();
        String ownerId = ok(owner.get("me")).path("userId").asText();
        String participantId = ok(participant.get("me")).path("userId").asText();
        db.update("INSERT INTO space_member(space_id,user_id,role,manager) VALUES (?,?,'MEMBER',FALSE)", spaceId, participantId);
        recordingArchiveControl.configure(spaceId, ownerId, List.of(ownerId, participantId));

        String root = "/spaces/" + spaceId + "/recordings";
        var participantList = participant.get(root);
        assertThat(participantList.statusCode()).isEqualTo(200);
        JsonNode archive = json.readTree(participantList.body());
        assertThat(archive.path("recordings")).hasSize(1);
        assertThat(archive.path("recordings").get(0).path("canDelete").asBoolean()).isFalse();
        assertThat(archive.path("spaceUsedBytes").isNull()).isTrue();
        assertThat(archive.path("spaceQuotaBytes").isNull()).isTrue();
        assertThat(archive.toString()).doesNotContain("requestedByUserId", "participants", "sha256", "fileKey");
        assertThat(outsider.get(root).statusCode()).isEqualTo(403);

        JsonNode managerArchive = json.readTree(owner.get(root).body());
        assertThat(managerArchive.path("spaceUsedBytes").asLong()).isEqualTo(13);
        assertThat(managerArchive.path("spaceQuotaBytes").asLong()).isEqualTo(1_073_741_824L);

        var deniedDelete = participant.delete(root + "/" + ARCHIVE_RECORDING_ID, Map.of());
        assertThat(deniedDelete.statusCode()).isEqualTo(403);
        assertThat(recordingArchiveControl.deleteCalls()).isZero();

        String contentPath = root + "/" + ARCHIVE_RECORDING_ID + "/tracks/" + ARCHIVE_TRACK_ID + "/content";
        var range = participant.client.send(HttpRequest.newBuilder(participant.uri(contentPath))
                .header("Range", "bytes=0-3").GET().build(), HttpResponse.BodyHandlers.ofByteArray());
        assertThat(range.statusCode()).isEqualTo(206);
        assertThat(range.headers().firstValue("Content-Range")).contains("bytes 0-3/13");
        assertThat(new String(range.body(), java.nio.charset.StandardCharsets.UTF_8)).isEqualTo("webm");

        assertThat(owner.getBytes("/spaces/" + otherSpaceId + "/recordings/" + ARCHIVE_RECORDING_ID
            + "/tracks/" + ARCHIVE_TRACK_ID + "/content").statusCode()).isEqualTo(404);
        assertThat(recordingArchiveControl.fileCalls()).isEqualTo(1);

        var ownerDelete = owner.delete(root + "/" + ARCHIVE_RECORDING_ID, Map.of());
        assertThat(ownerDelete.statusCode()).isEqualTo(200);
        assertThat(json.readTree(ownerDelete.body()).path("deleted").asBoolean()).isTrue();
        assertThat(recordingArchiveControl.deleteCalls()).isEqualTo(1);
    }

    private static RecordingArchiveControl recordingArchiveControl() {
        if (recordingArchiveControl != null) return recordingArchiveControl;
        synchronized (SsoIntegrationTest.class) {
            if (recordingArchiveControl == null) {
                try { recordingArchiveControl = new RecordingArchiveControl(); }
                catch (java.io.IOException failure) { throw new IllegalStateException("Could not start isolated media archive control", failure); }
            }
        }
        return recordingArchiveControl;
    }

    private static final class RecordingArchiveControl implements AutoCloseable {
        private final HttpServer server;
        private final ExecutorService executor = Executors.newCachedThreadPool();
        private final java.util.concurrent.atomic.AtomicReference<String> spaceId = new java.util.concurrent.atomic.AtomicReference<>("");
        private final java.util.concurrent.atomic.AtomicReference<String> requesterId = new java.util.concurrent.atomic.AtomicReference<>("");
        private final java.util.concurrent.atomic.AtomicReference<List<String>> participants = new java.util.concurrent.atomic.AtomicReference<>(List.of());
        private final java.util.concurrent.atomic.AtomicInteger deleteCalls = new java.util.concurrent.atomic.AtomicInteger();
        private final java.util.concurrent.atomic.AtomicInteger fileCalls = new java.util.concurrent.atomic.AtomicInteger();
        private final ObjectMapper mapper = new ObjectMapper();

        RecordingArchiveControl() throws java.io.IOException {
            server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
            server.setExecutor(executor);
            server.createContext("/", exchange -> {
                if (!("Bearer " + ARCHIVE_MEDIA_TOKEN).equals(exchange.getRequestHeaders().getFirst("Authorization"))) {
                    respond(exchange, 401, "{\"code\":\"UNAUTHORIZED\"}");
                    return;
                }
                String route = exchange.getRequestURI().getPath();
                try {
                    switch (route) {
                        case "/v1/recording/list-space" -> {
                            JsonNode request = mapper.readTree(exchange.getRequestBody());
                            spaceId.set(request.path("spaceId").asText());
                            respond(exchange, 200, archiveList());
                        }
                        case "/v1/recording/metadata" -> respond(exchange, 200, archiveMetadata());
                        case "/v1/recording/delete-space" -> {
                            deleteCalls.incrementAndGet();
                            respond(exchange, 200, "{\"recordingId\":\"" + ARCHIVE_RECORDING_ID + "\",\"deleted\":true}");
                        }
                        case "/v1/recording/file/" + ARCHIVE_RECORDING_ID + "/" + ARCHIVE_TRACK_ID -> stream(exchange);
                        default -> respond(exchange, 404, "{\"code\":\"RECORDING_NOT_FOUND\"}");
                    }
                } catch (Exception failure) {
                    exchange.close();
                }
            });
            server.start();
        }

        String endpoint() { return "http://127.0.0.1:" + server.getAddress().getPort(); }
        void configure(String space, String requester, List<String> people) {
            spaceId.set(space);
            requesterId.set(requester);
            participants.set(List.copyOf(people));
            deleteCalls.set(0);
            fileCalls.set(0);
        }
        int deleteCalls() { return deleteCalls.get(); }
        int fileCalls() { return fileCalls.get(); }

        private String archiveList() throws Exception {
            var root = mapper.createObjectNode();
            root.put("usedBytes", 13);
            root.put("quotaBytes", 1_073_741_824L);
            root.putArray("recordings").add(mapper.readTree(archiveMetadata()));
            return mapper.writeValueAsString(root);
        }

        private String archiveMetadata() throws Exception {
            var root = mapper.createObjectNode();
            root.put("recordingId", ARCHIVE_RECORDING_ID);
            root.put("spaceId", spaceId.get());
            root.put("mapId", "40000000-0000-4000-8000-000000000001");
            root.put("mapRevision", "50000000-0000-4000-8000-000000000001");
            root.put("zoneId", "meeting-room-a");
            root.put("requestedByUserId", requesterId.get());
            var people = root.putArray("participants");
            for (String participant : participants.get()) people.add(participant);
            root.put("startedAt", 1000);
            root.put("endedAt", 2000);
            root.put("retentionExpiresAt", 3000);
            root.putArray("sources").add("MICROPHONE");
            var tracks = root.putArray("tracks");
            var track = tracks.addObject();
            track.put("trackId", ARCHIVE_TRACK_ID);
            track.put("source", "MICROPHONE");
            track.put("bytes", 13);
            track.put("sha256", "private-hash-must-not-reach-browser");
            track.put("fileKey", "private/path/must-not-reach-browser");
            root.put("bytes", 13);
            return mapper.writeValueAsString(root);
        }

        private void stream(HttpExchange exchange) throws java.io.IOException {
            fileCalls.incrementAndGet();
            byte[] full = "webm-fragment".getBytes(java.nio.charset.StandardCharsets.UTF_8);
            if ("bytes=0-3".equals(exchange.getRequestHeaders().getFirst("Range"))) {
                byte[] partial = java.util.Arrays.copyOfRange(full, 0, 4);
                exchange.getResponseHeaders().set("Content-Range", "bytes 0-3/13");
                exchange.getResponseHeaders().set("Content-Type", "video/webm");
                exchange.sendResponseHeaders(206, partial.length);
                exchange.getResponseBody().write(partial);
                exchange.close();
                return;
            }
            exchange.getResponseHeaders().set("Content-Type", "video/webm");
            exchange.sendResponseHeaders(200, full.length);
            exchange.getResponseBody().write(full);
            exchange.close();
        }

        @Override public void close() {
            server.stop(0);
            executor.shutdownNow();
        }
    }

    private record AdditionalWorld(Process process, int port, java.nio.file.Path log) implements AutoCloseable {
        @Override public void close() throws Exception {
            process.destroy();
            if (!process.waitFor(5, TimeUnit.SECONDS)) {
                process.destroyForcibly();
                process.waitFor(5, TimeUnit.SECONDS);
            }
        }
    }
    private record DelayedMediaControl(HttpServer server, ExecutorService executor, CountDownLatch revokeEntered,
                                       CountDownLatch releaseRevoke) implements AutoCloseable {
        String endpoint() { return "http://127.0.0.1:" + server.getAddress().getPort(); }
        @Override public void close() {
            releaseRevoke.countDown();server.stop(0);executor.shutdownNow();
        }
    }
    private record RecordingMediaControl(HttpServer server, ExecutorService executor,
                                         BlockingQueue<JsonNode> policies, BlockingQueue<JsonNode> revocations,
                                         AtomicBoolean holdRevocations, CountDownLatch releaseRevocations) implements AutoCloseable {
        String endpoint() { return "http://127.0.0.1:" + server.getAddress().getPort(); }
        void holdRevokes() { holdRevocations.set(true); }
        void releaseRevokes() { holdRevocations.set(false); releaseRevocations.countDown(); }
        JsonNode awaitPolicy(String playerId, java.util.function.Predicate<JsonNode> condition) throws Exception {
            long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(8);
            while (System.nanoTime() < deadline) {
                JsonNode frame = policies.poll(100, TimeUnit.MILLISECONDS);
                if (frame == null) continue;
                for (JsonNode person : frame.path("people"))
                    if (person.path("id").asText().equals(playerId) && condition.test(person)) return person;
            }
            throw new AssertionError("Timed out waiting for SFU policy for player " + playerId);
        }
        JsonNode awaitRevoke(String playerId) throws Exception {
            long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(8);
            var observed = new ArrayList<JsonNode>();
            while (System.nanoTime() < deadline) {
                JsonNode request = revocations.poll(100, TimeUnit.MILLISECONDS);
                if (request == null) continue;
                observed.add(request);
                if (request.path("playerId").asText().equals(playerId)) return request;
            }
            throw new AssertionError("Timed out waiting for SFU revoke for player " + playerId + "; received: " + observed);
        }
        @Override public void close() { releaseRevokes(); server.stop(0); executor.shutdownNow(); }
    }

    @DynamicPropertySource static void properties(DynamicPropertyRegistry registry) {
        registry.add("spring.datasource.url", database::getJdbcUrl);
        registry.add("spring.datasource.username", database::getUsername);
        registry.add("spring.datasource.password", database::getPassword);
        registry.add("spring.data.redis.host", redis::getHost);
        registry.add("spring.data.redis.port", () -> redis.getMappedPort(6379));
        registry.add("town.auth.mode", () -> "sso");
        registry.add("town.storage-mode", () -> "mariadb-redis");
        registry.add("town.auth.cookie-secure", () -> false);
        registry.add("town.auth.sso.client-id", () -> "test-town");
        registry.add("town.auth.sso.client-secret", () -> "test-secret");
        registry.add("town.public-origin", () -> ORIGIN);
        registry.add("town.world.endpoints", () -> TEST_WORLD_ENDPOINTS);
        registry.add("town.moderation.admin-user-ids", () -> RETENTION_ADMIN_ID + "," + REPORT_ADMIN_ID);
        registry.add("town.asset-root", () -> assetRoot.toString());
        registry.add("MEDIA_CONTROL_URL", () -> recordingArchiveControl().endpoint());
        registry.add("MEDIA_CONTROL_TOKEN", () -> ARCHIVE_MEDIA_TOKEN);
    }
    @BeforeAll static void startWorld() throws Exception {
        // Use the actual packaged world classpath, not the API test JVM's richer dependencies.
        try (var reservation = new ServerSocket(0, 1, InetAddress.getByName("127.0.0.1"))) { worldPort = reservation.getLocalPort(); }
        worldLog = java.nio.file.Files.createTempFile("hufs-world-integration-", ".log");
        String javaExecutable = java.nio.file.Path.of(System.getProperty("java.home"), "bin", System.getProperty("os.name").startsWith("Windows") ? "java.exe" : "java").toString();
        worldProcess = new ProcessBuilder(javaExecutable, "-Duser.timezone=UTC", "-jar", System.getProperty("town.worldJar"),
            "--server.port=" + worldPort, "--town.auth.mode=sso", "--town.auth.cookie-secure=false", "--town.public-origin=" + ORIGIN,
            "--spring.datasource.url=" + database.getJdbcUrl(), "--spring.datasource.username=" + database.getUsername(),
            "--spring.datasource.password=" + database.getPassword(),
            "--spring.data.redis.host=" + redis.getHost(), "--spring.data.redis.port=" + redis.getMappedPort(6379))
            .redirectErrorStream(true).redirectOutput(worldLog.toFile()).start();
        HttpClient probe = HttpClient.newBuilder().connectTimeout(java.time.Duration.ofSeconds(1)).build();
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(25);
        while (worldProcess.isAlive() && System.nanoTime() < deadline) {
            try {
                var request = HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + worldPort + "/actuator/health")).timeout(java.time.Duration.ofSeconds(1)).GET().build();
                if (probe.send(request, HttpResponse.BodyHandlers.discarding()).statusCode() == 200) return;
            } catch (java.io.IOException unavailable) { /* Server is still starting. */ }
            Thread.sleep(100);
        }
        stopWorld();
        throw new AssertionError("Packaged world failed to start; log: " + worldLog);
    }
    @AfterAll static void stopWorld() throws Exception {
        if (worldProcess != null) {
            worldProcess.destroy();
            if (!worldProcess.waitFor(5, TimeUnit.SECONDS)) { worldProcess.destroyForcibly(); worldProcess.waitFor(5, TimeUnit.SECONDS); }
        }
        if (java.nio.file.Files.exists(assetRoot))
            try (var files = java.nio.file.Files.walk(assetRoot)) {
                for (var path : files.sorted(Comparator.reverseOrder()).toList()) java.nio.file.Files.deleteIfExists(path);
            }
        if (recordingArchiveControl != null) recordingArchiveControl.close();
    }
    private static AdditionalWorld startAdditionalWorld() throws Exception {
        return startAdditionalWorld(null,null);
    }
    private static AdditionalWorld startAdditionalWorld(String mediaControlUrl,String mediaControlToken) throws Exception {
        int port;
        try (var reservation = new ServerSocket(0, 1, InetAddress.getByName("127.0.0.1"))) {
            port = reservation.getLocalPort();
        }
        var log = java.nio.file.Files.createTempFile("hufs-world-secondary-integration-", ".log");
        String javaExecutable = java.nio.file.Path.of(System.getProperty("java.home"), "bin",
            System.getProperty("os.name").startsWith("Windows") ? "java.exe" : "java").toString();
        ProcessBuilder builder = new ProcessBuilder(javaExecutable, "-Duser.timezone=UTC", "-jar", System.getProperty("town.worldJar"),
            "--server.port=" + port, "--town.auth.mode=sso", "--town.auth.cookie-secure=false", "--town.public-origin=" + ORIGIN,
            "--spring.datasource.url=" + database.getJdbcUrl(), "--spring.datasource.username=" + database.getUsername(),
            "--spring.datasource.password=" + database.getPassword(),
            "--spring.data.redis.host=" + redis.getHost(), "--spring.data.redis.port=" + redis.getMappedPort(6379));
        builder.environment().put("TOWN_MEDIA_ENABLED",Boolean.toString(mediaControlUrl!=null));
        if(mediaControlUrl!=null){builder.environment().put("MEDIA_CONTROL_URL",mediaControlUrl);builder.environment().put("MEDIA_CONTROL_TOKEN",mediaControlToken);}
        Process process = builder.redirectErrorStream(true).redirectOutput(log.toFile()).start();
        HttpClient probe = HttpClient.newBuilder().connectTimeout(java.time.Duration.ofSeconds(1)).build();
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(25);
        while (process.isAlive() && System.nanoTime() < deadline) {
            try {
                var request = HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + port + "/actuator/health"))
                    .timeout(java.time.Duration.ofSeconds(1)).GET().build();
                if (probe.send(request, HttpResponse.BodyHandlers.discarding()).statusCode() == 200) {
                    Thread.sleep(250);
                    return new AdditionalWorld(process, port, log);
                }
            } catch (java.io.IOException unavailable) { /* Server is still starting. */ }
            Thread.sleep(100);
        }
        process.destroyForcibly();
        throw new AssertionError("Secondary packaged world failed to start; log: " + log);
    }
    private static DelayedMediaControl startDelayedMediaControl() throws Exception {
        HttpServer server=HttpServer.create(new InetSocketAddress("127.0.0.1",0),0);
        ExecutorService executor=Executors.newCachedThreadPool();
        CountDownLatch revokeEntered=new CountDownLatch(1),releaseRevoke=new CountDownLatch(1);
        server.setExecutor(executor);
        server.createContext("/v1/policy",exchange->respond(exchange,200,"{\"instanceId\":\"test-sfu\",\"people\":[]}"));
        server.createContext("/v1/revoke",exchange->{
            revokeEntered.countDown();
            try {
                if(!releaseRevoke.await(20,TimeUnit.SECONDS)){respond(exchange,504,"{\"code\":\"TEST_TIMEOUT\"}");return;}
                respond(exchange,200,"{\"ok\":true}");
            } catch(InterruptedException interrupted) { Thread.currentThread().interrupt();exchange.close(); }
        });
        server.start();return new DelayedMediaControl(server,executor,revokeEntered,releaseRevoke);
    }
    private static RecordingMediaControl startRecordingMediaControl() throws Exception {
        HttpServer server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        ExecutorService executor = Executors.newCachedThreadPool();
        BlockingQueue<JsonNode> policies = new LinkedBlockingQueue<>();
        BlockingQueue<JsonNode> revocations = new LinkedBlockingQueue<>();
        AtomicBoolean holdRevocations = new AtomicBoolean();
        CountDownLatch releaseRevocations = new CountDownLatch(1);
        ObjectMapper mapper = new ObjectMapper();
        server.setExecutor(executor);
        server.createContext("/v1/policy", exchange -> {
            try {
                if (!"Bearer hufs-town-integration-media-control-token-02".equals(
                    exchange.getRequestHeaders().getFirst("Authorization"))) {
                    respond(exchange, 401, "{\"code\":\"UNAUTHORIZED\"}");
                    return;
                }
                JsonNode frame = mapper.readTree(exchange.getRequestBody());
                policies.offer(frame);
                var people = mapper.createArrayNode();
                for (JsonNode person : frame.path("people")) {
                    var applied = mapper.createObjectNode();
                    applied.put("id", person.path("id").asText());
                    applied.put("epoch", person.path("epoch").asLong());
                    applied.set("peers", mapper.createArrayNode());
                    applied.set("offers", mapper.createArrayNode());
                    people.add(applied);
                }
                respond(exchange, 200, mapper.writeValueAsString(Map.of("instanceId", "test-sfu", "people", people)));
            } catch (Exception failure) {
                if (exchange.getResponseCode() == -1) respond(exchange, 500, "{\"code\":\"TEST_FAILURE\"}");
            }
        });
        server.createContext("/v1/revoke", exchange -> {
            try {
                revocations.offer(mapper.readTree(exchange.getRequestBody()));
                if (holdRevocations.get() && !releaseRevocations.await(15, TimeUnit.SECONDS)) {
                    respond(exchange, 504, "{\"code\":\"TEST_TIMEOUT\"}");
                    return;
                }
                respond(exchange, 200, "{\"ok\":true}");
            }
            catch (Exception failure) { respond(exchange, 500, "{\"code\":\"TEST_FAILURE\"}"); }
        });
        server.createContext("/v1/rpc", exchange -> respond(exchange, 200, "{}"));
        server.start();
        return new RecordingMediaControl(server, executor, policies, revocations, holdRevocations, releaseRevocations);
    }
    private static void respond(HttpExchange exchange,int status,String body) throws java.io.IOException {
        byte[] bytes=body.getBytes(java.nio.charset.StandardCharsets.UTF_8);
        exchange.getResponseHeaders().set("Content-Type","application/json");
        exchange.sendResponseHeaders(status,bytes.length);
        try(var output=exchange.getResponseBody()){output.write(bytes);}
    }
    @BeforeEach void resetTransport() {
        transport.server().reset();
        // Isolate the test browser batches sharing one loopback IP in this ephemeral Redis container.
        var keys = strings.keys("hufs-town:auth:rate:*");
        if (keys != null && !keys.isEmpty()) strings.delete(keys);
    }

    @Test void realSessionsPersistProfileGateSocketsAndRevokeAllTabsOnLogout() throws Exception {
        Browser browser = new Browser();
        assertThat(browser.get("me").statusCode()).isEqualTo(401);
        String oldCookie = browser.cookieAfterCsrf();
        String state = browser.start();
        assertThat(browser.rawPost("start", "{}", null).statusCode()).isEqualTo(403);
        expectUser("11111111-1111-4111-8111-111111111111", "ATTENDING");
        var response = browser.post("exchange", Map.of("code", "integration-login-1", "state", state));
        assertThat(response.statusCode()).isEqualTo(200);
        assertThat(browser.cookie()).isNotEqualTo(oldCookie);
        assertThat(response.headers().allValues("set-cookie").toString()).contains("HttpOnly", "SameSite=Lax");
        String id = json.readTree(response.body()).path("userId").asText();
        assertThat(browser.patch("profile", Map.of("displayName", "나의 캠퍼스", "avatar", 2)).statusCode()).isEqualTo(200);
        assertThat(json.readTree(browser.get("me").body()).path("displayName").asText()).isEqualTo("나의 캠퍼스");

        Probe first = browser.socket(ORIGIN);
        Probe second = browser.socket(ORIGIN);
        try {
            // The authenticated server profile wins over caller-supplied public join fields.
            first.send("{\"type\":\"join\",\"protocolVersion\":2,\"name\":\"client-name\",\"avatar\":0,\"skin\":\"light\",\"clothing\":\"casual_white\",\"hair\":\"hair_short_black\",\"resumeToken\":\"\"}");
            first.await(n -> n.path("type").asText().equals("welcome"));
            JsonNode snap = first.await(n -> n.path("type").asText().equals("snapshot"));
            assertThat(snap.path("players").get(0).path("name").asText()).isEqualTo("나의 캠퍼스");
            assertThat(snap.path("players").get(0).path("avatar").asInt()).isEqualTo(2);
            second.send("{\"type\":\"join\",\"protocolVersion\":2,\"name\":\"second\",\"avatar\":0,\"skin\":\"light\",\"clothing\":\"casual_white\",\"hair\":\"hair_short_black\",\"resumeToken\":\"\"}");
            second.await(n -> n.path("type").asText().equals("welcome"));
            first.await(n -> n.path("code").asText().equals("WORLD_OWNER_LOST"));
            assertThat(browser.post("logout", Map.of()).statusCode()).isEqualTo(200);
            second.await(n -> n.path("code").asText().equals("AUTH_REQUIRED"));
            first.closed.get(5, TimeUnit.SECONDS);
            second.closed.get(5, TimeUnit.SECONDS);
        } finally { first.socket.abort(); second.socket.abort(); }
        assertThat(browser.get("me").statusCode()).isEqualTo(401);
        assertThatThrownBy(() -> browser.socket(ORIGIN)).hasCauseInstanceOf(WebSocketHandshakeException.class);

        // A fresh login to the same SSO UUID reuses the account and its chosen avatar.
        String nextState = browser.start();
        expectUser("11111111-1111-4111-8111-111111111111", "ATTENDING");
        var next = browser.post("exchange", Map.of("code", "integration-login-2", "state", nextState));
        assertThat(json.readTree(next.body()).path("userId").asText()).isEqualTo(id);
        assertThat(json.readTree(next.body()).path("avatar").asInt()).isEqualTo(2);
        assertThat(db.queryForObject("SELECT COUNT(*) FROM oauth_identity WHERE subject=?", Integer.class, "11111111-1111-4111-8111-111111111111")).isEqualTo(1);
        transport.server().verify();
    }

    @Test void pokePreferencePersistsPerAccountAndSurvivesANewSession() throws Exception {
        String subject = "13131313-1313-4131-8131-131313131313";
        Browser owner = signedInAs(subject);
        JsonNode initial = ok(owner.get("me"));
        String userId = initial.path("userId").asText();
        assertThat(initial.path("allowPokes").asBoolean()).isTrue();

        JsonNode updated = ok(owner.patch("preferences", Map.of("allowPokes", false)));
        assertThat(updated.path("allowPokes").asBoolean()).isFalse();
        assertThat(ok(owner.get("me")).path("allowPokes").asBoolean()).isFalse();
        assertThat(db.queryForObject("SELECT allow_pokes FROM app_user WHERE id=?", Boolean.class, userId)).isFalse();

        Browser restored = signedInAs(subject);
        JsonNode restoredUser = ok(restored.get("me"));
        assertThat(restoredUser.path("userId").asText()).isEqualTo(userId);
        assertThat(restoredUser.path("allowPokes").asBoolean()).isFalse();

        Browser separate = signedInAs("14141414-1414-4141-8141-141414141414");
        assertThat(ok(separate.get("me")).path("allowPokes").asBoolean()).isTrue();
        transport.server().verify();
    }

    @Test void logoutEverywhereRevokesOtherBrowserSessionsAndTheirWorldSockets() throws Exception {
        String subject = "12121212-1212-4121-8121-121212121212";
        Browser current = signedInAs(subject);
        Browser other = signedInAs(subject);
        String userId = json.readTree(current.get("me").body()).path("userId").asText();
        assertThat(current.cookie()).isNotEqualTo(other.cookie());
        assertThat(sessions.findByPrincipalName(userId)).hasSize(2);

        Probe socket = other.socket(ORIGIN);
        try {
            socket.join("");
            socket.await(message -> message.path("type").asText().equals("welcome"));
            assertThat(current.delete("/auth/sessions", Map.of()).statusCode()).isEqualTo(200);
            assertThat(current.get("me").statusCode()).isEqualTo(401);
            assertThat(other.get("me").statusCode()).isEqualTo(401);
            assertThat(sessions.findByPrincipalName(userId)).isEmpty();
            socket.await(message -> message.path("code").asText().equals("AUTH_REQUIRED"));
            socket.closed.get(5, TimeUnit.SECONDS);
        } finally {
            socket.socket.abort();
        }
    }

    @Test void accountDeletionBlocksOwnedSpacesErasesPersonalDataAndRevokesEverySession() throws Exception {
        String subject = "77777777-7777-4777-8777-777777777777";
        Browser owner = signedInAs(subject);
        Browser ownerOnSecondDevice = signedInAs(subject);
        Browser member = signedIn();
        Browser thirdMember = signedIn();
        String ownerId = json.readTree(owner.get("me").body()).path("userId").asText();
        String memberId = json.readTree(member.get("me").body()).path("userId").asText();
        String thirdMemberId = json.readTree(thirdMember.get("me").body()).path("userId").asText();
        assertThat(sessions.findByPrincipalName(ownerId)).hasSize(2);

        var impact = owner.get("/auth/account/deletion-impact");
        assertThat(impact.statusCode()).isEqualTo(200);
        assertThat(json.readTree(impact.body()).path("ownedSpaces")).hasSize(0);
        assertThat(owner.delete("/auth/account", Map.of("confirmation", "delete")).statusCode()).isEqualTo(400);

        String spaceId = createSpace(owner, "탈퇴 보호 공간", "PUBLIC", 10).path("id").asText();
        assertThat(member.post("/spaces/" + spaceId + "/admission", Map.of()).statusCode()).isEqualTo(200);
        assertThat(thirdMember.post("/spaces/" + spaceId + "/admission", Map.of()).statusCode()).isEqualTo(200);
        JsonNode ownedImpact = json.readTree(owner.get("/auth/account/deletion-impact").body());
        assertThat(ownedImpact.path("ownedSpaces").get(0).path("id").asText()).isEqualTo(spaceId);
        assertThat(owner.delete("/auth/account", Map.of("confirmation", "탈퇴")).statusCode()).isEqualTo(409);
        assertThat(owner.get("me").statusCode()).isEqualTo(200);
        assertThat(sessions.findByPrincipalName(ownerId)).hasSize(2);

        assertThat(owner.post("/spaces/" + spaceId + "/ownership-transfer", Map.of("targetUserId", memberId)).statusCode()).isEqualTo(200);
        assertThat(member.post("/spaces/" + spaceId + "/ownership-transfer/respond", Map.of("decision", "ACCEPT")).statusCode()).isEqualTo(200);

        String conversationId = UUID.randomUUID().toString();
        db.update("""
            INSERT INTO direct_conversation(id,pair_key,conversation_kind,group_name,creation_key,creation_hash,owner_user_id)
            VALUES (?,NULL,'GROUP','탈퇴 검증 그룹',?,?,?)
            """, conversationId, ownerId + ":account-delete-test", "a".repeat(64), ownerId);
        db.update("""
            INSERT INTO direct_conversation_member(membership_id,conversation_id,user_id,joined_at)
            VALUES (UUID(),?,?,CURRENT_TIMESTAMP(6)-INTERVAL 2 MINUTE),
                   (UUID(),?,?,CURRENT_TIMESTAMP(6)-INTERVAL 1 MINUTE),
                   (UUID(),?,?,CURRENT_TIMESTAMP(6))
            """, conversationId, ownerId, conversationId, memberId, conversationId, thirdMemberId);
        db.update("""
            INSERT INTO direct_message(message_id,conversation_id,sender_user_id,sender_player_id,client_message_id,
                sender_name,sender_avatar,sender_skin,sender_clothing,sender_hair,body,content_hash,sent_at,expires_at)
            VALUES (?, ?, ?, ?, 'delete-test', '개인 이름', 0, 'light', 'casual_white', 'hair_short_black',
                '지워야 할 개인 메시지', ?, CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(6)+INTERVAL 1 DAY)
            """, UUID.randomUUID().toString(), conversationId, ownerId, UUID.randomUUID().toString(), "b".repeat(64));
        String memberMessageId = UUID.randomUUID().toString();
        db.update("""
            INSERT INTO direct_message(message_id,conversation_id,sender_user_id,sender_player_id,client_message_id,
                sender_name,sender_avatar,sender_skin,sender_clothing,sender_hair,body,content_hash,sent_at,expires_at)
            VALUES (?, ?, ?, ?, 'delete-test-shared', '다른 사용자', 0, 'light', 'casual_white', 'hair_short_black',
                '공유 대화는 유지할 메시지', ?, CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(6)+INTERVAL 1 DAY)
            """, memberMessageId, conversationId, memberId, UUID.randomUUID().toString(), "c".repeat(64));
        db.update("""
            INSERT INTO direct_message_mutation(id,message_id,actor_user_id,request_id,request_hash,action,revision)
            VALUES (UUID(),?,?,'delete-test-edit',?,'EDIT',1)
            """, memberMessageId, ownerId, "d".repeat(64));
        Long outboxEventId = db.queryForObject(
            "SELECT next_id FROM direct_message_event_sequence WHERE singleton_id=1", Long.class);
        db.update("UPDATE direct_message_event_sequence SET next_id=? WHERE singleton_id=1", outboxEventId + 1);
        db.update("""
            INSERT INTO direct_message_event_outbox(id,event_type,origin_node_id,conversation_id,message_id,
                actor_user_id,reader_membership_id)
            VALUES (?,'MUTATION',?,?,?,?,NULL)
            """, outboxEventId, UUID.randomUUID().toString(), conversationId, memberMessageId, ownerId);
        String eventId = UUID.randomUUID().toString();
        String pollId = UUID.randomUUID().toString();
        db.update("INSERT INTO town_event(id,space_id,host_user_id,title,started_at) VALUES (?,?,?,'탈퇴 처리',CURRENT_TIMESTAMP(6))",
            eventId, spaceId, ownerId);
        db.update("INSERT INTO town_event_poll(id,event_id,question) VALUES (?,?, '탈퇴 후 집계')", pollId, eventId);
        db.update("INSERT INTO town_event_poll_option(poll_id,option_index,label,vote_count) VALUES (?,0,'하나',2)", pollId);
        db.update("INSERT INTO town_event_poll_vote(poll_id,user_id,participant_type,participant_id,option_index) "
                + "VALUES (?, ?, 'USER', ?, 0), (?, ?, 'USER', ?, 0)",
            pollId, ownerId, ownerId, pollId, memberId, memberId);
        db.update("UPDATE app_user SET profile_bio='삭제할 소개',profile_links='https://example.invalid/me' WHERE id=?", ownerId);
        db.update("INSERT INTO chat_retention_policy(policy_id,retention_days,updated_by_user_id) VALUES (1,90,?)", ownerId);

        db.update("""
            INSERT INTO social_join_request(id,requester_user_id,target_user_id,message,expires_at)
            VALUES (?,?,?,'삭제할 합류 요청',CURRENT_TIMESTAMP(6)+INTERVAL 1 DAY)
            """, UUID.randomUUID().toString(), ownerId, memberId);
        db.update("""
            INSERT INTO social_join_request(id,requester_user_id,target_user_id,message,expires_at)
            VALUES (?,?,?,'삭제될 요청 수신 정보',CURRENT_TIMESTAMP(6)+INTERVAL 1 DAY)
            """, UUID.randomUUID().toString(), memberId, ownerId);

        db.update("""
            INSERT INTO space_invite(id,space_id,code_hash,expires_at,max_uses,target_user_id,created_by_user_id)
            VALUES (?,?,?,CURRENT_TIMESTAMP(6)+INTERVAL 1 DAY,1,?,?)
            """, UUID.randomUUID().toString(), spaceId, "e".repeat(64), thirdMemberId, ownerId);
        db.update("""
            INSERT INTO space_invite(id,space_id,code_hash,expires_at,max_uses,target_user_id,created_by_user_id)
            VALUES (?,?,?,CURRENT_TIMESTAMP(6)+INTERVAL 1 DAY,1,?,?)
            """, UUID.randomUUID().toString(), spaceId, "f".repeat(64), ownerId, memberId);
        db.update("""
            INSERT INTO space_invite(id,space_id,code_hash,expires_at,max_uses,target_user_id,created_by_user_id)
            VALUES (?,?,?,CURRENT_TIMESTAMP(6)+INTERVAL 1 DAY,1,?,?)
            """, UUID.randomUUID().toString(), spaceId, "1".repeat(64), thirdMemberId, memberId);

        String guestId = UUID.randomUUID().toString();
        db.update("INSERT INTO guest_moderation_restriction(guest_id,updated_by_user_id,reason) VALUES (?,?,?)",
            guestId, ownerId, "운영자 ID만 제거해야 하는 제한");
        db.update("INSERT INTO user_chat_restriction(user_id,muted_until,reason) VALUES (?,CURRENT_TIMESTAMP(6)+INTERVAL 1 DAY,'탈퇴 대상 채팅 제한')",
            ownerId);
        db.update("INSERT INTO user_world_restriction(user_id,blocked_until,reason) VALUES (?,CURRENT_TIMESTAMP(6)-INTERVAL 1 MINUTE,'만료된 월드 제한')",
            ownerId);
        db.update("INSERT INTO user_media_mute(user_id,muted_until,reason) VALUES (?,CURRENT_TIMESTAMP(6)+INTERVAL 1 DAY,'탈퇴 대상 미디어 제한')",
            ownerId);

        String moderationReportId = UUID.randomUUID().toString();
        String moderationMessageId = UUID.randomUUID().toString();
        String moderationConversationId = UUID.randomUUID().toString();
        db.update("""
            INSERT INTO user_report(report_id,reporter_user_id,reporter_name_snapshot,target_user_id,target_name_snapshot,
                conversation_id,message_id,category,details,evidence_text,message_sent_at,status,
                reviewed_by_user_id,reviewer_name_snapshot,review_note,reviewed_at)
            VALUES (?,?,?,?,?,?,?,'HARASSMENT','삭제 감사 검증 설명','삭제 감사 검증 원문',CURRENT_TIMESTAMP(3),
                'RESOLVED',?,'탈퇴 전 검토자','탈퇴 전 검토 기록',CURRENT_TIMESTAMP(6))
            """, moderationReportId, thirdMemberId, "신고자 표시명", memberId, "대상 표시명",
            moderationConversationId, moderationMessageId, ownerId);
        db.update("""
            INSERT INTO user_report_review(review_id,report_id,reviewer_user_id,reviewer_name_snapshot,
                from_status,to_status,note)
            VALUES (?,?,?,'탈퇴 전 검토자','OPEN','RESOLVED','감사 이력은 남겨야 합니다')
            """, UUID.randomUUID().toString(), moderationReportId, ownerId);

        String administratorActionId = UUID.randomUUID().toString();
        String targetActionId = UUID.randomUUID().toString();
        db.update("""
            INSERT INTO user_moderation_action(action_id,request_id,request_hash,report_id,target_user_id,
                administrator_user_id,action_code,duration_minutes,effective_until,note)
            VALUES (?,?,'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',?,?,?,
                'WORLD_KICK',10,CURRENT_TIMESTAMP(6)+INTERVAL 10 MINUTE,'탈퇴 운영자 식별 정보')
            """, administratorActionId, "delete-admin-action-0001", moderationReportId, memberId, ownerId);

        String targetReportId = UUID.randomUUID().toString();
        db.update("""
            INSERT INTO user_report(report_id,reporter_user_id,reporter_name_snapshot,target_user_id,target_name_snapshot,
                conversation_id,message_id,category,details,evidence_text,message_sent_at)
            VALUES (?,?,?,?,?,?,?,'HARASSMENT','삭제 대상 감사 검증 설명','삭제 대상 감사 검증 원문',CURRENT_TIMESTAMP(3))
            """, targetReportId, thirdMemberId, "신고자 표시명", ownerId, "삭제 대상 표시명",
            UUID.randomUUID().toString(), UUID.randomUUID().toString());
        db.update("""
            INSERT INTO user_moderation_action(action_id,request_id,request_hash,report_id,target_user_id,
                administrator_user_id,action_code,duration_minutes,effective_until,note)
            VALUES (?,?,'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',?,?,?,
                'CHAT_MUTE',30,CURRENT_TIMESTAMP(6)+INTERVAL 30 MINUTE,'탈퇴 대상 식별 정보')
            """, targetActionId, "delete-target-action-0001", targetReportId, ownerId, memberId);

        String noteMapId = db.queryForObject("SELECT map_id FROM space_map WHERE space_id=? ORDER BY sort_order,map_id LIMIT 1",
            String.class, spaceId);
        db.update("""
            INSERT INTO space_room_note(space_id,map_id,zone_id,revision,body,updated_at,updated_by_user_id,updated_by_name)
            VALUES (?,?, 'account-deletion-note',1,'공유 메모는 보존 정책까지 유지',CURRENT_TIMESTAMP(6),?,'삭제 전 표시 이름')
            """, spaceId, noteMapId, ownerId);
        db.update("""
            INSERT INTO space_room_note_revision(space_id,map_id,zone_id,request_id,revision,request_hash,
                author_user_id,author_name,body)
            VALUES (?,?, 'account-deletion-note','account-deletion-revision',1,?,?,'삭제 전 작성자 이름','공유 메모 수정 이력')
            """, spaceId, noteMapId, "2".repeat(64), ownerId);

        String pendingAssetFile = UUID.randomUUID() + ".png";
        String pendingAssetThumbnail = UUID.randomUUID() + ".png";
        java.nio.file.Files.createDirectories(assetRoot);
        java.nio.file.Files.writeString(assetRoot.resolve(pendingAssetFile), "private pending asset bytes");
        java.nio.file.Files.writeString(assetRoot.resolve(pendingAssetThumbnail), "private pending thumbnail bytes");
        db.update("""
            INSERT INTO space_asset(id,space_id,uploader_user_id,original_name,mime_type,byte_size,width,height,
                sha256,storage_key,thumbnail_key,status,reviewed_by_user_id)
            VALUES ('custom_account_delete_pending',?,?, '개인 파일명.png','image/png',100,1,1,?,?,?,'PENDING',?)
            """, spaceId, ownerId, "3".repeat(64), pendingAssetFile, pendingAssetThumbnail, ownerId);

        String acceptedFriendA = ownerId.compareTo(memberId) < 0 ? ownerId : memberId;
        String acceptedFriendB = ownerId.compareTo(memberId) < 0 ? memberId : ownerId;
        db.update("""
            INSERT INTO user_friendship(friendship_id,user_a_id,user_b_id,requested_by_user_id,status,resolved_at)
            VALUES (?,?,?,?, 'ACCEPTED',CURRENT_TIMESTAMP(6))
            """, UUID.randomUUID().toString(), acceptedFriendA, acceptedFriendB, ownerId);
        String pendingFriendA = ownerId.compareTo(thirdMemberId) < 0 ? ownerId : thirdMemberId;
        String pendingFriendB = ownerId.compareTo(thirdMemberId) < 0 ? thirdMemberId : ownerId;
        db.update("""
            INSERT INTO user_friendship(friendship_id,user_a_id,user_b_id,requested_by_user_id,status)
            VALUES (?,?,?,?, 'PENDING')
            """, UUID.randomUUID().toString(), pendingFriendA, pendingFriendB, thirdMemberId);
        db.update("INSERT INTO user_social_preference(user_id,allow_friend_requests) VALUES (?,FALSE)", ownerId);

        Probe activeFirst = owner.socket(ORIGIN);
        Probe activeSecond = ownerOnSecondDevice.socket(ORIGIN);
        try {
            activeFirst.join(""); activeFirst.await(node -> node.path("type").asText().equals("welcome"));
            activeSecond.join(""); activeSecond.await(node -> node.path("type").asText().equals("welcome"));
            assertThat(owner.delete("/auth/account", Map.of("confirmation", "탈퇴")).statusCode()).isEqualTo(200);
            assertThat(owner.get("me").statusCode()).isEqualTo(401);
            assertThat(ownerOnSecondDevice.get("me").statusCode()).isEqualTo(401);
            Predicate<JsonNode> accountSessionRevoked = node ->
                node.path("code").asText().equals("AUTH_REQUIRED")
                    || node.path("code").asText().equals("SPACE_ACCESS_REVOKED");
            activeFirst.await(accountSessionRevoked);
            activeSecond.await(accountSessionRevoked);
            activeFirst.closed.get(5, TimeUnit.SECONDS);
            activeSecond.closed.get(5, TimeUnit.SECONDS);
        } finally { activeFirst.socket.abort(); activeSecond.socket.abort(); }

        assertThat(sessions.findByPrincipalName(ownerId)).isEmpty();
        assertThat(db.queryForMap("SELECT status,display_name,profile_bio,profile_links FROM app_user WHERE id=?", ownerId))
            .containsEntry("status", "DELETED").containsEntry("display_name", "탈퇴한 사용자")
            .containsEntry("profile_bio", "").containsEntry("profile_links", "");
        assertThat(db.queryForObject("SELECT COUNT(*) FROM oauth_identity WHERE user_id=?", Integer.class, ownerId)).isZero();
        assertThat(db.queryForObject("SELECT COUNT(*) FROM space_member WHERE space_id=? AND user_id=?", Integer.class, spaceId, ownerId)).isZero();
        assertThat(db.queryForObject("SELECT COUNT(*) FROM direct_message WHERE conversation_id=? AND sender_user_id=?", Integer.class, conversationId, ownerId)).isZero();
        assertThat(db.queryForObject("SELECT COUNT(*) FROM direct_message WHERE message_id=? AND sender_user_id=?",
            Integer.class, memberMessageId, memberId)).isEqualTo(1);
        assertThat(db.queryForObject("SELECT COUNT(*) FROM direct_message_mutation WHERE actor_user_id=?", Integer.class, ownerId)).isZero();
        assertThat(db.queryForObject("SELECT COUNT(*) FROM direct_message_event_outbox WHERE actor_user_id=?", Integer.class, ownerId)).isZero();
        assertThat(db.queryForObject("SELECT updated_by_user_id FROM chat_retention_policy WHERE policy_id=1", String.class)).isNull();
        assertThat(db.queryForObject("SELECT COUNT(*) FROM social_join_request WHERE requester_user_id=? OR target_user_id=?",
            Integer.class, ownerId, ownerId)).isZero();
        assertThat(db.queryForObject("SELECT COUNT(*) FROM user_friendship WHERE user_a_id=? OR user_b_id=?",
            Integer.class, ownerId, ownerId)).isZero();
        assertThat(db.queryForObject("SELECT COUNT(*) FROM user_social_preference WHERE user_id=?", Integer.class, ownerId)).isZero();
        assertThat(db.queryForObject("SELECT COUNT(*) FROM space_invite WHERE target_user_id=? OR created_by_user_id=?",
            Integer.class, ownerId, ownerId)).isZero();
        assertThat(db.queryForObject("SELECT COUNT(*) FROM space_invite WHERE target_user_id=? AND created_by_user_id=?",
            Integer.class, thirdMemberId, memberId)).isEqualTo(1);
        assertThat(db.queryForObject("SELECT updated_by_user_id FROM guest_moderation_restriction WHERE guest_id=?",
            String.class, guestId)).isNull();
        assertThat(db.queryForObject("SELECT COUNT(*) FROM user_chat_restriction WHERE user_id=?", Integer.class, ownerId)).isZero();
        assertThat(db.queryForObject("SELECT COUNT(*) FROM user_world_restriction WHERE user_id=?", Integer.class, ownerId)).isZero();
        assertThat(db.queryForObject("SELECT COUNT(*) FROM user_media_mute WHERE user_id=?", Integer.class, ownerId)).isZero();
        assertThat(db.queryForMap("""
            SELECT reporter_user_id,reporter_name_snapshot,target_user_id,target_name_snapshot,
                reviewed_by_user_id,reviewer_name_snapshot,review_note
            FROM user_report WHERE report_id=?
            """, moderationReportId))
            .containsEntry("reporter_user_id", thirdMemberId)
            .containsEntry("reporter_name_snapshot", "신고자 표시명")
            .containsEntry("target_user_id", memberId)
            .containsEntry("target_name_snapshot", "대상 표시명")
            .containsEntry("reviewed_by_user_id", null)
            .containsEntry("reviewer_name_snapshot", "탈퇴한 운영자")
            .containsEntry("review_note", "탈퇴 전 검토 기록");
        assertThat(db.queryForMap("""
            SELECT reviewer_user_id,reviewer_name_snapshot,note FROM user_report_review WHERE report_id=?
            """, moderationReportId))
            .containsEntry("reviewer_user_id", null)
            .containsEntry("reviewer_name_snapshot", "탈퇴한 운영자")
            .containsEntry("note", "감사 이력은 남겨야 합니다");
        assertThat(db.queryForMap("""
            SELECT administrator_user_id,target_user_id,note FROM user_moderation_action WHERE action_id=?
            """, administratorActionId))
            .containsEntry("administrator_user_id", null)
            .containsEntry("target_user_id", memberId)
            .containsEntry("note", "계정 탈퇴로 사용자 식별정보가 삭제되었습니다.");
        assertThat(db.queryForMap("""
            SELECT administrator_user_id,target_user_id,note FROM user_moderation_action WHERE action_id=?
            """, targetActionId))
            .containsEntry("administrator_user_id", memberId)
            .containsEntry("target_user_id", null)
            .containsEntry("note", "계정 탈퇴로 사용자 식별정보가 삭제되었습니다.");
        assertThat(db.queryForMap("""
            SELECT target_user_id,target_name_snapshot FROM user_report WHERE report_id=?
            """, targetReportId))
            .containsEntry("target_user_id", null)
            .containsEntry("target_name_snapshot", "탈퇴한 사용자");
        assertThat(db.queryForMap("SELECT updated_by_user_id,updated_by_name,body FROM space_room_note WHERE space_id=? AND map_id=? AND zone_id='account-deletion-note'",
            spaceId, noteMapId)).containsEntry("updated_by_user_id", null)
            .containsEntry("updated_by_name", "탈퇴한 사용자")
            .containsEntry("body", "공유 메모는 보존 정책까지 유지");
        assertThat(db.queryForMap("SELECT author_user_id,author_name,body FROM space_room_note_revision WHERE space_id=? AND map_id=? AND zone_id='account-deletion-note'",
            spaceId, noteMapId)).containsEntry("author_user_id", null)
            .containsEntry("author_name", "탈퇴한 사용자")
            .containsEntry("body", "공유 메모 수정 이력");
        assertThat(db.queryForMap("SELECT status,uploader_user_id,original_name,reviewed_by_user_id FROM space_asset WHERE id='custom_account_delete_pending'"))
            .containsEntry("status", "REJECTED")
            .containsEntry("uploader_user_id", null)
            .containsEntry("original_name", "탈퇴한 사용자 업로드")
            .containsEntry("reviewed_by_user_id", null);
        assertThat(java.nio.file.Files.exists(assetRoot.resolve(pendingAssetFile))).isFalse();
        assertThat(java.nio.file.Files.exists(assetRoot.resolve(pendingAssetThumbnail))).isFalse();
        assertThat(db.queryForObject("SELECT owner_user_id FROM direct_conversation WHERE id=?", String.class, conversationId))
            .isNotEqualTo(ownerId);
        assertThat(db.queryForObject("SELECT creation_key FROM direct_conversation WHERE id=?", String.class, conversationId))
            .isEqualTo("deleted:" + conversationId).doesNotContain(ownerId);
        assertThat(db.queryForObject("SELECT vote_count FROM town_event_poll_option WHERE poll_id=? AND option_index=0", Integer.class, pollId)).isEqualTo(1);
        assertThat(db.queryForObject("SELECT host_user_id FROM town_event WHERE id=?", String.class, eventId)).isNull();

        Browser freshLogin = signedInAs(subject);
        String freshUserId = json.readTree(freshLogin.get("me").body()).path("userId").asText();
        assertThat(freshUserId).isNotEqualTo(ownerId);
        assertThat(json.readTree(freshLogin.get("me").body()).path("displayName").asText()).isEqualTo("HUFS 친구");
    }

    @Test void rejectedAndAbandonedAssetFilesAreCleanedWithoutRemovingActiveUploads() throws Exception {
        Browser owner = signedIn();
        String ownerId = ok(owner.get("me")).path("userId").asText();
        String spaceId = createSpace(owner, "에셋 정리 재시도", "PUBLIC", 10).path("id").asText();

        String rejectedStorage = UUID.randomUUID() + ".png";
        String rejectedThumbnail = UUID.randomUUID() + ".png";
        String activeStorage = UUID.randomUUID() + ".png";
        String recentOrphan = UUID.randomUUID() + ".png";
        String staleOrphan = UUID.randomUUID() + ".png";
        String staleTemporary = ".upload-thumb-" + UUID.randomUUID();
        java.nio.file.Files.createDirectories(assetRoot);
        for (String file : List.of(rejectedStorage, rejectedThumbnail, activeStorage, recentOrphan, staleOrphan, staleTemporary))
            java.nio.file.Files.writeString(assetRoot.resolve(file), "fixture");
        var staleTime = java.nio.file.attribute.FileTime.from(Instant.now().minus(java.time.Duration.ofHours(25)));
        java.nio.file.Files.setLastModifiedTime(assetRoot.resolve(staleOrphan), staleTime);
        java.nio.file.Files.setLastModifiedTime(assetRoot.resolve(staleTemporary), staleTime);

        db.update("""
            INSERT INTO space_asset(id,space_id,uploader_user_id,original_name,mime_type,byte_size,width,height,
                sha256,storage_key,thumbnail_key,status)
            VALUES ('custom_cleanup_rejected',?,NULL,'탈퇴 사용자 업로드','image/png',10,1,1,?,?,?,'REJECTED')
            """, spaceId, "a".repeat(64), rejectedStorage, rejectedThumbnail);
        db.update("""
            INSERT INTO space_asset(id,space_id,uploader_user_id,original_name,mime_type,byte_size,width,height,
                sha256,storage_key,thumbnail_key,status)
            VALUES ('custom_cleanup_active',?,?, '대기 중 업로드','image/png',10,1,1,?,?,?,'PENDING')
            """, spaceId, ownerId, "b".repeat(64), activeStorage, UUID.randomUUID() + ".png");

        int deleted = spaceAssets.sweepRejectedAndAbandonedFiles();

        assertThat(deleted).isEqualTo(4);
        assertThat(java.nio.file.Files.exists(assetRoot.resolve(rejectedStorage))).isFalse();
        assertThat(java.nio.file.Files.exists(assetRoot.resolve(rejectedThumbnail))).isFalse();
        assertThat(java.nio.file.Files.exists(assetRoot.resolve(staleOrphan))).isFalse();
        assertThat(java.nio.file.Files.exists(assetRoot.resolve(staleTemporary))).isFalse();
        assertThat(java.nio.file.Files.exists(assetRoot.resolve(activeStorage))).isTrue();
        assertThat(java.nio.file.Files.exists(assetRoot.resolve(recentOrphan))).isTrue();
    }

    @Test void onlyAllowedAdministratorCanChangeChatRetentionPolicy() throws Exception {
        db.update("DELETE FROM chat_retention_policy WHERE policy_id=1");
        db.update("INSERT INTO app_user(id,display_name) VALUES (?, '보존 관리자')", RETENTION_ADMIN_ID);
        db.update("INSERT INTO oauth_identity(user_id,provider,subject) VALUES (?,'gdg_hufs',?)",
            RETENTION_ADMIN_ID, RETENTION_ADMIN_SUBJECT);
        Browser admin = signedInAs(RETENTION_ADMIN_SUBJECT);
        Browser member = signedIn();
        try {
            JsonNode initial = ok(admin.get("/admin/settings/chat-retention"));
            assertThat(initial.path("retentionDays").asInt()).isEqualTo(30);
            assertThat(initial.path("source").asText()).isEqualTo("ENVIRONMENT");
            assertThat(member.get("/admin/settings/chat-retention").statusCode()).isEqualTo(403);
            assertThat(member.put("/admin/settings/chat-retention", Map.of("retentionDays", 90)).statusCode())
                .isEqualTo(403);

            JsonNode saved = ok(admin.put("/admin/settings/chat-retention", Map.of("retentionDays", 90)));
            assertThat(saved.path("retentionDays").asInt()).isEqualTo(90);
            assertThat(saved.path("source").asText()).isEqualTo("DATABASE");
            assertThat(saved.path("updatedBy").asText()).isEqualTo(RETENTION_ADMIN_ID);
            assertThat(admin.put("/admin/settings/chat-retention", Map.of("retentionDays", 366)).statusCode())
                .isEqualTo(400);
            assertThat(db.queryForObject("SELECT retention_days FROM chat_retention_policy WHERE policy_id=1", Integer.class))
                .isEqualTo(90);

            Thread.sleep(5200);
            String adminId = json.readTree(admin.get("me").body()).path("userId").asText();
            String memberId = json.readTree(member.get("me").body()).path("userId").asText();
            String conversationId = UUID.randomUUID().toString();
            String pairKey = adminId.compareTo(memberId) < 0 ? adminId + ":" + memberId : memberId + ":" + adminId;
            db.update("INSERT INTO direct_conversation(id,pair_key) VALUES (?,?)", conversationId, pairKey);
            db.update("""
                INSERT INTO direct_conversation_member(membership_id,conversation_id,user_id)
                VALUES (UUID(),?,?),(UUID(),?,?)
                """, conversationId, adminId, conversationId, memberId);
            Probe adminSocket = admin.socket(ORIGIN);
            Probe memberSocket = member.socket(ORIGIN);
            try {
                adminSocket.join("");
                JsonNode adminWelcome = adminSocket.await(node -> node.path("type").asText().equals("welcome"));
                memberSocket.join("");
                memberSocket.await(node -> node.path("type").asText().equals("welcome"));
                adminSocket.await(node -> node.path("type").asText().equals("blockState"));
                memberSocket.await(node -> node.path("type").asText().equals("blockState"));
                adminSocket.send(json.writeValueAsString(Map.of(
                    "type", "chatSend", "clientMessageId", "retention-policy-test",
                    "epoch", adminWelcome.path("epoch").asLong(), "channel", "dm",
                    "conversationId", conversationId, "text", "보존 기간 반영 확인"
                )));
                JsonNode acknowledgement = adminSocket.await(node -> node.path("type").asText().equals("chatAck")
                    && node.path("clientMessageId").asText().equals("retention-policy-test"));
                assertThat(acknowledgement.path("accepted").asBoolean()).isTrue();
                java.sql.Timestamp sentAt = db.queryForObject(
                    "SELECT sent_at FROM direct_message WHERE conversation_id=? AND client_message_id=?",
                    java.sql.Timestamp.class, conversationId, "retention-policy-test");
                java.sql.Timestamp expiresAt = db.queryForObject(
                    "SELECT expires_at FROM direct_message WHERE conversation_id=? AND client_message_id=?",
                    java.sql.Timestamp.class, conversationId, "retention-policy-test");
                assertThat(java.time.Duration.between(sentAt.toInstant(), expiresAt.toInstant()).toDays()).isEqualTo(90);

                adminSocket.send(json.writeValueAsString(Map.of(
                    "type", "chatSend", "clientMessageId", "retention-policy-space-test",
                    "epoch", adminWelcome.path("epoch").asLong(), "channel", "nearby",
                    "conversationId", "", "text", "공간 채팅 보존 기간 확인"
                )));
                JsonNode spaceAcknowledgement = adminSocket.await(node -> node.path("type").asText().equals("chatAck")
                    && node.path("clientMessageId").asText().equals("retention-policy-space-test"));
                assertThat(spaceAcknowledgement.path("accepted").asBoolean()).isTrue();
                java.sql.Timestamp spaceSentAt = db.queryForObject(
                    "SELECT sent_at FROM chat_message WHERE sender_user_id=? AND client_message_id=?",
                    java.sql.Timestamp.class, adminId, "retention-policy-space-test");
                java.sql.Timestamp spaceExpiresAt = db.queryForObject(
                    "SELECT expires_at FROM chat_message WHERE sender_user_id=? AND client_message_id=?",
                    java.sql.Timestamp.class, adminId, "retention-policy-space-test");
                assertThat(java.time.Duration.between(spaceSentAt.toInstant(), spaceExpiresAt.toInstant()).toDays())
                    .isEqualTo(90);
            } finally {
                adminSocket.socket.abort();
                memberSocket.socket.abort();
            }
        } finally {
            db.update("DELETE FROM chat_retention_policy WHERE policy_id=1");
            Thread.sleep(5200);
        }
    }

    @Test void dmReadReceiptAdvancesOverTheWorldSocketAndAppearsInHistory() throws Exception {
        Browser sender = signedIn();
        Browser reader = signedIn();
        String senderId = json.readTree(sender.get("me").body()).path("userId").asText();
        String readerId = json.readTree(reader.get("me").body()).path("userId").asText();
        String conversationId = UUID.randomUUID().toString();
        String pairKey = senderId.compareTo(readerId) < 0 ? senderId + ":" + readerId : readerId + ":" + senderId;
        db.update("INSERT INTO direct_conversation(id,pair_key) VALUES (?,?)", conversationId, pairKey);
        String senderMembershipId = UUID.randomUUID().toString();
        String readerMembershipId = UUID.randomUUID().toString();
        db.update("""
            INSERT INTO direct_conversation_member(membership_id,conversation_id,user_id)
            VALUES (?,?,?),(?,?,?)
            """, senderMembershipId, conversationId, senderId, readerMembershipId, conversationId, readerId);
        String messageId = UUID.randomUUID().toString();
        db.update("""
            INSERT INTO direct_message(message_id,conversation_id,sender_user_id,sender_player_id,client_message_id,
                sender_name,sender_avatar,sender_skin,sender_clothing,sender_hair,body,content_hash,sent_at,expires_at)
            VALUES (?,?,?,?,?,'읽음 테스트',0,'light','casual_white','hair_short_black','읽음 표시를 확인해요',?,
                CURRENT_TIMESTAMP(3)-INTERVAL 1 MINUTE,CURRENT_TIMESTAMP(6)+INTERVAL 1 DAY)
            """, messageId, conversationId, senderId, UUID.randomUUID().toString(), "read-receipt-test", "c".repeat(64));

        JsonNode beforeRead = json.readTree(reader.get("/dms/" + conversationId + "/messages").body());
        assertThat(beforeRead.get(0).path("messageId").asText()).isEqualTo(messageId);
        assertThat(beforeRead.get(0).path("readByCount").asInt()).isZero();
        assertThat(db.queryForObject("SELECT last_read_at FROM direct_conversation_member WHERE conversation_id=? AND user_id=?",
            java.sql.Timestamp.class, conversationId, readerId)).isNull();

        Probe senderSocket = sender.socket(ORIGIN);
        Probe readerSocket = reader.socket(ORIGIN);
        try {
            senderSocket.join("");
            JsonNode senderWelcome = senderSocket.await(node -> node.path("type").asText().equals("welcome"));
            readerSocket.join("");
            JsonNode readerWelcome = readerSocket.await(node -> node.path("type").asText().equals("welcome"));
            senderSocket.await(node -> node.path("type").asText().equals("blockState"));
            readerSocket.await(node -> node.path("type").asText().equals("blockState"));
            readerSocket.send(json.writeValueAsString(Map.of(
                "type", "directMessageReadRequest",
                "epoch", readerWelcome.path("epoch").asLong(),
                "requestId", "read-receipt-test",
                "conversationId", conversationId,
                "messageId", messageId
            )));
            JsonNode ack = readerSocket.await(node -> node.path("type").asText().equals("directMessageReadAck"));
            assertThat(ack.path("accepted").asBoolean()).isTrue();
            assertThat(ack.path("requestId").asText()).isEqualTo("read-receipt-test");
            JsonNode receipt = senderSocket.await(node -> node.path("type").asText().equals("directMessageReadEvent")
                && node.path("conversationId").asText().equals(conversationId));
            assertThat(receipt.path("messageId").asText()).isEqualTo(messageId);
            assertThat(receipt.path("readerMemberId").asText()).isEqualTo(readerMembershipId);
            assertThat(receipt.has("readerUserId")).isFalse();
            assertThat(db.queryForObject("SELECT last_read_message_id FROM direct_conversation_member WHERE conversation_id=? AND user_id=?",
                String.class, conversationId, readerId)).isEqualTo(messageId);
            JsonNode afterRead = json.readTree(sender.get("/dms/" + conversationId + "/messages").body());
            assertThat(afterRead.get(0).path("readByCount").asInt()).isEqualTo(1);
        } finally {
            senderSocket.socket.abort();
            readerSocket.socket.abort();
        }
    }

    @Test void meetingChatHistoryOnlyShowsMessagesRecordedForThatRoomAndItsOriginalRecipients() throws Exception {
        Browser owner = signedIn();
        Browser roomARecipient = signedIn();
        Browser roomBRecipient = signedIn();
        String spaceId = createSpace(owner, "회의실 채팅 이력 경계", "PUBLIC", 20).path("id").asText();
        String ownerId = json.readTree(owner.get("me").body()).path("userId").asText();
        String roomAUserId = json.readTree(roomARecipient.get("me").body()).path("userId").asText();
        String roomBUserId = json.readTree(roomBRecipient.get("me").body()).path("userId").asText();
        assertThat(roomARecipient.post("/spaces/" + spaceId + "/admission", Map.of()).statusCode()).isEqualTo(200);
        assertThat(roomBRecipient.post("/spaces/" + spaceId + "/admission", Map.of()).statusCode()).isEqualTo(200);

        String roomAMessage = UUID.randomUUID().toString();
        String roomBMessage = UUID.randomUUID().toString();
        String expiredRoomAMessage = UUID.randomUUID().toString();
        insertRoomChat(spaceId, ownerId, roomAMessage, "room-a", "회의실 A 비공개 이력", false);
        insertRoomChat(spaceId, ownerId, roomBMessage, "room-b", "회의실 B 비공개 이력", false);
        insertRoomChat(spaceId, ownerId, expiredRoomAMessage, "room-a", "만료된 회의실 이력", true);
        db.update("INSERT INTO chat_message_recipient(message_id,user_id) VALUES (?,?),(?,?),(?,?),(?,?),(?,?),(?,?)",
            roomAMessage, ownerId, roomAMessage, roomAUserId,
            roomBMessage, ownerId, roomBMessage, roomBUserId,
            expiredRoomAMessage, ownerId, expiredRoomAMessage, roomAUserId);

        String roomAPath = "/spaces/" + spaceId + "/chat?channel=room&zoneId=room-a";
        JsonNode ownerHistory = json.readTree(owner.get(roomAPath).body());
        JsonNode roomAHistory = json.readTree(roomARecipient.get(roomAPath).body());
        JsonNode roomBHistory = json.readTree(roomBRecipient.get(roomAPath).body());
        assertThat(ownerHistory).hasSize(1);
        assertThat(ownerHistory.get(0).path("messageId").asText()).isEqualTo(roomAMessage);
        assertThat(roomAHistory).hasSize(1);
        assertThat(roomAHistory.get(0).path("text").asText()).isEqualTo("회의실 A 비공개 이력");
        assertThat(roomBHistory).isEmpty();
        JsonNode roomBOnlyHistory = json.readTree(roomBRecipient.get(
            "/spaces/" + spaceId + "/chat?channel=room&zoneId=room-b").body());
        assertThat(roomBOnlyHistory).hasSize(1);
        assertThat(roomBOnlyHistory.get(0).path("messageId").asText()).isEqualTo(roomBMessage);
        assertThat(roomBRecipient.get(roomAPath + "&beforeId=" + roomAMessage).statusCode()).isEqualTo(400);
    }

    private void insertRoomChat(String spaceId, String senderId, String messageId, String zoneId,
                                String text, boolean expired) {
        String expiry = expired ? "CURRENT_TIMESTAMP(6)-INTERVAL 1 SECOND"
            : "CURRENT_TIMESTAMP(6)+INTERVAL 1 DAY";
        String sql = """
            INSERT INTO chat_message(message_id,space_id,sender_user_id,sender_player_id,client_message_id,
                channel,zone_id,sender_name,sender_avatar,sender_skin,sender_clothing,sender_hair,body,content_hash,sent_at,expires_at)
            VALUES (?,?,?,?,?,'room',?,'이력 검사 계정',0,'light','casual_white','hair_short_black',?,?,
                CURRENT_TIMESTAMP(3)-INTERVAL 1 MINUTE,%s)
            """.formatted(expiry);
        db.update(sql, messageId, spaceId, senderId, UUID.randomUUID().toString(),
            "meeting-history-" + messageId, zoneId, text, "a".repeat(64));
    }

    @Test void directMessageReportsUseServerVerifiedMembershipAndKeepEvidenceInTheAdminQueue() throws Exception {
        db.update("""
            INSERT INTO app_user(id,display_name) VALUES (?, '신고 검토 운영자')
            ON DUPLICATE KEY UPDATE display_name=VALUES(display_name)
            """, REPORT_ADMIN_ID);
        db.update("""
            INSERT INTO oauth_identity(user_id,provider,subject) VALUES (?,'gdg_hufs',?)
            ON DUPLICATE KEY UPDATE user_id=VALUES(user_id)
            """, REPORT_ADMIN_ID, REPORT_ADMIN_SUBJECT);

        Browser admin = signedInAs(REPORT_ADMIN_SUBJECT);
        Browser reporter = signedIn();
        Browser target = signedIn();
        Browser outsider = signedIn();
        String reporterId = json.readTree(reporter.get("me").body()).path("userId").asText();
        String targetId = json.readTree(target.get("me").body()).path("userId").asText();
        String conversationId = UUID.randomUUID().toString();
        String pairKey = reporterId.compareTo(targetId) < 0
            ? reporterId + ":" + targetId : targetId + ":" + reporterId;
        db.update("INSERT INTO direct_conversation(id,pair_key) VALUES (?,?)", conversationId, pairKey);
        db.update("""
            INSERT INTO direct_conversation_member(membership_id,conversation_id,user_id)
            VALUES (UUID(),?,?),(UUID(),?,?)
            """, conversationId, reporterId, conversationId, targetId);
        String messageId = UUID.randomUUID().toString();
        String evidence = "신고 검증용 비공개 DM 원문";
        db.update("""
            INSERT INTO direct_message(message_id,conversation_id,sender_user_id,sender_player_id,client_message_id,
                sender_name,sender_avatar,sender_skin,sender_clothing,sender_hair,body,content_hash,sent_at,expires_at)
            VALUES (?,?,?,?,?,'DM 신고 대상',0,'light','casual_white','hair_short_black',?,? ,
                CURRENT_TIMESTAMP(3)-INTERVAL 1 MINUTE,CURRENT_TIMESTAMP(6)+INTERVAL 1 DAY)
            """, messageId, conversationId, targetId, UUID.randomUUID().toString(),
            "dm-report-test-" + messageId, evidence, "e".repeat(64));

        var createdResponse = reporter.post("/reports", Map.of(
            "messageId", messageId, "category", "HARASSMENT", "details", "관리자만 열람할 추가 설명"
        ));
        assertThat(createdResponse.statusCode()).isEqualTo(200);
        JsonNode created = json.readTree(createdResponse.body());
        assertThat(created.path("created").asBoolean()).isTrue();
        String reportId = created.path("reportId").asText();

        assertThat(reporter.post("/reports", Map.of(
            "messageId", messageId, "category", "HARASSMENT", "details", "중복 신고"
        )).statusCode()).isEqualTo(409);
        String secondMessageId = UUID.randomUUID().toString();
        db.update("""
            INSERT INTO direct_message(message_id,conversation_id,sender_user_id,sender_player_id,client_message_id,
                sender_name,sender_avatar,sender_skin,sender_clothing,sender_hair,body,content_hash,sent_at,expires_at)
            VALUES (?,?,?,?,?,'DM 신고 대상',0,'light','casual_white','hair_short_black',?,? ,
                CURRENT_TIMESTAMP(3)-INTERVAL 30 SECOND,CURRENT_TIMESTAMP(6)+INTERVAL 1 DAY)
            """, secondMessageId, conversationId, targetId, UUID.randomUUID().toString(),
            "dm-report-test-second-" + secondMessageId, "다른 원문", "f".repeat(64));
        assertThat(reporter.post("/reports", Map.of(
            "messageId", secondMessageId, "category", "HARASSMENT", "details", "다른 메시지 재신고"
        )).statusCode()).isEqualTo(409);
        assertThat(outsider.post("/reports", Map.of(
            "messageId", messageId, "category", "HARASSMENT", "details", "멤버가 아닌 계정"
        )).statusCode()).isEqualTo(404);
        assertThat(reporter.get("/admin/reports?status=OPEN").statusCode()).isEqualTo(403);
        assertThat(target.get("/admin/reports?status=OPEN").statusCode()).isEqualTo(403);

        JsonNode queue = ok(admin.get("/admin/reports?status=OPEN"));
        JsonNode report = null;
        for (JsonNode item : queue) if (item.path("reportId").asText().equals(reportId)) report = item;
        assertThat(report).isNotNull();
        assertThat(report.path("sourceType").asText()).isEqualTo("DIRECT_MESSAGE");
        assertThat(report.path("targetName").asText()).isEqualTo("DM 신고 대상");
        assertThat(report.path("evidenceText").asText()).isEqualTo(evidence);
        assertThat(report.path("details").asText()).isEqualTo("관리자만 열람할 추가 설명");
        assertThat(db.queryForObject("SELECT target_user_id FROM user_report WHERE report_id=?", String.class, reportId))
            .isEqualTo(targetId);
    }

    @Test void participantReportCanBeReviewedAndKicksTheTargetAcrossWorldNodes() throws Exception {
        db.update("""
            INSERT INTO app_user(id,display_name) VALUES (?, '신고 검토 운영자')
            ON DUPLICATE KEY UPDATE display_name=VALUES(display_name)
            """, REPORT_ADMIN_ID);
        db.update("""
            INSERT INTO oauth_identity(user_id,provider,subject) VALUES (?,'gdg_hufs',?)
            ON DUPLICATE KEY UPDATE user_id=VALUES(user_id)
            """, REPORT_ADMIN_ID, REPORT_ADMIN_SUBJECT);

        Browser admin = signedInAs(REPORT_ADMIN_SUBJECT);
        Browser reporter = signedIn();
        Browser target = signedIn();
        Browser previouslyReportedReporter = signedIn();
        assertThat(admin.patch("profile", Map.of("displayName", "신고 검토 운영자", "avatar", 0)).statusCode()).isEqualTo(200);
        assertThat(reporter.patch("profile", Map.of("displayName", "신고 통합 테스트", "avatar", 1)).statusCode()).isEqualTo(200);
        assertThat(target.patch("profile", Map.of("displayName", "조치 대상 통합 테스트", "avatar", 2)).statusCode()).isEqualTo(200);
        String reportSpaceId = createSpace(reporter, "참가자 신고 통합 공간", "PUBLIC", 20).path("id").asText();
        String targetSpaceId = createSpace(target, "대상자 별도 월드 공간", "PUBLIC", 20).path("id").asText();
        String targetId = json.readTree(target.get("me").body()).path("userId").asText();
        String previousReporterId = json.readTree(previouslyReportedReporter.get("me").body()).path("userId").asText();
        String previousConversationId = UUID.randomUUID().toString();
        String previousPairKey = previousReporterId.compareTo(targetId) < 0
            ? previousReporterId + ":" + targetId : targetId + ":" + previousReporterId;
        db.update("INSERT INTO direct_conversation(id,pair_key) VALUES (?,?)", previousConversationId, previousPairKey);
        db.update("""
            INSERT INTO direct_conversation_member(membership_id,conversation_id,user_id)
            VALUES (UUID(),?,?),(UUID(),?,?)
            """, previousConversationId, previousReporterId, previousConversationId, targetId);
        String previousMessageId = UUID.randomUUID().toString();
        db.update("""
            INSERT INTO direct_message(message_id,conversation_id,sender_user_id,sender_player_id,client_message_id,
                sender_name,sender_avatar,sender_skin,sender_clothing,sender_hair,body,content_hash,sent_at,expires_at)
            VALUES (?,?,?,?,?,'조치 대상 통합 테스트',0,'light','casual_white','hair_short_black',?,? ,
                CURRENT_TIMESTAMP(3)-INTERVAL 1 MINUTE,CURRENT_TIMESTAMP(6)+INTERVAL 1 DAY)
            """, previousMessageId, previousConversationId, targetId, UUID.randomUUID().toString(),
            "dm-before-player-" + previousMessageId, "신고 경로 교차 검증용 DM", "a".repeat(64));
        assertThat(previouslyReportedReporter.post("/reports", Map.of(
            "messageId", previousMessageId, "category", "HARASSMENT", "details", "먼저 DM으로 접수"
        )).statusCode()).isEqualTo(200);
        AdditionalWorld secondaryWorld = startAdditionalWorld();
        Probe reporterSocket = reporter.socketWithTicket(ORIGIN, reporter.ticket(reportSpaceId));
        Probe targetReportSocket = target.socketWithTicket(ORIGIN, target.ticket(reportSpaceId));
        Probe previouslyReportedSocket = previouslyReportedReporter.socketWithTicket(ORIGIN,
            previouslyReportedReporter.ticket(reportSpaceId));
        Probe targetSecondarySocket = target.socketWithTicket(ORIGIN, target.ticket(targetSpaceId), secondaryWorld.port());
        try {
            JsonNode adminAccess = ok(admin.get("/reports/access"));
            assertThat(adminAccess.path("administrator").asBoolean()).isTrue();
            assertThat(ok(reporter.get("/reports/access")).path("administrator").asBoolean()).isFalse();
            assertThat(reporter.get("/admin/reports").statusCode()).isEqualTo(403);

            reporterSocket.join("");
            JsonNode reporterWelcome = reporterSocket.await(node -> node.path("type").asText().equals("welcome"));
            targetReportSocket.join("");
            JsonNode targetWelcome = targetReportSocket.await(node -> node.path("type").asText().equals("welcome"));
            previouslyReportedSocket.join("");
            JsonNode previouslyReportedWelcome = previouslyReportedSocket.await(node -> node.path("type").asText().equals("welcome"));
            targetSecondarySocket.join("");
            targetSecondarySocket.await(node -> node.path("type").asText().equals("welcome"));

            previouslyReportedSocket.send(json.writeValueAsString(Map.of(
                "type", "playerReportRequest", "epoch", previouslyReportedWelcome.path("epoch").asLong(),
                "requestId", "dm-before-player-block-01", "targetId", targetWelcome.path("playerId").asText(),
                "category", "HARASSMENT", "details", "다른 신고 출처의 중복 제한 확인"
            )));
            JsonNode blockedParticipantReport = previouslyReportedSocket.await(node -> node.path("type").asText().equals("playerReportAck")
                && node.path("requestId").asText().equals("dm-before-player-block-01"));
            assertThat(blockedParticipantReport.path("accepted").asBoolean()).isFalse();
            assertThat(blockedParticipantReport.path("code").asText()).isEqualTo("REPORT_TARGET_ALREADY_REPORTED");

            reporterSocket.send(json.writeValueAsString(Map.of(
                "type", "playerReportRequest", "epoch", reporterWelcome.path("epoch").asLong(),
                "requestId", "participant-report-crossworld-01", "targetId", targetWelcome.path("playerId").asText(),
                "category", "HARASSMENT", "details", "운영 검토와 전체 월드 조치를 통합 확인합니다."
            )));
            JsonNode reportAck = reporterSocket.await(node -> node.path("type").asText().equals("playerReportAck")
                && node.path("requestId").asText().equals("participant-report-crossworld-01"));
            assertThat(reportAck.path("accepted").asBoolean()).isTrue();

            String reporterId = json.readTree(reporter.get("me").body()).path("userId").asText();
            String reporterConversationId = UUID.randomUUID().toString();
            String reporterPairKey = reporterId.compareTo(targetId) < 0
                ? reporterId + ":" + targetId : targetId + ":" + reporterId;
            db.update("INSERT INTO direct_conversation(id,pair_key) VALUES (?,?)", reporterConversationId, reporterPairKey);
            db.update("""
                INSERT INTO direct_conversation_member(membership_id,conversation_id,user_id)
                VALUES (UUID(),?,?),(UUID(),?,?)
                """, reporterConversationId, reporterId, reporterConversationId, targetId);
            String reporterMessageId = UUID.randomUUID().toString();
            db.update("""
                INSERT INTO direct_message(message_id,conversation_id,sender_user_id,sender_player_id,client_message_id,
                    sender_name,sender_avatar,sender_skin,sender_clothing,sender_hair,body,content_hash,sent_at,expires_at)
                VALUES (?,?,?,?,?,'조치 대상 통합 테스트',0,'light','casual_white','hair_short_black',?,? ,
                    CURRENT_TIMESTAMP(3)-INTERVAL 1 MINUTE,CURRENT_TIMESTAMP(6)+INTERVAL 1 DAY)
                """, reporterMessageId, reporterConversationId, targetId, UUID.randomUUID().toString(),
                "player-before-dm-" + reporterMessageId, "신고 경로 교차 검증용 DM", "b".repeat(64));
            assertThat(reporter.post("/reports", Map.of(
                "messageId", reporterMessageId, "category", "HARASSMENT", "details", "먼저 참가자 신고 접수"
            )).statusCode()).isEqualTo(409);
            String reportId = db.queryForObject("""
                SELECT report_id FROM user_report
                WHERE reporter_user_id=? AND target_user_id=? AND source_type='PLAYER' AND space_id=?
                ORDER BY created_at DESC LIMIT 1
                """, String.class, reporterId, targetId, reportSpaceId);
            JsonNode openReports = ok(admin.get("/admin/reports?status=OPEN"));
            assertThat(openReports.toString()).contains(reportId, "PLAYER", reportSpaceId, "조치 대상 통합 테스트");

            String reportPath = "/admin/reports/" + reportId;
            JsonNode reviewing = ok(admin.patch(reportPath, Map.of("status", "REVIEWING", "note", "확인 중")));
            assertThat(reviewing.path("status").asText()).isEqualTo("REVIEWING");
            JsonNode kicked = ok(admin.patch(reportPath + "/kick", Map.of(
                "requestId", "participant-report-kick-crossworld-01", "note", "운영 정책 위반 확인"
            )));
            assertThat(kicked.path("report").path("status").asText()).isEqualTo("RESOLVED");
            assertThat(kicked.path("report").path("sourceType").asText()).isEqualTo("PLAYER");
            assertThat(ok(admin.get(reportPath + "/history")).toString()).contains("REVIEWING", "RESOLVED", "신고 검토 운영자");
            assertThat(db.queryForObject("""
                SELECT COUNT(*) FROM user_moderation_action
                WHERE report_id=? AND target_user_id=? AND action_code='WORLD_KICK'
                """, Integer.class, reportId, targetId)).isEqualTo(1);
            java.sql.Timestamp blockedUntil = db.queryForObject(
                "SELECT blocked_until FROM user_world_restriction WHERE user_id=?", java.sql.Timestamp.class, targetId);
            assertThat(blockedUntil.toInstant()).isAfter(java.time.Instant.now());

            JsonNode localKick = targetReportSocket.await(node -> node.path("type").asText().equals("error")
                && node.path("code").asText().equals("MODERATION_KICKED"));
            JsonNode remoteKick = targetSecondarySocket.await(node -> node.path("type").asText().equals("error")
                && node.path("code").asText().equals("MODERATION_KICKED"));
            assertThat(localKick.path("message").asText()).contains("운영 조치");
            assertThat(remoteKick.path("message").asText()).contains("운영 조치");

            assertThat(admin.patch(reportPath + "/kick", Map.of(
                "requestId", "participant-report-kick-crossworld-01", "note", "운영 정책 위반 확인"
            )).statusCode()).isEqualTo(200);
            assertThat(db.queryForObject("SELECT COUNT(*) FROM user_moderation_action WHERE report_id=?",
                Integer.class, reportId)).isEqualTo(1);
        } finally {
            reporterSocket.socket.abort();
            targetReportSocket.socket.abort();
            previouslyReportedSocket.socket.abort();
            targetSecondarySocket.socket.abort();
            secondaryWorld.close();
        }
    }

    @Test void concurrentDirectMessageAndParticipantReportsForOneTargetCommitOnlyOnce() throws Exception {
        Browser reporter = signedIn();
        Browser target = signedIn();
        String reporterId = json.readTree(reporter.get("me").body()).path("userId").asText();
        String targetId = json.readTree(target.get("me").body()).path("userId").asText();
        String spaceId = createSpace(reporter, "동시 신고 중복 방지 공간", "PUBLIC", 20).path("id").asText();
        String conversationId = createDirectConversation(reporterId, targetId);
        String messageId = UUID.randomUUID().toString();
        db.update("""
            INSERT INTO direct_message(message_id,conversation_id,sender_user_id,sender_player_id,client_message_id,
                sender_name,sender_avatar,sender_skin,sender_clothing,sender_hair,body,content_hash,sent_at,expires_at)
            VALUES (?,?,?,?,?,'동시 신고 대상',0,'light','casual_white','hair_short_black',?,? ,
                CURRENT_TIMESTAMP(3)-INTERVAL 1 MINUTE,CURRENT_TIMESTAMP(6)+INTERVAL 1 DAY)
            """, messageId, conversationId, targetId, UUID.randomUUID().toString(),
            "concurrent-report-" + messageId, "동시 신고 테스트 원문", "c".repeat(64));

        Probe reporterSocket = reporter.socketWithTicket(ORIGIN, reporter.ticket(spaceId));
        Probe targetSocket = target.socketWithTicket(ORIGIN, target.ticket(spaceId));
        ExecutorService contenders = Executors.newFixedThreadPool(2);
        CountDownLatch start = new CountDownLatch(1);
        try {
            reporterSocket.join("");
            JsonNode reporterWelcome = reporterSocket.await(node -> node.path("type").asText().equals("welcome"));
            targetSocket.join("");
            JsonNode targetWelcome = targetSocket.await(node -> node.path("type").asText().equals("welcome"));

            Future<HttpResponse<String>> directMessageReport = contenders.submit(() -> {
                start.await();
                return reporter.post("/reports", Map.of("messageId", messageId,
                    "category", "HARASSMENT", "details", "동시 신고 요청"));
            });
            Future<?> participantReport = contenders.submit(() -> {
                start.await();
                reporterSocket.send(json.writeValueAsString(Map.of(
                    "type", "playerReportRequest", "epoch", reporterWelcome.path("epoch").asLong(),
                    "requestId", "concurrent-cross-source-01", "targetId", targetWelcome.path("playerId").asText(),
                    "category", "HARASSMENT", "details", "동시 신고 요청"
                )));
                return null;
            });
            start.countDown();
            HttpResponse<String> directResponse = directMessageReport.get(20, TimeUnit.SECONDS);
            participantReport.get(20, TimeUnit.SECONDS);
            JsonNode participantAck = reporterSocket.await(node -> node.path("type").asText().equals("playerReportAck")
                && node.path("requestId").asText().equals("concurrent-cross-source-01"));

            boolean directAccepted = directResponse.statusCode() == 200;
            boolean participantAccepted = participantAck.path("accepted").asBoolean();
            assertThat(directAccepted ^ participantAccepted)
                .as("exactly one cross-source report must win, API status=%s, World ack=%s",
                    directResponse.statusCode(), participantAck)
                .isTrue();
            assertThat(db.queryForObject("""
                SELECT COUNT(*) FROM user_report
                WHERE reporter_user_id=? AND target_user_id=? AND created_at>=CURRENT_TIMESTAMP(6)-INTERVAL 1 DAY
                """, Integer.class, reporterId, targetId)).isEqualTo(1);
        } finally {
            start.countDown();
            contenders.shutdownNow();
            reporterSocket.socket.abort();
            targetSocket.socket.abort();
        }
    }

    @Test void participantMediaMutePropagatesFromAdminApiToWorldAndSfuPolicy() throws Exception {
        db.update("""
            INSERT INTO app_user(id,display_name) VALUES (?, '신고 검토 운영자')
            ON DUPLICATE KEY UPDATE display_name=VALUES(display_name)
            """, REPORT_ADMIN_ID);
        db.update("""
            INSERT INTO oauth_identity(user_id,provider,subject) VALUES (?,'gdg_hufs',?)
            ON DUPLICATE KEY UPDATE user_id=VALUES(user_id)
            """, REPORT_ADMIN_ID, REPORT_ADMIN_SUBJECT);

        Browser admin = signedInAs(REPORT_ADMIN_SUBJECT);
        Browser reporter = signedIn();
        Browser target = signedIn();
        admin.patch("profile", Map.of("displayName", "신고 검토 운영자", "avatar", 0));
        reporter.patch("profile", Map.of("displayName", "미디어 신고자", "avatar", 1));
        target.patch("profile", Map.of("displayName", "미디어 조치 대상", "avatar", 2));
        String reportSpaceId = createSpace(reporter, "미디어 신고 검증 공간", "PUBLIC", 20).path("id").asText();
        String otherSpaceId = createSpace(target, "미디어 조치 다른 공간", "PUBLIC", 20).path("id").asText();

        try (RecordingMediaControl reportMedia = startRecordingMediaControl();
             RecordingMediaControl otherMedia = startRecordingMediaControl();
             AdditionalWorld reportWorld = startAdditionalWorld(reportMedia.endpoint(),
                 "hufs-town-integration-media-control-token-02");
             AdditionalWorld otherWorld = startAdditionalWorld(otherMedia.endpoint(),
                 "hufs-town-integration-media-control-token-02")) {
            Probe reporterSocket = reporter.socketWithTicket(ORIGIN, reporter.ticket(reportSpaceId), reportWorld.port());
            Probe targetReportSocket = target.socketWithTicket(ORIGIN, target.ticket(reportSpaceId), reportWorld.port());
            Probe targetOtherSocket = target.socketWithTicket(ORIGIN, target.ticket(otherSpaceId), otherWorld.port());
            try {
                reporterSocket.join("");
                JsonNode reporterWelcome = reporterSocket.await(node -> node.path("type").asText().equals("welcome"));
                targetReportSocket.join("");
                JsonNode targetWelcome = targetReportSocket.await(node -> node.path("type").asText().equals("welcome"));
                targetOtherSocket.join("");
                JsonNode otherWelcome = targetOtherSocket.await(node -> node.path("type").asText().equals("welcome"));
                JsonNode initialState = targetReportSocket.await(node -> node.path("type").asText().equals("mediaState")
                    && node.path("available").asBoolean() && node.path("moderatedSources").isEmpty());
                JsonNode initialOtherState = targetOtherSocket.await(node -> node.path("type").asText().equals("mediaState")
                    && node.path("available").asBoolean() && node.path("moderatedSources").isEmpty());
                reportMedia.awaitPolicy(targetWelcome.path("playerId").asText(), person -> person.path("sources").size() == 4);
                otherMedia.awaitPolicy(otherWelcome.path("playerId").asText(), person -> person.path("sources").size() == 4);

                reporterSocket.send(json.writeValueAsString(Map.of(
                    "type", "playerReportRequest", "epoch", reporterWelcome.path("epoch").asLong(),
                    "requestId", "participant-media-mute-crossworld-01",
                    "targetId", targetWelcome.path("playerId").asText(),
                    "category", "HARASSMENT", "details", "화면 공유와 마이크 제한 전달을 확인합니다."
                )));
                JsonNode reportAck = reporterSocket.await(node -> node.path("type").asText().equals("playerReportAck")
                    && node.path("requestId").asText().equals("participant-media-mute-crossworld-01"));
                assertThat(reportAck.path("accepted").asBoolean()).isTrue();
                String reporterId = json.readTree(reporter.get("me").body()).path("userId").asText();
                String targetId = json.readTree(target.get("me").body()).path("userId").asText();
                String reportId = db.queryForObject("""
                    SELECT report_id FROM user_report
                    WHERE reporter_user_id=? AND target_user_id=? AND source_type='PLAYER' AND space_id=?
                    ORDER BY created_at DESC LIMIT 1
                    """, String.class, reporterId, targetId, reportSpaceId);

                JsonNode applied = ok(admin.patch("/admin/reports/" + reportId + "/media-mute", Map.of(
                    "requestId", "participant-media-mute-crossworld-action-01",
                    "durationMinutes", 60, "note", "미디어 제한 전달 검증"
                )));
                assertThat(applied.path("report").path("status").asText()).isEqualTo("RESOLVED");
                assertThat(applied.path("effectiveUntil").asLong()).isGreaterThan(System.currentTimeMillis());
                assertThat(db.queryForObject("""
                    SELECT COUNT(*) FROM user_moderation_action
                    WHERE report_id=? AND target_user_id=? AND action_code='MEDIA_MUTE'
                    """, Integer.class, reportId, targetId)).isEqualTo(1);
                assertThat(db.queryForObject("SELECT COUNT(*) FROM user_media_mute WHERE user_id=?", Integer.class,
                    targetId)).isEqualTo(1);

                JsonNode muted = targetReportSocket.await(node -> node.path("type").asText().equals("mediaState")
                    && node.path("moderatedSources").size() == 4);
                JsonNode mutedOther = targetOtherSocket.await(node -> node.path("type").asText().equals("mediaState")
                    && node.path("moderatedSources").size() == 4);
                assertThat(muted.path("moderatedSources").toString()).contains("MICROPHONE", "CAMERA", "SCREEN", "SCREEN_AUDIO");
                assertThat(mutedOther.path("moderatedSources").toString()).contains("MICROPHONE", "CAMERA", "SCREEN", "SCREEN_AUDIO");
                assertThat(muted.path("policyEpoch").asLong()).isGreaterThan(initialState.path("policyEpoch").asLong());
                assertThat(mutedOther.path("policyEpoch").asLong()).isGreaterThan(initialOtherState.path("policyEpoch").asLong());
                reportMedia.awaitPolicy(targetWelcome.path("playerId").asText(), person -> person.path("sources").isEmpty());
                otherMedia.awaitPolicy(otherWelcome.path("playerId").asText(), person -> person.path("sources").isEmpty());

                assertThat(ok(admin.get("/admin/reports/" + reportId + "/history")).toString())
                    .contains("RESOLVED", "신고 검토 운영자", "마이크·카메라·화면 공유 제한");
                assertThat(admin.patch("/admin/reports/" + reportId + "/media-mute", Map.of(
                    "requestId", "participant-media-mute-crossworld-action-01",
                    "durationMinutes", 60, "note", "미디어 제한 전달 검증"
                )).statusCode()).isEqualTo(200);
                assertThat(db.queryForObject("SELECT COUNT(*) FROM user_moderation_action WHERE report_id=?",
                    Integer.class, reportId)).isEqualTo(1);
            } finally {
                reporterSocket.socket.abort();
                targetReportSocket.socket.abort();
                targetOtherSocket.socket.abort();
            }
        }
    }

    @Test void reportedGuestRestrictionsFollowBrowserAcrossSessionsAndWorlds() throws Exception {
        db.update("""
            INSERT INTO app_user(id,display_name) VALUES (?, '신고 검토 운영자')
            ON DUPLICATE KEY UPDATE display_name=VALUES(display_name)
            """, REPORT_ADMIN_ID);
        db.update("""
            INSERT INTO oauth_identity(user_id,provider,subject) VALUES (?,'gdg_hufs',?)
            ON DUPLICATE KEY UPDATE user_id=VALUES(user_id)
            """, REPORT_ADMIN_ID, REPORT_ADMIN_SUBJECT);

        Browser owner = signedIn();
        Browser admin = signedInAs(REPORT_ADMIN_SUBJECT);
        Browser reporterChat = signedIn();
        Browser reporterMedia = signedIn();
        Browser reporterKick = signedIn();
        String reportSpaceId = json.readTree(owner.post("/spaces", Map.of("name", "게스트 운영 신고 공간",
            "description", "", "visibility", "PUBLIC", "capacity", 20, "guestEntryEnabled", true)).body())
            .path("id").asText();
        String otherSpaceId = json.readTree(owner.post("/spaces", Map.of("name", "게스트 운영 다른 공간",
            "description", "", "visibility", "PUBLIC", "capacity", 20, "guestEntryEnabled", true)).body())
            .path("id").asText();

        Browser guest = new Browser();
        Map<String, Object> guestProfile = Map.of("name", "신고 대상 게스트", "avatar", 1, "skin", "light",
            "clothing", "casual_white", "hair", "hair_short_black");
        HttpResponse<String> initialGuestAdmission = guest.post("/guest/spaces/" + reportSpaceId + "/admission", guestProfile);
        JsonNode guestAdmission = ok(initialGuestAdmission);
        JsonNode guestOtherAdmission = ok(guest.post("/guest/spaces/" + otherSpaceId + "/admission", Map.of()));
        String guestBrowserToken = guest.guestCookie();
        assertThat(guestBrowserToken).matches("[A-Za-z0-9_-]{43}");
        assertThat(initialGuestAdmission.headers().allValues("set-cookie").toString())
            .contains("HUFS_TOWN_GUEST=", "HttpOnly", "SameSite=Lax", "Path=/api/v1/guest", "Max-Age=16416000")
            .doesNotContain("Secure"); // This integration profile deliberately uses loopback HTTP.
        String reportTicket = guestAdmission.path("ticket").asText();
        String otherTicket = guestOtherAdmission.path("ticket").asText();
        String guestSessionId = new String(Base64.getDecoder().decode(guest.cookie()), java.nio.charset.StandardCharsets.UTF_8);
        var guestSession = sessions.findById(guestSessionId);
        var identity = (town.hufs.auth.GuestIdentity) guestSession.getAttribute(town.hufs.auth.GuestIdentity.SESSION_ATTRIBUTE);
        String guestId = identity.guestId();
        assertThat(guestBrowserToken).isNotEqualTo(guestId);
        assertThat(db.queryForObject("SELECT COUNT(*) FROM app_user WHERE id=?", Integer.class, guestId)).isZero();

        try (RecordingMediaControl reportMedia = startRecordingMediaControl();
             RecordingMediaControl otherMedia = startRecordingMediaControl();
             AdditionalWorld reportWorld = startAdditionalWorld(reportMedia.endpoint(),
                 "hufs-town-integration-media-control-token-02");
             AdditionalWorld otherWorld = startAdditionalWorld(otherMedia.endpoint(),
                 "hufs-town-integration-media-control-token-02")) {
            Probe chatReporter = reporterChat.socketWithTicket(ORIGIN, reporterChat.ticket(reportSpaceId), reportWorld.port());
            Probe mediaReporter = reporterMedia.socketWithTicket(ORIGIN, reporterMedia.ticket(reportSpaceId), reportWorld.port());
            Probe kickReporter = reporterKick.socketWithTicket(ORIGIN, reporterKick.ticket(reportSpaceId), reportWorld.port());
            Probe guestReportSocket = guest.socketWithTicket(ORIGIN, reportTicket, reportWorld.port());
            Probe guestOtherSocket = guest.socketWithTicket(ORIGIN, otherTicket, otherWorld.port());
            try {
                chatReporter.join("");
                JsonNode chatReporterWelcome = chatReporter.await(node -> node.path("type").asText().equals("welcome"));
                mediaReporter.join("");
                JsonNode mediaReporterWelcome = mediaReporter.await(node -> node.path("type").asText().equals("welcome"));
                kickReporter.join("");
                JsonNode kickReporterWelcome = kickReporter.await(node -> node.path("type").asText().equals("welcome"));
                guestReportSocket.join("");
                JsonNode guestWelcome = guestReportSocket.await(node -> node.path("type").asText().equals("welcome"));
                guestOtherSocket.join("");
                JsonNode guestOtherWelcome = guestOtherSocket.await(node -> node.path("type").asText().equals("welcome"));
                guestReportSocket.await(node -> node.path("type").asText().equals("mediaState")
                    && node.path("available").asBoolean() && node.path("moderatedSources").isEmpty());
                guestOtherSocket.await(node -> node.path("type").asText().equals("mediaState")
                    && node.path("available").asBoolean() && node.path("moderatedSources").isEmpty());

                String chatReporterId = json.readTree(reporterChat.get("me").body()).path("userId").asText();
                String mediaReporterId = json.readTree(reporterMedia.get("me").body()).path("userId").asText();
                String kickReporterId = json.readTree(reporterKick.get("me").body()).path("userId").asText();
                String guestPlayerId = guestWelcome.path("playerId").asText();
                String chatReportId = submitParticipantReport(reporterChat, chatReporter, chatReporterWelcome,
                    guestPlayerId, "guest-chat-report-0001", reportSpaceId, guestId);
                assertThat(json.readTree(admin.get("/admin/reports?status=OPEN").body()).toString())
                    .contains(chatReportId, "GUEST", "신고 대상 게스트");
                JsonNode chatApplied = ok(admin.patch("/admin/reports/" + chatReportId + "/chat-mute", Map.of(
                    "requestId", "guest-chat-mute-action-0001", "durationMinutes", 60, "note", "게스트 채팅 제한 검증"
                )));
                assertThat(chatApplied.path("report").path("targetType").asText()).isEqualTo("GUEST");
                assertThat(db.queryForObject("SELECT COUNT(*) FROM guest_moderation_restriction WHERE guest_id=? AND chat_muted_until>CURRENT_TIMESTAMP(6)",
                    Integer.class, guestId)).isEqualTo(1);
                assertThat(db.queryForObject("SELECT COUNT(*) FROM user_moderation_action WHERE report_id=? AND target_guest_id=? AND action_code='CHAT_MUTE'",
                    Integer.class, chatReportId, guestId)).isEqualTo(1);
                Thread.sleep(1200);
                guestReportSocket.send(json.writeValueAsString(Map.of("type", "chatSend", "clientMessageId", "guest-muted-chat-0001",
                    "epoch", guestWelcome.path("epoch").asLong(), "channel", "nearby", "conversationId", "",
                    "text", "제한된 게스트 채팅")));
                JsonNode chatDenied = guestReportSocket.await(node -> node.path("type").asText().equals("chatAck")
                    && node.path("clientMessageId").asText().equals("guest-muted-chat-0001"));
                assertThat(chatDenied.path("accepted").asBoolean()).isFalse();
                assertThat(chatDenied.path("code").asText()).isEqualTo("CHAT_RESTRICTED");

                String mediaReportId = submitParticipantReport(reporterMedia, mediaReporter, mediaReporterWelcome,
                    guestPlayerId, "guest-media-report-0001", reportSpaceId, guestId);
                JsonNode mediaApplied = ok(admin.patch("/admin/reports/" + mediaReportId + "/media-mute", Map.of(
                    "requestId", "guest-media-mute-action-0001", "durationMinutes", 60, "note", "게스트 미디어 제한 검증"
                )));
                assertThat(mediaApplied.path("report").path("targetType").asText()).isEqualTo("GUEST");
                JsonNode guestMuted = guestReportSocket.await(node -> node.path("type").asText().equals("mediaState")
                    && node.path("moderatedSources").size() == 4);
                JsonNode guestOtherMuted = guestOtherSocket.await(node -> node.path("type").asText().equals("mediaState")
                    && node.path("moderatedSources").size() == 4);
                assertThat(guestMuted.path("moderatedSources").toString()).contains("MICROPHONE", "CAMERA", "SCREEN", "SCREEN_AUDIO");
                assertThat(guestOtherMuted.path("moderatedSources").toString()).contains("MICROPHONE", "CAMERA", "SCREEN", "SCREEN_AUDIO");
                reportMedia.awaitPolicy(guestPlayerId, person -> person.path("sources").isEmpty());
                otherMedia.awaitPolicy(guestOtherWelcome.path("playerId").asText(), person -> person.path("sources").isEmpty());
                assertThat(db.queryForObject("SELECT COUNT(*) FROM guest_moderation_restriction WHERE guest_id=? AND media_muted_until>CURRENT_TIMESTAMP(6)",
                    Integer.class, guestId)).isEqualTo(1);

                String kickReportId = submitParticipantReport(reporterKick, kickReporter, kickReporterWelcome,
                    guestPlayerId, "guest-kick-report-0001", reportSpaceId, guestId);
                JsonNode kickApplied = ok(admin.patch("/admin/reports/" + kickReportId + "/kick", Map.of(
                    "requestId", "guest-kick-action-0001", "note", "게스트 전체 공간 퇴장 검증"
                )));
                assertThat(kickApplied.path("report").path("targetType").asText()).isEqualTo("GUEST");
                assertThat(db.queryForObject("SELECT COUNT(*) FROM guest_moderation_restriction WHERE guest_id=? AND blocked_until>CURRENT_TIMESTAMP(6)",
                    Integer.class, guestId)).isEqualTo(1);
                JsonNode reportKick = guestReportSocket.await(node -> node.path("type").asText().equals("error")
                    && node.path("code").asText().equals("MODERATION_KICKED"));
                JsonNode otherKick = guestOtherSocket.await(node -> node.path("type").asText().equals("error")
                    && node.path("code").asText().equals("MODERATION_KICKED"));
                assertThat(reportKick.path("message").asText()).contains("운영 조치");
                assertThat(otherKick.path("message").asText()).contains("운영 조치");

                HttpResponse<String> reentryResponse = null;
                for (int attempt = 0; attempt < 20; attempt++) {
                    reentryResponse = guest.post("/guest/spaces/" + reportSpaceId + "/admission", Map.of());
                    if (reentryResponse.statusCode() == 200) break;
                    Thread.sleep(100);
                }
                assertThat(reentryResponse).isNotNull();
                JsonNode reentry = ok(reentryResponse);
                Probe blockedReentry = guest.socketWithTicket(ORIGIN, reentry.path("ticket").asText(), reportWorld.port());
                try {
                    blockedReentry.join("");
                    blockedReentry.await(node -> node.path("type").asText().equals("welcome"));
                    JsonNode reentryDenied = blockedReentry.await(node -> node.path("type").asText().equals("error")
                        && node.path("code").asText().equals("MODERATION_KICKED"));
                    assertThat(reentryDenied.path("message").asText()).contains("운영 조치");
                } finally { blockedReentry.socket.abort(); }

                // Clearing the short Redis session must not discard this browser's guest sanction identity.
                String oldSessionCookie = guest.cookie();
                assertThat(guest.delete("/guest/session", Map.of()).statusCode()).isEqualTo(200);
                assertThat(guest.guestCookie()).isEqualTo(guestBrowserToken);
                JsonNode afterClearAdmission = ok(guest.post("/guest/spaces/" + reportSpaceId + "/admission", guestProfile));
                assertThat(guest.cookie()).isNotEqualTo(oldSessionCookie);
                assertThat(guestIdentityId(guest)).isEqualTo(guestId);
                Probe afterClearBlocked = guest.socketWithTicket(ORIGIN, afterClearAdmission.path("ticket").asText(), reportWorld.port());
                try {
                    afterClearBlocked.join("");
                    afterClearBlocked.await(node -> node.path("type").asText().equals("welcome"));
                    assertThat(afterClearBlocked.await(node -> node.path("type").asText().equals("error")
                        && node.path("code").asText().equals("MODERATION_KICKED")).path("code").asText())
                        .isEqualTo("MODERATION_KICKED");
                } finally { afterClearBlocked.socket.abort(); }

                // Redis expiry/recreation is a separate HTTP session but retains the browser-scoped pseudonym.
                String expiredSessionCookie = guest.cookie();
                String expiredSessionId = new String(Base64.getDecoder().decode(expiredSessionCookie), java.nio.charset.StandardCharsets.UTF_8);
                sessions.deleteById(expiredSessionId);
                JsonNode afterExpiryAdmission = ok(guest.post("/guest/spaces/" + reportSpaceId + "/admission", guestProfile));
                assertThat(guest.cookie()).isNotEqualTo(expiredSessionCookie);
                assertThat(guest.guestCookie()).isEqualTo(guestBrowserToken);
                assertThat(guestIdentityId(guest)).isEqualTo(guestId);
                Probe afterExpiryBlocked = guest.socketWithTicket(ORIGIN, afterExpiryAdmission.path("ticket").asText(), reportWorld.port());
                try {
                    afterExpiryBlocked.join("");
                    afterExpiryBlocked.await(node -> node.path("type").asText().equals("welcome"));
                    assertThat(afterExpiryBlocked.await(node -> node.path("type").asText().equals("error")
                        && node.path("code").asText().equals("MODERATION_KICKED")).path("code").asText())
                        .isEqualTo("MODERATION_KICKED");
                } finally { afterExpiryBlocked.socket.abort(); }

                // No guest cookie means a new browser-scoped subject; this is intentionally not an account/person ban.
                Browser freshBrowser = new Browser();
                assertThat(freshBrowser.guestCookie()).isEmpty();
                JsonNode freshAdmission = ok(freshBrowser.post("/guest/spaces/" + reportSpaceId + "/admission", guestProfile));
                assertThat(freshBrowser.guestCookie()).isNotBlank().isNotEqualTo(guestBrowserToken);
                assertThat(guestIdentityId(freshBrowser)).isNotEqualTo(guestId);
                Probe freshBrowserSocket = freshBrowser.socketWithTicket(ORIGIN, freshAdmission.path("ticket").asText(), reportWorld.port());
                try {
                    freshBrowserSocket.join("");
                    JsonNode freshWelcome = freshBrowserSocket.await(node -> node.path("type").asText().equals("welcome"));
                    String freshPlayerId = freshWelcome.path("playerId").asText();
                    freshBrowserSocket.await(node -> node.path("type").asText().equals("snapshot")
                        && freshBrowserSocket.visiblePlayers.containsKey(freshPlayerId));
                } finally { freshBrowserSocket.socket.abort(); }

                assertThat(db.queryForObject("SELECT COUNT(*) FROM app_user WHERE id=?", Integer.class, guestId)).isZero();
                assertThat(db.queryForObject("SELECT COUNT(*) FROM user_moderation_action WHERE target_guest_id=?",
                    Integer.class, guestId)).isEqualTo(3);

                // Logging in from the restricted guest browser carries all active restrictions to the account.
                String loginState = guest.start();
                String accountSubject = UUID.randomUUID().toString();
                expectUser(accountSubject, "ATTENDING");
                assertThat(guest.post("exchange", Map.of("code", UUID.randomUUID().toString(), "state", loginState)).statusCode())
                    .isEqualTo(200);
                String accountId = json.readTree(guest.get("me").body()).path("userId").asText();
                assertThat((Object) sessions.findById(new String(Base64.getDecoder().decode(guest.cookie()),
                    java.nio.charset.StandardCharsets.UTF_8)).getAttribute(town.hufs.auth.GuestIdentity.SESSION_ATTRIBUTE)).isNull();
                assertThat(db.queryForObject("SELECT COUNT(*) FROM user_chat_restriction WHERE user_id=? AND muted_until>CURRENT_TIMESTAMP(6)",
                    Integer.class, accountId)).isEqualTo(1);
                assertThat(db.queryForObject("SELECT COUNT(*) FROM user_media_mute WHERE user_id=? AND muted_until>CURRENT_TIMESTAMP(6)",
                    Integer.class, accountId)).isEqualTo(1);
                assertThat(db.queryForObject("SELECT COUNT(*) FROM user_world_restriction WHERE user_id=? AND blocked_until>CURRENT_TIMESTAMP(6)",
                    Integer.class, accountId)).isEqualTo(1);
                Probe upgradedBlocked = guest.socketWithTicket(ORIGIN, guest.ticket(reportSpaceId), reportWorld.port());
                try {
                    upgradedBlocked.join("");
                    upgradedBlocked.await(node -> node.path("type").asText().equals("welcome"));
                    JsonNode accountDenied = upgradedBlocked.await(node -> node.path("type").asText().equals("error")
                        && node.path("code").asText().equals("MODERATION_KICKED"));
                    assertThat(accountDenied.path("message").asText()).contains("운영 조치");
                } finally { upgradedBlocked.socket.abort(); }
            } finally {
                chatReporter.socket.abort();
                mediaReporter.socket.abort();
                kickReporter.socket.abort();
                guestReportSocket.socket.abort();
                guestOtherSocket.socket.abort();
            }
        }
    }

    @Test void joinRequestMovesOnlyAfterTheTargetApproves() throws Exception {
        Browser requester = signedIn();
        Browser target = signedIn();
        String spaceId = createSpace(requester, "합류 요청 통합 공간", "PUBLIC", 20).path("id").asText();
        Probe requesterSocket = requester.socketWithTicket(ORIGIN, requester.ticket(spaceId));
        Probe targetSocket = target.socketWithTicket(ORIGIN, target.ticket(spaceId));
        try {
            requesterSocket.join("");
            JsonNode requesterWelcome = requesterSocket.await(node -> node.path("type").asText().equals("welcome"));
            targetSocket.join("");
            JsonNode targetWelcome = targetSocket.await(node -> node.path("type").asText().equals("welcome"));
            String requesterId = requesterWelcome.path("playerId").asText();
            String targetId = targetWelcome.path("playerId").asText();
            requesterSocket.await(node -> node.path("type").asText().equals("snapshot")
                && requesterSocket.visiblePlayers.containsKey(requesterId)
                && requesterSocket.visiblePlayers.containsKey(targetId));
            assertThat(requesterSocket.visiblePlayers.keySet()).contains(requesterId, targetId);

            String requestId = "join-integration-" + UUID.randomUUID();
            requesterSocket.send(json.writeValueAsString(Map.of(
                "type", "joinRequest", "epoch", requesterWelcome.path("epoch").asLong(),
                "requestId", requestId, "targetId", targetId
            )));
            JsonNode requestAck = requesterSocket.await(node -> node.path("type").asText().equals("joinRequestAck")
                && node.path("requestId").asText().equals(requestId));
            assertThat(requestAck.path("accepted").asBoolean()).isTrue();
            JsonNode requestEvent = targetSocket.await(node -> node.path("type").asText().equals("joinRequestEvent")
                && node.path("requestId").asText().equals(requestId));
            assertThat(requestEvent.path("senderId").asText()).isEqualTo(requesterId);

            targetSocket.send(json.writeValueAsString(Map.of(
                "type", "joinResponse", "epoch", targetWelcome.path("epoch").asLong(),
                "requestId", requestId, "accepted", true
            )));
            JsonNode result = requesterSocket.await(node -> node.path("type").asText().equals("joinResult")
                && node.path("requestId").asText().equals(requestId));
            assertThat(result.path("accepted").asBoolean()).isTrue();
            assertThat(result.path("moved").asBoolean()).isTrue();

            requesterSocket.await(node -> node.path("type").asText().equals("snapshot")
                && requesterSocket.visiblePlayers.containsKey(requesterId)
                && requesterSocket.visiblePlayers.containsKey(targetId)
                && Math.hypot(requesterSocket.visiblePlayers.get(requesterId).path("x").asDouble()
                    - requesterSocket.visiblePlayers.get(targetId).path("x").asDouble(),
                    requesterSocket.visiblePlayers.get(requesterId).path("y").asDouble()
                    - requesterSocket.visiblePlayers.get(targetId).path("y").asDouble()) >= .5);
            JsonNode movedRequester = requesterSocket.visiblePlayers.get(requesterId);
            JsonNode targetPlayer = requesterSocket.visiblePlayers.get(targetId);
            double distance = Math.hypot(movedRequester.path("x").asDouble() - targetPlayer.path("x").asDouble(),
                movedRequester.path("y").asDouble() - targetPlayer.path("y").asDouble());
            assertThat(distance).isBetween(.5, 4.1);
        } finally {
            requesterSocket.socket.abort();
            targetSocket.socket.abort();
        }
    }

    @Test void friendRequestsRequireConsentAndRespectPrivacyAndBlocks() throws Exception {
        Browser first = signedIn();
        Browser second = signedIn();
        Browser privateAccount = signedIn();
        String firstId = json.readTree(first.get("me").body()).path("userId").asText();
        String secondId = json.readTree(second.get("me").body()).path("userId").asText();
        String privateId = json.readTree(privateAccount.get("me").body()).path("userId").asText();

        assertThat(first.post("/me/friends/requests", Map.of("targetUserId", firstId)).statusCode()).isEqualTo(400);
        ok(privateAccount.put("/me/friends/preferences", Map.of("allowFriendRequests", false)));
        assertThat(first.post("/me/friends/requests", Map.of("targetUserId", privateId)).statusCode()).isEqualTo(404);

        JsonNode request = ok(first.post("/me/friends/requests", Map.of("targetUserId", secondId)));
        assertThat(request.path("status").asText()).isEqualTo("PENDING");
        JsonNode repeated = ok(first.post("/me/friends/requests", Map.of("targetUserId", secondId)));
        assertThat(repeated.path("id").asText()).isEqualTo(request.path("id").asText());
        assertThat(ok(first.get("/me/friends")).path("friends")).isEmpty();
        assertThat(ok(first.get("/me/friends")).path("outgoing").get(0).path("userId").asText()).isEqualTo(secondId);
        assertThat(ok(second.get("/me/friends")).path("incoming").get(0).path("userId").asText()).isEqualTo(firstId);
        assertThat(first.post("/me/friends/requests/" + request.path("id").asText() + "/respond",
            Map.of("decision", "ACCEPT")).statusCode()).isEqualTo(409);

        assertThat(ok(second.post("/me/friends/requests/" + request.path("id").asText() + "/respond",
            Map.of("decision", "ACCEPT"))).path("status").asText()).isEqualTo("ACCEPTED");
        assertThat(ok(first.get("/me/friends")).path("friends").get(0).path("userId").asText()).isEqualTo(secondId);
        assertThat(ok(second.get("/me/friends")).path("friends").get(0).path("userId").asText()).isEqualTo(firstId);
        assertThat(first.delete("/me/friends/" + secondId, Map.of()).statusCode()).isEqualTo(200);

        JsonNode reciprocal = ok(first.post("/me/friends/requests", Map.of("targetUserId", secondId)));
        assertThat(reciprocal.path("status").asText()).isEqualTo("PENDING");
        JsonNode crossed = ok(second.post("/me/friends/requests", Map.of("targetUserId", firstId)));
        assertThat(crossed.path("status").asText()).isEqualTo("ACCEPTED");

        db.update("""
            INSERT INTO user_block(block_id,blocker_user_id,blocked_user_id,blocked_display_name)
            VALUES (?,?,?,'차단 대상')
            """, UUID.randomUUID().toString(), firstId, secondId);
        assertThat(ok(first.get("/me/friends")).path("friends")).isEmpty();
        assertThat(ok(second.get("/me/friends")).path("friends")).isEmpty();
        assertThat(first.post("/me/friends/requests", Map.of("targetUserId", secondId)).statusCode()).isEqualTo(404);
    }

    @Test void friendPushOutboxFollowsRecipientPreferenceAndFriendshipState() throws Exception {
        Browser sender = signedIn();
        Browser recipient = signedIn();
        Browser optedOutRecipient = signedIn();
        String senderId = json.readTree(sender.get("me").body()).path("userId").asText();
        String recipientId = json.readTree(recipient.get("me").body()).path("userId").asText();
        String optedOutRecipientId = json.readTree(optedOutRecipient.get("me").body()).path("userId").asText();

        JsonNode defaultPreferences = ok(recipient.get("/me/friends/preferences"));
        assertThat(defaultPreferences.path("allowFriendNotifications").asBoolean()).isTrue();
        JsonNode created = ok(sender.post("/me/friends/requests", Map.of("targetUserId", recipientId)));
        String friendshipId = created.path("id").asText();
        assertThat(db.queryForObject("""
            SELECT COUNT(*) FROM social_push_outbox
            WHERE friendship_id=? AND event_type='FRIEND_REQUEST' AND recipient_user_id=? AND actor_user_id=?
            """, Integer.class, friendshipId, recipientId, senderId)).isEqualTo(1);

        ok(sender.post("/me/friends/requests", Map.of("targetUserId", recipientId)));
        assertThat(db.queryForObject("SELECT COUNT(*) FROM social_push_outbox WHERE friendship_id=?",
            Integer.class, friendshipId)).isEqualTo(1);
        ok(recipient.post("/me/friends/requests/" + friendshipId + "/respond", Map.of("decision", "ACCEPT")));
        assertThat(db.queryForObject("""
            SELECT COUNT(*) FROM social_push_outbox
            WHERE friendship_id=? AND event_type='FRIEND_ACCEPTED' AND recipient_user_id=? AND actor_user_id=?
            """, Integer.class, friendshipId, senderId, recipientId)).isEqualTo(1);

        ok(optedOutRecipient.put("/me/friends/preferences", Map.of(
            "allowFriendRequests", true, "allowFriendNotifications", false)));
        JsonNode optedOutRequest = ok(sender.post("/me/friends/requests", Map.of("targetUserId", optedOutRecipientId)));
        assertThat(db.queryForObject("SELECT COUNT(*) FROM social_push_outbox WHERE friendship_id=?",
            Integer.class, optedOutRequest.path("id").asText())).isZero();
        assertThat(ok(optedOutRecipient.get("/me/friends/preferences")).path("allowFriendNotifications").asBoolean()).isFalse();
    }

    @Test void friendPresenceIsVisibleOnlyAfterExplicitOptInAndNeverRevealsLocation() throws Exception {
        Browser viewer = signedIn();
        Browser friend = signedIn();
        String viewerId = json.readTree(viewer.get("me").body()).path("userId").asText();
        String friendId = json.readTree(friend.get("me").body()).path("userId").asText();

        JsonNode request = ok(viewer.post("/me/friends/requests", Map.of("targetUserId", friendId)));
        ok(friend.post("/me/friends/requests/" + request.path("id").asText() + "/respond",
            Map.of("decision", "ACCEPT")));
        String presenceKey = "hufs-town:presence:shared:" + friendId;
        strings.opsForZSet().add(presenceKey, "friend-world-session", System.currentTimeMillis() + 60_000);

        JsonNode defaultPreferences = ok(friend.get("/me/friends/preferences"));
        assertThat(defaultPreferences.path("sharePresenceWithFriends").asBoolean()).isFalse();
        JsonNode hidden = ok(viewer.get("/me/friends")).path("friends").get(0);
        assertThat(hidden.path("online").asBoolean()).isFalse();
        Set<String> fields = new HashSet<>();
        hidden.fieldNames().forEachRemaining(fields::add);
        assertThat(fields).containsExactlyInAnyOrder("userId", "displayName", "since", "online");

        ok(friend.put("/me/friends/preferences", Map.of(
            "allowFriendRequests", true,
            "allowFriendNotifications", true,
            "sharePresenceWithFriends", true)));
        assertThat(ok(viewer.get("/me/friends")).path("friends").get(0).path("online").asBoolean()).isTrue();

        ok(friend.put("/me/friends/preferences", Map.of(
            "allowFriendRequests", true,
            "allowFriendNotifications", true,
            "sharePresenceWithFriends", false)));
        assertThat(ok(viewer.get("/me/friends")).path("friends").get(0).path("online").asBoolean()).isFalse();

        db.update("""
            INSERT INTO user_block(block_id,blocker_user_id,blocked_user_id,blocked_display_name)
            VALUES (?,?,?,'친구 차단')
            """, UUID.randomUUID().toString(), viewerId, friendId);
        assertThat(ok(viewer.get("/me/friends")).path("friends")).isEmpty();
    }

    @Test void friendPushDispatcherRechecksOptOutAndDndBeforeProviderSend() throws Exception {
        Browser sender = signedIn();
        Browser optedOutRecipient = signedIn();
        Browser dndRecipient = signedIn();
        String optedOutId = json.readTree(optedOutRecipient.get("me").body()).path("userId").asText();
        String dndId = json.readTree(dndRecipient.get("me").body()).path("userId").asText();

        ok(optedOutRecipient.put("/me/friends/preferences", Map.of(
            "allowFriendRequests", true,
            "allowFriendNotifications", true,
            "sharePresenceWithFriends", false)));
        JsonNode optedOutRequest = ok(sender.post("/me/friends/requests", Map.of("targetUserId", optedOutId)));
        ok(optedOutRecipient.put("/me/friends/preferences", Map.of(
            "allowFriendRequests", true,
            "allowFriendNotifications", false,
            "sharePresenceWithFriends", false)));

        JsonNode dndRequest = ok(sender.post("/me/friends/requests", Map.of("targetUserId", dndId)));
        String dndKey = "hufs-town:presence:dnd:" + dndId;
        strings.opsForZSet().add(dndKey, "dnd-dispatch-test", System.currentTimeMillis() + 60_000);
        insertPushSubscription(optedOutId, "a".repeat(64), "https://fcm.googleapis.com/friend-optout");
        insertPushSubscription(dndId, "b".repeat(64), "https://fcm.googleapis.com/friend-dnd");

        db.update("UPDATE direct_message_push_outbox SET delivered_at=CURRENT_TIMESTAMP(6),lease_id=NULL,lease_until=NULL");
        db.update("UPDATE social_push_outbox SET delivered_at=CURRENT_TIMESTAMP(6),lease_id=NULL,lease_until=NULL");
        String optedOutFriendshipId = optedOutRequest.path("id").asText();
        String dndFriendshipId = dndRequest.path("id").asText();
        db.update("UPDATE social_push_outbox SET delivered_at=NULL,next_attempt_at=CURRENT_TIMESTAMP(6),lease_id=NULL,lease_until=NULL " +
            "WHERE friendship_id IN (?,?)", optedOutFriendshipId, dndFriendshipId);

        org.mockito.Mockito.doReturn(true).when(webPushDelivery).enabled();
        webPushOutboxDispatcher.dispatch();

        assertThat(db.queryForObject("SELECT last_error_code FROM social_push_outbox WHERE friendship_id=?",
            String.class, optedOutFriendshipId)).isEqualTo("NOT_DELIVERABLE");
        assertThat(db.queryForObject("SELECT last_error_code FROM social_push_outbox WHERE friendship_id=?",
            String.class, dndFriendshipId)).isEqualTo("SUPPRESSED_DND");
        org.mockito.Mockito.verify(webPushDelivery, org.mockito.Mockito.never()).send(
            org.mockito.ArgumentMatchers.anyString(), org.mockito.ArgumentMatchers.anyString(),
            org.mockito.ArgumentMatchers.anyString(), org.mockito.ArgumentMatchers.anyString());
    }

    private void insertPushSubscription(String userId, String endpointHash, String endpoint) {
        db.update("""
            INSERT INTO web_push_subscription(id,user_id,endpoint_hash,endpoint,p256dh,auth_secret)
            VALUES (?,?,?,?, 'test-key','test-auth')
            """, UUID.randomUUID().toString(), userId, endpointHash, endpoint);
    }

    @Test void friendRequestRetriesRotateIdsEnforceCooldownAndRestrictRequestActions() throws Exception {
        Browser sender = signedIn();
        Browser recipient = signedIn();
        Browser unrelated = signedIn();
        String senderId = json.readTree(sender.get("me").body()).path("userId").asText();
        String recipientId = json.readTree(recipient.get("me").body()).path("userId").asText();
        String unrelatedId = json.readTree(unrelated.get("me").body()).path("userId").asText();

        JsonNode declinedRequest = ok(sender.post("/me/friends/requests", Map.of("targetUserId", recipientId)));
        String declinedRequestId = declinedRequest.path("id").asText();
        var outsiderRespond = unrelated.post("/me/friends/requests/" + declinedRequestId + "/respond",
            Map.of("decision", "ACCEPT"));
        var outsiderCancel = unrelated.delete("/me/friends/requests/" + declinedRequestId, Map.of());
        assertThat(outsiderRespond.statusCode()).isEqualTo(404);
        assertThat(outsiderCancel.statusCode()).isEqualTo(404);
        assertThat(ok(recipient.get("/me/friends")).path("incoming").findValuesAsText("id"))
            .contains(declinedRequestId);

        assertThat(ok(recipient.post("/me/friends/requests/" + declinedRequestId + "/respond",
            Map.of("decision", "DECLINE"))).path("status").asText()).isEqualTo("DECLINED");
        var cooldown = sender.post("/me/friends/requests", Map.of("targetUserId", recipientId));
        assertThat(cooldown.statusCode()).isEqualTo(429);
        assertThat(json.readTree(cooldown.body()).path("code").asText()).isEqualTo("RATE_LIMITED");

        db.update("UPDATE user_friendship SET resolved_at=DATE_SUB(CURRENT_TIMESTAMP(6), INTERVAL 25 HOUR) WHERE friendship_id=?",
            declinedRequestId);
        JsonNode retried = ok(sender.post("/me/friends/requests", Map.of("targetUserId", recipientId)));
        String retriedId = retried.path("id").asText();
        assertThat(retried.path("status").asText()).isEqualTo("PENDING");
        assertThat(retriedId).isNotEqualTo(declinedRequestId);

        var staleRespondAfterDecline = recipient.post("/me/friends/requests/" + declinedRequestId + "/respond",
            Map.of("decision", "ACCEPT"));
        var staleCancelAfterDecline = sender.delete("/me/friends/requests/" + declinedRequestId, Map.of());
        JsonNode recipientInboxAfterStaleActions = ok(recipient.get("/me/friends"));
        assertThat(staleRespondAfterDecline.statusCode()).isEqualTo(404);
        assertThat(staleCancelAfterDecline.statusCode()).isEqualTo(404);
        assertThat(recipientInboxAfterStaleActions.path("incoming").findValuesAsText("id")).contains(retriedId);

        JsonNode cancelledRequest = ok(sender.post("/me/friends/requests", Map.of("targetUserId", unrelatedId)));
        String cancelledRequestId = cancelledRequest.path("id").asText();
        assertThat(sender.delete("/me/friends/requests/" + cancelledRequestId, Map.of()).statusCode()).isEqualTo(200);
        JsonNode requestAfterCancel = ok(sender.post("/me/friends/requests", Map.of("targetUserId", unrelatedId)));
        String requestAfterCancelId = requestAfterCancel.path("id").asText();
        assertThat(requestAfterCancelId).isNotEqualTo(cancelledRequestId);

        var staleRespondAfterCancel = unrelated.post("/me/friends/requests/" + cancelledRequestId + "/respond",
            Map.of("decision", "ACCEPT"));
        var staleCancelAfterCancel = sender.delete("/me/friends/requests/" + cancelledRequestId, Map.of());
        JsonNode unrelatedInboxAfterStaleActions = ok(unrelated.get("/me/friends"));
        assertThat(staleRespondAfterCancel.statusCode()).isEqualTo(404);
        assertThat(staleCancelAfterCancel.statusCode()).isEqualTo(404);
        assertThat(unrelatedInboxAfterStaleActions.path("incoming").findValuesAsText("id"))
            .contains(requestAfterCancelId);

        assertThat(sender.delete("/me/friends/requests/" + retriedId.toUpperCase(Locale.ROOT), Map.of()).statusCode()).isEqualTo(200);
        assertThat(sender.delete("/me/friends/requests/" + requestAfterCancelId, Map.of()).statusCode()).isEqualTo(200);
    }

    @Test void friendRequestsEnforceFiftyPendingOutgoingLimit() throws Exception {
        Browser sender = signedIn();
        String senderId = json.readTree(sender.get("me").body()).path("userId").asText();
        List<String> pendingIds = new ArrayList<>();
        for (int index = 0; index < 50; index++) {
            String targetId = UUID.randomUUID().toString();
            db.update("INSERT INTO app_user(id,display_name) VALUES (?,?)", targetId, "친구 한도 대상 " + index);
            String first = senderId.compareTo(targetId) < 0 ? senderId : targetId;
            String second = senderId.compareTo(targetId) < 0 ? targetId : senderId;
            String requestId = UUID.randomUUID().toString();
            db.update("""
                INSERT INTO user_friendship(friendship_id,user_a_id,user_b_id,requested_by_user_id,status,created_at)
                VALUES (?,?,?,?,'PENDING',DATE_SUB(CURRENT_TIMESTAMP(6), INTERVAL 1 HOUR))
                """, requestId, first, second, senderId);
            pendingIds.add(requestId);
        }
        String newTargetId = UUID.randomUUID().toString();
        db.update("INSERT INTO app_user(id,display_name) VALUES (?,?)", newTargetId, "친구 한도 추가 대상");

        var fullPendingList = sender.post("/me/friends/requests", Map.of("targetUserId", newTargetId));
        assertThat(fullPendingList.statusCode()).isEqualTo(429);
        assertThat(json.readTree(fullPendingList.body()).path("code").asText()).isEqualTo("RATE_LIMITED");
        assertThat(sender.delete("/me/friends/requests/" + pendingIds.getFirst(), Map.of()).statusCode()).isEqualTo(200);
        JsonNode afterOneCancellation = ok(sender.post("/me/friends/requests", Map.of("targetUserId", newTargetId)));
        assertThat(afterOneCancellation.path("status").asText()).isEqualTo("PENDING");
        assertThat(ok(sender.get("/me/friends")).path("outgoing")).hasSize(50);
    }

    @Test void friendRequestCreationAllowsTwentyPerMinuteThenReturns429() throws Exception {
        Browser sender = signedIn();
        String senderId = json.readTree(sender.get("me").body()).path("userId").asText();
        for (int index = 0; index < 21; index++) {
            String targetId = UUID.randomUUID().toString();
            db.update("INSERT INTO app_user(id,display_name) VALUES (?,?)", targetId, "친구 속도 대상 " + index);
            if (index < 20) {
                JsonNode created = ok(sender.post("/me/friends/requests", Map.of("targetUserId", targetId)));
                assertThat(created.path("status").asText()).isEqualTo("PENDING");
            } else {
                var rateLimited = sender.post("/me/friends/requests", Map.of("targetUserId", targetId));
                assertThat(rateLimited.statusCode()).isEqualTo(429);
                assertThat(json.readTree(rateLimited.body()).path("code").asText()).isEqualTo("RATE_LIMITED");
                assertThat(strings.opsForZSet().zCard("hufs-town:friend-request-limit:" + senderId)).isEqualTo(20L);
            }
        }
    }

    @Test void friendAccountSearchNormalizesLiteralPrefixesAndCapsResults() throws Exception {
        Browser searcher = signedIn();
        List<String> expectedIds = new ArrayList<>();
        for (int index = 0; index < 25; index++) {
            String id = UUID.randomUUID().toString();
            db.update("INSERT INTO app_user(id,display_name) VALUES (?,?)", id,
                "Café 50%_search result " + String.format(Locale.ROOT, "%02d", index));
            expectedIds.add(id);
        }
        String wildcardDecoy = UUID.randomUUID().toString();
        db.update("INSERT INTO app_user(id,display_name) VALUES (?,?)", wildcardDecoy, "Café 50XXsearch wildcard decoy");

        String query = URLEncoder.encode("  Cafe\u0301 50%_search  ", java.nio.charset.StandardCharsets.UTF_8);
        JsonNode results = ok(searcher.get("/me/friends/search?q=" + query));
        assertThat(results).hasSize(20);
        assertThat(results.findValuesAsText("userId")).containsAll(expectedIds.subList(0, 20))
            .doesNotContain(wildcardDecoy);
        assertThat(results.findValuesAsText("displayName")).allMatch(name -> name.startsWith("Café 50%_search result "));
    }

    @Test void friendAccountSearchExcludesSelfInactiveAndEitherDirectionBlocksAndReportsRelationshipState() throws Exception {
        Browser searcher = signedIn();
        String viewerId = json.readTree(searcher.get("me").body()).path("userId").asText();
        db.update("UPDATE app_user SET display_name='Friendstate Searcher' WHERE id=?", viewerId);

        Map<String, String> ids = new LinkedHashMap<>();
        for (String label : List.of("Friend", "Incoming", "Outgoing", "Cooldown", "Available", "Unavailable",
            "Blocked forward", "Blocked reverse", "Inactive")) {
            String id = UUID.randomUUID().toString();
            String displayName = "Friendstate " + label;
            db.update("INSERT INTO app_user(id,display_name) VALUES (?,?)", id, displayName);
            ids.put(label, id);
        }
        addSearchFriendship(viewerId, ids.get("Friend"), viewerId, "ACCEPTED");
        addSearchFriendship(viewerId, ids.get("Incoming"), ids.get("Incoming"), "PENDING");
        addSearchFriendship(viewerId, ids.get("Outgoing"), viewerId, "PENDING");
        addSearchFriendship(viewerId, ids.get("Cooldown"), viewerId, "DECLINED");
        db.update("INSERT INTO user_social_preference(user_id,allow_friend_requests) VALUES (?,FALSE)", ids.get("Unavailable"));
        db.update("INSERT INTO user_social_preference(user_id,allow_friend_requests) VALUES (?,FALSE)", ids.get("Incoming"));
        db.update("INSERT INTO user_block(block_id,blocker_user_id,blocked_user_id,blocked_display_name) VALUES (?,?,?,?)",
            UUID.randomUUID().toString(), viewerId, ids.get("Blocked forward"), "Friendstate Blocked forward");
        db.update("INSERT INTO user_block(block_id,blocker_user_id,blocked_user_id,blocked_display_name) VALUES (?,?,?,?)",
            UUID.randomUUID().toString(), ids.get("Blocked reverse"), viewerId, "Friendstate Searcher");
        db.update("UPDATE app_user SET status='SUSPENDED' WHERE id=?", ids.get("Inactive"));

        JsonNode results = ok(searcher.get("/me/friends/search?q=" + URLEncoder.encode(" Friendstate ",
            java.nio.charset.StandardCharsets.UTF_8)));
        assertThat(results).hasSize(6);
        Map<String, JsonNode> resultByName = new HashMap<>();
        for (JsonNode result : results) {
            Set<String> fields = new HashSet<>();
            result.fieldNames().forEachRemaining(fields::add);
            assertThat(fields).containsExactlyInAnyOrder("userId", "displayName", "relationship");
            resultByName.put(result.path("displayName").asText(), result);
        }
        assertThat(resultByName.keySet()).containsExactlyInAnyOrder(
            "Friendstate Friend", "Friendstate Incoming", "Friendstate Outgoing", "Friendstate Cooldown",
            "Friendstate Available", "Friendstate Unavailable");
        assertThat(resultByName.get("Friendstate Friend").path("relationship").asText()).isEqualTo("FRIEND");
        assertThat(resultByName.get("Friendstate Incoming").path("relationship").asText()).isEqualTo("INCOMING");
        assertThat(resultByName.get("Friendstate Outgoing").path("relationship").asText()).isEqualTo("OUTGOING");
        assertThat(resultByName.get("Friendstate Cooldown").path("relationship").asText()).isEqualTo("COOLDOWN");
        assertThat(resultByName.get("Friendstate Available").path("relationship").asText()).isEqualTo("AVAILABLE");
        assertThat(resultByName.get("Friendstate Unavailable").path("relationship").asText()).isEqualTo("UNAVAILABLE");
        assertThat(resultByName.get("Friendstate Incoming").path("userId").asText()).isEqualTo(ids.get("Incoming"));
        assertThat(searcher.get("/me/friends/search?q=f").statusCode()).isEqualTo(400);
    }

    @Test void friendAccountSearchAllowsSixtyRequestsPerMinuteThenReturns429() throws Exception {
        Browser searcher = signedIn();
        String searcherId = json.readTree(searcher.get("me").body()).path("userId").asText();
        String path = "/me/friends/search?q=rate";
        for (int attempt = 0; attempt < 60; attempt++) assertThat(searcher.get(path).statusCode()).isEqualTo(200);

        var rateLimited = searcher.get(path);
        assertThat(rateLimited.statusCode()).isEqualTo(429);
        assertThat(json.readTree(rateLimited.body()).path("code").asText()).isEqualTo("RATE_LIMITED");
        assertThat(strings.opsForZSet().zCard("hufs-town:friend-search-limit:" + searcherId)).isEqualTo(60L);
    }

    private void addSearchFriendship(String viewerId, String peerId, String requesterId, String status) {
        String first = viewerId.compareTo(peerId) < 0 ? viewerId : peerId;
        String second = viewerId.compareTo(peerId) < 0 ? peerId : viewerId;
        if ("PENDING".equals(status)) {
            db.update("""
                INSERT INTO user_friendship(friendship_id,user_a_id,user_b_id,requested_by_user_id,status)
                VALUES (?,?,?,?,?)
                """, UUID.randomUUID().toString(), first, second, requesterId, status);
        } else {
            db.update("""
                INSERT INTO user_friendship(friendship_id,user_a_id,user_b_id,requested_by_user_id,status,resolved_at)
                VALUES (?,?,?,?,?,CURRENT_TIMESTAMP(6))
                """, UUID.randomUUID().toString(), first, second, requesterId, status);
        }
    }

    @Test void accountJoinRequestsReachOfflineAndOtherSpaceTargetsWithoutRevealingLocation() throws Exception {
        Browser firstRequester = signedIn();
        Browser secondRequester = signedIn();
        Browser target = signedIn();
        String firstRequesterId = json.readTree(firstRequester.get("me").body()).path("userId").asText();
        String secondRequesterId = json.readTree(secondRequester.get("me").body()).path("userId").asText();
        String targetId = json.readTree(target.get("me").body()).path("userId").asText();
        String firstConversation = createDirectConversation(firstRequesterId, targetId);
        String secondConversation = createDirectConversation(secondRequesterId, targetId);
        String firstDestinationSpace = createSpace(firstRequester, "먼저 만날 공개 공간", "PUBLIC", 20)
            .path("id").asText();
        String secondDestinationSpace = createSpace(secondRequester, "두 번째 만남 공간", "PUBLIC", 20)
            .path("id").asText();
        String targetOtherSpace = createSpace(target, "대상의 다른 공간", "PRIVATE", 20).path("id").asText();

        // The first request is delivered from the durable inbox while the target has no active World socket.
        JsonNode offlineRequest = ok(firstRequester.post("/me/join-requests", Map.of(
            "conversationId", firstConversation, "destinationSpaceId", firstDestinationSpace,
            "message", "나중에 함께 이야기할까요?")));
        assertThat(offlineRequest.path("status").asText()).isEqualTo("PENDING");
        JsonNode offlineInbox = ok(target.get("/me/join-requests"));
        assertThat(offlineInbox).hasSize(1);
        assertThat(offlineInbox.get(0).path("message").asText()).isEqualTo("나중에 함께 이야기할까요?");
        assertThat(offlineInbox.get(0).path("destinationSpaceId").asText()).isEqualTo(firstDestinationSpace);
        assertThat(offlineInbox.get(0).path("destinationSpaceName").asText()).isEqualTo("먼저 만날 공개 공간");
        assertThat(offlineInbox.get(0).has("userId")).isFalse();
        assertThat(offlineInbox.get(0).has("spaceId")).isFalse();
        assertThat(offlineInbox.get(0).has("mapId")).isFalse();
        assertThat(offlineInbox.get(0).has("x")).isFalse();
        assertThat(ok(target.post("/me/join-requests/" + offlineRequest.path("id").asText() + "/respond",
            Map.of("decision", "APPROVE"))).path("status").asText()).isEqualTo("APPROVED");
        assertThat(ok(firstRequester.get("/me/join-requests/outgoing")).get(0).path("status").asText())
            .isEqualTo("APPROVED");
        JsonNode approvedInbox = ok(target.get("/me/join-requests"));
        assertThat(approvedInbox).hasSize(1);
        assertThat(approvedInbox.get(0).path("status").asText()).isEqualTo("APPROVED");
        assertThat(approvedInbox.get(0).path("destinationSpaceId").asText()).isEqualTo(firstDestinationSpace);
        assertThat(target.get("/spaces/" + firstDestinationSpace).statusCode()).isEqualTo(200);
        Probe admittedToDestination = target.socketWithTicket(ORIGIN, target.ticket(firstDestinationSpace));
        try {
            admittedToDestination.join("");
            JsonNode joinedDestination = admittedToDestination.await(node -> node.path("type").asText().equals("welcome"));
            assertThat(joinedDestination.path("playerId").asText()).isNotBlank();
        } finally {
            admittedToDestination.socket.abort();
        }

        // A second request works while the target is actively connected to an unrelated space.
        Probe targetSocket = target.socketWithTicket(ORIGIN, target.ticket(targetOtherSpace));
        try {
            targetSocket.join("");
            JsonNode welcome = targetSocket.await(node -> node.path("type").asText().equals("welcome"));
            assertThat(welcome.path("mapRevision").asText()).isNotBlank();
            JsonNode remoteRequest = ok(secondRequester.post("/me/join-requests", Map.of(
                "conversationId", secondConversation, "destinationSpaceId", secondDestinationSpace,
                "message", "시간 될 때 만나고 싶어요.")));
            assertThat(remoteRequest.path("status").asText()).isEqualTo("PENDING");
            JsonNode remoteInbox = ok(target.get("/me/join-requests"));
            assertThat(remoteInbox).hasSize(2);
            assertThat(remoteInbox.get(0).path("message").asText()).isEqualTo("시간 될 때 만나고 싶어요.");
            assertThat(remoteInbox.get(0).toString()).doesNotContain(targetOtherSpace, targetId);
            assertThat(ok(target.post("/me/join-requests/" + remoteRequest.path("id").asText() + "/respond",
                Map.of("decision", "DECLINE"))).path("status").asText()).isEqualTo("DECLINED");
            assertThat(ok(secondRequester.get("/me/join-requests/outgoing")).get(0).path("status").asText())
                .isEqualTo("DECLINED");
        } finally {
            targetSocket.socket.abort();
        }

        // Consent does not bypass a private space's normal membership boundary.
        Browser privateRequester = signedIn();
        String privateRequesterId = json.readTree(privateRequester.get("me").body()).path("userId").asText();
        String privateConversation = createDirectConversation(privateRequesterId, targetId);
        String privateDestinationSpace = createSpace(privateRequester, "비공개 만남 공간", "PRIVATE", 20)
            .path("id").asText();
        JsonNode privateRequest = ok(privateRequester.post("/me/join-requests", Map.of(
            "conversationId", privateConversation, "destinationSpaceId", privateDestinationSpace,
            "message", "비공개 공간에서 만나요.")));
        JsonNode privateInbox = ok(target.get("/me/join-requests"));
        assertThat(privateInbox.get(0).path("id").asText()).isEqualTo(privateRequest.path("id").asText());
        assertThat(privateInbox.get(0).path("destinationSpaceName").asText()).isEqualTo("비공개 만남 공간");
        assertThat(ok(target.post("/me/join-requests/" + privateRequest.path("id").asText() + "/respond",
            Map.of("decision", "APPROVE"))).path("status").asText()).isEqualTo("APPROVED");
        assertThat(target.get("/spaces/" + privateDestinationSpace).statusCode()).isEqualTo(404);
        assertThat(target.post("/spaces/" + privateDestinationSpace + "/admission", Map.of()).statusCode())
            .isEqualTo(404);

        Browser unrelated = signedIn();
        Browser unrelatedPeer = signedIn();
        String unrelatedId = json.readTree(unrelated.get("me").body()).path("userId").asText();
        String unrelatedPeerId = json.readTree(unrelatedPeer.get("me").body()).path("userId").asText();
        String unrelatedConversation = createDirectConversation(unrelatedId, unrelatedPeerId);
        var unauthorized = firstRequester.post("/me/join-requests", Map.of(
            "conversationId", unrelatedConversation, "destinationSpaceId", firstDestinationSpace));
        assertThat(unauthorized.statusCode()).isEqualTo(404);
        assertThat(json.readTree(unauthorized.body()).path("code").asText()).isEqualTo("JOIN_REQUEST_UNAVAILABLE");
        var guessedUserId = firstRequester.post("/me/join-requests", Map.of("targetUserId", targetId));
        assertThat(guessedUserId.statusCode()).isEqualTo(400);
        assertThat(json.readTree(guessedUserId.body()).path("code").asText()).isEqualTo("JOIN_REQUEST_INVALID");
        assertThat(firstRequesterId).isNotEqualTo(secondRequesterId);
    }

    @Test void approvedJoinAcrossMapsResumesTheSameSeatNearTheTarget() throws Exception {
        Browser requester = signedIn();
        Browser target = signedIn();
        String spaceId = createSpace(target, "다른 지도 합류", "PUBLIC", 20).path("id").asText();
        String targetMapId = ok(target.post("/spaces/" + spaceId + "/maps",
            Map.of("name", "스터디룸", "templateId", "MEETUP_HALL"))).path("mapId").asText();
        try (RecordingMediaControl media = startRecordingMediaControl();
             AdditionalWorld world = startAdditionalWorld(media.endpoint(), "hufs-town-cross-map-join-control-token")) {
            Probe requesterSocket = requester.socketWithTicket(ORIGIN, requester.ticket(spaceId), world.port());
            Probe targetSocket = target.socketWithTicket(ORIGIN, target.ticket(spaceId, targetMapId), world.port());
            Probe resumedSocket = null;
            try {
                requesterSocket.join("");
                JsonNode requesterWelcome = requesterSocket.await(node -> node.path("type").asText().equals("welcome"));
                targetSocket.join("");
                JsonNode targetWelcome = targetSocket.await(node -> node.path("type").asText().equals("welcome"));
                String requesterId = requesterWelcome.path("playerId").asText();
                String targetId = targetWelcome.path("playerId").asText();
                assertThat(targetWelcome.path("mapRevision").asText()).isNotBlank();

                String requestId = "cross-map-join-" + UUID.randomUUID();
                requesterSocket.send(json.writeValueAsString(Map.of("type", "joinRequest",
                    "epoch", requesterWelcome.path("epoch").asLong(), "requestId", requestId, "targetId", targetId)));
                assertThat(requesterSocket.await(node -> node.path("type").asText().equals("joinRequestAck")
                    && node.path("requestId").asText().equals(requestId)).path("accepted").asBoolean()).isTrue();
                targetSocket.await(node -> node.path("type").asText().equals("joinRequestEvent")
                    && node.path("requestId").asText().equals(requestId));

                media.holdRevokes();
                targetSocket.send(json.writeValueAsString(Map.of("type", "joinResponse",
                    "epoch", targetWelcome.path("epoch").asLong(), "requestId", requestId, "accepted", true)));
                JsonNode revoke = media.awaitRevoke(requesterId);
                assertThat(revoke.path("playerId").asText()).isEqualTo(requesterId);
                Thread.sleep(250);
                assertThat(requesterSocket.messages.stream().noneMatch(node -> node.path("type").asText().equals("joinResult")
                    && node.path("requestId").asText().equals(requestId))).isTrue();
                media.releaseRevokes();

                JsonNode result = requesterSocket.await(node -> node.path("type").asText().equals("joinResult")
                    && node.path("requestId").asText().equals(requestId));
                assertThat(result.path("accepted").asBoolean()).isTrue();
                assertThat(result.path("moved").asBoolean()).isTrue();
                assertThat(result.path("destinationMapId").asText()).isEqualTo(targetMapId);

                requesterSocket.socket.abort();
                Thread.sleep(250);
                String resumeToken = requesterWelcome.path("resumeToken").asText();
                Probe mapArrival = requester.socketWithTicket(ORIGIN, requester.ticket(spaceId, targetMapId, resumeToken), world.port());
                resumedSocket = mapArrival;
                mapArrival.join(resumeToken);
                JsonNode resumedWelcome = mapArrival.await(node -> node.path("type").asText().equals("welcome"));
                assertThat(resumedWelcome.path("playerId").asText()).isEqualTo(requesterId);
                assertThat(resumedWelcome.path("epoch").asLong()).isEqualTo(requesterWelcome.path("epoch").asLong() + 1);
                assertThat(resumedWelcome.path("mapRevision").asText()).isEqualTo(targetWelcome.path("mapRevision").asText());
                assertThat(strings.opsForZSet().zCard("hufs-town:seats:" + spaceId)).isEqualTo(2L);

                mapArrival.await(node -> node.path("type").asText().equals("snapshot")
                    && mapArrival.visiblePlayers.containsKey(requesterId)
                    && mapArrival.visiblePlayers.containsKey(targetId));
                JsonNode requesterPlayer = mapArrival.visiblePlayers.get(requesterId);
                JsonNode targetPlayer = mapArrival.visiblePlayers.get(targetId);
                double distance = Math.hypot(requesterPlayer.path("x").asDouble() - targetPlayer.path("x").asDouble(),
                    requesterPlayer.path("y").asDouble() - targetPlayer.path("y").asDouble());
                assertThat(distance).isBetween(.5, 4.1);
            } finally {
                media.releaseRevokes();
                if (resumedSocket != null) resumedSocket.socket.abort();
                requesterSocket.socket.abort();
                targetSocket.socket.abort();
            }
        }
    }

    @Test void concurrentApprovedJoinsReserveDestinationsAcrossMediaRevocationBarriers() throws Exception {
        Browser firstRequester = signedIn();
        Browser secondRequester = signedIn();
        Browser target = signedIn();
        String spaceId = createSpace(target, "동시 합류 위치 예약", "PUBLIC", 20).path("id").asText();
        try (RecordingMediaControl media = startRecordingMediaControl();
             AdditionalWorld world = startAdditionalWorld(media.endpoint(), "hufs-town-integration-media-control-token-02")) {
            Probe firstSocket = firstRequester.socketWithTicket(ORIGIN, firstRequester.ticket(spaceId), world.port());
            Probe secondSocket = secondRequester.socketWithTicket(ORIGIN, secondRequester.ticket(spaceId), world.port());
            Probe targetSocket = target.socketWithTicket(ORIGIN, target.ticket(spaceId), world.port());
            try {
                firstSocket.join("");
                secondSocket.join("");
                targetSocket.join("");
                JsonNode firstMap = firstSocket.await(node -> node.path("type").asText().equals("mapChanged")).path("map");
                JsonNode secondWelcome = secondSocket.await(node -> node.path("type").asText().equals("welcome"));
                JsonNode firstWelcome = firstSocket.await(node -> node.path("type").asText().equals("welcome"));
                JsonNode targetWelcome = targetSocket.await(node -> node.path("type").asText().equals("welcome"));
                JsonNode quiet = java.util.stream.StreamSupport.stream(firstMap.path("zones").spliterator(), false)
                    .filter(zone -> zone.path("kind").asText().equals("SILENT")).findFirst().orElseThrow();
                String quietId = quiet.path("id").asText();
                double quietX = quiet.path("bounds").path("x").asDouble()
                    + quiet.path("bounds").path("width").asDouble() / 2;
                double quietY = quiet.path("bounds").path("y").asDouble()
                    + quiet.path("bounds").path("height").asDouble() / 2;
                String firstId = firstWelcome.path("playerId").asText();
                String secondId = secondWelcome.path("playerId").asText();
                String targetId = targetWelcome.path("playerId").asText();
                moveWorldProbeToZone(firstSocket, firstWelcome, quietId, quietX, quietY);
                moveWorldProbeToZone(secondSocket, secondWelcome, quietId, quietX, quietY);
                assertThat(firstSocket.visiblePlayers.get(firstId).path("zoneId").asText()).isEqualTo(quietId);
                assertThat(secondSocket.visiblePlayers.get(secondId).path("zoneId").asText()).isEqualTo(quietId);
                assertThat(targetSocket.visiblePlayers.get(targetId).path("zoneId").asText()).isNotEqualTo(quietId);
                media.awaitPolicy(targetId, person -> person.path("sources").size() == 4);

                media.holdRevokes();
                String firstRequestId = "concurrent-join-first-" + UUID.randomUUID();
                String secondRequestId = "concurrent-join-second-" + UUID.randomUUID();
                firstSocket.send(json.writeValueAsString(Map.of("type", "joinRequest", "requestId", firstRequestId,
                    "epoch", firstWelcome.path("epoch").asLong(), "targetId", targetId)));
                secondSocket.send(json.writeValueAsString(Map.of("type", "joinRequest", "requestId", secondRequestId,
                    "epoch", secondWelcome.path("epoch").asLong(), "targetId", targetId)));
                assertThat(firstSocket.await(node -> node.path("type").asText().equals("joinRequestAck")
                    && node.path("requestId").asText().equals(firstRequestId)).path("accepted").asBoolean()).isTrue();
                assertThat(secondSocket.await(node -> node.path("type").asText().equals("joinRequestAck")
                    && node.path("requestId").asText().equals(secondRequestId)).path("accepted").asBoolean()).isTrue();
                JsonNode firstJoinEvent = targetSocket.await(node -> node.path("type").asText().equals("joinRequestEvent")
                    && (node.path("requestId").asText().equals(firstRequestId)
                        || node.path("requestId").asText().equals(secondRequestId)));
                String remainingRequestId = firstJoinEvent.path("requestId").asText().equals(firstRequestId)
                    ? secondRequestId : firstRequestId;
                targetSocket.await(node -> node.path("type").asText().equals("joinRequestEvent")
                    && node.path("requestId").asText().equals(remainingRequestId));

                targetSocket.send(json.writeValueAsString(Map.of("type", "joinResponse", "requestId", firstRequestId,
                    "epoch", targetWelcome.path("epoch").asLong(), "accepted", true)));
                JsonNode firstRevoke = media.awaitRevoke(firstId);
                assertThat(firstSocket.await(node -> node.path("type").asText().equals("joinResult")
                    && node.path("requestId").asText().equals(firstRequestId)).path("moved").asBoolean()).isTrue();
                targetSocket.send(json.writeValueAsString(Map.of("type", "joinResponse", "requestId", secondRequestId,
                    "epoch", targetWelcome.path("epoch").asLong(), "accepted", true)));
                JsonNode secondRevoke = media.awaitRevoke(secondId);
                assertThat(secondSocket.await(node -> node.path("type").asText().equals("joinResult")
                    && node.path("requestId").asText().equals(secondRequestId)).path("moved").asBoolean()).isTrue();
                assertThat(firstRevoke.path("playerId").asText()).isEqualTo(firstId);
                assertThat(secondRevoke.path("playerId").asText()).isEqualTo(secondId);

                media.releaseRevokes();
                firstSocket.await(node -> node.path("type").asText().equals("snapshot")
                    && firstSocket.visiblePlayers.containsKey(firstId)
                    && firstSocket.visiblePlayers.containsKey(secondId)
                    && !quietId.equals(firstSocket.visiblePlayers.get(firstId).path("zoneId").asText())
                    && !quietId.equals(firstSocket.visiblePlayers.get(secondId).path("zoneId").asText()));
                JsonNode firstPosition = firstSocket.visiblePlayers.get(firstId);
                JsonNode secondPosition = firstSocket.visiblePlayers.get(secondId);
                assertThat(Math.hypot(firstPosition.path("x").asDouble() - secondPosition.path("x").asDouble(),
                    firstPosition.path("y").asDouble() - secondPosition.path("y").asDouble())).isGreaterThanOrEqualTo(.48);
            } finally {
                media.releaseRevokes();
                firstSocket.socket.abort();
                secondSocket.socket.abort();
                targetSocket.socket.abort();
            }
        }
    }

    private void moveWorldProbeToZone(Probe probe, JsonNode welcome, String targetZoneId,
                                      double targetX, double targetY) throws Exception {
        String playerId = welcome.path("playerId").asText();
        long epoch = welcome.path("epoch").asLong();
        int seq = 0;
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(35);
        while (System.nanoTime() < deadline) {
            JsonNode current = probe.visiblePlayers.get(playerId);
            if (current == null) {
                probe.await(node -> node.path("type").asText().equals("snapshot")
                    && probe.visiblePlayers.containsKey(playerId));
                continue;
            }
            if (targetZoneId.equals(current.path("zoneId").asText())) {
                int stopSeq = seq++;
                probe.send(json.writeValueAsString(Map.of("type", "move", "epoch", epoch, "seq", stopSeq,
                    "dx", 0, "dy", 0, "running", false)));
                probe.await(node -> node.path("type").asText().equals("snapshot")
                    && node.path("inputAckSeq").asInt(-1) >= stopSeq
                    && probe.visiblePlayers.containsKey(playerId)
                    && !probe.visiblePlayers.get(playerId).path("moving").asBoolean());
                return;
            }
            double dx = targetX - current.path("x").asDouble();
            double dy = targetY - current.path("y").asDouble();
            int stepX = Math.abs(dx) < .12 ? 0 : dx > 0 ? 1 : -1;
            int stepY = Math.abs(dy) < .12 ? 0 : dy > 0 ? 1 : -1;
            probe.send(json.writeValueAsString(Map.of("type", "move", "epoch", epoch, "seq", seq++,
                "dx", stepX, "dy", stepY, "running", true)));
            Thread.sleep(75);
        }
        throw new AssertionError("Player could not reach the target zone: " + probe.visiblePlayers.get(playerId));
    }

    @Test void presenceDndKeepsChatButStopsMediaAndInteractionsAndPublishesPushSuppression() throws Exception {
        Browser target = signedIn();
        Browser requester = signedIn();
        String spaceId = createSpace(target, "상태 정책 통합 공간", "PUBLIC", 20).path("id").asText();
        try (RecordingMediaControl media = startRecordingMediaControl();
             AdditionalWorld world = startAdditionalWorld(media.endpoint(), "hufs-town-integration-media-control-token-02")) {
            Probe targetSocket = target.socketWithTicket(ORIGIN, target.ticket(spaceId), world.port());
            Probe requesterSocket = requester.socketWithTicket(ORIGIN, requester.ticket(spaceId), world.port());
            try {
                targetSocket.join("");
                JsonNode targetWelcome = targetSocket.await(node -> node.path("type").asText().equals("welcome"));
                requesterSocket.join("");
                JsonNode requesterWelcome = requesterSocket.await(node -> node.path("type").asText().equals("welcome"));
                String targetId = targetWelcome.path("playerId").asText();
                String dndKey = "hufs-town:presence:dnd:" + json.readTree(target.get("me").body()).path("userId").asText();
                media.awaitPolicy(targetId, person -> person.path("sources").size() == 4);
                JsonNode activeMedia = targetSocket.await(node -> node.path("type").asText().equals("mediaState")
                    && node.path("available").asBoolean());

                targetSocket.send(json.writeValueAsString(Map.of("type", "presenceSet",
                    "epoch", targetWelcome.path("epoch").asLong(), "requestId", "presence-dnd-01", "status", "DND")));
                JsonNode dndAck = targetSocket.await(node -> node.path("type").asText().equals("presenceAck")
                    && node.path("requestId").asText().equals("presence-dnd-01"));
                assertThat(dndAck.path("accepted").asBoolean()).isTrue();
                assertThat(dndAck.path("status").asText()).isEqualTo("DND");
                JsonNode revoked = media.awaitRevoke(targetId);
                assertThat(revoked.path("epoch").asLong()).isGreaterThan(activeMedia.path("policyEpoch").asLong());
                awaitRedisDnd(dndKey, targetId, true);

                String joinId = "presence-join-" + UUID.randomUUID();
                requesterSocket.send(json.writeValueAsString(Map.of("type", "joinRequest",
                    "epoch", requesterWelcome.path("epoch").asLong(), "requestId", joinId, "targetId", targetId)));
                JsonNode joinAck = requesterSocket.await(node -> node.path("type").asText().equals("joinRequestAck")
                    && node.path("requestId").asText().equals(joinId));
                assertThat(joinAck.path("accepted").asBoolean()).isFalse();
                assertThat(joinAck.path("code").asText()).isEqualTo("JOIN_PRESENCE");

                String pokeId = "presence-poke-" + UUID.randomUUID();
                requesterSocket.send(json.writeValueAsString(Map.of("type", "poke",
                    "epoch", requesterWelcome.path("epoch").asLong(), "requestId", pokeId, "targetId", targetId)));
                JsonNode pokeAck = requesterSocket.await(node -> node.path("type").asText().equals("pokeAck")
                    && node.path("requestId").asText().equals(pokeId));
                assertThat(pokeAck.path("accepted").asBoolean()).isFalse();
                assertThat(pokeAck.path("code").asText()).isEqualTo("POKE_UNAVAILABLE");

                targetSocket.send(json.writeValueAsString(Map.of("type", "mediaRequest", "requestId", "presence-media-01",
                    "policyEpoch", activeMedia.path("policyEpoch").asLong(), "method", "capabilities", "dataJson", "{}")));
                JsonNode mediaReply = targetSocket.await(node -> node.path("type").asText().equals("mediaReply")
                    && node.path("requestId").asText().equals("presence-media-01"));
                assertThat(mediaReply.path("ok").asBoolean()).isFalse();
                assertThat(mediaReply.path("code").asText()).isEqualTo("MEDIA_PRESENCE");

                String chatId = "presence-chat-" + UUID.randomUUID();
                targetSocket.send(json.writeValueAsString(Map.of("type", "chatSend", "clientMessageId", chatId,
                    "epoch", targetWelcome.path("epoch").asLong(), "channel", "space", "conversationId", "",
                    "text", "방해 금지에서도 공간 채팅은 받을 수 있어요.")));
                JsonNode chatAck = targetSocket.await(node -> node.path("type").asText().equals("chatAck")
                    && node.path("clientMessageId").asText().equals(chatId));
                assertThat(chatAck.path("accepted").asBoolean()).isTrue();
                JsonNode chatEvent = requesterSocket.await(node -> node.path("type").asText().equals("chatEvent")
                    && node.path("clientMessageId").asText().equals(chatId));
                assertThat(chatEvent.path("senderId").asText()).isEqualTo(targetId);

                Thread.sleep(800);
                targetSocket.send(json.writeValueAsString(Map.of("type", "presenceSet",
                    "epoch", targetWelcome.path("epoch").asLong(), "requestId", "presence-away-01", "status", "AWAY")));
                JsonNode awayAck = targetSocket.await(node -> node.path("type").asText().equals("presenceAck")
                    && node.path("requestId").asText().equals("presence-away-01"));
                assertThat(awayAck.path("accepted").asBoolean()).isTrue();
                targetSocket.send(json.writeValueAsString(Map.of("type", "mediaRequest", "requestId", "presence-media-02",
                    "policyEpoch", activeMedia.path("policyEpoch").asLong() + 2, "method", "capabilities", "dataJson", "{}")));
                JsonNode awayMediaReply = targetSocket.await(node -> node.path("type").asText().equals("mediaReply")
                    && node.path("requestId").asText().equals("presence-media-02"));
                assertThat(awayMediaReply.path("ok").asBoolean()).isFalse();
                assertThat(awayMediaReply.path("code").asText()).isEqualTo("MEDIA_PRESENCE");

                Thread.sleep(800);
                targetSocket.send(json.writeValueAsString(Map.of("type", "presenceSet",
                    "epoch", targetWelcome.path("epoch").asLong(), "requestId", "presence-available-01", "status", "AVAILABLE")));
                JsonNode availableAck = targetSocket.await(node -> node.path("type").asText().equals("presenceAck")
                    && node.path("requestId").asText().equals("presence-available-01"));
                assertThat(availableAck.path("accepted").asBoolean()).isTrue();
                awaitRedisDnd(dndKey, targetId, false);
            } finally {
                targetSocket.socket.abort();
                requesterSocket.socket.abort();
            }
        }
    }

    private void awaitRedisDnd(String key, String playerId, boolean expected) throws Exception {
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5);
        while (System.nanoTime() < deadline) {
            Double score = strings.opsForZSet().score(key, playerId);
            if ((score != null) == expected) return;
            Thread.sleep(50);
        }
        assertThat(strings.opsForZSet().score(key, playerId) != null).isEqualTo(expected);
    }

    private JsonNode setBlockFromWorld(Probe actor, long epoch, String targetId, boolean blocked) throws Exception {
        String requestId = "integration-block-" + UUID.randomUUID();
        actor.send(json.writeValueAsString(Map.of("type", "blockAction", "epoch", epoch,
            "requestId", requestId, "targetId", targetId, "blocked", blocked)));
        return actor.await(node -> node.path("type").asText().equals("blockAck")
            && node.path("requestId").asText().equals(requestId));
    }

    @Test void blockChangesRefreshExistingSessionsAcrossWorldProcesses() throws Exception {
        Browser blocker = signedIn();
        Browser target = signedIn();
        Browser witness = signedIn();
        String blockerUserId = json.readTree(blocker.get("me").body()).path("userId").asText();
        String targetUserId = json.readTree(target.get("me").body()).path("userId").asText();
        String userA = blockerUserId.compareTo(targetUserId) < 0 ? blockerUserId : targetUserId;
        String userB = blockerUserId.compareTo(targetUserId) < 0 ? targetUserId : blockerUserId;
        db.update("""
            INSERT INTO user_friendship(friendship_id,user_a_id,user_b_id,requested_by_user_id,status,resolved_at)
            VALUES (?,?,?,?,'ACCEPTED',CURRENT_TIMESTAMP(6))
            """, UUID.randomUUID().toString(), userA, userB, blockerUserId);
        String firstSpace = createSpace(blocker, "차단 변경 출발 공간", "PUBLIC", 20).path("id").asText();
        String secondSpace = createSpace(blocker, "차단 변경 원격 공간", "PUBLIC", 20).path("id").asText();
        AdditionalWorld remoteWorld = startAdditionalWorld();
        Probe blockerLocal = blocker.socketWithTicket(ORIGIN, blocker.ticket(firstSpace));
        Probe targetLocal = target.socketWithTicket(ORIGIN, target.ticket(firstSpace));
        Probe blockerRemote = blocker.socketWithTicket(ORIGIN, blocker.ticket(secondSpace), remoteWorld.port());
        Probe targetRemote = target.socketWithTicket(ORIGIN, target.ticket(secondSpace), remoteWorld.port());
        Probe witnessRemote = witness.socketWithTicket(ORIGIN, witness.ticket(secondSpace), remoteWorld.port());
        Probe witnessOtherSpace = witness.socketWithTicket(ORIGIN, witness.ticket(firstSpace), remoteWorld.port());
        try {
            blockerLocal.join("");
            JsonNode blockerLocalWelcome = blockerLocal.await(node -> node.path("type").asText().equals("welcome"));
            targetLocal.join("");
            JsonNode targetLocalWelcome = targetLocal.await(node -> node.path("type").asText().equals("welcome"));
            blockerRemote.join("");
            JsonNode blockerRemoteWelcome = blockerRemote.await(node -> node.path("type").asText().equals("welcome"));
            targetRemote.join("");
            JsonNode targetRemoteWelcome = targetRemote.await(node -> node.path("type").asText().equals("welcome"));
            witnessRemote.join("");
            witnessRemote.await(node -> node.path("type").asText().equals("welcome"));
            witnessOtherSpace.join("");
            JsonNode witnessOtherSpaceWelcome = witnessOtherSpace.await(node -> node.path("type").asText().equals("welcome"));

            for (Probe connected : List.of(blockerLocal, targetLocal, blockerRemote, targetRemote, witnessRemote, witnessOtherSpace)) {
                JsonNode initialBlockState = connected.await(node -> node.path("type").asText().equals("blockState"));
                assertThat(initialBlockState.path("playerIds").size()).isZero();
            }
            String targetLocalId = targetLocalWelcome.path("playerId").asText();
            String targetRemoteId = targetRemoteWelcome.path("playerId").asText();
            String blockRequestId = "cross-world-block-" + UUID.randomUUID();
            blockerLocal.send(json.writeValueAsString(Map.of(
                "type", "blockAction", "epoch", blockerLocalWelcome.path("epoch").asLong(),
                "requestId", blockRequestId, "targetId", targetLocalId, "blocked", true
            )));
            JsonNode blockAck = blockerLocal.await(node -> node.path("type").asText().equals("blockAck")
                && node.path("requestId").asText().equals(blockRequestId));
            assertThat(blockAck.path("accepted").asBoolean()).isTrue();
            assertThat(db.queryForObject("SELECT COUNT(*) FROM user_friendship WHERE user_a_id=? AND user_b_id=?",
                Integer.class, userA, userB)).isZero();

            JsonNode remoteBlockState = blockerRemote.await(node -> node.path("type").asText().equals("blockState")
                && node.path("playerIds").toString().contains(targetRemoteId));
            assertThat(remoteBlockState.path("playerIds").toString()).contains(targetRemoteId);

            String otherSpaceProfileRequestId = "other-space-profile-" + UUID.randomUUID();
            blockerRemote.send(json.writeValueAsString(Map.of(
                "type", "profileRequest", "epoch", blockerRemoteWelcome.path("epoch").asLong(),
                "requestId", otherSpaceProfileRequestId, "targetId", witnessOtherSpaceWelcome.path("playerId").asText()
            )));
            JsonNode otherSpaceProfile = blockerRemote.await(node -> node.path("type").asText().equals("profileDetails")
                && node.path("requestId").asText().equals(otherSpaceProfileRequestId));
            assertThat(otherSpaceProfile.path("accepted").asBoolean()).isFalse();
            assertThat(otherSpaceProfile.path("code").asText()).isEqualTo("PROFILE_UNAVAILABLE");
            assertThat(otherSpaceProfile.path("bio").asText()).isEmpty();
            assertThat(otherSpaceProfile.path("links")).isEmpty();
            Thread.sleep(300);

            String blockedProfileRequestId = "blocked-profile-" + UUID.randomUUID();
            blockerRemote.send(json.writeValueAsString(Map.of(
                "type", "profileRequest", "epoch", blockerRemoteWelcome.path("epoch").asLong(),
                "requestId", blockedProfileRequestId, "targetId", targetRemoteId
            )));
            JsonNode blockedProfile = blockerRemote.await(node -> node.path("type").asText().equals("profileDetails")
                && node.path("requestId").asText().equals(blockedProfileRequestId));
            assertThat(blockedProfile.path("accepted").asBoolean()).isFalse();
            assertThat(blockedProfile.path("code").asText()).isEqualTo("PROFILE_BLOCKED");
            assertThat(blockedProfile.path("bio").asText()).isEmpty();
            assertThat(blockedProfile.path("links")).isEmpty();

            String joinRequestId = "cross-world-join-" + UUID.randomUUID();
            blockerRemote.send(json.writeValueAsString(Map.of(
                "type", "joinRequest", "epoch", blockerRemoteWelcome.path("epoch").asLong(),
                "requestId", joinRequestId, "targetId", targetRemoteId
            )));
            JsonNode joinAck = blockerRemote.await(node -> node.path("type").asText().equals("joinRequestAck")
                && node.path("requestId").asText().equals(joinRequestId));
            assertThat(joinAck.path("accepted").asBoolean()).isFalse();
            assertThat(joinAck.path("code").asText()).isEqualTo("JOIN_BLOCKED");

            String pokeRequestId = "cross-world-poke-" + UUID.randomUUID();
            blockerRemote.send(json.writeValueAsString(Map.of(
                "type", "poke", "epoch", blockerRemoteWelcome.path("epoch").asLong(),
                "requestId", pokeRequestId, "targetId", targetRemoteId
            )));
            JsonNode pokeAck = blockerRemote.await(node -> node.path("type").asText().equals("pokeAck")
                && node.path("requestId").asText().equals(pokeRequestId));
            assertThat(pokeAck.path("accepted").asBoolean()).isFalse();
            assertThat(pokeAck.path("code").asText()).isEqualTo("POKE_BLOCKED");

            String chatMessageId = "cross-world-blocked-chat-" + UUID.randomUUID();
            targetRemote.send(json.writeValueAsString(Map.of(
                "type", "chatSend", "clientMessageId", chatMessageId,
                "epoch", targetRemoteWelcome.path("epoch").asLong(), "channel", "space",
                "conversationId", "", "text", "차단되지 않은 참가자에게만 전달"
            )));
            JsonNode chatAck = targetRemote.await(node -> node.path("type").asText().equals("chatAck")
                && node.path("clientMessageId").asText().equals(chatMessageId));
            assertThat(chatAck.path("accepted").asBoolean()).isTrue();
            JsonNode witnessMessage = witnessRemote.await(node -> node.path("type").asText().equals("chatEvent")
                && node.path("clientMessageId").asText().equals(chatMessageId));
            assertThat(witnessMessage.path("senderId").asText()).isEqualTo(targetRemoteId);
            boolean leakedToBlockedAccount = false;
            long deadline = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(300);
            while (System.nanoTime() < deadline) {
                JsonNode received = blockerRemote.messages.poll(25, TimeUnit.MILLISECONDS);
                if (received != null && received.path("type").asText().equals("chatEvent")
                    && received.path("clientMessageId").asText().equals(chatMessageId)) {
                    leakedToBlockedAccount = true;
                    break;
                }
            }
            assertThat(leakedToBlockedAccount).isFalse();

            String unblockRequestId = "cross-world-unblock-" + UUID.randomUUID();
            blockerLocal.send(json.writeValueAsString(Map.of(
                "type", "blockAction", "epoch", blockerLocalWelcome.path("epoch").asLong(),
                "requestId", unblockRequestId, "targetId", targetLocalId, "blocked", false
            )));
            JsonNode unblockAck = blockerLocal.await(node -> node.path("type").asText().equals("blockAck")
                && node.path("requestId").asText().equals(unblockRequestId));
            assertThat(unblockAck.path("accepted").asBoolean()).isTrue();
            JsonNode clearedRemoteBlockState = blockerRemote.await(node -> node.path("type").asText().equals("blockState")
                && node.path("playerIds").isEmpty());
            assertThat(clearedRemoteBlockState.path("playerIds")).isEmpty();

            JsonNode targetToBlockerPending = ok(target.post("/me/friends/requests", Map.of("targetUserId", blockerUserId)));
            assertThat(targetToBlockerPending.path("status").asText()).isEqualTo("PENDING");
            JsonNode blockedTargetToBlocker = setBlockFromWorld(blockerLocal, blockerLocalWelcome.path("epoch").asLong(),
                targetLocalId, true);
            assertThat(blockedTargetToBlocker.path("accepted").asBoolean()).isTrue();
            assertThat(db.queryForObject("SELECT COUNT(*) FROM user_friendship WHERE user_a_id=? AND user_b_id=?",
                Integer.class, userA, userB)).isZero();
            JsonNode pendingBlockRemoteState = blockerRemote.await(node -> node.path("type").asText().equals("blockState")
                && node.path("playerIds").toString().contains(targetRemoteId));
            assertThat(pendingBlockRemoteState.path("playerIds").toString()).contains(targetRemoteId);
            JsonNode unblockTargetToBlocker = setBlockFromWorld(blockerLocal, blockerLocalWelcome.path("epoch").asLong(),
                targetLocalId, false);
            assertThat(unblockTargetToBlocker.path("accepted").asBoolean()).isTrue();
            JsonNode afterPendingUnblockState = blockerRemote.await(node -> node.path("type").asText().equals("blockState")
                && node.path("playerIds").isEmpty());
            assertThat(afterPendingUnblockState.path("playerIds")).isEmpty();
            assertThat(db.queryForObject("SELECT COUNT(*) FROM user_friendship WHERE user_a_id=? AND user_b_id=?",
                Integer.class, userA, userB)).isZero();
            assertThat(ok(target.get("/me/friends")).path("outgoing").findValuesAsText("userId")).doesNotContain(blockerUserId);
            assertThat(ok(blocker.get("/me/friends")).path("incoming").findValuesAsText("userId")).doesNotContain(targetUserId);

            JsonNode blockerToTargetPending = ok(blocker.post("/me/friends/requests", Map.of("targetUserId", targetUserId)));
            assertThat(blockerToTargetPending.path("status").asText()).isEqualTo("PENDING");
            JsonNode blockedBlockerToTarget = setBlockFromWorld(blockerLocal, blockerLocalWelcome.path("epoch").asLong(),
                targetLocalId, true);
            assertThat(blockedBlockerToTarget.path("accepted").asBoolean()).isTrue();
            assertThat(db.queryForObject("SELECT COUNT(*) FROM user_friendship WHERE user_a_id=? AND user_b_id=?",
                Integer.class, userA, userB)).isZero();
            JsonNode blockerToTargetRemoteState = blockerRemote.await(node -> node.path("type").asText().equals("blockState")
                && node.path("playerIds").toString().contains(targetRemoteId));
            assertThat(blockerToTargetRemoteState.path("playerIds").toString()).contains(targetRemoteId);
            JsonNode unblockBlockerToTarget = setBlockFromWorld(blockerLocal, blockerLocalWelcome.path("epoch").asLong(),
                targetLocalId, false);
            assertThat(unblockBlockerToTarget.path("accepted").asBoolean()).isTrue();
            JsonNode afterReversePendingUnblockState = blockerRemote.await(node -> node.path("type").asText().equals("blockState")
                && node.path("playerIds").isEmpty());
            assertThat(afterReversePendingUnblockState.path("playerIds")).isEmpty();
            assertThat(db.queryForObject("SELECT COUNT(*) FROM user_friendship WHERE user_a_id=? AND user_b_id=?",
                Integer.class, userA, userB)).isZero();
            assertThat(ok(blocker.get("/me/friends")).path("outgoing").findValuesAsText("userId")).doesNotContain(targetUserId);
            assertThat(ok(target.get("/me/friends")).path("incoming").findValuesAsText("userId")).doesNotContain(blockerUserId);
        } finally {
            blockerLocal.socket.abort();
            targetLocal.socket.abort();
            blockerRemote.socket.abort();
            targetRemote.socket.abort();
            witnessRemote.socket.abort();
            witnessOtherSpace.socket.abort();
            remoteWorld.close();
        }
    }

    @Test void dmEditsKeepPrivateRevisionHistoryAndDeletionErasesOldBodies() throws Exception {
        try (AdditionalWorld remoteWorld = startAdditionalWorld()) {
        Browser sender = signedIn();
        Browser reader = signedIn();
        Browser outsider = signedIn();
        String senderId = json.readTree(sender.get("me").body()).path("userId").asText();
        String readerId = json.readTree(reader.get("me").body()).path("userId").asText();
        String conversationId = UUID.randomUUID().toString();
        String pairKey = senderId.compareTo(readerId) < 0 ? senderId + ":" + readerId : readerId + ":" + senderId;
        db.update("INSERT INTO direct_conversation(id,pair_key) VALUES (?,?)", conversationId, pairKey);
        db.update("""
            INSERT INTO direct_conversation_member(membership_id,conversation_id,user_id)
            VALUES (UUID(),?,?),(UUID(),?,?)
            """, conversationId, senderId, conversationId, readerId);
        String messageId = UUID.randomUUID().toString();
        db.update("""
            INSERT INTO direct_message(message_id,conversation_id,sender_user_id,sender_player_id,client_message_id,
                sender_name,sender_avatar,sender_skin,sender_clothing,sender_hair,body,content_hash,sent_at,expires_at)
            VALUES (?,?,?,?,?,'수정 이력 테스트',0,'light','casual_white','hair_short_black','처음 본문',?,
                CURRENT_TIMESTAMP(3)-INTERVAL 1 MINUTE,CURRENT_TIMESTAMP(6)+INTERVAL 1 DAY)
            """, messageId, conversationId, senderId, UUID.randomUUID().toString(), "revision-history-test", "d".repeat(64));
        String historyPath = "/dms/" + conversationId + "/messages/" + messageId + "/revisions";
        assertThat(sender.get(historyPath).statusCode()).isEqualTo(200);
        assertThat(json.readTree(reader.get(historyPath).body())).isEmpty();
        assertThat(outsider.get(historyPath).statusCode()).isEqualTo(404);

        Probe senderSocket = sender.socket(ORIGIN);
        Probe readerSocket = reader.socketWithTicket(ORIGIN, reader.ticket(CAMPUS), remoteWorld.port());
        try {
            senderSocket.join("");
            JsonNode senderWelcome = senderSocket.await(node -> node.path("type").asText().equals("welcome"));
            readerSocket.join("");
            JsonNode readerWelcome = readerSocket.await(node -> node.path("type").asText().equals("welcome"));
            senderSocket.await(node -> node.path("type").asText().equals("blockState"));
            readerSocket.await(node -> node.path("type").asText().equals("blockState"));
            senderSocket.send(json.writeValueAsString(Map.of(
                "type", "chatSend", "clientMessageId", "cross-world-message", "epoch", senderWelcome.path("epoch").asLong(),
                "channel", "dm", "conversationId", conversationId, "text", "다른 월드 노드에서 받은 메시지"
            )));
            JsonNode chatAck = senderSocket.await(node -> node.path("type").asText().equals("chatAck")
                && node.path("clientMessageId").asText().equals("cross-world-message"));
            assertThat(chatAck.path("accepted").asBoolean()).isTrue();
            JsonNode relayedMessage = readerSocket.await(node -> node.path("type").asText().equals("chatEvent")
                && node.path("text").asText().equals("다른 월드 노드에서 받은 메시지"));
            assertThat(relayedMessage.path("channel").asText()).isEqualTo("dm");

            // Pause every Redis client request. The secondary world must still deliver from the SQL outbox.
            redis.execInContainer("redis-cli", "CLIENT", "PAUSE", "1200", "WRITE");
            senderSocket.send(json.writeValueAsString(Map.of(
                "type", "chatSend", "clientMessageId", "cross-world-outbox-recovery", "epoch", senderWelcome.path("epoch").asLong(),
                "channel", "dm", "conversationId", conversationId, "text", "Redis 중단 중에도 전달되는 메시지"
            )));
            JsonNode pausedRedisAck = senderSocket.await(node -> node.path("type").asText().equals("chatAck")
                && node.path("clientMessageId").asText().equals("cross-world-outbox-recovery"));
            assertThat(pausedRedisAck.path("accepted").asBoolean()).isTrue();
            JsonNode recoveredMessage = readerSocket.await(node -> node.path("type").asText().equals("chatEvent")
                && node.path("text").asText().equals("Redis 중단 중에도 전달되는 메시지"), java.time.Duration.ofMillis(900));
            assertThat(recoveredMessage.path("channel").asText()).isEqualTo("dm");
            Thread.sleep(1400); // Let Redis resume before the HTTP session repository is used again.

            readerSocket.send(json.writeValueAsString(Map.of(
                "type", "directMessageMutationRequest", "epoch", readerWelcome.path("epoch").asLong(),
                "requestId", "not-author-edit", "conversationId", conversationId, "messageId", messageId,
                "action", "EDIT", "text", "허용되면 안 되는 변경"
            )));
            JsonNode rejected = readerSocket.await(node -> node.path("type").asText().equals("directMessageMutationAck"));
            assertThat(rejected.path("accepted").asBoolean()).isFalse();
            assertThat(rejected.path("code").asText()).isEqualTo("DM_NOT_AUTHOR");

            senderSocket.send(json.writeValueAsString(Map.of(
                "type", "directMessageMutationRequest", "epoch", senderWelcome.path("epoch").asLong(),
                "requestId", "edit-history-one", "conversationId", conversationId, "messageId", messageId,
                "action", "EDIT", "text", "두 번째 본문"
            )));
            JsonNode firstAck = senderSocket.await(node -> node.path("type").asText().equals("directMessageMutationAck")
                && node.path("requestId").asText().equals("edit-history-one"));
            assertThat(firstAck.path("accepted").asBoolean()).as(firstAck.toString()).isTrue();
            readerSocket.await(node -> node.path("type").asText().equals("directMessageMutationEvent")
                && node.path("revision").asInt() == 1);
            JsonNode firstHistory = json.readTree(reader.get(historyPath).body());
            assertThat(firstHistory).hasSize(1);
            assertThat(firstHistory.get(0).path("revision").asInt()).isZero();
            assertThat(firstHistory.get(0).path("text").asText()).isEqualTo("처음 본문");

            Thread.sleep(850);
            senderSocket.send(json.writeValueAsString(Map.of(
                "type", "directMessageMutationRequest", "epoch", senderWelcome.path("epoch").asLong(),
                "requestId", "edit-history-two", "conversationId", conversationId, "messageId", messageId,
                "action", "EDIT", "text", "세 번째 본문"
            )));
            JsonNode secondAck = senderSocket.await(node -> node.path("type").asText().equals("directMessageMutationAck")
                && node.path("requestId").asText().equals("edit-history-two"));
            assertThat(secondAck.path("accepted").asBoolean()).isTrue();
            JsonNode versions = json.readTree(sender.get(historyPath).body());
            assertThat(versions).hasSize(2);
            assertThat(versions.get(0).path("revision").asInt()).isEqualTo(1);
            assertThat(versions.get(0).path("text").asText()).isEqualTo("두 번째 본문");
            assertThat(versions.get(1).path("revision").asInt()).isZero();
            assertThat(versions.get(1).path("text").asText()).isEqualTo("처음 본문");

            readerSocket.send(json.writeValueAsString(Map.of(
                "type", "directMessageReadRequest", "epoch", readerWelcome.path("epoch").asLong(),
                "requestId", "read-across-world", "conversationId", conversationId, "messageId", messageId
            )));
            JsonNode readAck = readerSocket.await(node -> node.path("type").asText().equals("directMessageReadAck")
                && node.path("requestId").asText().equals("read-across-world"));
            assertThat(readAck.path("accepted").asBoolean()).isTrue();
            JsonNode relayedRead = senderSocket.await(node -> node.path("type").asText().equals("directMessageReadEvent")
                && node.path("messageId").asText().equals(messageId));
            assertThat(relayedRead.path("readerMemberId").asText()).isNotBlank();

            Thread.sleep(850);
            senderSocket.send(json.writeValueAsString(Map.of(
                "type", "directMessageMutationRequest", "epoch", senderWelcome.path("epoch").asLong(),
                "requestId", "delete-history-message", "conversationId", conversationId, "messageId", messageId,
                "action", "DELETE", "text", ""
            )));
            JsonNode deleteAck = senderSocket.await(node -> node.path("type").asText().equals("directMessageMutationAck")
                && node.path("requestId").asText().equals("delete-history-message"));
            assertThat(deleteAck.path("accepted").asBoolean()).isTrue();
            assertThat(sender.get(historyPath).statusCode()).isEqualTo(404);
            assertThat(db.queryForObject("SELECT COUNT(*) FROM direct_message_revision WHERE message_id=?", Integer.class, messageId)).isZero();
        } finally {
            senderSocket.socket.abort();
            readerSocket.socket.abort();
        }
        }
    }

    @Test void persistedChatRetryAfterWorldNodeReconnectReusesStoredMessageWithoutDuplicateDelivery() throws Exception {
        Browser sender = signedIn();
        Browser receiver = signedIn();
        String spaceId = createSpace(sender, "월드 이동 채팅 복구", "PUBLIC", 10).path("id").asText();
        String senderId = json.readTree(sender.get("me").body()).path("userId").asText();
        String clientMessageId = "cross-node-chat-retry-0001";
        String text = "저장 이후 월드 노드를 옮겨도 한 번만 전달";

        try (AdditionalWorld otherWorld = startAdditionalWorld()) {
            Probe initialSender = sender.socketWithTicket(ORIGIN, sender.ticket(spaceId), worldPort);
            Probe liveReceiver = receiver.socketWithTicket(ORIGIN, receiver.ticket(spaceId), worldPort);
            Probe resumedSender = null;
            try {
                initialSender.join("");
                JsonNode initialWelcome = initialSender.await(node -> node.path("type").asText().equals("welcome"));
                liveReceiver.join("");
                liveReceiver.await(node -> node.path("type").asText().equals("welcome"));
                String resumeToken = initialWelcome.path("resumeToken").asText();

                initialSender.send(json.writeValueAsString(Map.of("type", "chatSend",
                    "clientMessageId", clientMessageId, "epoch", initialWelcome.path("epoch").asLong(),
                    "channel", "space", "conversationId", "", "text", text)));
                liveReceiver.await(node -> node.path("type").asText().equals("chatEvent")
                    && node.path("clientMessageId").asText().equals(clientMessageId));
                // The recipient and DB prove the commit while this sender never processes its event or ACK.
                assertThat(db.queryForObject("""
                    SELECT COUNT(*) FROM chat_message
                    WHERE space_id=? AND sender_user_id=? AND client_message_id=?
                    """, Integer.class, spaceId, senderId, clientMessageId)).isEqualTo(1);

                String seatId = strings.opsForZSet().range("hufs-town:seats:" + spaceId, 0, -1)
                    .stream().findFirst().orElseThrow();
                String ownerKey = "hufs-town:seat-owner:" + spaceId + ":" + seatId;
                assertThat(strings.opsForValue().get(ownerKey)).isNotBlank();
                // Model a partitioned old world node that loses its owner lease while the browser reconnects elsewhere.
                strings.delete(ownerKey);
                String resumeTicket = sender.ticket(spaceId, spaceId, resumeToken);
                resumedSender = sender.socketWithTicket(ORIGIN, resumeTicket, otherWorld.port());
                resumedSender.join(resumeToken);
                JsonNode resumedWelcome = resumedSender.await(node -> node.path("type").asText().equals("welcome"));
                assertThat(resumedWelcome.path("resumeToken").asText()).isEqualTo(resumeToken);
                assertThat(initialSender.await(node -> node.path("code").asText().equals("WORLD_OWNER_LOST"))).isNotNull();

                resumedSender.send(json.writeValueAsString(Map.of("type", "chatSend",
                    "clientMessageId", clientMessageId, "epoch", resumedWelcome.path("epoch").asLong(),
                    "channel", "space", "conversationId", "", "text", text)));
                JsonNode replay = resumedSender.await(node -> node.path("type").asText().equals("chatEvent")
                    && node.path("clientMessageId").asText().equals(clientMessageId));
                assertThat(replay.path("text").asText()).isEqualTo(text);
                JsonNode retryAck = resumedSender.await(node -> node.path("type").asText().equals("chatAck")
                    && node.path("clientMessageId").asText().equals(clientMessageId));
                assertThat(retryAck.path("accepted").asBoolean()).isTrue();
                assertThat(db.queryForObject("""
                    SELECT COUNT(*) FROM chat_message
                    WHERE space_id=? AND sender_user_id=? AND client_message_id=?
                    """, Integer.class, spaceId, senderId, clientMessageId)).isEqualTo(1);
                assertThat(liveReceiver.messages.stream().noneMatch(node -> node.path("type").asText().equals("chatEvent")
                    && node.path("clientMessageId").asText().equals(clientMessageId))).isTrue();

                resumedSender.send(json.writeValueAsString(Map.of("type", "chatSend",
                    "clientMessageId", clientMessageId, "epoch", resumedWelcome.path("epoch").asLong(),
                    "channel", "space", "conversationId", "", "text", "같은 ID의 다른 본문")));
                JsonNode conflict = resumedSender.await(node -> node.path("type").asText().equals("chatAck")
                    && node.path("clientMessageId").asText().equals(clientMessageId)
                    && !node.path("accepted").asBoolean());
                assertThat(conflict.path("code").asText()).isEqualTo("CHAT_IDEMPOTENCY_CONFLICT");
                assertThat(db.queryForObject("""
                    SELECT COUNT(*) FROM chat_message
                    WHERE space_id=? AND sender_user_id=? AND client_message_id=?
                    """, Integer.class, spaceId, senderId, clientMessageId)).isEqualTo(1);
            } finally {
                initialSender.socket.abort();
                liveReceiver.socket.abort();
                if (resumedSender != null) resumedSender.socket.abort();
            }
        }
    }

    @Test void stateIsBrowserBoundOneUseAndMissingCsrfNeverCallsProvider() throws Exception {
        Browser a = new Browser(); Browser b = new Browser();
        String state = a.start();
        assertThat(b.post("exchange", Map.of("code", "foreign-test-code", "state", state)).statusCode()).isEqualTo(400);
        String valid = state; // A different browser must not consume this browser's pending flow.
        assertThat(a.rawPost("exchange", json.writeValueAsString(Map.of("code", "csrf-test", "state", valid)), null).statusCode()).isEqualTo(403);
        expectUser("22222222-2222-4222-8222-222222222222", "GRADUATED");
        assertThat(a.post("exchange", Map.of("code", "single-use-test", "state", valid)).statusCode()).isEqualTo(200);
        assertThat(a.post("exchange", Map.of("code", "single-use-test", "state", valid)).statusCode()).isEqualTo(400);
        String another = a.start();
        assertThat(a.post("exchange", Map.of("code", "single-use-test", "state", another)).statusCode()).isEqualTo(401);
        transport.server().verify();
    }

    @Test void publicPasswordRegistrationAndLoginAreDisabled() throws Exception {
        Browser b = new Browser();
        assertThat(b.post("register", Map.of("email", "not-a-hufs-account@example.invalid", "password", "long-password-123"))
            .statusCode()).isEqualTo(401);
        assertThat(b.post("login", Map.of("email", "not-a-hufs-account@example.invalid", "password", "long-password-123"))
            .statusCode()).isEqualTo(401);
        assertThat(db.queryForObject("SELECT COUNT(*) FROM public_password_account WHERE email=?", Integer.class,
            "not-a-hufs-account@example.invalid")).isZero();
    }

    @Test void allHufsAccountTypesCanSignInAndBlockedLocalAccountsDoNotReceiveSessions() throws Exception {
        Browser b = new Browser();
        String[] accountTypes = {"ENROLLED", "LEAVE_OF_ABSENCE", "GRADUATED", "FACULTY", "STAFF", "COMMON_ACCOUNT", "UNKNOWN"};
        int index = 0;
        for (String accountType : accountTypes) {
            String subject = "33333333-3333-4333-8333-" + String.format("%012d", 100 + index);
            String state = b.start();
            expectUser(subject, accountType);
            assertThat(b.post("exchange", Map.of("code", "account-type-test-" + index, "state", state)).statusCode()).isEqualTo(200);
            assertThat(b.get("me").statusCode()).isEqualTo(200);
            b.post("logout", Map.of());
            index++;
        }
        String state = b.start();
        expectUser("44444444-4444-4444-8444-444444444444", "PROFESSOR");
        String id = json.readTree(b.post("exchange", Map.of("code", "before-block-test", "state", state)).body()).path("userId").asText();
        b.post("logout", Map.of());
        db.update("UPDATE app_user SET status='BLOCKED' WHERE id=?", id);
        state = b.start();
        expectUser("44444444-4444-4444-8444-444444444444", "PROFESSOR");
        assertThat(b.post("exchange", Map.of("code", "after-block-test", "state", state)).statusCode()).isEqualTo(403);
        assertThat(b.get("me").statusCode()).isEqualTo(401);
        transport.server().verify();
    }

    @Test void protectedWorldRequiresSessionAndExactOrigin() throws Exception {
        Browser b = new Browser();
        assertThatThrownBy(() -> b.socket(ORIGIN)).hasCauseInstanceOf(WebSocketHandshakeException.class);
        String state = b.start();
        expectUser("55555555-5555-4555-8555-555555555555", "LECTURER");
        assertThat(b.post("exchange", Map.of("code", "origin-test", "state", state)).statusCode()).isEqualTo(200);
        assertThatThrownBy(() -> b.socket("http://different.example.invalid")).hasCauseInstanceOf(WebSocketHandshakeException.class);
        assertThatThrownBy(() -> b.socket(null)).hasCauseInstanceOf(WebSocketHandshakeException.class);
    }
    @Test void expiresLoginStateAndServiceSessionUsingRealRedisTtls() throws Exception {
        Browser b = new Browser();
        String state = b.start();
        byte[] preLoginSessionId = Base64.getDecoder().decode(b.cookie());
        String digest = HexFormat.of().formatHex(java.security.MessageDigest.getInstance("SHA-256").digest(preLoginSessionId));
        strings.expire("hufs-town:auth:state:" + digest, java.time.Duration.ZERO);
        assertThat(b.post("exchange", Map.of("code", "expired-state-test", "state", state)).statusCode()).isEqualTo(400);
        state = b.start();
        expectUser("66666666-6666-4666-8666-666666666666", "ATTENDING");
        assertThat(b.post("exchange", Map.of("code", "expiry-session-test", "state", state)).statusCode()).isEqualTo(200);
        assertThat(b.patch("profile", Map.of("displayName", "bad", "avatar", 9)).statusCode()).isEqualTo(400);
        String sessionId = new String(Base64.getDecoder().decode(b.cookie()), java.nio.charset.StandardCharsets.UTF_8);
        var session = sessions.findById(sessionId);
        ((org.springframework.session.Session)session).setMaxInactiveInterval(java.time.Duration.ofSeconds(1));
        sessions.save(session);
        Thread.sleep(1200);
        assertThat(b.get("me").statusCode()).isEqualTo(401);
        assertThatThrownBy(() -> b.socket(ORIGIN)).hasCauseInstanceOf(WebSocketHandshakeException.class);
    }
    @Test void spacesPersistVisibilityOwnerPermissionsAndMembership() throws Exception {
        Browser owner = signedIn(); Browser visitor = signedIn();
        assertThat(new Browser().get("/spaces").statusCode()).isEqualTo(401);
        JsonNode created = createSpace(owner, "비공개 스터디", "PRIVATE", 10);
        String id = created.path("id").asText();
        assertThat(created.path("role").asText()).isEqualTo("OWNER");
        assertThat(visitor.get("/spaces/" + id).statusCode()).isEqualTo(404);
        assertThat(visitor.get("/spaces").body()).doesNotContain(id);
        assertThat(visitor.post("/spaces/" + id + "/admission", Map.of()).statusCode()).isEqualTo(404);
        assertThat(visitor.patch("/spaces/" + id, Map.of("name", "변경", "description", "", "visibility", "PUBLIC")).statusCode()).isEqualTo(403);
        assertThat(owner.patch("/spaces/" + id, Map.of("name", "링크 스터디", "description", "새 소개", "visibility", "UNLISTED")).statusCode()).isEqualTo(200);
        assertThat(visitor.get("/spaces").body()).doesNotContain(id);
        assertThat(visitor.get("/spaces/" + id).statusCode()).isEqualTo(200);
        assertThat(visitor.post("/spaces/" + id + "/admission", Map.of()).statusCode()).isEqualTo(200);
        assertThat(visitor.get("/spaces").body()).contains(id);
        assertThat(owner.patch("/spaces/" + id, Map.of("name", "우리 스터디", "description", "새 소개", "visibility", "PRIVATE")).statusCode()).isEqualTo(200);
        assertThat(visitor.get("/spaces/" + id).statusCode()).isEqualTo(200); // Existing members retain access.
        assertThat(visitor.get("/spaces/" + id + "/invites").statusCode()).isEqualTo(403);
        assertThat(owner.post("/spaces", Map.of("name", " ", "description", "", "visibility", "PUBLIC", "capacity", 101)).statusCode()).isEqualTo(400);
        assertThat(db.queryForObject("SELECT name FROM town_space WHERE id=?", String.class, id)).isEqualTo("우리 스터디");
        db.update("UPDATE app_user SET status='BLOCKED' WHERE id=?", json.readTree(visitor.get("me").body()).path("userId").asText());
        assertThat(visitor.post("/spaces/" + id + "/admission", Map.of()).statusCode()).isEqualTo(403);
    }

    @Test void publishedBoardWhiteboardMergesIdempotentStrokesAndRestrictsClear() throws Exception {
        Browser owner = signedIn();
        String memberSubject = UUID.randomUUID().toString();
        Browser member = signedInAs(memberSubject);
        Browser outsider = signedIn();
        String spaceId = createSpace(owner, "공동 화이트보드 검증", "PUBLIC", 10).path("id").asText();
        String ownerId = json.readTree(owner.get("me").body()).path("userId").asText();
        assertThat(member.post("/spaces/" + spaceId + "/admission", Map.of()).statusCode()).isEqualTo(200);
        assertThat(owner.get("/spaces/" + spaceId + "/map").statusCode()).isEqualTo(200);
        String map = db.queryForObject("SELECT document FROM map_revision WHERE space_id=? AND map_id=? ORDER BY sequence_no DESC LIMIT 1",
            String.class, spaceId, spaceId);
        var mapObject = (com.fasterxml.jackson.databind.node.ObjectNode) json.readTree(map);
        var board = json.createObjectNode();
        board.put("id", "shared-board"); board.put("asset", "whiteboard"); board.put("x", 10); board.put("y", 10); board.put("scale", 1);
        var interaction = board.putObject("interaction"); interaction.put("kind", "BOARD"); interaction.put("title", "공동 보드");
        interaction.put("body", "함께 그리는 공간"); interaction.put("url", ""); interaction.put("assetId", ""); interaction.put("radius", 0); interaction.put("volume", 0);
        mapObject.withArray("objects").add(board);
        String published = json.writeValueAsString(mapObject);
        String revision = UUID.randomUUID().toString();
        long sequence = db.queryForObject("SELECT published_sequence+1 FROM space_map WHERE space_id=? AND map_id=?", Long.class, spaceId, spaceId);
        String hash = HexFormat.of().formatHex(java.security.MessageDigest.getInstance("SHA-256")
            .digest(published.getBytes(java.nio.charset.StandardCharsets.UTF_8)));
        db.update("INSERT INTO map_revision(id,space_id,map_id,sequence_no,document,content_hash,actor_id,reason) VALUES (?,?,?,?,?,?,?,'PUBLISH')",
            revision, spaceId, spaceId, sequence, published, hash, ownerId);
        db.update("UPDATE space_map SET draft_json=?,published_id=?,published_sequence=? WHERE space_id=? AND map_id=?",
            published, revision, sequence, spaceId, spaceId);

        String root = "/spaces/" + spaceId + "/boards/shared-board/whiteboard";
        assertThat(new Browser().get(root).statusCode()).isEqualTo(401);
        assertThat(outsider.get("/spaces/" + spaceId).statusCode()).isEqualTo(200);
        assertThat(outsider.get(root).statusCode()).isEqualTo(404);
        var initial = owner.get(root);
        assertThat(initial.statusCode()).as(initial.body()).isEqualTo(200);
        assertThat(json.readTree(initial.body()).path("revision").asLong()).isZero();
        assertThat(json.readTree(initial.body()).path("canClear").asBoolean()).isTrue();

        String operationId = UUID.randomUUID().toString();
        var mutation = Map.of("operationId", operationId, "kind", "ADD_STROKE", "expectedRevision", 0,
            "stroke", Map.of("color", "#2563eb", "width", 7,
                "points", List.of(Map.of("x", 120, "y", 80), Map.of("x", 240, "y", 400))));
        var first = owner.post(root + "/operations", mutation);
        assertThat(first.statusCode()).as(first.body()).isEqualTo(200);
        assertThat(json.readTree(first.body()).path("revision").asLong()).isEqualTo(1);
        assertThat(json.readTree(first.body()).path("strokes")).hasSize(1);
        var duplicate = owner.post(root + "/operations", mutation);
        assertThat(duplicate.statusCode()).as(duplicate.body()).isEqualTo(200);
        assertThat(json.readTree(duplicate.body()).path("revision").asLong()).isEqualTo(1);
        Browser reconnectedMember = signedInAs(memberSubject);
        assertThat(json.readTree(reconnectedMember.get(root).body()).path("strokes")).hasSize(1);

        var concurrentA = Map.of("operationId", UUID.randomUUID().toString(), "kind", "ADD_STROKE", "expectedRevision", 1,
            "stroke", Map.of("color", "#dc2626", "width", 7,
                "points", List.of(Map.of("x", 400, "y", 140), Map.of("x", 600, "y", 420))));
        var concurrentB = Map.of("operationId", UUID.randomUUID().toString(), "kind", "ADD_STROKE", "expectedRevision", 1,
            "stroke", Map.of("color", "#16a34a", "width", 7,
                "points", List.of(Map.of("x", 600, "y", 140), Map.of("x", 400, "y", 420))));
        try (var pool = Executors.newFixedThreadPool(2)) {
            var start = new CountDownLatch(1);
            var firstStroke = pool.submit(() -> { start.await(); return owner.post(root + "/operations", concurrentA); });
            var secondStroke = pool.submit(() -> { start.await(); return member.post(root + "/operations", concurrentB); });
            start.countDown();
            assertThat(firstStroke.get(10, TimeUnit.SECONDS).statusCode()).isEqualTo(200);
            assertThat(secondStroke.get(10, TimeUnit.SECONDS).statusCode()).isEqualTo(200);
        }
        var collaborativelyEdited = reconnectedMember.get(root);
        assertThat(json.readTree(collaborativelyEdited.body()).path("revision").asLong()).isEqualTo(3);
        assertThat(json.readTree(collaborativelyEdited.body()).path("strokes")).hasSize(3);

        var forbiddenClear = member.post(root + "/operations", Map.of("operationId", UUID.randomUUID().toString(),
            "kind", "CLEAR", "expectedRevision", 3));
        assertThat(forbiddenClear.statusCode()).isEqualTo(403);
        var staleClear = owner.post(root + "/operations", Map.of("operationId", UUID.randomUUID().toString(),
            "kind", "CLEAR", "expectedRevision", 0));
        assertThat(staleClear.statusCode()).isEqualTo(409);
        var cleared = owner.post(root + "/operations", Map.of("operationId", UUID.randomUUID().toString(),
            "kind", "CLEAR", "expectedRevision", 3));
        assertThat(cleared.statusCode()).as(cleared.body()).isEqualTo(200);
        assertThat(json.readTree(reconnectedMember.get(root).body()).path("strokes")).isEmpty();
        assertThat(db.queryForObject("SELECT COUNT(*) FROM space_board_whiteboard_operation WHERE space_id=? AND board_id=?",
            Integer.class, spaceId, "shared-board")).isEqualTo(4);
        assertThat(owner.get("/spaces/" + spaceId + "/boards/unpublished/whiteboard").statusCode()).isEqualTo(404);
    }

    @Test void archivedSpacesAreOwnerScopedHiddenUntilRestored() throws Exception {
        Browser owner = signedIn();
        Browser anotherAccount = signedIn();
        JsonNode created = createSpace(owner, "보관 및 복원 검증", "PUBLIC", 10);
        String spaceId = created.path("id").asText();
        assertThat(created.path("archived").asBoolean()).isFalse();

        assertThat(anotherAccount.get("/spaces?view=browse").body()).contains(spaceId);
        Probe liveMember = anotherAccount.socketWithTicket(ORIGIN, anotherAccount.ticketDefault(spaceId));
        liveMember.join("");
        liveMember.await(node -> node.path("type").asText().equals("welcome"));
        var unauthorizedArchive = anotherAccount.post("/spaces/" + spaceId + "/archive", Map.of());
        assertThat(unauthorizedArchive.statusCode()).isIn(403, 404);
        assertThat(db.queryForObject("SELECT archived_at FROM town_space WHERE id=?", Timestamp.class, spaceId)).isNull();
        String memberUserId = json.readTree(anotherAccount.get("me").body()).path("userId").asText();
        var transfer = owner.post("/spaces/" + spaceId + "/ownership-transfer", Map.of("targetUserId", memberUserId));
        assertThat(transfer.statusCode()).as(transfer.body()).isEqualTo(200);
        var pendingTransferArchive = owner.post("/spaces/" + spaceId + "/archive", Map.of());
        assertThat(pendingTransferArchive.statusCode()).isEqualTo(409);
        assertThat(json.readTree(pendingTransferArchive.body()).path("code").asText()).isEqualTo("SPACE_TRANSFER_PENDING");
        assertThat(owner.delete("/spaces/" + spaceId + "/ownership-transfer", Map.of()).statusCode()).isEqualTo(200);

        try {
            var archived = owner.post("/spaces/" + spaceId + "/archive", Map.of());
            assertThat(archived.statusCode()).as(archived.body()).isEqualTo(200);
            assertThat(json.readTree(archived.body()).path("archived").asBoolean()).isTrue();
            liveMember.await(node -> node.path("code").asText().equals("SPACE_ACCESS_REVOKED"));
            liveMember.closed.get(5, TimeUnit.SECONDS);
        } finally { liveMember.socket.abort(); }
        assertThat(db.queryForObject("SELECT archived_at FROM town_space WHERE id=?", Timestamp.class, spaceId)).isNotNull();
        var archivedBrowse = owner.get("/spaces?view=browse");
        assertThat(archivedBrowse.statusCode()).as(archivedBrowse.body()).isEqualTo(200);
        assertThat(archivedBrowse.body()).doesNotContain(spaceId);
        var archivedMine = owner.get("/spaces?view=mine");
        assertThat(archivedMine.statusCode()).as(archivedMine.body()).isEqualTo(200);
        assertThat(archivedMine.body()).doesNotContain(spaceId);
        assertThat(owner.get("/spaces/" + spaceId).statusCode()).isEqualTo(404);

        var archiveListResponse = owner.get("/spaces?view=archived");
        JsonNode ownerArchiveList = json.readTree(archiveListResponse.body()).path("items");
        JsonNode archivedEntry = null;
        for (JsonNode item : ownerArchiveList) {
            if (item.path("id").asText().equals(spaceId)) archivedEntry = item;
        }
        assertThat(archivedEntry).as("archived response: %s", archiveListResponse.body()).isNotNull();
        assertThat(archivedEntry.path("archived").asBoolean()).isTrue();

        assertThat(anotherAccount.get("/spaces?view=archived").body()).doesNotContain(spaceId);
        assertThat(anotherAccount.get("/spaces/" + spaceId).statusCode()).isEqualTo(404);
        var unauthorizedRestore = anotherAccount.post("/spaces/" + spaceId + "/restore", Map.of());
        assertThat(unauthorizedRestore.statusCode()).isIn(403, 404);
        assertThat(db.queryForObject("SELECT archived_at FROM town_space WHERE id=?", Timestamp.class, spaceId)).isNotNull();

        var restored = owner.post("/spaces/" + spaceId + "/restore", Map.of());
        assertThat(restored.statusCode()).as(restored.body()).isEqualTo(200);
        assertThat(json.readTree(restored.body()).path("archived").asBoolean()).isFalse();
        var restoredMine = owner.get("/spaces?view=mine");
        assertThat(restoredMine.statusCode()).as(restoredMine.body()).isEqualTo(200);
        assertThat(restoredMine.body()).contains(spaceId);
        assertThat(owner.get("/spaces?view=archived").body()).doesNotContain(spaceId);
        assertThat(json.readTree(owner.get("/spaces/" + spaceId).body()).path("archived").asBoolean()).isFalse();
    }

    @Test void wholeSpaceCloneCopiesMapsAndSettingsButStartsWithoutSocialOrPermissionRecords() throws Exception {
        Browser owner = signedIn();
        Browser member = signedIn();
        Browser pendingRequester = signedIn();
        Browser blockedUser = signedIn();
        String ownerId = json.readTree(owner.get("me").body()).path("userId").asText();
        String blockedUserId = json.readTree(blockedUser.get("me").body()).path("userId").asText();

        var created = owner.post("/spaces", Map.of("name", "복제 원본 " + UUID.randomUUID().toString().substring(0, 8),
            "description", "복제 시 유지할 소개", "visibility", "PUBLIC", "capacity", 42,
            "templateId", "MEETUP_HALL", "approvalRequired", true, "allowedEmailDomains", List.of("hufs.ac.kr")));
        assertThat(created.statusCode()).as(created.body()).isEqualTo(200);
        JsonNode source = json.readTree(created.body());
        String sourceId = source.path("id").asText();
        String mapRoot = "/spaces/" + sourceId + "/maps";

        JsonNode sourceCatalog = ok(owner.get(mapRoot));
        assertThat(sourceCatalog).hasSize(1);
        JsonNode addedMap = ok(owner.post(mapRoot, Map.of("name", "별관 강의실", "templateId", "STUDY_SPACE")));
        String addedMapId = addedMap.path("mapId").asText();
        assertThat(addedMapId).isNotEqualTo(sourceId);
        ok(owner.put(mapRoot + "/" + addedMapId + "/entry", Map.of()));
        sourceCatalog = ok(owner.get(mapRoot));
        assertThat(sourceCatalog).hasSize(2);

        var image = new java.awt.image.BufferedImage(8, 6, java.awt.image.BufferedImage.TYPE_INT_ARGB);
        var encodedImage = new java.io.ByteArrayOutputStream();
        assertThat(javax.imageio.ImageIO.write(image, "PNG", encodedImage)).isTrue();
        String assetRoot = "/spaces/" + sourceId + "/assets";
        JsonNode pendingAsset = json.readTree(owner.upload(assetRoot, "clone-reference.png", "image/png", encodedImage.toByteArray()).body());
        String sourceAssetId = pendingAsset.path("id").asText();
        assertThat(owner.post(assetRoot + "/" + sourceAssetId + "/approve", Map.of()).statusCode()).isEqualTo(200);
        String sourceMapRoot = mapRoot + "/" + sourceId;
        String editorClient = UUID.randomUUID().toString();
        JsonNode editorLease = ok(owner.post(sourceMapRoot + "/lease", Map.of("clientId", editorClient, "takeover", false)));
        var sourceDocument = (com.fasterxml.jackson.databind.node.ObjectNode) editorLease.path("editor").path("map").deepCopy();
        assertThat(sourceDocument.path("objects")).isNotEmpty();
        ((com.fasterxml.jackson.databind.node.ObjectNode) sourceDocument.path("objects").get(0)).put("asset", sourceAssetId);
        var imageInteraction = json.createObjectNode().put("kind", "IMAGE").put("title", "복제 이미지")
            .put("body", "").put("url", "").put("assetId", sourceAssetId).put("radius", 0).put("volume", 0);
        ((com.fasterxml.jackson.databind.node.ObjectNode) sourceDocument.path("objects").get(0)).set("interaction", imageInteraction);
        ((com.fasterxml.jackson.databind.node.ArrayNode) sourceDocument.path("portals")).add(json.valueToTree(Map.of(
            "id", "clone_internal_portal", "name", "복제된 별관", "bounds", Map.of("x", 10, "y", 10, "width", 1, "height", 1),
            "targetSpaceId", sourceId, "targetMapId", addedMapId, "targetSpawnX", 2, "targetSpawnY", 2)));
        var saveDraft = owner.post(sourceMapRoot + "/draft", Map.of("lease", credentials(editorLease, editorClient),
            "baseVersion", 1, "operationId", UUID.randomUUID().toString(), "map", sourceDocument));
        assertThat(saveDraft.statusCode()).as(saveDraft.body()).isEqualTo(200);
        assertThat(owner.post(sourceMapRoot + "/publish", Map.of("lease", credentials(editorLease, editorClient), "baseVersion", 2)).statusCode()).isEqualTo(200);

        var inviteResponse = owner.post("/spaces/" + sourceId + "/invites", Map.of("hours", 2, "maxUses", 5));
        assertThat(inviteResponse.statusCode()).as(inviteResponse.body()).isEqualTo(200);
        String inviteCode = json.readTree(inviteResponse.body()).path("code").asText();
        assertThat(member.post("/spaces/redeem", Map.of("code", inviteCode)).statusCode()).isEqualTo(200);
        assertThat(blockedUser.post("/spaces/redeem", Map.of("code", inviteCode)).statusCode()).isEqualTo(200);
        assertThat(pendingRequester.post("/spaces/" + sourceId + "/join-requests", Map.of()).statusCode()).isEqualTo(200);
        db.update("INSERT INTO space_access_block(space_id,user_id,blocked_by_user_id) VALUES (?,?,?)",
            sourceId, blockedUserId, ownerId);
        db.update("INSERT INTO town_event(id,space_id,host_user_id,title,started_at) VALUES (?,?,?,'복제 검증 행사',CURRENT_TIMESTAMP(6))",
            UUID.randomUUID().toString(), sourceId, ownerId);
        db.update("""
            INSERT INTO town_scheduled_event(id,space_id,created_by,title,starts_at,ends_at)
            VALUES (?,?,?,'복제 검증 예정 행사',TIMESTAMPADD(HOUR,1,CURRENT_TIMESTAMP(6)),TIMESTAMPADD(HOUR,2,CURRENT_TIMESTAMP(6)))
            """, UUID.randomUUID().toString(), sourceId, ownerId);

        assertThat(db.queryForObject("SELECT COUNT(*) FROM space_member WHERE space_id=?", Integer.class, sourceId)).isEqualTo(3);
        assertThat(db.queryForObject("SELECT COUNT(*) FROM space_invite WHERE space_id=?", Integer.class, sourceId)).isEqualTo(1);
        assertThat(db.queryForObject("SELECT COUNT(*) FROM space_access_block WHERE space_id=?", Integer.class, sourceId)).isEqualTo(1);
        assertThat(db.queryForObject("SELECT COUNT(*) FROM space_join_request WHERE space_id=? AND status='PENDING'", Integer.class, sourceId)).isEqualTo(1);
        assertThat(db.queryForObject("SELECT COUNT(*) FROM town_event WHERE space_id=?", Integer.class, sourceId)).isEqualTo(1);
        assertThat(db.queryForObject("SELECT COUNT(*) FROM town_scheduled_event WHERE space_id=?", Integer.class, sourceId)).isEqualTo(1);

        String invalidNameClone = "/spaces/" + sourceId + "/clone";
        assertThat(owner.post(invalidNameClone, Map.of("name", " ")).statusCode()).isEqualTo(400);
        String deniedName = "회원 복제 거부 " + UUID.randomUUID().toString().substring(0, 8);
        var deniedClone = member.post(invalidNameClone, Map.of("name", deniedName));
        assertThat(deniedClone.statusCode()).isIn(403, 404);
        assertThat(db.queryForObject("SELECT COUNT(*) FROM town_space WHERE name=?", Integer.class, deniedName)).isZero();

        String cloneName = "복제된 독립 공간 " + UUID.randomUUID().toString().substring(0, 8);
        var cloneResponse = owner.post(invalidNameClone, Map.of("name", cloneName));
        assertThat(cloneResponse.statusCode()).as(cloneResponse.body()).isEqualTo(200);
        JsonNode cloned = json.readTree(cloneResponse.body());
        String cloneId = cloned.path("id").asText();
        assertThat(cloneId).isNotBlank().isNotEqualTo(sourceId);
        assertThat(cloned.path("name").asText()).isEqualTo(cloneName);
        assertThat(cloned.path("description").asText()).isEqualTo(source.path("description").asText());
        assertThat(cloned.path("visibility").asText()).isEqualTo("PRIVATE");
        assertThat(cloned.path("capacity").asInt()).isEqualTo(source.path("capacity").asInt());
        assertThat(cloned.path("templateId").asText()).isEqualTo(source.path("templateId").asText());
        assertThat(cloned.path("role").asText()).isEqualTo("OWNER");
        assertThat(cloned.path("allowedEmailDomains").toString()).contains("hufs.ac.kr");

        assertThat(db.queryForObject("SELECT COUNT(*) FROM space_member WHERE space_id=?", Integer.class, cloneId)).isEqualTo(1);
        assertThat(db.queryForObject("SELECT user_id FROM space_member WHERE space_id=?", String.class, cloneId)).isEqualTo(ownerId);
        assertThat(db.queryForObject("SELECT role FROM space_member WHERE space_id=? AND user_id=?", String.class, cloneId, ownerId)).isEqualTo("OWNER");
        assertThat(db.queryForObject("SELECT COUNT(*) FROM space_invite WHERE space_id=?", Integer.class, cloneId)).isZero();
        assertThat(db.queryForObject("SELECT COUNT(*) FROM space_access_block WHERE space_id=?", Integer.class, cloneId)).isZero();
        assertThat(db.queryForObject("SELECT COUNT(*) FROM space_join_request WHERE space_id=?", Integer.class, cloneId)).isZero();
        assertThat(db.queryForObject("SELECT COUNT(*) FROM town_event WHERE space_id=?", Integer.class, cloneId)).isZero();
        assertThat(db.queryForObject("SELECT COUNT(*) FROM town_scheduled_event WHERE space_id=?", Integer.class, cloneId)).isZero();

        JsonNode clonedCatalog = ok(owner.get("/spaces/" + cloneId + "/maps"));
        assertThat(clonedCatalog).hasSize(sourceCatalog.size());
        Set<String> sourceMapIds = new HashSet<>();
        Set<String> clonedMapIds = new HashSet<>();
        String sourceEntryName = null;
        String clonedEntryName = null;
        String clonedAddedMapId = null;
        for (JsonNode clonedMap : clonedCatalog) {
            if (clonedMap.path("name").asText().equals("별관 강의실")) clonedAddedMapId = clonedMap.path("mapId").asText();
        }
        for (JsonNode sourceMap : sourceCatalog) {
            sourceMapIds.add(sourceMap.path("mapId").asText());
            if (sourceMap.path("entry").asBoolean()) sourceEntryName = sourceMap.path("name").asText();
        }
        for (JsonNode clonedMap : clonedCatalog) {
            String clonedMapId = clonedMap.path("mapId").asText();
            clonedMapIds.add(clonedMapId);
            assertThat(clonedMapId).isNotBlank();
            assertThat(sourceMapIds).doesNotContain(clonedMapId);
            if (clonedMap.path("entry").asBoolean()) clonedEntryName = clonedMap.path("name").asText();

            JsonNode matchingSource = null;
            for (JsonNode sourceMap : sourceCatalog) {
                if (sourceMap.path("name").asText().equals(clonedMap.path("name").asText())) matchingSource = sourceMap;
            }
            assertThat(matchingSource).isNotNull();
            assertThat(clonedMap.path("entry").asBoolean()).isEqualTo(matchingSource.path("entry").asBoolean());
            assertThat(clonedMap.path("publishedRevision").asText()).isNotBlank();
            var publishedResponse = owner.get("/spaces/" + cloneId + "/maps/" + clonedMapId + "/published");
            assertThat(publishedResponse.statusCode()).as(publishedResponse.body()).isEqualTo(200);
            JsonNode published = json.readTree(publishedResponse.body());
            assertThat(published.path("id").asText()).isEqualTo(clonedMapId);
            assertThat(published.path("revision").asText()).isEqualTo(clonedMap.path("publishedRevision").asText());
            if (clonedMap.path("name").asText().equals("GDG 밋업 홀")) {
                String clonedAssetId = published.path("objects").get(0).path("asset").asText();
                String clonedInteractionAssetId = published.path("objects").get(0).path("interaction").path("assetId").asText();
                assertThat(clonedAssetId).startsWith("custom_").isNotEqualTo(sourceAssetId);
                assertThat(clonedInteractionAssetId).isEqualTo(clonedAssetId);
                assertThat(owner.get("/spaces/" + cloneId + "/assets/" + clonedAssetId + "/content").statusCode()).isEqualTo(200);
                JsonNode internalPortal = null;
                for (JsonNode portal : published.path("portals")) {
                    if (portal.path("id").asText().equals("clone_internal_portal")) internalPortal = portal;
                }
                assertThat(internalPortal).isNotNull();
                assertThat(internalPortal.path("targetSpaceId").asText()).isEqualTo(cloneId);
                assertThat(internalPortal.path("targetMapId").asText()).isEqualTo(clonedAddedMapId);
                assertThat(db.queryForObject("SELECT COUNT(*) FROM map_revision WHERE space_id=?", Integer.class, cloneId)).isEqualTo(2);
                String clonedDraft = db.queryForObject("SELECT draft_json FROM space_map WHERE space_id=? AND map_id=?",
                    String.class, cloneId, clonedMapId);
                JsonNode clonedDraftDocument = json.readTree(clonedDraft);
                assertThat(clonedDraftDocument.path("objects").get(0).path("asset").asText()).isEqualTo(clonedAssetId);
            }
        }
        assertThat(sourceMapIds).hasSize(2);
        assertThat(clonedMapIds).hasSize(2);
        assertThat(clonedAddedMapId).isNotNull();
        assertThat(sourceEntryName).isEqualTo(clonedEntryName);
    }

    @Test void allowedEmailDomainsGateGuestDiscoveryReadAndJoinButDoNotRevokeMembers() throws Exception {
        Browser owner = signedIn();
        String subject = UUID.randomUUID().toString();
        Browser matchingDomain = signedInAsEmail(subject, "STUDENT@Example.EDU");
        Browser outsideDomain = signedInAsEmail(UUID.randomUUID().toString(), "visitor@elsewhere.invalid");
        var created = owner.post("/spaces", Map.of("name", "도메인 제한 공간", "description", "", "visibility", "PUBLIC",
            "capacity", 10, "approvalRequired", true, "allowedEmailDomains", List.of("example.edu")));
        assertThat(created.statusCode()).as(created.body()).isEqualTo(200);
        String spaceId = json.readTree(created.body()).path("id").asText();

        assertThat(outsideDomain.get("/spaces").body()).doesNotContain(spaceId);
        assertThat(outsideDomain.get("/spaces/" + spaceId).statusCode()).isEqualTo(404);
        assertThat(outsideDomain.post("/spaces/" + spaceId + "/join-requests", Map.of()).statusCode()).isEqualTo(404);
        assertThat(outsideDomain.post("/spaces/" + spaceId + "/admission", Map.of()).statusCode()).isEqualTo(404);

        assertThat(matchingDomain.get("/spaces").body()).contains(spaceId);
        assertThat(matchingDomain.get("/spaces/" + spaceId).statusCode()).isEqualTo(200);
        assertThat(matchingDomain.post("/spaces/" + spaceId + "/admission", Map.of()).statusCode()).isEqualTo(403);
        assertThat(matchingDomain.post("/spaces/" + spaceId + "/join-requests", Map.of()).statusCode()).isEqualTo(200);
        JsonNode pending = json.readTree(owner.get("/spaces/" + spaceId + "/join-requests").body()).get(0);
        assertThat(owner.post("/spaces/" + spaceId + "/join-requests/" + pending.path("id").asText() + "/resolve",
            Map.of("decision", "APPROVE")).statusCode()).isEqualTo(200);
        assertThat(matchingDomain.post("/spaces/" + spaceId + "/admission", Map.of()).statusCode()).isEqualTo(200);

        // A later SSO email change does not remove an already granted membership.
        Browser memberWithChangedDomain = signedInAsEmail(subject, "student@elsewhere.invalid");
        assertThat(memberWithChangedDomain.get("/spaces").body()).contains(spaceId);
        assertThat(memberWithChangedDomain.get("/spaces/" + spaceId).statusCode()).isEqualTo(200);
        assertThat(memberWithChangedDomain.post("/spaces/" + spaceId + "/admission", Map.of()).statusCode()).isEqualTo(200);

        var invalidPolicy = owner.patch("/spaces/" + spaceId, Map.of("name", "도메인 제한 공간", "description", "",
            "visibility", "PUBLIC", "allowedEmailDomains", List.of("*.example.edu")));
        assertThat(invalidPolicy.statusCode()).isEqualTo(400);
        assertThat(db.queryForObject("SELECT COUNT(*) FROM oauth_identity WHERE user_id=? AND verified_email IS NOT NULL",
            Integer.class, json.readTree(memberWithChangedDomain.get("me").body()).path("userId").asText())).isZero();
        var redacted = new SsoClient.UserInfo(UUID.randomUUID().toString(), "테스터", "ATTENDING", "sensitive@example.edu");
        assertThat(redacted.toString()).doesNotContain("sensitive@example.edu", "example.edu");
    }

    @Test void anonymousGuestEntryIsPublicOnlySessionBoundNonMemberAndUsesOneShortTicket() throws Exception {
        Browser owner = signedIn();
        var valid = owner.post("/spaces", Map.of("name", "로그인 없는 공개 공간", "description", "", "visibility", "PUBLIC",
            "capacity", 10, "guestEntryEnabled", true));
        assertThat(valid.statusCode()).as(valid.body()).isEqualTo(200);
        String spaceId = json.readTree(valid.body()).path("id").asText();
        assertThat(owner.post("/guest/spaces/" + spaceId + "/admission", Map.of()).statusCode()).isEqualTo(403);

        Browser guest = new Browser();
        assertThat(guest.get("/guest/spaces/" + spaceId).statusCode()).isEqualTo(200);
        String profile = json.writeValueAsString(Map.of("name", "방문 게스트", "avatar", 1, "skin", "light",
            "clothing", "casual_white", "hair", "hair_short_black"));

        Browser staleGuest = new Browser();
        var staleResponse = staleGuest.post("/guest/spaces/" + spaceId + "/admission", json.readTree(profile));
        assertThat(staleResponse.statusCode()).as(staleResponse.body()).isEqualTo(200);
        String staleTicket = json.readTree(staleResponse.body()).path("ticket").asText();
        assertThat(strings.getExpire("hufs-town:admission:" + staleTicket)).isBetween(1L, 30L);
        assertThat(guest.rawPost("/guest/spaces/" + spaceId + "/admission", profile, null).statusCode()).isEqualTo(403);
        var admissionResponse = guest.post("/guest/spaces/" + spaceId + "/admission", json.readTree(profile));
        assertThat(admissionResponse.statusCode()).as(admissionResponse.body()).isEqualTo(200);
        JsonNode admission = json.readTree(admissionResponse.body());
        String ticket = admission.path("ticket").asText();
        assertThat(admission.path("expiresInSeconds").asInt()).isBetween(1, 30);
        assertThat(strings.getExpire("hufs-town:admission:" + ticket)).isBetween(1L, 30L);
        assertThat(guest.get("/guest/spaces/" + spaceId).statusCode()).isEqualTo(200);

        String guestSessionId = new String(Base64.getDecoder().decode(guest.cookie()), java.nio.charset.StandardCharsets.UTF_8);
        var guestSession = sessions.findById(guestSessionId);
        var identity = (town.hufs.auth.GuestIdentity) guestSession.getAttribute(town.hufs.auth.GuestIdentity.SESSION_ATTRIBUTE);
        assertThat(identity.displayName()).isEqualTo("방문 게스트");
        assertThat(db.queryForObject("SELECT COUNT(*) FROM app_user WHERE id=?", Integer.class, identity.guestId())).isZero();
        assertThat(db.queryForObject("SELECT COUNT(*) FROM space_member WHERE space_id=?", Integer.class, spaceId)).isEqualTo(1);

        // Disabling guest entry prevents new tickets; an already-issued one remains bounded by its 30s, one-use TTL.
        assertThat(owner.patch("/spaces/" + spaceId, Map.of("name", "로그인 없는 공개 공간", "description", "",
            "visibility", "PUBLIC", "guestEntryEnabled", false)).statusCode()).isEqualTo(200);
        assertThat(guest.post("/guest/spaces/" + spaceId + "/admission", Map.of()).statusCode()).isEqualTo(404);
        assertThat(staleGuest.post("/guest/spaces/" + spaceId + "/admission", json.readTree(profile)).statusCode()).isEqualTo(404);
        strings.expire("hufs-town:admission:" + staleTicket, java.time.Duration.ZERO);
        assertThatThrownBy(() -> staleGuest.socketWithTicket(ORIGIN, staleTicket)).hasCauseInstanceOf(WebSocketHandshakeException.class);
        Browser other = new Browser();
        assertThatThrownBy(() -> other.socketWithTicket(ORIGIN, ticket)).hasCauseInstanceOf(WebSocketHandshakeException.class);

        Probe socket = guest.socketWithTicket(ORIGIN, ticket);
        try {
            socket.join("");
            var welcome = socket.await(message -> message.path("type").asText().equals("welcome"));
            assertThat(welcome.path("playerId").asText()).isNotBlank();
            var snapshot = socket.await(message -> message.path("type").asText().equals("snapshot")
                && message.path("players").size() == 1);
            assertThat(snapshot.path("players").get(0).path("manager").asBoolean()).isFalse();
            assertThat(db.queryForObject("SELECT COUNT(*) FROM app_user WHERE id=?", Integer.class, identity.guestId())).isZero();
            assertThat(db.queryForObject("SELECT COUNT(*) FROM space_member WHERE space_id=?", Integer.class, spaceId)).isEqualTo(1);
        } finally { socket.socket.abort(); }
        assertThatThrownBy(() -> guest.socketWithTicket(ORIGIN, ticket)).hasCauseInstanceOf(WebSocketHandshakeException.class);

        // Logging in within this browser upgrades the session and must remove its former guest marker.
        String loginState = guest.start();
        String accountSubject = UUID.randomUUID().toString();
        expectUser(accountSubject, "ATTENDING");
        assertThat(guest.post("exchange", Map.of("code", UUID.randomUUID().toString(), "state", loginState)).statusCode()).isEqualTo(200);
        String accountId = json.readTree(guest.get("me").body()).path("userId").asText();
        String upgradedSessionId = new String(Base64.getDecoder().decode(guest.cookie()), java.nio.charset.StandardCharsets.UTF_8);
        var upgradedSession = sessions.findById(upgradedSessionId);
        assertThat((Object) upgradedSession.getAttribute(town.hufs.auth.GuestIdentity.SESSION_ATTRIBUTE)).isNull();
        Probe upgradedSocket = guest.socketWithTicket(ORIGIN, guest.ticketDefault(spaceId));
        try {
            upgradedSocket.join("");
            upgradedSocket.await(message -> message.path("type").asText().equals("welcome"));
            assertThat(db.queryForObject("SELECT COUNT(*) FROM space_member WHERE space_id=? AND user_id=?", Integer.class, spaceId, accountId)).isEqualTo(1);
        } finally { upgradedSocket.socket.abort(); }

        Browser deniedGuest = new Browser();
        for (var denied : List.of(
            Map.of("visibility", "PRIVATE", "guestEntryEnabled", false),
            Map.of("visibility", "UNLISTED", "guestEntryEnabled", false),
            Map.of("visibility", "PUBLIC", "approvalRequired", true, "guestEntryEnabled", false),
            Map.of("visibility", "PUBLIC", "allowedEmailDomains", List.of("example.edu"), "guestEntryEnabled", false))) {
            var draft = new java.util.HashMap<String, Object>(denied);
            draft.put("name", "게스트 차단 공간 " + UUID.randomUUID()); draft.put("description", ""); draft.put("capacity", 10);
            var deniedCreate = owner.post("/spaces", draft);
            assertThat(deniedCreate.statusCode()).as(deniedCreate.body()).isEqualTo(200);
            String deniedId = json.readTree(deniedCreate.body()).path("id").asText();
            assertThat(deniedGuest.get("/guest/spaces/" + deniedId).statusCode()).isEqualTo(404);
            assertThat(deniedGuest.post("/guest/spaces/" + deniedId + "/admission", json.readTree(profile)).statusCode()).isEqualTo(404);
        }
        var conflicting = owner.post("/spaces", Map.of("name", "서로 배타적인 게스트 정책", "description", "", "visibility", "PUBLIC",
            "capacity", 10, "guestEntryEnabled", true, "allowedEmailDomains", List.of("example.edu")));
        assertThat(conflicting.statusCode()).isEqualTo(400);
    }

    @Test void emailDomainPolicyAlsoGatesScheduledEventReadsAndNewInviteRedemptions() throws Exception {
        Browser owner = signedIn();
        String subject = UUID.randomUUID().toString();
        Browser allowed = signedInAsEmail(subject, "student@example.edu");
        Browser outside = signedInAsEmail(UUID.randomUUID().toString(), "visitor@elsewhere.invalid");
        var created = owner.post("/spaces", Map.of("name", "도메인 제한 행사 공간", "description", "", "visibility", "PUBLIC",
            "capacity", 20, "approvalRequired", true, "allowedEmailDomains", List.of("example.edu")));
        assertThat(created.statusCode()).as(created.body()).isEqualTo(200);
        String spaceId = json.readTree(created.body()).path("id").asText();
        String eventPath = "/spaces/" + spaceId + "/scheduled-events";
        var event = owner.post(eventPath, Map.of("title", "도메인 제한 행사", "description", "", "instructions", "",
            "resourceUrl", "", "startsAt", Instant.now().plusSeconds(3600).toString(), "endsAt", Instant.now().plusSeconds(7200).toString()));
        assertThat(event.statusCode()).as(event.body()).isEqualTo(200);
        assertThat(outside.get(eventPath).statusCode()).isEqualTo(404);
        assertThat(allowed.get(eventPath).statusCode()).isEqualTo(200);

        var issued = owner.post("/spaces/" + spaceId + "/invites", Map.of("hours", 2, "maxUses", 2));
        assertThat(issued.statusCode()).as(issued.body()).isEqualTo(200);
        String code = json.readTree(issued.body()).path("code").asText();
        assertThat(outside.post("/spaces/redeem", Map.of("code", code)).statusCode()).isEqualTo(404);
        var redemption = allowed.post("/spaces/redeem", Map.of("code", code));
        assertThat(redemption.statusCode()).as(redemption.body()).isEqualTo(200);
        assertThat(json.readTree(redemption.body()).path("role").asText()).isEqualTo("MEMBER");

        // An existing member keeps access after a new login reports a different email domain.
        Browser existingMember = signedInAsEmail(subject, "student@elsewhere.invalid");
        assertThat(existingMember.post("/spaces/redeem", Map.of("code", code)).statusCode()).isEqualTo(200);
        assertThat(existingMember.get(eventPath).statusCode()).isEqualTo(200);
    }

    @Test void ownershipTransferRequiresOwnerRequestAndTargetAcceptance() throws Exception {
        Browser owner = signedIn(); Browser target = signedIn(); Browser outsider = signedIn();
        String spaceId = createSpace(owner, "소유권 이전 통합 검증", "PUBLIC", 10).path("id").asText();
        String ownerId = json.readTree(owner.get("me").body()).path("userId").asText();
        String targetId = json.readTree(target.get("me").body()).path("userId").asText();
        String outsiderId = json.readTree(outsider.get("me").body()).path("userId").asText();

        assertThat(target.post("/spaces/" + spaceId + "/admission", Map.of()).statusCode()).isEqualTo(200);
        assertThat(owner.post("/spaces/" + spaceId + "/ownership-transfer", Map.of("targetUserId", outsiderId)).statusCode()).isEqualTo(409);
        assertThat(target.post("/spaces/" + spaceId + "/ownership-transfer", Map.of("targetUserId", ownerId)).statusCode()).isEqualTo(403);

        assertThat(owner.post("/spaces/" + spaceId + "/ownership-transfer", Map.of("targetUserId", targetId)).statusCode()).isEqualTo(200);
        assertThat(target.get("/spaces/ownership-transfers/incoming").body()).contains(spaceId);
        assertThat(outsider.get("/spaces/ownership-transfers/incoming").body()).doesNotContain(spaceId);
        assertThat(outsider.post("/spaces/" + spaceId + "/ownership-transfer/respond", Map.of("decision", "ACCEPT")).statusCode()).isEqualTo(404);
        assertThat(target.post("/spaces/" + spaceId + "/ownership-transfer/respond", Map.of("decision", "DECLINE")).body()).contains("DECLINED");
        assertThat(json.readTree(owner.get("/spaces/" + spaceId).body()).path("role").asText()).isEqualTo("OWNER");

        assertThat(owner.post("/spaces/" + spaceId + "/ownership-transfer", Map.of("targetUserId", targetId)).statusCode()).isEqualTo(200);
        assertThat(owner.delete("/spaces/" + spaceId + "/ownership-transfer", Map.of()).statusCode()).isEqualTo(200);
        assertThat(target.get("/spaces/ownership-transfers/incoming").body()).doesNotContain(spaceId);
        assertThat(target.post("/spaces/" + spaceId + "/ownership-transfer/respond", Map.of("decision", "ACCEPT")).statusCode()).isEqualTo(404);

        assertThat(owner.post("/spaces/" + spaceId + "/ownership-transfer", Map.of("targetUserId", targetId)).statusCode()).isEqualTo(200);
        assertThat(target.post("/spaces/" + spaceId + "/ownership-transfer/respond", Map.of("decision", "ACCEPT")).body()).contains("ACCEPTED");
        assertThat(json.readTree(owner.get("/spaces/" + spaceId).body()).path("role").asText()).isEqualTo("ADMIN");
        assertThat(json.readTree(target.get("/spaces/" + spaceId).body()).path("role").asText()).isEqualTo("OWNER");
        assertThat(db.queryForObject("SELECT owner_id FROM town_space WHERE id=?", String.class, spaceId)).isEqualTo(targetId);
        assertThat(db.queryForObject("SELECT manager FROM space_member WHERE space_id=? AND user_id=?", Boolean.class, spaceId, ownerId)).isTrue();
    }

    @Test void spaceManagersCanOperateMembersButCannotChangeOwnerSettingsOrRoles() throws Exception {
        Browser owner = signedIn(); Browser admin = signedIn(); Browser protectedAdmin = signedIn(); Browser member = signedIn();
        String spaceId = createSpace(owner, "공동 운영 권한 검증", "PUBLIC", 10).path("id").asText();
        String adminId = json.readTree(admin.get("me").body()).path("userId").asText();
        String protectedAdminId = json.readTree(protectedAdmin.get("me").body()).path("userId").asText();
        String memberId = json.readTree(member.get("me").body()).path("userId").asText();
        for (Browser participant : List.of(admin, protectedAdmin, member))
            assertThat(participant.post("/spaces/" + spaceId + "/admission", Map.of()).statusCode()).isEqualTo(200);

        assertThat(owner.patch("/spaces/" + spaceId + "/members/" + adminId + "/role", Map.of("role", "ADMIN")).statusCode()).isEqualTo(200);
        assertThat(owner.patch("/spaces/" + spaceId + "/members/" + protectedAdminId + "/role", Map.of("role", "ADMIN")).statusCode()).isEqualTo(200);
        assertThat(admin.get("/spaces/" + spaceId + "/members").statusCode()).isEqualTo(200);
        assertThat(admin.post("/spaces/" + spaceId + "/invites", Map.of("hours", 1, "maxUses", 2)).statusCode()).isEqualTo(200);
        assertThat(admin.patch("/spaces/" + spaceId, Map.of("name", "관리자 설정 시도", "description", "", "visibility", "UNLISTED")).statusCode()).isEqualTo(403);
        assertThat(admin.patch("/spaces/" + spaceId + "/members/" + memberId + "/role", Map.of("role", "ADMIN")).statusCode()).isEqualTo(403);
        assertThat(admin.delete("/spaces/" + spaceId + "/members/" + protectedAdminId, Map.of()).statusCode()).isEqualTo(403);

        assertThat(owner.patch("/spaces/" + spaceId + "/members/" + protectedAdminId + "/role", Map.of("role", "MEMBER")).statusCode()).isEqualTo(200);
        assertThat(admin.delete("/spaces/" + spaceId + "/members/" + memberId, Map.of()).statusCode()).isEqualTo(200);
        assertThat(member.post("/spaces/" + spaceId + "/admission", Map.of()).statusCode()).isEqualTo(403);
        assertThat(admin.get("/spaces/" + spaceId + "/access-blocks").body()).contains(memberId);
        assertThat(admin.delete("/spaces/" + spaceId + "/access-blocks/" + memberId, Map.of()).statusCode()).isEqualTo(200);
        assertThat(member.post("/spaces/" + spaceId + "/admission", Map.of()).statusCode()).isEqualTo(200);

        assertThat(owner.patch("/spaces/" + spaceId + "/members/" + adminId + "/role", Map.of("role", "MEMBER")).statusCode()).isEqualTo(200);
        assertThat(admin.get("/spaces/" + spaceId + "/members").statusCode()).isEqualTo(403);
        assertThat(admin.delete("/spaces/" + spaceId + "/members/" + memberId, Map.of()).statusCode()).isEqualTo(403);
        assertThat(db.queryForObject("SELECT role FROM space_member WHERE space_id=? AND user_id=?", String.class, spaceId, adminId)).isEqualTo("MEMBER");
    }

    @Test void demotedManagerCannotRaceAnUnblockPastRoleChange() throws Exception {
        Browser owner = signedIn(); Browser admin = signedIn(); Browser member = signedIn();
        String spaceId = createSpace(owner, "권한 회수와 제한 해제 동시성", "PUBLIC", 10).path("id").asText();
        String adminId = json.readTree(admin.get("me").body()).path("userId").asText();
        String memberId = json.readTree(member.get("me").body()).path("userId").asText();
        assertThat(admin.post("/spaces/" + spaceId + "/admission", Map.of()).statusCode()).isEqualTo(200);
        assertThat(member.post("/spaces/" + spaceId + "/admission", Map.of()).statusCode()).isEqualTo(200);
        assertThat(owner.patch("/spaces/" + spaceId + "/members/" + adminId + "/role", Map.of("role", "ADMIN")).statusCode()).isEqualTo(200);
        assertThat(owner.delete("/spaces/" + spaceId + "/members/" + memberId, Map.of()).statusCode()).isEqualTo(200);

        try (var connection = Objects.requireNonNull(db.getDataSource()).getConnection()) {
            connection.setAutoCommit(false);
            try (var lockSpace = connection.prepareStatement("SELECT id FROM town_space WHERE id=? FOR UPDATE")) {
                lockSpace.setString(1, spaceId);
                try (var rows = lockSpace.executeQuery()) { assertThat(rows.next()).isTrue(); }
            }
            try (var demote = connection.prepareStatement("UPDATE space_member SET manager=FALSE WHERE space_id=? AND user_id=?")) {
                demote.setString(1, spaceId);
                demote.setString(2, adminId);
                assertThat(demote.executeUpdate()).isEqualTo(1);
            }
            try (var lockBlock = connection.prepareStatement("SELECT user_id FROM space_access_block WHERE space_id=? AND user_id=? FOR UPDATE")) {
                lockBlock.setString(1, spaceId);
                lockBlock.setString(2, memberId);
                try (var rows = lockBlock.executeQuery()) { assertThat(rows.next()).isTrue(); }
            }

            try (var pool = Executors.newSingleThreadExecutor()) {
                var unblock = pool.submit(() -> admin.delete("/spaces/" + spaceId + "/access-blocks/" + memberId, Map.of()));
                long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5);
                String waitingStatement = null;
                while (System.nanoTime() < deadline && waitingStatement == null) {
                    waitingStatement = db.queryForList("""
                        SELECT INFO FROM information_schema.PROCESSLIST
                        WHERE COMMAND='Query' AND INFO IS NOT NULL
                        """, String.class).stream().filter(sql -> {
                            String normalized = sql.toLowerCase(Locale.ROOT);
                            return normalized.contains("delete from space_access_block")
                                || normalized.contains("from town_space s where s.id=");
                        }).findFirst().orElse(null);
                    if (waitingStatement == null) Thread.sleep(20);
                }
                assertThat(waitingStatement).as("unblock request should wait behind the pending role change").isNotNull();
                assertThat(unblock.isDone()).isFalse();
                connection.commit();
                assertThat(unblock.get(8, TimeUnit.SECONDS).statusCode()).isEqualTo(403);
            }
        }
        assertThat(db.queryForObject("SELECT manager FROM space_member WHERE space_id=? AND user_id=?", Boolean.class, spaceId, adminId)).isFalse();
        assertThat(db.queryForObject("SELECT COUNT(*) FROM space_access_block WHERE space_id=? AND user_id=?", Integer.class, spaceId, memberId)).isEqualTo(1);
    }

    @Test void uploadedAssetsStayQuarantinedUntilOwnerApprovalAndCanBeResubmittedAfterRejection() throws Exception {
        Browser owner = signedIn(); Browser admin = signedIn();
        String spaceId = createSpace(owner, "에셋 승인 검증", "PUBLIC", 10).path("id").asText();
        String adminId = json.readTree(admin.get("me").body()).path("userId").asText();
        assertThat(admin.post("/spaces/" + spaceId + "/admission", Map.of()).statusCode()).isEqualTo(200);
        assertThat(owner.patch("/spaces/" + spaceId + "/members/" + adminId + "/role", Map.of("role", "ADMIN")).statusCode()).isEqualTo(200);

        var image = new java.awt.image.BufferedImage(8, 6, java.awt.image.BufferedImage.TYPE_INT_ARGB);
        var encoded = new java.io.ByteArrayOutputStream();
        assertThat(javax.imageio.ImageIO.write(image, "PNG", encoded)).isTrue();
        byte[] png = encoded.toByteArray();
        String assets = "/spaces/" + spaceId + "/assets";
        var firstUpload = admin.upload(assets, "test-sprite.png", "image/png", png);
        assertThat(firstUpload.statusCode()).as(firstUpload.body()).isEqualTo(200);
        JsonNode pending = json.readTree(firstUpload.body());
        String assetId = pending.path("id").asText();
        assertThat(pending.path("status").asText()).isEqualTo("PENDING");
        assertThat(admin.get(assets).body()).isEqualTo("[]");
        assertThat(admin.get(assets + "/" + assetId + "/content").statusCode()).isEqualTo(404);
        assertThat(admin.get(assets + "/review").statusCode()).isEqualTo(403);
        assertThat(admin.get(assets + "/" + assetId + "/review-content").statusCode()).isEqualTo(403);
        assertThat(owner.get(assets + "/review").body()).contains(assetId).contains("HUFS 친구");
        var reviewPreview = owner.get(assets + "/" + assetId + "/review-content");
        assertThat(reviewPreview.statusCode()).isEqualTo(200);
        assertThat(reviewPreview.headers().firstValue("Content-Type").orElse("")).startsWith("image/png");
        assertThat(admin.post(assets + "/" + assetId + "/approve", Map.of()).statusCode()).isEqualTo(403);
        assertThat(owner.post(assets + "/" + assetId + "/reject", Map.of()).statusCode()).isEqualTo(200);
        assertThat(owner.get(assets + "/review").body()).doesNotContain(assetId);
        assertThat(owner.get(assets + "/" + assetId + "/review-content").statusCode()).isEqualTo(404);
        assertThat(db.queryForObject("SELECT status FROM space_asset WHERE id=?", String.class, assetId)).isEqualTo("REJECTED");

        var resubmitted = admin.upload(assets, "test-sprite.png", "image/png", png);
        assertThat(resubmitted.statusCode()).as(resubmitted.body()).isEqualTo(200);
        assertThat(json.readTree(resubmitted.body()).path("id").asText()).isEqualTo(assetId);
        assertThat(json.readTree(resubmitted.body()).path("status").asText()).isEqualTo("PENDING");
        var duplicate = admin.upload(assets, "duplicate-sprite.png", "image/png", png);
        assertThat(json.readTree(duplicate.body()).path("id").asText()).isEqualTo(assetId);
        String mapRoot = "/spaces/" + spaceId + "/map";
        String editorClient = UUID.randomUUID().toString();
        var editorLease = ok(owner.post(mapRoot + "/lease", Map.of("clientId", editorClient, "takeover", false)));
        var map = (com.fasterxml.jackson.databind.node.ObjectNode) editorLease.path("editor").path("map").deepCopy();
        var interaction = json.createObjectNode().put("kind", "IMAGE").put("title", "승인된 이미지").put("body", "").put("url", "")
            .put("assetId", assetId).put("radius", 0).put("volume", 0);
        ((com.fasterxml.jackson.databind.node.ObjectNode) map.path("objects").get(0)).set("interaction", interaction);
        var imageDraft = Map.of("lease", credentials(editorLease, editorClient), "baseVersion", 1,
            "operationId", UUID.randomUUID().toString(), "map", map);
        var quarantinedReference = owner.post(mapRoot + "/draft", imageDraft);
        assertThat(quarantinedReference.statusCode()).as(quarantinedReference.body()).isEqualTo(400);
        assertThat(owner.post(assets + "/" + assetId + "/approve", Map.of()).body()).contains("READY");
        assertThat(ok(owner.post(mapRoot + "/draft", imageDraft)).path("version").asLong()).isEqualTo(2);
        assertThat(admin.get(assets).body()).contains(assetId).contains("READY");
        assertThat(admin.get(assets + "/" + assetId + "/content").statusCode()).isEqualTo(200);
        assertThat(owner.get(assets + "/review").body()).doesNotContain(assetId);
    }

    @Test void uploadedAssetsRejectUnsafeImagesAndNormalizeApprovedJpegsWithThumbnails() throws Exception {
        Browser owner = signedIn();
        String spaceId = createSpace(owner, "에셋 파일 검증", "PUBLIC", 10).path("id").asText();
        String assets = "/spaces/" + spaceId + "/assets";

        var svg = owner.upload(assets, "vector.svg", "image/svg+xml",
            "<svg xmlns=\"http://www.w3.org/2000/svg\"><script>alert(1)</script></svg>".getBytes(java.nio.charset.StandardCharsets.UTF_8));
        assertThat(svg.statusCode()).isEqualTo(415);
        var spoofedPng = owner.upload(assets, "not-an-image.png", "image/png",
            "<html>not an image</html>".getBytes(java.nio.charset.StandardCharsets.UTF_8));
        assertThat(spoofedPng.statusCode()).isEqualTo(400);
        assertThat(spoofedPng.body()).contains("ASSET_INVALID");
        var mismatchedMime = owner.upload(assets, "png-declared-as-jpeg.jpg", "image/jpeg", quotaFixturePng(0xff336699));
        assertThat(mismatchedMime.statusCode()).isEqualTo(400);
        assertThat(mismatchedMime.body()).contains("ASSET_INVALID");

        var oversized = owner.upload(assets, "oversized.png", "image/png", new byte[2 * 1024 * 1024 + 1]);
        assertThat(oversized.statusCode()).isEqualTo(413);
        var oversizedDimensionsImage = new java.awt.image.BufferedImage(2049, 1, java.awt.image.BufferedImage.TYPE_INT_ARGB);
        var oversizedDimensionsPng = new java.io.ByteArrayOutputStream();
        assertThat(javax.imageio.ImageIO.write(oversizedDimensionsImage, "PNG", oversizedDimensionsPng)).isTrue();
        var oversizedDimensions = owner.upload(assets, "too-wide.png", "image/png", oversizedDimensionsPng.toByteArray());
        assertThat(oversizedDimensions.statusCode()).isEqualTo(400);
        assertThat(oversizedDimensions.body()).contains("ASSET_INVALID");
        byte[] decompressionBombHeader = pngHeaderWithDimensions(100_000, 100_000);
        assertThat(decompressionBombHeader).hasSizeLessThan(64);
        var decompressionBomb = owner.upload(assets, "huge-header.png", "image/png", decompressionBombHeader);
        assertThat(decompressionBomb.statusCode()).isEqualTo(400);
        assertThat(decompressionBomb.body()).contains("ASSET_INVALID");
        assertThat(owner.get(assets).body()).isEqualTo("[]");

        var source = new java.awt.image.BufferedImage(800, 400, java.awt.image.BufferedImage.TYPE_INT_RGB);
        var jpegBytes = new java.io.ByteArrayOutputStream();
        assertThat(javax.imageio.ImageIO.write(source, "JPEG", jpegBytes)).isTrue();
        var uploaded = owner.upload(assets, "wide-photo.jpg", "image/jpeg", jpegBytes.toByteArray());
        assertThat(uploaded.statusCode()).as(uploaded.body()).isEqualTo(200);
        JsonNode pending = json.readTree(uploaded.body());
        assertThat(pending.path("status").asText()).isEqualTo("PENDING");
        assertThat(pending.path("width").asInt()).isEqualTo(512);
        assertThat(pending.path("height").asInt()).isEqualTo(256);
        String assetId = pending.path("id").asText();
        var pendingContent = owner.get(assets + "/" + assetId + "/content");
        assertThat(pendingContent.statusCode()).isEqualTo(404);
        assertThat(owner.post(assets + "/" + assetId + "/approve", Map.of()).statusCode()).isEqualTo(200);

        var content = owner.getBytes(assets + "/" + assetId + "/content");
        assertThat(content.statusCode()).isEqualTo(200);
        assertThat(content.headers().firstValue("Content-Type").orElse("")).startsWith("image/png");
        var stored = javax.imageio.ImageIO.read(new java.io.ByteArrayInputStream(content.body()));
        assertThat(stored.getWidth()).isEqualTo(512);
        assertThat(stored.getHeight()).isEqualTo(256);
        var thumbnail = owner.getBytes(assets + "/" + assetId + "/thumbnail");
        assertThat(thumbnail.statusCode()).isEqualTo(200);
        var preview = javax.imageio.ImageIO.read(new java.io.ByteArrayInputStream(thumbnail.body()));
        assertThat(preview.getWidth()).isEqualTo(96);
        assertThat(preview.getHeight()).isEqualTo(48);
    }

    @Test void concurrentAssetUploadsCannotExceedThePerSpaceAssetLimit() throws Exception {
        Browser owner = signedIn(); Browser admin = signedIn();
        String spaceId = createSpace(owner, "동시 에셋 한도 검증", "PUBLIC", 10).path("id").asText();
        String adminId = json.readTree(admin.get("me").body()).path("userId").asText();
        assertThat(admin.post("/spaces/" + spaceId + "/admission", Map.of()).statusCode()).isEqualTo(200);
        assertThat(owner.patch("/spaces/" + spaceId + "/members/" + adminId + "/role", Map.of("role", "ADMIN")).statusCode()).isEqualTo(200);

        var placeholders = new ArrayList<Object[]>();
        for (int index = 0; index < 499; index++) {
            placeholders.add(new Object[] {
                "custom_" + UUID.randomUUID(), spaceId, adminId,
                "quota-fixture.png", UUID.randomUUID().toString().replace("-", "") + UUID.randomUUID().toString().replace("-", ""),
                UUID.randomUUID() + ".png"
            });
        }
        db.batchUpdate("""
            INSERT INTO space_asset(id,space_id,uploader_user_id,original_name,mime_type,byte_size,width,height,sha256,storage_key,status)
            VALUES (?,? ,?,?,'image/png',1,1,1,?,?,'PENDING')
            """, placeholders);

        String assets = "/spaces/" + spaceId + "/assets";
        byte[] firstImage = quotaFixturePng(0xff336699);
        byte[] secondImage = quotaFixturePng(0xffcc8844);
        try (var pool = Executors.newFixedThreadPool(2)) {
            var start = new CountDownLatch(1);
            var first = pool.submit(() -> { start.await(); return owner.upload(assets, "first.png", "image/png", firstImage); });
            var second = pool.submit(() -> { start.await(); return admin.upload(assets, "second.png", "image/png", secondImage); });
            start.countDown();
            var responses = List.of(first.get(15, TimeUnit.SECONDS), second.get(15, TimeUnit.SECONDS));
            assertThat(responses.stream().map(HttpResponse::statusCode).toList()).containsExactlyInAnyOrder(200, 413);
        }

        assertThat(db.queryForObject("SELECT COUNT(*) FROM space_asset WHERE space_id=? AND status IN ('PENDING','READY')", Integer.class, spaceId)).isEqualTo(500);
    }

    private static byte[] quotaFixturePng(int color) throws Exception {
        var image = new java.awt.image.BufferedImage(8, 6, java.awt.image.BufferedImage.TYPE_INT_ARGB);
        image.setRGB(0, 0, color);
        var encoded = new java.io.ByteArrayOutputStream();
        assertThat(javax.imageio.ImageIO.write(image, "PNG", encoded)).isTrue();
        return encoded.toByteArray();
    }

    private static byte[] pngHeaderWithDimensions(int width, int height) throws java.io.IOException {
        byte[] type = "IHDR".getBytes(java.nio.charset.StandardCharsets.US_ASCII);
        var header = new java.io.ByteArrayOutputStream();
        try (var png = new java.io.DataOutputStream(header)) {
            png.write(new byte[] {(byte) 137, 80, 78, 71, 13, 10, 26, 10});
            png.writeInt(13);
            png.write(type);
            var payload = new java.io.ByteArrayOutputStream();
            try (var ihdr = new java.io.DataOutputStream(payload)) {
                ihdr.writeInt(width);
                ihdr.writeInt(height);
                ihdr.writeByte(8);
                ihdr.writeByte(6);
                ihdr.writeByte(0);
                ihdr.writeByte(0);
                ihdr.writeByte(0);
            }
            byte[] fields = payload.toByteArray();
            png.write(fields);
            var crc = new java.util.zip.CRC32();
            crc.update(type);
            crc.update(fields);
            png.writeInt((int) crc.getValue());
        }
        return header.toByteArray();
    }

    @Test void invitationLimitsAreAtomicIdempotentRevocableAndExpiring() throws Exception {
        Browser owner = signedIn(); Browser a = signedIn(); Browser b = signedIn();
        String id = createSpace(owner, "초대 검증", "PRIVATE", 100).path("id").asText();
        var invite = json.readTree(owner.post("/spaces/" + id + "/invites", Map.of("hours", 1, "maxUses", 1)).body());
        String code = invite.path("code").asText();
        String inviteId = invite.path("invite").path("id").asText();
        assertThat(code).hasSize(22);
        assertThat(owner.get("/spaces/" + id + "/invites").body()).doesNotContain(code);
        assertThat(db.queryForObject("SELECT code_hash FROM space_invite WHERE id=?", String.class, inviteId)).hasSize(64).isNotEqualTo(code);
        try (var pool = Executors.newFixedThreadPool(2)) {
            var start = new CountDownLatch(1);
            var fa = pool.submit(() -> { start.await(); return a.post("/spaces/redeem", Map.of("code", code)); });
            var fb = pool.submit(() -> { start.await(); return b.post("/spaces/redeem", Map.of("code", code)); });
            start.countDown(); var ra = fa.get(8, TimeUnit.SECONDS); var rb = fb.get(8, TimeUnit.SECONDS);
            assertThat(List.of(ra.statusCode(), rb.statusCode())).containsExactlyInAnyOrder(200, 400);
            Browser winner = ra.statusCode() == 200 ? a : b;
            assertThat(winner.post("/spaces/redeem", Map.of("code", code)).statusCode()).isEqualTo(200);
        }
        assertThat(db.queryForObject("SELECT use_count FROM space_invite WHERE id=?", Integer.class, inviteId)).isEqualTo(1);
        assertThat(db.queryForObject("SELECT COUNT(*) FROM space_member WHERE space_id=?", Integer.class, id)).isEqualTo(2);
        Browser targetedAccount = signedIn(); Browser unrelatedAccount = signedIn();
        String targetedUserId = json.readTree(targetedAccount.get("me").body()).path("userId").asText();
        String targetedDisplayName = json.readTree(targetedAccount.get("me").body()).path("displayName").asText();
        var targetedInvite = json.readTree(owner.post("/spaces/" + id + "/invites",
            Map.of("hours", 1, "maxUses", 1, "targetUserId", targetedUserId)).body());
        String targetedInviteId = targetedInvite.path("invite").path("id").asText();
        assertThat(targetedInvite.path("invite").path("targetUserId").asText()).isEqualTo(targetedUserId);
        assertThat(targetedInvite.path("invite").path("targetDisplayName").asText()).isEqualTo(targetedDisplayName);
        var listedTargetedInvite = json.readTree(owner.get("/spaces/" + id + "/invites").body()).findValue("targetUserId");
        assertThat(listedTargetedInvite.asText()).isEqualTo(targetedUserId);
        var denied = unrelatedAccount.post("/spaces/redeem", Map.of("code", targetedInvite.path("code").asText()));
        assertThat(denied.statusCode()).isEqualTo(400);
        assertThat(json.readTree(denied.body()).toString()).contains("INVITE_UNAVAILABLE");
        assertThat(db.queryForObject("SELECT use_count FROM space_invite WHERE id=?", Integer.class, targetedInviteId)).isZero();
        assertThat(db.queryForObject("SELECT COUNT(*) FROM space_member WHERE space_id=? AND user_id=?", Integer.class, id,
            json.readTree(unrelatedAccount.get("me").body()).path("userId").asText())).isZero();
        String targetedCode = targetedInvite.path("code").asText();
        assertThat(targetedAccount.post("/spaces/redeem", Map.of("code", targetedCode)).statusCode()).isEqualTo(200);
        assertThat(targetedAccount.post("/spaces/redeem", Map.of("code", targetedCode)).statusCode()).isEqualTo(200);
        assertThat(db.queryForObject("SELECT use_count FROM space_invite WHERE id=?", Integer.class, targetedInviteId)).isEqualTo(1);

        Browser inboxAccount = signedIn(); Browser inboxUnrelatedAccount = signedIn(); Browser declineAccount = signedIn();
        String inboxUserId = json.readTree(inboxAccount.get("me").body()).path("userId").asText();
        String declineUserId = json.readTree(declineAccount.get("me").body()).path("userId").asText();
        String ownerDisplayName = json.readTree(owner.get("me").body()).path("displayName").asText();
        assertThat(owner.patch("/spaces/" + id + "/members/" + targetedUserId + "/role", Map.of("role", "ADMIN")).statusCode()).isEqualTo(200);
        var inboxInvite = json.readTree(targetedAccount.post("/spaces/" + id + "/invites",
            Map.of("hours", 1, "maxUses", 1, "targetUserId", inboxUserId)).body());
        String inboxInviteId = inboxInvite.path("invite").path("id").asText();
        var inbox = json.readTree(inboxAccount.get("/spaces/invitations/incoming").body());
        assertThat(inbox).hasSize(1);
        assertThat(inbox.get(0).path("inviteId").asText()).isEqualTo(inboxInviteId);
        assertThat(inbox.get(0).path("inviterDisplayName").asText()).isEqualTo(targetedDisplayName);
        assertThat(inbox.get(0).path("ownerDisplayName").asText()).isEqualTo(ownerDisplayName);
        assertThat(json.readTree(inboxUnrelatedAccount.get("/spaces/invitations/incoming").body())).isEmpty();
        assertThat(inboxUnrelatedAccount.post("/spaces/invitations/" + inboxInviteId + "/accept", Map.of()).statusCode()).isEqualTo(404);
        assertThat(inboxUnrelatedAccount.post("/spaces/invitations/" + inboxInviteId + "/decline", Map.of()).statusCode()).isEqualTo(404);
        var acceptedInboxInvite = inboxAccount.post("/spaces/invitations/" + inboxInviteId + "/accept", Map.of());
        assertThat(acceptedInboxInvite.statusCode()).isEqualTo(200);
        assertThat(json.readTree(acceptedInboxInvite.body()).path("id").asText()).isEqualTo(id);
        assertThat(db.queryForObject("SELECT use_count FROM space_invite WHERE id=?", Integer.class, inboxInviteId)).isEqualTo(1);
        assertThat(db.queryForObject("SELECT COUNT(*) FROM space_member WHERE space_id=? AND user_id=?", Integer.class,
            id, inboxUserId)).isEqualTo(1);
        assertThat(json.readTree(inboxAccount.get("/spaces/invitations/incoming").body())).isEmpty();
        db.update("UPDATE space_invite SET expires_at=DATE_SUB(CURRENT_TIMESTAMP(6), INTERVAL 1 SECOND) WHERE id=?", inboxInviteId);
        assertThat(inboxAccount.post("/spaces/invitations/" + inboxInviteId + "/accept", Map.of()).statusCode()).isEqualTo(200);
        assertThat(db.queryForObject("SELECT use_count FROM space_invite WHERE id=?", Integer.class, inboxInviteId)).isEqualTo(1);

        var declineInvite = json.readTree(owner.post("/spaces/" + id + "/invites",
            Map.of("hours", 1, "maxUses", 1, "targetUserId", declineUserId)).body());
        String declineInviteId = declineInvite.path("invite").path("id").asText();
        assertThat(json.readTree(declineAccount.get("/spaces/invitations/incoming").body())).hasSize(1);
        assertThat(declineAccount.post("/spaces/invitations/" + declineInviteId + "/decline", Map.of()).statusCode()).isEqualTo(200);
        assertThat(db.queryForObject("SELECT revoked FROM space_invite WHERE id=?", Boolean.class, declineInviteId)).isTrue();
        assertThat(json.readTree(declineAccount.get("/spaces/invitations/incoming").body())).isEmpty();
        assertThat(declineAccount.post("/spaces/redeem", Map.of("code", declineInvite.path("code").asText())).statusCode()).isEqualTo(400);

        Browser sameAccount = signedIn();
        sameAccount.cookieAfterCsrf();
        var retryInvite = json.readTree(owner.post("/spaces/" + id + "/invites", Map.of("hours", 1, "maxUses", 2)).body());
        String retryCode = retryInvite.path("code").asText();
        try (var pool = Executors.newFixedThreadPool(2)) {
            var start = new CountDownLatch(1);
            var first = pool.submit(() -> { start.await(); return sameAccount.post("/spaces/redeem", Map.of("code", retryCode)); });
            var second = pool.submit(() -> { start.await(); return sameAccount.post("/spaces/redeem", Map.of("code", retryCode)); });
            start.countDown();
            assertThat(first.get(8, TimeUnit.SECONDS).statusCode()).isEqualTo(200);
            assertThat(second.get(8, TimeUnit.SECONDS).statusCode()).isEqualTo(200);
        }
        assertThat(db.queryForObject("SELECT use_count FROM space_invite WHERE id=?", Integer.class, retryInvite.path("invite").path("id").asText())).isEqualTo(1);
        var revoked = json.readTree(owner.post("/spaces/" + id + "/invites", Map.of("hours", 1, "maxUses", 100)).body());
        assertThat(owner.post("/spaces/" + id + "/invites/" + revoked.path("invite").path("id").asText() + "/revoke", Map.of()).statusCode()).isEqualTo(200);
        assertThat(a.post("/spaces/redeem", Map.of("code", revoked.path("code").asText())).statusCode()).isEqualTo(400);
        var expired = json.readTree(owner.post("/spaces/" + id + "/invites", Map.of("hours", 1, "maxUses", 100)).body());
        db.update("UPDATE space_invite SET expires_at=DATE_SUB(CURRENT_TIMESTAMP(6), INTERVAL 1 SECOND) WHERE id=?", expired.path("invite").path("id").asText());
        assertThat(a.post("/spaces/redeem", Map.of("code", expired.path("code").asText())).statusCode()).isEqualTo(400);
        assertThat(a.post("/spaces/redeem", Map.of("code", "wrong")).statusCode()).isEqualTo(400);
    }

    @Test void spaceAccessBlockCannotBeBypassedByCodeOrTargetedInvitations() throws Exception {
        Browser owner = signedIn();
        Browser codeInviteTarget = signedIn();
        Browser targetedInviteTarget = signedIn();
        String spaceId = createSpace(owner, "접근 제한 초대 검증", "PUBLIC", 10).path("id").asText();
        String codeInviteTargetId = json.readTree(codeInviteTarget.get("me").body()).path("userId").asText();
        String targetedInviteTargetId = json.readTree(targetedInviteTarget.get("me").body()).path("userId").asText();

        var genericInvite = json.readTree(owner.post("/spaces/" + spaceId + "/invites",
            Map.of("hours", 2, "maxUses", 10)).body());
        String genericInviteId = genericInvite.path("invite").path("id").asText();
        String genericCode = genericInvite.path("code").asText();
        var targetedInvite = json.readTree(owner.post("/spaces/" + spaceId + "/invites",
            Map.of("hours", 2, "maxUses", 1, "targetUserId", targetedInviteTargetId)).body());
        String targetedInviteId = targetedInvite.path("invite").path("id").asText();

        assertThat(codeInviteTarget.post("/spaces/" + spaceId + "/admission", Map.of()).statusCode()).isEqualTo(200);
        assertThat(targetedInviteTarget.post("/spaces/" + spaceId + "/admission", Map.of()).statusCode()).isEqualTo(200);
        assertThat(owner.delete("/spaces/" + spaceId + "/members/" + codeInviteTargetId, Map.of()).statusCode()).isEqualTo(200);
        assertThat(owner.delete("/spaces/" + spaceId + "/members/" + targetedInviteTargetId, Map.of()).statusCode()).isEqualTo(200);

        var hiddenInbox = json.readTree(targetedInviteTarget.get("/spaces/invitations/incoming").body());
        assertThat(hiddenInbox).isEmpty();
        var deniedCodeRedemption = codeInviteTarget.post("/spaces/redeem", Map.of("code", genericCode));
        assertThat(deniedCodeRedemption.statusCode()).as(deniedCodeRedemption.body()).isEqualTo(403);
        assertThat(json.readTree(deniedCodeRedemption.body()).path("code").asText()).isEqualTo("SPACE_ACCESS_REVOKED");
        var deniedTargetedAcceptance = targetedInviteTarget.post(
            "/spaces/invitations/" + targetedInviteId + "/accept", Map.of());
        assertThat(deniedTargetedAcceptance.statusCode()).as(deniedTargetedAcceptance.body()).isEqualTo(403);
        assertThat(json.readTree(deniedTargetedAcceptance.body()).path("code").asText()).isEqualTo("SPACE_ACCESS_REVOKED");
        assertThat(db.queryForObject("SELECT COUNT(*) FROM space_access_block WHERE space_id=?", Integer.class, spaceId)).isEqualTo(2);
        assertThat(db.queryForObject("SELECT use_count FROM space_invite WHERE id=?", Integer.class, genericInviteId)).isZero();
        assertThat(db.queryForObject("SELECT use_count FROM space_invite WHERE id=?", Integer.class, targetedInviteId)).isZero();

        assertThat(owner.delete("/spaces/" + spaceId + "/access-blocks/" + codeInviteTargetId, Map.of()).statusCode()).isEqualTo(200);
        assertThat(owner.delete("/spaces/" + spaceId + "/access-blocks/" + targetedInviteTargetId, Map.of()).statusCode()).isEqualTo(200);
        assertThat(codeInviteTarget.post("/spaces/redeem", Map.of("code", genericCode)).statusCode()).isEqualTo(200);
        assertThat(json.readTree(targetedInviteTarget.get("/spaces/invitations/incoming").body())).hasSize(1);
        assertThat(targetedInviteTarget.post("/spaces/invitations/" + targetedInviteId + "/accept", Map.of()).statusCode()).isEqualTo(200);
        assertThat(db.queryForObject("SELECT use_count FROM space_invite WHERE id=?", Integer.class, genericInviteId)).isEqualTo(1);
        assertThat(db.queryForObject("SELECT use_count FROM space_invite WHERE id=?", Integer.class, targetedInviteId)).isEqualTo(1);
    }

    @Test void packagedWorldSeparatesSpacesAndEnforcesCapacityAndResumeScope() throws Exception {
        String ownerSubject = UUID.randomUUID().toString();
        Browser owner = signedInAs(ownerSubject); Browser ownerSecondSession = signedInAs(ownerSubject); Browser member = signedIn();
        String idA = createSpace(owner, "A 공간", "PUBLIC", 2).path("id").asText();
        String idB = createSpace(owner, "B 공간", "PRIVATE", 1).path("id").asText();
        String idC = createSpace(owner, "C 공간", "PRIVATE", 1).path("id").asText();
        Probe a = owner.socketWithTicket(ORIGIN, owner.ticket(idA));
        Probe b = owner.socketWithTicket(ORIGIN, owner.ticket(idB));
        Probe peer = member.socketWithTicket(ORIGIN, member.ticket(idA));
        try {
            a.join(""); var welcomeA = a.await(n -> n.path("type").asText().equals("welcome"));
            b.join(""); b.await(n -> n.path("type").asText().equals("welcome"));
            peer.join(""); peer.await(n -> n.path("type").asText().equals("welcome"));
            a.await(n -> n.path("type").asText().equals("snapshot") && a.visiblePlayers.size() == 2);
            assertThat(a.visiblePlayers.keySet()).contains(welcomeA.path("playerId").asText());
            assertThat(b.await(n -> n.path("type").asText().equals("snapshot") && b.visiblePlayers.size() == 1)).isNotNull();
            var full = ownerSecondSession.post("/spaces/" + idB + "/admission", Map.of());
            assertThat(full.statusCode()).isEqualTo(409);
            assertThat(json.readTree(full.body()).path("code").asText()).isEqualTo("SPACE_FULL");
            Probe foreignResume = owner.socketWithTicket(ORIGIN, owner.ticket(idC));
            try { foreignResume.join(welcomeA.path("resumeToken").asText()); foreignResume.await(n -> n.path("code").asText().equals("AUTH_REQUIRED")); } finally { foreignResume.socket.abort(); }
            a.socket.abort();
            peer.await(n -> n.path("type").asText().equals("snapshot")
                && n.path("removedPlayerIds").toString().contains(welcomeA.path("playerId").asText()));
            Probe resumed = owner.socketWithTicket(ORIGIN, owner.ticket(idA, idA, welcomeA.path("resumeToken").asText()));
            try { resumed.join(welcomeA.path("resumeToken").asText()); assertThat(resumed.await(n -> n.path("type").asText().equals("welcome")).path("playerId").asText()).isEqualTo(welcomeA.path("playerId").asText()); }
            finally { resumed.socket.abort(); }
        } finally { a.socket.abort(); b.socket.abort(); peer.socket.abort(); }
    }

    @Test
    @Timeout(value = 5, unit = TimeUnit.MINUTES)
    void oneHundredAuthenticatedParticipantsReceiveSeatsAndJoinThePackagedWorld() throws Exception {
        Browser owner = signedIn();
        List<Browser> participants = new ArrayList<>(100);
        participants.add(owner);
        Browser overflow = null;
        List<Probe> sockets = new ArrayList<>();
        try {
            String spaceId = createSpace(owner, "인증 100명 용량 통합", "PUBLIC", 100).path("id").asText();
            for (int index = 1; index < 100; index++) participants.add(signedIn());
            overflow = signedIn();

            List<String> tickets = new ArrayList<>(100);
            try (var admissionPool = Executors.newFixedThreadPool(24);
                 var socketPool = Executors.newFixedThreadPool(32)) {
                List<Future<HttpResponse<String>>> admissions = new ArrayList<>(participants.size());
                for (Browser participant : participants)
                    admissions.add(admissionPool.submit(() -> participant.post("/spaces/" + spaceId + "/admission", Map.of())));

                for (Future<HttpResponse<String>> admission : admissions) {
                    HttpResponse<String> response = admission.get(45, TimeUnit.SECONDS);
                    assertThat(response.statusCode()).as(response.body()).isEqualTo(200);
                    JsonNode issued = json.readTree(response.body());
                    assertThat(Arrays.asList(TEST_WORLD_ENDPOINTS.split(",")))
                        .contains(issued.path("worldUrl").asText());
                    assertThat(issued.path("expiresInSeconds").asInt()).isEqualTo(30);
                    tickets.add(issued.path("ticket").asText());
                }
                assertThat(new HashSet<>(tickets)).hasSize(100);
                assertThat(strings.opsForZSet().zCard("hufs-town:seats:" + spaceId)).isEqualTo(100L);

                var full = overflow.post("/spaces/" + spaceId + "/admission", Map.of());
                assertThat(full.statusCode()).as(full.body()).isEqualTo(409);
                assertThat(json.readTree(full.body()).path("code").asText()).isEqualTo("SPACE_FULL");

                List<Future<Probe>> handshakes = new ArrayList<>(tickets.size());
                for (int index = 0; index < tickets.size(); index++) {
                    Browser participant = participants.get(index);
                    String ticket = tickets.get(index);
                    handshakes.add(socketPool.submit(() -> participant.socketWithTicket(ORIGIN, ticket)));
                }
                for (Future<Probe> handshake : handshakes) sockets.add(handshake.get(20, TimeUnit.SECONDS));

                List<Future<JsonNode>> welcomes = new ArrayList<>(sockets.size());
                for (Probe socket : sockets)
                    welcomes.add(socketPool.submit(() -> {
                        socket.join("");
                        return socket.await(node -> node.path("type").asText().equals("welcome"),
                            java.time.Duration.ofSeconds(30));
                    }));
                Set<String> playerIds = new HashSet<>();
                for (Future<JsonNode> welcome : welcomes)
                    playerIds.add(welcome.get(35, TimeUnit.SECONDS).path("playerId").asText());
                assertThat(playerIds).hasSize(100);

                long rosterDeadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(30);
                while (sockets.getFirst().visiblePlayers.size() < 100 && System.nanoTime() < rosterDeadline)
                    Thread.sleep(50);
                assertThat(sockets.getFirst().visiblePlayers).hasSize(100);
                assertThat(strings.opsForZSet().zCard("hufs-town:seats:" + spaceId)).isEqualTo(100L);
            }
        } finally {
            sockets.forEach(socket -> socket.socket.abort());
            participants.forEach(participant -> participant.client.close());
            if (overflow != null) overflow.client.close();
        }
    }

    @Test
    void analyticsDashboardReadsWorldJoinCountersAndEnforcesTheSsoAdministratorAllowlist() throws Exception {
        db.update("""
            INSERT INTO app_user(id,display_name) VALUES (?, '분석 검토 운영자')
            ON DUPLICATE KEY UPDATE display_name=VALUES(display_name)
            """, REPORT_ADMIN_ID);
        db.update("""
            INSERT INTO oauth_identity(user_id,provider,subject) VALUES (?,'gdg_hufs',?)
            ON DUPLICATE KEY UPDATE user_id=VALUES(user_id)
            """, REPORT_ADMIN_ID, REPORT_ADMIN_SUBJECT);

        Browser administrator = signedInAs(REPORT_ADMIN_SUBJECT);
        Browser participant = signedIn();
        Browser anonymous = new Browser();
        String spaceId = createSpace(administrator, "실제 월드 분석 집계", "PUBLIC", 4)
            .path("id").asText();
        var today = java.time.LocalDate.now(java.time.ZoneOffset.UTC);
        long joinsBefore = db.queryForObject("""
            SELECT COALESCE(MAX(event_count),0) FROM town_product_analytics_daily
            WHERE metric_date=? AND metric_key='space_joined'
            """, Long.class, today);
        List<Probe> probes = new ArrayList<>();
        try {
            for (Browser browser : List.of(administrator, participant)) {
                Probe probe = browser.socketWithTicket(ORIGIN, browser.ticketDefault(spaceId));
                probes.add(probe);
                probe.join("");
                probe.await(node -> node.path("type").asText().equals("welcome"),
                    java.time.Duration.ofSeconds(15));
            }

            long analyticsDeadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(10);
            long observedJoins = joinsBefore;
            while (observedJoins < joinsBefore + probes.size() && System.nanoTime() < analyticsDeadline) {
                Thread.sleep(50);
                observedJoins = db.queryForObject("""
                    SELECT COALESCE(MAX(event_count),0) FROM town_product_analytics_daily
                    WHERE metric_date=? AND metric_key='space_joined'
                    """, Long.class, today);
            }
            assertThat(observedJoins).isEqualTo(joinsBefore + probes.size());

            var dashboardResponse = administrator.get("/admin/analytics");
            assertThat(dashboardResponse.statusCode()).as(dashboardResponse.body()).isEqualTo(200);
            JsonNode dashboard = json.readTree(dashboardResponse.body());
            assertThat(dashboard.path("days")).hasSize(30);
            JsonNode latestDay = dashboard.path("days").get(29);
            assertThat(latestDay.path("date").asText()).isEqualTo(today.toString());
            assertThat(latestDay.path("counts").path("spaceJoins").asLong())
                .isEqualTo(joinsBefore + probes.size());
            assertThat(dashboard.path("totals").path("spaceJoins").asLong())
                .isEqualTo(joinsBefore + probes.size());
            assertThat(dashboard.path("retentionDays").asInt()).isEqualTo(90);
            assertThat(dashboardResponse.body()).doesNotContain(REPORT_ADMIN_ID, spaceId,
                "tester@hufs.ac.kr", "displayName", "message");
            assertThat(participant.get("/admin/analytics").statusCode()).isEqualTo(403);
            assertThat(anonymous.get("/admin/analytics").statusCode()).isEqualTo(401);
        } finally {
            probes.forEach(probe -> probe.socket.abort());
            administrator.client.close();
            participant.client.close();
            anonymous.client.close();
        }
    }

    @Test void distributedWorldOwnershipFencesDuplicateAndStaleNodeWriters() throws Exception {
        Browser owner = signedIn();
        String space = createSpace(owner, "월드 소유권 fence", "PRIVATE", 4).path("id").asText();
        try (AdditionalWorld firstWorld = startAdditionalWorld()) {
            Probe first = owner.socketWithTicket(ORIGIN, owner.ticket(space), firstWorld.port());
            Probe second = null;
            try {
                first.join("");
                JsonNode firstWelcome = first.await(node -> node.path("type").asText().equals("welcome"));
                String resumeToken = firstWelcome.path("resumeToken").asText();
                String seatId = strings.opsForZSet().range("hufs-town:seats:" + space, 0, -1).stream().findFirst().orElseThrow();
                String ownerKey = "hufs-town:seat-owner:" + space + ":" + seatId;
                String oldOwner = strings.opsForValue().get(ownerKey);
                assertThat(oldOwner).isNotBlank();

                String contenderTicket = owner.ticket(space, space, resumeToken);
                second = owner.socketWithTicket(ORIGIN, contenderTicket, worldPort);
                second.join(resumeToken);
                JsonNode blocked = second.await(node -> node.path("code").asText().equals("WORLD_OWNER_BUSY"));
                assertThat(blocked.path("type").asText()).isEqualTo("error");
                assertThat(strings.opsForValue().get(ownerKey)).isEqualTo(oldOwner);
                second.socket.abort();

                // Simulate the current owner lease being lost while its JVM is still alive.
                strings.delete(ownerKey);
                String takeoverTicket = owner.ticket(space, space, resumeToken);
                second = owner.socketWithTicket(ORIGIN, takeoverTicket, worldPort);
                second.join(resumeToken);
                JsonNode secondWelcome = second.await(node -> node.path("type").asText().equals("welcome"));
                assertThat(secondWelcome.path("resumeToken").asText()).isEqualTo(resumeToken);
                String newOwner = strings.opsForValue().get(ownerKey);
                assertThat(newOwner).isNotEqualTo(oldOwner);
                assertThat(Long.parseLong(newOwner.substring(newOwner.indexOf('|') + 1)))
                    .isGreaterThan(Long.parseLong(oldOwner.substring(oldOwner.indexOf('|') + 1)));
                first.await(node -> node.path("code").asText().equals("WORLD_OWNER_LOST"), java.time.Duration.ofSeconds(5));
                first.closed.get(5, TimeUnit.SECONDS);
            } finally {
                first.socket.abort();
                if (second != null) second.socket.abort();
            }
        }
    }

    @Test void freshBrowserTabHandsOffTheExistingAvatarAndSpaceSeat() throws Exception {
        Browser owner = signedIn();
        String space = createSpace(owner, "중복 탭 인계", "PRIVATE", 1).path("id").asText();
        Probe first = owner.socketWithTicket(ORIGIN, owner.ticket(space));
        Probe second = null;
        try {
            first.join("");
            JsonNode firstWelcome = first.await(node -> node.path("type").asText().equals("welcome"));
            String seatId = strings.opsForZSet().range("hufs-town:seats:" + space, 0, -1).stream().findFirst().orElseThrow();

            String secondTicket = owner.ticket(space);
            String secondAdmission = strings.opsForValue().get("hufs-town:admission:" + secondTicket);
            assertThat(secondAdmission).isNotNull();
            assertThat(secondAdmission.split("\\n", -1)[8]).isEqualTo("1");
            second = owner.socketWithTicket(ORIGIN, secondTicket);
            second.join("");
            JsonNode secondWelcome = second.await(node -> node.path("type").asText().equals("welcome"));

            assertThat(secondWelcome.path("playerId").asText()).isEqualTo(firstWelcome.path("playerId").asText());
            assertThat(secondWelcome.path("resumeToken").asText()).isEqualTo(firstWelcome.path("resumeToken").asText());
            assertThat(first.await(node -> node.path("code").asText().equals("WORLD_OWNER_LOST"))).isNotNull();
            assertThat(strings.opsForZSet().zCard("hufs-town:seats:" + space)).isEqualTo(1L);
            assertThat(strings.opsForValue().get("hufs-town:seat-owner:" + space + ":" + seatId)).isNotBlank();
            second.socket.abort();
            long cleanupDeadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(20);
            while (strings.opsForZSet().zCard("hufs-town:seats:" + space) > 0 && System.nanoTime() < cleanupDeadline)
                Thread.sleep(100);
            assertThat(strings.opsForZSet().zCard("hufs-town:seats:" + space)).isZero();
        } finally {
            first.socket.abort();
            if (second != null) second.socket.abort();
        }
    }

    @Test void admissionTicketsAreRequiredBoundToSessionSingleUseAndShortLived() throws Exception {
        Browser owner = signedIn(); Browser other = signedIn();
        String id = createSpace(owner, "입장권 검증", "PRIVATE", 100).path("id").asText();
        assertThatThrownBy(() -> owner.socketWithTicket(ORIGIN, "")).hasCauseInstanceOf(WebSocketHandshakeException.class);
        String ticket = owner.ticket(id);
        assertThat(strings.getExpire("hufs-town:admission:" + ticket)).isBetween(1L, 30L);
        assertThatThrownBy(() -> other.socketWithTicket(ORIGIN, ticket)).hasCauseInstanceOf(WebSocketHandshakeException.class);
        Probe accepted = owner.socketWithTicket(ORIGIN, ticket); accepted.socket.abort();
        assertThatThrownBy(() -> owner.socketWithTicket(ORIGIN, ticket)).hasCauseInstanceOf(WebSocketHandshakeException.class);
        String expired = owner.ticket(id); strings.expire("hufs-town:admission:" + expired, java.time.Duration.ZERO);
        assertThatThrownBy(() -> owner.socketWithTicket(ORIGIN, expired)).hasCauseInstanceOf(WebSocketHandshakeException.class);
    }

    @Test void editorLeasesFenceOldTabsAndDraftSavesAreIdempotent() throws Exception {
        var owner=signedIn();var other=signedIn();String space=createSpace(owner,"편집 권한","PUBLIC",10).path("id").asText();String root="/spaces/"+space+"/map";
        assertThat(other.get(root).statusCode()).isEqualTo(200);
        assertThat(other.get(root+"/editor").statusCode()).isEqualTo(403);
        String client=UUID.randomUUID().toString();JsonNode first=ok(owner.post(root+"/lease",Map.of("clientId",client,"takeover",false)));
        var credentials=credentials(first,client);String secondClient=UUID.randomUUID().toString();
        assertThat(owner.post(root+"/lease",Map.of("clientId",secondClient,"takeover",false)).statusCode()).isEqualTo(409);
        var doc=first.path("editor").path("map").deepCopy();((com.fasterxml.jackson.databind.node.ObjectNode)doc).put("name","나의 오피스");
        var request=Map.of("lease",credentials,"baseVersion",1,"operationId",UUID.randomUUID().toString(),"map",doc);
        assertThat(ok(owner.post(root+"/draft",request)).path("version").asLong()).isEqualTo(2);
        assertThat(ok(owner.post(root+"/draft",request)).path("version").asLong()).isEqualTo(2);
        assertThat(owner.post(root+"/draft",Map.of("lease",credentials,"baseVersion",1,"operationId",UUID.randomUUID().toString(),"map",doc)).statusCode()).isEqualTo(409);
        JsonNode second=ok(owner.post(root+"/lease",Map.of("clientId",secondClient,"takeover",true)));
        assertThat(second.path("fence").asLong()).isGreaterThan(first.path("fence").asLong());
        assertThat(owner.post(root+"/lease/renew",credentials).statusCode()).isEqualTo(409);
        assertThat(owner.post(root+"/publish",Map.of("lease",credentials,"baseVersion",2)).statusCode()).isEqualTo(409);
        var current=credentials(second,secondClient);
        var currentDraft=(com.fasterxml.jackson.databind.node.ObjectNode)second.path("editor").path("map").deepCopy();
        currentDraft.put("name","새 탭의 최신 초안");
        assertThat(ok(owner.post(root+"/draft",Map.of("lease",current,"baseVersion",2,"operationId",UUID.randomUUID().toString(),"map",currentDraft))).path("version").asLong()).isEqualTo(3);
        var staleDraft=(com.fasterxml.jackson.databind.node.ObjectNode)doc.deepCopy();staleDraft.put("name","끊긴 탭의 오래된 초안");
        assertThat(owner.post(root+"/draft",Map.of("lease",credentials,"baseVersion",2,"operationId",UUID.randomUUID().toString(),"map",staleDraft)).statusCode()).isEqualTo(409);
        var unchanged=ok(owner.get(root+"/editor"));
        assertThat(unchanged.path("version").asLong()).isEqualTo(3);
        assertThat(unchanged.path("map").path("name").asText()).isEqualTo("새 탭의 최신 초안");
        assertThat(owner.post(root+"/lease/renew",current).statusCode()).isEqualTo(200);
        db.update("UPDATE space_map SET lease_until=DATE_SUB(CURRENT_TIMESTAMP(6),INTERVAL 1 SECOND) WHERE space_id=?",space);
        assertThat(owner.post(root+"/lease/renew",current).statusCode()).isEqualTo(409);
        assertThat(ok(owner.post(root+"/lease",Map.of("clientId",secondClient,"takeover",false))).path("fence").asLong()).isGreaterThan(second.path("fence").asLong());
    }

    @Test void collaborativeMapOperationsMergeDisjointOfflineEditsAndUndoOnlyTheAuthorsOwnChange() throws Exception {
        Browser owner=signedIn(),administrator=signedIn();
        String space=createSpace(owner,"공동 편집 순서","PUBLIC",20).path("id").asText();
        String mapId=space,root="/spaces/"+space+"/maps/"+mapId;
        String ownerId=ok(owner.get("me")).path("userId").asText();
        String administratorId=ok(administrator.get("me")).path("userId").asText();
        db.update("INSERT INTO space_member(space_id,user_id,role,manager) VALUES (?,?,'MEMBER',TRUE)",space,administratorId);

        String clientA=UUID.randomUUID().toString();
        JsonNode lease=ok(owner.post(root+"/lease",Map.of("clientId",clientA,"takeover",false)));
        var credentials=credentials(lease,clientA);
        var legacyDraft=(com.fasterxml.jackson.databind.node.ObjectNode)lease.path("editor").path("map").deepCopy();
        legacyDraft.put("name","저장된 기존 초안");
        JsonNode saved=ok(owner.post(root+"/draft",Map.of("lease",credentials,"baseVersion",1,"operationId",UUID.randomUUID().toString(),"map",legacyDraft)));
        assertThat(owner.post(root+"/edit/enable",Map.of("baseVersion",2)).statusCode()).isEqualTo(409);
        assertThat(owner.post(root+"/edit/presence",Map.of("clientId",clientA,"selection",List.of())).statusCode()).isEqualTo(409);
        assertThat(owner.post(root+"/lease/release",credentials).statusCode()).isEqualTo(200);
        JsonNode enabled=ok(owner.post(root+"/edit/enable",Map.of("baseVersion",2)));
        assertThat(enabled.path("sequence").asLong()).isZero();
        assertThat(enabled.path("editor").path("map").path("schemaVersion").asInt()).isEqualTo(2);
        assertThat(enabled.path("editor").path("map").path("name").asText()).isEqualTo("저장된 기존 초안");
        assertThat(owner.post(root+"/lease",Map.of("clientId",UUID.randomUUID().toString(),"takeover",true)).statusCode()).isEqualTo(409);
        assertThat(owner.post(root+"/draft",Map.of("lease",credentials,"baseVersion",2,"operationId",UUID.randomUUID().toString(),"map",legacyDraft)).statusCode()).isEqualTo(409);

        String objectId="collab-object-a",labelId="collab-label-b",objectOperation=UUID.randomUUID().toString();
        var addObject=Map.of("kind","ENTITY_ADD","collection","objects","entity",Map.of("id",objectId,"asset","desk-monitor","x",10,"y",10,"scale",1));
        var firstCommand=Map.of("protocolVersion",1,"mapId",mapId,"clientId",clientA,"operationId",objectOperation,"baseSequence",0,"actions",List.of(addObject));
        JsonNode first=ok(owner.post(root+"/edit/operations",firstCommand));
        assertThat(first.path("sequence").asLong()).isEqualTo(1);
        assertThat(first.path("operation").path("actorId").asText()).isEqualTo(ownerId);
        assertThat(first.path("operation").path("actorName").asText()).isNotBlank();
        var presenceUpdate=Map.of("clientId",clientA,"selection",List.of(Map.of("collection","objects","entityId",objectId)));
        assertThat(ok(owner.post(root+"/edit/presence",presenceUpdate)).path("updated").asBoolean()).isTrue();
        JsonNode presence=ok(administrator.get(root+"/edit/presence?clientId="+UUID.randomUUID()));
        assertThat(presence.path("participants")).hasSize(1);
        assertThat(presence.path("participants").get(0).path("userId").asText()).isEqualTo(ownerId);
        assertThat(presence.path("participants").get(0).path("selection").get(0).path("entityId").asText()).isEqualTo(objectId);
        assertThat(ok(owner.delete(root+"/edit/presence?clientId="+clientA,Map.of())).path("removed").asBoolean()).isTrue();

        String clientB=UUID.randomUUID().toString(),labelOperation=UUID.randomUUID().toString();
        var addLabel=Map.of("kind","ENTITY_ADD","collection","labels","entity",Map.of("id",labelId,"text","협업 안내","x",12,"y",12));
        var offlineCommand=Map.of("protocolVersion",1,"mapId",mapId,"clientId",clientB,"operationId",labelOperation,"baseSequence",0,"actions",List.of(addLabel));
        JsonNode second=ok(administrator.post(root+"/edit/operations",offlineCommand));
        assertThat(second.path("sequence").asLong()).isEqualTo(2);
        assertThat(second.path("operation").path("actorId").asText()).isEqualTo(administratorId);
        assertThat(ok(administrator.post(root+"/edit/operations",offlineCommand)).path("duplicate").asBoolean()).isTrue();

        var conflictingObject=Map.of("kind","ENTITY_REPLACE","collection","objects","entity",Map.of("id",objectId,"asset","desk-monitor","x",13,"y",10,"scale",1));
        var conflictingCommand=Map.of("protocolVersion",1,"mapId",mapId,"clientId",clientB,"operationId",UUID.randomUUID().toString(),"baseSequence",0,"actions",List.of(conflictingObject));
        var conflict=administrator.post(root+"/edit/operations",conflictingCommand);
        assertThat(conflict.statusCode()).isEqualTo(409);
        JsonNode conflictBody=json.readTree(conflict.body());
        assertThat(conflictBody.path("code").asText()).isEqualTo("MAP_EDIT_CONFLICT");
        assertThat(conflictBody.path("sequence").asLong()).isEqualTo(2);
        assertThat(conflictBody.path("editor").path("map").path("objects").findValuesAsText("id")).contains(objectId);
        assertThat(administrator.post(root+"/edit/operations",Map.of("protocolVersion",1,"mapId",mapId,"clientId",clientB,"operationId",UUID.randomUUID().toString(),"baseSequence",2,"actorId",administratorId,"actions",List.of(addLabel))).statusCode()).isEqualTo(400);

        var sync=ok(owner.get(root+"/edit?afterSequence=0&limit=1"));
        assertThat(sync.path("sequence").asLong()).isEqualTo(2);
        assertThat(sync.path("operations")).hasSize(1);
        assertThat(sync.path("hasMore").asBoolean()).isTrue();
        String undoClient=UUID.randomUUID().toString(),undoOperation=UUID.randomUUID().toString();
        var undo=Map.of("protocolVersion",1,"mapId",mapId,"clientId",undoClient,"operationId",undoOperation,"baseSequence",2,"undoSequence",1);
        assertThat(administrator.post(root+"/edit/undo",undo).statusCode()).isEqualTo(403);
        JsonNode undone=ok(owner.post(root+"/edit/undo",undo));
        assertThat(undone.path("sequence").asLong()).isEqualTo(3);
        assertThat(undone.path("operation").path("undoOfSequence").asLong()).isEqualTo(1);
        assertThat(ok(owner.post(root+"/edit/undo",undo)).path("duplicate").asBoolean()).isTrue();
        var finalMap=ok(owner.get(root+"/edit?afterSequence=2"));
        assertThat(finalMap.path("editor").path("map").path("objects").findValuesAsText("id")).doesNotContain(objectId);
        assertThat(finalMap.path("editor").path("map").path("labels").findValuesAsText("id")).contains(labelId);

        String entityA="collab-order-a",entityB="collab-order-b",entityC="collab-order-c";
        var seedActions=List.of(
            Map.of("kind","ENTITY_ADD","collection","objects","entity",Map.of("id",entityA,"asset","desk-monitor","x",16,"y",10,"scale",1)),
            Map.of("kind","ENTITY_ADD","collection","objects","entity",Map.of("id",entityB,"asset","desk-monitor","x",19,"y",10,"scale",1)));
        var seedCommand=Map.of("protocolVersion",1,"mapId",mapId,"clientId",clientA,"operationId",UUID.randomUUID().toString(),"baseSequence",3,"actions",seedActions);
        assertThat(ok(owner.post(root+"/edit/operations",seedCommand)).path("sequence").asLong()).isEqualTo(4);
        var addAfterAnchor=Map.of("kind","ENTITY_ADD","collection","objects","entity",Map.of("id",entityC,"asset","desk-monitor","x",22,"y",10,"scale",1),"afterId",entityA);
        var replaceAnchor=Map.of("kind","ENTITY_REPLACE","collection","objects","entity",Map.of("id",entityA,"asset","desk-monitor","x",16.5,"y",10,"scale",1));
        var reorderEntity=new LinkedHashMap<String,Object>();
        reorderEntity.put("kind","ENTITY_REORDER");reorderEntity.put("collection","objects");reorderEntity.put("entityId",entityB);reorderEntity.put("afterId",null);
        var orderedCommand=Map.of("protocolVersion",1,"mapId",mapId,"clientId",clientA,"operationId",UUID.randomUUID().toString(),"baseSequence",4,"actions",List.of(addAfterAnchor,replaceAnchor,reorderEntity));
        JsonNode ordered=ok(owner.post(root+"/edit/operations",orderedCommand));
        assertThat(ordered.path("sequence").asLong()).isEqualTo(5);
        var orderedIds=ordered.path("editor").path("map").path("objects").findValuesAsText("id");
        assertThat(orderedIds).containsSubsequence(entityB,entityA,entityC);
        int entityAIndex=orderedIds.indexOf(entityA);
        assertThat(ordered.path("editor").path("map").path("objects").get(entityAIndex).path("x").asDouble()).isEqualTo(16.5);

        long barrierSequence=ordered.path("sequence").asLong(),barrierVersion=ordered.path("editor").path("version").asLong();
        String publishOperationId=UUID.randomUUID().toString();
        var racePublishRequest=Map.of("clientId",clientA,"operationId",publishOperationId,"baseSequence",barrierSequence,"baseVersion",barrierVersion);
        String racingLabelId="racing-publish-label";
        var raceCommand=Map.of("protocolVersion",1,"mapId",mapId,"clientId",clientB,"operationId",UUID.randomUUID().toString(),"baseSequence",barrierSequence,
            "actions",List.of(Map.of("kind","ENTITY_ADD","collection","labels","entity",Map.of("id",racingLabelId,"text","게시와 동시에 저장","x",25,"y",16))));
        var gate=new CountDownLatch(1);
        var pool=Executors.newFixedThreadPool(2);
        HttpResponse<String> racePublishResponse,raceEditResponse;
        try{
            var publishFuture=pool.submit(()->{gate.await();return owner.post(root+"/edit/publish",racePublishRequest);});
            var editFuture=pool.submit(()->{gate.await();return administrator.post(root+"/edit/operations",raceCommand);});
            gate.countDown();
            racePublishResponse=publishFuture.get(15,TimeUnit.SECONDS);
            raceEditResponse=editFuture.get(15,TimeUnit.SECONDS);
        }finally{pool.shutdownNow();}
        JsonNode raceEdit=ok(raceEditResponse);
        assertThat(raceEdit.path("sequence").asLong()).isEqualTo(barrierSequence+1);
        JsonNode racingPublication=null;
        if(racePublishResponse.statusCode()==200){
            racingPublication=json.readTree(racePublishResponse.body());
            assertThat(racingPublication.path("editSequence").asLong()).isEqualTo(barrierSequence);
            assertThat(ok(owner.get(root+"/published")).path("labels").findValuesAsText("id")).doesNotContain(racingLabelId);
        }else{
            assertThat(racePublishResponse.statusCode()).isEqualTo(409);
            assertThat(json.readTree(racePublishResponse.body()).path("code").asText()).isEqualTo("MAP_EDIT_CONFLICT");
        }

        JsonNode ownerView=ok(owner.get(root+"/edit?afterSequence=0&limit=250"));
        JsonNode administratorView=ok(administrator.get(root+"/edit?afterSequence=0&limit=250"));
        assertThat(ownerView.path("sequence").asLong()).isEqualTo(administratorView.path("sequence").asLong());
        assertThat(ownerView.path("editor").path("map")).isEqualTo(administratorView.path("editor").path("map"));
        assertThat(ownerView.path("editor").path("map").path("labels").findValuesAsText("id")).contains(racingLabelId);
        long currentSequence=ownerView.path("sequence").asLong(),currentVersion=ownerView.path("editor").path("version").asLong();
        var staleSequence=owner.post(root+"/edit/publish",Map.of("clientId",clientA,"operationId",UUID.randomUUID().toString(),"baseSequence",currentSequence-1,"baseVersion",currentVersion));
        assertThat(staleSequence.statusCode()).isEqualTo(409);
        var staleVersion=owner.post(root+"/edit/publish",Map.of("clientId",clientA,"operationId",UUID.randomUUID().toString(),"baseSequence",currentSequence,"baseVersion",currentVersion-1));
        assertThat(staleVersion.statusCode()).isEqualTo(409);

        db.update("UPDATE space_member SET manager=FALSE WHERE space_id=? AND user_id=?",space,administratorId);
        var revoked=administrator.post(root+"/edit/publish",Map.of("clientId",clientB,"operationId",UUID.randomUUID().toString(),"baseSequence",currentSequence,"baseVersion",currentVersion));
        assertThat(revoked.statusCode()).isEqualTo(403);
        JsonNode published;
        if(racingPublication!=null){
            published=racingPublication;
        }else{
            published=ok(owner.post(root+"/edit/publish",Map.of("clientId",clientA,"operationId",publishOperationId,"baseSequence",currentSequence,"baseVersion",currentVersion)));
        }
        assertThat(published.path("editSequence").asLong()).isEqualTo(racingPublication==null?currentSequence:barrierSequence);
        assertThat(published.path("publishedEditSequence").asLong()).isEqualTo(racingPublication==null?currentSequence:barrierSequence);
        assertThat(published.path("editor").path("publishedRevision").asText()).isNotBlank();
        assertThat(published.path("duplicate").asBoolean()).isFalse();

        JsonNode duplicate=racingPublication!=null
            ?ok(owner.post(root+"/edit/publish",racePublishRequest))
            :ok(owner.post(root+"/edit/publish",Map.of("clientId",clientA,"operationId",publishOperationId,"baseSequence",currentSequence,"baseVersion",currentVersion)));
        assertThat(duplicate.path("duplicate").asBoolean()).isTrue();
        assertThat(duplicate.path("editSequence").asLong()).isEqualTo(currentSequence);
        assertThat(duplicate.path("publishedEditSequence").asLong()).isEqualTo(published.path("publishedEditSequence").asLong());
        assertThat(duplicate.path("editor").path("publishedRevision").asText()).isEqualTo(published.path("editor").path("publishedRevision").asText());
        var reusedPublishId=owner.post(root+"/edit/publish",Map.of("clientId",clientA,"operationId",publishOperationId,"baseSequence",currentSequence+1,"baseVersion",currentVersion));
        assertThat(reusedPublishId.statusCode()).isEqualTo(409);
        assertThat(json.readTree(reusedPublishId.body()).path("code").asText()).isEqualTo("MAP_EDIT_CONFLICT");
        JsonNode liveMap=ok(owner.get(root+"/published"));
        assertThat(liveMap.path("revision").asText()).isEqualTo(published.path("editor").path("publishedRevision").asText());
        if(racingPublication==null)assertThat(liveMap.path("labels").findValuesAsText("id")).contains(racingLabelId);
        JsonNode history=ok(owner.get(root+"/history"));
        assertThat(history).hasSize(2);
        assertThat(history.get(0).path("reason").asText()).isEqualTo("PUBLISH");
        String initialRevision=history.get(1).path("id").asText();

        String restoreOperation=UUID.randomUUID().toString();
        long restoreBaseVersion=currentVersion+(racingPublication==null?1:0);
        JsonNode restored=ok(owner.post(root+"/edit/publish",Map.of("clientId",clientA,"operationId",restoreOperation,"baseSequence",currentSequence,"baseVersion",restoreBaseVersion,"revisionId",initialRevision)));
        assertThat(restored.path("editSequence").asLong()).isEqualTo(currentSequence);
        var restoredDraft=(com.fasterxml.jackson.databind.node.ObjectNode)restored.path("editor").path("map").deepCopy();
        var previousDraft=(com.fasterxml.jackson.databind.node.ObjectNode)ownerView.path("editor").path("map").deepCopy();
        restoredDraft.remove("revision");previousDraft.remove("revision");
        assertThat(restoredDraft).isEqualTo(previousDraft);
        JsonNode restoredHistory=ok(owner.get(root+"/history"));
        assertThat(restoredHistory).hasSize(3);
        assertThat(restoredHistory.get(0).path("reason").asText()).isEqualTo("ROLLBACK");
        assertThat(ok(owner.get(root+"/published")).path("labels").findValuesAsText("id")).doesNotContain(racingLabelId);

        var editAfterPublish=Map.of("kind","ENTITY_ADD","collection","labels","entity",Map.of("id","post-publish-label","text","게시 후 변경","x",20,"y",20));
        JsonNode afterPublish=ok(owner.post(root+"/edit/operations",Map.of("protocolVersion",1,"mapId",mapId,"clientId",clientA,"operationId",UUID.randomUUID().toString(),"baseSequence",restored.path("editSequence").asLong(),"actions",List.of(editAfterPublish))));
        assertThat(afterPublish.path("sequence").asLong()).isEqualTo(restored.path("editSequence").asLong()+1);
        assertThat(owner.post(root+"/edit/publish",Map.of("clientId",clientA,"operationId",UUID.randomUUID().toString(),"baseSequence",restored.path("editSequence").asLong(),"baseVersion",restored.path("editor").path("version").asLong())).statusCode()).isEqualTo(409);

        var invalidDraft=(com.fasterxml.jackson.databind.node.ObjectNode)afterPublish.path("editor").path("map").deepCopy();
        invalidDraft.put("spawnX",invalidDraft.path("width").asLong());
        db.update("UPDATE space_map SET draft_json=? WHERE space_id=? AND map_id=?",invalidDraft.toString(),space,mapId);
        var invalidPublish=owner.post(root+"/edit/publish",Map.of("clientId",clientA,"operationId",UUID.randomUUID().toString(),"baseSequence",afterPublish.path("sequence").asLong(),"baseVersion",afterPublish.path("editor").path("version").asLong()));
        assertThat(invalidPublish.statusCode()).isEqualTo(400);
        assertThat(json.readTree(invalidPublish.body()).path("code").asText()).isEqualTo("MAP_INVALID");
        db.update("UPDATE space_map SET draft_json=? WHERE space_id=? AND map_id=?",afterPublish.path("editor").path("map").toString(),space,mapId);
    }

    @Test void eventSpeakerRightsAreManagedBySpaceRoleAndRevokedOnEventChanges() throws Exception {
        Browser owner=signedIn();Browser guest=signedIn();
        String space=createSpace(owner,"발표 발언권 통합","PUBLIC",100).path("id").asText();
        Probe ownerProbe=owner.socketWithTicket(ORIGIN,owner.ticket(space));
        Probe guestProbe=guest.socketWithTicket(ORIGIN,guest.ticket(space));
        try {
            ownerProbe.join("");guestProbe.join("");
            var ownerWelcome=ownerProbe.await(message->message.path("type").asText().equals("welcome"));
            var guestWelcome=guestProbe.await(message->message.path("type").asText().equals("welcome"));
            String ownerId=ownerWelcome.path("playerId").asText(),guestId=guestWelcome.path("playerId").asText();
            long ownerEpoch=ownerWelcome.path("epoch").asLong(),guestEpoch=guestWelcome.path("epoch").asLong();
            ownerProbe.await(message->message.path("type").asText().equals("snapshot")
                &&java.util.stream.StreamSupport.stream(message.path("players").spliterator(),false)
                    .anyMatch(player->player.path("id").asText().equals(ownerId)&&player.path("eventManager").asBoolean()));
            guestProbe.await(message->message.path("type").asText().equals("snapshot")
                &&java.util.stream.StreamSupport.stream(message.path("players").spliterator(),false)
                    .anyMatch(player->player.path("id").asText().equals(guestId)&&!player.path("eventManager").asBoolean()));

            ownerProbe.send(eventAction(ownerEpoch,"event-start","START","","HUFS 타운 전체 발표","발언권 권한 검증","",false));
            assertThat(ownerProbe.await(message->message.path("type").asText().equals("eventActionAck")
                &&message.path("requestId").asText().equals("event-start")).path("accepted").asBoolean()).isTrue();
            var started=guestProbe.await(message->message.path("type").asText().equals("eventState")&&message.path("active").asBoolean());
            assertThat(started.path("title").asText()).isEqualTo("HUFS 타운 전체 발표");
            assertThat(started.path("hostPlayerId").asText()).isEqualTo(ownerId);
            assertThat(started.path("speakerPlayerIds")).hasSize(1);
            assertThat(started.path("speakerPlayerIds").get(0).asText()).isEqualTo(ownerId);

            guestProbe.send(eventAction(guestEpoch,"unauthorized-stop","STOP","","","","",false));
            var refused=guestProbe.await(message->message.path("type").asText().equals("eventActionAck")
                &&message.path("requestId").asText().equals("unauthorized-stop"));
            assertThat(refused.path("accepted").asBoolean()).isFalse();
            assertThat(refused.path("code").asText()).isEqualTo("EVENT_FORBIDDEN");

            guestProbe.send(eventAction(guestEpoch,"raise-hand","RAISE_HAND","","","","",false));
            assertThat(guestProbe.await(message->message.path("type").asText().equals("eventActionAck")
                &&message.path("requestId").asText().equals("raise-hand")).path("accepted").asBoolean()).isTrue();
            var raised=ownerProbe.await(message->message.path("type").asText().equals("eventState")
                &&message.path("raisedHandPlayerIds").toString().contains(guestId));
            assertThat(raised.path("raisedHandPlayerIds").toString()).contains(guestId);

            ownerProbe.send(eventAction(ownerEpoch,"grant-speaker","GRANT_SPEAKER",guestId,"","","",false));
            var granted=guestProbe.await(message->message.path("type").asText().equals("eventState")
                &&message.path("speakerPlayerIds").toString().contains(guestId));
            assertThat(granted.path("speakerPlayerIds").toString()).contains(ownerId,guestId);
            assertThat(granted.path("raisedHandPlayerIds").toString()).doesNotContain(guestId);

            ownerProbe.send(eventAction(ownerEpoch,"revoke-speaker","REVOKE_SPEAKER",guestId,"","","",false));
            var revoked=guestProbe.await(message->message.path("type").asText().equals("eventState")
                &&message.path("speakerPlayerIds").size()==1);
            assertThat(revoked.path("speakerPlayerIds").toString()).contains(ownerId).doesNotContain(guestId);
            ownerProbe.send(eventAction(ownerEpoch,"event-stop","STOP","","","","",false));
            var stopped=guestProbe.await(message->message.path("type").asText().equals("eventState")&&!message.path("active").asBoolean());
            assertThat(stopped.path("speakerPlayerIds")).isEmpty();
            assertThat(stopped.path("raisedHandPlayerIds")).isEmpty();

            guestProbe.send(eventAction(guestEpoch,"late-hand","RAISE_HAND","","","","",false));
            var inactive=guestProbe.await(message->message.path("type").asText().equals("eventActionAck")
                &&message.path("requestId").asText().equals("late-hand"));
            assertThat(inactive.path("accepted").asBoolean()).isFalse();
            assertThat(inactive.path("code").asText()).isEqualTo("EVENT_INACTIVE");
        } finally { ownerProbe.socket.abort();guestProbe.socket.abort(); }
    }

    @Test void liveEventQuestionsAndPollsEnforceAccountRightsAndPersistClosedResults() throws Exception {
        Browser owner=signedIn();
        String attendeeSubject="15151515-1515-4151-8151-151515151515";
        Browser attendee=signedInAs(attendeeSubject);
        Browser attendeeSecondSession=signedInAs(attendeeSubject);
        String attendeeUserId=json.readTree(attendee.get("me").body()).path("userId").asText();
        assertThat(json.readTree(attendeeSecondSession.get("me").body()).path("userId").asText()).isEqualTo(attendeeUserId);
        String space=createSpace(owner,"실시간 Q&A와 투표","PUBLIC",100).path("id").asText();
        Probe ownerProbe=owner.socketWithTicket(ORIGIN,owner.ticket(space));
        Probe attendeeProbe=attendee.socketWithTicket(ORIGIN,attendee.ticket(space));
        Probe attendeeSecondProbe=attendeeSecondSession.socketWithTicket(ORIGIN,attendeeSecondSession.ticket(space));
        try {
            ownerProbe.join("");attendeeProbe.join("");attendeeSecondProbe.join("");
            var ownerWelcome=ownerProbe.await(message->message.path("type").asText().equals("welcome"));
            var attendeeWelcome=attendeeProbe.await(message->message.path("type").asText().equals("welcome"));
            var secondWelcome=attendeeSecondProbe.await(message->message.path("type").asText().equals("welcome"));
            assertThat(secondWelcome.path("playerId").asText()).isNotEqualTo(attendeeWelcome.path("playerId").asText());
            long ownerEpoch=ownerWelcome.path("epoch").asLong();
            long attendeeEpoch=attendeeWelcome.path("epoch").asLong();
            long secondEpoch=secondWelcome.path("epoch").asLong();

            ownerProbe.send(eventAction(ownerEpoch,"engagement-start","START","","학기 전체 발표","Q&A와 투표 권한 검증","",false));
            assertThat(ownerProbe.await(message->message.path("type").asText().equals("eventActionAck")
                &&message.path("requestId").asText().equals("engagement-start")).path("accepted").asBoolean()).isTrue();
            var active=attendeeProbe.await(message->message.path("type").asText().equals("eventState")&&message.path("active").asBoolean());
            String eventId=active.path("eventId").asText();

            attendeeProbe.send(eventEngagement(attendeeEpoch,"question-ask","ASK_QUESTION","","이 발표는 기록되나요?","",List.of(),0));
            var questionAck=attendeeProbe.await(message->message.path("type").asText().equals("eventEngagementAck")
                &&message.path("requestId").asText().equals("question-ask"));
            assertThat(questionAck.path("accepted").asBoolean()).isTrue();
            String questionId=questionAck.path("itemId").asText();
            var submitted=ownerProbe.await(message->message.path("type").asText().equals("eventEngagementState")
                &&message.path("questions").size()==1);
            assertThat(submitted.path("questions").get(0).path("text").asText()).isEqualTo("이 발표는 기록되나요?");

            attendeeSecondProbe.send(eventEngagement(secondEpoch,"question-rate","ASK_QUESTION","","다른 탭에서 질문","",List.of(),0));
            var rateLimited=attendeeSecondProbe.await(message->message.path("type").asText().equals("eventEngagementAck")
                &&message.path("requestId").asText().equals("question-rate"));
            assertThat(rateLimited.path("accepted").asBoolean()).isFalse();
            assertThat(rateLimited.path("code").asText()).isEqualTo("QUESTION_RATE");

            attendeeProbe.send(eventEngagement(attendeeEpoch,"answer-forbidden","ANSWER_QUESTION",questionId,"참가자 답변 시도","",List.of(),0));
            var answerRefused=attendeeProbe.await(message->message.path("type").asText().equals("eventEngagementAck")
                &&message.path("requestId").asText().equals("answer-forbidden"));
            assertThat(answerRefused.path("accepted").asBoolean()).isFalse();
            assertThat(answerRefused.path("code").asText()).isEqualTo("EVENT_FORBIDDEN");
            ownerProbe.send(eventEngagement(ownerEpoch,"answer-allowed","ANSWER_QUESTION",questionId,"네, 행사 결과에 저장됩니다.","",List.of(),0));
            assertThat(ownerProbe.await(message->message.path("type").asText().equals("eventEngagementAck")
                &&message.path("requestId").asText().equals("answer-allowed")).path("accepted").asBoolean()).isTrue();
            var answered=attendeeProbe.await(message->message.path("type").asText().equals("eventEngagementState")
                &&message.path("questions").size()==1&&message.path("questions").get(0).path("answered").asBoolean());
            assertThat(answered.path("questions").get(0).path("answer").asText()).isEqualTo("네, 행사 결과에 저장됩니다.");

            attendeeProbe.send(eventEngagement(attendeeEpoch,"poll-forbidden","CREATE_POLL","","","어떤 방식으로 참여하나요?",List.of("질문", "투표"),0));
            var pollRefused=attendeeProbe.await(message->message.path("type").asText().equals("eventEngagementAck")
                &&message.path("requestId").asText().equals("poll-forbidden"));
            assertThat(pollRefused.path("accepted").asBoolean()).isFalse();
            assertThat(pollRefused.path("code").asText()).isEqualTo("EVENT_FORBIDDEN");
            ownerProbe.send(eventEngagement(ownerEpoch,"poll-create","CREATE_POLL","","","어떤 방식으로 참여하나요?",List.of("질문", "투표"),0));
            var pollCreated=ownerProbe.await(message->message.path("type").asText().equals("eventEngagementAck")
                &&message.path("requestId").asText().equals("poll-create"));
            assertThat(pollCreated.path("accepted").asBoolean()).isTrue();
            String pollId=pollCreated.path("itemId").asText();
            attendeeProbe.await(message->message.path("type").asText().equals("eventEngagementState")
                &&message.path("pollId").asText().equals(pollId));

            attendeeProbe.send(eventEngagement(attendeeEpoch,"vote-first","VOTE_POLL","","","",List.of(),1));
            assertThat(attendeeProbe.await(message->message.path("type").asText().equals("eventEngagementAck")
                &&message.path("requestId").asText().equals("vote-first")).path("accepted").asBoolean()).isTrue();
            var oneVote=ownerProbe.await(message->message.path("type").asText().equals("eventEngagementState")
                &&message.path("pollId").asText().equals(pollId)&&message.path("pollCounts").get(1).asInt()==1);
            assertThat(oneVote.path("pollCounts").get(0).asInt()).isZero();

            attendeeSecondProbe.send(eventEngagement(secondEpoch,"vote-second-session","VOTE_POLL","","","",List.of(),0));
            var duplicateVote=attendeeSecondProbe.await(message->message.path("type").asText().equals("eventEngagementAck")
                &&message.path("requestId").asText().equals("vote-second-session"));
            assertThat(duplicateVote.path("accepted").asBoolean()).isFalse();
            assertThat(duplicateVote.path("code").asText()).isEqualTo("POLL_DUPLICATE");

            ownerProbe.send(eventEngagement(ownerEpoch,"poll-close","CLOSE_POLL","","","",List.of(),0));
            assertThat(ownerProbe.await(message->message.path("type").asText().equals("eventEngagementAck")
                &&message.path("requestId").asText().equals("poll-close")).path("accepted").asBoolean()).isTrue();

            ownerProbe.send(eventEngagement(ownerEpoch,"quiz-create","CREATE_QUIZ","","","캠퍼스 정답 찾기",
                List.of("런던","서울"),0,1));
            var quizCreated=ownerProbe.await(message->message.path("type").asText().equals("eventEngagementAck")
                &&message.path("requestId").asText().equals("quiz-create"));
            assertThat(quizCreated.path("accepted").asBoolean()).as(quizCreated.toPrettyString()).isTrue();
            String quizId=quizCreated.path("itemId").asText();
            attendeeProbe.await(message->message.path("type").asText().equals("eventEngagementState")
                &&message.path("pollId").asText().equals(quizId)&&message.path("pollMode").asText().equals("QUIZ"));
            attendeeProbe.send(eventEngagement(attendeeEpoch,"quiz-answer","VOTE_POLL","","","",List.of(),1));
            assertThat(attendeeProbe.await(message->message.path("type").asText().equals("eventEngagementAck")
                &&message.path("requestId").asText().equals("quiz-answer")).path("accepted").asBoolean()).isTrue();
            attendeeSecondProbe.send(eventEngagement(secondEpoch,"quiz-duplicate","VOTE_POLL","","","",List.of(),0));
            var quizDuplicate=attendeeSecondProbe.await(message->message.path("type").asText().equals("eventEngagementAck")
                &&message.path("requestId").asText().equals("quiz-duplicate"));
            assertThat(quizDuplicate.path("accepted").asBoolean()).isFalse();
            assertThat(quizDuplicate.path("code").asText()).isEqualTo("POLL_DUPLICATE");
            ownerProbe.send(eventEngagement(ownerEpoch,"quiz-close","CLOSE_POLL","","","",List.of(),0));
            assertThat(ownerProbe.await(message->message.path("type").asText().equals("eventEngagementAck")
                &&message.path("requestId").asText().equals("quiz-close")).path("accepted").asBoolean()).isTrue();
            var quizResults=attendeeProbe.await(message->message.path("type").asText().equals("eventEngagementState")
                &&message.path("pollId").asText().equals(quizId)&&message.path("pollClosed").asBoolean());
            assertThat(quizResults.path("pollCorrectOptionIndex").asInt()).isEqualTo(1);
            assertThat(quizResults.path("myQuizScore").asInt()).isEqualTo(1);

            ownerProbe.send(eventAction(ownerEpoch,"engagement-stop","STOP","","","","",false));
            assertThat(ownerProbe.await(message->message.path("type").asText().equals("eventActionAck")
                &&message.path("requestId").asText().equals("engagement-stop")).path("accepted").asBoolean()).isTrue();
            var stopped=attendeeProbe.await(message->message.path("type").asText().equals("eventState")&&!message.path("active").asBoolean());
            assertThat(stopped.path("eventId").asText()).isEqualTo(eventId);
            attendeeProbe.send(eventEngagement(attendeeEpoch,"after-stop-vote","VOTE_POLL","","","",List.of(),1));
            var afterStop=attendeeProbe.await(message->message.path("type").asText().equals("eventEngagementAck")
                &&message.path("requestId").asText().equals("after-stop-vote"));
            assertThat(afterStop.path("accepted").asBoolean()).isFalse();
            assertThat(afterStop.path("code").asText()).isEqualTo("EVENT_INACTIVE");

            long persistedBy=System.nanoTime()+TimeUnit.SECONDS.toNanos(8);
            Integer finalized=0;
            while(System.nanoTime()<persistedBy&&finalized==0) {
                finalized=db.queryForObject("""
                    SELECT COUNT(*) FROM town_event e
                    WHERE e.id=? AND e.ended_at IS NOT NULL
                      AND EXISTS(SELECT 1 FROM town_event_question q WHERE q.id=? AND q.answered=TRUE AND q.answer=?)
                      AND EXISTS(SELECT 1 FROM town_event_poll p WHERE p.id=? AND p.closed=TRUE)
                      AND EXISTS(SELECT 1 FROM town_event_poll_vote v WHERE v.poll_id=? AND v.user_id=? AND v.option_index=1)
                      AND (SELECT vote_count FROM town_event_poll_option WHERE poll_id=? AND option_index=1)=1
                      AND EXISTS(SELECT 1 FROM town_event_poll_vote v WHERE v.poll_id=? AND v.user_id=?
                          AND v.option_index=1 AND v.is_correct=TRUE AND v.points_awarded=1)
                      AND (SELECT vote_count FROM town_event_poll_option WHERE poll_id=? AND option_index=1)=1
                    """,Integer.class,eventId,questionId,"네, 행사 결과에 저장됩니다.",pollId,pollId,attendeeUserId,pollId,
                    quizId,attendeeUserId,quizId);
                if(finalized==0)Thread.sleep(100);
            }
            assertThat(finalized).isEqualTo(1);
            var results=ok(owner.get("/spaces/"+space+"/events/"+eventId+"/results"));
            assertThat(results.path("questions").get(0).path("answered").asBoolean()).isTrue();
            assertThat(results.path("polls").get(0).path("closed").asBoolean()).isTrue();
            assertThat(results.path("polls").get(0).path("options").get(1).path("voteCount").asInt()).isEqualTo(1);
            JsonNode quizReport=null;
            for(JsonNode poll:results.path("polls"))if(poll.path("id").asText().equals(quizId))quizReport=poll;
            assertThat(quizReport).isNotNull();
            assertThat(quizReport.path("kind").asText()).isEqualTo("QUIZ");
            assertThat(quizReport.path("correctOptionIndex").asInt()).isEqualTo(1);
            assertThat(results.path("quizScores").get(0).path("score").asInt()).isEqualTo(1);
            assertThat(attendee.get("/spaces/"+space+"/events/"+eventId+"/results").statusCode()).isEqualTo(403);
            transport.server().verify();
        } finally { ownerProbe.socket.abort();attendeeProbe.socket.abort();attendeeSecondProbe.socket.abort(); }
    }

    @Test void eventAttendanceGroupsAccountSessionsHonorsOptOutAndExportsFormulaSafeCsv() throws Exception {
        Browser owner=signedIn();
        String attendeeSubject="16161616-1616-4161-8161-161616161616";
        Browser attendee=signedInAs(attendeeSubject);
        Browser attendeeSecondSession=signedInAs(attendeeSubject);
        String ownerUserId=json.readTree(owner.get("me").body()).path("userId").asText();
        String attendeeUserId=json.readTree(attendee.get("me").body()).path("userId").asText();
        assertThat(json.readTree(attendeeSecondSession.get("me").body()).path("userId").asText()).isEqualTo(attendeeUserId);
        assertThat(owner.patch("profile",Map.of("displayName","=1+1","avatar",0)).statusCode()).isEqualTo(200);
        String space=createSpace(owner,"출석 집계 검증","PUBLIC",100).path("id").asText();
        Probe ownerProbe=owner.socketWithTicket(ORIGIN,owner.ticket(space));
        Probe attendeeProbe=attendee.socketWithTicket(ORIGIN,attendee.ticket(space));
        Probe attendeeSecondProbe=attendeeSecondSession.socketWithTicket(ORIGIN,attendeeSecondSession.ticket(space));
        try {
            ownerProbe.join("");attendeeProbe.join("");attendeeSecondProbe.join("");
            var ownerWelcome=ownerProbe.await(message->message.path("type").asText().equals("welcome"));
            var attendeeWelcome=attendeeProbe.await(message->message.path("type").asText().equals("welcome"));
            var attendeeSecondWelcome=attendeeSecondProbe.await(message->message.path("type").asText().equals("welcome"));
            long ownerEpoch=ownerWelcome.path("epoch").asLong();
            long attendeeEpoch=attendeeWelcome.path("epoch").asLong();
            String ownerPlayerId=ownerWelcome.path("playerId").asText();
            ownerProbe.await(message->message.path("type").asText().equals("snapshot")
                &&java.util.stream.StreamSupport.stream(message.path("players").spliterator(),false)
                    .anyMatch(player->player.path("id").asText().equals(ownerPlayerId)&&player.path("eventManager").asBoolean()));

            ownerProbe.send(eventAction(ownerEpoch,"attendance-start","START","","출석 기록 행사","동일 계정 중복 탭 집계","",true));
            var attendanceStart=ownerProbe.await(message->message.path("type").asText().equals("eventActionAck")
                &&message.path("requestId").asText().equals("attendance-start"));
            assertThat(attendanceStart.path("accepted").asBoolean()).as(attendanceStart.toString()).isTrue();
            var active=attendeeProbe.await(message->message.path("type").asText().equals("eventState")&&message.path("active").asBoolean());
            String eventId=active.path("eventId").asText();
            String resultsPath="/spaces/"+space+"/events/"+eventId+"/results";
            JsonNode report=null;
            long deadline=System.nanoTime()+TimeUnit.SECONDS.toNanos(8);
            while(System.nanoTime()<deadline) {
                var response=owner.get(resultsPath);
                if(response.statusCode()==200) {
                    report=json.readTree(response.body());
                    if(report.path("event").path("attendeeCount").asInt()==2&&report.path("attendance").size()==2)break;
                }
                Thread.sleep(100);
            }
            assertThat(report).isNotNull();
            assertThat(report.path("event").path("attendeeCount").asInt()).isEqualTo(2);
            assertThat(report.path("attendance")).hasSize(2);
            JsonNode attendeeRow=null,ownerRow=null;
            for(JsonNode row:report.path("attendance")) {
                if(row.path("userId").asText().equals(attendeeUserId))attendeeRow=row;
                if(row.path("userId").asText().equals(ownerUserId))ownerRow=row;
            }
            assertThat(attendeeRow).isNotNull();
            assertThat(attendeeRow.path("sessionCount").asInt()).isEqualTo(2);
            assertThat(attendeeRow.path("displayName").asText()).isEqualTo("HUFS 친구");
            assertThat(ownerRow).isNotNull();
            assertThat(ownerRow.path("displayName").asText()).isEqualTo("=1+1");

            var csv=owner.getBytes("/spaces/"+space+"/events/"+eventId+"/attendance.csv");
            assertThat(csv.statusCode()).isEqualTo(200);
            String csvText=new String(csv.body(),java.nio.charset.StandardCharsets.UTF_8);
            assertThat(csvText).startsWith("\uFEFFparticipantId,displayName,userId");
            assertThat(csvText).contains("\"'=1+1\"");
            assertThat(csvText.split("\\R")).hasSize(3);
            assertThat(attendee.get(resultsPath).statusCode()).isEqualTo(403);
            assertThat(attendee.getBytes("/spaces/"+space+"/events/"+eventId+"/attendance.csv").statusCode()).isEqualTo(403);

            ownerProbe.send(eventAction(ownerEpoch,"attendance-stop","STOP","","","","",false));
            assertThat(ownerProbe.await(message->message.path("type").asText().equals("eventActionAck")
                &&message.path("requestId").asText().equals("attendance-stop")).path("accepted").asBoolean()).isTrue();
            ownerProbe.send(eventAction(ownerEpoch,"private-start","START","","출석 미사용 행사","개별 출석은 저장하지 않음","",false));
            assertThat(ownerProbe.await(message->message.path("type").asText().equals("eventActionAck")
                &&message.path("requestId").asText().equals("private-start")).path("accepted").asBoolean()).isTrue();
            var privateEvent=attendeeProbe.await(message->message.path("type").asText().equals("eventState")&&message.path("active").asBoolean()
                &&!message.path("eventId").asText().equals(eventId));
            String privateEventId=privateEvent.path("eventId").asText();
            JsonNode privateReport=null;
            long noAttendanceDeadline=System.nanoTime()+TimeUnit.SECONDS.toNanos(8);
            while(System.nanoTime()<noAttendanceDeadline) {
                var response=owner.get("/spaces/"+space+"/events/"+privateEventId+"/results");
                if(response.statusCode()==200) { privateReport=json.readTree(response.body()); break; }
                Thread.sleep(100);
            }
            assertThat(privateReport).isNotNull();
            assertThat(privateReport.path("event").path("attendeeCount").asInt()).isZero();
            assertThat(privateReport.path("attendance")).isEmpty();
            assertThat(db.queryForObject("SELECT COUNT(*) FROM town_event_attendance WHERE event_id=?",Integer.class,privateEventId)).isZero();
            ownerProbe.send(eventAction(ownerEpoch,"private-stop","STOP","","","","",false));
            ownerProbe.await(message->message.path("type").asText().equals("eventActionAck")
                &&message.path("requestId").asText().equals("private-stop"));
            transport.server().verify();
        } finally { ownerProbe.socket.abort();attendeeProbe.socket.abort();attendeeSecondProbe.socket.abort(); }
    }

    @Test void eventResultRetentionDeletesExpiredRecordsAndTheirPersonalData() throws Exception {
        Browser owner=signedIn();
        String space=createSpace(owner,"행사 결과 보존","PRIVATE",20).path("id").asText();
        String userId=json.readTree(owner.get("me").body()).path("userId").asText();
        Instant now=Instant.now();
        String expiredEvent=UUID.randomUUID().toString(),recentEvent=UUID.randomUUID().toString(),activeEvent=UUID.randomUUID().toString();
        String questionId=UUID.randomUUID().toString(),pollId=UUID.randomUUID().toString(),playerId=UUID.randomUUID().toString();
        Timestamp expiredStart=Timestamp.from(now.minus(java.time.Duration.ofDays(182)));
        Timestamp expiredEnd=Timestamp.from(now.minus(java.time.Duration.ofDays(181)));
        Timestamp recentStart=Timestamp.from(now.minus(java.time.Duration.ofDays(180)));
        Timestamp recentEnd=Timestamp.from(now.minus(java.time.Duration.ofDays(179)));
        db.update("INSERT INTO town_event(id,space_id,host_user_id,title,started_at,ended_at) VALUES (?,?,?,?,?,?)",
            expiredEvent,space,userId,"만료 행사",expiredStart,expiredEnd);
        db.update("INSERT INTO town_event(id,space_id,host_user_id,title,started_at,ended_at) VALUES (?,?,?,?,?,?)",
            recentEvent,space,userId,"보존 행사",recentStart,recentEnd);
        db.update("INSERT INTO town_event(id,space_id,host_user_id,title,started_at) VALUES (?,?,?,?,?)",
            activeEvent,space,userId,"진행 행사",expiredStart);
        db.update("INSERT INTO town_event_question(id,event_id,asker_user_id,asker_name,body) VALUES (?,?,?,?,?)",
            questionId,expiredEvent,userId,"테스터","삭제될 질문");
        db.update("INSERT INTO town_event_poll(id,event_id,question) VALUES (?,?,?)",pollId,expiredEvent,"삭제될 투표");
        db.update("INSERT INTO town_event_poll_option(poll_id,option_index,label,vote_count) VALUES (?,0,'예',1)",pollId);
        db.update("INSERT INTO town_event_poll_vote(poll_id,user_id,participant_type,participant_id,option_index) "
            + "VALUES (?,?,'USER',?,0)",pollId,userId,userId);
        db.update("INSERT INTO town_event_attendance(event_id,player_id,user_id,display_name) VALUES (?,?,?,?)",
            expiredEvent,playerId,userId,"테스터");

        assertThat(eventResultsRetention.purgeBefore(now.minus(java.time.Duration.ofDays(EventResultsRetention.RETENTION_DAYS))))
            .isEqualTo(1);
        assertThat(db.queryForObject("SELECT COUNT(*) FROM town_event WHERE id=?",Integer.class,expiredEvent)).isZero();
        assertThat(db.queryForObject("SELECT COUNT(*) FROM town_event_question WHERE id=?",Integer.class,questionId)).isZero();
        assertThat(db.queryForObject("SELECT COUNT(*) FROM town_event_poll WHERE id=?",Integer.class,pollId)).isZero();
        assertThat(db.queryForObject("SELECT COUNT(*) FROM town_event_poll_vote WHERE poll_id=?",Integer.class,pollId)).isZero();
        assertThat(db.queryForObject("SELECT COUNT(*) FROM town_event_attendance WHERE event_id=?",Integer.class,expiredEvent)).isZero();
        assertThat(db.queryForObject("SELECT COUNT(*) FROM town_event WHERE id=?",Integer.class,recentEvent)).isEqualTo(1);
        assertThat(db.queryForObject("SELECT COUNT(*) FROM town_event WHERE id=? AND ended_at IS NULL",Integer.class,activeEvent)).isEqualTo(1);
        transport.server().verify();
    }

    private String eventAction(long epoch,String requestId,String action,String targetPlayerId,String title,
                               String description,String resourceUrl,boolean attendanceEnabled) throws Exception {
        return json.writeValueAsString(Map.of("type","eventAction","epoch",epoch,"requestId",requestId,"action",action,
            "targetPlayerId",targetPlayerId,"title",title,"description",description,"resourceUrl",resourceUrl,
            "attendanceEnabled",attendanceEnabled));
    }

    private String eventEngagement(long epoch,String requestId,String action,String questionId,String text,
                                   String pollQuestion,List<String> pollOptions,long optionIndex) throws Exception {
        return eventEngagement(epoch,requestId,action,questionId,text,pollQuestion,pollOptions,optionIndex,0);
    }

    private String eventEngagement(long epoch,String requestId,String action,String questionId,String text,
                                   String pollQuestion,List<String> pollOptions,long optionIndex,
                                   long correctOptionIndex) throws Exception {
        return json.writeValueAsString(Map.of("type","eventEngagement","epoch",epoch,"requestId",requestId,"action",action,
            "questionId",questionId,"text",text,"pollQuestion",pollQuestion,"pollOptions",pollOptions,
            "optionIndex",optionIndex,"correctOptionIndex",correctOptionIndex));
    }

    @Test void publishingKeepsImmutableHistoryAndUpdatesConnectedWorldSafely() throws Exception {
        var owner=signedIn();String space=createSpace(owner,"라이브 맵","PRIVATE",10).path("id").asText();String root="/spaces/"+space+"/map";
        String client=UUID.randomUUID().toString();var lease=ok(owner.post(root+"/lease",Map.of("clientId",client,"takeover",false)));var credentials=credentials(lease,client);
        var initial=lease.path("editor").path("map");String initialRevision=initial.path("revision").asText();
        Probe peer=owner.socketWithTicket(ORIGIN,owner.ticket(space));
        try {
            peer.join("");var welcome=peer.await(n->n.path("type").asText().equals("welcome"));long epoch=welcome.path("epoch").asLong();
            var changed=(com.fasterxml.jackson.databind.node.ObjectNode)initial.deepCopy();changed.put("name","게시한 오피스");changed.put("spawnX",24);changed.put("spawnY",31);
            ((com.fasterxml.jackson.databind.node.ArrayNode)changed.path("walls")).add(json.valueToTree(Map.of("id","new-wall","material","CREAM","bounds",Map.of("x",23,"y",29,"width",2,"height",1))));
            var saved=ok(owner.post(root+"/draft",Map.of("lease",credentials,"baseVersion",1,"operationId",UUID.randomUUID().toString(),"map",changed)));
            assertThat(saved.path("issues")).isEmpty();assertThat(ok(owner.get(root)).path("revision").asText()).isEqualTo(initialRevision);
            var published=ok(owner.post(root+"/publish",Map.of("lease",credentials,"baseVersion",2)));String revision=published.path("publishedRevision").asText();
            var event=peer.await(n->n.path("type").asText().equals("mapChanged")&&n.path("map").path("revision").asText().equals(revision));assertThat(event.path("map").path("name").asText()).isEqualTo("게시한 오피스");
            assertThat(peer.await(n->n.path("type").asText().equals("welcome")).path("epoch").asLong()).isGreaterThan(epoch);
            var snap=peer.await(n->n.path("type").asText().equals("snapshot")&&n.path("mapRevision").asText().equals(revision));
            assertThat(snap.path("players").get(0).path("y").asDouble()).isEqualTo(31);
            assertThat(db.queryForObject("SELECT document FROM map_revision WHERE id=?",String.class,initialRevision))
                .contains("GDG HUFS 훕스타운")
                .doesNotContain("HUFS 오피스", "MEETING · 01", "WELCOME TO HUFS", "게시한 오피스");
            var restored=ok(owner.post(root+"/restore",Map.of("lease",credentials,"baseVersion",3,"revisionId",initialRevision)));
            assertThat(restored.path("map").path("name").asText()).isEqualTo("GDG HUFS 훕스타운");
            assertThat(restored.path("publishedRevision").asText()).isNotEqualTo(initialRevision).isNotEqualTo(revision);
            var history=ok(owner.get(root+"/history"));assertThat(history.size()).isEqualTo(3);assertThat(history.get(0).path("reason").asText()).isEqualTo("ROLLBACK");
            var cache=new town.hufs.auth.PublishedMaps(strings);cache.publish(space,1,initial.toString());
            assertThat(cache.read(space).sequence()).isEqualTo(3);
            strings.delete("hufs-town:published-map:"+space);db.update("UPDATE map_outbox SET delivered=FALSE WHERE space_id=?",space);
            long until=System.nanoTime()+TimeUnit.SECONDS.toNanos(5);
            while(System.nanoTime()<until&&(cache.read(space)==null||cache.read(space).sequence()!=3))Thread.sleep(100);
            assertThat(cache.read(space).map().revision()).isEqualTo(restored.path("publishedRevision").asText());
        } finally {peer.socket.abort();}
    }

    @Test void rollbackRejectsRevisionFromAnotherMapWithoutChangingDraftOrPublication() throws Exception {
        Browser owner=signedIn();
        String firstSpace=createSpace(owner,"복구 원본 공간","PRIVATE",10).path("id").asText();
        String otherSpace=createSpace(owner,"복구 참조 공간","PRIVATE",10).path("id").asText();
        String firstMap="/spaces/"+firstSpace+"/maps/"+firstSpace;
        String otherMap="/spaces/"+otherSpace+"/maps/"+otherSpace;
        String published=ok(owner.get(firstMap+"/history")).get(0).path("id").asText();
        String foreignRevision=ok(owner.get(otherMap+"/history")).get(0).path("id").asText();
        String client=UUID.randomUUID().toString();
        var lease=ok(owner.post(firstMap+"/lease",Map.of("clientId",client,"takeover",false)));
        var credentials=credentials(lease,client);
        var draft=(com.fasterxml.jackson.databind.node.ObjectNode)lease.path("editor").path("map").deepCopy();
        draft.put("name","보존되어야 하는 초안");
        ok(owner.post(firstMap+"/draft",Map.of("lease",credentials,"baseVersion",1,"operationId",UUID.randomUUID().toString(),"map",draft)));

        assertThat(owner.post(firstMap+"/restore",Map.of("lease",credentials,"baseVersion",2,"revisionId",foreignRevision)).statusCode()).isEqualTo(404);
        var current=ok(owner.get(firstMap+"/editor"));
        assertThat(current.path("version").asLong()).isEqualTo(2);
        assertThat(current.path("map").path("name").asText()).isEqualTo("보존되어야 하는 초안");
        assertThat(current.path("publishedRevision").asText()).isEqualTo(published);
        assertThat(ok(owner.get(firstMap+"/history"))).hasSize(1);
        assertThat(ok(owner.get(firstMap+"/published")).path("revision").asText()).isEqualTo(published);
    }

    @Test void selectedSpaceTemplatesSeedPublishedMapsThatCanBeEntered() throws Exception {
        Browser owner=signedIn();
        var templates=Map.of("CAMPUS_SQUARE","캠퍼스 광장","STUDY_SPACE","스터디 라운지","MEETUP_HALL","GDG 밋업 홀");
        for(var entry:templates.entrySet()) {
            String templateId=entry.getKey(),expectedName=entry.getValue();
            var space=ok(owner.post("/spaces",Map.of("name",expectedName+" 검증","description","템플릿 통합 검증","visibility","PRIVATE","capacity",100,"templateId",templateId)));
            String spaceId=space.path("id").asText();
            assertThat(space.path("templateId").asText()).isEqualTo(templateId);
            String mapsRoot="/spaces/"+spaceId+"/maps";
            var catalog=ok(owner.get(mapsRoot));
            assertThat(catalog).hasSize(1);
            assertThat(catalog.get(0).path("mapId").asText()).isEqualTo(spaceId);
            assertThat(catalog.get(0).path("entry").asBoolean()).isTrue();
            String revision=catalog.get(0).path("publishedRevision").asText();
            var published=ok(owner.get(mapsRoot+"/"+spaceId+"/published"));
            var expected=MapLoader.template(templateId);
            assertThat(published.path("revision").asText()).isEqualTo(revision);
            assertThat(published.path("name").asText()).isEqualTo(expectedName);
            assertThat(published.path("width").asInt()).isEqualTo(expected.width());
            assertThat(published.path("height").asInt()).isEqualTo(expected.height());
            assertThat(published.path("floors").size()).isEqualTo(expected.floors().size());
            assertThat(published.path("objects").size()).isEqualTo(expected.objects().size());
            assertThat(published.path("zones").size()).isEqualTo(expected.zones().size());

            Probe world=owner.socketWithTicket(ORIGIN,owner.ticket(spaceId));
            try {
                world.join("");
                assertThat(world.await(message->message.path("type").asText().equals("welcome")).path("mapRevision").asText()).isEqualTo(revision);
                var snapshot=world.await(message->message.path("type").asText().equals("snapshot")&&message.path("mapRevision").asText().equals(revision));
                assertThat(snapshot.path("players")).hasSize(1);
                assertThat(snapshot.path("players").get(0).path("x").asDouble()).isEqualTo(expected.spawnX());
                assertThat(snapshot.path("players").get(0).path("y").asDouble()).isEqualTo(expected.spawnY());
            } finally { world.socket.abort(); }
        }
    }

    @Test void publishedMapWaitsForEveryActiveWorldNodeAcknowledgement() throws Exception {
        Browser owner=signedIn();Browser guest=signedIn();String space=createSpace(owner,"다중 월드 게시 확인","PUBLIC",10).path("id").asText();
        String root="/spaces/"+space+"/maps/"+space;String clientId=UUID.randomUUID().toString();
        var lease=ok(owner.post(root+"/lease",Map.of("clientId",clientId,"takeover",false)));
        var credentials=credentials(lease,clientId);var map=(com.fasterxml.jackson.databind.node.ObjectNode)lease.path("editor").path("map").deepCopy();
        try(AdditionalWorld secondWorld=startAdditionalWorld()) {
            Probe first=owner.socketWithTicket(ORIGIN,owner.ticket(space));
            Probe second=guest.socketWithTicket(ORIGIN,guest.ticket(space),secondWorld.port());
            try {
                first.join("");second.join("");
                first.await(n->n.path("type").asText().equals("welcome"));
                second.await(n->n.path("type").asText().equals("welcome"));
                long heartbeatDeadline=System.nanoTime()+TimeUnit.SECONDS.toNanos(10);
                int activeNodes=0;
                while(System.nanoTime()<heartbeatDeadline) {
                    activeNodes=db.queryForObject("SELECT COUNT(*) FROM world_map_node_map WHERE space_id=? AND map_id=? AND active=TRUE AND last_seen_at>=DATE_SUB(CURRENT_TIMESTAMP(6),INTERVAL 10 SECOND)",Integer.class,space,space);
                    if(activeNodes>=2)break;
                    Thread.sleep(100);
                }
                assertThat(activeNodes).as("both packaged world processes publish their active map heartbeat").isEqualTo(2);
                map.put("name","두 월드에 반영된 맵");map.put("spawnX",24);map.put("spawnY",31);
                var saved=ok(owner.post(root+"/draft",Map.of("lease",credentials,"baseVersion",1,"operationId",UUID.randomUUID().toString(),"map",map)));
                assertThat(saved.path("issues")).isEmpty();
                var published=ok(owner.post(root+"/publish",Map.of("lease",credentials,"baseVersion",2)));
                String revision=published.path("publishedRevision").asText();
                assertThat(published.path("publication").path("targetNodes").asInt()).isEqualTo(2);
                first.await(n->n.path("type").asText().equals("mapChanged")&&n.path("map").path("revision").asText().equals(revision));
                second.await(n->n.path("type").asText().equals("mapChanged")&&n.path("map").path("revision").asText().equals(revision));
                long ackDeadline=System.nanoTime()+TimeUnit.SECONDS.toNanos(10);
                JsonNode status=null;
                while(System.nanoTime()<ackDeadline) {
                    status=ok(owner.get(root+"/publication/"+revision));
                    if(status.path("state").asText().equals("APPLIED"))break;
                    Thread.sleep(150);
                }
                assertThat(status).isNotNull();
                assertThat(status.path("state").asText()).isEqualTo("APPLIED");
                assertThat(status.path("targetNodes").asInt()).isEqualTo(2);
                assertThat(status.path("appliedNodes").asInt()).isEqualTo(2);
                assertThat(status.path("pendingNodes").asInt()).isZero();
                assertThat(status.path("offlineNodes").asInt()).isZero();
            } finally { first.socket.abort();second.socket.abort(); }
        }
    }

    @Test void forceStoppingWorldBeforeMediaRevocationAckReportsOfflineTarget() throws Exception {
        Browser owner=signedIn();Browser guest=signedIn();String space=createSpace(owner,"종료 노드 게시 처리","PUBLIC",10).path("id").asText();
        String root="/spaces/"+space+"/maps/"+space;String clientId=UUID.randomUUID().toString();
        var lease=ok(owner.post(root+"/lease",Map.of("clientId",clientId,"takeover",false)));
        var credentials=credentials(lease,clientId);var map=(com.fasterxml.jackson.databind.node.ObjectNode)lease.path("editor").path("map").deepCopy();
        String controlToken="hufs-town-integration-media-control-token-01";
        try(DelayedMediaControl mediaControl=startDelayedMediaControl();AdditionalWorld secondWorld=startAdditionalWorld(mediaControl.endpoint(),controlToken)) {
            Probe first=owner.socketWithTicket(ORIGIN,owner.ticket(space));
            Probe second=guest.socketWithTicket(ORIGIN,guest.ticket(space),secondWorld.port());
            try {
                first.join("");second.join("");
                first.await(n->n.path("type").asText().equals("welcome"));
                second.await(n->n.path("type").asText().equals("welcome"));
                long heartbeatDeadline=System.nanoTime()+TimeUnit.SECONDS.toNanos(10);
                int activeNodes=0;
                while(System.nanoTime()<heartbeatDeadline) {
                    activeNodes=db.queryForObject("SELECT COUNT(*) FROM world_map_node_map WHERE space_id=? AND map_id=? AND active=TRUE AND last_seen_at>=DATE_SUB(CURRENT_TIMESTAMP(6),INTERVAL 10 SECOND)",Integer.class,space,space);
                    if(activeNodes>=2)break;
                    Thread.sleep(100);
                }
                assertThat(activeNodes).isEqualTo(2);
                map.put("name","나머지 월드에 적용된 맵");
                var saved=ok(owner.post(root+"/draft",Map.of("lease",credentials,"baseVersion",1,"operationId",UUID.randomUUID().toString(),"map",map)));
                assertThat(saved.path("issues")).isEmpty();
                var published=ok(owner.post(root+"/publish",Map.of("lease",credentials,"baseVersion",2)));
                String revision=published.path("publishedRevision").asText();
                assertThat(published.path("publication").path("targetNodes").asInt()).isEqualTo(2);
                assertThat(mediaControl.revokeEntered().await(8,TimeUnit.SECONDS)).isTrue();
                second.await(n->n.path("type").asText().equals("mediaState")&&n.path("transitioning").asBoolean());

                secondWorld.close();
                assertThat(secondWorld.process().isAlive()).isFalse();
                first.await(n->n.path("type").asText().equals("mapChanged")&&n.path("map").path("revision").asText().equals(revision));
                long statusDeadline=System.nanoTime()+TimeUnit.SECONDS.toNanos(20);
                JsonNode status=null;
                while(System.nanoTime()<statusDeadline) {
                    status=ok(owner.get(root+"/publication/"+revision));
                    if(status.path("appliedNodes").asInt()==1&&status.path("offlineNodes").asInt()==1)break;
                    Thread.sleep(150);
                }
                assertThat(status.path("state").asText()).isEqualTo("DEGRADED");
                assertThat(status.path("targetNodes").asInt()).isEqualTo(2);
                assertThat(status.path("appliedNodes").asInt()).isEqualTo(1);
                assertThat(status.path("pendingNodes").asInt()).isZero();
                assertThat(status.path("offlineNodes").asInt()).isEqualTo(1);
                assertThat(db.queryForObject("SELECT COUNT(*) FROM world_map_node_map WHERE space_id=? AND map_id=? AND active=TRUE",Integer.class,space,space)).isEqualTo(1);
            } finally {first.socket.abort();second.socket.abort();}
        }
    }

    @Test void mapOutboxRetriesRedisAndTargetWriteFailuresWithoutReportingFalseSuccess() throws Exception {
        Browser owner=signedIn();String space=createSpace(owner,"게시 재시도","PUBLIC",10).path("id").asText();
        String root="/spaces/"+space+"/maps/"+space;String clientId=UUID.randomUUID().toString();
        var lease=ok(owner.post(root+"/lease",Map.of("clientId",clientId,"takeover",false)));
        var credentials=credentials(lease,clientId);var map=(com.fasterxml.jackson.databind.node.ObjectNode)lease.path("editor").path("map").deepCopy();
        Probe peer=owner.socketWithTicket(ORIGIN,owner.ticket(space));
        var failCacheWrites=new java.util.concurrent.atomic.AtomicBoolean(false);
        var failTargetWrites=new java.util.concurrent.atomic.AtomicBoolean(false);
        var targetWriteFailures=new java.util.concurrent.atomic.AtomicInteger();
        doAnswer(invocation->{
            if(failCacheWrites.get())throw new org.springframework.data.redis.RedisConnectionFailureException("Injected map cache outage",new java.io.IOException("test fault"));
            return invocation.callRealMethod();
        }).when(publishedMaps).publish(anyString(),anyString(),anyLong(),anyString());
        doAnswer(invocation->{
            String sql=invocation.getArgument(0);
            if(failTargetWrites.get()&&sql.contains("INSERT INTO map_outbox_node_target")) {
                targetWriteFailures.incrementAndGet();
                throw new org.springframework.dao.DataAccessResourceFailureException("Injected outbox target write outage",new java.io.IOException("test fault"));
            }
            return invocation.callRealMethod();
        }).when(db).update(anyString(),any(Object[].class));
        try {
            peer.join("");peer.await(n->n.path("type").asText().equals("welcome"));
            long heartbeatDeadline=System.nanoTime()+TimeUnit.SECONDS.toNanos(8);
            while(System.nanoTime()<heartbeatDeadline&&db.queryForObject("SELECT COUNT(*) FROM world_map_node_map WHERE space_id=? AND map_id=? AND active=TRUE AND last_seen_at>=DATE_SUB(CURRENT_TIMESTAMP(6),INTERVAL 10 SECOND)",Integer.class,space,space)==0)Thread.sleep(100);
            assertThat(db.queryForObject("SELECT COUNT(*) FROM world_map_node_map WHERE space_id=? AND map_id=? AND active=TRUE AND last_seen_at>=DATE_SUB(CURRENT_TIMESTAMP(6),INTERVAL 10 SECOND)",Integer.class,space,space)).isEqualTo(1);
            map.put("name","Redis 복구 뒤 반영");
            var saved=ok(owner.post(root+"/draft",Map.of("lease",credentials,"baseVersion",1,"operationId",UUID.randomUUID().toString(),"map",map)));
            assertThat(saved.path("issues")).isEmpty();
            failCacheWrites.set(true);
            var published=ok(owner.post(root+"/publish",Map.of("lease",credentials,"baseVersion",2)));
            String revision=published.path("publishedRevision").asText();
            assertThat(published.path("publication").path("state").asText()).isEqualTo("PUBLISHING");
            assertThat(db.queryForObject("SELECT delivered FROM map_outbox WHERE revision_id=?",Boolean.class,revision)).isFalse();
            failCacheWrites.set(false);
            failTargetWrites.set(true);
            long targetFailureDeadline=System.nanoTime()+TimeUnit.SECONDS.toNanos(8);
            while(System.nanoTime()<targetFailureDeadline&&targetWriteFailures.get()==0)Thread.sleep(100);
            assertThat(targetWriteFailures.get()).isGreaterThan(0);
            assertThat(db.queryForObject("SELECT delivered FROM map_outbox WHERE revision_id=?",Boolean.class,revision)).isFalse();
            assertThat(ok(owner.get(root+"/publication/"+revision)).path("state").asText()).isEqualTo("PUBLISHING");
            failTargetWrites.set(false);
            peer.await(n->n.path("type").asText().equals("mapChanged")&&n.path("map").path("revision").asText().equals(revision),java.time.Duration.ofSeconds(8));
            long ackDeadline=System.nanoTime()+TimeUnit.SECONDS.toNanos(8);
            JsonNode status=null;
            while(System.nanoTime()<ackDeadline) {
                status=ok(owner.get(root+"/publication/"+revision));
                if(status.path("state").asText().equals("APPLIED"))break;
                Thread.sleep(150);
            }
            assertThat(db.queryForObject("SELECT delivered FROM map_outbox WHERE revision_id=?",Boolean.class,revision)).isTrue();
            assertThat(status.path("state").asText()).isEqualTo("APPLIED");
            assertThat(status.path("targetNodes").asInt()).isEqualTo(1);
            assertThat(status.path("appliedNodes").asInt()).isEqualTo(1);
        } finally {failCacheWrites.set(false);failTargetWrites.set(false);peer.socket.abort();}
    }

    @Test void initialMapRevisionsAreHashedImmutableAndPrivateAssetsStaySpaceScoped() throws Exception {
        Browser owner = signedIn();
        Browser outsider = signedIn();
        String privateSpace = createSpace(owner, "비공개 버전 검증", "PRIVATE", 10).path("id").asText();
        String otherSpace = createSpace(owner, "다른 비공개 공간", "PRIVATE", 10).path("id").asText();
        String mapRoot = "/spaces/" + privateSpace + "/map";

        JsonNode seededMap = ok(owner.get(mapRoot));
        String initialRevision = seededMap.path("revision").asText();
        assertThat(seededMap.path("id").asText()).isEqualTo(privateSpace);
        assertThat(seededMap.path("objects").size()).isGreaterThan(0);
        String initialDocument = db.queryForObject("SELECT document FROM map_revision WHERE id=? AND space_id=?",
            String.class, initialRevision, privateSpace);
        String initialHash = db.queryForObject("SELECT content_hash FROM map_revision WHERE id=? AND space_id=?",
            String.class, initialRevision, privateSpace);
        assertThat(initialHash).isEqualTo(java.util.HexFormat.of().formatHex(
            java.security.MessageDigest.getInstance("SHA-256").digest(initialDocument.getBytes(java.nio.charset.StandardCharsets.UTF_8))));

        var deniedMap = outsider.get(mapRoot);
        assertThat(deniedMap.statusCode()).isIn(403, 404);
        assertThat(owner.get("/spaces/" + otherSpace + "/maps/" + privateSpace + "/published").statusCode()).isEqualTo(404);

        var image = new java.awt.image.BufferedImage(8, 6, java.awt.image.BufferedImage.TYPE_INT_ARGB);
        var encoded = new java.io.ByteArrayOutputStream();
        assertThat(javax.imageio.ImageIO.write(image, "PNG", encoded)).isTrue();
        String assetRoot = "/spaces/" + privateSpace + "/assets";
        JsonNode pending = json.readTree(owner.upload(assetRoot, "space-scoped.png", "image/png", encoded.toByteArray()).body());
        String assetId = pending.path("id").asText();
        assertThat(owner.post(assetRoot + "/" + assetId + "/approve", Map.of()).statusCode()).isEqualTo(200);
        assertThat(owner.get("/spaces/" + otherSpace + "/assets/" + assetId + "/content").statusCode()).isEqualTo(404);
        var deniedAsset = outsider.get(assetRoot + "/" + assetId + "/content");
        assertThat(deniedAsset.statusCode()).isIn(403, 404);

        String clientId = UUID.randomUUID().toString();
        JsonNode lease = ok(owner.post(mapRoot + "/lease", Map.of("clientId", clientId, "takeover", false)));
        var map = (com.fasterxml.jackson.databind.node.ObjectNode) lease.path("editor").path("map").deepCopy();
        var interaction = json.createObjectNode().put("kind", "IMAGE").put("title", "비공개 공간 이미지")
            .put("body", "").put("url", "").put("assetId", assetId).put("radius", 0).put("volume", 0);
        ((com.fasterxml.jackson.databind.node.ObjectNode) map.path("objects").get(0)).set("interaction", interaction);
        Map<String, Object> save = Map.of("lease", credentials(lease, clientId), "baseVersion", 1,
            "operationId", UUID.randomUUID().toString(), "map", map);
        assertThat(ok(owner.post(mapRoot + "/draft", save)).path("version").asLong()).isEqualTo(2);
        assertThat(owner.delete(assetRoot + "/" + assetId, Map.of()).statusCode()).isEqualTo(409);
        JsonNode published = ok(owner.post(mapRoot + "/publish", Map.of("lease", credentials(lease, clientId), "baseVersion", 2)));
        String publishedRevision = published.path("publishedRevision").asText();
        String publishedDocument = db.queryForObject("SELECT document FROM map_revision WHERE id=? AND space_id=?",
            String.class, publishedRevision, privateSpace);
        String publishedHash = db.queryForObject("SELECT content_hash FROM map_revision WHERE id=? AND space_id=?",
            String.class, publishedRevision, privateSpace);
        assertThat(publishedHash).isEqualTo(java.util.HexFormat.of().formatHex(
            java.security.MessageDigest.getInstance("SHA-256").digest(publishedDocument.getBytes(java.nio.charset.StandardCharsets.UTF_8))));
        assertThat(db.queryForObject("SELECT document FROM map_revision WHERE id=? AND space_id=?",
            String.class, initialRevision, privateSpace)).isEqualTo(initialDocument);
        assertThat(db.queryForObject("SELECT content_hash FROM map_revision WHERE id=? AND space_id=?",
            String.class, initialRevision, privateSpace)).isEqualTo(initialHash);
        assertThat(ok(owner.get(mapRoot)).path("revision").asText()).isEqualTo(publishedRevision);
    }

    @Test void invalidPublicationKeepsPreviousMapAndDraftBodyIsBounded() throws Exception {
        var owner=signedIn();String space=createSpace(owner,"검증 맵","PRIVATE",10).path("id").asText();String root="/spaces/"+space+"/map";
        String client=UUID.randomUUID().toString();var lease=ok(owner.post(root+"/lease",Map.of("clientId",client,"takeover",false)));var credentials=credentials(lease,client);
        var doc=(com.fasterxml.jackson.databind.node.ObjectNode)lease.path("editor").path("map").deepCopy();String revision=doc.path("revision").asText();
        doc.put("spawnX",1.2);doc.put("spawnY",2);
        var saved=ok(owner.post(root+"/draft",Map.of("lease",credentials,"baseVersion",1,"operationId",UUID.randomUUID().toString(),"map",doc)));
        assertThat(saved.path("issues")).isNotEmpty();assertThat(owner.post(root+"/publish",Map.of("lease",credentials,"baseVersion",2)).statusCode()).isEqualTo(400);
        assertThat(ok(owner.get(root)).path("revision").asText()).isEqualTo(revision);
        String csrf=ok(owner.get("csrf")).path("token").asText();
        assertThat(owner.rawPost(root+"/draft"," ".repeat(512_001),csrf).statusCode()).isEqualTo(413);
    }
    @Test void mapsInOneSpaceKeepIndependentDraftsRevisionsAndEntryOrder() throws Exception {
        String ownerSubject=UUID.randomUUID().toString();var owner=signedInAs(ownerSubject);var other=signedIn();var otherOwnerSession=signedInAs(ownerSubject);
        String space=createSpace(owner,"다중 지도","PUBLIC",100).path("id").asText();String root="/spaces/"+space+"/maps";
        var initial=ok(owner.get(root));assertThat(initial).hasSize(1);assertThat(initial.get(0).path("mapId").asText()).isEqualTo(space);assertThat(initial.get(0).path("entry").asBoolean()).isTrue();
        assertThat(other.get(root).statusCode()).isEqualTo(403);
        var created=ok(owner.post(root,Map.of("name","강의실","templateId","MEETUP_HALL")));String mapId=created.path("mapId").asText();
        assertThat(mapId).isNotEqualTo(space);assertThat(created.path("entry").asBoolean()).isFalse();
        String defaultRoot=root+"/"+space,secondRoot=root+"/"+mapId;String defaultClient=UUID.randomUUID().toString(),secondClient=UUID.randomUUID().toString();
        var defaultLease=ok(owner.post(defaultRoot+"/lease",Map.of("clientId",defaultClient,"takeover",false)));
        var secondLease=ok(owner.post(secondRoot+"/lease",Map.of("clientId",secondClient,"takeover",false)));
        assertThat(defaultLease.path("editor").path("map").path("id").asText()).isEqualTo(space);
        assertThat(secondLease.path("editor").path("map").path("id").asText()).isEqualTo(mapId);
        var changed=(com.fasterxml.jackson.databind.node.ObjectNode)secondLease.path("editor").path("map").deepCopy();changed.put("name","강의실 변경");
        var saved=ok(owner.post(secondRoot+"/draft",Map.of("lease",credentials(secondLease,secondClient),"baseVersion",1,"operationId",UUID.randomUUID().toString(),"map",changed)));
        assertThat(saved.path("version").asLong()).isEqualTo(2);
        ok(owner.post(secondRoot+"/publish",Map.of("lease",credentials(secondLease,secondClient),"baseVersion",2)));
        assertThat(ok(owner.get(secondRoot+"/published")).path("name").asText()).isEqualTo("강의실 변경");
        assertThat(ok(owner.get(defaultRoot+"/published")).path("id").asText()).isEqualTo(space);
        assertThat(ok(owner.get(secondRoot+"/history"))).hasSize(2);
        assertThat(ok(owner.get(defaultRoot+"/history"))).hasSize(1);
        var independentOrder=ok(owner.put(root+"/order",Map.of("mapIds",List.of(mapId,space))));
        assertThat(independentOrder.get(0).path("mapId").asText()).isEqualTo(mapId);
        assertThat(independentOrder.get(0).path("entry").asBoolean()).isFalse();assertThat(independentOrder.get(1).path("entry").asBoolean()).isTrue();
        var reordered=ok(owner.put(root+"/order",Map.of("mapIds",List.of(space,mapId))));
        assertThat(reordered.get(0).path("mapId").asText()).isEqualTo(space);
        assertThat(other.get("/spaces/"+space+"/maps/"+mapId+"/editor").statusCode()).isEqualTo(403);
        Probe entryWorld=owner.socketWithTicket(ORIGIN,owner.ticket(space));
        Probe hallWorld=otherOwnerSession.socketWithTicket(ORIGIN,otherOwnerSession.ticket(space,mapId));
        try {
            entryWorld.join(""); hallWorld.join("");
            var entryWelcome=entryWorld.await(n->n.path("type").asText().equals("welcome"));
            var hallWelcome=hallWorld.await(n->n.path("type").asText().equals("welcome"));
            assertThat(entryWelcome.path("mapRevision").asText()).isNotEqualTo(hallWelcome.path("mapRevision").asText());
            assertThat(entryWorld.await(n->n.path("type").asText().equals("snapshot")&&n.path("players").size()==1)
                .path("players").get(0).path("id").asText()).isEqualTo(entryWelcome.path("playerId").asText());
            assertThat(hallWorld.await(n->n.path("type").asText().equals("snapshot")&&n.path("players").size()==1)
                .path("players").get(0).path("id").asText()).isEqualTo(hallWelcome.path("playerId").asText());
        } finally { entryWorld.socket.abort(); hallWorld.socket.abort(); }
    }
    @Test void mapLifecycleClonesMapsSelectsEntryAndProtectsPortalDestinations() throws Exception {
        Browser owner=signedIn();String space=createSpace(owner,"지도 관리","PRIVATE",100).path("id").asText();String root="/spaces/"+space+"/maps";
        String target=ok(owner.post(root,Map.of("name","대상 지도","templateId","MEETUP_HALL"))).path("mapId").asText();
        JsonNode clone=ok(owner.post(root+"/"+target+"/clone",Map.of("name","복제 지도")));String cloneId=clone.path("mapId").asText();
        assertThat(cloneId).isNotEqualTo(target);assertThat(clone.path("entry").asBoolean()).isFalse();
        var entry=ok(owner.put(root+"/"+cloneId+"/entry",Map.of()));assertThat(entry.findValuesAsText("mapId")).contains(cloneId);
        assertThat(entry.findValuesAsText("entry")).contains("true");
        String defaultPlayerId;
        Probe defaultEntry=owner.socketWithTicket(ORIGIN,owner.ticket(space,space));
        try {
            defaultEntry.join("");var welcome=defaultEntry.await(n->n.path("type").asText().equals("welcome"));
            defaultPlayerId=welcome.path("playerId").asText();
            assertThat(welcome.path("mapRevision").asText()).isNotEqualTo(clone.path("publishedRevision").asText());
            assertThat(defaultEntry.await(n->n.path("type").asText().equals("snapshot")&&n.path("players").size()==1).path("players").get(0).path("id").asText())
                .isEqualTo(defaultPlayerId);
        } finally { defaultEntry.socket.abort(); }
        var entryDelete=owner.delete(root+"/"+cloneId,Map.of());assertThat(entryDelete.statusCode()).isEqualTo(409);
        String client=UUID.randomUUID().toString();var lease=ok(owner.post(root+"/"+space+"/lease",Map.of("clientId",client,"takeover",false)));
        var doc=(com.fasterxml.jackson.databind.node.ObjectNode)lease.path("editor").path("map").deepCopy();
        ((com.fasterxml.jackson.databind.node.ArrayNode)doc.path("portals")).add(json.valueToTree(Map.of("id","map-portal-test","name","복제 지도 연결","bounds",Map.of("x",5,"y",5,"width",1,"height",1),"targetSpaceId",space,"targetMapId",cloneId,"targetSpawnX",2,"targetSpawnY",2)));
        ((com.fasterxml.jackson.databind.node.ArrayNode)doc.path("portals")).add(json.valueToTree(Map.of("id","map-portal-fallback-test","name","안전 위치 대체","bounds",Map.of("x",8,"y",5,"width",1,"height",1),"targetSpaceId",space,"targetMapId",cloneId,"targetSpawnX",0.1,"targetSpawnY",0.1)));
        var credentials=credentials(lease,client);
        var saved=ok(owner.post(root+"/"+space+"/draft",Map.of("lease",credentials,"baseVersion",1,"operationId",UUID.randomUUID().toString(),"map",doc)));
        assertThat(saved.path("issues")).isEmpty();
        ok(owner.post(root+"/"+space+"/publish",Map.of("lease",credentials,"baseVersion",2)));
        ok(owner.put(root+"/"+space+"/entry",Map.of()));
        String portalTicket=owner.portalTicket(space,space,space,"map-portal-test",cloneId);
        Probe portalArrival=owner.socketWithTicket(ORIGIN,portalTicket);
        try {
            portalArrival.join("");var movedWelcome=portalArrival.await(node->node.path("type").asText().equals("welcome"));
            assertThat(movedWelcome.path("playerId").asText()).isEqualTo(defaultPlayerId);
            var arrival=portalArrival.await(node->node.path("type").asText().equals("snapshot")&&node.path("players").size()==1);
            assertThat(strings.opsForZSet().zCard("hufs-town:seats:"+space)).isEqualTo(1L);
            assertThat(arrival.path("players").get(0).path("x").asDouble()).isEqualTo(2);
            assertThat(arrival.path("players").get(0).path("y").asDouble()).isEqualTo(2);
        } finally { portalArrival.socket.abort(); }
        var forgedPortal=owner.post("/spaces/"+space+"/admission",Map.of("mapId",cloneId,"sourceSpaceId",space,"sourceMapId",space,"portalId","missing-portal"));
        assertThat(forgedPortal.statusCode()).isEqualTo(400);
        var mismatchedDestination=owner.post("/spaces/"+space+"/admission",Map.of("mapId",space,"sourceSpaceId",space,"sourceMapId",space,"portalId","map-portal-test"));
        assertThat(mismatchedDestination.statusCode()).isEqualTo(400);
        Probe fallbackArrival=owner.socketWithTicket(ORIGIN,owner.portalTicket(space,space,space,"map-portal-fallback-test",cloneId));
        try {
            fallbackArrival.join("");fallbackArrival.await(node->node.path("type").asText().equals("welcome"));
            var arrival=fallbackArrival.await(node->node.path("type").asText().equals("snapshot")&&node.path("players").size()==1);
            assertThat(arrival.path("players").get(0).path("x").asDouble()).isEqualTo(24);
            assertThat(arrival.path("players").get(0).path("y").asDouble()).isEqualTo(30);
        } finally { fallbackArrival.socket.abort(); }
        var inUse=owner.delete(root+"/"+cloneId,Map.of());assertThat(inUse.statusCode()).isEqualTo(409);assertThat(json.readTree(inUse.body()).path("code").asText()).isEqualTo("MAP_IN_USE");
        String removable=ok(owner.post(root,Map.of("name","삭제 대상","templateId","OFFICE"))).path("mapId").asText();
        String staleTicket=owner.ticket(space,removable);
        assertThat(owner.delete(root+"/"+removable,Map.of()).statusCode()).isEqualTo(200);
        assertThatThrownBy(()->owner.socketWithTicket(ORIGIN,staleTicket)).hasCauseInstanceOf(WebSocketHandshakeException.class);
        assertThat(ok(owner.get(root)).findValuesAsText("mapId")).doesNotContain(removable);
    }
    private JsonNode ok(HttpResponse<String> response) throws Exception {assertThat(response.statusCode()).as(response.body()).isEqualTo(200);return json.readTree(response.body());}
    private Map<String,Object> credentials(JsonNode lease,String client){return Map.of("token",lease.path("token").asText(),"fence",lease.path("fence").asLong(),"clientId",client);}

    private Browser signedIn() throws Exception {
        return signedInAs(UUID.randomUUID().toString());
    }
    private Browser signedInAs(String subject) throws Exception {
        return signedInAsEmail(subject, "tester@hufs.ac.kr");
    }
    private Browser signedInAsEmail(String subject, String email) throws Exception {
        Browser browser = new Browser(); String state = browser.start();
        expectUser(subject, "ATTENDING", email);
        assertThat(browser.post("exchange", Map.of("code", UUID.randomUUID().toString(), "state", state)).statusCode()).isEqualTo(200);
        return browser;
    }
    private JsonNode createSpace(Browser owner, String name, String visibility, int capacity) throws Exception {
        var response = owner.post("/spaces", Map.of("name", name, "description", "통합 테스트", "visibility", visibility, "capacity", capacity));
        assertThat(response.statusCode()).as(response.body()).isEqualTo(200);
        return json.readTree(response.body());
    }
    private String createDirectConversation(String firstUserId, String secondUserId) {
        List<String> users = new TreeSet<>(List.of(firstUserId, secondUserId)).stream().toList();
        String id = UUID.randomUUID().toString();
        String pairKey = users.getFirst() + ":" + users.getLast();
        db.update("INSERT INTO direct_conversation(id,pair_key) VALUES (?,?)", id, pairKey);
        db.update("INSERT INTO direct_conversation_member(membership_id,conversation_id,user_id) VALUES (UUID(),?,?)",
            id, users.getFirst());
        db.update("INSERT INTO direct_conversation_member(membership_id,conversation_id,user_id) VALUES (UUID(),?,?)",
            id, users.getLast());
        return id;
    }
    private String submitParticipantReport(Browser reporter, Probe socket, JsonNode welcome, String targetPlayerId,
                                           String requestId, String spaceId, String targetGuestId) throws Exception {
        socket.send(json.writeValueAsString(Map.of("type", "playerReportRequest",
            "epoch", welcome.path("epoch").asLong(), "requestId", requestId, "targetId", targetPlayerId,
            "category", "HARASSMENT", "details", "브라우저 범위 게스트 신고 통합 검증")));
        JsonNode acknowledgement = socket.await(node -> node.path("type").asText().equals("playerReportAck")
            && node.path("requestId").asText().equals(requestId));
        assertThat(acknowledgement.path("accepted").asBoolean()).as(acknowledgement.toString()).isTrue();
        String reporterId = json.readTree(reporter.get("me").body()).path("userId").asText();
        return db.queryForObject("""
            SELECT report_id FROM user_report
            WHERE reporter_user_id=? AND target_guest_id=? AND source_type='PLAYER' AND space_id=?
            ORDER BY created_at DESC LIMIT 1
            """, String.class, reporterId, targetGuestId, spaceId);
    }
    private String guestIdentityId(Browser browser) {
        String sessionId = new String(Base64.getDecoder().decode(browser.cookie()), java.nio.charset.StandardCharsets.UTF_8);
        var session = sessions.findById(sessionId);
        assertThat(session).isNotNull();
        var identity = (town.hufs.auth.GuestIdentity) session.getAttribute(town.hufs.auth.GuestIdentity.SESSION_ATTRIBUTE);
        assertThat(identity).isNotNull();
        return identity.guestId();
    }
    private void expectUser(String uuid, String status) {
        expectUser(uuid, status, "tester@hufs.ac.kr");
    }
    private void expectUser(String uuid, String status, String email) {
        transport.server().verify();
        transport.server().reset();
        transport.server().expect(requestTo("https://api.gdghufs.com/v1/sso/userinfo"))
            .andRespond(withSuccess("{\"data\":{\"uuid\":\"" + uuid + "\",\"name\":\"테스터\",\"status\":\"" + status + "\",\"email\":\"" + email + "\"},\"error_code\":null}", MediaType.APPLICATION_JSON));
    }
    class Browser {
        final CookieManager cookies = new CookieManager(null, CookiePolicy.ACCEPT_ALL);
        final HttpClient client = HttpClient.newBuilder().cookieHandler(cookies).build();
        URI uri(String path) { return URI.create("http://127.0.0.1:" + port + "/api/v1" + (path.startsWith("/") ? path : "/auth/" + path)); }
        HttpResponse<String> get(String path) throws Exception { return client.send(HttpRequest.newBuilder(uri(path)).GET().build(), HttpResponse.BodyHandlers.ofString()); }
        HttpResponse<byte[]> getBytes(String path) throws Exception { return client.send(HttpRequest.newBuilder(uri(path)).GET().build(), HttpResponse.BodyHandlers.ofByteArray()); }
        String cookie() { return cookie("HUFS_TOWN_SESSION"); }
        String guestCookie() { return cookie("HUFS_TOWN_GUEST"); }
        String cookie(String name) { return cookies.getCookieStore().getCookies().stream().filter(c -> c.getName().equals(name)).map(HttpCookie::getValue).findFirst().orElse(""); }
        String cookieAfterCsrf() throws Exception { get("csrf"); return cookie(); }
        HttpResponse<String> rawPost(String path, String body, String csrf) throws Exception {
            var request = HttpRequest.newBuilder(uri(path)).header("Content-Type", "application/json");
            if (csrf != null) request.header("X-CSRF-TOKEN", csrf);
            return client.send(request.POST(HttpRequest.BodyPublishers.ofString(body)).build(), HttpResponse.BodyHandlers.ofString());
        }
        HttpResponse<String> post(String path, Object body) throws Exception {
            String csrf = json.readTree(get("csrf").body()).path("token").asText();
            return rawPost(path, json.writeValueAsString(body), csrf);
        }
        HttpResponse<String> put(String path, Object body) throws Exception {
            String csrf = json.readTree(get("csrf").body()).path("token").asText();
            return client.send(HttpRequest.newBuilder(uri(path)).header("Content-Type", "application/json").header("X-CSRF-TOKEN", csrf)
                .PUT(HttpRequest.BodyPublishers.ofString(json.writeValueAsString(body))).build(), HttpResponse.BodyHandlers.ofString());
        }
        HttpResponse<String> upload(String path, String fileName, String contentType, byte[] bytes) throws Exception {
            String csrf = json.readTree(get("csrf").body()).path("token").asText();
            String boundary = "----HUFS" + UUID.randomUUID().toString().replace("-", "");
            var body = new java.io.ByteArrayOutputStream();
            body.write(("--" + boundary + "\r\nContent-Disposition: form-data; name=\"file\"; filename=\"" + fileName + "\"\r\nContent-Type: " + contentType + "\r\n\r\n").getBytes(java.nio.charset.StandardCharsets.UTF_8));
            body.write(bytes);
            body.write(("\r\n--" + boundary + "--\r\n").getBytes(java.nio.charset.StandardCharsets.UTF_8));
            return client.send(HttpRequest.newBuilder(uri(path)).header("Content-Type", "multipart/form-data; boundary=" + boundary)
                .header("X-CSRF-TOKEN", csrf).POST(HttpRequest.BodyPublishers.ofByteArray(body.toByteArray())).build(), HttpResponse.BodyHandlers.ofString());
        }
        HttpResponse<String> patch(String path, Object body) throws Exception {
            String csrf = json.readTree(get("csrf").body()).path("token").asText();
            return client.send(HttpRequest.newBuilder(uri(path)).header("Content-Type", "application/json").header("X-CSRF-TOKEN", csrf)
                .method("PATCH", HttpRequest.BodyPublishers.ofString(json.writeValueAsString(body))).build(), HttpResponse.BodyHandlers.ofString());
        }
        HttpResponse<String> delete(String path, Object body) throws Exception {
            String csrf = json.readTree(get("csrf").body()).path("token").asText();
            return client.send(HttpRequest.newBuilder(uri(path)).header("Content-Type", "application/json").header("X-CSRF-TOKEN", csrf)
                .method("DELETE", HttpRequest.BodyPublishers.ofString(json.writeValueAsString(body))).build(), HttpResponse.BodyHandlers.ofString());
        }
        String start() throws Exception {
            var response = post("start", Map.of());
            assertThat(response.statusCode()).isEqualTo(200);
            String url = json.readTree(response.body()).path("authorizationUrl").asText();
            assertThat(url).startsWith("https://api.gdghufs.com/v1/sso/authorize?").contains("client_id=test-town").doesNotContain("test-secret");
            return Arrays.stream(URI.create(url).getRawQuery().split("&")).filter(s -> s.startsWith("state=")).findFirst().orElseThrow().substring(6);
        }
        Probe socket(String origin) throws Exception {
            String ticket = json.readTree(post("/spaces/" + CAMPUS + "/admission", Map.of()).body()).path("ticket").asText();
            return socketWithTicket(origin, ticket);
        }
        String ticket(String id) throws Exception {
            return ticket(id,id);
        }
        String ticket(String id,String mapId) throws Exception {
            return ticket(id, mapId, "");
        }
        String ticket(String id,String mapId,String resumeToken) throws Exception {
            var body = new java.util.HashMap<String, String>();
            body.put("mapId", mapId);
            if (resumeToken != null && !resumeToken.isBlank()) body.put("resumeToken", resumeToken);
            var response = post("/spaces/" + id + "/admission", body);
            assertThat(response.statusCode()).as(response.body()).isEqualTo(200);
            var admission = json.readTree(response.body());
            assertThat(Arrays.asList(TEST_WORLD_ENDPOINTS.split(","))).contains(admission.path("worldUrl").asText());
            return admission.path("ticket").asText();
        }
        String ticketDefault(String id) throws Exception {
            var response = post("/spaces/" + id + "/admission", Map.of());
            assertThat(response.statusCode()).as(response.body()).isEqualTo(200);
            var admission = json.readTree(response.body());
            assertThat(Arrays.asList(TEST_WORLD_ENDPOINTS.split(","))).contains(admission.path("worldUrl").asText());
            return admission.path("ticket").asText();
        }
        String portalTicket(String destinationSpaceId,String sourceSpaceId,String sourceMapId,String portalId,String mapId) throws Exception {
            var response=post("/spaces/"+destinationSpaceId+"/admission",Map.of("mapId",mapId,"sourceSpaceId",sourceSpaceId,"sourceMapId",sourceMapId,"portalId",portalId));
            assertThat(response.statusCode()).as(response.body()).isEqualTo(200);
            var admission = json.readTree(response.body());
            assertThat(Arrays.asList(TEST_WORLD_ENDPOINTS.split(","))).contains(admission.path("worldUrl").asText());
            return admission.path("ticket").asText();
        }
        Probe socketWithTicket(String origin, String ticket) throws Exception {
            return socketWithTicket(origin, ticket, worldPort);
        }
        Probe socketWithTicket(String origin, String ticket, int targetPort) throws Exception {
            var probe = new Probe();
            var builder = client.newWebSocketBuilder();
            if (origin != null) builder.header("Origin", origin);
            if (!ticket.isEmpty()) builder.subprotocols("hufs-town-v2", "hufs-ticket." + ticket);
            probe.socket = builder.buildAsync(URI.create("ws://127.0.0.1:" + targetPort + "/world/socket"), probe).get(5, TimeUnit.SECONDS);
            return probe;
        }
    }
    class Probe implements WebSocket.Listener {
        WebSocket socket;
        final BlockingQueue<JsonNode> messages = new LinkedBlockingQueue<>();
        final ConcurrentMap<String, JsonNode> visiblePlayers = new ConcurrentHashMap<>();
        final CompletableFuture<Void> closed = new CompletableFuture<>();
        final Object outboundLock = new Object();
        final StringBuilder buffer = new StringBuilder();
        @Override public void onOpen(WebSocket ws) { ws.request(1); }
        @Override public CompletionStage<?> onText(WebSocket ws, CharSequence text, boolean last) {
            buffer.append(text);
            if (last) { try {
                JsonNode node = json.readTree(buffer.toString());
                if (node.path("type").asText().equals("snapshot")) {
                    if (node.path("full").asBoolean()) visiblePlayers.clear();
                    node.path("players").forEach(player -> visiblePlayers.put(player.path("id").asText(), player.deepCopy()));
                    node.path("removedPlayerIds").forEach(playerId -> visiblePlayers.remove(playerId.asText()));
                    synchronized (outboundLock) {
                        ws.sendText(json.writeValueAsString(Map.of("type", "snapshotAck",
                            "tick", node.path("tick").asLong(), "applied", true)), true).join();
                    }
                }
                messages.add(node);
            } catch (Exception e) { throw new IllegalStateException(e); } buffer.setLength(0); }
            ws.request(1); return null;
        }
        @Override public CompletionStage<?> onClose(WebSocket ws, int code, String reason) { closed.complete(null); return null; }
        void send(String body) {
            synchronized (outboundLock) { socket.sendText(body, true).join(); }
        }
        void join(String resume) { send("{\"type\":\"join\",\"protocolVersion\":2,\"name\":\"테스터\",\"avatar\":0,\"skin\":\"light\",\"clothing\":\"casual_white\",\"hair\":\"hair_short_black\",\"resumeToken\":\"" + resume + "\"}"); }
        JsonNode await(Predicate<JsonNode> predicate) throws Exception {
            return await(predicate, java.time.Duration.ofSeconds(5));
        }
        JsonNode await(Predicate<JsonNode> predicate, java.time.Duration timeout) throws Exception {
            long deadline = System.nanoTime() + timeout.toNanos();
            var observed = new ArrayList<JsonNode>();
            while (System.nanoTime() < deadline) {
                var node = messages.poll(100, TimeUnit.MILLISECONDS);
                if (node != null) {
                    observed.add(node);
                    if (predicate.test(node)) return node;
                }
            }
            throw new AssertionError("Expected local WebSocket event did not arrive; received: " + observed);
        }
    }
    record Transport(RestClient client, MockRestServiceServer server) {}
    @TestConfiguration(proxyBeanMethods = false) static class TransportConfig {
        @Bean Transport transport() {
            var builder = RestClient.builder();
            var server = MockRestServiceServer.bindTo(builder).build();
            return new Transport(builder.build(), server);
        }
        @Bean @Primary @Qualifier("ssoRestClient") RestClient mockSsoClient(Transport transport) { return transport.client(); }
    }
}
