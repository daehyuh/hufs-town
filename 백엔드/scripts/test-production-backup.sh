#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
temp_parent=${TMPDIR:-/tmp}
mkdir -p -- "$temp_parent"
temp_parent=$(realpath -e -- "$temp_parent")
work_dir=$(mktemp -d "$temp_parent/hufs-town-backup-test.XXXXXX")
work_dir=$(realpath -e -- "$work_dir")
case "$work_dir/" in
  "$temp_parent"/hufs-town-backup-test.*/) ;;
  *) echo '테스트 임시 경로가 예상한 위치 밖에 있습니다.' >&2; exit 1 ;;
esac

for command_name in age age-keygen gzip sha256sum stat realpath flock openssl tar python3 find sort; do
  command -v "$command_name" >/dev/null 2>&1 || { echo "필수 명령을 찾지 못했습니다: $command_name" >&2; exit 1; }
done

cleanup() {
  result=$?
  if [[ "$work_dir" == "$temp_parent"/hufs-town-backup-test.* && -d "$work_dir" && ! -L "$work_dir" ]]; then
    rm -rf --one-file-system -- "$work_dir"
  fi
  exit "$result"
}
trap cleanup EXIT

mkdir -p "$work_dir/mockbin" "$work_dir/assets" "$work_dir/recordings" "$work_dir/backups" "$work_dir/infra"
printf 'asset-content-marker\n' >"$work_dir/assets/asset.bin"
printf 'recording-content-marker\n' >"$work_dir/recordings/recording.webm"
: >"$work_dir/infra/production.compose.yaml"
: >"$work_dir/infra/.env.production"

cat >"$work_dir/mockbin/docker" <<'MOCK_DOCKER'
#!/usr/bin/env bash
set -Eeuo pipefail
if [[ ${1:-} == inspect ]]; then
  printf 'running|healthy\n'
  exit 0
fi
if [[ ${1:-} == run ]]; then
  printf '%s\n' "$*" >"$MOCK_RESTORE_RUN_ARGS"
  [[ " $* " == *" --network none "* ]] || exit 94
  [[ " $* " == *" --pull=never "* ]] || exit 94
  [[ " $* " != *" --publish "* && " $* " != *" -p "* ]] || exit 94
  printf 'mock-restore-container\n'
  exit 0
fi
if [[ ${1:-} == rm ]]; then
  [[ ${2:-} == -f && ${3:-} == mock-restore-container ]] || exit 95
  : >"$MOCK_RESTORE_REMOVED"
  exit 0
fi
if [[ ${1:-} == exec ]]; then
  shift
  interactive=false
  if [[ ${1:-} == -i ]]; then interactive=true; shift; fi
  [[ ${1:-} == mock-restore-container ]] || exit 96
  shift
  case ${1:-} in
    healthcheck.sh) exit 0 ;;
    mariadb)
      shift
      if [[ "$interactive" == true ]]; then
        cat >"$MOCK_RESTORE_SQL_FILE"
        exit 0
      fi
      for argument in "$@"; do
        if [[ "$argument" == '--execute=SHOW TABLES' ]]; then
          printf 'backup_probe\nsecond_probe\n'
          exit 0
        fi
      done
      exit 97
      ;;
    *) exit 98 ;;
  esac
fi
[[ ${1:-} == compose ]] || exit 90
printf '%s\n' "$*" >>"$MOCK_DOCKER_COMPOSE_LOG"
shift
while (($#)); do
  case "$1" in
    ps)
      shift
      service=
      for argument in "$@"; do service=$argument; done
      printf 'test-container-%s\n' "$service"
      exit 0
      ;;
    exec) shift; break ;;
    *) shift ;;
  esac
done
[[ ${1:-} == -T ]] || exit 92
shift
service=${1:-}
case "$service" in
  mariadb)
    printf 'CREATE DATABASE hufstown;\nCREATE TABLE backup_probe(id INT);\nINSERT INTO backup_probe VALUES (1);\nplaintext-db-marker\n'
    ;;
  api) tar -C "$MOCK_BACKUP_ASSET_SOURCE" -cf - . ;;
  media) tar -C "$MOCK_BACKUP_RECORDING_SOURCE" -cf - . ;;
  *) exit 93 ;;
