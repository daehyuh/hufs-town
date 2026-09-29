#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
backend_root=$(cd -- "$script_dir/.." && pwd -P)
project_root=$(cd -- "$backend_root/.." && pwd -P)
backup_root_input=''
keep_count=''
apply=false

fail() {
  echo "$1" >&2
  exit 1
}

usage() {
  cat <<'EOF'
사용법: prune-production-backups.sh --root <백업 디렉터리> --keep <개수> [--apply]
기본 동작은 삭제 후보 미리보기입니다. 실제 삭제에는 --apply가 필요합니다.
EOF
}

while (($#)); do
  case "$1" in
    --root)
      (($# >= 2)) || fail '--root에 경로가 필요합니다.'
      backup_root_input=$2
      shift 2
      ;;
    --keep)
      (($# >= 2)) || fail '--keep에 보존 개수가 필요합니다.'
      keep_count=$2
      shift 2
      ;;
    --apply)
      apply=true
      shift
      ;;
    --dry-run)
      apply=false
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *) usage >&2; fail "알 수 없는 옵션입니다: $1" ;;
  esac
done

[[ $(id -u) -eq 0 ]] || fail '운영 백업 정리는 root 권한으로 실행해야 합니다.'
[[ -n "$backup_root_input" && -n "$keep_count" ]] || { usage >&2; exit 2; }
[[ "$keep_count" =~ ^[1-9][0-9]{0,3}$ ]] || fail '--keep은 1부터 9999 사이의 정수여야 합니다.'
[[ -d "$backup_root_input" && ! -L "$backup_root_input" ]] || fail '백업 경로가 없거나 심볼릭 링크입니다.'
backup_root=$(realpath -e -- "$backup_root_input")
[[ "$backup_root" != / ]] || fail '루트 디렉터리의 내용을 정리할 수 없습니다.'
case "$backup_root/" in
  "$project_root/"*) fail '프로젝트 소스 안의 백업 경로는 정리할 수 없습니다.' ;;
esac
[[ $(stat -c '%u' -- "$backup_root") -eq 0 ]] || fail '백업 디렉터리는 root 소유여야 합니다.'
backup_mode=$(stat -c '%a' -- "$backup_root")
(( (8#$backup_mode & 0077) == 0 )) || fail '백업 디렉터리는 소유자만 접근할 수 있어야 합니다.'

for command_name in bash find sort flock; do
  command -v "$command_name" >/dev/null 2>&1 || fail "필수 명령을 찾지 못했습니다: $command_name"
done
lock_file=${TOWN_BACKUP_LOCK_FILE:-/run/lock/hufs-town-backup.lock}
mkdir -p -- "$(dirname -- "$lock_file")"
exec 9>"$lock_file"
flock -n 9 || fail '백업 또는 다른 정리 작업이 이미 실행 중입니다.'

declare -a candidates=()
declare -a verified=()
while IFS= read -r -d '' candidate; do
  candidates+=("$candidate")
done < <(find "$backup_root" -mindepth 1 -maxdepth 1 -name 'hufs-town-*' -print0 | LC_ALL=C sort -z -r)

for candidate in "${candidates[@]}"; do
  backup_name=${candidate##*/}
  [[ "$backup_name" =~ ^hufs-town-[0-9]{8}T[0-9]{6}Z-[a-f0-9]{8}$ ]] || continue
  [[ -d "$candidate" && ! -L "$candidate" ]] || fail "검증 대상이 일반 디렉터리가 아닙니다: $backup_name"
  canonical_candidate=$(realpath -e -- "$candidate")
  canonical_parent=$(realpath -e -- "$(dirname -- "$candidate")")
  [[ "$canonical_parent" == "$backup_root" && "$canonical_candidate" == "$backup_root"/* ]] || fail "백업 경로가 지정 디렉터리 밖을 가리킵니다: $backup_name"
  bash "$script_dir/verify-production-backup.sh" "$canonical_candidate" >/dev/null
  verified+=("$canonical_candidate")
done

printf '검증된 백업 %s개 · 보존 개수 %s · 모드 %s\n' "${#verified[@]}" "$keep_count" "$([[ "$apply" == true ]] && printf '실행' || printf '미리보기')"
for ((index = 0; index < ${#verified[@]}; index++)); do
  candidate=${verified[$index]}
  backup_name=${candidate##*/}
  if ((index < keep_count)); then
    printf '유지: %s\n' "$backup_name"
    continue
  fi

  printf '%s: %s\n' "$([[ "$apply" == true ]] && printf '삭제' || printf '삭제 후보')" "$backup_name"
  if [[ "$apply" == true ]]; then
    [[ -d "$candidate" && ! -L "$candidate" ]] || fail "삭제 직전에 백업 경로가 바뀌었습니다: $backup_name"
    [[ $(realpath -e -- "$(dirname -- "$candidate")") == "$backup_root" ]] || fail "삭제 경로가 지정 디렉터리 밖으로 바뀌었습니다: $backup_name"
    rm -rf --one-file-system -- "$candidate"
  fi
done
