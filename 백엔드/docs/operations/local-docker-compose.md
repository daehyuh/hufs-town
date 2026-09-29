# 로컬 Docker Compose 운영 안내

이 문서는 개발 PC에서 MariaDB·Redis와 선택적인 Spring API·World 컨테이너를 다루는 절차다. 현재 Compose는 배포 구성이 아니다. 모든 호스트 포트가 `127.0.0.1`에만 바인딩되며, 도메인·TLS·프로덕션 비밀값 저장소·외부 알림 전달·백업 작업은 준비되지 않았다. 선택형 `observability` 프로필은 Prometheus로 API·World·Media 지표를 15일간 보관하고 로컬 경보 규칙과 HUFS Town 대시보드를 제공한다. Media 지표는 공간·플레이어 ID 없이 미디어 연결·트랙·녹화의 전체 집계만 노출하며 Docker 내부망에서 수집한다. 여기 적힌 Compose health와 로컬 경보는 실제 배포/당직 알림 완료 증거가 아니다.

## 설정 파일과 구성

- `infra/.env`는 Compose 변수 치환에 쓰인다. 처음이면 `Copy-Item infra/.env.example infra/.env`로 만들고 로컬 DB 비밀번호를 정한다. 예제 값은 개인 개발용이며 공유 환경에서 사용하지 않는다.
- 백엔드 루트 `.env`는 Compose의 `api`와 `world` 컨테이너에 주입되는 애플리케이션 설정(SSO 및 선택적 미디어 설정 등)이다. 두 파일을 혼용하거나 실제 시크릿을 문서·로그에 붙여 넣지 않는다.
- 프론트 `.env.local`은 Vite의 개발 호스트와 프록시를 정한다. 이 파일들은 로컬 실행을 편하게 할 뿐 환경 분리나 시크릿 저장소를 제공하지 않는다. 실제 운영에서는 개발 `.env`를 복사하지 말고 각 환경의 배포 시스템/시크릿 관리자에서 값을 주입한다.
- 기본 포트는 API `127.0.0.1:18090` → 컨테이너 `18080`, World `127.0.0.1:18091` → `18081`, MariaDB `127.0.0.1:3307` → `3306`, Redis `127.0.0.1:6380` → `6379`다. React 개발 웹은 이 Compose 파일에 포함되지 않고 별도로 `localhost:5173`에서 실행한다.
- Tailnet의 다른 기기에서 Docker API·World를 쓰는 개발 웹은 프론트 루트의 Git 제외 `.env.local`에 `TOWN_VITE_HOST=<이 PC의 Tailscale IPv4>`, `TOWN_API_TARGET=http://127.0.0.1:18090`, `TOWN_WORLD_TARGET=http://127.0.0.1:18091`을 둔다. API·World 포트는 계속 loopback에 남고, 브라우저의 `/api`·`/world` 요청은 Vite를 거쳐 전달된다. 단일 World 개발 환경의 `WORLD_PUBLIC_ENDPOINT`는 `ws://localhost:18091/world/socket`으로 둔다. 프론트가 loopback World 주소를 현재 페이지의 WebSocket 출처로 바꾸므로 localhost와 Tailnet 브라우저 모두 같은 출처 프록시를 통과하고 로그인 세션도 유지된다. 여러 공개 World 노드를 운영할 때만 각 브라우저가 직접 접근할 수 있는 주소를 `WORLD_PUBLIC_ENDPOINT`에 지정한다. Vite 설정은 `pnpm dev` 시작 시 프론트 `.env.local`을 읽는다.
- 같은 PC의 `http://localhost:5173`과 Tailnet 접속을 동시에 쓰려면 Vite를 두 개 실행한다. `.env.local` 설정을 사용하는 기존 `pnpm dev`는 Tailscale IPv4에 계속 바인딩하고, 프론트에서 `pnpm dev:localhost`를 별도 터미널로 실행하면 `127.0.0.1`에만 같은 포트가 열린다. 두 주소를 모두 브라우저에서 쓸 수 있고, localhost용 리스너는 다른 네트워크 인터페이스에 공개되지 않는다.
- 같은 tailnet 기기에서 WebRTC를 시험할 때는 백엔드 `.env`의 `MEDIA_ANNOUNCED_ADDRESS`와 `MEDIA_RTC_BIND_ADDRESS`에 이 PC의 Tailscale IPv4를 지정한다. SFU ICE 후보가 이 주소를 광고하고 UDP/TCP 44444도 이 인터페이스에만 열린다. 제어 포트 18082는 계속 loopback/Compose 내부 통신으로 둔다. 이 환경변수를 비우면 기본 loopback 구성으로 돌아간다.
- API와 World는 `runtime` 프로필에 있다. 이 두 서비스는 별도 미디어 Compose가 만드는 외부 `hufs-town-media_default` 네트워크를 참조한다. API·World를 Compose로 올리려면 `scripts/media.ps1 start`로 로컬 미디어 스택을 먼저 준비한다. MariaDB·Redis만 필요하면 `runtime` 프로필 없이 실행한다.
- Compose는 `mariadb-data`, `redis-data`, `town-assets` named volume을 사용한다. 컨테이너를 다시 만들어도 이 데이터는 유지된다.

