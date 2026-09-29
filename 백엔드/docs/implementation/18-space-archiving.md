# 공간 보관과 복구 (V45)

공간 소유자는 로비에서 공간을 보관하고, 보관함에서 복구할 수 있다. 보관은 데이터를 지우지 않는다. 공간의 지도·에셋·멤버십·일정·초대 기록을 유지하며, 복구 뒤 기존 설정과 멤버가 다시 활성화된다.

## 동작과 권한

- `POST /api/v1/spaces/{id}/archive`는 활성 OWNER만 실행할 수 있다. 처리 중인 소유권 이전 요청이 있으면 `409 SPACE_TRANSFER_PENDING`으로 보관을 막는다. 만료된 이전 요청은 정리한다.
- `GET /api/v1/spaces?view=archived`는 현재 소유자의 보관 공간만 반환하고, 각 항목은 `archived: true`로 표시한다. browse/mine/favorites와 상세 조회에서는 보관 공간을 제외한다.
- `POST /api/v1/spaces/{id}/restore`는 공간 소유자만 실행할 수 있고 보관 표시를 해제한다. 타 계정에는 존재 여부를 노출하지 않고 숨김 응답을 준다.
- 보관 공간은 상세·입장권·초대 수락·게스트 입장·맵/에셋 관리의 일반 경로에 들어갈 수 없다. 이미 접속한 월드 참가자도 월드의 권한 갱신에서 `SPACE_ACCESS_REVOKED`를 받고 연결이 종료된다.
- 로비 보관 카드에는 입장·일정·편집·초대·멤버 관리와 설정 동작을 표시하지 않는다. OWNER는 확인 대화상자를 거쳐 보관하고 보관함에서 복구한다.

Flyway V45는 `town_space.archived_at`과 소유자 보관함 인덱스를 추가했다. 보관된 공간도 계정당 공간 생성 한도에 포함된다. 공간 복제는 [공간 복제 구현 기록](19-space-cloning.md)을 따른다. 영구 삭제는 제공하지 않으며, T07.2에는 실제 HUFS SSO 계정 간 권한 검수가 남아 있다.

## 검증

Testcontainers SSO 통합 검사는 두 계정 간 보관/복구 권한, pending ownership transfer 차단, browse/mine/archived 목록, 상세 비노출을 확인한다. 같은 검사에서 이미 접속한 다른 멤버의 WebSocket이 `SPACE_ACCESS_REVOKED`를 받고 종료되는 것도 확인한다. UI Playwright는 API fixture를 사용해 보관 확인, 보관 카드의 관리/입장 동작 제거, 복구와 일반 목록 복귀를 검증한다.
