# GDG HUFS SSO API 연동 가이드

다른 서비스에서 한국외국어대학교 Google 계정으로 로그인하고 사용자 정보를 확인하기 위한 문서입니다.

## 1. 기본 정보

| 항목 | 값 |
| --- | --- |
| 운영 API 기준 주소 | `https://api.gdghufs.com` |
| 공통 경로 | `/v1/sso` |
| POST 요청 형식 | `Content-Type: application/json` |
| 성공 응답 | `{"data": ...}` |
| 오류 응답 | `{"error_code": "...", "message": "..."}`와 해당 HTTP 상태 |
| 일회용 코드 유효기간 | 발급 시점부터 60초 |
| One Tap nonce 유효기간 | 발급 시점부터 600초 |

이 API는 자체 SSO 프로토콜입니다. 표준 OAuth 2.0 또는 OpenID Connect 제공자와 동일한 인터페이스가 아니므로 일반 OIDC 라이브러리에 주소만 지정해서 연결할 수 없습니다.

- Google 로그인 결과를 일회용 SSO 코드로 전달하고, 연동 서비스 백엔드가 코드를 사용자 정보로 교환합니다.
- 연동 서비스용 access token, refresh token, ID token은 발급하지 않습니다.
- `/userinfo`는 Bearer 토큰 조회 API가 아니라 클라이언트 시크릿을 사용하는 코드 교환 API입니다.
- 연동 서비스의 로그인 세션 생성, 만료, 로그아웃, 서비스별 접근 권한은 연동 서비스가 관리합니다.
- 학교 계정 로그인 성공과 재학생 전용 서비스 이용 자격은 별개입니다. 재학생 여부는 `status`로 판단합니다.


## 2. 연동 전 등록

API 운영자에게 아래 정보를 전달하고 운영자가 발급하는 `client_id`와 `client_secret`을 사용합니다.

| 항목 | 설명 |
| --- | --- |
| 서비스 이름 | 연동 서비스를 구분할 이름 |
| 콜백 URI | 예: `https://service.example.com/auth/callback` |
| One Tap 사용 여부 | 일반 로그인만 사용하면 필요 없음 |
| 개발용 콜백 URI | 필요하면 운영 주소와 별도로 등록 |

`client_secret`은 연동 서비스 백엔드의 환경변수나 비밀 관리 저장소에만 보관합니다. 프론트엔드 코드, 공개 저장소, URL, 브라우저 저장소에 넣지 않습니다. 프론트엔드만 있는 서비스는 코드 교환을 담당할 백엔드 또는 서버리스 함수가 필요합니다.

`redirect_uri`는 등록된 문자열과 정확히 일치해야 합니다. 프로토콜, 포트, 경로, 마지막 `/`, 쿼리 문자열이 다르면 거절됩니다. 와일드카드 등록은 지원하지 않습니다. 운영용 콜백은 HTTPS를 사용하고, `code`나 `state`가 미리 포함된 주소 및 fragment 기반 콜백은 사용하지 않습니다.


## 3. 엔드포인트 요약

| 메서드 | 경로 | 호출 주체 | 역할 |
| --- | --- | --- | --- |
| GET | `/v1/sso/authorize` | 브라우저 페이지 이동 | 일반 Google 로그인 시작 |
| POST | `/v1/sso/userinfo` | 연동 서비스 백엔드 | 일회용 코드 교환 |
| POST | `/v1/sso/onetap/nonce` | 연동 서비스 브라우저 | One Tap nonce 발급 |
| POST | `/v1/sso/onetap` | 연동 서비스 브라우저 | Google ID 토큰 검증 및 SSO 코드 발급 |

One Tap은 같은 콜백과 코드 교환 과정을 재사용하는 선택 기능입니다. (구현 필수가 아님)


## 4. 일반 로그인

### 4.1. 전체 흐름

