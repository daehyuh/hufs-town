# 행사 결과와 출석 집계

발표 행사는 질문·답변·투표 결과를 저장하고 운영자가 출석 현황을 조회하거나 CSV로 내보낸다. 출석은 발표 공간에 실제로 연결된 참가자를 기록하며, 별도 RSVP 신청이나 체크인 버튼을 실제 출석으로 간주하지 않는다. 출석 기록을 켠 발표에는 저장 여부와 조회 범위를 참가자에게 알린다.

## 참가자 집계

저장 계층은 연결별 출석 구간을 유지한다. V31은 구간 시작 시각과 연결 구간 수를 저장해 15초 안에 플레이어 접속을 복원해도 이전 체류 시간을 중복 계산하지 않는다. 보고서와 CSV에서는 로그인한 `userId`를 기준으로 같은 계정의 재접속·중복 탭을 한 명으로 합치고 구간별 체류 시간을 합산한다. 익명 세션은 계정 식별자가 없으므로 플레이어 세션 단위로 계산한다. 행사 인원 수, 결과 화면의 인원 수, CSV 행 수는 이 고유 참가자 기준을 사용한다. 진행 중 연결의 마지막 구간은 5초 heartbeat에 10초 여유를 더해 계산해, 월드 프로세스가 갑자기 종료된 연결을 현재 시각까지 참석한 것으로 계속 부풀리지 않는다.

## 결과 접근과 내보내기

`GET /api/v1/spaces/{spaceId}/events`, `GET /api/v1/spaces/{spaceId}/events/{eventId}/results`, `GET /api/v1/spaces/{spaceId}/events/{eventId}/attendance.csv`는 활성 계정의 OWNER/ADMIN만 사용할 수 있다. 차단된 계정, 비활성 계정, 운영자가 아닌 참가자는 결과를 볼 수 없다. CSV는 UTF-8 BOM과 RFC 스타일의 셀 따옴표 처리를 사용하며, 사용자 입력이 `=`, `+`, `-`, `@`로 시작하거나 공백/제어 문자 뒤에 수식 문자가 오는 경우 텍스트로 강제해 스프레드시트 수식 실행을 막는다.

CSV와 API 결과는 공간 운영자에게 참가자 표시명과 계정 UUID를 제공한다. 발표 중 참가자는 Q&A·투표 결과와 선택적 출석 데이터가 저장되는지, 공간 운영자가 어떤 정보에 접근할 수 있는지, 180일 뒤 결과가 삭제되는지 안내받는다. 미리보기는 Q&A·투표와 개인별 출석 정보를 저장하지 않는다고 고지한다. 출석 기록을 끄면 행사와 Q&A·투표는 보관하지만 계정별 접속 구간은 저장하지 않는다.

## 보존 기간

종료된 실시간 행사와 출석, Q&A, 투표 결과는 180일 뒤 삭제한다. API의 `EventResultsRetention` 작업이 매일 04:35 UTC에 종료 시각이 보존 기한보다 오래된 `town_event`를 최대 1,000건 단위로 삭제한다. 한 번에 최대 20개 batch를 처리하고 다음 실행에서 남은 backlog를 이어간다. 외래 키 cascade로 출석, 질문/답변, 투표, 선택지와 개별 표도 같이 지운다. 아직 종료되지 않은 행사는 자동 삭제 대상이 아니다. 계정 탈퇴는 행사 결과를 기다리지 않고 해당 사용자의 출석·질문·표를 즉시 삭제하며 투표 선택지 집계도 감소시킨다.

## Q&A와 투표 결과 수명

발표 중 참가자는 질문을 제출하고 공간 운영자는 답변을 게시한다. 질문 속도 제한과 투표 중복 방지는 player ID 대신 로그인 계정 ID를 사용하므로 동일 계정의 별도 세션도 하나의 응답자로 취급한다. 익명 preview는 계정 ID가 없으므로 player ID를 사용한다. 투표 생성·종료, 질문 답변은 운영자 권한을 월드에서 검사한다.

월드 단일 writer가 질문·답변·투표 변경을 순서대로 저장한다. 운영자가 발표를 종료하면 같은 저장 트랜잭션에서 출석 구간과 열려 있는 투표를 닫고 행사 종료 시각을 기록한다. 종료된 월드 상태는 새 질문/응답을 거부하며 결과 API에는 종료된 poll과 저장된 집계가 표시된다.

2026-09-24 Testcontainers SSO API 통합 검사 `liveEventQuestionsAndPollsEnforceAccountRightsAndPersistClosedResults`에서 패키징 월드, MariaDB, Redis를 연결해 운영자/참가자 권한, 같은 계정 두 세션의 질문 속도 제한과 중복 투표, 행사 종료 뒤 거부, 저장된 질문 답변·단일 득표·닫힌 투표의 결과 API 반영 및 비운영자 결과 접근 거부를 확인했다. 프론트 `event-engagement.spec.ts`는 두 preview 브라우저로 질문/답변·투표 집계·중복 응답·종료 표시를 검사한다. 이 검사는 외부 HUFS IdP 자체가 아니라 테스트 SSO 운송 대역을 사용한다.

