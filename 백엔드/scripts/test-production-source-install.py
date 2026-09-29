#!/usr/bin/env python3
"""Regression checks for the production source installer using temporary trees."""

from __future__ import annotations

import importlib.util
import io
import tarfile
import tempfile
import unittest
from pathlib import Path


SCRIPT = Path(__file__).with_name("install-production-source.py")
SPEC = importlib.util.spec_from_file_location("production_source_installer", SCRIPT)
assert SPEC and SPEC.loader
installer = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(installer)


def make_archive(path: Path, files: dict[str, bytes], extra: list[tarfile.TarInfo] | None = None) -> None:
    with tarfile.open(path, "w:gz", format=tarfile.PAX_FORMAT) as archive:
        root = tarfile.TarInfo("./")
        root.type = tarfile.DIRTYPE
        archive.addfile(root)
        directories: set[str] = set()
        for filename in files:
            parent = Path(filename).parent
            while str(parent) != ".":
                directories.add(parent.as_posix() + "/")
                parent = parent.parent
        for dirname in sorted(directories):
            info = tarfile.TarInfo("./" + dirname)
            info.type = tarfile.DIRTYPE
            archive.addfile(info)
        for filename, data in files.items():
            info = tarfile.TarInfo("./" + filename)
            info.size = len(data)
            archive.addfile(info, io.BytesIO(data))
        manifest = "".join(f"{name}\n" for name in sorted(files)).encode("utf-8")
        info = tarfile.TarInfo("./deployment-manifest.txt")
        info.size = len(manifest)
        archive.addfile(info, io.BytesIO(manifest))
        for member in extra or []:
            archive.addfile(member)


class ProductionSourceInstallerTest(unittest.TestCase):
    def test_update_removes_old_managed_source_and_preserves_local_data(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            root = base / "application"
            root.mkdir()
            protected = root / "백엔드/infra/.env.production"
            protected.parent.mkdir(parents=True)
            protected.write_text("operator secret stays untouched", encoding="utf-8")
            local_note = root / "백엔드/infra/operator-note.txt"
            local_note.write_text("operator data", encoding="utf-8")
            generated = root / "백엔드/build/generated.bin"
            generated.parent.mkdir()
            generated.write_bytes(b"build output")

            first = base / "first.tar.gz"
            make_archive(first, {
                ".dockerignore": b"**/build\n",
                "백엔드/old-source.txt": b"old",
                "프론트/index.html": b"v1",
            })
            self.assertEqual(installer.install(first, root), (3, 0))
            self.assertEqual((root / "백엔드/old-source.txt").read_bytes(), b"old")

            second = base / "second.tar.gz"
            make_archive(second, {
                ".dockerignore": b"**/build\n",
                "백엔드/new-source.txt": b"new",
                "프론트/index.html": b"v2",
            })
            self.assertEqual(installer.install(second, root), (3, 1))
            self.assertFalse((root / "백엔드/old-source.txt").exists())
            self.assertEqual((root / "백엔드/new-source.txt").read_bytes(), b"new")
            self.assertEqual((root / "프론트/index.html").read_bytes(), b"v2")
            self.assertEqual(protected.read_text(encoding="utf-8"), "operator secret stays untouched")
            self.assertEqual(local_note.read_text(encoding="utf-8"), "operator data")
            self.assertEqual(generated.read_bytes(), b"build output")

    def test_rejects_environment_and_traversal_paths_before_installing(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            root = base / "application"
            protected = root / "백엔드/infra/.env.production"
            protected.parent.mkdir(parents=True)
            protected.write_text("keep", encoding="utf-8")
            for bad_path in ("백엔드/infra/.env.production", "백엔드/../../outside.txt"):
                archive = base / (str(len(bad_path)) + ".tar.gz")
                make_archive(archive, {bad_path: b"attack"})
                with self.assertRaises(installer.InstallError):
                    installer.install(archive, root)
            self.assertEqual(protected.read_text(encoding="utf-8"), "keep")
            self.assertFalse((base / "outside.txt").exists())

    def test_rejects_archive_manifest_mismatch_without_changing_target(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            root = base / "application"
            root.mkdir()
            current = root / "백엔드/current.txt"
            current.parent.mkdir()
            current.write_text("keep", encoding="utf-8")
            (root / installer.MANIFEST_IN_TARGET).write_text("백엔드/current.txt\n", encoding="utf-8")
            archive = base / "mismatch.tar.gz"
            with tarfile.open(archive, "w:gz") as tar:
                payload = b"changed"
                info = tarfile.TarInfo("백엔드/changed.txt")
                info.size = len(payload)
                tar.addfile(info, io.BytesIO(payload))
                manifest = "백엔드/unlisted.txt\n".encode("utf-8")
                info = tarfile.TarInfo(installer.MANIFEST_IN_ARCHIVE)
                info.size = len(manifest)
                tar.addfile(info, io.BytesIO(manifest))
            with self.assertRaises(installer.InstallError):
                installer.install(archive, root)
            self.assertEqual(current.read_text(encoding="utf-8"), "keep")
            self.assertFalse((root / "백엔드/changed.txt").exists())

    def test_rejects_symbolic_links_in_the_archive(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            root = base / "application"
            archive = base / "link.tar.gz"
            with tarfile.open(archive, "w:gz") as tar:
                link = tarfile.TarInfo("백엔드/linked.txt")
                link.type = tarfile.SYMTYPE
                link.linkname = "../../outside.txt"
                tar.addfile(link)
                manifest = "백엔드/linked.txt\n".encode("utf-8")
                info = tarfile.TarInfo(installer.MANIFEST_IN_ARCHIVE)
                info.size = len(manifest)
                tar.addfile(info, io.BytesIO(manifest))
            with self.assertRaises(installer.InstallError):
                installer.install(archive, root)
            self.assertFalse((base / "outside.txt").exists())

    def test_rejects_source_root_as_a_regular_file(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            root = base / "application"
            archive = base / "root-file.tar.gz"
            with tarfile.open(archive, "w:gz") as tar:
                payload = b"not a directory"
                info = tarfile.TarInfo("./백엔드")
                info.size = len(payload)
                tar.addfile(info, io.BytesIO(payload))
                manifest = "백엔드\n".encode("utf-8")
                info = tarfile.TarInfo(installer.MANIFEST_IN_ARCHIVE)
                info.size = len(manifest)
                tar.addfile(info, io.BytesIO(manifest))
            with self.assertRaises(installer.InstallError):
                installer.install(archive, root)
            self.assertFalse((root / "백엔드").exists())


if __name__ == "__main__":
    unittest.main()
