#!/usr/bin/env bash
set -Eeuo pipefail

fail() {
  echo "$1" >&2
  exit 1
}

[[ $# -eq 1 ]] || fail '사용법: verify-production-backup.sh <백업 디렉터리>'
root_input=$1
[[ -d "$root_input" && ! -L "$root_input" ]] || fail '백업 경로가 없거나 심볼릭 링크입니다.'
root=$(realpath -e -- "$root_input")
[[ -f "$root/manifest.txt" && ! -L "$root/manifest.txt" ]] || fail 'manifest.txt가 없거나 심볼릭 링크입니다.'
[[ -f "$root/SHA256SUMS" && ! -L "$root/SHA256SUMS" ]] || fail 'SHA256SUMS가 없거나 심볼릭 링크입니다.'

grep -Fxq 'format_version=1' "$root/manifest.txt" || fail '지원하지 않는 백업 형식입니다.'
grep -Fxq 'encryption=age' "$root/manifest.txt" || fail '암호화 형식이 age가 아닙니다.'
grep -Fxq 'database=hufstown' "$root/manifest.txt" || fail '백업 데이터베이스가 예상과 다릅니다.'
grep -Fxq 'included=database,space-assets,room-recordings' "$root/manifest.txt" || fail '백업 포함 항목이 올바르지 않습니다.'

expected_files=(database.sql.gz.age assets.tar.gz.age recordings.tar.gz.age)
for entry in "$root"/* "$root"/.[!.]*; do
  [[ -e "$entry" ]] || continue
  [[ -f "$entry" && ! -L "$entry" ]] || fail '백업에는 일반 파일만 있어야 합니다.'
  case "$(basename -- "$entry")" in
    SHA256SUMS|manifest.txt|database.sql.gz.age|assets.tar.gz.age|recordings.tar.gz.age) ;;
    *) fail "백업에 허용되지 않은 항목이 있습니다: $(basename -- "$entry")" ;;
  esac
done

declare -A recorded_hashes=()
while IFS=' ' read -r hash filename extra; do
  [[ "$hash" =~ ^[a-f0-9]{64}$ && -n "$filename" && -z "${extra:-}" ]] || fail 'SHA256SUMS 형식이 올바르지 않습니다.'
  case "$filename" in
    database.sql.gz.age|assets.tar.gz.age|recordings.tar.gz.age) ;;
    *) fail "SHA256SUMS에 허용되지 않은 파일명이 있습니다: $filename" ;;
  esac
  [[ -z "${recorded_hashes[$filename]+present}" ]] || fail "SHA256SUMS에 중복 항목이 있습니다: $filename"
  recorded_hashes[$filename]=$hash
done <"$root/SHA256SUMS"

[[ ${#recorded_hashes[@]} -eq ${#expected_files[@]} ]] || fail 'SHA256SUMS 항목 수가 올바르지 않습니다.'
for filename in "${expected_files[@]}"; do
  file="$root/$filename"
  [[ -f "$file" && ! -L "$file" ]] || fail "백업 파일이 없거나 심볼릭 링크입니다: $filename"
  [[ $(stat -c '%s' -- "$file") -gt 0 ]] || fail "백업 파일이 비어 있습니다: $filename"
  actual_hash=$(sha256sum -- "$file")
  actual_hash=${actual_hash%% *}
  [[ "$actual_hash" == "${recorded_hashes[$filename]}" ]] || fail "SHA-256 검증에 실패했습니다: $filename"
done

printf '백업 무결성 확인 완료: %s\n' "$root"