## 구현 확인

2026-09-23: API/world bootJar, 프론트 계약 검사와 React production build가 통과했다. MariaDB에서 참석자 그룹화 SQL을 `EXPLAIN`으로 확인했고, 격리된 SSO 모드 API에서 행사 목록·결과·CSV 경로가 미인증 요청에 모두 401을 반환하는 것을 확인했다. Flyway V31 적용과 두 연결 구간 컬럼 생성도 확인했다. 인증된 운영자 계정의 결과 조회와 복수 계정 재접속 집계는 별도 검증이 남아 있다.

2026-09-23: `EventState.attendancePersistent`를 월드 프로토콜에 추가해 저장형 공간과 임시 미리보기를 구분한다. 참가자 발표 패널은 출석 기록 활성 시 저장 데이터·운영자 조회 범위를 알리고, 미리보기에서는 개인별 데이터가 저장되지 않는다고 표시한다. 생성 계약 검사와 API/world bootJar, React production build를 통과했다.

2026-09-24: `SsoIntegrationTest.eventAttendanceGroupsAccountSessionsHonorsOptOutAndExportsFormulaSafeCsv`에서 세 개의 실제 패키징 월드 연결을 만들고 두 로그인 세션을 같은 SSO 주체로 발급했다. 결과 API는 세 연결을 두 계정으로 집계하고 중복 계정 행의 접속 세션 수를 2로 내보냈다. 출석 저장 해제 시 개인 attendance row가 0개인 것, 소유자 전용 결과/CSV 권한, `=1+1` 표시명을 CSV에서 텍스트로 강제하는 것을 확인했다. `eventResultRetentionDeletesExpiredRecordsAndTheirPersonalData`는 보존 기한이 지난 종료 행사의 출석/Q&A/투표 및 개인 표가 cascade 삭제되고 최근·미종료 행사는 유지되는 것을 Testcontainers MariaDB에서 확인했다. 두 통합 검사와 행사 UI Playwright, React production build가 통과했다.

## 퀴즈와 점수

T29.1은 기존 단일 활성 투표 흐름에 진행자 선택형 퀴즈를 추가한다. 진행자는 2~6개 선택지 중 정답을 지정해 퀴즈를 열고, 참가자는 투표와 같은 버튼으로 한 번 응답한다. 응답은 월드의 계정 ID(로그인) 또는 플레이어 ID(익명 preview)를 응답자 키로 삼는다. 따라서 같은 계정의 동시 탭과 재접속은 기존 응답을 보고 중복 제출을 거절한다. 월드 프로세스가 살아 있는 동안 참가자가 새 연결로 재입장하면 개인 점수와 응답도 같은 계정 키로 복구된다.

퀴즈가 열려 있는 동안 서버는 정답 인덱스와 응답 수를 브라우저에 보내지 않는다. 운영자가 퀴즈를 닫으면 정답 선택지, 일반 집계, 내 점수와 상위 20명 점수판을 공개한다. V53은 일반 투표/퀴즈 종류와 정답 인덱스, 로그인 계정 및 게스트 응답자 ID, 정답 여부, 부여 점수를 저장한다. 응답자의 복합 기본 키와 기존 계정 행 이관으로 과거 투표를 보존하고, 사용자 삭제 시 계정의 투표와 점수 흔적을 함께 제거한다. 완료 행사 결과 API는 OWNER/ADMIN만 접근할 수 있다.

2026-09-26 검증: `WorldEventRosterTest.quizScoresCorrectAnswersAndPreventsDuplicateAccountResponsesAcrossSessions`, `SsoIntegrationTest.liveEventQuestionsAndPollsEnforceAccountRightsAndPersistClosedResults`, `SsoIntegrationTest.accountDeletionBlocksOwnedSpacesErasesPersonalDataAndRevokesEverySession`, `SsoIntegrationTest.eventResultRetentionDeletesExpiredRecordsAndTheirPersonalData`가 통과했다. isolated preview `event-engagement.spec.ts` 1/1에서 정답을 두 번째 선택지로 지정하고, 정답·집계가 닫기 전에는 감춰지며 종료 뒤 정답 표식과 점수가 표시되는 것을 확인했다. 프론트 Vitest 65/65, TypeScript 검사, 계약 생성 검사 83개 Java 레코드/TypeScript, Prettier, production build도 통과했다. 테스트 SSO 운송 대역을 사용하므로 외부 HUFS IdP 검증은 포함하지 않는다. 활성 퀴즈의 월드 프로세스 재시작 복원은 구현하지 않았다.
