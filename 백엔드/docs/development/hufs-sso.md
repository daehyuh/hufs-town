# GDG HUFS SSO 연결

2026-09-21 사용자 결정에 따라 Google OAuth 대신 `hufs-code-master-server`와 같은 GDG HUFS SSO를 사용한다. 백엔드 루트의 [관리자 연동 가이드](../../sso.md)를 추가 확인해 반영했다. Google Cloud 클라이언트는 필요하지 않다. 참조 저장소의 코드는 수정하지 않았다.

## 관리자가 준비할 값

HUFS Town 전용 애플리케이션을 등록하고 다음 값을 받는다. CODE MASTER의 `ps` 클라이언트나 그 서비스의 키를 재사용하지 않는다.

| 항목 | 값 |
|---|---|
| 앱 이름 | HUFS Town |
| Client ID | `hufs-town-local-test` (사용자가 전달한 등록값) |
| Client Secret | 백엔드 `.env`의 `HUFS_SSO_CLIENT_SECRET=` 뒤에 붙여넣기 |
| 개발 콜백 URI | `http://localhost:5173/auth/callback` |
| 운영 콜백 URI | `https://실제서비스도메인/auth/callback` — 도메인 확정 후 별도 등록 |
| Authorize | `https://api.gdghufs.com/v1/sso/authorize` |
| Userinfo 코드 교환 | `POST https://api.gdghufs.com/v1/sso/userinfo` |

콜백의 호스트·포트·경로가 정확히 일치해야 한다. 등록된 개발 접속은 **http://localhost:5173/** 이다. `127.0.0.1`은 다른 origin이므로 대체해서 접속하지 않는다. 현재 PC에서는 localhost를 IPv6 loopback `::1:5173`에 바인딩해 기존 IPv4 5173 서비스와 충돌하지 않게 했다. 키를 채팅이나 프론트엔드 `VITE_*` 변수에 넣지 않는다.

## 로컬 설정

`백엔드/.env.example`과 Git에서 제외된 **`백엔드/.env`를 만들었다.** `.env`의 시크릿 한 줄만 채운다. 이전 `.env.local`은 보존했으며 새 `.env`가 우선한다.

```dotenv
TOWN_AUTH_MODE=sso
TOWN_PUBLIC_ORIGIN=http://localhost:5173
TOWN_WORLD_ENDPOINTS=
TOWN_COOKIE_SECURE=false
HUFS_SSO_CLIENT_ID=hufs-town-local-test
HUFS_SSO_CLIENT_SECRET=
HUFS_SSO_REDIRECT_URI=http://localhost:5173/auth/callback
```

다중 월드 노드를 쓸 때 `TOWN_WORLD_ENDPOINTS`에 브라우저에서 직접 접근할 수 있는 WebSocket 주소를 쉼표로 구분해 적는다. 예: `wss://world-a.example.com/world/socket,wss://world-b.example.com/world/socket`. 입장 API는 공간 ID 기준으로 주소 하나를 안정적으로 선택해 돌려준다. 비워 두면 기존처럼 웹 앱과 같은 출처의 `/world/socket`으로 연결한다.

현재 `.env`는 `TOWN_AUTH_MODE=sso`로 준비했다. 시크릿이 비어 있으면 설정 대기 화면을 표시하고 API와 월드는 익명 입장을 허용하지 않는다. 시크릿을 넣고 서버를 재시작하면 버튼이 활성화된다. 인증 없는 월드 미리보기가 필요할 때만 명시적으로 `preview`를 선택한다. 키 누락을 이유로 자동으로 미리보기 모드로 내려가지 않는다.

설정을 적용하려면:

```powershell
cd C:\Project\hufstown\백엔드
./scripts/dev.ps1 stop
./scripts/dev.ps1 start
```

이 실행기는 API와 월드에 같은 인증 모드·Redis 설정을 전달한다. 환경변수 우선순위는 프로세스 환경 → `.env` → 이전 `.env.local` → `infra/.env`다. 과거의 `GOOGLE_*` 설정은 읽지 않는다.

운영에서는 `TOWN_AUTH_MODE=sso`, `TOWN_COOKIE_SECURE=true`, HTTPS public origin/콜백을 설정하고 `local`/`preview` 프로필을 사용하지 않는다. `/api`와 `/world`를 같은 웹 origin으로 프록시한다. `/auth/callback`은 SPA의 `index.html`로 제공하고 `Referrer-Policy: no-referrer`, 인증 응답 `Cache-Control: no-store`, 콜백 query를 남기지 않는 접근 로그 설정을 유지한다. API/월드는 같은 Redis와 `hufs-town:session` namespace를 사용한다. 현재 loopback 바인딩·개발 Compose는 로컬 실행용이며 운영 배포 작업은 별도 태스크다.

## 구현된 인증 흐름

1. React가 `/api/v1/auth/config`로 모드·설정 준비 여부를 읽고 `/me`로 기존 세션을 복원한다.
2. `GET /csrf`로 CSRF 토큰을 받은 뒤 `POST /start`를 호출한다. 서버가 256비트 난수 state를 만들고 Redis에 10분간 브라우저 세션과 연결해 저장한다. IdP와 동일하게 새 로그인 시작 시 이전 흐름을 대체한다.
3. 서버가 만든 authorize URL에는 `client_id`, `redirect_uri`, `state`, `select_account=true`가 들어간다. 브라우저가 해당 주소로 이동한다.
4. SSO가 `/auth/callback?code=...&state=...`로 돌려보낸다. React는 query를 즉시 브라우저 history에서 제거한다. React StrictMode에서도 교환 요청은 한 번만 보낸다.
5. `POST /exchange`는 CSRF, 브라우저에 연결된 일회용 state, 코드 재사용 여부를 검사한다. 서버가 아래 JSON으로 userinfo를 요청한다.

