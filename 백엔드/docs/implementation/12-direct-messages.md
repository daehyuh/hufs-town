# 직접·그룹 메시지

T15 채팅의 독립 대화 경로다. 로그인한 사용자는 같은 월드 공간의 현재 참가자에게 1:1 메시지를 보내거나, 2~11명을 선택해 자신을 포함한 최대 12명의 그룹 대화를 만들 수 있다. 그룹 생성은 실시간 참가자 목록으로 제한해 안정 계정 ID를 클라이언트에 공개하지 않는다.

## 동작과 권한

- 참가자 목록의 메시지 버튼은 `directConversationRequest`, 그룹 만들기 화면은 `groupConversationRequest`를 보낸다. 월드 actor는 현재 공간, 접속 상태, 로그인 계정, 차단 상태를 확인한다. 스냅샷은 안정 계정 ID 대신 DM 사용 가능 여부만 공개한다.
- 1:1 대화는 정렬한 사용자 쌍의 `pair_key` 유니크 제약으로 동시에 시작해도 하나만 생성된다. 그룹은 요청 계정별 `requestId` 유니크 키와 참가자·이름 해시로 재전송 중복 및 요청 ID 재사용을 구분한다.
- 그룹은 생성 시 선택된 계정 전원의 활성 상태, 중복 계정, 참가자 간 차단을 DB 트랜잭션에서 확인하고 멤버십을 추가한다. 대화 생성은 같은 공간에서 접속 중인 로그인 계정끼리만 가능하다.
- `chatSend`의 `channel=dm`은 UUID `conversationId`를 포함한다. 영속 저장 트랜잭션에서 발신 멤버십·참가 계정 활성 상태·차단을 확인하고 커밋한 뒤에만 월드 actor가 대화 멤버의 활성 세션들에 전달한다.
- DM은 다른 참가자, 다른 공간의 일반 채팅, 장면 말풍선에 나타나지 않는다. DND/AWAY 상태에서도 DM은 허용하며, 공간 이동/미디어 정책과 별도다.
- 발신 계정·대화·`clientMessageId` 조합은 DB에서 멱등성을 보장한다. 같은 ID와 같은 본문은 기존 이벤트를 돌려주고, 다른 본문은 충돌 ACK를 받는다. 메시지는 기본 30일 보존하고 기존 `TOWN_CHAT_RETENTION_DAYS` 설정을 공유한다.
- 대화 목록은 1:1 상대 프로필 또는 그룹 이름·참가자 수, 최근 메시지와 읽지 않은 수를 보여준다. 이력 API는 멤버십을 확인하며 최근 50개부터 최대 100개를 커서로 조회한다. 대화 화면에서 이전 페이지를 불러오고 스크롤 위치를 보존한다. 읽음 API 호출은 월드 WebSocket의 별도 읽음 요청으로 수행하며, 대화를 연 로그인 계정의 읽음 커서만 앞으로 이동한다. 이력 GET은 상태를 바꾸지 않아 조회만으로 읽음 처리되지 않는다.
- 활성 대화가 보이고 브라우저 탭이 전면에 있을 때 최신 메시지까지 읽음 요청을 보낸다. 월드 저장소는 대화와 멤버십을 잠근 뒤 해당 대화의 만료되지 않은 메시지인지 검증하고, 커서를 단조 증가시킨다. 성공하면 같은 대화의 다른 온라인 멤버 세션에 읽음 이벤트를 전파한다. 이벤트는 계정 ID 대신 대화별 opaque 멤버 ID를 담는다. 이력 API는 각 메시지까지 읽은 다른 멤버 수를 계산하므로 재접속·이전 페이지에서도 읽음 표시를 복구한다.
- 로그인한 세션은 월드 재접속 시 대화 목록을 다시 가져와 DB의 읽지 않은 수를 복구한다. 브라우저 알림을 켜면 연결된 탭의 알림과 Web Push를 사용하며, 브라우저가 닫힌 동안에도 OS 알림을 받을 수 있다. Push 본문에는 DM 내용 대신 일반 안내만 넣고, 클릭하면 해당 대화로 이동한다.
- 그룹 멤버는 같은 공간에서 접속 중인 로그인 참가자에게 초대를 보낼 수 있다. 초대는 7일 동안 MariaDB에 보존되고, 온라인 수신자에게는 WS 알림도 전달된다. 초대함은 재접속 뒤에도 pending 초대를 복구하며 초대 대상만 수락·거절할 수 있다. 수락 시 계정 활성 상태·그룹 정원·차단 관계를 재검사하고 멤버십과 초대 상태를 같은 트랜잭션에서 반영한다.
- 그룹 생성자는 소유자가 된다. 소유자는 이름 변경과 멤버 내보내기를 할 수 있으며, 내보낸 계정의 대기 초대도 취소된다. 소유자가 나가면 가장 먼저 참여한 멤버에게 소유권을 넘긴다. 멤버 목록 API는 계정 ID 대신 대화별 무작위 멤버 ID를 반환한다.

