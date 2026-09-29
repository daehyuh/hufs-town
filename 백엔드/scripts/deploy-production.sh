#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

if [[ ${EUID:-$(id -u)} -ne 0 ]]; then
  echo '운영 배포 스크립트는 sudo로 실행해야 합니다.' >&2
  exit 1
fi

release_id=${1:-}
if [[ ! $release_id =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$ ]]; then
  echo '사용법: sudo bash deploy-production.sh <고유한-릴리스-ID>' >&2
  exit 2
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
[[ ! -L $state_dir ]] || { echo '릴리스 상태 폴더는 심볼릭 링크일 수 없습니다.' >&2; exit 1; }
install -d -o root -g root -m 0700 -- "$state_dir"
exec 9>"$state_dir/deploy.lock"
flock -n 9 || { echo '다른 배포/롤백 작업이 이미 실행 중입니다.' >&2; exit 1; }
[[ ! -e $state_file || ( -f $state_file && ! -L $state_file ) ]] || {
  echo '릴리스 상태 파일은 일반 파일이어야 합니다.' >&2
  exit 1
}
if [[ -e $state_file ]]; then
  [[ $(stat -c '%u:%g:%a' -- "$state_file") == '0:0:600' ]] || {
    echo '릴리스 상태 파일은 root:root 소유의 0600 권한이어야 합니다.' >&2
    exit 1
  }
fi

compose=(docker compose --project-name hufs-town --env-file "$environment_file" -f "$compose_file")
compose_release() {
  local selected_release=$1
  shift
  TOWN_RELEASE_ID="$selected_release" "${compose[@]}" "$@"
}
compose_build_release() {
  local selected_release=$1
  shift
  TOWN_RELEASE_ID="$selected_release" TOWN_SKIP_BUILD_TESTS=true "${compose[@]}" "$@"
}
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
restore_release() {
  local selected_release=$1 service
  compose_release "$selected_release" up -d --wait --wait-timeout 240 || return 1
  for service in "${services[@]}"; do
    docker image tag "hufs-town-$service:$selected_release" "hufs-town-$service:latest" || return 1
  done
  nginx -t || return 1
  systemctl reload nginx || return 1
  check_public_service || return 1
}

if [[ -e $state_file ]]; then
  state_lines=()
  mapfile -t state_lines <"$state_file"
  [[ ${#state_lines[@]} -eq 2 ]] || { echo '릴리스 상태 파일 형식이 올바르지 않습니다.' >&2; exit 1; }
  current_release=${state_lines[0]}
  previous_release=${state_lines[1]}
  valid_release "$current_release" || { echo '현재 릴리스 ID가 올바르지 않습니다.' >&2; exit 1; }
  [[ -z $previous_release ]] || valid_release "$previous_release" || { echo '이전 릴리스 ID가 올바르지 않습니다.' >&2; exit 1; }
  if [[ -n $previous_release ]]; then
    for service in "${services[@]}"; do
      docker image inspect "hufs-town-$service:$previous_release" >/dev/null || {
        echo "직전 릴리스 이미지가 없어 현재 상태를 보장할 수 없습니다: $service" >&2
        exit 1
      }
    done
  fi
  for service in "${services[@]}"; do
    docker image inspect "hufs-town-$service:$current_release" >/dev/null || {
      echo "현재 릴리스 이미지가 없어 배포를 중단했습니다: $service" >&2
      exit 1
    }
  done
else
  current_release="legacy-$(date -u +%Y%m%dT%H%M%SZ)"
  previous_release=''
  for service in "${services[@]}"; do
    container_id=$("${compose[@]}" ps -q "$service")
    [[ -n $container_id ]] || { echo "기존 서비스가 실행 중이 아니어서 기준 릴리스를 만들 수 없습니다: $service" >&2; exit 1; }
    image_id=$(docker inspect --format '{{.Image}}' "$container_id")
    docker image tag "$image_id" "hufs-town-$service:$current_release"
  done
  write_state "$current_release" ''
fi

previous_release=$current_release
for service in "${services[@]}"; do
  if docker image inspect "hufs-town-$service:$release_id" >/dev/null 2>&1; then
    echo "이 릴리스 ID의 이미지가 이미 있어 덮어쓰지 않았습니다: $release_id" >&2
    exit 1
  fi
done

for service in "${services[@]}"; do
  echo "Building $service for release $release_id"
  compose_build_release "$release_id" build "$service"
done

up_started=0
rollback_on_failure() {
  local result=$?
  trap - EXIT
  if (( result != 0 && up_started == 1 )); then
    echo "배포 확인에 실패해 이전 릴리스로 복구합니다: $previous_release" >&2
    if restore_release "$previous_release"; then
      echo '이전 애플리케이션 릴리스로 복구했습니다.' >&2
    else
      echo '자동 복구도 완료되지 않았습니다. 운영 상태를 즉시 확인해야 합니다.' >&2
    fi
  fi
  exit "$result"
}
trap rollback_on_failure EXIT

up_started=1
compose_release "$release_id" up -d --wait --wait-timeout 240
nginx -t
systemctl reload nginx
check_public_service
for service in "${services[@]}"; do
  docker image tag "hufs-town-$service:$release_id" "hufs-town-$service:latest"
done
write_state "$release_id" "$previous_release"
up_started=0
trap - EXIT
echo "운영 배포 완료: $release_id (직전 릴리스: $previous_release)"
