# HUFS Town 운영 인수인계

마지막 확인: 2026-09-29. 이 문서는 실제 운영 설정을 다시 출력하지 않고, 확인 가능한 운영 절차와 남은 제한을 정리한다.

## 현재 운영 상태

- 서비스: [https://town.gdgoc.com](https://town.gdgoc.com)
- 현재 앱 릴리스: `20260929T110500Z-admission-pages`
- 운영 서버 별칭: `daehyuh-1`; 프로젝트: `/opt/hufs-town`
- Compose: `/opt/hufs-town/백엔드/infra/production.compose.yaml`
- 현재 확인 결과: `20260929T110500Z-admission-pages` 배포 뒤 Web/API/World/Media/MariaDB/Redis가 healthy이고, Nginx 검사·공개 HTTPS·SSO 설정·기본 공간 정원 100·미디어 활성·World WebSocket 접근 거부 경계가 정상이다. 친구 공개/요청 설정은 People 패널의 설정 탭에서 관리한다. 모든 맵 생성·저장·게시 API 요청 본문은 512KB로 제한된다. 로비의 입장 승인 요청함은 권한 검증이 포함된 단일 조회에서 50건씩 커서 페이지로 이어지며, 월드 승인 패널에서도 같은 목록을 제공한다. [최신 배포 증거](../implementation/evidence/27-admission-inbox-pagination-production-2026-09-29.json)
- Prometheus는 `observability` 프로필로 실행되며 `127.0.0.1:19090`에만 바인딩된다. 규칙 파일은 있지만 Alertmanager 수신 경로가 없어 장애 알림은 외부로 전달되지 않는다.
- `TOWN_ADMIN_USER_IDS`에는 현재 승인 계정 UUID가 설정되지 않았다. 따라서 신고 검토와 운영 분석은 승인된 계정을 지정하기 전까지 사용할 수 없다. [확인 증거](../implementation/evidence/24-admin-allowlist-state-2026-09-29.json)

웹은 Nginx HTTPS 뒤에 있고 API·World·Web의 호스트 포트는 loopback에만 열려 있다. MariaDB·Redis는 Compose 내부망과 영구 볼륨을 사용한다. 미디어 서버는 TCP/UDP 44444를 사용한다.

## 배포와 롤백

Windows 개발 환경에서 비밀값·캐시를 제외한 소스 묶음을 만든 뒤 `daehyuh-1`의 `/tmp`에 전송한다. 운영 서버에서는 설치 스크립트로 `/opt/hufs-town`의 관리 소스만 업데이트하고, 고유 릴리스 ID로 다음 스크립트를 실행한다.

```bash
sudo bash /opt/hufs-town/백엔드/scripts/deploy-production.sh <unique-release-id>
```

이 스크립트는 2 vCPU 서버를 고려해 Web/API/World/Media를 순차 빌드하고 health·공개 smoke 검사를 거친다. 실패 시 이전 앱 이미지로 자동 복귀한다. 수동 앱 롤백은 다음 명령을 사용한다.

```bash
sudo bash /opt/hufs-town/백엔드/scripts/rollback-production.sh
```

앱 롤백은 데이터베이스 마이그레이션이나 영구 볼륨을 되돌리지 않는다. 현재 운영자는 백업 없이 진행하기로 결정했으므로 DB/파일 저장소 장애나 손상 뒤 데이터 복구는 보장되지 않는다. 이 결정이 유지되는 동안 되돌릴 수 없는 스키마 변경은 피한다. 사용자가 백업 결정을 바꾸기 전까지 백업 위치·일정·복구 리허설은 설정되어 있지 않다.

## 상태 확인과 장애 대응

서버에서 컨테이너 상태를 확인한다.

```bash
cd /opt/hufs-town/백엔드
sudo docker compose --env-file infra/.env.production -f infra/production.compose.yaml ps
```

개발 PC에서는 공개 서비스 smoke를 확인한다.

```powershell
pwsh -NoProfile -ExecutionPolicy Bypass -File C:\Project\hufstown\백엔드\scripts\production-smoke.ps1
```

프로세스 시작 문제는 컨테이너 환경을 출력하지 않는 로그 조회로 확인한다.

```bash
sudo docker compose --env-file infra/.env.production -f infra/production.compose.yaml logs --tail 100 api world media
```

운영 장애 때는 먼저 `ps`에서 DB·Redis·Media·API·World·Web 상태를 확인하고, 공개 smoke와 Nginx 설정 검사 결과를 본다. 새 앱 릴리스 직후 앱 컨테이너가 unhealthy이거나 공개 smoke가 실패하면 배포 스크립트의 자동 복귀 결과를 확인한다. 로그 수집 시 세션·메시지 본문·환경값을 외부에 공유하지 않는다.

운영 환경 파일은 `/opt/hufs-town/백엔드/infra/.env.production`이며 `root:root`, 권한 `0600`이다. 값을 출력하거나 소스 묶음·로그·메신저에 복사하지 않는다. 앱 업데이트에서 `/opt/hufs-town` 전체 삭제, `docker volume prune`, 데이터베이스/Redis 볼륨 초기화를 실행하지 않는다.

## 확인되지 않은 운영 제한

- 공간 정원 100은 설정값이다. 운영 ARM64 호스트에서 실제 100명 월드·SFU 미디어 부하는 검증되지 않았다.
- 공개 UDP 44444의 외부 경로는 확인되지 않았고 TURN은 운영에 설정되지 않았다. 네트워크가 UDP를 제한하면 미디어 연결이 실패할 수 있다.
- 최대 8개 동시 화면공유와 한 화면 내 카메라형 갤러리가 배포됐지만, 실제 복수 계정의 동시 송출과 수신은 확인되지 않았다. [갤러리 증거](../implementation/evidence/26-screen-gallery-fit-production-2026-09-29.json)
- 현재 공개 smoke는 인증 없는 HTTP/SSO 설정 확인이다. 실제 HUFS SSO 로그인, 카메라·마이크·화면공유 RTP 통화 성공을 증명하지 않는다.
- 오프사이트 운영 백업이 없으며, DB나 업로드 저장소 손실 후 복구 사본이 없다.
- 운영 경보의 외부 수신처는 아직 연결되지 않았다.

상세 배포 절차와 향후 백업 선택 시의 별도 방법은 [운영 배포 문서](production-deployment.md)를 참조한다. 최신 외부 확인과 릴리스는 [2026-09-29 입장 승인 페이지 배포 증거](../implementation/evidence/27-admission-inbox-pagination-production-2026-09-29.json)에 기록되어 있다.
