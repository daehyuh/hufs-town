package town.hufs.world;

import io.micrometer.core.instrument.simple.SimpleMeterRegistry;
import org.springframework.boot.actuate.metrics.MetricsEndpoint;
import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.TimeUnit;

import static org.assertj.core.api.Assertions.assertThat;

class WorldRuntimeMetricsTest {
    @Test void recordsTickBudgetQueueAndProcessGauges() {
        var registry = new SimpleMeterRegistry();
        var commands = new ArrayBlockingQueue<Runnable>(4);
        var joins = new ArrayBlockingQueue<Runnable>(3);
        var connections = new ConcurrentHashMap<String, Object>();
        var metrics = new WorldRuntimeMetrics(registry, commands, joins, connections);
        commands.add(() -> {});
        joins.add(() -> {});
        joins.add(() -> {});
        connections.put("socket", new Object());

        metrics.recordTick(20_000_000, 3);
        metrics.recordTick(75_000_000, 5);
        metrics.recordRejectedCommand();
        metrics.recordRejectedJoinCommand();

        assertThat(registry.get("hufs.world.tick.duration").timer().count()).isEqualTo(2);
        assertThat(registry.get("hufs.world.tick.overruns").counter().count()).isEqualTo(1);
        assertThat(registry.get("hufs.world.command.queue.rejected").counter().count()).isEqualTo(1);
        assertThat(registry.get("hufs.world.join.queue.rejected").counter().count()).isEqualTo(1);
        assertThat(registry.get("hufs.world.command.queue.size").gauge().value()).isEqualTo(1);
        assertThat(registry.get("hufs.world.command.queue.capacity").gauge().value()).isEqualTo(4);
        assertThat(registry.get("hufs.world.join.queue.size").gauge().value()).isEqualTo(2);
        assertThat(registry.get("hufs.world.join.queue.capacity").gauge().value()).isEqualTo(3);
        assertThat(registry.get("hufs.world.players.active").gauge().value()).isEqualTo(5);
        assertThat(registry.get("hufs.world.connections.active").gauge().value()).isEqualTo(1);
    }

    @Test void exposesAThirtySecondRollingTickP95ThroughActuator() {
        var registry = new SimpleMeterRegistry();
        var metrics = new WorldRuntimeMetrics(registry, new ArrayBlockingQueue<Runnable>(4), new ConcurrentHashMap<>());
        for (int sampleMs = 1; sampleMs <= 100; sampleMs++)
            metrics.recordTick(TimeUnit.MILLISECONDS.toNanos(sampleMs), 10);

        var response = new MetricsEndpoint(registry).metric("hufs.world.tick.duration.p95", List.of());

        assertThat(response.getBaseUnit()).isEqualTo("seconds");
        assertThat(response.getDescription()).contains("p95").contains("30 seconds");
        assertThat(response.getMeasurements()).singleElement()
            .satisfies(sample -> {
                assertThat(sample.getStatistic().name()).isEqualTo("VALUE");
                assertThat(sample.getValue()).isBetween(0.09, 0.1);
            });
    }

    @Test void recordsBoundedActorPhaseDurationsByPhaseTag() {
        var registry = new SimpleMeterRegistry();
        var metrics = new WorldRuntimeMetrics(registry, new ArrayBlockingQueue<Runnable>(4), new ConcurrentHashMap<>());

        metrics.recordTickPhase("joins", 12_000_000);
        metrics.recordTickPhase("snapshot_view", 2_000_000);
        metrics.recordTickPhase("snapshot_fanout", 3_000_000);
        metrics.recordTickPhase("snapshot_prepare", 4_000_000);
        metrics.recordTickPhase("snapshot_encode", 5_000_000);
        metrics.recordTickPhase("snapshot_queue", 6_000_000);
        metrics.recordJoinCommand(4_000_000);
        metrics.recordJoinPhase("capacity_reject", 500_000);
        metrics.recordJoinPhase("map_prepare", 1_000_000);

        assertThat(registry.get("hufs.world.tick.phase.duration").tag("phase", "joins").timer().count()).isEqualTo(1);
        assertThat(registry.get("hufs.world.tick.phase.duration").tag("phase", "joins").timer().totalTime(TimeUnit.MILLISECONDS))
            .isEqualTo(12);
        assertThat(registry.get("hufs.world.tick.phase.duration").tag("phase", "snapshots").timer().count()).isZero();
        assertThat(registry.get("hufs.world.tick.phase.duration").tag("phase", "snapshot_view").timer().totalTime(TimeUnit.MILLISECONDS))
            .isEqualTo(2);
        assertThat(registry.get("hufs.world.tick.phase.duration").tag("phase", "snapshot_fanout").timer().totalTime(TimeUnit.MILLISECONDS))
            .isEqualTo(3);
        assertThat(registry.get("hufs.world.tick.phase.duration").tag("phase", "snapshot_prepare").timer().totalTime(TimeUnit.MILLISECONDS))
            .isEqualTo(4);
        assertThat(registry.get("hufs.world.tick.phase.duration").tag("phase", "snapshot_encode").timer().totalTime(TimeUnit.MILLISECONDS))
            .isEqualTo(5);
        assertThat(registry.get("hufs.world.tick.phase.duration").tag("phase", "snapshot_queue").timer().totalTime(TimeUnit.MILLISECONDS))
            .isEqualTo(6);
        assertThat(registry.get("hufs.world.join.command.duration").timer().count()).isEqualTo(1);
        assertThat(registry.get("hufs.world.join.command.duration").timer().totalTime(TimeUnit.MILLISECONDS)).isEqualTo(4);
        assertThat(registry.get("hufs.world.join.phase.duration").tag("phase", "capacity_reject").timer().totalTime(TimeUnit.MILLISECONDS))
            .isEqualTo(0.5);
        assertThat(registry.get("hufs.world.join.phase.duration").tag("phase", "map_prepare").timer().totalTime(TimeUnit.MILLISECONDS))
            .isEqualTo(1);
    }
}