1. 연동 서비스 백엔드가 암호학적으로 안전한 임의의 `state`를 생성하고 현재 브라우저 세션에 연결해 저장합니다.
2. 브라우저를 `/v1/sso/authorize`로 이동시킵니다.
3. API가 클라이언트와 콜백을 확인한 뒤 Google 로그인으로 보냅니다.
4. Google 로그인 성공 후 API가 학교 계정과 사용자 정보를 확인하고 회원을 생성하거나 갱신합니다.
5. 등록된 콜백 URI에 `code`와 원래 `state`를 붙여 브라우저를 보냅니다.
6. 연동 서비스 백엔드가 `state`를 검증하고, `/v1/sso/userinfo`로 코드를 교환합니다.
7. 반환된 `uuid`와 `status`를 기준으로 회원 연결과 이용 자격을 확인하고 자체 로그인 세션을 만듭니다.

`/authorize`는 `fetch`로 호출하는 JSON 로그인 API가 아닙니다. 브라우저 페이지 이동으로 시작해야 API의 OAuth 세션 쿠키가 로그인 왕복 과정에서 유지됩니다.

### 4.2. GET /v1/sso/authorize

| 쿼리 매개변수 | 필수 | 설명 |
| --- | --- | --- |
| `client_id` | 예 | 운영자가 발급한 SSO 클라이언트 ID |
| `redirect_uri` | 예 | 사전 등록된 콜백 URI |
| `state` | 예 | 공백이 아닌 최대 512자 문자열 |
| `select_account` | 아니오 | `true`가 기본값. Google 계정 선택 화면을 요청 |

로그인 시작 URL 예시입니다. `state`는 매 요청마다 새로 생성해야 하며 아래 값을 실제 로그인에 재사용하지 않습니다.

```text
https://api.gdghufs.com/v1/sso/authorize?client_id=sample-service&redirect_uri=https%3A%2F%2Fservice.example.com%2Fauth%2Fcallback&state=RANDOM_STATE_FOR_THIS_LOGIN&select_account=true
```

URL은 문자열을 직접 이어 붙이기보다 `URL`과 `URLSearchParams` 등으로 생성합니다.

`select_account=false`는 계정 선택 강제를 생략한다는 뜻입니다. 무조건 무화면 로그인되거나 재인증을 건너뛴다는 보장은 아닙니다.

성공 시 우선 HTTP 302로 `/oauth2/authorization/google`에 이동하며, 최종 성공 콜백은 아래 형태입니다.

```text
https://service.example.com/auth/callback?code=ONE_TIME_SSO_CODE&state=RANDOM_STATE_FOR_THIS_LOGIN
```

### 4.3. 콜백 처리

- 로그인 시작 시 저장한 `state`와 콜백의 `state`가 일치하고 만료되지 않았는지 백엔드에서 확인합니다.
- `state`에는 최소 128비트의 무작위 값을 URL-safe 형식으로 인코딩해 사용합니다. 예측 가능한 회원 ID나 고정 문자열을 사용하지 않습니다.
- `state`가 없거나 다르면 코드를 교환하거나 로그인 세션을 만들지 않습니다.
- `state`는 검증 후 한 번만 사용할 수 있도록 소비합니다. 단순히 요청에 `state`가 존재하는지만 확인하면 안 됩니다.
- SSO API는 `state`를 전달하지만, 연동 서비스의 브라우저 세션과 연결해 검증하는 책임은 연동 서비스에 있습니다.
- 콜백은 코드를 즉시 교환하고 깨끗한 서비스 URL로 이동시킵니다. 코드가 포함된 URL을 분석 도구, 외부 리소스, 로그에 전달하지 않습니다.
- 콜백 페이지와 응답에는 캐시 방지 및 `Referrer-Policy: no-referrer` 적용을 권장합니다.
- 일반 로그인 후처리 정보는 API 세션당 하나입니다. 같은 브라우저에서 여러 로그인 흐름을 동시에 시작하지 않도록 합니다.

인증 코드와 `state`에는 사용자 정보나 연동 서비스의 로그인 세션을 직접 담지 않습니다.