esac
MOCK_DOCKER
chmod 700 "$work_dir/mockbin/docker"

age_identity="$work_dir/age-identity"
age-keygen -o "$age_identity" >/dev/null 2>&1
age_recipient=$(age-keygen -y "$age_identity" 2>/dev/null)
export PATH="$work_dir/mockbin:$PATH"
command -v docker >/dev/null 2>&1 || { echo '모의 Docker 실행기를 준비하지 못했습니다.' >&2; exit 1; }
cat >"$work_dir/backup.env" <<EOF
TOWN_BACKUP_AGE_RECIPIENT=$age_recipient
TOWN_BACKUP_ROOT=$work_dir/backups
EOF
chmod 600 "$work_dir/backup.env"
export MOCK_BACKUP_ASSET_SOURCE="$work_dir/assets"
export MOCK_BACKUP_RECORDING_SOURCE="$work_dir/recordings"
export TOWN_BACKUP_CONFIG="$work_dir/backup.env"
export TOWN_BACKUP_LOCK_FILE="$work_dir/backup.lock"
export MOCK_DOCKER_COMPOSE_LOG="$work_dir/docker-compose.log"
unset TOWN_BACKUP_ROOT TOWN_BACKUP_AGE_RECIPIENT
export TOWN_PRODUCTION_COMPOSE_FILE="$work_dir/infra/production.compose.yaml"
export TOWN_PRODUCTION_ENV_FILE="$work_dir/infra/.env.production"
export TOWN_RESTORE_OUTPUT_ROOT="$work_dir/restores"
export MOCK_RESTORE_SQL_FILE="$work_dir/restored.sql"
export MOCK_RESTORE_RUN_ARGS="$work_dir/restore-run-args"
export MOCK_RESTORE_REMOVED="$work_dir/restore-container-removed"
: >"$MOCK_DOCKER_COMPOSE_LOG"

root_mode=$(stat -c '%a' /)
if TOWN_BACKUP_ROOT=/ bash "$script_dir/backup-production.sh" >/dev/null 2>&1; then
  echo '루트 디렉터리를 백업 경로로 사용하는 설정이 통과했습니다.' >&2
  exit 1
fi
[[ $(stat -c '%a' /) == "$root_mode" ]] || { echo '잘못된 백업 경로 검증이 루트 권한을 변경했습니다.' >&2; exit 1; }
[[ ! -s "$MOCK_DOCKER_COMPOSE_LOG" ]] || { echo '안전하지 않은 백업 경로 검증 전에 운영 Compose를 호출했습니다.' >&2; exit 1; }

unmounted_backup_path="$work_dir/unmounted-backups"
if TOWN_BACKUP_ROOT="$unmounted_backup_path" TOWN_BACKUP_REQUIRE_MOUNT=true bash "$script_dir/backup-production.sh" >/dev/null 2>&1; then
  echo '마운트되지 않은 필수 백업 저장소가 통과했습니다.' >&2
  exit 1
fi
[[ ! -e "$unmounted_backup_path" ]] || { echo '마운트되지 않은 경로에 로컬 백업 디렉터리를 만들었습니다.' >&2; exit 1; }
[[ ! -s "$MOCK_DOCKER_COMPOSE_LOG" ]] || { echo '필수 마운트 검사 전에 운영 Compose를 호출했습니다.' >&2; exit 1; }

project_backup_path=$(dirname -- "$(dirname -- "$script_dir")")/unsafe-backups
if TOWN_BACKUP_ROOT="$project_backup_path" bash "$script_dir/backup-production.sh" >/dev/null 2>&1; then
  echo '프로젝트 내부 백업 경로 설정이 통과했습니다.' >&2
  exit 1
fi
[[ ! -e "$project_backup_path" ]] || { echo '프로젝트 내부 경로 거부 전에 디렉터리가 생성됐습니다.' >&2; exit 1; }

