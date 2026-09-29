package town.hufs.api.calendar;

final class CalendarIntegrationFailure extends RuntimeException {
    private final String code;
    private final int status;

    CalendarIntegrationFailure(String code, int status) {
        super(code);
        this.code = code;
        this.status = status;
    }

    String code() { return code; }
    int status() { return status; }
}
