# HUFS Town

React + Phaser 웹과 Java/Spring WebSocket으로 만든 첫 로컬 캠퍼스다. 제공된 GDG HUFS·도트 에셋을 사용하며, 실제 여러 브라우저에서 같은 지도에 접속한다.

현재 동작: 이름과 아바타 3체형·피부색·의상·헤어 커스터마이징, 무작위 외형 선택, 참가자 목록/검색, 걷기·달리기, 서버 충돌, 구역 표시, 감정표현, 자동 재접속, 지도 확대/축소, 퇴장. 외형은 SSO 계정에 저장되어 재입장과 참가자·채팅 표시에서 유지된다. 기본 맵은 회의실·업무석·라운지를 갖춘 오피스이며, 소유자는 맵 편집에서 가구·바닥·벽·구역을 수정하고 저장·게시·복원할 수 있다.

참가자 목록에서 접속별 온라인/자리 비움/방해 금지 상태를 선택할 수 있다. 자리 비움과 방해 금지는 근거리 미디어와 찌르기를 차단하지만 채팅은 계속 허용한다. 차단은 계정에 저장되어 채팅·찌르기·근거리 미디어에 반영된다. 상세 제한은 [접속 상태](docs/implementation/09-presence-status.md)와 [계정 차단](docs/implementation/08-account-blocking.md)을 참고한다.

GDG HUFS SSO 로그인·세션·프로필 저장·인증된 월드 입장을 구현했고 실제 개발 SSO 로그인도 확인했다. 로그인 뒤 공간 홈에서 공간 생성·공개/링크 공개/비공개 설정·초대 코드/링크 발급과 수락·공간별 월드 입장을 사용할 수 있다. 채팅은 근거리·공간 전체·독립 회의실·1:1 DM·그룹 DM을 제공하며, 공간 전체 메시지는 독립 회의실을 제외한다. DM은 멤버십 검사 이력, 읽음 표시, 수정 본문 복구, 활성 세션 실시간 전달과 다중 월드 간 Redis fan-out을 지원한다. 로컬 SFU를 켜면 근거리 음성·화상, 회의실별 통화, 무음 구역, 화면/오디오 공유와 장치 설정을 사용할 수 있다. 여러 사람이 화면을 공유하면 화면별 타일과 독립 음량 조절을 제공한다. 외부 접속용 TURN, Pub/Sub 장애 복구, 100명 실제 통화 부하는 아직 검증하지 않았다. [미디어 구현 기록](docs/implementation/05-realtime-media.md), [아바타 옷장](docs/implementation/10-avatar-customization.md), [DM](docs/implementation/12-direct-messages.md)을 참고한다. [공간·초대](docs/implementation/03-spaces-invitations.md), [오피스·맵 편집기 구현 기록](docs/implementation/04-office-map-editor.md)에 현재 범위와 남은 작업을 기록했다.

## 시작하기 — Windows PowerShell

필요: Node 22.12 이상(검증 24.14.1), pnpm 11.19.0, JDK 21, 실행 중인 Docker Desktop. `JAVA_HOME` 또는 사용자 `.jdks` 폴더의 JDK 21을 사용한다. 시스템 Java 버전은 바꾸지 않는다.

```powershell
cd C:\Project\hufstown\프론트
pnpm install --frozen-lockfile
cd ..\백엔드
if (-not (Test-Path infra/.env)) { Copy-Item infra/.env.example infra/.env }
docker compose --env-file infra/.env -f infra/compose.yaml up -d --wait
./scripts/media.ps1 start # 로컬 음성·화상 SFU 기동 및 .env 설정
./scripts/dev.ps1 start
```

접속: **http://localhost:5173/**. 기본 실행은 실제 MariaDB·Redis에 연결하는 `local` 프로필이다. 현재 `.env`는 등록된 HUFS SSO용으로 준비했으므로 시크릿 입력·재시작 후 로그인한다. 이동 상태는 월드 메모리에 유지하며 서버 재시작 시 접속 상태가 사라진다. DB 없이 익명 월드만 확인하려면 명시적으로 `./scripts/dev.ps1 start -Profile preview`를 사용한다.

같은 Tailscale 네트워크의 휴대폰에서 화면만 미리 보려면 `./scripts/dev.ps1 start -Profile preview -TailnetPreview`를 실행한다. 이 HTTP 미리보기에서는 브라우저 보안 제한 때문에 카메라·마이크·화면 공유가 꺼져 있다.

휴대폰에서도 카메라·마이크·화면 공유를 시험하려면 `./scripts/dev.ps1 start -Profile preview -TailnetHttpsPreview`를 실행한다. Tailscale Serve가 HTTPS를 제공하는 `https://<이 PC의 MagicDNS 이름>.ts.net/` 주소를 출력한다. 이 주소는 tailnet 안에서만 접근할 수 있고, 계정/맵 데이터는 저장하지 않는 익명 미리보기다. 실제 SSO는 사용하지 않는다. 개발 웹/API/월드와 SFU는 서로 분리된 포트에서 기동하고, WebRTC는 이 PC의 Tailscale IPv4로 TCP/UDP 44446을 광고한다. Media control 포트는 loopback에만 둔다. Tailscale Serve의 기존 설정이 있으면 덮어쓰지 않고, `./scripts/dev.ps1 stop`은 시작 시점의 설정과 현재 설정이 같을 때만 임시 HTTPS 경로를 제거한다. tailnet에서 HTTPS 인증서 기능이 꺼져 있으면 Tailscale이 활성화를 요청할 수 있다. HTTPS 주소가 준비되기 전에는 미리보기가 정식 준비 완료를 표시하지 않는다. 학교·회사망 방화벽에 따라 미디어 연결에는 별도 TURN이 필요할 수 있다.

