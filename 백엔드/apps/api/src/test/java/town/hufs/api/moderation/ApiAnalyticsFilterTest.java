package town.hufs.api.moderation;

import jakarta.servlet.ServletException;
import org.junit.jupiter.api.Test;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.mock.web.MockHttpServletResponse;

import java.io.IOException;

import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;

class ApiAnalyticsFilterTest {
    private final ApiAnalyticsRecorder recorder = mock(ApiAnalyticsRecorder.class);
    private final ApiAnalyticsFilter filter = new ApiAnalyticsFilter(recorder);

    @Test
    void recordsServerErrorsWithoutRecordingClientRejections() throws ServletException, IOException {
        MockHttpServletRequest request = new MockHttpServletRequest();
        MockHttpServletResponse response = new MockHttpServletResponse();
        filter.doFilter(request, response, (incoming, outgoing) ->
            ((MockHttpServletResponse) outgoing).setStatus(500));

        verify(recorder, times(1)).recordServerError();

        MockHttpServletResponse clientRejection = new MockHttpServletResponse();
        filter.doFilter(request, clientRejection, (incoming, outgoing) ->
            ((MockHttpServletResponse) outgoing).setStatus(403));
        verify(recorder, times(1)).recordServerError();
    }

    @Test
    void recordsUncaughtApiFailuresOnceAndRethrowsThem() {
        MockHttpServletRequest request = new MockHttpServletRequest();
        MockHttpServletResponse response = new MockHttpServletResponse();

        assertThatThrownBy(() -> filter.doFilter(request, response, (incoming, outgoing) -> {
            throw new ServletException("sensitive request detail");
        })).isInstanceOf(ServletException.class);

        verify(recorder, times(1)).recordServerError();
    }
}
