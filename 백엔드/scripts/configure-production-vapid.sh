#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

if [[ ${EUID:-$(id -u)} -ne 0 ]]; then
  echo 'VAPID 설정 스크립트는 sudo로 실행해야 합니다.' >&2
  exit 1
fi

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
backend_root=${TOWN_PRODUCTION_ROOT:-$script_dir/..}
backend_root=$(cd -- "$backend_root" && pwd -P)
infra_dir=$backend_root/infra
compose_file=$infra_dir/production.compose.yaml
environment_file=$infra_dir/.env.production
state_dir=${TOWN_RELEASE_STATE_DIR:-/var/lib/hufs-town}
state_file=$state_dir/release-state

[[ -f $compose_file && ! -L $compose_file ]] || { echo '운영 Compose 파일을 찾을 수 없습니다.' >&2; exit 1; }
[[ -f $environment_file && ! -L $environment_file ]] || { echo '운영 환경 파일을 찾을 수 없습니다.' >&2; exit 1; }
[[ $(stat -c '%u:%g:%a' -- "$environment_file") == '0:0:600' ]] || {
  echo '운영 환경 파일은 root:root 소유의 0600 권한이어야 합니다.' >&2
  exit 1
}
[[ -f $state_file && ! -L $state_file ]] || { echo '현재 릴리스 상태 파일을 찾을 수 없습니다.' >&2; exit 1; }
[[ $(stat -c '%u:%g:%a' -- "$state_file") == '0:0:600' ]] || {
  echo '릴리스 상태 파일은 root:root 소유의 0600 권한이어야 합니다.' >&2
  exit 1
}

install -d -o root -g root -m 0700 -- "$state_dir"
exec 9>"$state_dir/deploy.lock"
flock -n 9 || { echo '다른 배포/롤백 작업이 이미 실행 중입니다.' >&2; exit 1; }

