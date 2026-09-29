# GDG HUFS SSO 로그인 구현

2026-09-21. 사용자가 클론한 `hufs-code-master-server`의 계약과 추가 제공한 백엔드 루트 `sso.md`를 확인하고 Google OAuth 계획을 교체했다. 등록된 `hufs-town-local-test` / `http://localhost:5173/auth/callback`에 맞춰 `.env`를 준비했다. 일정 없이 태스크와 검증 증거로 관리한다.

## 이번에 동작하는 범위

- GDG HUFS authorize 진입, 일회용 code → userinfo 교환, 서버 state·CSRF·코드 재사용 검사.
- MariaDB provider UUID 계정 생성/재로그인, 기존 닉네임 보존, 닉네임·3종 아바타 저장.
- Spring Security + Spring Session Redis 세션, HttpOnly 쿠키, 세션 ID 회전, 8시간 비활성 만료, 현재/전체 세션 로그아웃.
- React 로그인/설정 대기/콜백 취소/오류/로그인 유지/프로필 저장/현재·모든 기기 로그아웃과 실패 재시도 화면. 콜백 query 제거와 StrictMode 단일 교환.
- 초대 링크의 코드는 같은 탭의 sessionStorage에 보관해 SSO 왕복 뒤 로비에 복원한다. 초대 수락 요청이 성공한 경우에만 코드를 지우며, 로그인 취소·만료 중에도 다음 로그인 재시도에 쓸 수 있다.
- 인증된 세션과 정확한 Origin을 요구하는 WebSocket 입장, 서버 프로필 사용, 복구 토큰의 원래 로그인 세션 확인.
- 일반 로그아웃은 현재 로그인 세션을 폐기하고 같은 세션의 모든 월드 탭을 종료한다. 프로필의 모든 기기 로그아웃은 계정에 인덱싱된 다른 브라우저 세션도 폐기하며, Redis 세션 유효성 확인에서 월드 연결을 닫는다. Redis 확인은 이동 tick과 별도 작업에서 수행.
- 계정 탈퇴 시 모든 인덱싱된 세션을 폐기하고 SSO 연결 정보를 제거한다. 소유 공간은 먼저 이전하도록 차단하며 개인 작성물 삭제·공유 기록 익명화 규칙은 [탈퇴 구현 기록](16-account-deletion.md)에 정리했다.
- 명시적 로컬 미리보기 모드 유지. SSO 모드에서 키가 없어도 익명 입장으로 자동 전환하지 않음.
- 설정 예제·개발 실행기·OpenAPI·CI·제품/아키텍처/백로그 문서 반영.

## 검사 결과

| 검사 | 확인 범위 |
|---|---|
| Java 기존 검사 8개 + SSO 클라이언트 검사 6개 | 이동/계약/재접속/송신 큐 회귀, snake_case 요청, 응답 envelope, IdP 오류/상태/클라이언트 키 오류 처리 |
| MariaDB/Redis Testcontainers 기존 검사 2개 | Flyway V1/V2/V3 적용, provider/subject 고유성, Redis 연결 |
| SSO 통합 검사 | 실제 API+월드+MariaDB+Redis에서 로그인/재로그인/프로필/세션 회전/현재·전체 로그아웃/다른 브라우저 월드 소켓 종료/state 및 세션 TTL/계정 거절/Origin/CSRF |
| 프론트 단위 검사 4개 | 공용 계약과 기존 동작 회귀 |
| Playwright SSO 화면 검사 8개 | 진입/콜백/프로필 저장·복원/현재·모든 세션 로그아웃/세션 종료 실패 재시도/취소·오류 복구 |
| Playwright 초대 왕복 검사 | 성공 콜백 후 초대 입력 복원·초대 수락·공간 열기, 취소 및 만료 콜백 뒤 탭 내 초대 코드 보존 |
| 웹 빌드 및 계약 생성 검사 | TypeScript/Vite 빌드, 11개 Java record/TS 타입 일치 |

자동화 검사에서 **외부 SSO의 HTTP 전송은 모의 처리한다.** 별도로 사용자가 `.env`에 실제 키를 입력한 뒤, 로컬 브라우저에서 실제 GDG HUFS 로그인 완료와 서비스 프로필 복원을 확인했다. 아래 실 연동 검증은 개발 콜백 기준이며 운영 배포 검증과 구분한다.

### 실제 로그인 및 독립 실행 파일 검증

