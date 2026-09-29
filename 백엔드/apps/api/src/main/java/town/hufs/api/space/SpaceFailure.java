package town.hufs.api.space;

final class SpaceFailure extends RuntimeException {
    final int status; final String code;
    SpaceFailure(int status, String code, String message) { super(message); this.status = status; this.code = code; }
}