## API와 데이터

- `GET /api/v1/dms`: 로그인 계정의 최근 100개 대화, 종류·상대 프로필 또는 그룹 이름·참가자 수, 최신 메시지, 읽지 않은 수.
- `GET /api/v1/dms/{conversationId}/messages?limit=50&beforeId=...`: 멤버 전용 시간순 메시지 이력. `beforeId`는 같은 대화에서 만료되지 않은 메시지여야 한다.
- `GET /api/v1/dms/{conversationId}/messages/{messageId}/revisions`: 대화 멤버 전용 수정 이력. 삭제되었거나 보존 기간이 지난 메시지는 숨기며, 최신 50개 이전 본문만 반환한다.
- `DELETE /api/v1/dms/{conversationId}/membership`: 그룹 멤버가 나가며, 1명만 남으면 그룹과 이력을 정리한다. 1:1 대화에는 적용되지 않는다.
- `GET /api/v1/dms/group-invitations`: 로그인 계정의 만료되지 않은 대기 초대 목록.
- `POST /api/v1/dms/group-invitations/{invitationId}`: 초대 대상 계정이 `{ "accepted": true|false }`로 초대를 수락하거나 거절한다.
- `GET /api/v1/dms/{conversationId}/members`: 그룹 참가자가 볼 수 있는 그룹 멤버·소유자 정보.
- `PATCH /api/v1/dms/{conversationId}`: 그룹 소유자만 `{ "name": "..." }`으로 이름 변경.
- `DELETE /api/v1/dms/{conversationId}/members/{memberId}`: 그룹 소유자만 해당 대화의 멤버를 내보냄. 계정 ID 대신 대화별 opaque ID를 사용한다.
- `GET /api/v1/push/config`, `POST/DELETE /api/v1/push/subscriptions`: 로그인 계정의 Web Push 공개키 조회 및 브라우저 구독 등록·삭제. 구독 API 변경은 기존 CSRF 보호를 적용하며 계정당 최대 10개 구독을 저장한다.
- 월드 WS `groupInvitationRequest`: 현재 같은 공간에 있는 온라인 참가자를 대상으로 그룹 멤버 초대를 요청한다. DB 초대와 별개로 계정 ID는 브라우저에 노출하지 않는다.
- 월드 WS `directMessageMutationRequest`: 메시지 작성자가 `EDIT` 또는 `DELETE`를 요청한다. 서버는 현재 플레이어 epoch, 로그인 상태, 대화 멤버십, 작성자 ID와 차단 상태를 확인한다. 수정은 전송 후 15분 이내, 500자 이내로 허용하며 삭제는 보존 기간 안에 언제든 요청할 수 있다. `directMessageMutationAck`는 요청 결과를 돌려주고, `directMessageMutationEvent`는 현재 연결된 대화 멤버 세션에 변경 상태를 fan-out한다.
- 삭제는 행을 제거하지 않고 본문을 비우는 tombstone 방식이다. 이력 API는 `revision`, `editedAt`, `deleted`를 포함해 재접속한 화면에도 변경 상태를 복구한다. 수정 시각·삭제 시각과 변경 요청의 멱등 해시·행동·revision을 저장하며 기존 30일 만료 정책은 유지한다.
- `direct_message_revision`은 편집 직전 본문과 revision·시각을 최대 50개 저장한다. 작성자는 수정 이력에서 이전 본문을 확인하고 기존 15분 편집 제한 안에서는 해당 버전을 다시 편집할 수 있다. 메시지를 삭제하면 이전 본문도 같은 트랜잭션에서 제거한다. 수정 가능 시간은 DB 시각으로 판정해 API와 월드 JVM의 시간대 차이에 영향을 받지 않는다.
- 월드 노드는 MariaDB 커밋 후 Redis Pub/Sub으로 eventId 깨우기만 발행하며, 실제 메시지 내용은 DB outbox에서 읽는다. 각 노드는 250ms마다 SQL outbox를 polling해 Pub/Sub 유실이나 Redis 단절을 복구한다. outbox row에는 본문 대신 direct_message 참조, actor, 생성 시점 membership ID만 보관한다. 수신 전 현재 membership ID, 활성 계정, 양방향 차단 상태를 다시 검사한다. 읽음 이벤트의 reader membership이 삭제돼 참조가 사라진 경우에는 전달하지 않는다. 트랜잭션에서 단조 sequence 행을 잠가 낮은 eventId가 늦게 커밋되어 cursor를 건너뛰는 일을 막는다. 노드가 재시작되면 기존 WebSocket은 함께 끊기므로 기동 시점까지의 이벤트는 건너뛰고, 재접속한 클라이언트는 권한 검사된 메시지 이력/읽지 않은 수를 조회한다.
- `direct_conversation`: `DIRECT` 정렬 쌍 또는 `GROUP` 생성 요청별 대화 이름·멱등성 정보와 그룹 소유자.
- `direct_conversation_member`: 1:1 두 계정 또는 그룹 멤버십, 대화별 opaque ID와 읽음 커서.
- `direct_message`: 표시 당시 발신 이름·아바타, 본문, 클라이언트 요청 ID, 멱등성 해시, 수정 revision·시각, 삭제 시각과 만료 시각.
- `direct_message_mutation`: 작성자 변경 요청의 멱등성 해시, 행동 종류와 revision 감사 레코드. 메시지 보존 기한이 지나면 메시지와 함께 정리된다.
- `direct_conversation_invite`: 그룹·초대자·초대 대상·발신 요청 멱등 키·상태와 7일 만료 시각.