Docker의 실제 API·World를 유지한 채 같은 tailnet의 다른 기기에서 웹을 확인하려면 [로컬 Docker 안내](docs/operations/local-docker-compose.md)의 Tailnet 개발 웹 설정을 사용한다. 이것은 HTTP 미리보기라 HUFS SSO 로그인이나 브라우저 미디어 검증을 대신하지 않는다.

```powershell
./scripts/dev.ps1 status
./scripts/dev.ps1 stop
```

프로세스는 숨겨진 창으로 실행하고 `.local/hufs-town`에 로그와 이 스크립트가 시작한 PID/생성 시각을 기록한다. `stop`은 기록과 일치하는 자체 프로세스만 종료한다. 기존에 사용 중인 포트는 종료하지 않고 안내한다.

## MariaDB·Redis 환경

Docker 엔진이 실행 중이어야 한다. 현재 작업 PC에서 두 컨테이너 healthy, 실제 MariaDB/Redis 기반 통합 검사 14개, Spring API의 Flyway V1~V5 적용 및 health UP을 확인했다.

```powershell
if (-not (Test-Path infra/.env)) { Copy-Item infra/.env.example infra/.env }
docker compose --env-file infra/.env -f infra/compose.yaml up -d --wait
./scripts/dev.ps1 start -Profile local
```

기본 포트는 웹 localhost:5173(IPv6 loopback), API 18080, 월드 18081, MariaDB 3307, Redis 6380, 미디어 제어 18082, WebRTC 44444(UDP/TCP)이며 loopback에만 공개한다. `-TailnetPreview`는 HTTP 화면 전용이다. `-TailnetHttpsPreview`는 웹 5174, API 18084, 월드 18085, 내부 관리 18086/18087, loopback Media control 18088, Tailscale 전용 WebRTC 44446(UDP/TCP)의 격리된 로컬 구성을 사용한다. DB 스키마는 Flyway가 관리한다. 예제 비밀번호는 개인 로컬 개발용이다.

개발 실행기는 프로세스 환경변수 → 백엔드 `.env` → 이전 `.env.local` → `infra/.env` 순서로 허용된 설정을 읽는다. SSO 발급값은 Git에서 제외한 `.env`에 보관한다. client ID는 `hufs-town-local-test`, 콜백은 `http://localhost:5173/auth/callback`으로 입력해 두었다. 시크릿만 채우고 재시작한다. 자세한 내용은 [GDG HUFS SSO 연결 안내](docs/development/hufs-sso.md)를 따른다. Google OAuth는 더 이상 사용하지 않는다.

## 검사

```powershell
# 백엔드 폴더
./scripts/gradle.ps1 test :apps:api:bootJar :apps:world:bootJar
./scripts/gradle.ps1 :modules:persistence:integrationTest :apps:api:integrationTest # Docker 필요; 외부 IdP 전송만 모의 처리
./scripts/media.ps1 test # Docker native SFU 자원/정책 검사
./scripts/e2e.ps1 -SkipBuild -Media -TestFile tests/e2e/media.spec.ts # 실제 WebRTC, 가상 장치
./scripts/e2e.ps1 -SkipBuild # 별도 임시 포트에서 API·월드·웹 기동/검증/정리, 현재 SSO 세션 유지

# 프론트 폴더
pnpm contracts:check
pnpm test
pnpm build
pnpm exec playwright install chromium
pnpm test:e2e # 수동 실행 시 preview API·월드 필요. Windows에서는 위 e2e.ps1 권장
```

`백엔드/contracts/world.schema.json`에서 Java record와 TypeScript 타입을 생성한다. 수정 뒤 프론트에서 `pnpm contracts`를 실행한다. 원본 에셋 카탈로그/선별 복사는 `pnpm assets`로 재생성한다. 원본 파일은 수정하지 않는다. 공개 배포 전 에셋별 이용권한 확인은 남아 있다.

CI 정의는 상위 `.github/workflows/ci.yml`에 있으며, 기본 브랜치 push와 pull request에서 계약 검사·프론트 빌드·통합 검사를 실행한다.

- [구현·검증 기록](docs/implementation/01-local-world.md)
- [전체 설계](docs/planning/README.md)
- [태스크 체크리스트](docs/planning/08-task-backlog.md)
- [초기 런타임 결정](docs/adr/0001-initial-runtime.md)
- [GDG HUFS SSO 키·콜백 설정](docs/development/hufs-sso.md)
- [SSO 구현·검증 기록](docs/implementation/02-sso-login.md)
