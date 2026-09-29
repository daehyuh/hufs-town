#!/usr/bin/env python3
"""Extract a backup tar stream into a new private directory without links."""

from __future__ import annotations

import os
import re
import sys
import tarfile
from pathlib import Path, PurePosixPath


def positive_limit(name: str, default: int) -> int:
    raw = os.environ.get(name, str(default))
    if not raw.isdecimal() or int(raw) <= 0:
        raise ValueError
    return int(raw)


def fail() -> None:
    print("백업 압축 파일에 안전하지 않거나 지원하지 않는 항목이 있습니다.", file=sys.stderr)
    raise SystemExit(1)


def main() -> int:
    if len(sys.argv) != 2:
        print("사용법: safe-extract-backup-tar.py <새 추출 디렉터리>", file=sys.stderr)
        return 2

    destination = Path(sys.argv[1])
    if destination.is_symlink() or not destination.is_dir():
        print("추출 대상은 이미 만들어진 일반 디렉터리여야 합니다.", file=sys.stderr)
        return 2
    destination = destination.resolve(strict=True)
    maximum_bytes = positive_limit("TOWN_RESTORE_MAX_EXTRACTED_BYTES", 214748364800)
    maximum_entries = positive_limit("TOWN_RESTORE_MAX_ARCHIVE_ENTRIES", 2000000)

    seen: dict[str, str] = {}
    extracted_files = 0
    extracted_bytes = 0
    entry_count = 0

    try:
        archive = tarfile.open(fileobj=sys.stdin.buffer, mode="r|gz")
        with archive:
            for member in archive:
                entry_count += 1
                if entry_count > maximum_entries:
                    fail()
                name = member.name
                if not name or "\x00" in name or "\\" in name or name.startswith("/"):
                    fail()
                raw_path = PurePosixPath(name)
                parts = tuple(part for part in raw_path.parts if part not in ("", "."))
                if any(part == ".." for part in parts) or (
                    parts and re.match(r"^[A-Za-z]:", parts[0])
                ):
                    fail()

                if member.isdir():
                    if not parts:
                        continue
                    relative = PurePosixPath(*parts).as_posix()
                    if seen.get(relative) == "file":
                        fail()
                    if relative in seen:
                        continue
                    target = destination
                    for part in parts:
                        target = target / part
                        try:
                            target.mkdir(mode=0o700)
                        except FileExistsError:
                            if target.is_symlink() or not target.is_dir():
                                fail()
                    seen[relative] = "directory"
                    continue

                if not member.isfile() or not parts or member.size < 0:
                    fail()
                if extracted_bytes + member.size > maximum_bytes:
                    fail()
                relative = PurePosixPath(*parts).as_posix()
                if relative in seen:
                    fail()

                parent = destination
                for part in parts[:-1]:
                    parent = parent / part
                    try:
                        parent.mkdir(mode=0o700)
                    except FileExistsError:
                        if parent.is_symlink() or not parent.is_dir():
                            fail()
                target = parent / parts[-1]
                flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
                if hasattr(os, "O_NOFOLLOW"):
                    flags |= os.O_NOFOLLOW
                descriptor = os.open(target, flags, 0o600)
                source = archive.extractfile(member)
                if source is None:
                    os.close(descriptor)
                    fail()
                remaining = member.size
                with os.fdopen(descriptor, "wb") as output, source:
                    while remaining:
                        chunk = source.read(min(1024 * 1024, remaining))
                        if not chunk:
                            fail()
                        output.write(chunk)
                        remaining -= len(chunk)
                seen[relative] = "file"
                extracted_files += 1
                extracted_bytes += member.size
    except (OSError, tarfile.TarError, ValueError):
        fail()

    print(f"파일 {extracted_files}개, {extracted_bytes} bytes")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
