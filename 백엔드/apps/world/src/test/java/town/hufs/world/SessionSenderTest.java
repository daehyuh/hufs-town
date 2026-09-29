package town.hufs.world;
import org.junit.jupiter.api.Test;
import org.springframework.web.socket.*;
import java.util.ArrayDeque;
import java.util.concurrent.Executor;
import java.util.concurrent.*;
import static org.assertj.core.api.Assertions.*;
import static org.mockito.Mockito.*;

class SessionSenderTest {
    @Test void coalescesSnapshotsButKeepsReliableMessageOrder() throws Exception {
        ArrayDeque<Runnable> tasks = new ArrayDeque<>();
        Executor paused = tasks::add;
        var socket = mock(WebSocketSession.class);
        var sender = new SessionSender(socket, paused);
        sender.offer("welcome", false);
        for (int i=0; i<10_000; i++) sender.offer("snapshot-"+i, true);
        sender.offer("control", false);
        assertThat(sender.pending()).isEqualTo(3);
        assertThat(tasks).hasSize(1);
        tasks.remove().run();
        var order = inOrder(socket);
        order.verify(socket).sendMessage(new TextMessage("welcome"));
        order.verify(socket).sendMessage(new TextMessage("control"));
        order.verify(socket).sendMessage(new TextMessage("snapshot-9999"));
        verifyNoMoreInteractions(socket);
    }
    @Test void refusesAnUnboundedReliableQueue() {
        var sender = new SessionSender(mock(WebSocketSession.class), ignored -> {});
        for(int i=0; i<32; i++) assertThat(sender.offer("control", false)).isTrue();
        assertThat(sender.offer("overflow", false)).isFalse();
    }

    @Test void aSlowSocketDoesNotBlockAnotherSessionsSender() throws Exception {
        var sends = Executors.newFixedThreadPool(2);
        var slowSocket = mock(WebSocketSession.class);
        var fastSocket = mock(WebSocketSession.class);
        var slowEntered = new CountDownLatch(1);
        var releaseSlow = new CountDownLatch(1);
        var fastSent = new CountDownLatch(1);
        doAnswer(invocation -> {
            slowEntered.countDown();
            if (!releaseSlow.await(3, TimeUnit.SECONDS))
                throw new AssertionError("slow socket was not released");
            return null;
        }).when(slowSocket).sendMessage(any(TextMessage.class));
        doAnswer(invocation -> {
            fastSent.countDown();
            return null;
        }).when(fastSocket).sendMessage(any(TextMessage.class));

        try {
            var slowSender = new SessionSender(slowSocket, sends);
            var fastSender = new SessionSender(fastSocket, sends);
            assertThat(slowSender.offer("slow", false)).isTrue();
            assertThat(slowEntered.await(1, TimeUnit.SECONDS)).isTrue();
            assertThat(slowSender.stalled(System.nanoTime() + TimeUnit.SECONDS.toNanos(4))).isTrue();
            assertThat(fastSender.offer("fast", false)).isTrue();
            assertThat(fastSent.await(1, TimeUnit.SECONDS)).isTrue();
            releaseSlow.countDown();
            verify(slowSocket, timeout(1000)).sendMessage(new TextMessage("slow"));
            verify(fastSocket).sendMessage(new TextMessage("fast"));
        } finally {
            releaseSlow.countDown();
            sends.shutdownNow();
            assertThat(sends.awaitTermination(2, TimeUnit.SECONDS)).isTrue();
        }
    }

    @Test void closingSenderDropsQueuedFramesAndRejectsFurtherWrites() throws Exception {
        ArrayDeque<Runnable> tasks = new ArrayDeque<>();
        var socket = mock(WebSocketSession.class);
        var sender = new SessionSender(socket, tasks::add);
        assertThat(sender.offer("control", false)).isTrue();
        assertThat(sender.offer("snapshot", true)).isTrue();
        assertThat(sender.pending()).isEqualTo(2);

        sender.close();
        assertThat(sender.pending()).isZero();
        assertThat(sender.offer("after-close", false)).isFalse();
        tasks.remove().run();
        verify(socket).close(CloseStatus.NORMAL);
        verifyNoMoreInteractions(socket);
    }
}
