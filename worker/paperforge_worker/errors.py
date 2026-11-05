"""Typed worker errors. Messages are shown to users, so they must never include document content."""

from __future__ import annotations

import errno
from typing import Any


class WorkerError(Exception):
    def __init__(self, code: str, message: str, details: dict[str, Any] | None = None):
        super().__init__(message)
        self.code = code
        self.message = message
        self.details = details or {}


class JobCancelled(Exception):
    """Raised by the cancellation token at a safe point in a job."""


def invalid_request(message: str) -> WorkerError:
    return WorkerError("INVALID_REQUEST", message)


def from_os_error(exc: OSError, target: str = "file") -> WorkerError:
    """Translate a filesystem error into something a user can act on."""
    if isinstance(exc, FileNotFoundError):
        return WorkerError(
            "FILE_NOT_FOUND",
            f"The {target} could not be found. It may have been moved or deleted.",
        )
    if isinstance(exc, PermissionError) or getattr(exc, "winerror", None) in (5, 32, 33):
        return WorkerError(
            "OUTPUT_LOCKED",
            f"The {target} is locked or read-only. Close any program using it and try again.",
        )
    if exc.errno == errno.ENOSPC or getattr(exc, "winerror", None) in (39, 112):
        return WorkerError(
            "DISK_FULL",
            "There is not enough free disk space to finish this operation.",
        )
    if exc.errno == errno.ENAMETOOLONG or getattr(exc, "winerror", None) in (3, 206):
        return WorkerError(
            "PATH_TOO_LONG",
            f"The {target} path is too long or a folder in it does not exist.",
        )
    return WorkerError("IO_ERROR", f"Could not access the {target} (system error {exc.errno}).")