- `http://localhost:5173`에서 실제 SSO 로그인 완료 표시, 저장한 서비스 닉네임 복원, 서버 재시작 후 로그인 유지, 캠퍼스 `연결됨` / 참가자 1명 표시를 확인했다.
- 최초 실 입장에서 월드 jar가 Redis 세션의 `DefaultCsrfToken`을 역직렬화하지 못하는 오류를 발견했다. API와 같은 테스트 JVM에서 월드를 실행하던 검사에는 API 쪽 의존성이 들어 있어 이 오류가 드러나지 않았다.
- 공통 auth 모듈에 `spring-security-web`을 추가했다. API 통합 검사는 월드의 실제 `bootJar`를 별도 Java 프로세스로 실행하도록 바꿨고, API→Redis 세션을 독립 월드 실행 파일에서 읽는 회귀 검사 5개가 통과했다.
- 실 사용자 세션으로 월드 입장까지 확인했다. 실제 IdP 로그아웃/재로그인 왕복과 운영 콜백은 아직 별도 검증 대상이며, 자동화 검사에서의 로그아웃·재로그인 결과와 혼동하지 않는다.

브라우저 캡처는 `프론트/test-results/sso-landing-desktop.png`, `sso-landing-mobile.png`에 남긴다. 390px 폭 가로 넘침 없음, 오류 안내/로그인 버튼 배치 확인. 테스트 리포트는 `.build/backend/apps/api/reports/tests/integrationTest`와 `프론트/playwright-report`에 생성된다.

## 남은 태스크

- T06.2: 2026-09-27 실제 HUFS 계정을 선택해 IdP에서 HUFS Town 개발 콜백으로 돌아온 뒤 서비스 로그인 상태와 공간 목록이 복원되는 것을 브라우저에서 확인했다. 이전 실 세션에서 인증된 월드 입장도 확인했고, 초대 링크의 콜백 복귀와 취소·만료 복구는 브라우저 E2E로 검증했다. HTTPS 운영 콜백 등록과 비밀값 저장소는 T26.2 배포 검증 범위다.
- T24: 탈퇴 동작은 구현 및 임시 MariaDB/Redis 통합 검사 완료. 실제 IdP 재로그인으로 신규 계정 생성 확인과 운영자 조치 확인은 남아 있다.
- T09: 공간별 Redis 정원 예약·일회용 입장 티켓·세션 바인딩·새 탭 인계·같은 참가자 ID의 지도 이동과 비정상 종료 좌석 회수까지 구현. 실제 100명 접속과 배포 중 월드 노드 교체/drain은 T26에서 검증한다.
- T26: 운영 HTTPS/프록시/비밀 관리/로그 query 마스킹/스테이징, 100명 부하 검증.
- 음성·영상·화면공유·공간 생성·초대·맵 에디터는 이번 로그인 작업에서 구현한 것으로 표시하지 않는다.

키 변경 시 적용 절차는 [SSO 연결 안내](../development/hufs-sso.md)를 따른다. 참조 저장소는 수정하지 않았다.

2026-09-24 전체 세션 폐기: 프로필 편집 창에서 모든 브라우저 기기 로그아웃을 실행할 수 있다. API는 현재 세션을 제외한 계정의 인덱싱된 Redis 세션을 삭제하고 현재 세션을 무효화한다. 패키지 월드는 해당 세션 ID가 더 이상 유효하지 않으면 활성 WebSocket을 닫는다. 실패 응답에서는 프로필 창에 오류를 표시하고 재시도할 수 있게 유지한다. 28개 API Testcontainers 통합 검사에서 실제 MariaDB/Redis와 패키지 월드로 다른 브라우저 세션 및 연결 회수를 검증했고, SSO UI 8/8, React 단위 35/35, 계약·타입·빌드를 통과했다.

2026-09-29 계정 유형 정책 수정: SSO 로그인은 일반 이메일·비밀번호 계정을 만들거나 로그인하지 않고 HUFS 통합 인증만 사용한다. `ENROLLED`, `LEAVE_OF_ABSENCE`, `GRADUATED`, `FACULTY`, `STAFF`, `COMMON_ACCOUNT`, `UNKNOWN` 일곱 유형을 모두 허용하고, 알려지지 않은 비어 있지 않은 상태값은 `UNKNOWN`으로 분류한다. 기존 SSO 별칭(`ATTENDING`, `COMMON_ID`, 교수·강사·교직원 한국어 값 등)도 대응한다. `SsoClientTest`와 Testcontainers `SsoIntegrationTest`에서 유형별 세션 발급, 이메일 가입·로그인 API 차단을 확인했다. 운영 API·웹을 재빌드·배포했으며 웹 200, API/웹 healthy, 운영 SSO `configured=true`를 확인했다. 실제 공용 계정으로 IdP 왕복 로그인하는 확인은 별도다.