로컬 개발 웹 주소를 `localhost` 또는 `127.0.0.1`로 열 수 있도록 루트 `.env`와 `.env.example`은 두 출처를 모두 등록한다. 개발 실행기(`scripts/dev.ps1`)도 `TOWN_ALLOWED_ORIGINS` 설정을 읽는다. 실제 운영 환경에는 이 로컬 출처 목록을 복사하지 말고 공개 사이트의 정확한 origin만 등록한다.

## 기동과 상태 확인

백엔드 루트 `C:\Project\hufstown\백엔드`에서 PowerShell을 열고 실행한다. 전체 로컬 런타임은 다음 순서로 시작한다.

```powershell
if (-not (Test-Path infra/.env)) { Copy-Item infra/.env.example infra/.env }
./scripts/media.ps1 start
docker compose --env-file infra/.env -f infra/compose.yaml --profile runtime up -d --build --wait
```

DB·Redis만 올려 로컬 개발 실행기(`scripts/dev.ps1`)가 API와 World를 직접 실행하게 하려면 마지막 줄에서 `--profile runtime`을 빼고 실행한다.

```powershell
docker compose --env-file infra/.env -f infra/compose.yaml up -d --wait
```

서비스 상태와 애플리케이션 health를 각각 확인한다.

```powershell
docker compose --env-file infra/.env -f infra/compose.yaml --profile runtime ps
Invoke-RestMethod http://127.0.0.1:18090/actuator/health
Invoke-RestMethod http://127.0.0.1:18091/actuator/health
```

API와 World 응답에서 `status`가 `UP`인지 확인한다. `ps`에서 MariaDB·Redis의 health가 `healthy`, API·World도 `healthy`인지 본다. Compose API·World Actuator는 메인 앱 포트와 분리한 관리 포트 `18082`/`18083`에서만 연다. 이 포트는 호스트에 게시하지 않는다. 확인은 `docker compose --env-file infra/.env -f infra/compose.yaml --profile runtime exec api curl -fsS http://127.0.0.1:18082/actuator/health`와 같은 명령의 `world`/`18083` 조합으로 할 수 있다. 이 확인은 개발 PC의 프로세스 상태만 확인하며 사용자 로그인, 브라우저 미디어, 인터넷 경로 또는 운영 준비도를 증명하지 않는다. 로그는 `docker compose --env-file infra/.env -f infra/compose.yaml --profile runtime logs --tail 100 api world`로 확인한다.

로컬에서 Prometheus를 시작하려면 API·World를 새 소스로 다시 빌드하고, `observability` 프로필을 켠다. 첫 명령은 두 애플리케이션을 재생성해 연결된 사용자의 접속이 잠시 끊기므로 사용 중인 세션이 없을 때만 실행한다.