마이그레이션은 1:1 대화의 V9, 그룹 대화의 V11, 그룹 초대의 V12, 그룹 소유권·멤버 opaque ID의 V13, 메시지 수정·삭제의 V14, 브라우저 구독·DM Push outbox의 V15, 수정 전 본문 이력의 V38, 월드 간 실시간 전달용 event outbox의 V39다. Web Push outbox는 DM 수신자별 메시지 저장과 같은 트랜잭션에서 기록되며 API 작업자가 구독·멤버십·계정·차단 상태를 다시 확인한 뒤 전송한다. 전달 실패는 재시도하고 만료 구독은 제거한다. Push 구독 endpoint와 키는 민감한 구독 정보로 취급한다. 저장소 큐는 한 writer와 최대 256건을 사용한다. DB 접근은 API 계정 인증과 conversation membership으로 제한한다. 응답에는 안정적인 계정 ID를 포함하지 않는다.

Web Push를 켜려면 backend `.env`의 `TOWN_WEB_PUSH_PUBLIC_KEY`, `TOWN_WEB_PUSH_PRIVATE_KEY`, `TOWN_WEB_PUSH_SUBJECT`를 설정한다. 새 키는 백엔드 루트에서 `node scripts/generate-vapid.mjs --subject=mailto:운영연락처@example.com`으로 만들 수 있으며 개인키는 콘솔에 출력하지 않는다. 브라우저의 Service Worker/Push API는 HTTPS secure context가 필요하다. localhost는 개발 예외지만 휴대폰의 Tailscale HTTP 주소는 secure context가 아니므로 실제 모바일 푸시에는 HTTPS가 필요하다.

## 남은 범위

DM 메시지 신고와 관리자 검토·감사 기록은 [신고 구현 기록](13-user-reports.md)에서 다룬다. 신고 조치로 전역 시간제 채팅/미디어 제한과 10분 전체 공간 퇴장을 적용한다. 모바일 DM 입력은 가상 키보드에 맞춰 패널 위치를 조정하고 터치 영역을 키웠다. 실기기 키보드 동작과 실제 계정 간 브라우저 사용성 검증은 남아 있다. 작성자는 보낸 뒤 15분 이내에 메시지를 수정하거나 보존 기간 안에 삭제할 수 있다.

## 검증

