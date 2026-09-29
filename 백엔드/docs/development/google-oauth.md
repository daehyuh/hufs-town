# Google OAuth 클라이언트 발급

> **대체된 문서:** 2026-09-21 사용자 결정으로 GDG HUFS SSO를 사용한다. 아래 내용은 이전 Google 로그인 계획의 기록이다. 현재 필요한 설정은 [SSO 연결 안내](hufs-sso.md)를 따른다. Google 클라이언트를 발급하지 않아도 된다.

현재 단계는 발급과 로컬 설정 준비다. T06의 Spring Security 로그인·콜백·서비스 세션은 아직 구현하지 않았으므로 자격 증명만 저장해도 로그인 버튼이 바로 활성화되는 것은 아니다.

## Google Cloud Console

1. [Google Cloud Console](https://console.cloud.google.com/)에서 프로젝트를 선택하거나 `HUFS Town` 프로젝트를 만든다.
2. [Google Auth Platform](https://console.cloud.google.com/auth/overview)에서 시작하기(Get started)를 누른다. 앱 이름은 `HUFS Town`, 사용자 지원 이메일과 개발자 연락처는 본인의 관리용 이메일을 입력한다.
3. 대상(Audience)은 일반 Gmail 계정과 학교 계정을 모두 받을 수 있도록 외부(External)를 선택한다. 내부(Internal)는 선택한 Workspace 조직 내부로 제한하는 경우에만 사용한다. 개발 중에는 테스트(Testing) 상태로 두고 테스트 사용자 항목이 표시되면 본인과 개발용 계정을 추가한다.
4. 데이터 액세스(Data Access)는 로그인에 필요한 `openid`, `email`, `profile`만 사용한다. UI에는 이메일·프로필 권한이 `.../auth/userinfo.email`, `.../auth/userinfo.profile`로 표시될 수 있다. 메일 읽기/발송 권한이나 Gmail API 활성화는 이 로그인 흐름에 필요하지 않다.
5. [클라이언트(Clients)](https://console.cloud.google.com/auth/clients) → 클라이언트 만들기(Create client) → 웹 애플리케이션(Web application)을 선택한다. 이름은 `HUFS Town Local Web`처럼 구분 가능한 값으로 지정한다.
6. 승인된 리디렉션 URI에 아래 값을 등록하고 생성한다.

```text
http://localhost:5173/login/oauth2/code/google
```

승인된 JavaScript 원본은 서버 OAuth 리디렉션 방식에서는 필수가 아니다. 설정하려면 경로 없이 `http://localhost:5173`을 입력한다. `localhost`와 `127.0.0.1`을 섞지 않고 현재 프로젝트의 `127.0.0.1` 주소를 사용한다.

로컬 개발에서는 Vite가 `/oauth2`와 `/login/oauth2`를 Spring API(18080)로 전달한다. 브라우저 기준 origin은 계속 15173이다. Spring 로그인 구현은 `GOOGLE_REDIRECT_URI`를 명시적으로 사용하도록 연결한다. 기본 Spring 콜백 경로는 `/login/oauth2/code/{registrationId}`다.

## 발급 결과 저장

발급되는 값은 Client ID와 Client Secret이다. 현재 Google 공식 안내상 secret은 생성 시점에만 볼 수 있으므로 생성 완료 화면에서 바로 저장한다.

백엔드 `.env.local`의 아래 항목에 입력한다. 이 파일은 Git 제외 대상이며 프론트의 `VITE_` 변수에 secret을 넣지 않는다. 채팅에 secret을 붙여 넣을 필요는 없다.

```dotenv
GOOGLE_CLIENT_ID=발급한-client-id.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=발급한-client-secret
GOOGLE_REDIRECT_URI=http://localhost:5173/login/oauth2/code/google
```

`.env.local.example`을 복사해서 만들 수 있다. `scripts/dev.ps1`은 프로세스 환경변수 → `.env.local` → `infra/.env` 순으로 값을 사용하며 값을 실행하거나 로그에 출력하지 않는다.

실제 로그인 검증은 자격 증명 설정과 T06 구현 뒤 수행한다. 배포할 때는 HTTPS 운영 도메인의 콜백을 별도 등록하고 환경별 클라이언트를 분리한다.

공식 근거: [Google 동의 화면 설정](https://developers.google.com/workspace/guides/configure-oauth-consent), [웹 서버 OAuth 클라이언트 생성·secret 보관](https://developers.google.com/identity/protocols/oauth2/web-server), [Google OIDC scope·redirect 규칙](https://developers.google.com/identity/openid-connect/openid-connect), [Spring 콜백 경로](https://docs.spring.io/spring-security/reference/servlet/oauth2/login/core.html).