```powershell
docker compose --env-file infra/.env -f infra/compose.yaml --profile runtime up -d --build --wait api world
docker compose --env-file infra/.env -f infra/compose.yaml --profile observability up -d --wait prometheus
```

Prometheus UI는 `http://127.0.0.1:9090`이며 Status → Targets에서 API/World 수집 상태를, Alerts에서 경보 규칙 평가를 확인한다. HUFS Town 대시보드는 `http://127.0.0.1:9090/user/hufs-town.html`에서 열고 1/6/24시간 범위를 바꿀 수 있다. API와 World 컨테이너가 이번 소스에서 재생성되지 않았다면 관리 포트가 아직 열리지 않아 두 대상이 down으로 보일 수 있다. 예시 지표는 `hufs_world_tick_duration_p95_seconds`, 명령 대기 큐의 `hufs_world_command_queue_size`/`hufs_world_command_queue_capacity`, 입장 대기 큐의 `hufs_world_join_queue_size`/`hufs_world_join_queue_capacity`/`hufs_world_join_queue_rejected_total`, `hufs_world_players_active`, `http_server_requests_seconds_count`, `jvm_memory_used_bytes`다. 대시보드는 두 큐의 용량 사용률과 입장 큐의 최근 5분 거절 수를 보여준다. 경보 규칙은 수집 대상 중단, World tick p95 25ms 초과, 명령 및 입장 큐 각각 80% 초과, 명령 거절, API 5xx 비율을 다룬다.

Compose 관리 포트는 호스트에 게시하지 않으며 Prometheus UI만 loopback에 연다. 로컬 실행기(`scripts/dev.ps1`)는 관리 포트를 따로 지정하지 않으므로 기존 loopback Actuator 경로를 유지한다. Prometheus 데이터는 `prometheus-data` volume에 저장하며 백업에서 제외한다. 경보는 Prometheus UI에서 확인할 수 있고 이메일/Slack 등 외부 수신자에게 전달하지 않는다. Docker의 `unhealthy` 표시는 상태만 바꾸며 `restart: unless-stopped`만으로 살아 있는 비정상 컨테이너를 재시작하지 않는다. 운영 환경은 제한된 관리 네트워크, 외부 readiness 감시, 실제 경보 수신과 담당자 대응 절차를 별도로 연결해야 한다. API·World health도 SSO, WebSocket, 브라우저 ICE/TURN, 파일 저장까지 확인하는 종단간 검사는 아니다.

### 로컬 데이터 백업·복원

Compose의 MariaDB·API·Media가 모두 실행 중일 때 `scripts/backup-local.ps1`을 실행하면 DB 덤프와 업로드/녹화 파일을 `.build/backend/backups`에 백업한다. 실행 서비스는 재시작하지 않는다. 다음 명령으로 파일 해시를 검사한다.

```powershell
$backup = ./scripts/backup-local.ps1
./scripts/verify-local-backup.ps1 -BackupDirectory $backup
```

`scripts/restore-local.ps1 -BackupDirectory <백업 폴더>`는 DB를 기본 이름 `hufstown_restore`로 복원하고 파일을 `.build/backend/restores` 아래에 별도 배치한다. 기존 DB는 명시적 `-ReplaceDatabase` 없이는 바꾸지 않는다. 복원 파일을 실행 중인 서비스 volume에 자동 적용하거나 앱 트래픽을 전환하지 않는다. 전체 범위와 제한은 [로컬 백업과 격리 복원](../implementation/26-local-backups.md)을 따른다.

이 도구는 로컬 수동 백업이다. 파일은 암호화하지 않으며 스케줄·회전·off-site 저장을 설정하지 않는다. MariaDB와 파일 volume이 서로 다른 시점에 복사되므로 서비스 쓰기가 계속되는 환경의 원자 스냅샷으로 볼 수 없다. 운영 복구 전에 쓰기 중지/스토리지 스냅샷, 암호화 보관소, 비밀값·외부 서비스 재구성과 전체 복원 리허설이 필요하다.

