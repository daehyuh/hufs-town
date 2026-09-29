#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
backend_root=$(cd -- "$script_dir/.." && pwd -P)
project_root=$(cd -- "$backend_root/.." && pwd -P)
output_root=${TOWN_RESTORE_OUTPUT_ROOT:-/var/tmp/hufs-town-restores}
database_memory=${TOWN_RESTORE_DB_MEMORY:-2g}
database_cpus=${TOWN_RESTORE_DB_CPUS:-1}
database_tmpfs=${TOWN_RESTORE_DB_TMPFS_SIZE:-1536m}
container_id=''
partial_dir=''

fail() {
  echo "$1" >&2
  exit 1
}

[[ $(id -u) -eq 0 ]] || fail '격리 복구 검증은 root 권한으로 실행해야 합니다.'
[[ $# -eq 2 ]] || fail '사용법: restore-production-backup.sh <암호화 백업 디렉터리> <age 개인 키 파일>'

backup_input=$1
identity_input=$2
[[ -d "$backup_input" && ! -L "$backup_input" ]] || fail '백업 디렉터리가 없거나 심볼릭 링크입니다.'
[[ -f "$identity_input" && ! -L "$identity_input" ]] || fail 'age 개인 키 파일이 없거나 심볼릭 링크입니다.'
backup_dir=$(realpath -e -- "$backup_input")
identity_file=$(realpath -e -- "$identity_input")
identity_mode=$(stat -c '%a' -- "$identity_file")
(( (8#$identity_mode & 0077) == 0 )) || fail 'age 개인 키 파일은 소유자만 읽을 수 있어야 합니다.'

for command_name in docker age gzip python3 stat realpath openssl awk; do
  command -v "$command_name" >/dev/null 2>&1 || fail "필수 명령을 찾지 못했습니다: $command_name"
done
[[ "$database_memory" =~ ^[1-9][0-9]*[mMgG]$ ]] || fail 'TOWN_RESTORE_DB_MEMORY 값이 올바르지 않습니다.'
[[ "$database_tmpfs" =~ ^[1-9][0-9]*[mMgG]$ ]] || fail 'TOWN_RESTORE_DB_TMPFS_SIZE 값이 올바르지 않습니다.'
[[ "$database_cpus" =~ ^[0-9]+([.][0-9]+)?$ ]] || fail 'TOWN_RESTORE_DB_CPUS 값이 올바르지 않습니다.'

bash "$script_dir/verify-production-backup.sh" "$backup_dir" >/dev/null
[[ ! -L "$output_root" ]] || fail '복구 결과 경로는 심볼릭 링크일 수 없습니다.'
output_root=$(realpath -m -- "$output_root")
[[ "$output_root" != / ]] || fail '루트 디렉터리를 복구 결과 경로로 사용할 수 없습니다.'
case "$output_root/" in
  "$project_root/"*) fail '복구 결과 디렉터리는 운영 프로젝트 밖이어야 합니다.' ;;
esac
case "$backup_dir/" in
  "$output_root/"*) fail '복구 결과 디렉터리와 백업 디렉터리는 겹치면 안 됩니다.' ;;
esac
case "$output_root/" in
  "$backup_dir/"*) fail '복구 결과 디렉터리와 백업 디렉터리는 겹치면 안 됩니다.' ;;
esac
case "$identity_file" in
  "$output_root"/*|"$backup_dir"/*) fail '개인 키는 복구 결과나 백업 폴더 안에 둘 수 없습니다.' ;;
esac

if [[ -e "$output_root" ]]; then
  [[ -d "$output_root" && ! -L "$output_root" ]] || fail '복구 결과 경로는 일반 디렉터리여야 합니다.'
else
  mkdir -p -- "$output_root"
fi
output_root=$(realpath -e -- "$output_root")
[[ $(stat -c '%u' -- "$output_root") -eq 0 ]] || fail '복구 결과 디렉터리는 root 소유여야 합니다.'
output_mode=$(stat -c '%a' -- "$output_root")
(( (8#$output_mode & 0077) == 0 )) || fail '복구 결과 디렉터리는 소유자만 접근할 수 있어야 합니다.'

restore_stamp=$(date -u +%Y%m%dT%H%M%SZ)
restore_suffix=$(openssl rand -hex 4)
restore_name="hufs-town-restore-$restore_stamp-$restore_suffix"
partial_dir="$output_root/.partial-$restore_name"
final_dir="$output_root/$restore_name"
container_name="hufs-town-restore-$restore_stamp-$restore_suffix"
[[ ! -e "$partial_dir" && ! -e "$final_dir" ]] || fail '같은 이름의 복구 경로가 이미 있습니다.'
mkdir -m 700 -- "$partial_dir"
mkdir -m 700 -- "$partial_dir/assets" "$partial_dir/recordings"

cleanup() {
  result=$?
  if [[ -n "$container_id" ]]; then docker rm -f "$container_id" >/dev/null 2>&1 || true; fi
  if [[ -n "$partial_dir" && "$partial_dir" == "$output_root"/.partial-hufs-town-restore-* && -d "$partial_dir" && ! -L "$partial_dir" ]]; then
    rm -rf --one-file-system -- "$partial_dir"
  fi
  exit "$result"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

container_id=$(docker run -d \
  --pull=never \
  --name "$container_name" \
  --network none \
  --cpus="$database_cpus" \
  --memory="$database_memory" \
  --tmpfs "/var/lib/mysql:rw,noexec,nosuid,size=$database_tmpfs" \
  --env MARIADB_ALLOW_EMPTY_ROOT_PASSWORD=1 \
  --env MARIADB_DATABASE=hufstown \
  mariadb:11.4.10)
[[ -n "$container_id" ]] || fail '격리 MariaDB를 시작하지 못했습니다.'

database_ready=false
for ((attempt = 0; attempt < 120; attempt++)); do
  if docker exec "$container_id" healthcheck.sh --connect --innodb_initialized >/dev/null 2>&1; then
    database_ready=true
    break
  fi
  sleep 1
done
[[ "$database_ready" == true ]] || fail '격리 MariaDB가 제한 시간 안에 준비되지 않았습니다.'

age -d -i "$identity_file" "$backup_dir/database.sql.gz.age" \
  | gzip -dc \
  | docker exec -i "$container_id" mariadb --user=root

table_count=$(docker exec "$container_id" mariadb --user=root --batch --skip-column-names --database=hufstown --execute='SHOW TABLES' | awk 'END { print NR + 0 }')
[[ "$table_count" =~ ^[0-9]+$ && "$table_count" -gt 0 ]] || fail '복구된 데이터베이스에 테이블이 없습니다.'

asset_summary=$(age -d -i "$identity_file" "$backup_dir/assets.tar.gz.age" \
  | python3 -I "$script_dir/safe-extract-backup-tar.py" "$partial_dir/assets")
recording_summary=$(age -d -i "$identity_file" "$backup_dir/recordings.tar.gz.age" \
  | python3 -I "$script_dir/safe-extract-backup-tar.py" "$partial_dir/recordings")

mv -T -- "$partial_dir" "$final_dir"
partial_dir=''
docker rm -f "$container_id" >/dev/null
container_id=''
printf '격리 복구 검증 완료: DB 테이블 %s개, 에셋 %s, 녹화 %s, 파일 결과 %s\n' \
  "$table_count" "$asset_summary" "$recording_summary" "$final_dir"
