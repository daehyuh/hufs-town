package town.hufs.api.calendar;

import org.springframework.dao.DataAccessException;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;

import java.util.Map;

@RestControllerAdvice(basePackageClasses = CalendarIntegrationErrors.class)
class CalendarIntegrationErrors {
    @ExceptionHandler(CalendarIntegrationFailure.class)
    ResponseEntity<?> calendar(CalendarIntegrationFailure failure) {
        return ResponseEntity.status(failure.status()).body(Map.of(
            "code", failure.code(), "message", message(failure.code())));
    }

    @ExceptionHandler(DataAccessException.class)
    ResponseEntity<?> storageUnavailable() {
        return ResponseEntity.status(503).body(Map.of(
            "code", "CALENDAR_STORAGE_UNAVAILABLE", "message", "일정 연결 정보를 불러오지 못했어요. 잠시 후 다시 시도해 주세요."));
    }

    private static String message(String code) {
        return switch (code) {
            case "AUTH_REQUIRED" -> "로그인한 뒤 다시 시도해 주세요.";
            case "CALENDAR_RATE_LIMIT" -> "연결 요청이 많아요. 잠시 후 다시 시도해 주세요.";
            case "CALENDAR_OAUTH_STATE_INVALID" -> "일정 연결 요청이 만료되었어요. 다시 연결해 주세요.";
            case "CALENDAR_NOT_CONFIGURED" -> "캘린더 연결 설정을 준비하고 있어요.";
            case "CALENDAR_RECONNECT_REQUIRED" -> "캘린더 권한이 만료되었어요. 다시 연결해 주세요.";
            case "CALENDAR_REMOTE_CONFLICT" -> "Google Calendar에서 일정이 바뀌었어요. 동기화 충돌을 확인해 주세요.";
            case "CALENDAR_REMOTE_NOT_FOUND" -> "Google Calendar 일정을 찾을 수 없어요.";
            case "CALENDAR_SYNC_ITEM_NOT_FOUND" -> "동기화 충돌 항목을 찾을 수 없어요.";
            case "CALENDAR_TOKEN_STORAGE_UNAVAILABLE", "CALENDAR_TOKEN_UNAVAILABLE" -> "캘린더 보안 정보를 읽지 못했어요. 다시 연결해 주세요.";
            default -> "Google Calendar에 연결하지 못했어요. 잠시 후 다시 시도해 주세요.";
        };
    }
}
