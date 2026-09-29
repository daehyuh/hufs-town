#!/usr/bin/env python3
"""Install a packaged source tree and remove only files from the prior package."""

from __future__ import annotations

import argparse
import os
import shutil
import stat
import sys
import tarfile
import tempfile
from pathlib import Path, PurePosixPath

MANIFEST_IN_ARCHIVE = "deployment-manifest.txt"
MANIFEST_IN_TARGET = ".hufs-town-source-files"
PROTECTED_PARTS = {
    ".build",
    ".cache",
    ".env",
    ".git",
    ".gradle",
    ".local",
    "build",
    "dist",
    "node_modules",
    "playwright-report",
    "target",
    "test-results",
}


class InstallError(Exception):
    pass


def fail(message: str) -> None:
    raise InstallError(message)


def normalized_path(raw: str) -> str:
    value = raw.replace("\\", "/")
    while value.startswith("./"):
        value = value[2:]
    if value.startswith("/") or (len(value) > 1 and value[1] == ":"):
        fail(f"절대 경로는 배포 파일에 넣을 수 없습니다: {raw}")
    value = value.rstrip("/")
    if not value or value == ".":
        return ""
    if "\x00" in value or "\n" in value or "\r" in value:
        fail("배포 경로에 제어 문자를 넣을 수 없습니다.")
    if len(value.encode("utf-8")) > 4096:
        fail("배포 경로가 너무 깁니다.")
    parts = value.split("/")
    if any(part in {"", ".", ".."} for part in parts):
        fail(f"안전하지 않은 배포 경로입니다: {raw}")
    if value == MANIFEST_IN_ARCHIVE:
        return value
    if value in {"백엔드", "프론트"}:
        return value
    if any(part.startswith(".env") for part in parts):
        fail(f"환경 설정 파일은 소스 배포에 넣을 수 없습니다: {raw}")
    if any(part in PROTECTED_PARTS or part.startswith(".gradle") for part in parts):
        fail(f"캐시·데이터 경로는 소스 배포에 넣을 수 없습니다: {raw}")
    if value != ".dockerignore" and not value.startswith(("백엔드/", "프론트/")):
        fail(f"배포 대상이 아닌 경로입니다: {raw}")
    return value


def safe_target(root: Path, relative: str) -> Path:
    target = root.joinpath(*PurePosixPath(relative).parts)
    current = root
    for part in PurePosixPath(relative).parts:
        current = current / part
        try:
            current.lstat()
        except FileNotFoundError:
            continue
        if stat.S_ISLNK(current.lstat().st_mode):
            fail(f"배포 경로 안의 링크는 허용하지 않습니다: {relative}")
    try:
        target.resolve(strict=False).relative_to(root)
    except ValueError:
        fail(f"배포 경로가 대상 폴더 밖을 가리킵니다: {relative}")
    except (OSError, RuntimeError) as error:
        fail(f"배포 경로를 안전하게 확인할 수 없습니다: {relative}: {error}")
    return target


def read_archive(archive_path: Path, stage: Path) -> tuple[dict[str, tarfile.TarInfo], list[str]]:
    try:
        tar = tarfile.open(archive_path, mode="r:gz")
    except (OSError, tarfile.TarError) as error:
        fail(f"소스 압축 파일을 열 수 없습니다: {error}")
    with tar:
        files: dict[str, tarfile.TarInfo] = {}
        manifest_bytes: bytes | None = None
        seen: set[str] = set()
        for member in tar.getmembers():
            relative = normalized_path(member.name)
            if not relative:
                if member.isdir():
                    continue
                fail("압축 파일 루트에는 파일을 둘 수 없습니다.")
            if relative in {"백엔드", "프론트"} and not member.isdir():
                fail(f"소스 루트에는 파일을 둘 수 없습니다: {relative}")
            if relative in seen:
                fail(f"압축 파일에 중복 경로가 있습니다: {relative}")
            seen.add(relative)
            if member.isdir():
                continue
            if not member.isfile():
                fail(f"일반 파일 외의 압축 항목은 허용하지 않습니다: {relative}")
            if relative == MANIFEST_IN_ARCHIVE:
                stream = tar.extractfile(member)
                if stream is None:
                    fail("배포 manifest를 읽을 수 없습니다.")
                manifest_bytes = stream.read(16 * 1024 * 1024 + 1)
                if len(manifest_bytes) > 16 * 1024 * 1024:
                    fail("배포 manifest가 너무 큽니다.")
                continue
            files[relative] = member
            destination = stage.joinpath(*PurePosixPath(relative).parts)
            destination.parent.mkdir(parents=True, exist_ok=True)
            stream = tar.extractfile(member)
            if stream is None:
                fail(f"압축 파일을 읽을 수 없습니다: {relative}")
            with stream, destination.open("xb") as output:
                shutil.copyfileobj(stream, output)
            destination.chmod(member.mode & 0o777 & ~0o6000)

        if manifest_bytes is None:
            fail("압축 파일에 deployment-manifest.txt가 없습니다.")
        try:
            manifest_text = manifest_bytes.decode("utf-8-sig")
        except UnicodeDecodeError:
            fail("배포 manifest가 UTF-8 형식이 아닙니다.")
        manifest: list[str] = []
        for line in manifest_text.splitlines():
            if not line:
                continue
            item = normalized_path(line)
            if item == MANIFEST_IN_ARCHIVE or item in manifest:
                fail(f"배포 manifest 항목이 중복되거나 잘못되었습니다: {line}")
            manifest.append(item)
        if set(manifest) != set(files):
            missing = sorted(set(manifest) - set(files))
            unlisted = sorted(set(files) - set(manifest))
            fail(f"배포 manifest와 압축 파일이 일치하지 않습니다: 누락={missing[:3]}, 미기록={unlisted[:3]}")
        file_set = set(files)
        for relative in file_set:
            parent = PurePosixPath(relative).parent
            while str(parent) != ".":
                if str(parent) in file_set:
                    fail(f"파일 경로가 다른 파일의 하위 경로입니다: {relative}")
                parent = parent.parent
        return files, sorted(manifest)


