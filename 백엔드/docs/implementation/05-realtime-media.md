# 근거리 음성·화상·화면 공유

React UI → Spring 인증 WebSocket → Node mediasoup SFU를 연결했다. 기존 SSO, MariaDB/Redis, 공간 입장권과 맵 편집 경로를 유지한다. 실제 Chromium과 Docker의 native mediasoup worker로 검증한다.

## 사용하기

```powershell
# 백엔드 폴더
./scripts/media.ps1 start
./scripts/dev.ps1 stop
./scripts/dev.ps1 start
```

`media.ps1 start`는 `.env`에 서버 전용 control token을 생성하고 미디어 기능을 켠다. 기존 SSO secret은 수정하지 않는다. 다음 dev 실행에서 API와 월드가 설정을 읽는다. 중지·상태 확인은 `media.ps1 stop`, `media.ps1 status`다. 미디어만 중지하면 월드는 유지되고 UI에 연결 상태가 표시된다.

입장 폼에서 **입장 전 마이크·카메라 확인**을 누르면 장치를 미리 점검할 수 있다. 각 테스트는 사용자 클릭 뒤에만 장치를 켜며, 마이크 입력 수준·카메라 미리보기·짧은 스피커 테스트를 제공한다. 이 테스트 스트림은 SFU에 보내지 않고 창을 닫거나 입장하면 정리한다. HTTP 비보안 주소처럼 브라우저에서 장치 접근을 막는 환경에는 localhost/HTTPS 안내를 표시하며 미디어 없이 입장할 수 있다.

공간에 입장한 뒤 아래 마이크·카메라·화면 공유 버튼을 사용한다. 기본은 모두 꺼짐이다. 장치 설정에서 입력/카메라/지원되는 브라우저의 출력 장치를 고르고, 마이크 입력 수준과 카메라 미리보기를 확인한다. 활성 장치 변경이 실패하면 선택을 이전 장치로 되돌리고 기존 트랙을 유지해, 실제 송출과 선택 UI가 어긋나지 않게 한다. 자동 재생이 막히면 “대화 소리 켜기”를 누른다. 공유 화면은 확대하거나 고정할 수 있다.

인터넷 환경에서는 미디어 compose의 `MEDIA_ICE_SERVERS_JSON`에 TURN/STUN 서버 배열을 넣는다. 각 항목은 `urls`(문자열 또는 문자열 배열)를 가지며, 필요하면 정적 `username`·`credential`도 사용할 수 있다. 운영에서는 `MEDIA_TURN_SHARED_SECRET`을 Coturn의 `--static-auth-secret`과 동일하게 설정하고 TURN URL만 지정하는 방식을 권장한다. Media는 capabilities 요청마다 만료 시각과 무작위 식별자를 포함한 사용자명을 만들고 HMAC-SHA1 Coturn REST credential을 발급한다. 브라우저에는 만료가 설정된 credential만 전달되고 공유 비밀은 전달되지 않는다. 유효 시간은 `MEDIA_TURN_CREDENTIAL_TTL_SECONDS`(기본 21600초, 허용 60~604800초)로 조절한다. 정적 자격 증명은 호환성을 위해 지원하지만 브라우저에서 확인할 수 있으므로 장기 운영 비밀로 사용하지 않는다. 인증 정보도 공유 비밀도 없는 TURN URL은 서비스 시작 시 거부한다. 목록이 비어 있으면 직접 ICE 후보만 사용한다.

**눌러 말하기**를 켜면 마이크 버튼을 누르고 있거나 `V` 키를 누르는 동안에만 마이크 트랙을 활성화한다. 버튼에 포커스가 있을 때는 Space/Enter를 누르고 있는 동안도 송출한다. 손가락/키를 놓거나 창 포커스·브라우저 탭·통화 구역이 바뀌면 바로 음소거한다. `V` 단축키는 입력란이나 열린 대화상자에서는 동작하지 않으며, 보조 기술에 `aria-keyshortcuts`로 제공된다. 눌러 말하기를 끄면 마이크 트랙과 송출 producer를 정리한다.

공용 공간의 수신 음량은 서버가 MediaState로 보낸 근거리 진입/이탈 거리를 기준으로 위치에 따라 부드럽게 줄어든다. PRIVATE 회의실은 거리와 관계없이 일정 음량을 유지한다. 이 클라이언트 감쇠는 이미 서버가 허용한 peer의 재생 음량만 조절하며, 통화 접근 권한이나 peer 집합은 바꾸지 않는다.

통화 상태창의 **사람별 음량**에서 현재 대화 가능한 상대의 로컬 재생 음량을 0~100%로 조정하거나 음소거할 수 있다. 개인 음량은 현재 접속 화면에만 적용되고 거리에 따른 감쇠와 곱해진다. 상대가 나가면 설정을 정리하며, 상대의 장치나 송출 권한은 바뀌지 않는다.

카메라가 둘 이상 보이면 통화 상태창에서 세로 목록과 갤러리를 전환할 수 있다. 각 카메라의 핀 버튼으로 메인 화면에 고정하고 나머지 카메라는 보조 목록으로 둔다. 이 레이아웃과 고정은 각 사용자 화면의 로컬 표시 상태이며 상대 위치·통화 경계·송출 상태를 바꾸지 않는다.

카메라·공유 화면은 대화 대상으로 허용된 사람에게만 표시된다. 공용 구역은 근거리, 회의실 A/B는 각 구역, 집중 구역은 무음이다. 화면 공유 범위는 현재 대화 구역과 같으며 구역/연결 변경 시 종료된다. 브라우저의 공유 종료 버튼과 장치 권한 종료도 처리한다.

## 코드

| 영역 | 파일 | 책임 |
|---|---|---|
| 정책 | `modules/domain/.../MediaPolicy.java` | 거리, 구역, epoch, source 허용, 쌍별 상한 |
| 월드 | `apps/world/.../WorldHandler.java` | 위치/맵 전환 보류, 회수 ACK, WS 요청 바인딩 |
| 제어 | `apps/world/.../MediaGateway.java` | 제한된 비동기 HTTP, 짧은 정책 lease |
| SFU | `apps/media/src/engine.mjs`, `server.mjs` | router/transport/producer/consumer 수명과 수신 정책 |
| 웹 | `프론트/src/media/MediaController.ts` | 장치 동의, 송수신, 재연결, 종료·실패 정리 |
| 화면 | `프론트/src/media/MediaPanel.tsx`, `media.css` | 버튼, 영상, 공유 확대·고정, 장치 설정, 오류 안내 |
| 계약 | `contracts/world.schema.json` | 네 가지 미디어 타입과 정책 거리 포함, 45개 Java record/TypeScript interface 생성 |

미디어 RPC는 `capabilities`, `createTransport`, `connectTransport`, `produce`, `closeProducer`, `consume`, `resumeConsumer`, `closeConsumer`, `stats`다. SDP/RTP 구조는 JSON 문자열 `dataJson`으로 전송한다. WS 최대 64KiB, dataJson 32KiB, 클라이언트/연결당 pending 8개, 요청 5초 timeout이다. 일반 이동 패킷 크기 제한은 별도로 유지한다. `stats`는 요청한 참가자 자신의 미디어 통계만 반환한다.

