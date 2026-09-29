# 공동 맵 편집 계약

공동 편집은 CRDT 대신 **서버가 순서를 정하는 의미 단위 작업 로그**를 사용한다. 현재 편집기는 지도 전체 snapshot을 고쳐 자동 저장하고, 서버는 지도 행 잠금·단일 lease·`baseVersion`·멱등 operation ID로 한 작성자만 허용한다. 여러 클라이언트가 지도 전체를 서로 덮어쓰도록 열면 서로의 변경이 사라지므로 그 저장 경로를 공동 편집에 재사용하지 않는다.

## 명령과 동기화 규칙

`contracts/map-editing.schema.json`이 제출 명령과 서버 발행 이벤트의 기준 계약이다. 명령 하나는 `clientId`, 고유 `operationId`, 클라이언트가 알고 있는 `baseSequence`, 하나 이상의 원자적 action을 담는다. 지도 엔터티는 기존 `MapDefinition`의 `objects`, `floors`, `walls`, `zones`, `labels`, `portals` 컬렉션을 ID로 참조한다. 이름과 스폰 좌표만 지도 수준 변경으로 허용한다. `revision`, `collisions`, 크기, ID를 클라이언트가 임의 변경하는 action은 없다. 기존 `schemaVersion=2` 지도 fixture를 그대로 게시 문서로 보존한다.

API는 요청마다 SSO 세션의 OWNER/ADMIN 권한을 확인하고 DB 잠금 안에서 `baseSequence` 뒤의 작업과 충돌 여부를 검사한다. 같은 엔터티의 두 교체/삭제/재정렬은 충돌로 돌려 최신 상태를 다시 불러오게 한다. 서로 다른 엔터티나 서로 다른 지도 필드의 변경은 서버가 작업을 직렬화해 병합한다. 추가 ID 중복, 사라진 대상 ID, 범위를 벗어난 재정렬 기준은 거부한다. 한 action이라도 잘못되면 배치 전체를 거부한다. 충돌은 `409`와 현재 sequence·복구용 상태로 돌려주며 조용한 last-write-wins는 쓰지 않는다.

서버가 저장하는 이벤트는 단조 증가하는 `sequence`, 인증된 작성자 ID와 당시 표시 이름, `clientId`, `operationId`, action, 수신 시각을 포함한다. 요청의 `actorId`는 받지 않는다. 같은 지도·작성자·client의 operation ID 재요청은 content hash가 같으면 원래 ACK를 돌려주고, 내용이 다르면 충돌 처리한다. 협업 중 포인터·선택 표시만 휘발성 presence로 전달하고 이를 지도 문서나 revision에 저장하지 않는다.

실행 취소는 작업을 로그에서 지우는 대신 이전 값을 복원하는 **새 보상 작업**이다. 보상 작업은 원래 작성자만 요청할 수 있고 대상 엔터티가 원래 작업 이후 다른 작성자에 의해 바뀌지 않았을 때만 적용한다. 변경됐으면 되돌리기를 거부해 다른 작성자의 결과를 지키고, 사용자가 최신 변경을 비교한 뒤 직접 수정하게 한다. 사용자별 undo 이력은 서버 ACK 기준으로 쌓는다.

## 기존 데이터와 게시 호환성

전환 시 기존 `space_map.draft_json`, `draft_version`, `map_revision`, 게시 포인터와 `MapDefinition.schemaVersion=2`를 다시 쓰거나 재인코딩하지 않는다. 지도 행마다 공동 편집 sequence를 0으로 초기화하고, sequence 0의 기준 snapshot은 기존 `draft_json` 자체로 본다. 즉시 전체 맵을 다시 저장하거나 기존 지도별 ID·revision을 바꾸지 않는다. 새 `map_edit_operation` 로그에는 이후에 들어온 명령만 추가한다. 서버는 로그와 snapshot을 같은 MariaDB 트랜잭션에서 갱신한다. 긴 오프라인 편집은 저장된 snapshot sequence보다 오래된 경우 최신 snapshot과 이후 로그를 함께 내려받아 재기준화하며, 동일 엔터티 충돌은 자동 병합하지 않는다.

기존 단일 lease 초안 API는 협업 기능을 켜기 전까지 유지한다. 한 지도에는 `LEGACY` 또는 `COLLABORATIVE` 중 한 writer mode만 허용하고, 서버 설정/지도 mode를 원자적으로 전환한다. mode 전환은 lease가 비어 있고 미저장 로컬 작업이 없는 상태에서만 수행한다. 협업 mode에서는 기존 전체 snapshot `draft` 저장을 거부한다. 이전 클라이언트의 stale 요청이 새 협업 초안을 덮을 수 없도록 막는다.

게시 요청은 로그 반영이 끝난 `baseSequence`, 초안 버전, 멱등 client/operation ID를 함께 제출한다. 서버는 지도 행 잠금 하에서 두 장벽 값이 최신인지 확인하고, 정규화된 전체 `MapDefinition`에 기존 `MapRules`, 에셋, 포털 및 도달 가능성 검증을 그대로 실행한다. 성공한 경우에만 기존의 불변 `map_revision` 및 outbox 경로로 단일 게시 revision을 생성한다. 동시 편집이 게시 잠금 뒤에 도착하면 다음 sequence로 남고, 잠금 앞에 도착하면 낡은 barrier의 게시가 거부된다. 같은 operation ID 재시도는 원래 revision을 반환해 중복 게시를 막는다. 과거 revision 복원은 live map을 다시 게시하면서 공동 편집 초안과 edit sequence는 보존하고 draft version만 올린다. 권한 회수는 다음 명령 및 게시 요청부터 차단하고, 해당 작성자의 미전송 로컬 작업은 복구본으로 보존한다.

