# ADR 0002 — GDG HUFS SSO와 서비스 전용 세션

날짜: 2026-09-21. 상태: 채택, 실제 IdP 연결은 키 발급 후 검증.

사용자 요청으로 Google OAuth 계획을 GDG HUFS SSO로 교체한다. `hufs-code-master-server`의 `API.md`와 SsoClient/DTO를 로컬에서 확인했다. authorize에 client_id/redirect_uri/state를 보내고 userinfo에 client_id/client_secret/code를 POST하는 커스텀 SSO다.

HUFS Town은 외부 교환 규격을 따르되 state를 서버에서 발급·검증하고 CSRF를 검사한다. provider UUID를 MariaDB 고유 계정으로 연결하고, Spring Security + Spring Session Redis로 독립된 HttpOnly 세션을 만든다. 이메일을 인증 식별자로 사용하지 않고 참조 앱의 공용 계정 예외나 다중 session_slot 쿠키를 복제하지 않는다.

API와 월드가 같은 Spring Session 저장소를 읽는다. 현재 단일 캠퍼스는 WebSocket handshake에서 인증하고 약 1초 주기로 세션 폐기를 확인한다. 이름·아바타는 인증된 서버 프로필을 사용한다. 공간별 일회용 입장 티켓과 중복 탭 인계는 T09에서 추가한다.

로컬 preview는 명시적인 모드다. 일반 실행의 기본은 sso이고 키 누락 시 익명 입장으로 전환하지 않는다. 사용자용 안내, 배포 조건, 남은 기능은 [SSO 연결 문서](../development/hufs-sso.md)를 따른다.
