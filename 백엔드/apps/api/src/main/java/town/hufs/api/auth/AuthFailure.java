package town.hufs.api.auth;

import org.springframework.http.HttpStatus;

final class AuthFailure extends RuntimeException {
    final HttpStatus status;
    final String code;
    AuthFailure(HttpStatus status, String code, String message) { super(message); this.status = status; this.code = code; }
    static AuthFailure login() { return new AuthFailure(HttpStatus.UNAUTHORIZED, "SSO_LOGIN_FAILED", "로그인 코드가 만료되었거나 유효하지 않아요. 다시 로그인해 주세요."); }
}