격리된 WebSocket 부하 검사는 백엔드 루트에서 `scripts/docker-world-load.ps1 -ClientCount 100 -WarmupSeconds 60 -SteadyStateSeconds 60`으로 실행한다. 이 스크립트는 실행마다 고유 이미지와 폐기 가능한 preview World 컨테이너를 만들며 기존 API·World·DB·Redis 서비스를 시작하거나 재생성하지 않는다. 결과 JSON과 Docker CPU/메모리 표본은 `.build/backend/world-load`에 저장한다. `-RecordJfr`를 추가하면 진단용 JFR도 저장되며, JFR 계측은 처리 시간을 늘릴 수 있다. 이 시험은 DB·SFU 미디어 부하를 끈 World 이동 검증이므로 실제 브라우저 ICE/DTLS·TURN·RTC 통합 증거로 간주하지 않는다.

## 재빌드·롤백·정지

아래 절차는 로컬 개발 컨테이너에서 직전 API·World 이미지를 보관하는 방법이다. 프로덕션 릴리스 절차가 아니며, 태그는 같은 Docker 호스트에만 보관되고 불변 아티팩트 저장소나 배포 승인 기록을 대신하지 않는다. 코드 변경 후 이미지를 다시 만들기 전에 현재 API·World 이미지에 복구용 태그를 붙인다. Compose 프로젝트 이름이 `hufs-town`이므로 서비스 이미지 이름은 `hufs-town-api:latest`, `hufs-town-world:latest`다.

```powershell
$apiImage = docker compose --env-file infra/.env -f infra/compose.yaml --profile runtime images -q api | Select-Object -First 1
$worldImage = docker compose --env-file infra/.env -f infra/compose.yaml --profile runtime images -q world | Select-Object -First 1
if (-not $apiImage -or -not $worldImage) { throw '기존 API와 World 이미지가 있는지 먼저 확인하세요.' }
docker image tag $apiImage hufs-town-api:rollback
docker image tag $worldImage hufs-town-world:rollback
docker compose --env-file infra/.env -f infra/compose.yaml --profile runtime build api world
docker compose --env-file infra/.env -f infra/compose.yaml --profile runtime up -d --no-build --wait api world
```

새 버전 health가 실패하면 이전 이미지로 되돌리고 다시 health를 확인한다.

```powershell
docker image tag hufs-town-api:rollback hufs-town-api:latest
docker image tag hufs-town-world:rollback hufs-town-world:latest
docker compose --env-file infra/.env -f infra/compose.yaml --profile runtime up -d --no-build --force-recreate --wait api world
Invoke-RestMethod http://127.0.0.1:18090/actuator/health
Invoke-RestMethod http://127.0.0.1:18091/actuator/health
```

이 절차는 컨테이너 이미지만 되돌린다. Flyway가 적용한 DB 변경은 이미지 롤백으로 취소되지 않는다. 스키마가 바뀐 배포는 복원 가능한 DB 백업과 별도 복구 절차가 필요하다. 전체 런타임을 멈출 때는 `docker compose --env-file infra/.env -f infra/compose.yaml --profile runtime stop`을 사용한다. DB·Redis를 계속 쓰고 API·World만 멈출 때는 마지막에 `stop api world`를 지정한다. 미디어는 `./scripts/media.ps1 stop`으로 별도 정지한다. 데이터 볼륨 삭제가 포함되는 `down -v`는 실행하지 않는다.

실제 릴리스에서는 이미지 태그 `latest` 대신 커밋 SHA/릴리스 ID와 digest로 배포 대상을 고정하고, 직전 API·World 이미지와 환경 설정 revision을 함께 보존한다. DB migration은 이전 앱 버전과 호환되는 expand/contract 순서로 배포하고, 파괴적 변경 전에는 MariaDB 및 업로드/녹화 저장소의 복원 가능한 백업을 확보한다. 로컬 수동 dump·파일 복원 도구는 있으나 자동 백업, off-site/암호화 저장, Redis 재구성, 운영 환경 복원 리허설은 없다. 앱 이미지 롤백만으로 데이터 migration이나 저장된 사용자 파일은 복원되지 않는다.

