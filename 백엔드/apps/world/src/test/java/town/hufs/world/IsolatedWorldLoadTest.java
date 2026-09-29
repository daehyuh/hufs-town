package town.hufs.world;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;

import java.lang.management.ManagementFactory;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.net.http.WebSocket;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.time.Duration;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.Predicate;

import static org.junit.jupiter.api.Assertions.*;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

/** Client-side capacity probe. The target is an independently launched packaged World process. */
class IsolatedWorldLoadTest {
    private static final int MAX_CAPACITY = 100;
    private static final int[] SUPPORTED_CLIENT_COUNTS = {25, 50, 100};
    private static final int DEFAULT_CLIENT_COUNT = 100;
    private static final long DEFAULT_STEADY_STATE_SECONDS = 15;
    private final ObjectMapper json = new ObjectMapper();
    private final HttpClient http = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(5)).build();

    @Test void packagedWorldRunsConfiguredMovementLoadAndEnforcesCapacity() throws Exception {
        String endpoint = optionalProperty("worldLoadUrl");
        String output = optionalProperty("worldLoadOutput");
        String samplesOutput = output == null ? null : output + ".samples.jsonl";
        int clientCount = integerProperty("worldLoadClientCount", DEFAULT_CLIENT_COUNT);
        long warmupSeconds = longProperty("worldLoadWarmupSeconds", 0);
        long steadyStateSeconds = longProperty("worldLoadSteadyStateSeconds", DEFAULT_STEADY_STATE_SECONDS);
        assumeTrue(endpoint != null && output != null,
            "Run scripts/world-load.ps1 to provide a separate preview World target.");
        assertTrue(java.util.Arrays.stream(SUPPORTED_CLIENT_COUNTS).anyMatch(count -> count == clientCount),
            "worldLoadClientCount must be 25, 50, or 100");
        assertTrue(warmupSeconds >= 0, "worldLoadWarmupSeconds must not be negative");
        assertTrue(steadyStateSeconds > 0, "worldLoadSteadyStateSeconds must be positive");
        String metricsBase = endpoint.replaceFirst("^ws", "http").replaceFirst("/world/socket(?:\\?.*)?$", "");
        Files.createDirectories(Path.of(output).getParent());
        if (samplesOutput != null) Files.deleteIfExists(Path.of(samplesOutput));
        Files.writeString(Path.of(output + ".started"), Long.toString(System.nanoTime()));
        Files.writeString(Path.of(output + ".client-pid"), Long.toString(ProcessHandle.current().pid()));
        com.sun.management.OperatingSystemMXBean loadGeneratorOs =
            (com.sun.management.OperatingSystemMXBean) ManagementFactory.getOperatingSystemMXBean();
        long loadGeneratorCpuStartNanos = loadGeneratorOs.getProcessCpuTime();
        List<Probe> probes = new CopyOnWriteArrayList<>();
        long started = System.nanoTime();
        JsonNode connectStartTicks = metric(metricsBase, "hufs.world.tick.duration");
        JsonNode connectStartOverruns = metric(metricsBase, "hufs.world.tick.overruns");
        ExecutorService pool = Executors.newFixedThreadPool(32);
        try {
            List<Future<Probe>> connects = new ArrayList<>(clientCount);
            for (int i = 0; i < clientCount; i++) connects.add(pool.submit(() -> connect(endpoint, clientCount)));
            for (Future<Probe> connect : connects) probes.add(connect.get(20, TimeUnit.SECONDS));
            long connectedAt = System.nanoTime();
            JsonNode connectEndTicks = metric(metricsBase, "hufs.world.tick.duration");
            JsonNode connectEndOverruns = metric(metricsBase, "hufs.world.tick.overruns");

            JsonNode joinStartTicks = metric(metricsBase, "hufs.world.tick.duration");
            JsonNode joinStartOverruns = metric(metricsBase, "hufs.world.tick.overruns");
            Map<String, JsonNode> joinWorkStart = actorPhaseMetrics(metricsBase);
            Map<String, JsonNode> joinStageStart = joinStageMetrics(metricsBase);
            JsonNode joinCommandStart = metric(metricsBase, "hufs.world.join.command.duration");
            List<Future<?>> joins = new ArrayList<>(clientCount);
            for (int i = 0; i < clientCount; i++) {
                int clientId = i;
                joins.add(pool.submit(() -> probes.get(clientId).send(joinMessage("isolated-%03d".formatted(clientId)))));
            }
            for (Future<?> join : joins) join.get(20, TimeUnit.SECONDS);
            CompletableFuture.allOf(probes.stream().map(p -> p.welcome).toArray(CompletableFuture[]::new))
                .get(30, TimeUnit.SECONDS);
            CompletableFuture.allOf(probes.stream().map(p -> p.fullSpaceRoster).toArray(CompletableFuture[]::new))
                .get(40, TimeUnit.SECONDS);
            long convergedAt = System.nanoTime();
            for (Probe probe : probes) assertEquals(clientCount, probe.spaceParticipantIds.size(), "every client sees the full space roster");
            JsonNode joinEndTicks = metric(metricsBase, "hufs.world.tick.duration");
            JsonNode joinEndOverruns = metric(metricsBase, "hufs.world.tick.overruns");
            Map<String, JsonNode> joinWorkEnd = actorPhaseMetrics(metricsBase);
            Map<String, JsonNode> joinStageEnd = joinStageMetrics(metricsBase);
            JsonNode joinCommandEnd = metric(metricsBase, "hufs.world.join.command.duration");

            JsonNode players = awaitMetricValue(metricsBase, "hufs.world.players.active", clientCount, Duration.ofSeconds(5));
            JsonNode connections;
            try {
                connections = awaitMetricValue(metricsBase, "hufs.world.connections.active", clientCount, Duration.ofSeconds(10));
            } catch (AssertionError failure) {
                Map<String, Long> closeCodes = probes.stream()
                    .map(probe -> probe.closeCode.get())
                    .filter(code -> code >= 0)
                    .collect(java.util.stream.Collectors.groupingBy(String::valueOf, LinkedHashMap::new, java.util.stream.Collectors.counting()));
                Map<String, Long> errors = probes.stream()
                    .map(probe -> probe.socketErrorClass.get())
                    .filter(errorClass -> !errorClass.isBlank())
                    .collect(java.util.stream.Collectors.groupingBy(String::valueOf, LinkedHashMap::new, java.util.stream.Collectors.counting()));
                throw new AssertionError(failure.getMessage() + "; probe welcome="
                    + probes.stream().filter(probe -> probe.welcome.isDone() && !probe.welcome.isCompletedExceptionally()).count()
                    + "/" + clientCount + ", websocket close codes=" + closeCodes + ", websocket errors=" + errors, failure);
            }
            JsonNode queueCapacity = metric(metricsBase, "hufs.world.command.queue.capacity");

            for (int i = 0; i < clientCount; i++) probes.get(i).startMovement(i);
            if (warmupSeconds > 0) Thread.sleep(TimeUnit.SECONDS.toMillis(warmupSeconds));

            JsonNode rejected = null;
            JsonNode capacityStartTicks = metric(metricsBase, "hufs.world.tick.duration");
            JsonNode capacityStartOverruns = metric(metricsBase, "hufs.world.tick.overruns");
            if (clientCount == MAX_CAPACITY) {
                Probe overflow = connect(endpoint, clientCount);
                probes.add(overflow);
                overflow.captureMessages();
                overflow.send(joinMessage("isolated-overflow"));
                rejected = overflow.await(n -> n.path("type").asText().equals("error"));
                assertEquals("FULL", rejected.path("code").asText(), "client 101 must be rejected by world capacity");
            }
            JsonNode capacityEndTicks = metric(metricsBase, "hufs.world.tick.duration");
            JsonNode capacityEndOverruns = metric(metricsBase, "hufs.world.tick.overruns");

            // Start a fresh baseline after the warmed capacity probe has completed.
            JsonNode steadyStartTicks = metric(metricsBase, "hufs.world.tick.duration");
            JsonNode steadyStartOverruns = metric(metricsBase, "hufs.world.tick.overruns");
            long steadyStartedAt = System.nanoTime();
            long steadyDeadline = steadyStartedAt + TimeUnit.SECONDS.toNanos(steadyStateSeconds);
            List<Double> rollingP95Samples = new ArrayList<>();
            var resourceSamples = json.createArrayNode();
            while (System.nanoTime() < steadyDeadline) {
                long remainingMillis = TimeUnit.NANOSECONDS.toMillis(steadyDeadline - System.nanoTime());
                Thread.sleep(Math.max(1, Math.min(10_000, remainingMillis)));
                Double sample = optionalMeasurement(metricsBase, "hufs.world.tick.duration.p95", "VALUE");
                if (sample != null) rollingP95Samples.add(sample);
                JsonNode sampledTicks = metric(metricsBase, "hufs.world.tick.duration");
                JsonNode sampledOverruns = metric(metricsBase, "hufs.world.tick.overruns");
                JsonNode sampledHeap = metric(metricsBase, "jvm.memory.used?tag=area:heap");
                JsonNode sampledQueue = metric(metricsBase, "hufs.world.command.queue.size");
                JsonNode sampledJoinQueue = metric(metricsBase, "hufs.world.join.queue.size");
                JsonNode sampledPlayers = metric(metricsBase, "hufs.world.players.active");
                JsonNode sampledConnections = metric(metricsBase, "hufs.world.connections.active");
                var resourceSample = resourceSamples.addObject();
                resourceSample.put("elapsedSeconds", TimeUnit.NANOSECONDS.toSeconds(System.nanoTime() - steadyStartedAt));
                if (sample != null) resourceSample.put("rollingTickP95Ms", sample);
                resourceSample.put("serverTickCount", measurement(sampledTicks, "COUNT") - measurement(steadyStartTicks, "COUNT"));
                resourceSample.put("serverTickOverruns", measurement(sampledOverruns, "COUNT") - measurement(steadyStartOverruns, "COUNT"));
                resourceSample.put("serverHeapUsedBytes", measurement(sampledHeap, "VALUE"));
                resourceSample.put("serverCommandQueueSize", measurement(sampledQueue, "VALUE"));
                resourceSample.put("serverJoinQueueSize", measurement(sampledJoinQueue, "VALUE"));
                resourceSample.put("activePlayers", measurement(sampledPlayers, "VALUE"));
                resourceSample.put("activeConnections", measurement(sampledConnections, "VALUE"));
                resourceSample.put("loadGeneratorHeapUsedBytes", ManagementFactory.getMemoryMXBean().getHeapMemoryUsage().getUsed());
                Files.writeString(Path.of(samplesOutput), json.writeValueAsString(resourceSample) + System.lineSeparator(),
                    StandardCharsets.UTF_8, StandardOpenOption.CREATE, StandardOpenOption.APPEND);
            }
            JsonNode steadyEndTicks = metric(metricsBase, "hufs.world.tick.duration");
            JsonNode steadyEndOverruns = metric(metricsBase, "hufs.world.tick.overruns");
            long steadyEndedAt = System.nanoTime();
            double steadyTickCount = measurement(steadyEndTicks, "COUNT") - measurement(steadyStartTicks, "COUNT");
            double steadyTickTotalSeconds = measurement(steadyEndTicks, "TOTAL_TIME") - measurement(steadyStartTicks, "TOTAL_TIME");
            double steadyTickOverruns = measurement(steadyEndOverruns, "COUNT") - measurement(steadyStartOverruns, "COUNT");
            Double steadyTickP95Ms = optionalMeasurement(metricsBase, "hufs.world.tick.duration.p95", "VALUE");
            if (steadyTickP95Ms != null) rollingP95Samples.add(steadyTickP95Ms);
            JsonNode steadyPlayers = metric(metricsBase, "hufs.world.players.active");
            JsonNode steadyConnections = metric(metricsBase, "hufs.world.connections.active");
            JsonNode steadyQueue = metric(metricsBase, "hufs.world.command.queue.size");
            JsonNode steadyJoinQueue = metric(metricsBase, "hufs.world.join.queue.size");
            JsonNode steadyHeap = metric(metricsBase, "jvm.memory.used?tag=area:heap");
            assertEquals(clientCount, measurement(steadyPlayers, "VALUE"), "all load clients remain joined through steady state");
            assertEquals(clientCount, measurement(steadyConnections, "VALUE"), "all load WebSockets remain connected through steady state");
            assertEquals(0, measurement(steadyJoinQueue, "VALUE"), "join queue drains before steady state");
            for (Probe probe : probes.subList(0, clientCount))
                assertEquals(clientCount, probe.spaceParticipantIds.size(), "each client retains the full space roster through steady state");
            int minimumVisiblePlayers = probes.subList(0, clientCount).stream().mapToInt(probe -> probe.visibleIds.size()).min().orElse(0);
            int maximumVisiblePlayers = probes.subList(0, clientCount).stream().mapToInt(probe -> probe.visibleIds.size()).max().orElse(0);
            long clientsWithMovement = probes.subList(0, clientCount).stream().filter(probe -> probe.observedMovement.get()).count();
            assertEquals(clientCount, clientsWithMovement, "every simulated client must move during the measurement");
            long ended = System.nanoTime();
            long loadGeneratorCpuEndNanos = loadGeneratorOs.getProcessCpuTime();
            long loadGeneratorElapsedNanos = ended - started;
            var result = json.createObjectNode();
            result.put("requestedClients", clientCount);
            result.put("acceptedClients", clientCount);
            result.put("allClientsObservedFullSpaceRoster", true);
            result.put("minimumAoiPlayersVisibleAtPhaseEnd", minimumVisiblePlayers);
            result.put("maximumAoiPlayersVisibleAtPhaseEnd", maximumVisiblePlayers);
            result.put("movementEnabled", true);
            result.put("clientsObservedMoving", clientsWithMovement);
            result.put("movementMessagesSubmitted", probes.subList(0, clientCount).stream()
                .mapToLong(probe -> probe.movementMessagesSubmitted.get()).sum());
            if (loadGeneratorCpuStartNanos >= 0 && loadGeneratorCpuEndNanos >= loadGeneratorCpuStartNanos) {
                result.put("loadGeneratorCpuPercentOfOneCore",
                    (loadGeneratorCpuEndNanos - loadGeneratorCpuStartNanos) * 100.0 / loadGeneratorElapsedNanos);
            }
            var loadGeneratorHeap = ManagementFactory.getMemoryMXBean().getHeapMemoryUsage();
            result.put("loadGeneratorHeapUsedBytesAtEnd", loadGeneratorHeap.getUsed());
            result.put("loadGeneratorHeapMaxBytes", loadGeneratorHeap.getMax());
            result.put("overflowClientCode", rejected == null ? "NOT_TESTED_BELOW_CAPACITY" : rejected.path("code").asText());
            result.put("connectMs", TimeUnit.NANOSECONDS.toMillis(connectedAt - started));
            result.put("joinAndConvergenceMs", TimeUnit.NANOSECONDS.toMillis(convergedAt - connectedAt));
            result.put("testElapsedMs", TimeUnit.NANOSECONDS.toMillis(ended - started));
            result.put("activePlayersAtConvergence", measurement(players, "VALUE"));
            result.put("activeConnectionsAtConvergence", measurement(connections, "VALUE"));
            putPhaseMetrics(result, "connectPhase", "From first WebSocket connection attempt until all " + clientCount + " sockets are open",
                connectStartTicks, connectEndTicks, connectStartOverruns, connectEndOverruns);
            var joinPhase = putPhaseMetrics(result, "joinPhase", "From join commands after all sockets are open until all clients observe the full roster",
                joinStartTicks, joinEndTicks, joinStartOverruns, joinEndOverruns);
            putActorPhaseWork(joinPhase, joinWorkStart, joinWorkEnd);
            putJoinStageWork(joinPhase, joinStageStart, joinStageEnd);
            double joinCommandCount = measurement(joinCommandEnd, "COUNT") - measurement(joinCommandStart, "COUNT");
            double joinCommandTotalMs = (measurement(joinCommandEnd, "TOTAL_TIME") - measurement(joinCommandStart, "TOTAL_TIME")) * 1000.0;
            var joinCommands = joinPhase.putObject("actorJoinCommands");
            joinCommands.put("count", joinCommandCount);
            joinCommands.put("totalMs", joinCommandTotalMs);
            joinCommands.put("meanMs", joinCommandCount == 0 ? 0 : joinCommandTotalMs / joinCommandCount);
            joinCommands.put("maxMsSinceWorldStartup", measurement(joinCommandEnd, "MAX") * 1000.0);
            putPhaseMetrics(result, "capacityPhase", rejected == null ? "Capacity+1 rejection (not tested below capacity)"
                    : "From opening the capacity+1 socket until FULL rejection",
                capacityStartTicks, capacityEndTicks, capacityStartOverruns, capacityEndOverruns);
            var steadyState = result.putObject("steadyState");
            steadyState.put("warmupDurationSeconds", warmupSeconds);
            steadyState.put("requestedDurationSeconds", steadyStateSeconds);
            steadyState.put("measuredDurationMs", TimeUnit.NANOSECONDS.toMillis(steadyEndedAt - steadyStartedAt));
            steadyState.put("tickCount", steadyTickCount);
            steadyState.put("tickMeanMs", steadyTickCount == 0 ? 0 : steadyTickTotalSeconds * 1000.0 / steadyTickCount);
            steadyState.put("tickOverrunsOver50ms", steadyTickOverruns);
            steadyState.put("tickMaxMsAtPhaseEnd", measurement(steadyEndTicks, "max") * 1000.0);
            steadyState.put("tickMaxScope", "Actuator timer max at phase end; cumulative since packaged World startup");
            steadyState.put("tickP95Available", steadyTickP95Ms != null);
            steadyState.put("tickP95Scope", "Dedicated p95 gauge from a 3 x 10-second rolling histogram, read after the measured movement phase");
            if (steadyTickP95Ms != null) steadyState.put("tickP95Ms", steadyTickP95Ms);
            var rollingP95 = steadyState.putArray("sampledRollingP95Ms");
            rollingP95Samples.forEach(rollingP95::add);
            var samples = steadyState.putArray("resourceSamples");
            samples.addAll(resourceSamples);
            var finalSample = samples.addObject();
            finalSample.put("elapsedSeconds", TimeUnit.NANOSECONDS.toSeconds(steadyEndedAt - steadyStartedAt));
            if (steadyTickP95Ms != null) finalSample.put("rollingTickP95Ms", steadyTickP95Ms);
            finalSample.put("serverTickCount", steadyTickCount);
            finalSample.put("serverTickOverruns", steadyTickOverruns);
            finalSample.put("serverHeapUsedBytes", measurement(steadyHeap, "VALUE"));
            finalSample.put("serverCommandQueueSize", measurement(steadyQueue, "VALUE"));
            finalSample.put("serverJoinQueueSize", measurement(steadyJoinQueue, "VALUE"));
            finalSample.put("activePlayers", measurement(steadyPlayers, "VALUE"));
            finalSample.put("activeConnections", measurement(steadyConnections, "VALUE"));
            finalSample.put("loadGeneratorHeapUsedBytes", loadGeneratorHeap.getUsed());
            steadyState.put("sampledRollingP95WindowCount", rollingP95Samples.size());
            if (!rollingP95Samples.isEmpty()) {
                steadyState.put("sampledRollingP95MaximumMs", rollingP95Samples.stream().mapToDouble(Double::doubleValue).max().orElseThrow());
                steadyState.put("sampledRollingP95WindowsOver25Ms", rollingP95Samples.stream().filter(value -> value >= 25.0).count());
            }
            steadyState.put("activePlayersAtPhaseEnd", measurement(steadyPlayers, "VALUE"));
            steadyState.put("activeConnectionsAtPhaseEnd", measurement(steadyConnections, "VALUE"));
            steadyState.put("commandQueueSizeAtPhaseEnd", measurement(steadyQueue, "VALUE"));
            steadyState.put("joinQueueSizeAtPhaseEnd", measurement(steadyJoinQueue, "VALUE"));
            steadyState.put("serverHeapUsedBytesAtPhaseEnd", measurement(steadyHeap, "VALUE"));
            result.put("commandQueueCapacity", measurement(queueCapacity, "VALUE"));
            result.put("joinQueueCapacity", measurement(metric(metricsBase, "hufs.world.join.queue.capacity"), "VALUE"));
            Files.createDirectories(Path.of(output).getParent());
            json.writerWithDefaultPrettyPrinter().writeValue(Path.of(output).toFile(), result);
            System.out.println("ISOLATED_WORLD_LOAD_RESULT " + json.writeValueAsString(result));
        } finally {
            for (Probe probe : probes) if (probe.socket != null) probe.socket.abort();
            pool.shutdownNow();
            pool.awaitTermination(5, TimeUnit.SECONDS);
        }
    }

    private Probe connect(String endpoint, int expectedPopulation) throws Exception {
        Probe probe = new Probe(expectedPopulation);
        probe.socket = http.newWebSocketBuilder().connectTimeout(Duration.ofSeconds(10))
            .header("Origin", "http://localhost:5173")
            .buildAsync(URI.create(endpoint), probe).get(12, TimeUnit.SECONDS);
        return probe;
    }

    private JsonNode metric(String base, String name) throws Exception {
        HttpRequest request = HttpRequest.newBuilder(URI.create(base + "/actuator/metrics/" + name))
            .timeout(Duration.ofSeconds(5)).GET().build();
        HttpResponse<String> response = http.send(request, HttpResponse.BodyHandlers.ofString());
        assertEquals(200, response.statusCode(), "server metric available: " + name + " response=" + response.body());
        return json.readTree(response.body());
    }

    private Double optionalMeasurement(String base, String name, String statistic) throws Exception {
        HttpRequest request = HttpRequest.newBuilder(URI.create(base + "/actuator/metrics/" + name))
            .timeout(Duration.ofSeconds(5)).GET().build();
        HttpResponse<String> response = http.send(request, HttpResponse.BodyHandlers.ofString());
        if (response.statusCode() != 200) return null;
        JsonNode percentileMetric = json.readTree(response.body());
        for (JsonNode item : percentileMetric.path("measurements"))
            if (statistic.equalsIgnoreCase(item.path("statistic").asText())) return item.path("value").asDouble() * 1000.0;
        return null;
    }

    private Map<String, JsonNode> actorPhaseMetrics(String base) throws Exception {
        List<String> phases = List.of("commands", "joins", "simulation", "room_state", "maintenance",
            "media_policy", "snapshots", "snapshot_view", "snapshot_fanout", "snapshot_prepare", "snapshot_encode",
            "snapshot_queue", "publication");
        var requests = new LinkedHashMap<String, CompletableFuture<JsonNode>>();
        for (String phase : phases) {
            String name = "hufs.world.tick.phase.duration?tag=phase%3A" + phase;
            HttpRequest request = HttpRequest.newBuilder(URI.create(base + "/actuator/metrics/" + name))
                .timeout(Duration.ofSeconds(5)).GET().build();
            requests.put(phase, http.sendAsync(request, HttpResponse.BodyHandlers.ofString()).thenApply(response -> {
                assertEquals(200, response.statusCode(), "server phase metric available: " + name + " response=" + response.body());
                try { return json.readTree(response.body()); }
                catch (java.io.IOException error) { throw new CompletionException(error); }
            }));
        }
        CompletableFuture.allOf(requests.values().toArray(CompletableFuture[]::new)).get(5, TimeUnit.SECONDS);
        var measurements = new LinkedHashMap<String, JsonNode>();
        requests.forEach((phase, request) -> measurements.put(phase, request.join()));
        return Map.copyOf(measurements);
    }

    private void putActorPhaseWork(com.fasterxml.jackson.databind.node.ObjectNode joinPhase,
                                   Map<String, JsonNode> start, Map<String, JsonNode> end) {
        var phases = joinPhase.putObject("actorPhaseWork");
        for (String phaseName : List.of("commands", "joins", "simulation", "room_state", "maintenance",
            "media_policy", "snapshots", "snapshot_view", "snapshot_fanout", "snapshot_prepare", "snapshot_encode",
            "snapshot_queue", "publication")) {
            double count = measurement(end.get(phaseName), "COUNT") - measurement(start.get(phaseName), "COUNT");
            double totalMs = (measurement(end.get(phaseName), "TOTAL_TIME") - measurement(start.get(phaseName), "TOTAL_TIME")) * 1000.0;
            var phase = phases.putObject(phaseName);
            phase.put("tickCount", count);
            phase.put("totalMs", totalMs);
            phase.put("meanMsPerTick", count == 0 ? 0 : totalMs / count);
            phase.put("maxMsSinceWorldStartup", measurement(end.get(phaseName), "MAX") * 1000.0);
        }
    }

    private Map<String, JsonNode> joinStageMetrics(String base) throws Exception {
        List<String> phases = List.of("map_prepare", "player_attach", "initial_messages");
        var requests = new LinkedHashMap<String, CompletableFuture<JsonNode>>();
        for (String phase : phases) {
            String name = "hufs.world.join.phase.duration?tag=phase%3A" + phase;
            HttpRequest request = HttpRequest.newBuilder(URI.create(base + "/actuator/metrics/" + name))
                .timeout(Duration.ofSeconds(5)).GET().build();
            requests.put(phase, http.sendAsync(request, HttpResponse.BodyHandlers.ofString()).thenApply(response -> {
                assertEquals(200, response.statusCode(), "server join phase metric available: " + name + " response=" + response.body());
                try { return json.readTree(response.body()); }
                catch (java.io.IOException error) { throw new CompletionException(error); }
            }));
        }
        CompletableFuture.allOf(requests.values().toArray(CompletableFuture[]::new)).get(5, TimeUnit.SECONDS);
        var measurements = new LinkedHashMap<String, JsonNode>();
        requests.forEach((phase, request) -> measurements.put(phase, request.join()));
        return Map.copyOf(measurements);
    }

    private void putJoinStageWork(com.fasterxml.jackson.databind.node.ObjectNode joinPhase,
                                  Map<String, JsonNode> start, Map<String, JsonNode> end) {
        var phases = joinPhase.putObject("joinStages");
        for (String phaseName : List.of("map_prepare", "player_attach", "initial_messages")) {
            double count = measurement(end.get(phaseName), "COUNT") - measurement(start.get(phaseName), "COUNT");
            double totalMs = (measurement(end.get(phaseName), "TOTAL_TIME") - measurement(start.get(phaseName), "TOTAL_TIME")) * 1000.0;
            var phase = phases.putObject(phaseName);
            phase.put("count", count);
            phase.put("totalMs", totalMs);
            phase.put("meanMs", count == 0 ? 0 : totalMs / count);
            phase.put("maxMsSinceWorldStartup", measurement(end.get(phaseName), "MAX") * 1000.0);
        }
    }

    private JsonNode awaitMetricValue(String base, String name, double expected, Duration timeout) throws Exception {
        long deadline = System.nanoTime() + timeout.toNanos();
        JsonNode latest;
        do {
            latest = metric(base, name);
            if (Math.abs(measurement(latest, "VALUE") - expected) < 0.001) return latest;
            Thread.sleep(25);
        } while (System.nanoTime() < deadline);
        fail("Metric did not reach " + expected + " within " + timeout + ": " + name + " latest=" + latest);
        return latest;
    }

    private double measurement(JsonNode metric, String statistic) {
        for (JsonNode item : metric.path("measurements"))
            if (statistic.equalsIgnoreCase(item.path("statistic").asText())) return item.path("value").asDouble();
        fail("Metric measurement missing: " + statistic + " in " + metric);
        return Double.NaN;
    }

    private com.fasterxml.jackson.databind.node.ObjectNode putPhaseMetrics(com.fasterxml.jackson.databind.node.ObjectNode result,
                                 String name, String scope, JsonNode startTicks, JsonNode endTicks,
                                 JsonNode startOverruns, JsonNode endOverruns) {
        double tickCount = measurement(endTicks, "COUNT") - measurement(startTicks, "COUNT");
        double tickTotalSeconds = measurement(endTicks, "TOTAL_TIME") - measurement(startTicks, "TOTAL_TIME");
        double overrunCount = measurement(endOverruns, "COUNT") - measurement(startOverruns, "COUNT");
        var phase = result.putObject(name);
        phase.put("scope", scope);
        phase.put("tickCount", tickCount);
        phase.put("tickMeanMs", tickCount == 0 ? 0 : tickTotalSeconds * 1000.0 / tickCount);
        phase.put("tickOverrunsOver50ms", overrunCount);
        phase.put("tickMaxMsAtPhaseEnd", measurement(endTicks, "MAX") * 1000.0);
        phase.put("tickMaxScope", "Actuator timer max at phase end; cumulative since packaged World startup");
        return phase;
    }

    private String joinMessage(String name) {
        return "{\"type\":\"join\",\"protocolVersion\":2,\"name\":\"" + name
            + "\",\"avatar\":0,\"skin\":\"light\",\"clothing\":\"casual_white\",\"hair\":\"hair_short_black\",\"resumeToken\":\"\"}";
    }

    private String optionalProperty(String key) {
        String envKey = "HUFS_" + key.replaceAll("([a-z])([A-Z])", "$1_$2").toUpperCase();
        String value = System.getProperty(key, System.getenv(envKey));
        return value == null || value.isBlank() ? null : value;
    }

    private int integerProperty(String key, int defaultValue) {
        String value = optionalProperty(key);
        return value == null ? defaultValue : Integer.parseInt(value);
    }

    private long longProperty(String key, long defaultValue) {
        String value = optionalProperty(key);
        return value == null ? defaultValue : Long.parseLong(value);
    }

    private final class Probe implements WebSocket.Listener {
        private final int expectedPopulation;
        private WebSocket socket;
        private final CompletableFuture<JsonNode> welcome = new CompletableFuture<>();
        private final CompletableFuture<Void> fullSpaceRoster = new CompletableFuture<>();
        private final BlockingQueue<JsonNode> messages = new LinkedBlockingQueue<>();
        private final AtomicBoolean captureMessages = new AtomicBoolean();
        private final Set<String> visibleIds = ConcurrentHashMap.newKeySet();
        private final Set<String> spaceParticipantIds = ConcurrentHashMap.newKeySet();
        private final StringBuilder fragments = new StringBuilder();
        private final AtomicReference<Throwable> parseFailure = new AtomicReference<>();
        private final AtomicReference<String> socketErrorClass = new AtomicReference<>("");
        private final AtomicInteger closeCode = new AtomicInteger(-1);
        private final AtomicBoolean movementEnabled = new AtomicBoolean();
        private final AtomicBoolean movementSendPending = new AtomicBoolean();
        private final AtomicBoolean positionInitialized = new AtomicBoolean();
        private final AtomicBoolean observedMovement = new AtomicBoolean();
        private final AtomicInteger movementSequence = new AtomicInteger();
        private final AtomicLong movementMessagesSubmitted = new AtomicLong();
        private volatile String playerId = "";
        private volatile long epoch;
        private volatile double previousX;
        private volatile double previousY;
        private int movementOffset;

        private Probe(int expectedPopulation) { this.expectedPopulation = expectedPopulation; }

        void captureMessages() { captureMessages.set(true); }

        void startMovement(int offset) {
            JsonNode joined = welcome.join();
            playerId = joined.path("playerId").asText();
            epoch = joined.path("epoch").asLong();
            movementOffset = offset;
            movementEnabled.set(true);
        }

        @Override public void onOpen(WebSocket webSocket) { webSocket.request(1); }

        @Override public CompletionStage<?> onClose(WebSocket webSocket, int statusCode, String reason) {
            closeCode.compareAndSet(-1, statusCode);
            return CompletableFuture.completedFuture(null);
        }

        @Override public void onError(WebSocket webSocket, Throwable error) {
            socketErrorClass.compareAndSet("", error.getClass().getName());
        }

        @Override public CompletionStage<?> onText(WebSocket webSocket, CharSequence data, boolean last) {
            fragments.append(data);
            if (last) {
                try {
                    JsonNode node = json.readTree(fragments.toString());
                    if (captureMessages.get()) messages.add(node);
                    if (node.path("type").asText().equals("welcome")) welcome.complete(node);
                    if (node.path("type").asText().equals("spaceParticipants")) {
                        spaceParticipantIds.clear();
                        node.path("participants").forEach(participant -> {
                            String participantId = participant.path("playerId").asText();
                            if (!participantId.isBlank()) spaceParticipantIds.add(participantId);
                        });
                        if (spaceParticipantIds.size() == expectedPopulation) fullSpaceRoster.complete(null);
                    }
                    if (node.path("type").asText().equals("snapshot")) {
                        if (node.path("full").asBoolean()) visibleIds.clear();
                        node.path("players").forEach(player -> {
                            String id = player.path("id").asText();
                            visibleIds.add(id);
                            if (id.equals(playerId)) {
                                double x = player.path("x").asDouble();
                                double y = player.path("y").asDouble();
                                if (positionInitialized.get() && (Math.abs(x - previousX) > 0.01 || Math.abs(y - previousY) > 0.01))
                                    observedMovement.set(true);
                                previousX = x;
                                previousY = y;
                                positionInitialized.set(true);
                            }
                        });
                        node.path("removedPlayerIds").forEach(id -> visibleIds.remove(id.asText()));
                        webSocket.sendText("{\"type\":\"snapshotAck\",\"tick\":" + node.path("tick").asLong()
                            + ",\"applied\":true}", true).whenComplete((sent, error) -> {
                                if (error != null) parseFailure.compareAndSet(null, error);
                                else sendMovement(webSocket);
                            });
                    }
                } catch (Throwable error) {
                    parseFailure.compareAndSet(null, error);
                    welcome.completeExceptionally(error);
                    fullSpaceRoster.completeExceptionally(error);
                }
                fragments.setLength(0);
            }
            webSocket.request(1);
            return null;
        }

        synchronized void send(String message) { socket.sendText(message, true).join(); }

        private void sendMovement(WebSocket webSocket) {
            if (!movementEnabled.get() || !movementSendPending.compareAndSet(false, true)) return;
            int sequence = movementSequence.getAndIncrement();
            int direction = (sequence / 20 + movementOffset) % 4;
            int dx = direction == 0 ? 1 : direction == 2 ? -1 : 0;
            int dy = direction == 1 ? 1 : direction == 3 ? -1 : 0;
            boolean running = sequence % 4 == 0;
            String input = "{\"type\":\"move\",\"epoch\":" + epoch + ",\"seq\":" + sequence
                + ",\"dx\":" + dx + ",\"dy\":" + dy + ",\"running\":" + running + "}";
            movementMessagesSubmitted.incrementAndGet();
            webSocket.sendText(input, true).whenComplete((sent, error) -> {
                if (error != null) parseFailure.compareAndSet(null, error);
                movementSendPending.set(false);
            });
        }

        JsonNode await(Predicate<JsonNode> predicate) throws Exception {
            long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(10);
            while (System.nanoTime() < deadline) {
                Throwable error = parseFailure.get();
                if (error != null) throw new AssertionError("WebSocket JSON decoding failed", error);
                JsonNode message = messages.poll(100, TimeUnit.MILLISECONDS);
                if (message != null && predicate.test(message)) return message;
            }
            List<String> received = messages.stream().limit(20)
                .map(node -> node.path("type").asText("unknown")
                    + (node.path("code").isMissingNode() ? "" : ":" + node.path("code").asText()))
                .toList();
            throw new AssertionError("Timed out waiting for expected WebSocket event; closeCode="
                + closeCode.get() + ", socketError=" + socketErrorClass.get() + ", received=" + received);
        }
    }
}
