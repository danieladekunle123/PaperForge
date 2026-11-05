"""Filesystem helpers: long paths, staged atomic output, collision handling."""

from __future__ import annotations

import os
import shutil
import sys
from dataclasses import dataclass

from .errors import WorkerError, from_os_error

TEMP_PREFIX = ".paperforge-"
LONG_PATH_THRESHOLD = 240


def native_path(path: str) -> str:
    """Return a path usable by Win32 APIs even when it exceeds MAX_PATH."""
    if sys.platform != "win32":
        return path
    absolute = os.path.abspath(path)
    if absolute.startswith("\\\\?\\") or len(absolute) < LONG_PATH_THRESHOLD:
        return absolute
    if absolute.startswith("\\\\"):
        return "\\\\?\\UNC\\" + absolute[2:]
    return "\\\\?\\" + absolute


def ensure_free_space(directory: str, required_bytes: int) -> None:
    try:
        free = shutil.disk_usage(native_path(directory)).free
    except OSError as exc:
        raise from_os_error(exc, "output folder") from exc
    if free < required_bytes:
        raise WorkerError(
            "DISK_FULL",
            f"This job needs about {_mb(required_bytes)} of free space, "
            f"but only {_mb(free)} is available on the output drive.",
        )


def _mb(n: int) -> str:
    return f"{n / (1024 * 1024):.1f} MB"


def safe_filename(name: str) -> str:
    """Reject names that could escape the output folder or are invalid on Windows."""
    invalid = set('<>:"/\\|?*') | {chr(c) for c in range(32)}
    if not name or name in {".", ".."} or any(ch in invalid for ch in name):
        raise WorkerError("INVALID_REQUEST", "An output filename contains invalid characters.")
    if name.endswith((" ", ".")):
        raise WorkerError("INVALID_REQUEST", "An output filename cannot end with a space or dot.")
    stem = name.split(".", 1)[0].upper()
    reserved = {"CON", "PRN", "AUX", "NUL"} | {f"COM{i}" for i in range(1, 10)} | {
        f"LPT{i}" for i in range(1, 10)
    }
    if stem in reserved:
        raise WorkerError("INVALID_REQUEST", f"“{name}” is a reserved filename on Windows.")
    return name


def resolve_collision(path: str, policy: str, taken: set[str] | None = None) -> str:
    """Apply the overwrite policy. Returns the final path to write to."""
    taken = taken if taken is not None else set()
    exists = os.path.exists(native_path(path)) or os.path.normcase(path) in taken
    if not exists or policy == "replace":
        return path
    if policy == "error":
        raise WorkerError(
            "OUTPUT_EXISTS",
            f"“{os.path.basename(path)}” already exists in the output folder.",
            {"name": os.path.basename(path)},
        )
    stem, ext = os.path.splitext(path)
    counter = 1
    while True:
        candidate = f"{stem} ({counter}){ext}"
        if not os.path.exists(native_path(candidate)) and os.path.normcase(candidate) not in taken:
            return candidate
        counter += 1


@dataclass
class _Staged:
    temp: str
    final: str
    backup: str | None = None
    committed: bool = False


class Staging:
    """All-or-nothing output: write temp files beside the destination, then rename.

    Temp names embed the job id so the host can sweep them if the worker is killed.
    """

    def __init__(self, job_id: str):
        self.job_id = job_id
        self._items: list[_Staged] = []

    def __enter__(self) -> Staging:
        return self

    def __exit__(self, *_exc: object) -> None:
        self.cleanup()

    def temp_for(self, final_path: str) -> str:
        directory = os.path.dirname(os.path.abspath(final_path))
        if not os.path.isdir(native_path(directory)):
            raise WorkerError("FILE_NOT_FOUND", "The output folder no longer exists.")
        index = len(self._items)
        temp = native_path(os.path.join(directory, f"{TEMP_PREFIX}{self.job_id}-{index}.tmp"))
        self._items.append(_Staged(temp=temp, final=final_path))
        return temp

    def commit(self) -> None:
        """Move every staged file into place, rolling back everything on failure."""
        try:
            for index, item in enumerate(self._items):
                final = native_path(item.final)
                if os.path.exists(final):
                    directory = os.path.dirname(os.path.abspath(item.final))
                    item.backup = native_path(
                        os.path.join(directory, f"{TEMP_PREFIX}{self.job_id}-{index}.bak")
                    )
                    os.replace(final, item.backup)
                os.replace(item.temp, final)
                item.committed = True
        except OSError as exc:
            self._rollback()
            raise from_os_error(exc, "output file") from exc
        for item in self._items:
            if item.backup:
                _remove_quietly(item.backup)

    def _rollback(self) -> None:
        for item in self._items:
            final = native_path(item.final)
            if item.committed:
                _remove_quietly(final)
            if item.backup and os.path.exists(item.backup):
                try:
                    os.replace(item.backup, final)
                except OSError:
                    pass

    def cleanup(self) -> None:
        for item in self._items:
            if not item.committed:
                _remove_quietly(item.temp)


def _remove_quietly(path: str) -> None:
    try:
        os.unlink(path)
    except OSError:
        pass


def file_size(path: str) -> int:
    return os.path.getsize(native_path(path))