Tailnet IP로 접속하는 개발 세션의 WebSocket 출처는 루트 `.env`의 `TOWN_ALLOWED_ORIGINS`에 정확한 origin 목록으로 적는다. 예: `http://localhost:5173,http://100.87.52.42:5173`. API와 World가 이 목록만큼 출처를 허용하도록 둘 다 재생성한다. 이 설정은 WebSocket 출처만 추가하며 SSO redirect URI를 바꾸지 않는다. Tailnet HTTP 주소는 브라우저의 secure context가 아니고, 현재 HUFS SSO 콜백도 localhost로 등록되어 있다. 폰에서 실제 로그인을 검증하려면 tailnet HTTPS 주소를 마련하고 `TOWN_PUBLIC_ORIGIN`, `HUFS_SSO_REDIRECT_URI`, HUFS SSO 허용 콜백을 같은 HTTPS origin으로 맞춘 뒤 API·World를 재시작한다. 음성·화상은 별도의 공개 가능한 ICE/TURN 경로와 실제 기기 검증이 필요하다.

Tailnet HTTPS는 tailnet 정책에서 Serve를 활성화한 뒤 `tailscale serve --bg http://<이 PC의 Tailscale IPv4>:5173`으로 로컬 Vite를 제공한다. 이때 프론트 `.env.local`의 `TOWN_VITE_ALLOWED_HOSTS`에 할당된 `<machine>.<tailnet>.ts.net` 호스트를 추가한다. 단일 World는 loopback endpoint를 페이지의 `wss://` same-origin 경로로 자동 변환하므로 `WORLD_PUBLIC_ENDPOINT`를 HTTPS용으로 바꿀 필요가 없다. 현재 이 PC의 Serve는 tailnet 관리자 활성화가 필요한 상태다. 인증 콜백의 외부 URI 허용과 실제 iOS/Android 미디어 통화는 별도 완료 증거가 필요하다.

## T26.2 대상 환경 배포 전 체크

현재 구현된 환경은 `preview`(저장소 없이 익명 확인), `local`(실제 로컬 MariaDB/Redis와 SSO), 그리고 loopback 전용 Docker Compose뿐이다. 선택형 local Prometheus 프로필은 API·World·Media scrape를 제공하지만, HTTPS staging/production 프로필, reverse proxy/TLS 설정, 외부 관리 네트워크·알림 수신 대상은 없다. Tailscale HTTP preview도 브라우저 secure context가 아니므로 SSO·카메라·마이크 검증으로 간주하지 않는다.

실제 대상 환경에서 다음 항목을 값과 검수 증거까지 채운다.

