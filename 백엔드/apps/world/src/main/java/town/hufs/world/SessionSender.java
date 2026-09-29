package town.hufs.world;

import org.springframework.web.socket.*;
import java.io.IOException;
import java.util.ArrayDeque;
import java.util.concurrent.Executor;
import java.util.concurrent.RejectedExecutionException;

/** Reliable control queue plus one replaceable world snapshot patch based on the client's acknowledged tick. */
final class SessionSender {
    private final WebSocketSession session;
    private final Executor executor;
    private final ArrayDeque<String> control = new ArrayDeque<>();
    private String snapshot;
    private boolean draining;
    private boolean closed;
    private volatile long writeStarted;
    SessionSender(WebSocketSession session, Executor executor) { this.session = session; this.executor = executor; }
    synchronized boolean offer(String payload, boolean replaceable) {
        if (closed) return false;
        if (replaceable) snapshot = payload;
        else {
            if (control.size() >= 32) { closed = true; return false; }
            control.add(payload);
        }
        if (!draining) {
            draining = true;
            try { executor.execute(this::drain); }
            catch (RejectedExecutionException e) { closed = true; draining = false; return false; }
        }
        return true;
    }
    private void drain() {
        try {
            while (true) {
                String next;
                synchronized (this) {
                    if (closed) { draining = false; return; }
                    next = control.poll();
                    if (next == null) { next = snapshot; snapshot = null; }
                    if (next == null) { draining = false; return; }
                }
                writeStarted = System.nanoTime();
                session.sendMessage(new TextMessage(next));
                writeStarted = 0;
            }
        } catch (IOException | RuntimeException e) { close(); }
    }
    boolean stalled(long now) { return writeStarted != 0 && now - writeStarted > 3_000_000_000L; }
    synchronized int pending() { return control.size() + (snapshot == null ? 0 : 1); }
    void close() {
        synchronized (this) { closed = true; snapshot = null; control.clear(); }
        try { session.close(CloseStatus.NORMAL); } catch (IOException ignored) { }
    }
}
