# HUFS SSO 계정 유형

로그인과 신규 Town 계정 연결은 HUFS 통합 인증(SSO)만 사용한다. 일반 이메일·비밀번호 가입 및 로그인은 제공하지 않는다. 기존 배포에 남아 있을 수 있는 `public_password_account` 표와 탈퇴 시 자격 증명 정리는 과거 데이터 호환을 위해 유지하지만, 이 표에 접근하는 인증 API는 없다.

SSO가 반환한 학적·계정 유형은 다음 일곱 범주 모두 로그인을 허용한다: `ENROLLED`, `LEAVE_OF_ABSENCE`, `GRADUATED`, `FACULTY`, `STAFF`, `COMMON_ACCOUNT`, `UNKNOWN`. 이전 SSO 값도 대응하며, 비어 있지 않은 새 상태 문자열은 `UNKNOWN`으로 취급해 인증된 HUFS 계정의 입장을 막지 않는다. 상태가 누락되거나 공백이면 잘못된 인증 응답으로 거부한다.

계정 연결 키는 계속 SSO UUID다. 이메일은 계정 연결에 사용하지 않는다.