2026-09-21: V9/V11 적용, 프로토콜 계약 생성·검사, React production build, API/world `bootJar` 빌드, API·월드 health `UP`, 웹 200을 확인했다. 자동화 테스트는 실행하지 않았다. 실제 계정 여러 개를 사용한 그룹 생성·전달은 아직 수동 검증하지 않았다. Vite는 Phaser 청크 크기 경고를 표시한다.

후속 구현(2026-09-21): V12에 7일 유효 그룹 초대 테이블을 추가했다. 같은 공간의 온라인 참가자를 월드 actor가 확인한 뒤 초대를 저장하고, 실시간 알림과 영속 초대함을 함께 제공한다. 초대 대상만 수락·거절할 수 있고, 수락 시 활성 계정·그룹 정원·참가자 간 차단을 재검사해 멤버십과 초대 상태를 원자적으로 반영한다. 그룹 대화 화면에 멤버 초대, 사람들 패널에 초대함과 응답 버튼을 연결했다. V12 DB 마이그레이션, API/world bootJar, React production build, 로컬 서버 health 및 unauthenticated 접근 거부를 확인했다. 자동화 테스트와 여러 계정 간 초대 시나리오는 실행하지 않았다.

후속 구현(2026-09-22): V13에서 기존 그룹 생성 요청 키로 소유자를 복구하고 대화별 opaque 멤버 ID를 추가했다. 생성자는 그룹 이름을 바꾸고 멤버를 내보낼 수 있으며, 소유자가 나가면 가장 오래 참여한 멤버에게 소유권을 이전한다. 그룹 멤버 목록·이름 변경·내보내기 UI와 API를 연결했다. API/world bootJar와 프론트 production build가 통과했고, 로컬 MariaDB에 V13 적용 및 API/world health를 확인했다. 그룹 관리 경로는 비로그인 요청 401, CSRF 없는 변경 요청 403을 반환했다. 다중 계정 권한 이전은 수동 검증하지 않았다.

후속 구현(2026-09-22): V15 구독·outbox 스키마, API의 구독 등록/삭제와 VAPID 설정 조회, DM 트랜잭션 outbox 기록 및 API 발송 작업자를 추가했다. 작업자는 현재 멤버십·활성 계정·차단·메시지 만료/삭제를 확인하고 generic payload만 발송하며, 실패 재시도와 만료 구독 정리를 지원한다. Service Worker가 알림을 표시하고 클릭 시 기존 탭 또는 새 탭에서 DM으로 이동한다. 브라우저에 설정된 기존 구독도 로그인 뒤 서버와 동기화하며 로그아웃 때 서버 구독을 지운다. API/world bootJar 및 계약 검사는 통과했다. 실제 브라우저 권한과 외부 Push 서비스 전달은 수동 확인하지 않았다. VAPID 키와 실제 운영 연락처가 backend `.env`에 있어야 하며, Web Push는 HTTPS 또는 localhost에서만 사용할 수 있다.

후속 구현(2026-09-21): 1:1 및 그룹 DM에서 커서 기반 이전 페이지 불러오기를 연결했다. 50개 단위로 이어 읽으며 새 페이지를 위에 붙일 때 기존 메시지의 화면상 위치를 유지한다. 오래된 커서가 만료되면 최신 페이지를 다시 불러올 수 있다. 프론트 타입 검사와 production build가 통과했다. 자동화 테스트와 여러 계정 수동 검증은 실행하지 않았다.

후속 구현(2026-09-21): 그룹 DM에서 나가기 기능을 추가했다. 인증된 DELETE API가 그룹 멤버십을 제거하고, 대화와 메시지 저장은 같은 대화 행 잠금으로 나가기와 메시지 커밋 순서를 직렬화한다. 마지막 사용자가 남아 대화가 1인으로 줄면 그룹과 이력을 정리한다. 여러 계정에서 나간 뒤 접근이 차단되는 동작은 수동 검증하지 않았다.

후속 구현(2026-09-24): 전면에 열린 DM에서 최신 메시지를 읽음 처리하는 월드 WebSocket 요청과 ACK·이벤트를 추가했다. MariaDB 커서는 대화 멤버십과 대화 행 잠금 아래 앞으로만 이동하며, 만료되거나 다른 대화에 속한 메시지 ID는 거부한다. 이벤트는 다른 온라인 대화 멤버에게만 전파하고 계정 ID 대신 대화별 opaque 멤버 ID를 전달한다. 이력 조회는 변경 없이 메시지별 읽은 사람 수를 반환해 재접속 상태도 복원한다. 메시지 UI는 1:1 `읽음`, 그룹 `읽음 N명`을 표시한다. Docker 기반 실통합 검사에서 두 개 SSO 세션과 실제 월드 WebSocket을 연결해 비읽음 상태, 요청 ACK, 상대 읽음 이벤트, DB 커서, 이력의 `readByCount` 복구를 검증했다. API 조회가 읽음 상태를 암묵 변경하지 않는 점도 확인했다. 단일 월드 프로세스 경계와 실제 브라우저 다중 계정 화면 검증은 계속 남아 있다.

