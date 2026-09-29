# 메시지 신고와 관리자 검토

T24.2의 신고 접수와 검토 큐 수직 경로다. 로그인 계정은 참여 중인 DM의 다른 사람 메시지와 현재 공간의 참가자를 신고할 수 있다. 사람 패널은 현재 맵뿐 아니라 같은 공간의 다른 맵 참가자에게도 신고 동작을 제공한다. DM 신고는 브라우저에서 메시지 ID와 사유만 보내고 API가 멤버십과 원본 증거를 확인한다. 참가자 신고는 월드가 현재 공간의 활성 참가자를 확인해 계정 또는 게스트 대상을 저장한다. 게스트 신고의 신고자도 로그인 계정이어야 한다.

## 권한과 보존

- 신고 사유는 괴롭힘, 위협, 스팸, 개인정보 노출, 기타로 제한하고 설명은 최대 1,000자다. 신고자는 DM·참가자 신고 출처와 관계없이 같은 계정을 24시간에 한 번만 신고할 수 있고, 게스트도 브라우저 가명 ID 기준으로 같은 제한을 적용한다. 전체 신고는 신고자 계정당 24시간 최대 10건이다.
- `TOWN_ADMIN_USER_IDS`에 쉼표로 구분한 내부 계정 UUID를 지정하면 해당 계정만 신고 목록·검토 API를 사용할 수 있다. UUID는 로그인된 `/api/v1/auth/me` 응답의 `userId` 값이다. 환경변수에 UUID 외 데이터를 기록하지 않는다.
- 관리자는 `OPEN`, `REVIEWING`, `RESOLVED`, `DISMISSED` 상태를 사용하고 각 변경의 이전/이후 상태·관리자 표시 이름·메모를 별도 감사 테이블에 남긴다. 종료 상태는 다시 열 수 없다.
- 메시지 본문은 신고를 제출한 경우에만 증거 snapshot으로 복사된다. 신고와 검토 이력은 신고 시각부터 최대 180일 보관하며 일일 정리 작업이 지난 자료를 삭제한다.
- 신고 설명, 메시지 본문, 관리자 메모는 애플리케이션 로그에 쓰지 않는다. 관리자 검토에서 10분·1시간·24시간·7일의 전역 채팅 제한과 미디어 제한을 적용할 수 있다. 채팅 제한은 공간/근거리/회의실 채팅과 1:1·그룹 DM의 영속 저장 직전에 DB에서 확인한다. 미디어 제한은 마이크·카메라·화면·화면 오디오 송출을 SFU의 송출 정책에서 제거하고 기존 producer도 닫는다.
- 전체 공간 강제 퇴장은 10분간 재입장을 막는다. 각 월드 프로세스가 활성 계정과 게스트 세션의 조치 상태를 0.5초 간격의 일괄 조회로 동기화해 기존 연결을 끊고, 새 연결도 입장 시 확인한다. 따라서 DB를 공유하는 월드와 미디어 프로세스에 모두 적용되며, 월드 상태 확인이 불가능할 때는 연결을 종료한다.
- 게스트는 `HUFS_TOWN_GUEST` HttpOnly·SameSite=Lax 쿠키의 256비트 무작위 브라우저 토큰에서 유도한 UUID로 신고·제한한다. 쿠키는 Secure 설정을 로그인 세션 쿠키와 공유하고 API 게스트 경로에만 보내며, 190일 Max-Age를 입장 때 갱신한다. 짧은 30분 Redis HTTP session을 지우거나 만료해도 같은 브라우저 토큰이면 게스트 UUID와 제재가 이어진다. 토큰 원문은 `app_user`, 신고, 제재 테이블에 저장하지 않는다. UUID는 계정이나 이메일에 연결되지 않으며 쿠키가 없거나 다른 브라우저이면 다른 게스트로 취급한다. 이는 브라우저 범위 제재이지 사람·계정 단위 차단이 아니다. 사용자가 쿠키를 삭제하거나 브라우저를 바꾸면 새 게스트 범위가 생길 수 있다.
- 같은 브라우저 토큰을 가진 세션에서 제한이 살아 있는 동안 SSO 로그인하면 채팅·미디어·월드 제한의 남은 만료 시각과 감사 참조를 새 계정에 옮긴 뒤 게스트 표식을 제거한다. 계정의 기존 제한이 더 길면 그 제한을 유지한다.
- 모든 조치는 신고 종결·관리자 메모와 한 트랜잭션으로 반영한다. 관리자별 요청 ID와 요청 본문 해시를 365일 감사 보관하며 같은 요청의 재시도는 기존 결과를 돌려준다. 제한 행은 만료 후 30일이 지나면 정리한다.

탈퇴할 때는 신고·검토의 계정 참조와 표시 이름을 익명화하지만 기존 신고/검토 최대 180일, 조치 감사 최대 365일의 보존 기간은 유지한다. 감사 행의 탈퇴자 관련 조치 메모도 비식별 일반 문구로 교체한다. 상세는 [계정 탈퇴 기록](16-account-deletion.md)을 따른다.

## API