## 5. 사용자 정보 교환

### 5.1. POST /v1/sso/userinfo

반드시 연동 서비스 백엔드에서 호출합니다. API 로그인 쿠키나 Authorization 헤더 대신 JSON 본문의 클라이언트 자격 증명을 사용합니다.

```json
{
  "client_id": "sample-service",
  "client_secret": "SERVER_SIDE_CLIENT_SECRET",
  "code": "ONE_TIME_SSO_CODE"
}
```

세 필드는 모두 필수이며 빈 문자열이나 공백만 전달할 수 없습니다. 이 엔드포인트에 `redirect_uri`, `state`, `grant_type`, PKCE 매개변수를 전달할 필요는 없습니다. `state`는 호출 전에 연동 서비스에서 검증합니다.

HTTP 200 응답 예시입니다. 사용자 정보는 설명용 가상 값입니다.

```json
{
  "data": {
    "id": 123,
    "uuid": "9d3d2c3a-825f-4f1b-842c-28e972ef7429",
    "email": "kimhufs@hufs.ac.kr",
    "name": "김훕스",
    "department": "컴퓨터공학전공",
    "status": "ATTENDING",
    "institutional_id": "202400001"
  }
}
```

| 필드 | 형식 | 설명 |
| --- | --- | --- |
| `id` | 정수 | API 내부 회원 일련번호 |
| `uuid` | UUID 문자열 | 외부 서비스에서 회원 연결에 사용할 식별자 |
| `email` | 문자열 | 학교 계정 이메일 |
| `name` | 문자열 | 회원 이름 |
| `department` | 문자열 | 소속 |
| `status` | 문자열 | `MemberStatus`의 enum 이름 |
| `institutional_id` | 문자열 또는 null | 학번 또는 사번. 정보가 없을 수 있으므로 필수값으로 취급하지 않음 |

사용자 정보는 코드 발급 시점의 값입니다. `id` 및 `uuid`를 제외한 모든 정보는 변경될 수 있으므로 장기간 저장하지 마십시오.

### 5.2. 코드 수명과 재시도

- 코드는 발급 후 60초 안에 교환해야 합니다.
- 코드는 발급된 `client_id`에 연결되며 한 번만 사용할 수 있습니다.
- 응답을 받지 못했더라도 서버에서는 이미 소비했을 수 있습니다. 교환 실패를 반복 재시도하는 대신 필요하면 로그인을 새로 시작합니다.
- HTTP 400의 `Invalid or expired code`는 잘못된 코드, 만료, 이미 사용된 코드 등을 나타냅니다.
- 잘못된 클라이언트 자격 증명은 HTTP 401의 `Invalid client credentials`로 구분합니다.

### 5.3. 재학생 판정

현재 `MemberStatus` 값은 다음과 같습니다.

| 값 | 의미 |
| --- | --- |
| `ATTENDING` | 재학 |
| `GRADUATED` | 졸업생 |
| `LECTURER` | 강사 |
| `PROFESSOR` | 교수 |
| `RESEARCHER` | 연구원 |
| `RETIRED` | 퇴직 |
| `COMMON_ID` | 공용 계정 |
| `STAFF` | 직원 |

재학생만 허용하는 서비스는 백엔드에서 `data.status === "ATTENDING"`인 경우에만 이용 자격을 부여합니다.

이름, 소속 문자열로 재학 상태를 추측하지 마십시오.
알 수 없는 상태가 오면 임의로 허용하지 마십시오.

이 응답에는 GDG 멤버 여부, 관리자 권한, 프로필 번호가 포함되지 않습니다. 해당 자격은 학교 계정 또는 재학생 여부와 별개입니다.


## 6. Google One Tap

### 6.1. 사용 조건

