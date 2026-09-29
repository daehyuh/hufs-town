#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
backend_root=$(cd -- "$script_dir/.." && pwd -P)
project_root=$(cd -- "$backend_root/.." && pwd -P)
compose_file=${TOWN_PRODUCTION_COMPOSE_FILE:-$backend_root/infra/production.compose.yaml}
environment_file=${TOWN_PRODUCTION_ENV_FILE:-$backend_root/infra/.env.production}
compose_project=${TOWN_PRODUCTION_COMPOSE_PROJECT:-hufs-town}
config_file=${TOWN_BACKUP_CONFIG:-/etc/hufs-town/backup.env}

if [[ -f "$config_file" ]]; then
  [[ ! -L "$config_file" ]] || { echo '백업 설정 파일은 심볼릭 링크일 수 없습니다.' >&2; exit 1; }
  config_mode=$(stat -c '%a' -- "$config_file")
  (( (8#$config_mode & 0022) == 0 )) || { echo '백업 설정 파일은 그룹/일반 사용자가 수정할 수 없어야 합니다.' >&2; exit 1; }
  while IFS='=' read -r config_key config_value config_extra || [[ -n "${config_key:-}" ]]; do
    config_value=${config_value%$'\r'}
    [[ -z "${config_key:-}" || "$config_key" == \#* ]] && continue
    [[ -n "${config_value:-}" && -z "${config_extra:-}" ]] || { echo '백업 설정 줄 형식이 올바르지 않습니다.' >&2; exit 1; }
    case "$config_key" in
      TOWN_BACKUP_AGE_RECIPIENT)
        [[ -n "${TOWN_BACKUP_AGE_RECIPIENT:-}" ]] || TOWN_BACKUP_AGE_RECIPIENT=$config_value
        ;;
      TOWN_BACKUP_ROOT)
        [[ -n "${TOWN_BACKUP_ROOT:-}" ]] || TOWN_BACKUP_ROOT=$config_value
        ;;
      TOWN_BACKUP_REQUIRE_MOUNT)
        [[ -n "${TOWN_BACKUP_REQUIRE_MOUNT:-}" ]] || TOWN_BACKUP_REQUIRE_MOUNT=$config_value
        ;;
      *) echo "허용되지 않은 백업 설정 항목입니다: $config_key" >&2; exit 1 ;;
    esac
  done <"$config_file"
fi

backup_root=${TOWN_BACKUP_ROOT:-/var/backups/hufs-town}
age_recipient=${TOWN_BACKUP_AGE_RECIPIENT:-}
require_backup_mount=${TOWN_BACKUP_REQUIRE_MOUNT:-false}
lock_file=${TOWN_BACKUP_LOCK_FILE:-/run/lock/hufs-town-backup.lock}

fail() {
  echo "$1" >&2
  exit 1
}

[[ $(id -u) -eq 0 ]] || fail '운영 백업은 root 권한으로 실행해야 합니다.'

for command_name in docker age gzip sha256sum stat realpath flock openssl; do
  command -v "$command_name" >/dev/null 2>&1 || fail "필수 명령을 찾지 못했습니다: $command_name"
done

[[ -f "$compose_file" && ! -L "$compose_file" ]] || fail '운영 Compose 파일이 없거나 심볼릭 링크입니다.'
[[ -f "$environment_file" && ! -L "$environment_file" ]] || fail '운영 환경 파일이 없거나 심볼릭 링크입니다.'
[[ "$age_recipient" == age1* ]] || fail 'TOWN_BACKUP_AGE_RECIPIENT에 age 공개 수신자(age1...)를 설정해야 합니다.'

mkdir -p -- "$(dirname -- "$lock_file")"
exec 9>"$lock_file"
flock -n 9 || fail '다른 백업 작업이 이미 실행 중입니다.'

[[ ! -L "$backup_root" ]] || fail '백업 경로는 심볼릭 링크일 수 없습니다.'
backup_root=$(realpath -m -- "$backup_root")
[[ "$backup_root" != / ]] || fail '루트 디렉터리를 백업 경로로 사용할 수 없습니다.'
case "$backup_root/" in
  "$project_root/"*) fail '백업 디렉터리는 프로젝트 소스·Compose 디렉터리 밖이어야 합니다.' ;;
