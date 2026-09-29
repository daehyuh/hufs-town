package town.hufs.api.moderation;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

import java.io.IOException;

@Component
@ConditionalOnProperty(name = "town.storage-mode", havingValue = "mariadb-redis")
final class ApiAnalyticsFilter extends OncePerRequestFilter {
    private final ApiAnalyticsRecorder recorder;

    ApiAnalyticsFilter(ApiAnalyticsRecorder recorder) {
        this.recorder = recorder;
    }

    @Override
    protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response,
                                   FilterChain filterChain) throws ServletException, IOException {
        boolean recorded = false;
        try {
            filterChain.doFilter(request, response);
        } catch (ServletException | IOException | RuntimeException failure) {
            recorder.recordServerError();
            recorded = true;
            throw failure;
        } finally {
            if (!recorded && response.getStatus() >= HttpServletResponse.SC_INTERNAL_SERVER_ERROR)
                recorder.recordServerError();
        }
    }
}