- 등록된 SSO 클라이언트의 `one-tap-enabled`가 `true`여야 합니다. (SSO 운영자가 설정해야 함)
- API에 이미 가입한 학교 계정만 사용할 수 있습니다. 미가입자는 일반 `/authorize` 로그인 흐름을 먼저 완료해야 합니다.
- One Tap에 지정하는 Google OAuth 클라이언트 ID는 API의 `GOOGLE_CLIENT_ID`와 같아야 합니다. SSO `client_id`와는 다른 값입니다.
- Google OAuth 웹 클라이언트의 Authorized JavaScript origins에 연동 서비스 origin을 등록합니다.
- 브라우저의 origin과 `redirect_uri`의 origin이 같아야 합니다. 여기서 origin은 프로토콜, 호스트, 포트로 구성됩니다.

예를 들어 `https://service.example.com`에서 호출하려면 콜백도 같은 origin의 `https://service.example.com/auth/callback`이어야 합니다. 콜백을 다른 백엔드 서브도메인에 두면 이 조건을 만족하지 않습니다.

### 6.2. POST /v1/sso/onetap/nonce

브라우저에서 호출합니다. `Origin` 헤더는 브라우저가 자동으로 보내므로 JavaScript에서 임의로 설정하지 않습니다.

```http
POST /v1/sso/onetap/nonce HTTP/1.1
Host: api.gdghufs.com
Origin: https://service.example.com
Content-Type: application/json

{
  "client_id": "sample-service",
  "redirect_uri": "https://service.example.com/auth/callback",
  "state": "RANDOM_STATE_FOR_THIS_LOGIN"
}
```

각 필드는 필수이며, `state`는 일반 로그인과 마찬가지로 공백이 아닌 최대 512자입니다.

HTTP 200 응답:

```json
{
  "data": {
    "nonce": "SERVER_ISSUED_NONCE",
    "expires_in": 600
  }
}
```

현재 nonce 발급 제한은 클라이언트별 1분에 300회, 같은 클라이언트와 요청 IP 조합별 1분에 60회입니다. 초과하면 HTTP 429와 `COMMON_005`를 반환합니다. 요청할 때마다 nonce를 발급하는 반복 루프를 만들지 않습니다.

### 6.3. Google credential 받기

Google Identity Services JavaScript 라이브러리를 로드한 뒤 `google.accounts.id.initialize`에 아래 값을 전달합니다.

| Google 설정 필드 | 값 |
| --- | --- |
| `client_id` | API 운영자가 안내한 Google OAuth 클라이언트 ID |
| `nonce` | 바로 앞 단계의 `data.nonce` |
| `callback` | Google이 전달한 `credential`을 아래 `/onetap`으로 보내는 함수 |