## 단계적 구현과 검증 기준

- T30.2는 sequence별 snapshot/operation 저장, 멱등성·충돌 응답, 재접속 동기화, ephemeral presence, 보상 명령 undo를 구현한다. 오프라인 작업은 먼저 서버 로그에 안전하게 재기준화하고 같은 엔터티 수정 충돌 화면을 제공한다.
- T30.3은 writer mode fencing, 권한 회수, 멱등 게시 ID, sequence/version 게시 barrier, 기존 `MapRules` 검증, 이력 복구와 단일 revision 게시를 추가한다.
- 현재 계약 fixture는 기존 `campus-map` 문서와 함께 AJV로 검사한다. 새 작업은 MapDefinition을 대체하는 snapshot 계약이 아니라 그 위에 적용되는 delta임을 테스트한다.
- 통합 완료 검증은 MariaDB Testcontainers에서 동시 사용자 두 명, 같은/다른 오브젝트 충돌, 중복 요청, 재접속·오프라인 재기준화·사용자별 undo, 게시 도중 편집과 권한 회수를 확인한다. 실제 다중 브라우저 검증에서는 각 편집 화면의 sequence와 최종 저장 문서 hash가 일치해야 한다.

이 계약은 T30.1 산출물이다. 공동 작성 화면은 T30.2에서 연결했고 게시 barrier는 T30.3에서 구현했다. `LEGACY` 지도는 계속 기존 lease 기반으로 편집한다.

## 구현 상태

2026-09-27 T30.2 서버 저장 기반을 추가했다. V58은 기존 지도를 `LEGACY`, sequence 0으로 유지하며 각 지도에 별도 edit mode/sequence와 작성자·action·inverse를 저장하는 `map_edit_operation`을 만든다. 편집 모드 전환은 현재 draft version이 맞고 기존 lease가 만료/해제된 경우에만 허용한다. 협업 모드에서는 lease·전체 snapshot 저장·기존 publish API를 차단한다. `GET /maps/{mapId}/edit`는 최신 snapshot과 sequence 뒤의 제한된 이벤트 페이지를 반환하고, `POST .../edit/operations`는 멱등 ID, 같은 엔터티 충돌 검사, MapRules/에셋/포털 검증과 snapshot/log 원자 저장을 수행한다. `/edit/undo`는 작성자만 원본 sequence를 보상할 수 있고 이후 변경이 충돌하면 거부한다.

실 MariaDB/Redis Testcontainers `SsoIntegrationTest`에서 V58 적용, 기존 초안·schemaVersion 2 보존, 활성 lease 전환 거부, 오래된 서로 다른 요소 편집 병합, 같은 요소 충돌과 현재 snapshot 반환, idempotency, 작성자 식별, 악의적인 작성자 필드 거부, 제한된 재접속 페이지, 타 사용자 undo 거부와 작성자 undo/재시도를 확인했다.

2026-09-27 React 맵 편집기를 연결했다. 기존 지도별 LEGACY 편집을 유지하면서 관리자가 공동 편집 모드로 전환할 수 있고, semantic delta를 자동 저장하며 1.25초 간격으로 sequence 변경을 조회한다. 오프라인 중 서로 다른 대상의 수정은 최신 snapshot 위에 재기준화하고, 겹친 수정은 로컬 복구본을 보존한 뒤 최신 버전 불러오기를 요구한다. undo는 본인 작업의 서버 보상 명령을 사용하며 redo는 해당 action을 새 명령으로 재적용한다. 선택 presence는 2초 heartbeat와 8초 Redis TTL로 표시하고, 접속자 이름과 선택 항목을 맵 위에 그린다. 모드 전환/동기화/복구 UI에는 한국어·영어 문구를 추가했다. 협업 모드의 게시 버튼은 sequence/version barrier가 구현될 때까지 비활성화한다.

2026-09-27 T30.3 공동 게시를 연결했다. V59의 `map_publish_operation`은 사용자/클라이언트/operation ID와 요청 hash 및 게시 revision을 저장한다. `POST /maps/{mapId}/edit/publish`는 OWNER/ADMIN을 매 요청 다시 확인하고, 행 잠금 안에서 sequence와 draft version을 일치시킨 뒤 기존 맵·에셋·포털·도달 가능성 검증 및 durable outbox 게시를 사용한다. 동시 편집이 장벽보다 먼저 반영되면 낡은 게시 요청은 409로 거부되며, 게시 응답 유실 뒤의 재요청은 같은 revision을 반환한다. 이력 복원은 과거 문서로 live revision을 새로 게시하되 공동 편집 초안과 operation sequence는 보존한다. 프론트 게시 버튼·이력 복원·장벽 충돌 후 최신 상태 재시도·권한 회수 시 복구본/읽기 전용 상태를 연결했다. Testcontainers에서 편집과 게시 경합, 순번·버전 불일치, 중복 재시도, 관리자 권한 회수, 이력 복원, 잘못된 시작 위치 검증을 확인했다. T30.3 완료다.

T30.2는 실제 Chromium 브라우저 컨텍스트 두 개에서 순서가 엇갈린 서로 다른 항목 편집의 재기준화, 양쪽 편집 화면의 동일 문서 수렴, 재접속 후 sequence와 문서 일치를 확인했다. 브라우저 검사는 공유 모의 API 상태를 사용하고, 서버의 인증·저장·충돌·undo 의미는 위 MariaDB/Redis Testcontainers 통합 검사에서 별도로 확인한다. 저장 응답에 다른 작성자의 변경이 포함된 경우 현재 화면에 최신 문서를 반영하지 못하던 결함도 수정했으며, 저장 중 추가된 로컬 수정은 보존한다. T30.2와 T30.3을 완료했다.