backup_dir=$(bash "$script_dir/backup-production.sh")
bash "$script_dir/verify-production-backup.sh" "$backup_dir" >/dev/null
[[ $(stat -c '%a' "$backup_dir") == 700 ]] || { echo '백업 디렉터리 권한이 700이 아닙니다.' >&2; exit 1; }

age -d -i "$age_identity" "$backup_dir/database.sql.gz.age" | gzip -dc | grep -q 'plaintext-db-marker'
age -d -i "$age_identity" "$backup_dir/assets.tar.gz.age" | gzip -dc | tar -xO -f - ./asset.bin | grep -q 'asset-content-marker'
age -d -i "$age_identity" "$backup_dir/recordings.tar.gz.age" | gzip -dc | tar -xO -f - ./recording.webm | grep -q 'recording-content-marker'
if grep -aR -E 'plaintext-db-marker|asset-content-marker|recording-content-marker|MARIADB_ROOT_PASSWORD' "$backup_dir"; then
  echo '백업 결과에 평문 콘텐츠나 비밀 환경변수 이름이 있습니다.' >&2
  exit 1
fi

expect_verify_failure() {
  if bash "$script_dir/verify-production-backup.sh" "$backup_dir" >/dev/null 2>&1; then
    echo "$1" >&2
    exit 1
  fi
}

cp "$backup_dir/assets.tar.gz.age" "$work_dir/assets.original"
printf 'tampered' >>"$backup_dir/assets.tar.gz.age"
expect_verify_failure '변조된 백업 파일이 검증을 통과했습니다.'
mv -- "$work_dir/assets.original" "$backup_dir/assets.tar.gz.age"
printf 'unexpected' >"$backup_dir/unexpected.txt"
expect_verify_failure 'manifest 밖의 파일이 검증을 통과했습니다.'
rm -- "$backup_dir/unexpected.txt"
ln -s manifest.txt "$backup_dir/manifest-link"
expect_verify_failure '심볼릭 링크가 포함된 백업이 검증을 통과했습니다.'
rm -- "$backup_dir/manifest-link"

root_mode=$(stat -c '%a' /)
if TOWN_RESTORE_OUTPUT_ROOT=/ bash "$script_dir/restore-production-backup.sh" "$backup_dir" "$age_identity" >/dev/null 2>&1; then
  echo '루트 디렉터리를 복구 결과 경로로 사용하는 설정이 통과했습니다.' >&2
  exit 1
fi
[[ $(stat -c '%a' /) == "$root_mode" ]] || { echo '잘못된 경로 검증이 루트 권한을 변경했습니다.' >&2; exit 1; }
[[ ! -e "$MOCK_RESTORE_RUN_ARGS" ]] || { echo '안전하지 않은 경로 검증 전에 임시 데이터베이스가 시작됐습니다.' >&2; exit 1; }

