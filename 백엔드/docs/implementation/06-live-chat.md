# 실시간 채팅 첫 수직 경로

T15의 첫 구현으로 WS를 통한 인근 채팅과 독립 회의실 채팅을 추가했다. 브라우저는 기존 월드 연결을 사용하므로 채팅 참가자도 SSO/공간 입장권으로 이미 허가된 현재 연결에 한정된다.

## 동작 범위

- `nearby` 메시지는 같은 HUFS Town 공간에서 발신자와 6타일 이내인 연결에 전달한다. 공개 구역의 구역 경계는 넘을 수 있지만 `PRIVATE` 회의실로 전파되지 않는다.
- `space` 메시지는 같은 월드 공간의 모든 활성 참가자에게 전달한다. 발신자는 `PRIVATE` 회의실 안에서 보낼 수 없고, 회의실 안의 참가자도 받지 않는다. 메시지·이력 이벤트에는 발신자의 구역 ID를 넣지 않는다.
- `PRIVATE` 구역에서는 `room` 채널만 허용한다. 서버가 현재 게시 맵의 구역과 공간 ID를 기준으로 같은 회의실에 있는 연결에만 전파한다. 방 이름이나 구역 ID는 클라이언트가 메시지의 범위를 정하는 데 쓰지 않는다.
- 무음 구역 텍스트는 허용하되 같은 무음 구역 안의 6타일 이내에만 전달한다. 음성/영상/화면 공유 정책은 기존 미디어 정책을 계속 따른다.
- 본문은 1~500자이고 제어 문자는 거부한다. 같은 참가자의 초당 메시지 제한과 별개로 채팅은 10초당 8개로 제한한다.
- 브라우저가 만든 `clientMessageId`에 대해 서버가 `messageId`와 시간, 발신자 프로필을 붙인다. 연결이 유지되는 동안 참가자별 최근 64개 요청 ID를 기억해 재전송 중복을 막고, 성공/거부 ACK를 돌려준다.
- 클라이언트 패널은 최근 이력 50개와 실시간 메시지를 표시하고, 이전 페이지를 50개씩 불러오며 스크롤 위치를 유지한다. 읽지 않은 메시지 수와 전송 중/실패 상태도 보여준다. 메시지는 React 텍스트 노드로 출력한다.
- 입력기 옆 이모지 선택기는 자주 쓰는 6개 이모지를 제공하고 현재 커서 위치에 삽입한다. Escape 키로 닫을 수 있으며 선택 뒤 입력창에 포커스를 돌려준다.
- 서버가 실시간 전달한 `chatEvent`는 해당 발신 아바타 머리 위 말풍선에도 최대 5.2초 표시한다. 한 번에 최대 54자를 3줄로 제한하고 새 메시지가 오면 교체하며 끝부분은 서서히 사라진다. DB에서 불러온 과거 이력은 말풍선으로 재생하지 않는다.

## 저장과 이력 접근

SSO 로컬 프로필에서는 메시지를 MariaDB에 저장한다. 월드 프로세스의 단일 writer 큐(최대 256건)가 actor와 DB 쓰기를 분리하며, 큐가 가득 차거나 저장에 실패하면 메시지를 전달하지 않고 실패 ACK를 보낸다. DB 커밋 후 actor가 현재 위치와 구역을 다시 확인해 수신 가능한 연결에 전달한다. 저장 중 이탈·이동한 참가자는 이력에는 수신자로 남을 수 있지만 실시간 전달은 받지 않는다.

`chat_message`에는 메시지와 발신 당시 표시 이름·아바타를, `chat_message_recipient`에는 그 메시지를 실제로 받을 자격이 있었던 계정만 기록한다. 유효 기간은 기본 30일이며 `TOWN_CHAT_RETENTION_DAYS`로 1~365일 사이에서 설정할 수 있다. 신고 관리자 허용 목록에 있는 운영자는 신고 검토 화면 옆의 **채팅 보존 설정**에서 같은 1~365일 기간을 저장할 수 있다. DB에 저장된 운영자 값은 환경 기본값보다 우선하며 월드 노드가 최대 5초 뒤 새 채팅과 DM에 적용한다. 변경 전에 저장된 메시지는 기존 만료일을 유지한다. 만료 행은 시간별 제한 정리 작업으로 삭제한다. 미리보기 프로필은 DB 없이 메모리 전용으로 동작한다.

`GET /api/v1/spaces/{spaceId}/chat?channel=nearby&limit=50`는 최근 이력을 시간순으로 돌려준다. `beforeId`로 이전 페이지를 조회할 수 있으며 한 페이지는 1~100건이다. 공간 전체는 `channel=space`, 회의실은 `channel=room&zoneId=...`를 지정한다. API는 로그인 사용자와 공간 접근을 확인하고, 메시지별 수신자 기록에 포함된 계정에만 행을 돌려준다. 회의실 이력은 같은 zoneId로 한 번 더 제한한다. 다른 사용자의 안정적인 계정 ID는 응답하지 않고 본인 메시지 여부만 `own`으로 표시한다. 새로고침이나 재접속 뒤 최근 이력을 불러올 수 있지만, 오프라인 중 수신자로 기록되지 않은 사용자가 과거 메시지를 보게 하지는 않는다.

같은 공간·발신 계정·`clientMessageId` 조합은 DB 유니크 키로 보호한다. 본문·채널·구역 해시가 일치하면 기존 messageId와 원본 이벤트를 돌려주고, 같은 키에 다른 내용을 보내면 충돌 ACK를 반환한다. 이 보장은 연결 메모리의 64개 키 제한과 별도로 재접속을 넘어 지속된다.

