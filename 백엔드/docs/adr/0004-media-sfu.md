# ADR 0004 — Spring 통화 정책과 mediasoup SFU

상태: 후보 B mediasoup/coturn 로컬 경로 채택. 3인 구역 경계, 실제 TURN RTP, TURN 중단 뒤 ICE 복구를 로컬 Docker에서 검증했다. 운영 배포·공용 외부망·실기기 검증은 남아 있다. ADR 0001의 “미디어 미구현” 설명을 이 범위에서 대체한다.

Spring API·월드, MariaDB·Redis를 유지한다. RTP 중계만 Node 24.14.1의 mediasoup 3.27.1 전용 앱으로 분리하고, 브라우저는 mediasoup-client 3.23.2를 사용한다. 의존성은 lockfile에 고정한다.

핵심 요구는 위치를 판정하는 서버가 각 수신자의 Consumer 생성을 소유하고, PRIVATE/SILENT 경계에서 기존 Consumer를 닫는 것이다. mediasoup의 서버 Consumer와 paused 생성 → 브라우저 준비 → resume 절차를 이 요구에 맞춰 사용한다. [공식 시그널링 문서](https://mediasoup.org/documentation/v3/communication-between-client-and-server/), [공식 API](https://mediasoup.org/documentation/v3/mediasoup/api/).

후보 A LiveKit 비교 실험을 `scripts/livekit-spike.ps1`로 별도 실행했다. LiveKit Server 1.13.7과 브라우저 SDK 2.22.3에서 가상 장치를 쓴 세 Chromium 참가자의 마이크·카메라와 화면 영상·화면 오디오 송수신, 오디오 수신 바이트와 영상 디코딩 프레임, 마이크만 허용한 토큰의 카메라 송출 거부가 통과했다. 이 검사는 서버 권한 token의 source 제한을 확인했으며, 운영 SSO와 실기기를 쓰지 않았다.

후보 A 실험에서 확인하지 않은 항목은 외부 TURN·모바일망·100명 부하와 근거리 정책 변화에 맞춘 참가자별 구독 허용/회수 fan-out이다. LiveKit에는 서버 Room Service의 구독 변경 API가 있지만, 이 제품의 매 tick 정책·즉시 회수·수신 상한과 결합한 지속적인 쌍별 제어 및 부하는 아직 검증하지 않았다. 따라서 SFU 교체 근거로 삼지 않는다. 이미 검증한 mediasoup 경로는 서버가 Consumer를 직접 소유하고 정책 변경 때 닫는 방식이라 현재 요구와 맞아 후보 B를 유지한다. [LiveKit 토큰 권한](https://docs.livekit.io/frontends/reference/tokens-grants/), [서버 구독 제어](https://docs.livekit.io/reference/other/roomservice-api/), [LiveKit 구독 문서](https://docs.livekit.io/transport/media/subscribe/).

## 제어 경로

1. 기존 인증된 월드 WebSocket에 `mediaState`, `mediaRequest`, `mediaReply`를 추가한다. 입장 자격은 기존 일회성 티켓·세션 검사를 따른다.
2. Spring의 월드 actor가 위치·map revision·구역·media epoch로 대상 쌍을 계산한다. HTTP I/O는 별도 제한된 executor에서 수행한다.
3. Node 제어 경로는 로컬 loopback과 서버 전용 Bearer token으로 제한한다. 브라우저에 제어 token을 전달하지 않는다. 사용자 식별자·epoch는 Spring이 결정한다.
4. Node가 정책을 적용한 결과를 브라우저에 보낸다. 브라우저가 원하는 상대를 추가해도 Node의 현재 정책과 상호 허용 목록을 통과해야 Consumer가 만들어진다.
5. Consumer는 일단 paused 상태로 만들고, 비동기 생성 뒤와 resume 전후에 정책을 재검사한다. 상태가 바뀌면 서버에서 닫는다.

## 현재 정책

- 통화 domain: `space / published map revision / common 또는 private:zone 또는 silent:zone`.
- 공용 공간은 쌍별 5타일 이내 200ms 유지 시 연결하고, 기존 연결은 7타일까지 유지한다. A-B, B-C가 A-C 허용으로 확장되지 않는다.
- 같은 PRIVATE 구역에서는 거리에 관계없이 후보가 된다. SILENT는 모든 송출을 막는다. 쌍별 관계는 최대 12명이며 유지 중인 관계와 거리 순으로 선택한다.
- 수신 상한: 마이크 12, 카메라 8, 공유 화면 1, 공유 오디오 1. 공유 오디오는 선택된 공유 화면의 소유자와 반드시 일치한다.
- 공간/맵/독립 구역 이동은 media epoch를 올리고 위치 변경을 잠시 보류한다. 이전 미디어 회수 ACK 또는 기존 lease 만료 대기 후 새 위치/맵을 적용한다.
- 화면 공유는 구역·연결 변경 시 종료하고 자동 재공유하지 않는다. 마이크·카메라는 이전에 사용자가 켰다면 PRIVATE 이동 후 재연결한다. SILENT 진입은 캡처 장치도 종료한다.
- 정책 frame은 절대 시각으로 최대 1.5초 유효하고 Node는 100ms마다 만료 자원을 닫는다. 회수 ACK가 없을 때 월드는 2.2초 동안 이동을 보류한다. 현재 동작은 동일 호스트의 시계가 맞는 로컬 Docker 환경을 전제로 한다.

## 한계와 후속 작업

- `MEDIA_ICE_SERVERS_JSON`으로 STUN/TURN 정보를 capabilities에 전달하고, relay-only Chromium에서 실제 Coturn RTP와 짧은 TURN 중단·재개 뒤 ICE 복구를 검증했다. 공용 인터넷에서 들어오는 실제 TURN 주소·방화벽·모바일망 경로는 운영 배포 전에 검증해야 한다. 현재 기본 compose의 SFU UDP/TCP 44444 포트는 localhost에만 바인딩한다.
- 분산 배포 전 시간 동기화/시계 편차, 장시간 네트워크 단절, worker 재시작·재연결 부하를 검증하고 lease 설계를 확장한다.
- 100명 정책 입력에 대한 계산 검사는 처리하지만 100명 실제 통화 부하를 검증한 것은 아니다. worker 분할·다중 노드 ownership·대시보드가 남아 있다.
- 개인 차단/관리자 음소거를 위한 정책 필드는 있지만 사용자 설정·관리 API와 연결하지 않았다. 행사/무대·발언권·잠금/노크·회의실 별도 정원은 후속 태스크다.
- E2EE는 구현하지 않았다. WebRTC 전송 암호화와 종단간 암호화를 동일하게 설명하지 않는다.
