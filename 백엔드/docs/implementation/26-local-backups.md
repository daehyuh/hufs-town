# 로컬 백업과 격리 복원

로컬 Docker Compose 데이터의 수동 백업 경로를 추가했다. 기본 출력은 `C:/Project/hufstown/.build/backend/backups`이며, 실행 중인 MariaDB·API·Media 컨테이너를 중지하거나 재생성하지 않는다.

```powershell
$backup = ./scripts/backup-local.ps1
./scripts/verify-local-backup.ps1 -BackupDirectory $backup
./scripts/restore-local.ps1 -BackupDirectory $backup -DatabaseTarget hufstown_restore
```

백업 폴더에는 MariaDB 논리 덤프, API의 업로드 에셋, Media의 녹화 파일, 파일별 SHA-256·크기를 기록한 manifest가 들어간다. 덤프는 InnoDB 단일 트랜잭션으로 읽는다. 실패하면 임시 폴더를 지우고, 모든 항목을 만든 뒤에만 최종 백업 이름으로 바꾼다. 확인 도구는 누락·변조·manifest 밖 파일, 경로 탈출, 심볼릭 링크/재분석 지점을 거부한다.

복원은 기본적으로 `hufstown_restore`라는 별도 데이터베이스에 SQL을 적용하고 에셋·녹화 파일은 `.build/backend/restores` 아래 별도 폴더에 풀어 둔다. 같은 이름의 데이터베이스가 이미 있으면 중단한다. 기존 대상 교체에는 `-ReplaceDatabase`가 필요하며 지정한 대상 DB를 삭제한 뒤 복원한다. 복원 스크립트는 실행 중인 앱 볼륨을 덮어쓰거나 트래픽을 전환하지 않는다. 복원 결과를 확인한 뒤 별도의 복구 환경에서 앱 연결과 파일 접근을 점검해야 한다.

Redis는 로그인 세션, 좌석 예약, 소유권 lease처럼 만료되는 런타임 자료를 담아 백업에서 제외한다. 서비스 복구 때 사용자는 다시 로그인한다. SSO·DB·Media·TURN 비밀값도 포함하지 않으므로 복구 환경에서 비밀 관리자가 별도로 주입해야 한다.

현재 방식은 폴더별 순차 사본이다. DB dump와 업로드/녹화 볼륨 사이의 단일 원자 시점을 보장하지 않으며 스케줄, 회전, 암호화, off-site 복사, Prometheus 시계열 보존도 설정하지 않는다. 로컬 덤프와 녹화에는 계정·사용자 콘텐츠가 있으므로 암호화된 저장소에 보관하고 복구 후 접근을 제한해야 한다. 실제 운영 복구에는 쓰기 중지 또는 스토리지 스냅샷을 조정하고, 환경별 비밀값·도메인·미디어·알림을 포함한 별도 리허설이 필요하다.

격리 테스트용 Docker 컨테이너에서 합성 MariaDB 행·에셋·녹화를 백업하고, 무결성 검사와 DB/파일 복원을 통과시켰다. 변조 파일과 manifest 경로 탈출은 거부됐고, 기존 복원 DB는 `-ReplaceDatabase` 없이 덮어쓰지 않는 점과 해당 옵션을 준 경우 백업 내용으로 교체되는 점을 확인했다. 실제 개발 DB/사용자 데이터를 백업하지 않았다.

운영 서버용 백업은 이 로컬 PowerShell 도구와 분리했다. [운영 배포 runbook](../operations/production-deployment.md)의 `backup-production.sh`는 서버에서 DB·업로드·녹화를 age 공개키로 암호화하며, `.env.production`·Redis·Prometheus 기록은 포함하지 않는다. `restore-production-backup.sh`는 검증된 암호문을 네트워크·공개 포트가 없는 일회용 MariaDB에 가져오고 파일은 보호된 새 디렉터리로 안전하게 푼다. `prune-production-backups.sh`는 명시된 보존 개수에 맞춘 미리보기를 기본 제공하며, `--apply`일 때만 모든 대상의 무결성을 먼저 확인한 뒤 오래된 백업을 삭제한다. 추출기는 경로 탈출, 링크, 장치 파일, 비정상적으로 큰 아카이브를 거부한다. 테스트는 모의 DB importer와 임시 age 키, 합성 데이터만 사용했고 실제 MariaDB나 운영 데이터에는 실행하지 않았다([검증 증거](evidence/26-production-backup-tool-2026-09-28.json)). 운영 복구 호스트에서 실제 백업을 복호화하고 애플리케이션 읽기까지 확인하는 리허설, 백업 일정·보존 정책·외부 저장은 남아 있다.
