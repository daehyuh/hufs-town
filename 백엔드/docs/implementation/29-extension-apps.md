# 공간 확장 앱

공간 OWNER/ADMIN은 공간 목록의 확장 앱 버튼에서 외부 웹 앱을 등록하고 권한을 검토한 뒤 켤 수 있다. 멤버에게는 켜진 앱만 보이며, 공간에 입장한 멤버만 권한이 허용된 앱의 공간 정보를 요청할 수 있다. 앱은 공간당 최대 8개다.

등록 주소는 사용자 정보, 쿼리 문자열, fragment가 없는 HTTPS URL이어야 한다. `localhost`, `.local` 주소와 IP 리터럴은 거부한다. 앱 코드는 서버에서 내려받거나 서버에서 실행하지 않는다. 관리자가 앱 배포자를 검토하고 등록해야 한다.

## 권한과 데이터 경계

현재 허용 권한은 `SPACE_SUMMARY_READ` 하나다. 공간 이름·설명·공개 범위·정원·템플릿 ID만 반환한다. 계정·멤버 명단·초대·이메일 도메인·세션·미디어 자격 증명은 반환하지 않는다. 앱 등록은 꺼진 상태로 시작하고, 관리자가 요청 권한을 승인한 다음 별도로 켜야 한다. 권한을 변경하거나 회수하면 앱이 자동으로 꺼진다.

컨텍스트 요청은 `GET /api/v1/spaces/{spaceId}/extensions/{extensionId}/context`를 사용한다. 이 요청은 매번 로그인 계정의 현재 공간 멤버십, 공간 접근 차단, 앱의 활성 상태를 다시 확인한다. 계정당 앱·공간별 서버 요청은 분당 60회로 제한한다. 비활성화하면 이후 요청은 거부된다. 앱이 이미 받은 데이터를 브라우저 메모리에서 회수할 수는 없으므로, 민감 데이터는 권한 응답에 넣지 않는다.

## 샌드박스 브리지

호스트는 `sandbox="allow-scripts"`와 `referrerpolicy="no-referrer"`가 적용된 iframe에서만 앱을 연다. `allow-same-origin`, 카메라·마이크 권한, 팝업, 폼 제출, 다운로드, 상위 페이지 이동은 허용하지 않는다. 로그인 쿠키·CSRF 토큰·앱별 bearer 토큰을 iframe에 전달하지 않는다.

iframe은 로드 후 호스트로부터 아래 초기화 메시지를 받는다. opaque sandbox origin을 대상으로 하므로 호스트에서 iframe으로 보내는 `postMessage`의 target origin은 `*`지만, 각 실행마다 생성된 nonce와 특정 iframe의 `contentWindow`로 메시지를 묶는다.

```json
{
  "channel": "HUFS_TOWN_EXTENSION",
  "version": 1,
  "type": "INITIALIZE",
  "nonce": "per-frame-random-value",
  "extensionId": "registered-app-id",
  "permissions": ["SPACE_SUMMARY_READ"]
}
```

공간 요약이 필요할 때 앱은 같은 채널·버전·nonce와 `requestId`(1~64자의 영숫자, 밑줄 또는 하이픈)를 담아 호스트에 `CONTEXT_REQUEST`를 보낸다. 호스트는 발신자가 현재 iframe인지, `event.origin`이 opaque sandbox의 `null`인지, nonce·형식·크기가 맞는지 확인한다. 허용된 요청에만 인증된 same-origin API를 대신 호출하고 `CONTEXT_RESPONSE`로 결과를 전달한다. 프레임당 분당 30회, 메시지당 UTF-8 4 KiB로 제한한다. 이 브리지에는 임의 URL fetch, 채팅 쓰기, 공간 변경, 마이크·카메라·화면 공유 기능이 없다.

```js
window.addEventListener("message", (event) => {
  const message = event.data;
  if (event.source !== window.parent || message?.channel !== "HUFS_TOWN_EXTENSION") return;

  if (message.type === "INITIALIZE") {
    window.parent.postMessage({
      channel: message.channel,
      version: 1,
      type: "CONTEXT_REQUEST",
      nonce: message.nonce,
      requestId: "space-summary-1",
    }, "*");
  } else if (message.type === "CONTEXT_RESPONSE") {
    renderSpaceSummary(message.context?.space);
  }
});
```

앱 제공자는 자신의 페이지에서 상위 사이트가 앱을 프레임할 수 있도록 `X-Frame-Options`와 CSP `frame-ancestors` 정책을 설정해야 한다. 현재 권한 범위가 하나뿐인 것은 의도된 초기 경계다. 새 데이터를 공개하거나 쓰기 기능을 추가하려면 별도의 좁은 권한, API별 서버 검사, 크기·빈도 제한 및 회귀 검사를 먼저 추가한다.

## 검증

`SpaceExtensionsIntegrationTest`는 Testcontainers MariaDB/Redis에서 V57 마이그레이션, 비 HTTPS 주소와 미지원 권한 거부, 등록 직후 비활성 상태, OWNER 승인/활성화, 멤버의 허용된 공간 요약 조회, 비멤버 차단, 분당 서버 한도, 비활성화 후 API 차단을 검증한다. `spaces.spec.ts`의 Chromium 검사는 등록→권한 승인→실행 흐름에서 iframe sandbox/referrer 정책과 nonce 기반 요약 정보 브리지를 확인한다.

현재 비활성화는 이후 컨텍스트 요청과 새 앱 실행을 막는다. 이미 실행된 다른 브라우저 탭의 프레임은 자동으로 닫히지 않으므로, 관리자가 권한을 끄거나 회수한 뒤 기존 탭에 있던 정보까지 소급 삭제할 수는 없다.