수정 이력 복구(2026-09-24): V38에 DM 편집 전 본문·revision·시각 테이블을 추가했다. 편집 직전 본문은 한 메시지당 최대 50개 보존하고, 삭제 시 기존 본문 이력을 함께 제거한다. 멤버 전용 수정 이력 API와 작성자 UI를 연결해 이전 버전을 다시 편집할 수 있다. 수정 가능 시간 검사는 DB 시각을 사용해 서버 시간대 차이를 제거했다. Docker Testcontainers의 MariaDB/Redis와 패키지 월드를 사용한 2계정 통합 테스트에서 멤버 권한, 두 번의 수정 이력, 이전 버전 복구 가능 상태, 삭제 후 이력 제거를 통과했다. 당시 월드 테스트 8개, 프론트 단위 테스트 15개와 production build도 통과했다. 다중 월드 전달과 모바일/키보드 세부 조정은 별도로 검증 중이다.

다중 월드 전달 복구(2026-09-24): V39에 트랜잭션 순서를 보장하는 DB sequence, DM event outbox와 membership 대상 snapshot을 추가했다. 메시지·수정·읽음 상태는 변경 데이터와 같은 트랜잭션에서 outbox row를 만들고, Redis Pub/Sub에는 origin node ID와 eventId만 담은 작은 힌트를 보낸다. 각 월드는 현재 membership generation·활성 계정·차단 여부를 검사해 DB 이벤트를 actor 큐에 전달하고, 큐가 가득 차면 커서를 진행하지 않아 다음 poll 때 재시도한다. Redis 알림은 빠른 깨우기 용도이며 250ms polling이 지속 복구 경로다. 두 패키지 월드와 Testcontainers MariaDB/Redis를 사용한 API 통합 검사에서 Redis write를 1.2초 동안 멈춘 상태에서도 반대 월드가 SQL outbox에서 메시지를 받았고, 기존 수정·읽음 fan-out, 본문 복구·삭제 정리도 통과했다. 전체 API 통합 20/20, 월드 단위 테스트, DB/Redis 인프라 검사를 통과했다. 월드 재시작 뒤에는 소켓이 끊기므로 재입장 후 대화 이력과 읽지 않은 수를 복구한다. 실제 브라우저 다중 계정 UX와 모바일 실기기 확인은 남아 있다.

모바일 DM 입력 보강(2026-09-24): 채팅 입력은 모바일 키보드의 보내기 키를 사용하고, `visualViewport` 변화로 소프트 키보드가 열린 동안 채팅 패널을 키보드 위에 유지한다. 작은 화면에서는 대화·범위 전환·전송 버튼을 키우고 메시지 목록의 터치 스크롤을 안정화했다. 프론트 단위 테스트 15/15와 production build를 통과했다. 실제 iOS/Android 키보드와 다중 계정 브라우저 확인은 남아 있다.

## 코드 위치

- 계약: `contracts/world.schema.json`, `scripts/generate-contracts.mjs`
- 실시간 권한·fan-out: `apps/world/src/main/java/town/hufs/world/WorldHandler.java`, `DirectMessageStore.java`
- 이력 API: `apps/api/src/main/java/town/hufs/api/space/DirectMessagesController.java`
- 스키마·전달: `modules/persistence/src/main/resources/db/migration/V9__direct_messages.sql`, `V11__group_conversations.sql`, `V12__group_conversation_invitations.sql`, `V13__group_conversation_ownership.sql`, `V38__direct_message_revision_history.sql`, `V39__direct_message_event_outbox.sql`, `apps/world/src/main/java/town/hufs/world/DirectMessageFanout.java`
- 웹: 프론트 workspace의 `src/game/WorldConnection.ts`, `src/social/directMessages.ts`, `src/app/App.tsx`
