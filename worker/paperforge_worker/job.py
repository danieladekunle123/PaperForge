"""Per-job context: progress reporting and cooperative cancellation."""

from __future__ import annotations

import threading
from typing import Callable

from .errors import JobCancelled


class JobContext:
    def __init__(self, job_id: str, emit_progress: Callable[[str, int, int, str], None] | None = None):
        self.job_id = job_id
        self._cancel = threading.Event()
        self._emit = emit_progress

    def cancel(self) -> None:
        self._cancel.set()

    @property
    def cancelled(self) -> bool:
        return self._cancel.is_set()

    def check_cancelled(self) -> None:
        if self._cancel.is_set():
            raise JobCancelled()

    def progress(self, done: int, total: int, stage: str = "") -> None:
        if self._emit:
            self._emit(self.job_id, done, total, stage)