restore_output=$(bash "$script_dir/restore-production-backup.sh" "$backup_dir" "$age_identity")
restore_path=${restore_output##*파일 결과 }
[[ -d "$restore_path/assets" && -d "$restore_path/recordings" ]] || { echo '복구 결과 파일 디렉터리가 없습니다.' >&2; exit 1; }
grep -q 'asset-content-marker' "$restore_path/assets/asset.bin"
grep -q 'recording-content-marker' "$restore_path/recordings/recording.webm"
grep -q 'CREATE TABLE backup_probe' "$MOCK_RESTORE_SQL_FILE"
[[ $(stat -c '%a' "$restore_path/assets/asset.bin") == 600 ]] || { echo '복구 파일 권한이 600이 아닙니다.' >&2; exit 1; }
[[ $(stat -c '%a' "$restore_path") == 700 ]] || { echo '복구 결과 디렉터리 권한이 700이 아닙니다.' >&2; exit 1; }
[[ -e "$MOCK_RESTORE_REMOVED" ]] || { echo '임시 MariaDB 컨테이너가 정리되지 않았습니다.' >&2; exit 1; }
grep -q -- '--network none' "$MOCK_RESTORE_RUN_ARGS"
if grep -Eq -- '(^| )(-p|--publish)( |$)' "$MOCK_RESTORE_RUN_ARGS"; then
  echo '격리 MariaDB에 포트가 게시됐습니다.' >&2
  exit 1
fi

retention_root="$work_dir/retention"
mkdir -m 700 "$retention_root"
for day in 24 25 26 27; do
  cp -a -- "$backup_dir" "$retention_root/hufs-town-202609${day}T030000Z-abcdef12"
done
export TOWN_BACKUP_LOCK_FILE="$work_dir/prune.lock"
prune_preview=$(bash "$script_dir/prune-production-backups.sh" --root "$retention_root" --keep 2)
[[ $(find "$retention_root" -mindepth 1 -maxdepth 1 -type d -name 'hufs-town-*' | wc -l) -eq 4 ]] || { echo '백업 정리 미리보기가 실제 디렉터리를 삭제했습니다.' >&2; exit 1; }
[[ "$prune_preview" == *'삭제 후보: hufs-town-20260924T030000Z-abcdef12'* ]] || { echo '가장 오래된 백업이 정리 후보에 없습니다.' >&2; exit 1; }
mkdir -m 700 "$retention_root/hufs-town-20260928T030000Z-abcdef12"
if bash "$script_dir/prune-production-backups.sh" --root "$retention_root" --keep 2 --apply >/dev/null 2>&1; then
  echo '유효하지 않은 백업이 있는 저장소에서 정리가 진행됐습니다.' >&2
  exit 1
fi
[[ $(find "$retention_root" -mindepth 1 -maxdepth 1 -type d -name 'hufs-town-*' | wc -l) -eq 5 ]] || { echo '검증 실패 뒤 일부 백업이 삭제됐습니다.' >&2; exit 1; }
rm -rf --one-file-system -- "$retention_root/hufs-town-20260928T030000Z-abcdef12"
bash "$script_dir/prune-production-backups.sh" --root "$retention_root" --keep 2 --apply >/dev/null
[[ $(find "$retention_root" -mindepth 1 -maxdepth 1 -type d -name 'hufs-town-*' | wc -l) -eq 2 ]] || { echo '명시적 정리가 설정한 보존 개수와 다릅니다.' >&2; exit 1; }
[[ -d "$retention_root/hufs-town-20260926T030000Z-abcdef12" && -d "$retention_root/hufs-town-20260927T030000Z-abcdef12" ]] || { echo '정리 도구가 최신 백업을 유지하지 않았습니다.' >&2; exit 1; }

mkdir -m 700 "$work_dir/unsafe-extract"
python3 - "$work_dir/path-traversal.tar.gz" <<'PY'
import io
import sys
import tarfile

with tarfile.open(sys.argv[1], "w:gz") as archive:
    data = b"must-not-escape"
    entry = tarfile.TarInfo("../escaped-marker")
    entry.size = len(data)
    archive.addfile(entry, io.BytesIO(data))
PY
mkdir -m 700 "$work_dir/limited-extract"
if age -d -i "$age_identity" "$backup_dir/assets.tar.gz.age" \
  | TOWN_RESTORE_MAX_EXTRACTED_BYTES=5 python3 -I "$script_dir/safe-extract-backup-tar.py" "$work_dir/limited-extract" >/dev/null 2>&1; then
  echo '추출 용량 제한을 넘는 tar 파일이 복구 도구를 통과했습니다.' >&2
  exit 1
fi
if python3 -I "$script_dir/safe-extract-backup-tar.py" "$work_dir/unsafe-extract" <"$work_dir/path-traversal.tar.gz" >/dev/null 2>&1; then
  echo '경로 이탈 tar 항목이 복구 도구를 통과했습니다.' >&2
  exit 1
fi
[[ ! -e "$work_dir/escaped-marker" ]] || { echo '경로 이탈 파일이 추출됐습니다.' >&2; exit 1; }

printf '격리된 백업 생성·암호화·복호화·무결성·복구 흐름 시뮬레이션 통과\n'