## 남은 범위

저장 채팅 재전송은 MariaDB 멱등성 키가 월드 노드 교체와 연결 복구를 넘어 보장하며, 이미 처리한 같은 요청은 발신자에게 원본 이벤트와 성공 ACK를 다시 준다. 같은 키에 다른 본문·채널·대화·구역을 담으면 메모리 캐시에 남은 요청도 충돌로 거부한다. 월드 단위 전송 제한은 10초당 8건이다. Testcontainers에서 저장 커밋 뒤 ACK를 처리하지 못한 채 연결된 브라우저가 다른 패키지 월드로 복귀해 재전송하고, 한 행 유지·상대 중복 전달 없음·충돌 거부를 검증했다. 참가자별 메시지 수신 기록과 회의실 구역 ID는 과거 이력을 당시 수신 자격과 구역으로 제한하고 만료 행은 숨긴다.

1:1 및 그룹 DM 경로는 [직접 메시지 구현 기록](12-direct-messages.md)에서 다룬다. 그룹 초대 저장·수락·거절, 새 멤버 초대, 소유자에 의한 멤버 제거·이름 변경, 재접속 뒤 읽지 않은 수 복구, 연결된 탭과 Web Push 알림, 작성자 메시지 수정·삭제와 수정 본문 이력, MariaDB outbox와 Redis 깨우기 기반 다중 월드 전달 복구를 지원한다. DM 메시지 신고와 관리자 검토 기록은 [신고 구현 기록](13-user-reports.md)에 있다. 계정 설정의 탈퇴 경로는 개인 메시지·채팅 수신자 기록을 삭제하고 남겨야 하는 신고/운영 기록의 사용자 식별정보를 익명화한다. 보존 설정 변경자도 탈퇴 때 ID를 지운다. 모바일 입력과 키보드 위치 조정은 구현했으며 실제 기기와 계정 간 UX 검증이 남아 있다. 미디어 정책은 채팅 보존 및 접근과 별도로 적용된다.

## 코드 위치

- 계약: `contracts/world.schema.json`, `scripts/generate-contracts.mjs`
- 서버 권한·전파: `apps/world/src/main/java/town/hufs/world/WorldHandler.java`
- 웹 연결/ACK/최근 메시지: 프론트 workspace의 `src/game/WorldConnection.ts`
- 채팅 패널: 프론트 workspace의 `src/app/App.tsx`, `src/app/styles.css`
- DB 스키마: `modules/persistence/src/main/resources/db/migration/V6__scoped_chat_history.sql`, `V9__direct_messages.sql`, `V10__space_wide_chat.sql`, `V11__group_conversations.sql`, `V12__group_conversation_invitations.sql`, `V13__group_conversation_ownership.sql`
- 저장/보존: `apps/world/src/main/java/town/hufs/world/ChatPersistence.java`
- 운영 보존 정책: `apps/api/src/main/java/town/hufs/api/moderation/ChatRetentionController.java`, `apps/world/src/main/java/town/hufs/world/ChatRetentionPolicy.java`, 프론트 workspace의 `src/social/ChatRetentionSettingsDialog.tsx`
- 권한 검사된 이력 API: `apps/api/src/main/java/town/hufs/api/space/SpaceChatController.java`

UI 왕복 확인(2026-09-24): 격리 preview 서버와 두 Chromium 브라우저에서 WebSocket 근거리/공간 전체 메시지를 보내고 수신자 패널의 읽지 않은 배지, 패널 열기 뒤 초기화, 각 범위 안내를 확인했다. 이모지는 입력 중간 커서에 삽입되고 전송 본문에도 반영됐다. Escape로 선택기를 닫은 뒤 포커스가 선택 버튼에 남는 동작도 확인했다. 설정 가능한 보존 기간에 맞춰 사용자 안내에서 고정된 30일 표기를 제거했다. Playwright `tests/e2e/chat.spec.ts` 1/1, 프론트 단위 32/32, 계약 69개, Prettier, production build를 통과했다. PRIVATE 회의실·DM의 두 계정 UI 왕복과 말풍선 시각 검증은 T15.2에 남긴다.

두 계정 DM UI 후속 검사(2026-09-24): 독립된 두 브라우저와 사용자 상태에서 참가자 목록을 통한 1:1 대화 시작, 상대 브라우저의 실시간 수신, 읽지 않은 배지와 받은편지함 갱신, 대화 열람 시 읽음 요청과 배지 해제를 확인했다. Playwright `tests/e2e/direct-message-cross-browser.spec.ts` 1/1 통과. 앞선 실제 preview 월드 세션의 PRIVATE 회의실 전달 범위·Canvas 말풍선 검사 및 근거리/공간 전체 두 브라우저 검사와 함께 T15.2 완료 기준을 충족했다. 이 DM UI 검사는 격리된 API/WebSocket fixture를 사용한다. 실제 IdP 계정 간 수동 UX와 iOS/Android 키보드·기기 확인은 T06.2/T25.2에 남아 있다.

실시간 채팅 회귀 재검증(2026-09-27): 격리 프리뷰 실행기(`scripts/e2e.ps1 -SkipBuild`)로 회의실 안팎 채팅 격리 1/1과 근거리 채팅/읽지 않음·모바일 가상 키보드/저장 채팅 ACK 유실 복구 3/3을 검증했다. 회의실 테스트에 있던 프론트 인증 설정만 프리뷰로 가짜 응답하는 임시 우회를 제거했다. API와 World가 모두 프리뷰 모드인 격리 실행에서만 해당 E2E를 수행했으며 공유 Docker의 SSO API·World는 재시작하지 않았다.