| 영역              | 대상 환경에 필요한 설정/검증                                                                                                                                                                                                                                                                                                   | 현재 상태                                                                                                                                                                                              |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 환경 분리         | 개발·스테이징·운영별 앱 설정, DB/Redis, 도메인, 데이터/파일 저장소, SSO client와 운영 담당자를 각각 지정한다.                                                                                                                                                                                                                  | 로컬 `preview`/`local`만 있음                                                                                                                                                                          |
| HTTPS와 WebSocket | 신뢰되는 도메인 인증서와 자동 갱신, HTTP→HTTPS, `/api`·정적 웹 라우팅, `/world/socket` WebSocket Upgrade, `wss://` 외부 World 주소, 프록시가 전달하는 실제 scheme/host를 검증한다. SFU 제어 API는 공개 라우팅에서 제외한다.                                                                                                    | 미구성                                                                                                                                                                                                 |
| HUFS SSO          | `TOWN_PUBLIC_ORIGIN=https://<도메인>`, `TOWN_COOKIE_SECURE=true`, `HUFS_SSO_REDIRECT_URI=https://<도메인>/auth/callback`을 맞추고 동일한 정확한 URI를 IdP에서 허용한다. 실제 두 계정으로 로그인·로그아웃·세션 만료를 확인한다.                                                                                                 | 현재 허용 URI는 로컬 localhost이며 외부 허용은 관리자 작업 필요                                                                                                                                        |
| 비밀값            | SSO secret, DB 자격 증명, VAPID private key, 미디어 제어 token, TURN 자격 증명을 이미지·저장소·명령 기록에 넣지 않고 환경별 비밀 관리자에서 주입한다. 권한 최소화, 접근 기록, 회전·폐기 절차를 검증한다.                                                                                                                       | Git 제외 로컬 `.env`만 있음                                                                                                                                                                            |
| 미디어            | 외부 ICE 후보, 방화벽 UDP/TCP, 공개 TURN/TURNS와 짧은 수명의 credential을 준비하고 서로 다른 실제 인터넷/모바일망에서 마이크·카메라·화면공유 RTP를 확인한다.                                                                                                                                                                   | loopback/Tailscale 시험 외 공개 미디어 경로 없음                                                                                                                                                       |
| 상태와 알림       | API·World·Media의 liveness/readiness와 외부 접속 synthetic check를 분리한다. Actuator/Media control을 공개하지 않고 제한된 관리 경로로만 수집한다. tick p95/overrun, 명령·입장 큐 크기·용량·거절, 연결/참가자, DB·Redis, SFU worker, recording 저장공간·오류에 대시보드·임계치·담당자 알림을 붙여 실제 알림 수신까지 시험한다. | 선택형 loopback Prometheus 15일 보존, API/World exporter와 개인정보 없는 Media 연결·트랙·녹화 집계, 서비스 중단/queue/녹화 한도 경보와 대시보드가 소스에 있음. 실행 컨테이너 반영·외부 수신·운영 대시보드·저장소 관측은 미검증 |
| 릴리스와 복구     | 불변 image digest와 설정 revision, 이전 호환 DB migration, 직전 버전 트래픽 복귀, DB 및 파일 저장소 백업 계획을 준비한다. 스테이징에서 앱 릴리스 롤백을 리허설한다. 데이터 백업의 실제 복원 리허설과 복구 지표는 T26.3에서 기록한다.                                                                                           | 로컬 image rollback 및 수동 DB/파일 백업·격리 복원 도구 있음; 자동 주기·암호화·off-site·운영 리허설 없음                                                                                               |

완료 증거는 실제 대상 환경의 릴리스 ID/digest, HTTPS와 정확한 HUFS SSO 콜백, 실제 로그인, 맵 생성·입장, 웹소켓 재접속, 두 외부 네트워크 간 RTP, 기록/업로드 저장 경로, health/알림 전달, 직전 버전 롤백 및 데이터 복구 리허설을 함께 남긴다. 도메인, HUFS IdP 허용 목록, 배포 플랫폼/시크릿 관리자, TURN 경로, 알림 수신 대상은 외부 관리 권한과 값이 주어져야 검증할 수 있다. 이 저장소에서 로컬로 실행한 build·Compose 정적 검사나 `health=UP` 응답만으로 T26.2를 완료 처리하지 않는다.

## 근거

현재 포트·프로필·health check·named volume·외부 미디어 네트워크는 [`infra/compose.yaml`](../../infra/compose.yaml), 미디어 제어/RTC 포트는 [`infra/media.compose.yaml`](../../infra/media.compose.yaml), 이미지 빌드 방식은 [`infra/Dockerfile.jvm`](../../infra/Dockerfile.jvm)에 따른다. 실행 모드와 SSO/HTTPS 제한은 [`README.md`](../../README.md), [`docs/development/hufs-sso.md`](../development/hufs-sso.md), 미디어 외부망 한계는 [`docs/adr/0004-media-sfu.md`](../adr/0004-media-sfu.md)에 기록돼 있다.