mapfile -t release_state <"$state_file"
[[ ${#release_state[@]} -eq 2 && ${release_state[0]} =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$ ]] || {
  echo '현재 릴리스 상태 파일 형식이 올바르지 않습니다.' >&2
  exit 1
}
release_id=${release_state[0]}
compose=(docker compose --project-name hufs-town --env-file "$environment_file" -f "$compose_file")
names=(TOWN_WEB_PUSH_PUBLIC_KEY TOWN_WEB_PUSH_PRIVATE_KEY TOWN_WEB_PUSH_SUBJECT)

recreate_api() {
  TOWN_RELEASE_ID="$release_id" "${compose[@]}" up -d --no-deps --force-recreate api
}

wait_for_api_health() {
  local start=$SECONDS container_id status health restart_count
  while (( SECONDS - start < 240 )); do
    container_id=$("${compose[@]}" ps -q api)
    if [[ -n $container_id ]]; then
      status=$(docker inspect --format '{{.State.Status}}' "$container_id")
      health=$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$container_id")
      restart_count=$(docker inspect --format '{{.RestartCount}}' "$container_id")
      if [[ $status == running && $health == healthy ]]; then return 0; fi
      if [[ $status == exited || $status == dead ]] || (( restart_count > 0 )); then return 1; fi
    fi
    sleep 5
  done
  return 1
}

present=0
for name in "${names[@]}"; do
  if awk -F= -v key="$name" '$1 == key && length(substr($0, index($0, "=") + 1)) > 0 { found=1 } END { exit !found }' "$environment_file"; then
    ((present += 1))
  fi
done
if (( present == ${#names[@]} )); then
  echo '운영 Web Push 키가 이미 설정되어 있습니다. 기존 키는 변경하지 않았습니다.'
  exit 0
elif (( present != 0 )); then
  echo '운영 Web Push 설정이 일부만 있어 변경하지 않았습니다. 설정을 수동 확인해야 합니다.' >&2
  exit 1
fi

temporary_dir=$(mktemp -d /run/hufs-town-vapid.XXXXXXXX)
chmod 0700 -- "$temporary_dir"
fragment=$temporary_dir/vapid.env
backup=$temporary_dir/environment.backup
cp -- "$environment_file" "$backup"
chmod 0600 -- "$backup"
configuration_changed=0

cleanup() {
  rm -f -- "$fragment" "$backup"
  rmdir -- "$temporary_dir" 2>/dev/null || true
}

rollback_after_failure() {
  local result=$?
  trap - EXIT
  if (( result != 0 && configuration_changed == 1 )); then
    echo 'API 재기동에 실패해 이전 환경 설정을 복원합니다.' >&2
    set +e
    local restore_file
    restore_file=$(mktemp "$infra_dir/.env.production.restore.XXXXXXXX")
    cat -- "$backup" >"$restore_file"
    chown root:root -- "$restore_file"
    chmod 0600 -- "$restore_file"
    mv -f -- "$restore_file" "$environment_file"
    recreate_api
    if [[ $? -ne 0 ]] || ! wait_for_api_health; then
      echo '이전 API 설정 복구를 확인하지 못했습니다. 운영 상태를 확인해야 합니다.' >&2
    else
      echo '이전 API 설정과 컨테이너를 복원했습니다.' >&2
    fi
    set -e
  fi
  cleanup
  exit "$result"
}
trap rollback_after_failure EXIT

"${compose[@]}" exec -T media node -e '
const { generateKeyPairSync } = require("node:crypto");
const pair = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const values = [
  ["TOWN_WEB_PUSH_PUBLIC_KEY", pair.publicKey.export({ type: "spki", format: "der" }).toString("base64url")],
  ["TOWN_WEB_PUSH_PRIVATE_KEY", pair.privateKey.export({ type: "pkcs8", format: "der" }).toString("base64url")],
  ["TOWN_WEB_PUSH_SUBJECT", "https://town.gdgoc.com"],
];
process.stdout.write(values.map(([key, value]) => `${key}=${value}`).join("\n") + "\n");
' >"$fragment"
chmod 0600 -- "$fragment"

python3 - "$fragment" <<'PY'
import base64
import sys

expected = {"TOWN_WEB_PUSH_PUBLIC_KEY", "TOWN_WEB_PUSH_PRIVATE_KEY", "TOWN_WEB_PUSH_SUBJECT"}
values = {}
with open(sys.argv[1], "r", encoding="utf-8") as source:
    for line in source:
        key, separator, value = line.rstrip("\n").partition("=")
        if not separator or key not in expected or key in values or not value:
            raise SystemExit("Generated Web Push settings are invalid.")
        values[key] = value
if values.keys() != expected or values["TOWN_WEB_PUSH_SUBJECT"] != "https://town.gdgoc.com":
    raise SystemExit("Generated Web Push settings are incomplete.")
for key in expected - {"TOWN_WEB_PUSH_SUBJECT"}:
    try:
        raw = values[key] + "=" * ((4 - len(values[key]) % 4) % 4)
        if len(base64.b64decode(raw, altchars=b"-_", validate=True)) < 32:
            raise ValueError
    except ValueError:
        raise SystemExit("Generated Web Push key material is invalid.") from None
PY
echo 'Web Push 키 쌍을 생성하고 형식을 확인했습니다. 키 값은 표시하지 않았습니다.'

python3 - "$environment_file" "$fragment" <<'PY'
import os
import pathlib
import sys
import tempfile

path = pathlib.Path(sys.argv[1])
names = ("TOWN_WEB_PUSH_PUBLIC_KEY", "TOWN_WEB_PUSH_PRIVATE_KEY", "TOWN_WEB_PUSH_SUBJECT")
with open(sys.argv[2], "r", encoding="utf-8") as source:
    generated = dict(line.rstrip("\n").split("=", 1) for line in source)
original = path.read_text(encoding="utf-8")
lines = original.splitlines(keepends=True)
positions = {name: [] for name in names}
for index, line in enumerate(lines):
    key, separator, value = line.rstrip("\r\n").partition("=")
    if separator and key in positions:
        positions[key].append((index, value))
for name, entries in positions.items():
    if len(entries) > 1 or any(value.strip() for _, value in entries):
        raise SystemExit("Existing Web Push settings changed during configuration; no values were written.")
for name in names:
    if positions[name]:
        index = positions[name][0][0]
        ending = "\r\n" if lines[index].endswith("\r\n") else "\n"
        lines[index] = f"{name}={generated[name]}{ending}"
    else:
        if lines and not lines[-1].endswith(("\n", "\r")):
            lines[-1] += "\n"
        lines.append(f"{name}={generated[name]}\n")
fd, temporary = tempfile.mkstemp(prefix=".env.production.vapid.", dir=path.parent)
try:
    os.fchown(fd, 0, 0)
    os.fchmod(fd, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8", newline="") as target:
        target.write("".join(lines))
        target.flush()
        os.fsync(target.fileno())
    os.replace(temporary, path)
    directory_fd = os.open(path.parent, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
    try:
        os.fsync(directory_fd)
    finally:
        os.close(directory_fd)
except BaseException:
    try:
        os.unlink(temporary)
    except FileNotFoundError:
        pass
    raise
PY
configuration_changed=1

echo '현재 릴리스의 API 컨테이너를 재기동합니다.'
recreate_api
wait_for_api_health || { echo 'API health가 240초 안에 정상화되지 않았습니다.' >&2; exit 1; }
echo 'API health가 정상입니다. 비밀값이 컨테이너에 주입됐는지 확인합니다.'
"${compose[@]}" exec -T api sh -c 'test -n "${TOWN_WEB_PUSH_PUBLIC_KEY:-}" && test -n "${TOWN_WEB_PUSH_PRIVATE_KEY:-}" && test -n "${TOWN_WEB_PUSH_SUBJECT:-}"'
curl -fsS --max-time 20 https://town.gdgoc.com/api/v1/auth/config \
  | python3 -c 'import json,sys; data=json.load(sys.stdin); sys.exit(0 if data.get("mode")=="sso" and data.get("configured") is True else 1)'

configuration_changed=0
trap - EXIT
cleanup
echo '운영 Web Push VAPID 설정 완료. 비밀값은 출력하지 않았고 API health와 환경 주입을 확인했습니다.'