클라이언트는 SFU transport의 `failed` 상태에서 즉시 복구하고, 모바일 네트워크 전환 중 잠깐 나타나는 `disconnected`는 transport별로 5초 유예한다. 유예 중 다시 연결되면 타이머를 취소하고, 한 transport라도 계속 끊겨 있으면 기존 producer/consumer/transport를 닫고 제한된 재시도 횟수 안에서 다시 연결한다. 퇴장·정책 전환·재시도 시에는 유예 타이머도 함께 정리한다.

월드 정책은 참가자 쌍별 후보를 한 번 생성하고 ID 인덱스에서 역할·행사 정보를 조회해 상한을 선택한다. 후보 생성은 O(n²), m개 후보 정렬은 O(m log m)이며 후보마다 참가자 전체를 재검색하던 O(n³) 경로는 제거했다. 한 공간 100명에서 최대 4,950개 쌍을 평가한다.

## 재현 검사

후보 A LiveKit 실행 비교는 `../scripts/livekit-spike.ps1`로 실행한다. 이 스크립트는 로컬 loopback 포트에만 바인딩한 LiveKit 1.13.7 임시 컨테이너와 별도 Vite 포트를 사용하고 종료 시 컨테이너와 설정 파일을 정리한다. 프런트의 `tests/e2e/livekit-spike.spec.ts`는 LiveKit JS SDK 2.22.3과 Chromium 합성 장치로 세 참가자의 마이크·카메라·화면 영상·화면 오디오를 확인하고 수신 RTP 통계, 마이크 전용 grant의 카메라 거부를 검사한다. 테스트 전용 의존성/fixture이며 제품의 mediasoup 연결 경로를 바꾸지 않는다.

2026-09-24 미디어 구역 식별자 보강: 월드 room key의 `|` 구분자가 SFU 허용 문자에서 빠져 정책 프레임이 거부되던 문제를 수정했다. `MediaPolicy`가 내부 room separator를 SFU 안전 문자로 정규화하며 도메인 테스트로 형식을 고정했다. Node 정책 검증은 참가자·구역·epoch, peer 목록, 송출 source 목록을 구분해 거부 이유를 반환하고 월드는 미디어 정책 전달 실패/복구를 같은 이유별로 한 번씩 기록한다. `:modules:domain:test`, mediasoup native worker 테스트 8/8, Chromium 실시간 미디어 E2E 3/3, API/world bootJar가 통과했다. E2E는 합성 화면/오디오와 가상 마이크·카메라를 사용하고 직접 ICE로 연결했으므로 실기기·TURN·외부망 검증은 남아 있다.

```powershell
./scripts/gradle.ps1 test :apps:api:bootJar :apps:world:bootJar
./scripts/media.ps1 test
./scripts/e2e.ps1 -SkipBuild -Media -TestFile tests/e2e/media.spec.ts
./scripts/e2e.ps1 -SkipBuild
# 100명 SFU PlainTransport RTP fan-out (isolated Docker, no published ports)
.\apps\media\scripts\fanout-capacity.ps1 -Listeners 99 -DurationSeconds 8 -MinimumReceivedBytes 5000
# 프론트 폴더: pnpm test; pnpm contracts:check; pnpm build
```

미디어 브라우저 검사는 별도 preview API/월드/Vite를 임시 포트에 띄우며 실제 SSO 세션을 사용하지 않는다. 카메라·마이크는 Chromium 가상 장치, 화면은 테스트 전용 canvas와 오디오 신호를 쓴다. 사용자의 실제 장치나 데스크톱을 자동 캡처하지 않는다. 프로덕션 앱에는 테스트 전용 장치·위치 변경 API를 넣지 않았다.

검사 항목:

- Java 정책: A-B-C 비전파, 경계·무음·차단 필드, epoch, 100명 입력 시 대칭/상한/결정성, source 음소거.
- Java 월드: 회수 ACK 이전 위치 변경 차단, 전환 중/옛 epoch RPC 거부, ACK 없는 lease 대기, 맵 게시 시 회수 순서.
- Node: 오래된 정책/epoch 차단, 비동기 Consumer 생성 중 정책 변경, 수신 상한, 화면·오디오 소유자 일치, fence 정리.
- Native worker: paused Consumer 생성/재개, 허용 철회 시 실제 Consumer 종료, lease 만료 시 실제 transport/producer 종료.
- Chromium: 실제 RTP 수신, 거리 이탈 후 SFU Consumer 제거와 새 영상 프레임/오디오 샘플 수신 중단, 세 명의 회의실 안팎 분리, 화면 자동 재공유 방지, 무음 구역 캡처 종료, 권한 거부, 장치 설정, 퇴장 시 PeerConnection 종료.

