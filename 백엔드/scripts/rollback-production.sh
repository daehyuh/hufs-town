#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

if [[ ${EUID:-$(id -u)} -ne 0 ]]; then
  echo '운영 롤백 스크립트는 sudo로 실행해야 합니다.' >&2
  exit 1
fi

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
backend_root=$(cd -- "$script_dir/.." && pwd -P)
compose_file=${TOWN_PRODUCTION_COMPOSE_FILE:-$backend_root/infra/production.compose.yaml}
environment_file=${TOWN_PRODUCTION_ENV_FILE:-$backend_root/infra/.env.production}
state_dir=${TOWN_RELEASE_STATE_DIR:-/var/lib/hufs-town}
state_file=$state_dir/release-state
services=(web api world media)

[[ -f $compose_file && ! -L $compose_file ]] || { echo '운영 Compose 파일을 찾을 수 없거나 안전한 일반 파일이 아닙니다.' >&2; exit 1; }
[[ -f $environment_file && ! -L $environment_file ]] || { echo '운영 환경 파일을 찾을 수 없거나 안전한 일반 파일이 아닙니다.' >&2; exit 1; }
[[ $(stat -c '%u:%g:%a' -- "$environment_file") == '0:0:600' ]] || {
  echo '운영 환경 파일은 root:root 소유의 0600 권한이어야 합니다.' >&2
  exit 1
}
[[ -d $state_dir && ! -L $state_dir ]] || { echo '릴리스 상태 폴더를 찾을 수 없거나 안전하지 않습니다.' >&2; exit 1; }
exec 9>"$state_dir/deploy.lock"
flock -n 9 || { echo '다른 배포/롤백 작업이 이미 실행 중입니다.' >&2; exit 1; }
[[ -f $state_file && ! -L $state_file ]] || { echo '릴리스 상태 파일을 찾을 수 없습니다.' >&2; exit 1; }
[[ $(stat -c '%u:%g:%a' -- "$state_file") == '0:0:600' ]] || {
  echo '릴리스 상태 파일은 root:root 소유의 0600 권한이어야 합니다.' >&2
  exit 1
}

compose=(docker compose --project-name hufs-town --env-file "$environment_file" -f "$compose_file")
valid_release() {
  [[ $1 =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$ ]]
}
write_state() {
  local current=$1 previous=$2 temporary
  temporary=$(mktemp "$state_dir/.release-state.XXXXXXXX")
  printf '%s\n%s\n' "$current" "$previous" >"$temporary"
  chmod 0600 "$temporary"
  mv -f -- "$temporary" "$state_file"
}
check_public_service() {
  curl -fsS --max-time 20 https://town.gdgoc.com/ >/dev/null || return 1
  curl -fsS --max-time 20 https://town.gdgoc.com/api/v1/auth/config \
    | python3 -c 'import json,sys; data=json.load(sys.stdin); sys.exit(0 if data.get("mode")=="sso" and data.get("configured") is True else 1)' \
    || return 1
  curl -fsS --max-time 20 https://town.gdgoc.com/api/v1/bootstrap \
    | python3 -c 'import json,sys; data=json.load(sys.stdin); space=data.get("space",{}); features=data.get("features",{}); sys.exit(0 if space.get("capacity")==100 and features.get("media") is True else 1)' \
    || return 1
}

state_lines=()
mapfile -t state_lines <"$state_file"
[[ ${#state_lines[@]} -eq 2 ]] || { echo '릴리스 상태 파일 형식이 올바르지 않습니다.' >&2; exit 1; }
current_release=${state_lines[0]}
target_release=${state_lines[1]}
valid_release "$current_release" && valid_release "$target_release" || {
  echo '현재/이전 릴리스 ID가 올바르지 않습니다.' >&2
  exit 1
}
[[ $current_release != "$target_release" ]] || { echo '현재 버전 이외의 보존된 릴리스가 없습니다.' >&2; exit 1; }

for service in "${services[@]}"; do
  docker image inspect "hufs-town-$service:$target_release" >/dev/null || {
    echo "복구 대상 릴리스 이미지가 없어 중단했습니다: $service" >&2
    exit 1
  }
done

TOWN_RELEASE_ID="$target_release" "${compose[@]}" up -d --wait --wait-timeout 240
nginx -t
systemctl reload nginx
check_public_service
for service in "${services[@]}"; do
  docker image tag "hufs-town-$service:$target_release" "hufs-town-$service:latest"
done
write_state "$target_release" "$current_release"
echo "운영 롤백 완료: $target_release (되돌릴 수 있는 릴리스: $current_release)"
