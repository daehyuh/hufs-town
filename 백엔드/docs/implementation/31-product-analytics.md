# 익명 일별 운영 분석
\
`town_product_analytics_daily`는 UTC 날짜와 고정된 지표 키별 누계만 보관한다. 이용자·게스트·공간·행사·요청 식별자, 대화 내용, 이벤트 본문은 저장하지 않는다. World는 신규 참가자 생성, 실제 행사 출석 기록, 월드 거절 응답을 계측하고 API 필터는 5xx 응답을 한 번 집계한다. 각 프로세스는 제한된 메모리 큐에서 비동기로 누계를 기록해 DB 지연이 월드 tick이나 API 요청을 막지 않게 한다.

SSO 관리자 계정 allowlist만 `/api/v1/admin/analytics`에서 최근 30일 일별 합계와 전체 합계를 조회한다. 빈 날짜는 0으로 채우며 UTC 기준 90일이 지난 행은 매일 정리한다. 프론트의 전역 운영 도구에서 접근 권한이 확인된 관리자만 대시보드를 열 수 있다. 비관리자 접근은 API에서 403, 비로그인 접근은 401로 차단한다.

2026-09-27 로컬 검증: API 분석 컨트롤러·5xx 필터·일별 기록기 단위 검사와 World 일별 기록기·신규 참가자 계측 검사가 통과했고 World 전체 단위 검사도 통과했다. API/World bootJar를 다시 만들었다. Chromium 운영 UI E2E 2/2(일반 멤버 도구 비노출, 운영자 30일 표·보존 안내 표시)가 통과했다. Docker Compose의 API와 World를 새 JAR로 갱신해 둘 다 `healthy` 상태를 확인했다. API/World 관리 health는 200, 익명 분석 API는 401이며 Flyway 현재 스키마는 62다.

실제 SSO 관리자 검수는 아직 준비되지 않았다. 실행 환경의 `TOWN_ADMIN_USER_IDS`는 비어 있고, 관리자 UI E2E는 API 응답을 모의한다. 실제 콘솔을 쓰려면 승인된 `app_user` UUID를 이 allowlist에 설정한 뒤 로그인 세션으로 대시보드를 확인하고 실제 입장/행사/거절 이벤트 수와 DB 집계를 대조해야 한다. 권한을 임의 기본 계정에 자동 부여하지 않는다. 이 검수가 남아 있어 T31.3은 미완료로 둔다.

2026-09-27 Testcontainers 종단 통합 검증: `SsoIntegrationTest.analyticsDashboardReadsWorldJoinCountersAndEnforcesTheSsoAdministratorAllowlist`에서 실제 API·패키징된 World·MariaDB·Redis를 연결했다. SSO 테스트 세션 2개로 월드 접속 후 비동기 `space_joined` 누계가 정확히 두 건 증가하고 `/api/v1/admin/analytics` 최근 30일 일자와 합계에 반영되는 것을 확인했다. allowlist 관리자 200, 일반 로그인 403, 비로그인 401, 응답에 사용자·공간 식별정보가 없는 점과 90일 보존 설정도 검사했다. 통합 검사 1/1 통과. 외부 HUFS IdP 관리자 로그인과 실행 환경의 실제 allowlist 설정은 아직 검수할 수 없어 T31.3은 미완료로 유지한다.