def read_previous_manifest(path: Path, root: Path) -> set[str]:
    if not os.path.lexists(path):
        return set()
    if stat.S_ISLNK(path.lstat().st_mode) or not stat.S_ISREG(path.lstat().st_mode):
        fail("기존 배포 manifest가 일반 파일이 아닙니다.")
    try:
        raw_manifest = path.read_bytes()
        if len(raw_manifest) > 16 * 1024 * 1024:
            fail("기존 배포 manifest가 너무 큽니다.")
        lines = raw_manifest.decode("utf-8").splitlines()
    except (OSError, UnicodeError) as error:
        fail(f"기존 배포 manifest를 읽을 수 없습니다: {error}")
    result: set[str] = set()
    for line in lines:
        item = normalized_path(line)
        if item == MANIFEST_IN_ARCHIVE or item in result:
            fail(f"기존 배포 manifest 항목이 중복되거나 잘못되었습니다: {line}")
        safe_target(root, item)
        result.add(item)
    return result


def atomic_copy(root: Path, relative: str, source: Path, target: Path, mode: int) -> None:
    target.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temp_name = tempfile.mkstemp(prefix=".hufs-town-source-", dir=target.parent)
    try:
        with os.fdopen(descriptor, "wb") as output, source.open("rb") as input_file:
            shutil.copyfileobj(input_file, output)
        os.chmod(temp_name, mode & 0o777 & ~0o6000)
        safe_target(root, relative)
        os.replace(temp_name, target)
    except BaseException:
        try:
            os.unlink(temp_name)
        except FileNotFoundError:
            pass
        raise


def install(archive_path: Path, root: Path) -> tuple[int, int]:
    if not archive_path.is_file() or archive_path.is_symlink():
        fail("소스 압축 파일이 없거나 일반 파일이 아닙니다.")
    if root.exists() and (root.is_symlink() or not root.is_dir()):
        fail("대상 프로젝트 경로는 일반 디렉터리여야 합니다.")
    root.mkdir(parents=True, exist_ok=True)
    root = root.resolve(strict=True)
    manifest_path = root / MANIFEST_IN_TARGET
    safe_target(root, MANIFEST_IN_TARGET)
    old_files = read_previous_manifest(manifest_path, root)

    with tempfile.TemporaryDirectory(prefix="hufs-town-source-install-") as temporary:
        stage = Path(temporary)
        files, new_files = read_archive(archive_path, stage)
        targets: dict[str, Path] = {}
        for relative in new_files:
            target = safe_target(root, relative)
            targets[relative] = target
            try:
                target_mode = target.lstat().st_mode
            except FileNotFoundError:
                continue
            if stat.S_ISLNK(target_mode) or not stat.S_ISREG(target_mode):
                fail(f"새 배포 파일 경로에 일반 파일이 아닌 항목이 있습니다: {relative}")

        removals: list[Path] = []
        for relative in sorted(old_files - set(new_files)):
            target = safe_target(root, relative)
            try:
                target_mode = target.lstat().st_mode
            except FileNotFoundError:
                continue
            if stat.S_ISLNK(target_mode) or not stat.S_ISREG(target_mode):
                fail(f"기존 배포 파일이 일반 파일이 아니어서 제거하지 않았습니다: {relative}")
            removals.append(target)

        for relative in new_files:
            source = stage.joinpath(*PurePosixPath(relative).parts)
            atomic_copy(root, relative, source, targets[relative], files[relative].mode)

        removed = 0
        for target in removals:
            target.unlink()
            removed += 1

        manifest_temp = root / f".{MANIFEST_IN_TARGET}.tmp"
        if os.path.lexists(manifest_temp):
            if manifest_temp.is_dir() and not manifest_temp.is_symlink():
                fail("manifest 임시 경로가 디렉터리입니다.")
            manifest_temp.unlink()
        with manifest_temp.open("x", encoding="utf-8", newline="\n") as output:
            output.write("\n".join(new_files) + "\n")
            output.flush()
            os.fsync(output.fileno())
        manifest_temp.chmod(0o644)
        safe_target(root, MANIFEST_IN_TARGET)
        os.replace(manifest_temp, manifest_path)
        return len(new_files), removed


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("archive", type=Path)
    parser.add_argument("--root", type=Path, default=Path("/opt/hufs-town"))
    args = parser.parse_args()
    try:
        installed, removed = install(args.archive, args.root)
    except (InstallError, OSError, tarfile.TarError) as error:
        print(f"소스 배포 실패: {error}", file=sys.stderr)
        return 1
    print(f"설치 파일 {installed}개, 이전 배포에서 삭제된 소스 {removed}개")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