실행 결과와 현재 남은 범위는 [태스크 실행 기록](../planning/08-task-backlog.md)에 기록한다. `프론트/test-results`에 실패 trace/스크린샷 및 성공 시 RTP JSON 첨부가 생성된다. 실제 RTP 검사는 mocks만 사용하는 정책 검사와 구분한다. RTP 패킷 개수에는 재전송 등이 포함되고 오디오 전체 샘플에는 로컬 합성 concealment가 포함되므로, 회수 검사는 SFU Consumer 0개와 새 영상 프레임·합성분을 뺀 오디오 샘플 수신 중단을 함께 확인한다. [W3C 통계 정의](https://www.w3.org/TR/webrtc-stats/).

2026-09-28 React 월드 UI 스냅샷 갱신 최적화: WorldConnection은 새 player/room 상태를 즉시 저장하고 게임용 `onSnapshot`에는 매 tick 전달하지만, React 구독 알림은 250ms마다 한 번으로 묶는다. 월드 연결/채팅/정책 변경 알림은 즉시 유지된다. 전체 프론트 단위검사 156/156, 타입검사, production build 및 발표 도구 기본 숨김·핵심 조작 E2E 1/1이 통과했다. 완성 React 화면 50개를 한 개발 PC에서 실행한 재검사는 42명 입장 후 host CPU가 95% 이상인 상태로 20초 지속되어 안전 중단했다(최소 여유 메모리 2,460MiB, 페이지 오류 0). 이는 다수 Chromium 창을 한 PC에서 실행한 부하 한계이며 서버의 50명 실패나 운영 용량 증거로 해석하지 않는다. [원시 결과](evidence/26-world-snapshot-ui-coalescing-2026-09-28.json). 이 시험으로 T26.1은 완료되지 않는다.

2026-09-28 스냅샷 최적화 후 일반 근거리 100명 RTC 재검증: 100/100 WorldConnection·MediaController 인스턴스가 입장·권위 이동·공간 채팅을 완료했고, 발표/행사 모드 없이 12개 마이크 송신자의 144/144 inbound 오디오 RTP 트랙을 60초 지속했다. 모든 트랙에서 ICE·DTLS 연결과 RTP 증가가 확인됐으며 트랙별 최소 증가량은 176,744 bytes·3,002 packets였다. CPU peak 99%, 종료 가용 메모리 8,086MiB였고 안전 중단은 없었다([결과](evidence/26-rtc-capacity-100-modules-12-mics-60s-2026-09-28.json)). 이는 실제 제품 연결/미디어 모듈과 격리 loopback SFU 검사이며 React 화면 100개, 영상/화면 공유, 공용 TURN 및 운영 ARM64를 포함하지 않아 T26.1은 미완료다.

## 남은 범위

현재 남은 검증은 공용 인터넷의 Coturn 주소·방화벽·모바일망 연결, 다양한 하드웨어·모바일 브라우저, 100명 미디어 부하다. 회의실 잠금/노크/정원·호스트 승계·강퇴는 Chromium 다중 브라우저와 합성 미디어로 실제 SFU RTP까지 검증했다. 차단·DND, 발표 역할과 공간/근거리 채팅은 코드 경로가 구현되어 있으며 해당 기능의 추가 계정·실제 장치 조합 확인은 태스크 백로그에 남아 있다. 다중 월드 노드 확장은 별도 확장 태스크다. 세부 결정과 시간/용량 제약은 [ADR 0004](../adr/0004-media-sfu.md)를 따른다.

2026-09-21 검증: Java 26 + DB/Redis 통합 14 + 웹 단위 15 + 미디어 worker/정책 8 + 전체 브라우저 13 = **76개 통과**. 계약/타입 및 Java·React 빌드 성공. [보관한 수신 통계](evidence/05-media-local.json), [실제 테스트 렌더링](evidence/05-media-connected.png). localhost:5173은 미디어 기능을 활성화해 재시작했고 기존 SSO 계정의 입장·통화 준비 상태를 확인했다.

2026-09-22: 입장 폼에 선택형 사전 장치 확인을 추가했다. 마이크·카메라 테스트는 각각 사용자 조작으로 시작하며, 로컬 분석/미리보기만 수행하고 입장 또는 창 닫기 때 모든 트랙을 정리한다. 지원 브라우저에서는 선택 출력 장치로 테스트 음을 재생한다. `pnpm build` (TypeScript + Vite) 통과. 실제 하드웨어·모바일 브라우저 동작은 아직 확인하지 않았다.

2026-09-22: 눌러 말하기를 추가했다. 모드를 켜면 마이크 권한을 명시적으로 요청하고 송출은 음소거로 준비한다. 화면의 마이크 버튼 또는 `V` 키를 누르고 있는 동안만 송출하며 pointer/key release, 창 흐림, 탭 숨김, 미디어 policy 전환에서 놓침 없이 음소거하도록 했다. 눌러 말하기를 끄면 마이크 트랙도 정리한다. 이번 변경은 TypeScript·Vite 빌드로 확인하고 실제 키보드/터치·장치 조합은 아직 수동 검증하지 않았다.

2026-09-22: 서버의 `MediaPolicy` 진입/이탈 반경을 `mediaState` 계약으로 전달하고 공용 공간의 remote audio에 거리 감쇠를 적용했다. 가까이에서는 정상 음량, 이탈 반경에서는 12%로 부드럽게 감소하며 PRIVATE 방은 일정 음량을 쓴다. 프론트의 플레이어 위치 snapshot만 사용하고 서버 peer/consumer 권한은 그대로 유지한다. 계약 검사와 API/world bootJar·프론트 build로 확인하며 실제 여러 기기에서의 청감 검증은 남겼다.

2026-09-22: 사람별 음량 패널을 추가했다. 서버가 허용한 참가자별 0~100% 로컬 재생 음량과 음소거를 제공하며 같은 사람의 마이크/화면 오디오에 함께 적용한다. 거리에 따른 감쇠와 합성하고 참가자가 공간을 나가면 로컬 상태를 정리한다. `pnpm build` 통과. 실제 동시 참가자의 독립 음량·음소거 청감은 아직 수동 검증하지 않았다.

2026-09-22: 카메라 목록/갤러리 전환과 참가자 카메라 고정을 추가했다. 고정된 타일은 크게 표시되고 나머지는 보조 목록에 남으며, 원본 비디오와 미디어 권한은 건드리지 않는다. 참가자가 카메라를 끄거나 나가면 존재하지 않는 고정 상태를 자동 정리한다. `pnpm build` 통과. 다자간 실제 카메라 화면에서 레이아웃과 모바일 배치를 수동 검증하지 않았다.

2026-09-23: 100명 정책에서 후보 제한을 적용할 때 매 후보마다 전체 참가자 목록을 두 번 검색하던 경로를 ID 인덱스 조회로 바꿨다. 정책의 pairwise 선택·거리 hysteresis·peer 상한은 그대로 두고 후보 선택의 중복 O(n) 검색을 제거했다. world bootJar로 컴파일을 확인했으며, Docker 기반 실제 RTP/100명 부하는 별도 검증 범위로 남아 있다.

2026-09-23: 미디어 transport가 `disconnected`에 머무르는 모바일 네트워크 전환을 처리하도록 transport별 5초 유예와 복구 재시도를 추가했다. 유예 중 복구되면 재연결하지 않고, 계속 끊겨 있으면 producer·consumer·transport를 회수한 뒤 기존 재시도 제한을 적용한다. 퇴장·전환 시 타이머도 정리한다. 프론트 production build 통과. 실제 네트워크 전환·TURN 릴레이와 장시간 하드웨어 검증은 수행하지 않았다.

2026-09-23: 서버 정책이 원격 source를 회수할 때 브라우저 Consumer와 오디오/비디오 뷰도 같은 정책 갱신에서 바로 닫도록 보강했다. 이전에는 receive 루프가 다른 SFU 응답을 기다리는 중이면 UI 원격 트랙 정리가 늦어질 수 있었다. Docker mediasoup native-worker 검사 8/8, Chromium 실제 RTP 검사 3/3, React production build를 통과했다. 브라우저 검사는 음성·카메라·화면/화면 오디오 수신과 근거리 이탈 후 SFU Consumer 및 신규 RTP 중단, 세 참가자의 회의실 경계·재진입·화면 재공유 방지, 무음 구역 캡처 종료·권한 거부를 포함한다. 원격 트랙은 `[data-source]` 오디오만 대상으로 검사해 맵 환경음 재생용으로 항상 존재하는 빈 오디오 요소와 구분한다. 현재 결과는 로컬 Docker 직접 연결 환경이다. 실제 TURN relay, 모바일 하드웨어와 100명 미디어 부하는 아직 검증하지 않았다.

2026-09-24: Docker Coturn을 relay-only로 사용하는 Chromium 두 참가자 E2E에 TURN 일시 중단·복구를 추가했다. 양쪽 ICE 단절 후 TURN을 재개하고 연결 이벤트·ready 복구·마이크/카메라 RTP 재개를 확인했으며, 화면 공유는 자동 재개되지 않고 사용자가 다시 시작해야 하는 동작도 검사했다. React production build, Prettier와 TURN E2E 1/1 통과. 테스트 전용 TURN/media 컨테이너와 네트워크는 실행 후 정리한다.

2026-09-24: 세 Chromium 참가자가 실제 SFU로 공용 공간에서 통화한 뒤 Alice와 Bob을 별도 PRIVATE 회의실로 이동시키는 경로를 확인했다. 방 밖 참가자의 audio/video Consumer와 새 RTP를 회수하고, 방 안 두 사람 사이의 카메라·마이크 및 사용자 조작 후 화면/화면 오디오를 복구한다. media zone 전환 검사에서 비동기 타이밍을 추적할 서버 통계·응답 진단을 추가하고 RTP 통계 대기를 미디어 협상에 맞췄다. `scripts/e2e.ps1 -SkipBuild -Media -TestFile tests/e2e/media.spec.ts -TestName 'three peers'` 재실행 통과, Docker native worker 검사 8/8 통과. T05.3 완료. 공용 외부망·모바일 실기기·100명 RTP 부하는 별도 검증으로 남긴다.

2026-09-24: 미디어 전용 Playwright 6/6과 TURN relay-only 장애/복구 E2E 1/1을 실행했다. 입장 전 점검은 Chromium 합성 장치로 마이크 입력계·카메라 프리뷰·스피커 재생, NotAllowed/NotFound 오류, 사용 중 마이크 track 종료, 점검 스트림의 로컬 전용·입장 시 트랙 종료, 장치 없이 입장을 확인했다. PTT test는 V 키·버튼 누름, keyup·blur·visibilitychange·pointer up·채팅 입력 시 해제를 확인했다. 입력 장치 교체 시 PTT 대기 중 새 track이 기본 활성화되어 마이크가 열릴 수 있는 경로를 수정하고, 기존 track 종료·새 track 음소거·PTT 재개를 검사했다. 실제 SFU RTP 및 근거리/PRIVATE/SILENT 경계 회수·퇴장 정리, TURN relay 차단/복구 뒤 마이크·카메라 재송신과 화면 공유의 명시적 재시작도 통과했다. 프론트 Vitest 27개, TypeScript/Vite build, 69개 계약 검사와 Prettier를 확인해 T12.1~T12.3을 완료했다. 실기기·모바일망·100명 동시 미디어 부하는 별도 태스크다.

2026-09-24: 공개 구역 거리 음량 계산을 `proximityAudioVolume`으로 분리했다. 진입 반경 안에서는 100%, 이탈 반경에 도달하면 12%까지 smoothstep으로 낮추며 PRIVATE는 거리와 무관하게 100%를 유지한다. 잘못된 거리·반경 입력의 fallback도 단위 검사로 고정했다. 행사 운영 패널과 통화 상태가 겹치던 부분은 데스크톱에서 상태 영역을 오른쪽으로 이동하고, 900px 이하에서는 운영 도구를 접은 상태로 시작하게 수정했다. 운영 도구가 표시된 Chromium에서 사람별 음량 창을 열고 상대 이름을 확인하는 실제 SFU 시나리오 1/1, 전체 미디어 브라우저 검사 6/6, 프론트 단위 30/30, 69개 계약, Prettier·production build가 통과해 T13.1을 완료했다. 실제 하드웨어 거리 청감, 회의실 운영과 구역 전환 권한 검증은 남아 있다.
2026-09-24: PRIVATE 회의실 잠금·노크 승인 브라우저 E2E를 실제 Docker SFU로 확장했다. 승인 전에는 호스트 offers가 손님에게 전달되지 않고 승인 후 같은 방에서 마이크·카메라 RTP가 들어오며, 강퇴 뒤 미디어 관계가 회수된다. 호스트 WebSocket을 끊고 복구했을 때 같은 참가자 ID와 송출이 복구되고 남아 있던 참가자가 새 호스트가 되어 이전 호스트를 내보내는 권한 승계도 확인했다. 월드 잠금·노크·정원·역할 JUnit 통합 검사, 기본 전체 미디어 E2E 7/7, 확장 회의실 E2E 1/1, 프론트 단위 30/30, Prettier 및 production build 통과. T13.2/T13.3 완료. 실제 하드웨어·모바일·공용망과 100명 RTP 부하는 별도 검증 범위다.

2026-09-25: 눌러 말하기 버튼에 `V`, `Space`, `Enter` 키 조합 안내를 추가하고, 보조 기술에 단축키와 누름 상태를 노출한다. Docker SFU의 브라우저 검사에서 키별 누름 동안에만 실제 마이크 트랙이 활성화되고 키를 떼면 음소거되는 것을 확인했다. axe-core WCAG 2.1 A/AA 검사에서 선택 상태 미디어 버튼의 대비 위반을 찾아 선택 녹색을 어둡게 조정했다. 마이크/카메라 설정 대화상자는 첫 포커스·Tab 순서·Escape 닫기·호출 버튼으로의 포커스 복귀, 대화상자 접근성 검사까지 확인했다. 관련 미디어 E2E 1/1 통과.

2026-09-25: SFU 정책 적용 중 참가자별 허용 offer 집합을 한 번 계산해 consumer 회수와 응답에 재사용하도록 했다. 12명·여섯 명 동시 발화 Chromium E2E가 1/1 통과했고, 여섯 producer, 각 참가자의 기대 inbound Consumer 수, 참가자별 실제 RTP 수신을 확인했다. 격리 Docker SFU control 요청 계측에서는 policy 최대 320ms/RPC 최대 207ms였고, 해당 World 실행에 정책 HTTP timeout 1회와 187ms 뒤 복구가 기록됐다. 별도 최대치 시험에서 12명 전원 입장은 성공하고 첫 일곱 발화자의 producer 검사가 통과했지만, 여덟 번째는 producer 요청 없이 실패했다. 그 실행의 RPC 경로는 550~556ms였으며 캡처 track과 통화 전환의 상세 원인은 미확정이다. 12명 전원 송출은 완료로 세지 않는다. 반복 안정성·최대 근거리 발화 수·100명 행사 fan-out을 확인해야 해 T26.1은 미완료다. Docker Linux 미디어 전체 검사 26/26, 프론트 TypeScript와 Prettier도 통과했다.
2026-09-24: 발표 도구가 열린 화면에서 통화 상태창이 공유 화면 고정/확대 버튼을 덮던 겹침을 확인해 공유 카드 위치를 조정하고 확대 보기 레이어를 정리했다. Chromium 합성 display track을 사용해 실제 SFU 화면/화면 오디오 RTP, 브라우저 share-ended 이벤트 정리, NotAllowedError 안내를 확인했다. 상대 카메라가 있는 갤러리에서 카메라·공유 화면 고정과 확대를 조작해 위치, 정책 epoch, peers/offers에 영향이 없음을 검사했다. SFU E2E 1/1, 프론트 Vitest 30/30, Prettier, TypeScript/Vite production build 통과. T14.1/T14.2 완료. 운영자 차단/source 제한 연계와 실기기/모바일 검증은 남아 있다.
2026-09-24: World moderation refresh가 제한 source와 epoch를 갱신하고, 활성 world block은 `MODERATION_KICKED`로 세션을 내보내는 JUnit 통합 검사를 추가했다. 브라우저가 SCREEN만 제한받아도 `SCREEN_AUDIO`를 함께 종료하도록 정책을 정규화했다. 실제 Docker SFU E2E에서 화면/오디오 RTP 뒤 source 제한으로 capture 두 개, producer, 상대 재생을 닫고, 제한 해제 후 다시 공유한 뒤 강퇴 오류에도 정리되는 것을 확인했다. 월드 전체 테스트·`WorldModerationMediaTest`, 프론트 Vitest 32/32, source 제한 SFU E2E 1/1, 기본 화면공유/경계/퇴장 E2E 1/1이 통과해 T14.3을 완료했다. 관리자 실 SSO 조작·다중 월드 운영 확인은 T24.2에 남긴다.

2026-09-25: 한 SFU PlainTransport RTP fan-out 검사에서 발표자 1명과 청취자 99명 모두에게 실제 오디오 RTP를 전달했다. 소비자별 RTP 통계가 99/99 증가하고 청취자별 UDP 수신 최소값은 60,213 bytes였다. 격리 `--network none` Docker 실행에서 peak memory 55.16 MiB를 기록했다. 이는 SFU RTP fan-out 기능/자원 검사이며 브라우저 WebRTC ICE/DTLS, 디코딩, 입장 폭주 성능 근거는 아니다. [태스크 실행 기록](../planning/08-task-backlog.md) · [JSON 결과](evidence/26-media-fanout-2026-09-25.json).

2026-09-26: 12명 동시 발화 trace와 World 로그에서 정책 lease 만료에 따른 미디어 세션 재생성을 확인했다. lease를 2초로 늘리는 조정은 6명 발화 재검사에서도 실패해 되돌렸다. 대신 World 정책 snapshot은 Scheduler 대기 중 보관하되 lease 시각은 실제 HTTP 전송 직전에 생성하도록 수정했다. SFU의 2초 상한과 프론트의 오래된 세대 트랙 중지 동작은 그대로 유지했다. `:apps:world:test`와 6명 실제 RTP 재검사 결과를 기다리고 있다.

2026-09-26 후속 조사: Windows World와 Docker SFU의 벽시계 차이가 약 4.8초라 absolute `expiresAt` 정책 프레임이 정상 상태에서도 `MEDIA_INVALID`로 거절되는 원인을 확인했다. 제어 프레임을 `leaseMillis` 상대값으로 바꾸고 SFU가 수신 시각부터 최대 2초 만료를 계산하도록 했다. 정책 HTTP timeout에는 최신 snapshot을 한 차례 재전송한다. Linux Docker 미디어 검사 27/27, World 전체 테스트와 패키징이 통과했다. 12명·6명 발화 검사는 모든 참가자의 inbound RTP 조건까지 도달했지만, 마지막 참가자별 server stats 요청이 `MEDIA_STALE`로 실패했고 실행 중 World의 policy HTTP timeout/연결 종료가 한 번 기록됐다. 반복 안정성 및 해당 제어 경로 실패 처리는 남아 T26.1은 미완료다.

2026-09-26: policy 재전송이 `HttpTimeoutException`만 처리해 `IOException` 연결 종료를 놓치는 경로를 추가로 고쳤다. 최신 snapshot으로 한 번 재시도하고 이전 callback은 폐기하는 `MediaGatewayPolicyRetryTest`를 추가했다. World 전체 테스트·패키징 통과 후 12명·6명 동시 발화 Chromium E2E를 2회 연속 실행해 두 번 모두 실제 producer/consumer 통계와 참가자 전원의 inbound RTP 5KB 초과를 확인했다(5.0분, 4.2분). 첫 실행에서 policy 요청 timeout 한 번이 213ms 뒤 재전송 성공으로 회복됐고 테스트도 통과했다. [Playwright report](../../프론트/playwright-report/index.html) · 상대 lease가 적용된 실제 mediasoup PlainTransport 100명 검사도 재실행해 청취자 99/99 전원 수신, 최소 청취자 60,213 bytes, SFU worker RSS 11.88 MiB, Docker peak memory 57.18 MiB를 기록했다. [100명 fan-out 결과](evidence/26-media-fanout-2026-09-26.json). 이는 두 번의 12인 브라우저 검사와 격리 SFU RTP fan-out 증거다. 실제 브라우저 100명 ICE/DTLS, 입장 폭주 반복, 외부 TURN·장시간 통합 부하는 계속 남아 T26.1은 미완료다.

2026-09-26: 100명 동시 입장 때 무거운 join 처리 때문에 actor tick이 몰리는 현상을 줄이기 위해 실제 참가자 join만 bounded actor queue로 분리했다. snapshot ACK·채팅 등 일반 실시간 명령은 기존 큐에서 틱당 최대 512개를 처리하고, join 기본 예산은 틱당 8개다. 입장 큐 크기·용량·거절 수를 Actuator/Prometheus에 노출하고 별도 경보와 dashboard 패널을 추가했다. Docker World 전용 100 WebSocket 부하에서 100명 전원 입장·전체 roster·이동, 초과 참가자 `FULL`, 입장 큐 소진을 확인했다. 5초 warmup과 15초 steady 측정의 join convergence는 733ms, steady tick p95는 3.65ms, steady tick 초과는 0회였고 양쪽 큐는 측정 종료 시 비어 있었다. join 구간은 14틱 중 3회 50ms를 넘었으므로 burst 지연은 줄었지만 틱 초과가 완전히 사라진 것은 아니다. [실행 결과](evidence/26-world-join-queue-docker-100-15s-2026-09-26.json). 이는 World WebSocket actor 단독 부하이며 브라우저 ICE/DTLS, TURN, SFU RTP와 15분 warmup·30분 steady 통합 부하는 남아 T26.1은 미완료다.

2026-09-26 후속: 관리자 engagement 상태 생성 때 공간 맵의 오브젝트를 반복 순회하던 부분을 room·published sequence·map revision 기준 actor 소유 cache로 바꾸고, 빈 방 항목 정리와 캐시 경계 테스트를 추가했다. `:apps:world:test` 전체 통과. 격리 Docker 100명 재측정은 전원 입장·이동·roster 동기화와 101번째 `FULL`을 확인했고, 수렴 708ms, join 13틱 평균 31.80ms·50ms 초과 3회, steady mean 2.38ms·rolling p95 4.70ms·50ms 초과 0회였다. 직전 733ms/3회와 비교해 뚜렷한 초과 틱 감소는 입증하지 못했다. 종료 표본의 일반 명령 큐 100은 snapshot ACK 처리 대기분, join 큐는 0이었다. 실제 ICE/DTLS/RTP 브라우저 재검사는 격리 2인 실행을 시작했지만 호스트 여유 메모리가 2,274MiB에서 안전 하한 2,048MiB 아래인 2,039MiB로 내려가 자동 중단됐고 첫 페이지 로드 중 Chromium이 닫혔다. 미디어 연결 성공 근거는 아니다. [안전 중단 결과](evidence/26-rtc-capacity-2-safe-stop-2026-09-26.json). 공유 API/World 및 데이터 서비스는 계속 healthy였고 재시작하지 않았다. 첫 실행은 메모리 보호 한계로 안전 종료됐고, 후속 2인 RTP 검사 결과를 아래에 추가했다. T26.1은 미완료다.
2026-09-26 최종 재측정: join 큐 대기 작업을 각 tick의 `commands`, `joins`, `simulation`, `room_state`, `maintenance`, `media_policy`, `snapshots`, `publication` 단계별 Timer로 나누고 단일 join 작업 시간도 측정하도록 했다. 기본 맵의 공개용 JSON payload는 첫 join tick 대신 World 시작 때 미리 직렬화한다. 전체 World 테스트 통과. 격리 Docker 100 WebSocket 부하에서 100명 전원 입장·이동·전체 명단과 101번째 `FULL`을 확인했다. 연결 357ms, roster 수렴 771ms, join 14틱 중 4회 50ms 초과였다. 개별 join 명령 최대 43.6ms였지만 batch join 최대 57.4ms, snapshots 평균 37.8ms·최대 59.1ms로 burst 기준은 아직 통과하지 못했다. 안정 구간 평균 2.33ms·rolling p95 5.23ms·50ms 초과 0회. [최종 JSON](evidence/26-world-join-queue-docker-100-15s-2026-09-26.json). 메모리 여유 확보 후 격리 Chromium 2인 행사용 오디오 검사가 통과했다. 가짜 마이크 하나의 offer와 상대 ICE/DTLS 연결, inbound RTP 11,479 bytes/205 packets를 확인했다. [RTC 결과](evidence/26-rtc-capacity-2-ice-dtls-rtp-2026-09-26.json). 이는 2인 행사 오디오 경로만 확인하며 카메라·화면 공유·100인 브라우저 부하·TURN·15분/30분 통합 부하는 남아 T26.1 미완료다. 공유 API/World 및 DB 컨테이너는 재시작하지 않았다.
2026-09-27 용량 재검증: 현재 `apps/media` 소스로 격리된 네트워크 없는 SFU fan-out 검사를 다시 빌드해 1 publisher + 99 listeners, 총 100 participant에서 모두 실제 RTP를 수신했다. 8.458초 구간의 listener 최저 UDP 수신량은 60,213 bytes, Consumer 통계 최저는 113,098 bytes였고, consumer 구성 145.53ms, native worker peak RSS 11.88MiB, Docker 메모리 peak 55.34MiB 및 2-core quota 기준 CPU peak 10.52%를 기록했다([결과](evidence/26-media-fanout-2026-09-27.json)). 이 검사는 PlainTransport fan-out이며 browser ICE/DTLS나 인코딩·디코딩은 검증하지 않는다. 개발 전용 RTC 부하 테스트에서 Phaser 맵 렌더링을 생략하되 앱 WebSocket과 실제 SFU 연결은 유지하도록 바꿨고, 2인 행사 오디오 E2E에서 상대 ICE/DTLS 연결과 inbound RTP 5,619 bytes/107 packets를 확인했다([결과](evidence/26-rtc-capacity-2-ice-dtls-rtp-2026-09-27-headless.json)). 12인 브라우저 검사는 10명 입장 뒤 host free memory 2,042MiB로 2,048MiB 안전 하한에 닿아 종료됐으며 미디어 RTP 통과로 계산하지 않는다([안전 중단](evidence/26-rtc-capacity-12-safe-stop-2026-09-27-headless.json)). 실제 브라우저 12/100명 ICE·DTLS/RTP, 외부 TURN, 장시간 통합 부하는 계속 남아 T26.1은 미완료다.

2026-09-28 TURN relay 재검증: 충돌 없이 실행되도록 전용 미디어 포트를 기존 용량 검사 컨테이너가 사용 중인 44445에서 44446으로 옮겼다. 임시 Coturn·SFU를 새 자격 증명과 함께 별도 Compose 프로젝트로 기동하고 advertised host의 UDP STUN 응답을 확인했다. Chromium 두 참가자를 relay-only로 연결해 양쪽 relay ICE 후보, 마이크·카메라·화면/화면 오디오 RTP, TURN 정지 중 연결 단절과 재개 뒤 ICE/DTLS·미디어 복구를 확인했다(E2E 1/1, 1.6분). 테스트 전용 서비스·네트워크는 종료 후 제거했고 기존 용량 검사 및 로컬 미디어 컨테이너는 유지했다. 이 검사는 같은 호스트의 광고 주소에서 수행했으므로 공용 인터넷·실제 이동통신망, 운영 Coturn 설정, 장시간·다중 참가자 TURN 부하는 확인하지 않아 T26.1/T26.2는 미완료다.
2026-09-28 Coturn REST 인증: TURN 서버의 장기 사용자명·비밀번호를 브라우저에 고정 전달하던 설정을 보완했다. MEDIA_TURN_SHARED_SECRET이 설정되면 SFU capabilities 요청마다 만료 시각과 난수 식별자를 포함한 username, HMAC-SHA1 credential을 만들고 공용 비밀은 응답에 포함하지 않는다. 유효시간은 60초~7일 범위로 설정하며, 미인증 TURN URL·절반만 지정한 정적 자격 증명·정적 값과 공유 비밀의 혼용은 시작 단계에서 거부한다. 기존 정적 ICE 설정은 호환된다. Coturn use-auth-secret relay-only 2인 Chromium E2E에서 실제 ICE/DTLS·마이크/카메라/화면 RTP, TURN 중단 및 복구를 확인했고, 기본 no-TURN 로컬 SFU E2E도 통과했다. Media 단위 검사는 Linux Docker에서 45/45 통과했다. 운영 TURN은 배포하지 않았다.

2026-09-28 화면공유 음량 조절 회귀: 근거리 미디어 Chromium/SFU 흐름에서 화면공유 헤더의 음량 슬라이더를 0%와 100%로 움직였을 때 표시값뿐 아니라 실제 `SCREEN_AUDIO` HTMLAudioElement의 `volume`이 각각 0과 1로 바뀌는지 검사했다. 같은 테스트에서 실제 마이크·카메라·화면/화면 오디오 RTP 전달, 화면공유 창 이동·크기 조절, 카메라 창 이동·크기 조절, 키보드 조작, 거리 이탈 시 수신 회수와 퇴장 정리를 확인했다. 격리 Docker SFU Chromium E2E 1/1 통과, Prettier 통과. 장치는 Playwright 합성 입력이며 실기기는 별도 검수가 필요하다([핵심 커뮤니케이션 증거](evidence/25-core-communication-e2e-2026-09-28.json)).

2026-09-28 100명 오디오 RTP 지속 fan-out: 현재 SFU 소스로 격리 Docker를 빌드하고 송신자 1명에서 수신자 99명에게 Opus RTP를 60초 이상 전달했다. 99/99 Consumer에서 실제 RTP 통계가 증가했고, 각 수신자의 UDP 최소 수신량은 468,899 bytes, Consumer 최소 통계는 882,790 bytes였다. Consumer 구성은 182.66ms였으며 2코어·1GiB·network none 제한에서 컨테이너 CPU peak 17.54%(2코어 quota의 8.77%), 메모리 57.36MiB, native worker CPU 4.69%(한 코어 기준)를 기록했다. [원시 fan-out 결과](evidence/26-media-fanout-2026-09-28-100-60s.json). 이 검사는 합성 단일 Opus 송신을 PlainTransport로 전달하는 격리 SFU 부하로, 브라우저 ICE/DTLS·TURN·카메라 인코딩·디코딩·React UI 100개·여러 동시 발화·실제 네트워크를 포함하지 않아 T26.1은 미완료다.

2026-09-28 100명 제품 미디어 모듈 부하: 용량 시험 전용 loopback SFU 컨테이너의 소스를 현재 workspace와 맞추고 health·소스 해시를 확인했다. 격리 Preview API/World와 현재 `WorldConnection`·`MediaController` 모듈 100개가 참가하고 이동·공간 채팅을 보내는 Chromium 단일 페이지 harness에서 100/100 고유 참가자·권위 이동·채팅 전달, 오디오 송신자 1명→수신자 99명의 ICE/DTLS 연결과 실제 inbound RTP를 확인했다. 수신자는 99/99, 최소 6,268 bytes·104 packets였다. 안전 중단 한도는 여유 메모리 2GiB와 CPU 95% 20회 연속이며 시험 중 최종 여유 메모리는 4,078MiB, 사용량 peak 89.1%, 순간 CPU peak 100%였다. [실행 JSON](evidence/26-rtc-capacity-100-module-harness-2026-09-28.json). 이 경로는 실 HUFS SSO·Redis 좌석 예약·React 화면 100개·여러 동시 송신·카메라/화면 공유·공용망 TURN을 포함하지 않고 CPU peak도 관측돼 운영 2-vCPU 서버의 용량 인증으로 보지 않는다. T26.1은 미완료다.

2026-09-28 일반 근거리 미디어 100명 반복 검증: 행사/발표 모드를 시작하지 않고 격리 Preview API/World와 제품 `WorldConnection`·`MediaController` 100개를 Chromium 단일 페이지에서 두 번 실행했다. 두 시험 모두 100/100 참가자의 일반 공개 공간 정책, 권위 이동·공간 채팅 수신을 확인하고, 한 참가자의 정책 peer 목록과 실제 원격 오디오 트랙 수신자가 일치했다. 일반 근거리 최대 한도인 가까운 12/12명에서 ICE·DTLS가 연결된 inbound RTP를 수신했다. 1차 최소 RTP는 5,814 bytes·120 packets, CPU peak 92.1%, 종료 여유 메모리 6,168MiB였다. 2차 최소 RTP는 6,106 bytes·121 packets, 순간 CPU peak 100%, 종료 여유 메모리 5,989MiB였다. 자동 안전 중단 기준은 여유 2GiB 미만 또는 CPU 95% 이상이 20초 연속이며 두 실행 모두 중단 조건에 도달하지 않았다. [1차 결과](evidence/26-rtc-capacity-100-nearby-module-harness-run1-2026-09-28.json) · [2차 결과](evidence/26-rtc-capacity-100-nearby-module-harness-2026-09-28.json). 단일 mic sender 제품 모듈 검사이며 React 화면 100개, 다중 동시 송신, 카메라·화면 공유 100명 fan-out, 운영 ARM64 서버·공용 TURN은 검증하지 않아 T26.1 용량 완료로 계산하지 않는다.

2026-09-28 일반 근거리 4인 동시 발화 60초 검증: 100명 제품 모듈 harness에서 발표 모드 없이 네 참가자가 동시에 마이크를 송출했다. 100명 입장·이동·공간 채팅과 48개 근거리 송수신 트랙을 확인했고, 13명의 실제 수신자와 각자의 정책상 발화 peer 집합이 정확히 일치했다. 48/48 inbound 오디오 트랙에서 60초 내내 RTP가 증가했으며 트랙별 최소 증가량은 174,097 bytes·3,000 packets였다. 시험 CPU 순간 peak 99.6%, 최종 여유 메모리 5,627MiB였고, 95% 이상 CPU 20초 연속 또는 여유 2GiB 미만의 안전 중단은 없었다. [실행 JSON](evidence/26-rtc-capacity-100-nearby-4-mics-60s-2026-09-28.json). 제품 World/미디어 모듈 100개와 마이크 4명에 대한 지속 미디어 검사다. 이 실행 자체에는 실제 React 화면·카메라와 화면 공유가 포함되지 않았다. React 화면 12개에서 6명 동시 발화와 실제 RTP 수신을 확인한 후속 결과는 아래 별도 기록으로 남긴다. 100개 React 화면, 영상·화면공유의 다중 수신, 실제 ARM64 운영 서버와 공용 TURN 부하는 미검증이어서 T26.1은 완료하지 않는다.

2026-09-28 실제 React 화면 근거리 통화 검증: 전체 웹 화면 12개를 열고 발표 도구 없이 가까운 사람끼리 4명이 마이크를 켰다. 12/12 화면에서 정책상 연결된 상대의 ICE·DTLS와 실제 오디오 RTP를 확인했으며, 60초 지속 구간의 수신자별 최소 증가량은 543,410 bytes·9,133 packets였다. 발표 도구가 숨겨진 상태에서 마이크·카메라·화면 공유와 Enter 근거리 채팅 조작도 노출됨을 검사했다. CPU 순간 peak 100%, 최종 여유 메모리 5,207MiB, 페이지 오류 0건이었다. [실행 결과](evidence/26-rtc-capacity-12-nearby-full-ui-4-mics-60s-2026-09-28.json). 100개 실제 React 화면 검사는 40명 입장 후 CPU 95% 이상이 20초 연속되어 자동 안전 중단됐다(peak 100%, 당시 가용 메모리 2,830MiB). [안전 중단 결과](evidence/26-rtc-capacity-100-nearby-full-ui-safe-stop-2026-09-28.json). 두 결과 모두 실제 운영 서버 용량을 입증하지 않아 T26.1은 미완료다.

2026-09-28 일반 근거리 12명·6명 동시 발화 Chromium/SFU E2E: 12개 React 화면에서 12개 고유 참가자, 마이크 producer 6개, 참가자별 예상 수신 stream 수(발화자 6명은 각 5개, 나머지 참가자는 6개)와 12/12 실제 inbound RTP(각 5,000 bytes 초과)를 검증했다. 이 통화 검사에서는 테스트 전용 설정으로 Phaser 지도 렌더링만 생략하고 앱·World 연결 및 실 SFU를 사용했다. 첫 실행은 지도를 12개 화면에서 함께 렌더링하면서 월드 연결이 끊겨 실패했고, 렌더링과 RTC 부하를 분리한 재실행은 E2E 1/1이 39초에 통과했다. [검증 요약](evidence/26-rtc-capacity-12-nearby-6-mics-2026-09-28.json). 별도의 실제 SFU 2인 E2E에서는 마이크·카메라·화면·화면 오디오 source 수신과 inbound 오디오/비디오 RTP, 화면 오디오 0–100% 조절, 화면·카메라 창 이동/크기 조절, 거리 이탈 후 consumer/RTP 회수를 확인했다(1/1, 56.7초). [검증 요약](evidence/26-rtc-capacity-2-nearby-camera-screen-2026-09-28.json). 100개 React 화면, 6명 동시 영상 공유, 공용망 TURN과 운영 ARM64 부하는 남아 T26.1은 미완료다.


2026-09-28 일반 근거리 12인 동시 발화 60초 검증: RTC 용량 실행기의 `-Speakers` 허용 범위를 제품 근거리 peer 상한과 같은 12로 넓혔다. 격리 loopback SFU 및 제품 `WorldConnection`·`MediaController` 100개에서 100/100 참가·고유 ID·권위 이동·공간 채팅 수신, 12개 마이크 송신자와 144개 inbound 오디오 RTP stream을 확인했다. 13명의 수신자에서 ICE·DTLS 연결이 유지됐고 144/144 트랙 모두 60초 동안 RTP가 계속 증가해 트랙별 최소 174,781 bytes·3,000 packets가 추가됐다. CPU peak 97.2%·평균 55.3%, 최소 가용 메모리 7,439MiB·최종 7,518MiB였고 안전 중단은 없었다. [실행 증거](evidence/26-rtc-capacity-100-nearby-12-mics-60s-2026-09-28.json). React 화면 100개, 영상·화면공유 다중 송신, 공용 TURN·운영 ARM64 부하는 포함하지 않아 T26.1은 계속 미완료다.


2026-09-28 일반 근거리 12인 동시 발화 5분 지속 검사: 이전 60초 검사와 같은 100명 제품 RTC 모듈 구성을 300초 유지했다. 100/100 참가·이동·공간 채팅, 12개 마이크 송신자, 실제 수신자 14명, 예상된 144/144 inbound RTP 트랙에서 ICE·DTLS와 RTP 증가가 지속됐다. 트랙별 최소 증가량 884,037 bytes·15,003 packets, CPU peak 84.3%·평균 52.5%, 최소 여유 메모리 7,278MiB·종료 7,484MiB를 기록했고 안전 중단은 없었다([실행 결과](evidence/26-rtc-capacity-100-nearby-12-mics-300s-2026-09-28.json)). 재현 명령은 `./scripts/rtc-capacity-e2e.ps1 -Clients 100 -Speakers 12 -RtpHoldSeconds 300 -ModuleHarness -SkipBuild`다. 이 검사는 제품 모듈·loopback SFU이며 실제 100 React 화면, video/screen fan-out, 공용 TURN과 운영 ARM64 2-vCPU 부하는 포함하지 않는다.

2026-09-28 일반 근거리 12개 React 화면·6개 동시 카메라 송출: 지도 렌더링을 생략한 Chromium 테스트에서 12명의 고유 참가자와 실제 SFU를 연결했다. 카메라 6개 송출의 66개 예상 Consumer가 참가자별 5개 또는 6개로 모두 준비되고, 12개 화면 전부에서 inbound video RTP와 디코딩 프레임을 확인했다. 66개 원격 카메라 타일이 모두 UI에 표시됐고 페이지 오류는 없었다. 발표 모드는 비활성화되고 발표 도구 UI가 숨겨진 상태에서 검사했다. E2E 1/1을 두 차례 실행했다([검증 요약](evidence/26-rtc-capacity-12-nearby-6-cameras-2026-09-28.json)). 합성 카메라·Preview 로그인·로컬 SFU를 사용했으며 100개 실제 화면, 공용망 TURN과 운영 ARM64 부하는 포함하지 않는다. 따라서 T26.1은 미완료다.

2026-09-28 일반 근거리 12개 React 화면 화면공유: 한 참가자가 합성 화면 영상과 공유 오디오를 송출하고 나머지 11명이 두 미디어를 수신하는지 Chromium·실 SFU로 검사했다. 11명 모두 video RTP 5,000 bytes 초과와 audio RTP 1,000 bytes 초과를 받았고 화면 영상의 디코딩·표시와 화면 오디오 요소를 확인했다. 총 22개 수신 Consumer는 화면 공유 종료 시 모두 정리됐다. 이벤트/발표 모드는 비활성화 상태였다. E2E 1/1을 두 차례 통과했다([검증 요약](evidence/26-rtc-capacity-12-nearby-screen-share-2026-09-28.json)). 합성 화면·Preview 로그인·로컬 SFU 검사이며 공용망 TURN, 실제 데스크톱 캡처, 100개 React 화면과 운영 ARM64 부하는 포함하지 않아 T26.1은 미완료다.

2026-09-29 핵심 근거리 미디어 회귀: 발표 도구를 기본 숨김으로 둔 상태에서 Chromium·로컬 SFU E2E 4/4를 재검증했다. 모바일·데스크톱 참가자 간 마이크/카메라 RTP, 화면 영상·오디오 송출 제한의 동시 회수, 회의실 경계 밖 수신 회수와 자동 재공유 금지, 카메라가 보이는 화면 공유 창 배치를 확인했다([실행 결과](evidence/25-core-media-regression-2026-09-29.json)). 합성 브라우저 장치 검사여서 실기기 권한, 공용 TURN, 운영망 용량은 검증하지 않았다.

2026-09-28 월드 위치 갱신 최적화: 위치 snapshot은 바뀌어도 미디어 정책 참조·연결 상태·참가자 ID가 그대로면 MediaController의 SFU consumer 재검사와 remote UI 갱신을 건너뛴다. 정책 객체가 새로 오거나 연결 상태·자기 ID가 바뀌면 기존 처리를 수행한다. Vitest 회귀 1/1, 타입 검사 및 포맷 검사가 통과했다. 발표 도구 기본 숨김·마이크/카메라/화면공유·Enter 근거리 채팅 E2E도 1/1 통과했다. 이어 수행한 로컬 미디어 E2E 재검사는 Preview 연결의 과속 거부 화면과 미디어 미준비로 실패해 이 변경의 통합 통과로 계산하지 않는다. 이전에 두 차례 통과한 카메라·화면공유 검증 결과와 이 재검사는 별도 기록이며, 상세는 [스냅샷 재검사](evidence/26-media-policy-snapshot-2026-09-28.json)를 참조한다.

2026-09-29 Coturn 릴레이 복구 E2E: `scripts/turn-e2e.ps1`가 무작위 임시 자격증명으로 격리 Docker Coturn·Media를 띄우고 Chromium 두 참가자의 마이크·카메라·화면·화면 오디오 RTP를 확인했다. 두 브라우저 모두 relay 후보를 선택했고 TURN 컨테이너를 중단했을 때 ICE 단절, 재개 뒤 ICE 재연결·통화 `ready` 복구 및 relay 재선택을 통과했다. 거리 이탈 수신 회수와 퇴장 후 자원 정리도 같은 E2E에서 통과했다(1/1, 1.3분). 전용 Compose 컨테이너와 네트워크가 제거됐고 기존 앱·DB·미디어 컨테이너는 계속 healthy 상태였다. Docker 이미지 안에서 네트워크를 끄고 미디어 단위 테스트 전체를 실행해 46/46 통과했다([검증 증거](evidence/05-turn-relay-recovery-2026-09-29.json)). 이는 사설 로컬 경로 시험이며 운영 Oracle 공인 IP, 방화벽, 공용 인터넷·휴대전화 경로는 검증하지 않아 T26.1/T26.2는 미완료다. Windows의 `pnpm test` 실행기는 네이티브 `mediasoup` install build script를 승인하지 않아 중단됐지만, Docker 빌드와 격리 미디어 전체 단위·브라우저 E2E는 통과했다.

2026-09-29 presentation/event tools default reset: Moved the opt-in preference to v7 and clear stored v1-v6 values on upgrade, so a previously saved opt-in no longer turns on supplemental presentation tools automatically. The event roster Chromium suite passed 2/2: default and upgraded sessions hide the tools while nearby chat, microphone, camera, and screen sharing remain available; a deliberate Settings opt-in still enables event management and participant controls. Focused preference Vitest passed 2/2, TypeScript and Prettier passed. Event-media-specific E2E was skipped because the local SFU media profile was not active. [Evidence](evidence/25-event-tools-default-off-2026-09-29.json). No production deployment was performed.

2026-09-29 프리뷰 녹화 메타데이터 호환: 비로그인 프리뷰가 `preview` 공간 ID와 합성 사용자 ID를 보내 SFU의 UUID 메타데이터 검사에서 동의 완료 뒤 녹화 시작이 거절되는 문제를 확인했다. 프리뷰 요청에만 목적별·입력별 결정적 UUID를 만들고, 운영/로그인 식별자와 이미 유효한 UUID는 변경하지 않는다. 월드 전체 단위·통합 검사 64/64(1 skip), World JAR 빌드, 로컬 실 SFU Chromium 미디어 E2E 15/15가 통과했다. 동의가 모두 모인 뒤 마이크 RTP 녹화 WebM이 생성되고 ffprobe 재생 가능성·소스·RTP 패킷을 확인했다([증거](evidence/26-recording-preview-ids-2026-09-29.json)). 운영 SSO 계정과 실제 휴대전화/공용 TURN은 별도 검증이 남는다.
