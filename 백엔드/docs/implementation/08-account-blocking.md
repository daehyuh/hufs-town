# 계정 차단

T16.1의 첫 안전 기능으로 계정 단위 차단을 추가했다. 참가자 패널에서 같은 공간의 온라인 사용자를 차단하거나 해제할 수 있다. 차단은 공간 전체에 저장되어 다음 접속에도 유지된다.

## 적용 범위와 서버 권한

- V7의 `user_block`은 blocker/blocked 계정 쌍을 유일 키로 저장하며, 한 계정은 최대 500개 계정을 차단할 수 있다. 계정 삭제 시 관련 행도 제거한다.
- 월드 입장 직후 제한된 DB worker가 차단 목록을 읽는다. 읽기가 끝나기 전에는 채팅·찌르기·미디어 연결을 허용하지 않는다. 목록을 읽지 못하면 연결을 닫아 차단 정보가 없는 상태로 소통이 열리지 않게 한다.
- 참가자 패널의 차단 요청에는 클라이언트가 표시한 임시 playerId만 전달한다. 월드가 같은 공간의 실제 Player와 계정 ID를 확인한 후 DB에 저장한다. 클라이언트가 보낸 사용자 ID나 좌표는 권한 결정에 사용하지 않는다.
- 차단은 양방향으로 적용된다. 양쪽 중 한쪽이라도 차단하면 근거리/PRIVATE 회의실 채팅, 찌르기, 미디어 정책의 쌍별 연결에서 서로 제외한다. 다른 참가자와의 연결은 유지한다.
- block 상태 메시지는 해당 사용자에게만 현재 접속 중인 차단 대상 playerId를 보낸다. 다른 사용자에게 차단 관계나 계정 ID를 노출하지 않는다.
- DB 쓰기는 월드 actor 밖의 제한 큐에서 수행하고, 커밋 뒤 actor 상태와 같은 계정의 다른 현재 월드 세션을 함께 갱신한다.
- `/api/v1/me/blocks`에서 본인이 저장한 계정 차단 목록을 조회하거나 항목 ID로 해제할 수 있다. API의 삭제는 blocker 계정 조건을 함께 적용한다. 월드 차단·해제와 API의 REST 해제는 DB 변경 뒤 계정 ID만 Redis Pub/Sub로 알린다. 각 월드는 해당 계정의 차단 목록을 MariaDB에서 즉시 다시 읽고, 기존 5초 간격 재조회가 신호 유실을 복구한다. Redis 신호는 권한 데이터로 사용하지 않으며 DB 재조회에 실패하면 그 계정의 소통을 목록 확인 때까지 fail-closed 한다.

## 남은 범위

오프라인 상대의 차단 해제와 목록 조회를 참가자 패널에서 지원한다. 차단 추가는 대상 계정 ID를 안전하게 확인하기 위해 같은 공간의 온라인 참가자 행에서만 할 수 있다. 신고·운영자 검토와 실제 여러 SSO 계정에서의 차단 변경 왕복 확인은 남아 있다. 접속별 AWAY/DND 선택과 Web Push 억제는 [상태 구현 기록](09-presence-status.md)에 추가했다. 개발 서버는 단일 월드 프로세스로 실행하며, Redis fan-out과 서로 다른 월드 프로세스의 운영 조치는 Testcontainers 통합 검사로 검증한다.

## 코드 위치

- DB: `modules/persistence/src/main/resources/db/migration/V7__user_blocks.sql`
- 제한 비동기 저장/조회: `apps/world/src/main/java/town/hufs/world/UserBlockStore.java`
- actor 검증, 채팅/찌르기/미디어 정책: `apps/world/src/main/java/town/hufs/world/WorldHandler.java`
- 계약: `contracts/world.schema.json`, `scripts/generate-contracts.mjs`
- 오프라인 목록 조회/해제: `apps/api/src/main/java/town/hufs/api/auth/UserBlocksController.java`, 프론트 workspace의 `src/social/blocks.ts`
- 화면과 접속별 표시: 프론트 workspace의 `src/app/App.tsx`, `src/game/WorldConnection.ts`

다중 월드 운영 조치 검증(2026-09-24): Docker Testcontainers의 실제 MariaDB·Redis와 패키징된 월드 프로세스 2개를 실행해 참가자 신고 저장, 일반 사용자 운영자 API 거부, 운영자 검토·이력·강퇴·중복 요청 멱등성, 두 월드에 접속한 같은 계정의 강제 퇴장을 확인했다. 이 경로를 테스트하면서 JVM 기본 시간대가 KST일 때 JDBC `TIMESTAMP`가 UTC에서 9시간 밀려 제한이 이미 끝난 것으로 계산되는 결함을 수정했다. API·월드 커넥션의 MariaDB 세션 시간대를 UTC로 고정하고 개발/테스트 JVM도 UTC로 실행한다. 외부 HUFS SSO 자격 증명 교환은 이 검사에서 목 처리되므로 실제 계정 UI 확인은 남아 있다.

다중 월드 차단 적용 검증(2026-09-24): Testcontainers의 MariaDB·Redis와 별도 패키징 월드 프로세스 2개에 차단자·대상·관찰자 계정을 동시에 연결했다. 첫 월드의 `blockAction` 저장 후 Redis 신호를 받은 다른 월드에서 기존 차단자 세션의 `blockState`가 바뀌고, 합류와 찌르기가 `JOIN_BLOCKED`/`POKE_BLOCKED`로 거부되며, 대상이 보낸 공간 채팅은 차단자에게 도달하지 않고 관찰자에게 전달되는 것을 확인했다. SSO 사용자 응답은 테스트에서 목 처리했으므로 실제 HUFS 계정의 화면 왕복은 남아 있다.