nonce를 자체 생성하거나 생략하지 않습니다. Google에서 받은 ID 토큰의 `nonce`를 API에서 검증합니다. Google 라이브러리의 초기화 및 callback 형식은 [공식 JavaScript API 문서](https://developers.google.com/identity/gsi/web/reference/js-reference)를 참고합니다.

### 6.4. POST /v1/sso/onetap

```http
POST /v1/sso/onetap HTTP/1.1
Host: api.gdghufs.com
Origin: https://service.example.com
Content-Type: application/json

{
  "client_id": "sample-service",
  "redirect_uri": "https://service.example.com/auth/callback",
  "state": "RANDOM_STATE_FOR_THIS_LOGIN",
  "credential": "GOOGLE_ID_TOKEN_FROM_CALLBACK"
}
```

모든 필드가 필수입니다. `client_id`, `redirect_uri`, `state`, `Origin`은 nonce 발급 단계와 동일하게 유지합니다. nonce는 요청 본문 필드가 아니라 Google ID 토큰에 포함되어야 합니다.

API는 Google 서명, 발급자, audience, 시간 유효성, 이메일 검증 여부, 학교 도메인, 필수 사용자 정보 및 일회용 nonce를 확인합니다. 클라이언트가 토큰을 디코딩해서 얻은 사용자 정보를 자체적으로 인증 결과로 사용하면 안 됩니다.

HTTP 200 응답:

```json
{
  "data": {
    "redirect_uri": "https://service.example.com/auth/callback?code=ONE_TIME_SSO_CODE&state=RANDOM_STATE_FOR_THIS_LOGIN"
  }
}
```

이 응답은 HTTP 302가 아닙니다. 프론트엔드가 `data.redirect_uri`로 페이지를 이동시켜야 합니다. 이후 콜백의 `state` 검증과 백엔드 `/userinfo` 교환은 일반 로그인과 같습니다.

nonce는 한 번 검증에 사용하면 재사용할 수 없습니다. 실패 후에는 새 nonce와 새로운 로그인 시도로 다시 시작합니다.

### 6.5. HTTP 200이어도 로그인 완료가 아닌 경우

현재 구현은 아래 경우에도 HTTP 200의 `data.redirect_uri`를 반환합니다. HTTP 200만 보고 로그인 성공으로 처리하지 말고 반환된 안내 페이지로 이동합니다.

| 상황 | `redirect_uri` |
| --- | --- |
| API에 가입되지 않은 계정 | `https://api.gdghufs.com/error/not-registered` |
| Google 사용자 정보 조회 실패 또는 할당량 초과 | `https://api.gdghufs.com/error/page?message=...` |

이 경우 SSO 코드가 발급되지 않으며 자체 로그인 세션을 만들어서는 안 됩니다. 연동 서비스의 로그인 완료 판단은 `/userinfo`에서 사용자 정보를 받은 뒤에 합니다.

### 6.6. CORS와 쿠키

- 브라우저 직접 호출용 CORS는 `/onetap/nonce`와 `/onetap`에만 설정되어 있습니다.
- One Tap 허용 클라이언트의 콜백 URI에서 추출한 origin만 허용합니다.
- 허용 메서드는 `POST`, `OPTIONS`이고, 요청 헤더는 `Accept`, `Content-Type`입니다.
- API 쿠키를 포함하지 않습니다. `fetch`를 사용하면 `credentials: "omit"`으로 호출합니다.
- `/userinfo`를 브라우저에서 직접 호출하지 않습니다. 시크릿 보호를 위해 백엔드에서 교환합니다.
- One Tap 자체는 API의 브라우저 로그인 세션을 만들지 않습니다. 연동 서비스는 코드 교환 후 자체 세션을 생성합니다.


## 7. 오류 처리

JSON 오류 응답 예시:

```json
{
  "error_code": "COMMON_002",
  "message": "Invalid or expired code"
}
```

정상 응답에는 `error_code`와 `message`가 없고, 오류 응답에는 `data`가 없습니다. 별도의 `success`나 `status` JSON 필드는 없습니다. HTTP 상태와 `error_code`를 기준으로 처리하고 `message`는 진단에 사용합니다.

| HTTP 상태 | 오류 코드 | 대표 상황 |
| --- | --- | --- |
| 400 | `COMMON_002` | 필수값 누락, 잘못된 JSON, 잘못된 매개변수 |
| 400 | `COMMON_002` | `Unknown client_id`, `Invalid redirect_uri`, `Invalid state` |
| 400 | `COMMON_002` | 코드가 유효하지 않거나 만료됨 |
| 400 | `COMMON_002` | One Tap 비활성 클라이언트, `Invalid origin` |
| 401 | `AUTH_001` | `/userinfo` 클라이언트 자격 증명 불일치 |
| 401 | `AUTH_002` | Google One Tap 토큰 또는 nonce 검증 실패 |
| 429 | `COMMON_005` | One Tap nonce 발급 횟수 초과 |
| 500 | `COMMON_004` | 전역 오류 처리로 반환된 서버 내부 오류 |

CORS가 보안 필터 단계에서 거부되면 HTTP 403이나 브라우저의 CORS 오류가 발생할 수 있으며, 위 JSON 형식을 보장하지 않습니다. 브라우저에서 오류 본문을 읽을 수 없으면 origin 등록과 preflight 응답부터 확인합니다.

일반 Google 로그인 도중의 실패는 연동 서비스 콜백에 `error` 매개변수를 붙여 반환하는 방식이 아닙니다. API의 안내 페이지로 이동합니다.

| 상황 | API 안내 경로 |
| --- | --- |
| 로그인 세션 유실 | `/error/login-session` |
| 사용자가 Google 로그인 취소 | `/error/login-cancelled` |
| 학교 계정이 아님 | `/error/not-hufs-mail` |
| 그 외 OAuth 또는 사용자 정보 처리 실패 | `/error/page` |


## 8. API 운영자 설정

연동 서비스가 아니라 API 서버의 Spring 설정에 클라이언트를 등록합니다. 예시:

```yaml
sso:
  clients:
    - id: sample-service
      secret: ${SSO_SAMPLE_SERVICE_SECRET}
      one-tap-enabled: true
      allowed-redirect-uris:
        - https://service.example.com/auth/callback
```

- `one-tap-enabled`의 기본값은 `false`입니다.
- `application-sso.yml`의 저장소 기본값은 빈 클라이언트 목록입니다. 해당 파일을 이용하려면 `sso` 프로필을 활성화하거나 명시적으로 가져와야 합니다.
- 운영의 외부 Spring 설정을 사용하는 경우 그 설정의 `sso.clients` 목록에 등록합니다. 위 환경변수 이름만 추가한다고 클라이언트가 자동 등록되지는 않습니다.
- 목록 설정을 덮어쓸 때 기존 클라이언트가 누락되지 않도록 전체 유효 설정을 확인합니다. 같은 `id`를 중복 등록하지 않습니다.
- 레지스트리와 CORS 목록은 시작 시 구성되므로 등록 내용 변경 후 API를 재시작 또는 재배포합니다.
- 시크릿은 서비스별로 분리합니다. One Tap에는 시크릿을 전달하지 않습니다.
- One Tap을 사용하는 서비스 origin은 같은 Google OAuth 웹 클라이언트에도 등록합니다.
- 일반 Google OAuth가 돌아올 API 콜백은 `/login/oauth2/code/google`이며, 연동 서비스의 `redirect_uri`와 다릅니다.
- Redis가 코드와 nonce를 보관하므로 API 인스턴스는 같은 Redis를 사용해야 합니다. 일반 OAuth 로그인은 API 세션도 유지되어야 합니다.
- 현재 nonce 발급 제한은 서버가 인식한 요청 IP를 사용합니다. 프록시 환경의 전달 헤더 신뢰 범위를 확인합니다.

SSO 로그아웃을 모든 연동 서비스에 전파하는 기능은 없습니다. 연동 서비스의 로그아웃은 자체 세션을 삭제해야 하며, API의 `/logout` 호출만으로 연동 서비스의 세션이 종료되지는 않습니다.


## 9. 연동 확인 목록

- 등록된 클라이언트와 정확히 일치하는 콜백으로 일반 로그인이 완료되는지 확인합니다.
- 콜백의 `state`가 현재 세션에 저장한 값과 일치해야만 로그인이 완료되는지 확인합니다.
- 백엔드에서만 코드를 교환하고 `client_secret`이 브라우저나 로그에 노출되지 않는지 확인합니다.
- 코드 만료 또는 교환 실패 시 새 로그인으로 복구할 수 있는지 확인합니다.
- `institutional_id`가 없어도 의도한 방식으로 처리되는지 확인합니다.
- One Tap의 nonce 발급, Google 초기화, credential 전송에 같은 요청 정보를 사용하는지 확인합니다.
- One Tap의 HTTP 200 안내 페이지 응답을 로그인 성공으로 오인하지 않는지 확인합니다.
- 로그인 취소, API 세션 만료, CORS 거부, nonce 발급 제한에 대한 사용자 안내를 준비합니다.
- 로그인 성공 후 코드가 포함된 콜백 URL을 제거하고 자체 서비스 세션만 사용하는지 확인합니다.