esac
[[ "$require_backup_mount" == true || "$require_backup_mount" == false ]] || fail 'TOWN_BACKUP_REQUIRE_MOUNT 값은 true 또는 false여야 합니다.'
if [[ "$require_backup_mount" == true ]]; then
  command -v mountpoint >/dev/null 2>&1 || fail '필수 명령을 찾지 못했습니다: mountpoint'
  mountpoint -q "$backup_root" || fail '백업 저장소가 마운트되지 않았습니다. 원격 저장소를 연결한 뒤 다시 실행하세요.'
fi
if [[ -e "$backup_root" ]]; then
  [[ -d "$backup_root" && ! -L "$backup_root" ]] || fail '백업 경로는 일반 디렉터리여야 합니다.'
else
  mkdir -p -- "$backup_root"
fi
backup_root=$(realpath -e -- "$backup_root")
[[ $(stat -c '%u' -- "$backup_root") -eq 0 ]] || fail '백업 디렉터리는 root 소유여야 합니다.'
backup_mode=$(stat -c '%a' -- "$backup_root")
(( (8#$backup_mode & 0077) == 0 )) || fail '백업 디렉터리는 소유자만 접근할 수 있어야 합니다.'

compose=(docker compose --project-name "$compose_project" --env-file "$environment_file" -f "$compose_file")
for service in mariadb api media; do
  container_id=$("${compose[@]}" ps --status running -q "$service")
  [[ -n "$container_id" && "$container_id" != *$'\n'* ]] || fail "$service 컨테이너가 하나 실행 중이어야 합니다."
  state=$(docker inspect --format '{{.State.Status}}|{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$container_id")
  IFS='|' read -r container_status health_status <<<"$state"
  [[ "$container_status" == running ]] || fail "$service 컨테이너가 실행 중이 아닙니다."
  [[ "$health_status" == healthy || "$health_status" == none ]] || fail "$service 컨테이너 상태가 정상이지 않습니다."
done

created_at=$(date -u +%Y%m%dT%H%M%SZ)
suffix=$(openssl rand -hex 4)
backup_name="hufs-town-$created_at-$suffix"
partial_dir="$backup_root/.partial-$backup_name"
final_dir="$backup_root/$backup_name"
[[ ! -e "$partial_dir" && ! -e "$final_dir" ]] || fail '같은 이름의 백업 경로가 이미 있습니다.'
mkdir -m 700 -- "$partial_dir"

cleanup() {
  result=$?
  if [[ -n "${partial_dir:-}" && "$partial_dir" == "$backup_root"/.partial-hufs-town-* && -d "$partial_dir" && ! -L "$partial_dir" ]]; then
    rm -rf --one-file-system -- "$partial_dir"
  fi
  exit "$result"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# The container must expand its own injected password and database variables.
# shellcheck disable=SC2016
"${compose[@]}" exec -T mariadb sh -c \
  'MYSQL_PWD="$MARIADB_ROOT_PASSWORD" exec mariadb-dump --user=root --single-transaction --routines --events --triggers --hex-blob --default-character-set=utf8mb4 --databases "$MARIADB_DATABASE"' \
  | gzip -1 \
  | age -r "$age_recipient" -o "$partial_dir/database.sql.gz.age"

"${compose[@]}" exec -T api sh -c 'exec tar -C /data/assets -cf - .' \
  | gzip -1 \
  | age -r "$age_recipient" -o "$partial_dir/assets.tar.gz.age"

"${compose[@]}" exec -T media sh -c 'exec tar -C /data/recordings -cf - .' \
  | gzip -1 \
  | age -r "$age_recipient" -o "$partial_dir/recordings.tar.gz.age"

cat >"$partial_dir/manifest.txt" <<EOF
format_version=1
created_at_utc=$created_at
encryption=age
database=hufstown
included=database,space-assets,room-recordings
excluded=redis-runtime-state,environment-secrets,prometheus-time-series
consistency=sequential-non-atomic
EOF

(
  cd -- "$partial_dir"
  sha256sum -- database.sql.gz.age assets.tar.gz.age recordings.tar.gz.age >SHA256SUMS
)
bash "$script_dir/verify-production-backup.sh" "$partial_dir" >/dev/null
mv -T -- "$partial_dir" "$final_dir"
partial_dir=''
printf '%s\n' "$final_dir"
