#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
backend_root=$(cd -- "$script_dir/.." && pwd -P)
compose_file=${TOWN_PRODUCTION_COMPOSE_FILE:-$backend_root/infra/production.compose.yaml}
environment_file=${TOWN_PRODUCTION_ENV_FILE:-$backend_root/infra/.env.production}
state_dir=${TOWN_RELEASE_STATE_DIR:-/var/lib/hufs-town}
state_file=$state_dir/release-state
keep_count=3
apply=false
services=(web api world media)
repositories=(hufs-town-web hufs-town-api hufs-town-world hufs-town-media)

fail() { echo "$1" >&2; exit 1; }
usage() {
  cat <<'EOF'
사용법: prune-production-releases.sh [--keep <개수>] [--apply]
기본은 삭제 후보 미리보기입니다. 실제 삭제에는 --apply가 필요합니다.
현재/직전 릴리스와 실행 중인 컨테이너 이미지는 항상 보존합니다.
EOF
}

while (($#)); do
  case "$1" in
    --keep) (($# >= 2)) || fail '--keep에 보존 개수가 필요합니다.'; keep_count=$2; shift 2 ;;
    --apply) apply=true; shift ;;
    --dry-run) apply=false; shift ;;
    --help|-h) usage; exit 0 ;;
    *) usage >&2; fail "알 수 없는 옵션입니다: $1" ;;
  esac
done

[[ $(id -u) -eq 0 ]] || fail '운영 릴리스 정리는 root 권한으로 실행해야 합니다.'
[[ $keep_count =~ ^([2-9]|[1-9][0-9]{1,3})$ ]] || fail '--keep은 2부터 9999 사이의 정수여야 합니다.'
[[ -f $compose_file && ! -L $compose_file ]] || fail '운영 Compose 파일이 없거나 심볼릭 링크입니다.'
[[ -f $environment_file && ! -L $environment_file ]] || fail '운영 환경 파일이 없거나 심볼릭 링크입니다.'
[[ $(stat -c '%u:%g:%a' -- "$environment_file") == '0:0:600' ]] || fail '운영 환경 파일은 root:root 소유의 0600 권한이어야 합니다.'
[[ -d $state_dir && ! -L $state_dir ]] || fail '릴리스 상태 폴더가 없거나 심볼릭 링크입니다.'
[[ $(stat -c '%u:%g:%a' -- "$state_dir") == '0:0:700' ]] || fail '릴리스 상태 폴더는 root:root 소유의 0700 권한이어야 합니다.'
[[ -f $state_file && ! -L $state_file ]] || fail '릴리스 상태 파일이 없거나 안전한 일반 파일이 아닙니다.'
[[ $(stat -c '%u:%g:%a' -- "$state_file") == '0:0:600' ]] || fail '릴리스 상태 파일은 root:root 소유의 0600 권한이어야 합니다.'

for command_name in docker flock sort; do
  command -v "$command_name" >/dev/null 2>&1 || fail "필수 명령을 찾지 못했습니다: $command_name"
done

exec 9>"$state_dir/deploy.lock"
flock -n 9 || fail '배포 또는 롤백 중에는 릴리스 이미지를 정리할 수 없습니다.'
state_lines=()
mapfile -t state_lines <"$state_file"
[[ ${#state_lines[@]} -eq 2 ]] || fail '릴리스 상태 파일 형식이 올바르지 않습니다.'
current_release=${state_lines[0]}
previous_release=${state_lines[1]}
valid_release='^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'
[[ $current_release =~ $valid_release && $previous_release =~ $valid_release && $current_release != "$previous_release" ]] \
  || fail '현재/직전 릴리스 ID가 올바르지 않습니다.'

compose=(docker compose --project-name hufs-town --env-file "$environment_file" -f "$compose_file")
declare -A active_image_ids=()
for service in "${services[@]}"; do
  container_id=$("${compose[@]}" ps -q "$service")
  [[ -n $container_id ]] || fail "실행 중인 서비스를 확인하지 못해 정리를 중단했습니다: $service"
  image_id=$(docker inspect --format '{{.Image}}' "$container_id")
  active_image_ids["$image_id"]=1
done
for release in "$current_release" "$previous_release"; do
  for repository in "${repositories[@]}"; do
    docker image inspect "$repository:$release" >/dev/null \
      || fail "현재/직전 릴리스 이미지를 확인할 수 없어 정리를 중단했습니다: $repository:$release"
  done
done

declare -A release_seen=()
while IFS= read -r image_ref; do
  repository=${image_ref%%:*}
  tag=${image_ref#*:}
  case "$repository" in hufs-town-web|hufs-town-api|hufs-town-world|hufs-town-media) ;; *) continue ;; esac
  [[ $tag =~ ^[0-9]{8}T[0-9]{6}Z-[A-Za-z0-9][A-Za-z0-9._-]{0,63}$ || $tag =~ ^legacy-[0-9]{8}T[0-9]{6}Z$ ]] || continue
  release_seen["$tag"]=1
done < <(docker image ls --format '{{.Repository}}:{{.Tag}}')

mapfile -t releases < <(printf '%s\n' "${!release_seen[@]}" | LC_ALL=C sort -r)
declare -A keep_release=()
keep_release["$current_release"]=1
keep_release["$previous_release"]=1
kept_count=2
for release in "${releases[@]}"; do
  [[ -n ${keep_release[$release]+x} ]] && continue
  if ((kept_count < keep_count)); then
    keep_release["$release"]=1
    ((kept_count += 1))
  fi
done

declare -a removable_refs=()
declare -a removable_ids=()
for release in "${releases[@]}"; do
  [[ -n ${keep_release[$release]+x} ]] && continue
  for repository in "${repositories[@]}"; do
    image_ref="$repository:$release"
    image_id=$(docker image inspect --format '{{.Id}}' "$image_ref" 2>/dev/null) || continue
    [[ -z ${active_image_ids[$image_id]+x} ]] || continue
    removable_refs+=("$image_ref")
    removable_ids+=("$image_id")
  done
done

printf '릴리스 %s개 확인 · 최소 보존 %s개 · 모드 %s\n' \
  "${#releases[@]}" "$keep_count" "$([[ $apply == true ]] && printf '실행' || printf '미리보기')"
for index in "${!removable_refs[@]}"; do
  image_ref=${removable_refs[$index]}
  image_id=${removable_ids[$index]}
  printf '%s: %s\n' "$([[ $apply == true ]] && printf '태그 제거' || printf '제거 후보')" "$image_ref"
  if [[ $apply == true ]]; then
    current_image_id=$(docker image inspect --format '{{.Id}}' "$image_ref" 2>/dev/null) \
      || fail "삭제 직전에 이미지 태그가 바뀌었습니다: $image_ref"
    [[ $current_image_id == "$image_id" && -z ${active_image_ids[$current_image_id]+x} ]] \
      || fail "삭제 직전에 이미지가 활성 릴리스가 됐습니다: $image_ref"
    docker image rm "$image_ref" >/dev/null
  fi
done
printf '태그 정리 %s개\n' "${#removable_refs[@]}"