- `GET /api/v1/reports/access`: 로그인 계정 본인의 관리자 UI 접근 가능 여부만 반환한다.
- `POST /api/v1/reports`: `{ "messageId", "category", "details" }`로 DM 신고를 접수한다. 참가자 신고는 월드 WebSocket `playerReport` 이벤트로 접수한다. CSRF 보호가 적용되고 메시지·참가자 권한은 서버에서 확인한다.
- `GET /api/v1/admin/reports?status=OPEN&limit=50`: 허용된 관리자만 최대 100개를 조회한다. 메시지 증거는 관리자 응답에만 포함한다.
- `PATCH /api/v1/admin/reports/{reportId}`: `REVIEWING`, `RESOLVED`, `DISMISSED`로 상태를 바꾸고 메모를 감사 이력에 남긴다.
- `PATCH /api/v1/admin/reports/{reportId}/chat-mute`: `{ "requestId", "durationMinutes", "note" }`로 1~10,080분의 채팅 제한을 적용한다. 요청 ID는 16~64자의 문자·숫자·밑줄·하이픈이며, UI는 10분·60분·1,440분·10,080분을 제공한다. 성공 시 신고를 `RESOLVED`로 종결한다.
- `PATCH /api/v1/admin/reports/{reportId}/media-mute`: 같은 요청 형식으로 마이크·카메라·화면 공유와 공유 오디오를 1~10,080분 제한한다. 기존 연결에도 제한된 송출 트랙을 중지한다.
- `PATCH /api/v1/admin/reports/{reportId}/kick`: `{ "requestId", "note" }`로 신고 대상의 모든 연결을 종료하고 10분간 전체 공간 재입장을 제한한다.
- `GET /api/v1/admin/reports/{reportId}/history`: 신고의 상태 변경 이력을 반환한다.

V16은 신고와 검토 이력, V17은 채팅 제한과 관리자 조치 감사, V18은 전체 공간 퇴장과 미디어 제한, V46은 게스트 대상과 세션 제한 테이블을 추가한다. 탈퇴 이후에도 조사 이력이 남도록 표시 이름 snapshot을 보존하고 계정 외래키는 `SET NULL`로 처리한다. 180일 후 신고·검토 이력을 삭제하고, 조치 감사는 365일 보관하며 계정·게스트 제한 행은 만료 또는 갱신 뒤 30일이 지나면 정리한다.

2026-09-25 UI 검증: 같은 공간의 다른 맵 참가자 행에서 신고 사유와 설명을 제출해 `playerReportRequest` 대상 ID를 보내고 승인 ACK를 표시하는 Chromium E2E를 추가했다. 관리자 큐의 positive 경로도 신고 증거/설명 표시, REVIEWING PATCH와 검토 메모 전송, 상태 이동 후 성공 안내를 검증한다. 일반 계정은 관리자 도구와 API 경로에 접근하지 못하는 기존 검사가 함께 통과했다. 실제 HUFS 관리자 계정의 허용 목록과 운영 조치 후속 검수는 남는다.

2026-09-25 통합 재검증: 새 Testcontainers 시나리오에서 실제 DM message ID·conversation membership로 원문 증거를 서버가 결정하고, 중복 신고와 비멤버 신고를 각각 거부하며, 일반/신고 대상 계정에 관리자 신고 큐를 숨기는 것을 확인했다. 관리자 응답에만 원문·설명이 나타났다. 기존 cross-world kick, World→SFU media mute, 브라우저 기반 guest restriction 검사가 3/3 통과했다. 실 HUFS 운영자 계정의 허용 목록·실운영 조치 검수는 아직 남아 T24.2는 미완료다.

2026-09-26 신고 중복 제한 보강: 신고자의 계정 행을 트랜잭션에서 잠근 뒤 같은 계정/게스트 대상을 24시간 내 신고했는지 확인한다. DM과 참가자 신고가 같은 제한을 공유하며, 서로 다른 DM 메시지로 같은 계정을 재신고하는 경로도 거부한다. 두 경로를 동시에 요청하는 Testcontainers 검사에서 한 건만 저장되고, 선행 DM 뒤 참가자 신고 및 선행 참가자 신고 뒤 DM 신고가 모두 거부되는 것을 확인했다. DM 증거는 기존처럼 허용 관리자 응답에만 노출된다. 관련 API/월드·SFU·게스트 회귀 검사 5건이 통과했다.

2026-09-27 운영 신고 수직 경로 재검증: `:apps:api:integrationTest`의 DM 원문·멤버십 검증, 계정/참가자 교차 신고 중복 억제, 두 World 노드 강퇴, 게스트 세션·브라우저·SSO 승격 제재 검사 4개가 통과했다. Chromium 신고 E2E 3/3에서 비관리자 도구 비노출, 관리자 검토/감사 메모 저장, 영어 설정 시 영문 신고 패널 진입과 메모 저장을 확인했다. Docker SFU 미디어 테스트 25/25에서 실제 mediasoup worker의 제한된 participant producer와 기존 consumer 종료도 통과했다. API/World 실패 로그는 신고 본문·증거·관리자 메모 대신 예외 클래스나 고정된 상태 문구만 남기는 것을 재검토했다. 허용 관리자 UUID를 지정한 API 검사와 운영 UI 자동 검증은 완료됐지만 실제 HUFS 운영자 SSO 계정에서의 권한 설정 검수는 남아 T24.2를 미완료로 유지한다.

2026-09-27 logging privacy hardening: SFU control-plane failure responses and RPC exceptions were previously logged with remote messages/stack traces, and World tick/map-publication failures logged complete exception details. Those paths now record only the exception class, not response codes, messages, payloads, or stack traces. Added a regression assertion that failure labels never copy private text or bearer-like values. Targeted moderation-media/retry tests and the complete `:apps:world:test` suite passed (2m40s). T24.2 remains open until the allowlisted real HUFS operator account is verified in the deployed SSO environment.
