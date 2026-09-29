package town.hufs.world;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.sun.net.httpserver.HttpServer;
import org.junit.jupiter.api.Test;
import town.hufs.domain.MediaPolicy;

import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;

import static org.assertj.core.api.Assertions.assertThat;

class MediaGatewayPolicyRetryTest {
    @Test
    void failureLabelsDoNotCopySensitiveExceptionMessagesIntoWorldLogs() {
        String privateMessage = "private chat content and bearer-token-secret";
        var failure = new IllegalStateException(privateMessage);

        String label = MediaGateway.safeFailureType(failure);

        assertThat(label).isEqualTo("IllegalStateException");
        assertThat(label).doesNotContain(privateMessage, "bearer-token-secret");
    }

    @Test
    void controlFailureLabelsKeepOnlySanitizedStatusAndCode() {
        assertThat(MediaGateway.safeControlFailureLabel(401, "MEDIA_AUTH_REQUIRED"))
            .isEqualTo("ControlFailure:401:MEDIA_AUTH_REQUIRED");
        assertThat(MediaGateway.safeControlFailureLabel(0, "bad code\nBearer secret"))
            .isEqualTo("ControlFailure:0:UNKNOWN");
        assertThat(MediaGateway.safeControlFailureReason("통화 참가자 ID·구역·접속 번호가 올바르지 않아요."))
            .isEqualTo("PARTICIPANT_ID_DOMAIN_EPOCH");
        assertThat(MediaGateway.safeControlFailureReason("private chat and bearer-token-secret"))
            .isEqualTo("OTHER");
    }

    @Test
    void retriesAStaleSnapshotAfterAnIoFailureUsingTheNewestQueuedSnapshot() throws Exception {
        var server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        var requests = new AtomicInteger();
        var requestFrames = new CopyOnWriteArrayList<JsonNode>();
        var receivedFirstFrame = new CountDownLatch(1);
        var finishFirstFrame = new CountDownLatch(1);
        var json = new ObjectMapper();
        var serverExecutor = Executors.newCachedThreadPool();
        server.setExecutor(serverExecutor);
        server.createContext("/v1/policy", exchange -> {
            var frame = json.readTree(exchange.getRequestBody());
            requestFrames.add(frame);
            if (requests.incrementAndGet() == 1) {
                receivedFirstFrame.countDown();
                try {
                    if (!finishFirstFrame.await(3, TimeUnit.SECONDS))
                        throw new IllegalStateException("test did not release first policy request");
                } catch (InterruptedException interrupted) {
                    Thread.currentThread().interrupt();
                    throw new IllegalStateException(interrupted);
                }
                exchange.close();
                return;
            }
            byte[] response = "{\"instanceId\":\"test-engine\",\"people\":[]}"
                .getBytes(StandardCharsets.UTF_8);
            exchange.getResponseHeaders().add("Content-Type", "application/json");
            exchange.sendResponseHeaders(200, response.length);
            try (var body = exchange.getResponseBody()) { body.write(response); }
        });
        server.start();

        var gateway = new MediaGateway(true,
            "http://127.0.0.1:" + server.getAddress().getPort(), "x".repeat(32));
        var staleCallback = new AtomicInteger();
        var latestCallback = new CountDownLatch(1);
        try {
            var decision = new MediaPolicy.Decision(Map.of(), Set.of());
            gateway.publish(List.of(), decision, ignored -> staleCallback.incrementAndGet());
            assertThat(receivedFirstFrame.await(3, TimeUnit.SECONDS)).isTrue();

            gateway.publish(List.of(), decision, ignored -> latestCallback.countDown());
            finishFirstFrame.countDown();

            assertThat(latestCallback.await(3, TimeUnit.SECONDS)).isTrue();
            assertThat(requests.get()).isEqualTo(2);
            assertThat(requestFrames).hasSize(2);
            assertThat(requestFrames.get(1).path("sequence").asLong())
                .isGreaterThan(requestFrames.get(0).path("sequence").asLong());
            assertThat(requestFrames.get(1).path("leaseMillis").asLong()).isEqualTo(2_000);
            assertThat(staleCallback.get()).isZero();
        } finally {
            finishFirstFrame.countDown();
            gateway.close();
            server.stop(0);
            serverExecutor.shutdownNow();
        }
    }
}
