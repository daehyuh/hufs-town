# 06. 근거·결정·미확정 사항

조사 기준일: 2026-09-21. 제품·SDK 문서는 변경될 수 있으므로 구현 시작 시 고정할 버전과 현재 공식 문서를 다시 대조한다. 아래 자료는 기능 참고와 기술 제약 확인용이며, 제안한 성능·비용이 검증됐다는 근거가 아니다.

## 1. 공식 자료

| 자료 | 이번 설계에 반영한 내용 |
|---|---|
| [Gather 영상 보기 방식](https://support.gather.town/articles/3515338779-changing-your-video-view) | 공식 가이드의 지도·영상·회의 화면 배치를 브라우저에서 확인. 07 레퍼런스 설계에 연결 |
| [ZEP 에디터 기초 가이드](https://docs.channel.io/zep-guide/ko/articles/%EC%97%90%EB%94%94%ED%84%B0-%EA%B8%B0%EC%B4%88-%EA%B0%80%EC%9D%B4%EB%93%9C-c9e20c51) | 공식 이미지의 맵 목록·격자 캔버스·상단 도구와 저장/플레이 흐름 확인 |
| [Gather 회의 개요](https://support.gather.town/articles/4892470515-overview-of-meetings-for-remote-office-spaces) | 통화 화면 구성·공유·채팅·감정표현·손들기 등 협업 흐름 참고 |
| [Gather 독립 회의 구역](https://support.gather.town/articles/2550999600-overview-of-meeting-rooms-private-areas) | 독립 통화 영역·잠금·입장·회의실 정원 개념 참고 |
| [Gather Mapmaker](https://support.gather.town/articles/9657827678-mapmaker-overview) | 객체와 타일 효과를 구분하는 편집 방식 참고 |
| [ZEP 공식 서비스 소개](https://www.zep.us/home/landing) | 공간·맵 제작·음성/영상/화면공유를 포함하는 서비스 범위 참고 |
| [ZEP 타일 효과 API](https://docs.zep.us/zep-script/zep-script-api/scriptmap/methods) | 충돌·스폰·포털·독립 구역·스포트라이트·웹 임베드·환경음 종류 확인 |
| [ZEP 호스트 안내](https://docs.channel.io/zep-support/ko/articles/%ED%98%B8%EC%8A%A4%ED%8A%B8-818e36fa) | 공간 운영과 발표자 전파 범위의 구분 참고 |
| [ZEP 에셋 스토어](https://docs.channel.io/zep-support/ko/articles/%EC%97%90%EC%85%8B-%EC%8A%A4%ED%86%A0%EC%96%B4-bf1ec94a) | 에셋 카탈로그/확장 생태계 기능의 후속 범위 참고 |
| [Google OpenID Connect](https://developers.google.com/identity/openid-connect/openid-connect) | Google 계정 로그인·ID token·subject·state/nonce·scope |
| [LiveKit 트랙 모델](https://docs.livekit.io/intro/basics/rooms-participants-tracks/tracks/) | 트랙 종류·선택 구독의 역할 |
| [LiveKit 트랙 구독](https://docs.livekit.io/transport/media/subscribe/) | 구독·화질·adaptive stream 관련 설계 후보 |
| [LiveKit RoomService API](https://docs.livekit.io/reference/other/roomservice-api/) | 참가자·권한·구독 관리·Cloud 토큰 회수 동작 |
| [LiveKit 공식 저장소 이슈 4651](https://github.com/livekit/livekit/issues/4651) | 특정 버전의 구독 권한 조합 문제 보고. 미확정 동작을 검증 게이트로 두는 이유 |
| [mediasoup 클라이언트/서버 통신](https://mediasoup.org/documentation/v3/communication-between-client-and-server/) | 서버가 Consumer 생성·수명·시그널링을 소유하는 대안 |
| [Spring WebSocket](https://docs.spring.io/spring-framework/reference/web/websocket.html) | raw WebSocket/STOMP 지원과 이벤트 기반 통신 |
| [Spring WebSocket API](https://docs.spring.io/spring-framework/reference/web/websocket/server.html) | handler·handshake·세션 송신 직렬화 필요성 |
| [Spring Security OAuth2 Login](https://docs.spring.io/spring-security/reference/servlet/oauth2/login/core.html) | Google OIDC 연동의 Spring 구현 기반 |
| [MariaDB JSON](https://mariadb.com/docs/server/reference/data-types/string-data-types/json) | LONGTEXT 기반 JSON 저장 특성, 관계 데이터/맵 파일 분리 |
| [Redis Pub/Sub](https://redis.io/docs/latest/develop/pubsub/) | 알림 전달 누락과 권한/게시 이벤트 재확인 설계 |
| [LiveKit JVM 서버 SDK](https://github.com/livekit/server-sdk-kotlin) | Spring에서 미디어 서버 제어를 연결하는 후보 |
| [Phaser Tilemap](https://docs.phaser.io/api-documentation/3.88.2/class/tilemaps-tilemap) | 타일맵·레이어·Tiled 데이터 사용 가능성. 버전 선택의 최종 근거는 별도 검증 |
| [MDN 화면 캡처](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getDisplayMedia) | 사용자 클릭·보안 컨텍스트·브라우저/OS별 화면 오디오 지원 제약 |

Gather 문서는 일부 기능을 Gather 1.0/공간 유형별로 설명한다. 해당 내용을 모든 현재 Gather 상품의 동일한 동작이라고 일반화하지 않았다. ZEP의 대형 인원 수치도 본 프로젝트의 성능 목표로 그대로 가져오지 않았다.

## 2. 확정·제안·검증 대기 구분

| 사항 | 상태 | 근거/후속 |
|---|---|---|
| 공간당 동시 100명 | 사용자 확정 | 전체 맵 합계 좌석으로 적용 |
| AI가 처음부터 끝까지 전체 구현 | 사용자 확정 | 설계 보완·코드·UI·테스트·배포 설정·운영 문서까지 태스크로 수행 |
| 개발 일정·인력 기준 추정 제외 | 사용자 확정 | 계획·태스크·의존 관계·완료 기준으로만 관리 |
| Google 로그인·생성/초대·아바타·편집·RTC·독립 통화·표현 | 사용자 요구 | R1 필수 범위 |
| 보유 도트/GDG HUFS 에셋 활용 | 사용자 요구 | 실제 파일·크기·대표 이미지 확인 완료 |
| Gather·ZEP을 실제 UX 레퍼런스로 활용 | 사용자 추가 방향 반영 | 플레이/회의는 Gather Classic, 공간/맵 관리는 ZEP 기준. 상세 대응은 07 문서 |
| React 기반 웹 | 사용자 확정 | TypeScript/Vite UI + Phaser 도트 월드를 기본 구현안으로 사용 |
| Java + Spring Boot + Spring WebSocket | 사용자 선호를 반영한 기본안 | API와 실시간 월드 모듈, 동기화·큐·재접속 직접 구현 |
| MariaDB + Spring Data JPA + Flyway + Redis | 사용자 선호를 반영한 기본안 | 관계 데이터·마이그레이션·접속/예약·캐시를 분리 |
| LiveKit Cloud | 검증 후보 | G0 수신 권한 강제 검증 전 확정하지 않음 |
| mediasoup + coturn | 명시적 대안 | LiveKit 요건 미충족 시 검증 후 채택, 관련 구현·운영 태스크에 반영 |
| 근거리 5/7타일·20Hz·12명 대화 | 초기 튜닝 제안 | 실제 맵·지연·사용성 시험 |
| 국내 우선 배포·데스크톱 우선 | 기본 가정 | 첫 공개 대상과 사용 기기 확인 후 조정 |
| 에셋 공개 배포 권한 | 미확인 | 출처/제공 조건/로고 가이드 확인 |
| 월 예산·공급자·총 서비스 CCU | 미정 | 스테이징 개설 전 사용량/비용표 작성 |

## 3. 구현 때 남길 ADR

- ADR-001: React 웹·Java/Spring 서버 구성, JDK/Boot/Gradle·MariaDB·프론트 Node·패키지 호환 버전.
- ADR-002: 미디어 엔진과 서버 수신 권한 검증 결과. 미통과 항목을 숨기지 않는다.
- ADR-003: 단일 공간/맵 인스턴스·세션/좌석 예약·재접속 정책.
- ADR-004: 맵 스키마·tile/anchor·avatar frame layout·에셋 변환 규칙.
- ADR-005: 게시/롤백·편집 lease·운영 중 맵 전환.
- ADR-006: 초기 배포 지역·자원·실제 100명 부하와 비용.
- ADR-007: 메시지/로그/탈퇴 데이터 보존 정책.

## 4. 지금 바로 필요한 결정과 나중에 해도 되는 결정

G0에서 먼저 확정할 것은 미디어 엔진, 원본 아바타 프레임 해석, 브라우저 지원 기준이다. 후속 사용자 결정에 따라 G1의 로그인은 GDG HUFS SSO를 사용하며 관리자 client ID/secret 발급과 콜백 등록이 필요하다. 위 Google OIDC/OAuth2 자료는 대체된 초기 선택의 조사 기록이다. 현재 계약 근거는 클론한 `hufs-code-master-server`의 API.md, SsoClient/DTO, MemberStatus다. 스테이징 배포 전에는 공급자·월 예산·도메인·에셋 배포 권한을 준비한다.

결제·녹화·AI 회의록·앱 마켓·수천 명 채널링·글로벌 리전은 실제 필요가 생겼을 때 상세 설계를 확장한다. 계획 이후 로컬 캠퍼스와 Spring 월드, 실제 MariaDB·Redis 개발 환경을 구현했다. 최신 상태는 [구현 기록](../implementation/01-local-world.md)을 따른다. 외부 계정 개설·유료 자원 생성·공개 배포는 수행하지 않았다.