```json
{"client_id":"HUFS Town ID","client_secret":"백엔드 비밀값","code":"일회용 코드"}
```

6. 응답의 `error_code`가 없는 경우 `data.uuid`, `data.status`로 계정과 자격을 검증한다. 서비스 계정 식별자는 `provider=gdg_hufs + uuid`다. 가이드에 따라 SSO 이름·학번·사번·이메일·소속·status를 장기 저장하지 않는다. V3 마이그레이션으로 이전의 status 열도 제거했다. 서비스 닉네임과 아바타는 별도 사용자 설정이다.
7. MariaDB에서 계정을 만들거나 조회한 뒤 세션 ID와 CSRF 토큰을 회전한다. Redis에 Spring Session을 저장하고 `HUFS_TOWN_SESSION` HttpOnly/SameSite=Lax 쿠키를 발급한다. 비활성 만료는 8시간이다.
8. 닉네임·아바타 저장 후 WebSocket을 연다. 월드는 쿠키 세션과 정확한 Origin을 검사하고 서버에 저장된 프로필을 사용한다. 복구 토큰은 원래 로그인 세션에 연결된다.
9. 월드는 별도 작업에서 약 1초 간격으로 Redis 세션을 확인한다. 로그아웃·만료 시 해당 세션의 모든 월드 연결을 종료하며 Redis 장애 시 인증 연결을 닫는다. Redis 확인 작업은 이동 tick에서 실행하지 않는다.

이 SSO 규격은 OIDC ID token 교환이 아니다. ID token/nonce/PKCE를 임의로 추가하지 않았다. HUFS Town의 `/exchange`는 참조 앱보다 강화된 브라우저 state·CSRF 검증을 위해 `code`와 `state`를 함께 받는다. 외부 IdP에 보내는 요청 규격은 참조 서버와 같다. CODE MASTER와 쿠키·회원 DB·로그인 세션을 공유하지 않는다.

## 계정 정책과 남은 범위

- 재학생(`ENROLLED`), 휴학생(`LEAVE_OF_ABSENCE`), 졸업생(`GRADUATED`), 교수·강사·교원(`FACULTY`), 직원(`STAFF`), 공용 계정(`COMMON_ACCOUNT`), 판별되지 않은 계정(`UNKNOWN`)을 모두 허용한다. 구 SSO 상태값과 한국어 별칭도 대응 유형으로 정규화한다. 비어 있지 않은 새 상태값도 `UNKNOWN`으로 처리한다.
- 계정 유형은 로그인을 제한하지 않는다. GDG 멤버·운영자 권한은 별도 검증 없이 부여하지 않는다.
- 신규 계정의 기본 닉네임은 `HUFS 친구`다. 입장 전에 사용자가 고른 서비스 닉네임과 아바타를 저장하고 다음 로그인에도 유지한다.
- SSO code는 발급 후 **60초** 안에 즉시 교환한다. 교환 실패를 자동 반복하지 않고 새 로그인으로 복구한다. 클라이언트 자격 증명 오류(상위 HTTP 401)는 코드 만료와 구분해 설정 오류로 안내한다.
- 일반 Google 로그인 취소/학교 계정 거절/IdP 세션 유실은 **IdP 안내 페이지**에 표시된다. 사용자가 HUFS Town으로 돌아와 다시 시작한다. 앱의 `?error=` 처리는 예상치 못한 콜백에 대한 방어적 처리이며, 실제 IdP가 그 방식으로 취소를 전달한다고 가정하지 않는다.
- One Tap은 선택 기능이며 이번 구현 범위에 포함하지 않았다.
- 일반 로그아웃은 **현재 브라우저 세션과 그 세션의 모든 월드 탭**을 종료한다. 계정 탈퇴 때는 인덱싱된 Redis 세션을 전부 폐기하며 상세 보존 규칙과 검증 범위는 [탈퇴 구현 기록](../implementation/16-account-deletion.md)을 따른다. 모든 기기 로그아웃과 운영자의 즉시 전체 세션 차단은 별도 운영 태스크다.
- 로그인 상태의 공간 접근 검사는 준비됐지만 공간/초대/정원 예약 티켓 시스템은 T07/T09에서 구현한다. 현재는 단일 캠퍼스다.
- 사용자가 실제 키를 입력한 뒤 개발 콜백에서 SSO 로그인, 서비스 프로필 복원, 인증된 월드 입장까지 확인했다. 실제 IdP 재로그인 왕복과 운영 환경 검증은 남아 있다.

## 확인 근거와 검사

현재 계약 근거: 백엔드 루트 `sso.md`. 참조 구현: `hufs-code-master-server`의 `API.md`, SsoClient/DTO, MemberStatus. 계정 유형은 로그인 허용 여부에만 사용하고 GDG 멤버·운영자 권한과 연결하지 않는다.

```powershell
./scripts/gradle.ps1 test :modules:persistence:integrationTest :apps:api:integrationTest
# 프론트 폴더에서, 로컬 미리보기 서버가 실행 중일 때
pnpm test
pnpm build
pnpm test:e2e
```

통합 검사는 임시 MariaDB/Redis 컨테이너에서 실제 API·월드 서버를 실행한다. 외부 SSO HTTP 전송만 모의 처리하므로 실제 인증 서버에 테스트 요청을 보내지 않는다. 브라우저 인증 검사는 모의 API로 화면·콜백·로그아웃 동작을 검증하고, 기존 세 브라우저 월드 검사는 실제 로컬 서버를 사용한다.
