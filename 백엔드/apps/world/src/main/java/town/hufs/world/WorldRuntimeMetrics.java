package town.hufs.world;

import io.micrometer.core.instrument.Counter;
import io.micrometer.core.instrument.Gauge;
import io.micrometer.core.instrument.MeterRegistry;
import io.micrometer.core.instrument.Timer;

import java.util.Map;
import java.util.LinkedHashMap;
import java.util.List;
import java.time.Duration;
import java.util.concurrent.BlockingQueue;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

final class WorldRuntimeMetrics {
    private static final long TICK_BUDGET_NANOS = TimeUnit.MILLISECONDS.toNanos(50);
    private static final double TICK_P95_PERCENTILE = 0.95;
    private static final Duration TICK_PERCENTILE_WINDOW = Duration.ofSeconds(10);
    private static final int TICK_PERCENTILE_WINDOWS = 3;
    private static final List<String> TICK_PHASES = List.of(
        "commands", "joins", "simulation", "room_state", "maintenance", "media_policy", "snapshots",
        "snapshot_view", "snapshot_fanout", "snapshot_prepare", "snapshot_encode", "snapshot_queue", "publication"
    );
    private static final List<String> JOIN_PHASES = List.of("capacity_reject", "map_prepare", "player_attach", "initial_messages");

    private final Timer tickDuration;
    private final Timer joinCommandDuration;
    private final Map<String, Timer> tickPhaseDurations;
    private final Map<String, Timer> joinPhaseDurations;
    private final Counter tickOverruns;
    private final Counter rejectedCommands;
    private final Counter rejectedJoinCommands;
    private final AtomicInteger activePlayers = new AtomicInteger();

    WorldRuntimeMetrics(MeterRegistry registry, BlockingQueue<?> commands, Map<?, ?> connections) {
        this(registry, commands, null, connections);
    }

    WorldRuntimeMetrics(MeterRegistry registry, BlockingQueue<?> commands, BlockingQueue<?> joins, Map<?, ?> connections) {
        tickDuration = Timer.builder("hufs.world.tick.duration")
            .description("Duration of one authoritative world actor tick")
            .publishPercentiles(TICK_P95_PERCENTILE)
            .distributionStatisticExpiry(TICK_PERCENTILE_WINDOW)
            .distributionStatisticBufferLength(TICK_PERCENTILE_WINDOWS)
            .register(registry);
        var phaseTimers = new LinkedHashMap<String, Timer>();
        for (String phase : TICK_PHASES) {
            phaseTimers.put(phase, Timer.builder("hufs.world.tick.phase.duration")
                .tag("phase", phase)
                .description("Duration of a bounded phase inside one authoritative world actor tick")
                .publishPercentiles(TICK_P95_PERCENTILE)
                .distributionStatisticExpiry(TICK_PERCENTILE_WINDOW)
                .distributionStatisticBufferLength(TICK_PERCENTILE_WINDOWS)
                .register(registry));
        }
        tickPhaseDurations = Map.copyOf(phaseTimers);
        var joinPhaseTimers = new LinkedHashMap<String, Timer>();
        for (String phase : JOIN_PHASES) {
            joinPhaseTimers.put(phase, Timer.builder("hufs.world.join.phase.duration")
                .tag("phase", phase)
                .description("Duration of a bounded stage inside a world join decision")
                .publishPercentiles(TICK_P95_PERCENTILE)
                .distributionStatisticExpiry(TICK_PERCENTILE_WINDOW)
                .distributionStatisticBufferLength(TICK_PERCENTILE_WINDOWS)
                .register(registry));
        }
        joinPhaseDurations = Map.copyOf(joinPhaseTimers);
        joinCommandDuration = Timer.builder("hufs.world.join.command.duration")
            .description("Duration of one accepted world join actor command")
            .publishPercentiles(TICK_P95_PERCENTILE)
            .distributionStatisticExpiry(TICK_PERCENTILE_WINDOW)
            .distributionStatisticBufferLength(TICK_PERCENTILE_WINDOWS)
            .register(registry);
        Gauge.builder("hufs.world.tick.duration.p95", tickDuration, WorldRuntimeMetrics::tickP95Seconds)
            .description("Rolling p95 of authoritative world actor tick duration over approximately 30 seconds")
            .baseUnit("seconds")
            .register(registry);
        tickOverruns = Counter.builder("hufs.world.tick.overruns")
            .description("World ticks that exceeded the 50 ms tick budget")
            .register(registry);
        rejectedCommands = Counter.builder("hufs.world.command.queue.rejected")
            .description("Commands rejected because the world actor queue is full")
            .register(registry);
        rejectedJoinCommands = Counter.builder("hufs.world.join.queue.rejected")
            .description("Join commands rejected because the world join queue is full")
            .register(registry);
        Gauge.builder("hufs.world.command.queue.size", commands, BlockingQueue::size)
            .description("Current number of commands waiting for the world actor")
            .register(registry);
        Gauge.builder("hufs.world.command.queue.capacity", commands, queue -> queue.size() + queue.remainingCapacity())
            .description("Maximum number of commands the world actor queue can hold")
            .register(registry);
        if (joins != null) {
            Gauge.builder("hufs.world.join.queue.size", joins, BlockingQueue::size)
                .description("Current number of join commands waiting for the world actor")
                .register(registry);
            Gauge.builder("hufs.world.join.queue.capacity", joins, queue -> queue.size() + queue.remainingCapacity())
                .description("Maximum number of join commands the world actor join queue can hold")
                .register(registry);
        }
        Gauge.builder("hufs.world.players.active", activePlayers, AtomicInteger::get)
            .description("Players currently owned by this world process")
            .register(registry);
        Gauge.builder("hufs.world.connections.active", connections, Map::size)
            .description("WebSocket connections currently held by this world process")
            .register(registry);
    }

    void recordTick(long durationNanos, int playerCount) {
        tickDuration.record(durationNanos, TimeUnit.NANOSECONDS);
        if (durationNanos > TICK_BUDGET_NANOS) tickOverruns.increment();
        activePlayers.set(playerCount);
    }

    void recordTickPhase(String phase, long durationNanos) {
        Timer timer = tickPhaseDurations.get(phase);
        if (timer == null) throw new IllegalArgumentException("Unknown world tick phase: " + phase);
        timer.record(durationNanos, TimeUnit.NANOSECONDS);
    }

    void recordJoinCommand(long durationNanos) {
        joinCommandDuration.record(durationNanos, TimeUnit.NANOSECONDS);
    }

    void recordJoinPhase(String phase, long durationNanos) {
        Timer timer = joinPhaseDurations.get(phase);
        if (timer == null) throw new IllegalArgumentException("Unknown world join phase: " + phase);
        timer.record(durationNanos, TimeUnit.NANOSECONDS);
    }

    void recordRejectedCommand() { rejectedCommands.increment(); }

    void recordRejectedJoinCommand() { rejectedJoinCommands.increment(); }

    private static double tickP95Seconds(Timer timer) {
        for (var percentile : timer.takeSnapshot().percentileValues())
            if (percentile.percentile() == TICK_P95_PERCENTILE) return percentile.value(TimeUnit.SECONDS);
        return 0;
    }
}
