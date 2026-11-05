"""Entry point: a JSON Lines protocol over stdin/stdout, with logs on stderr.

Requests:  {"v":1,"type":"job","id":"...","op":"...","params":{...}}
           {"v":1,"type":"cancel","id":"..."}
           {"v":1,"type":"shutdown"}
Events:    {"v":1,"type":"ready","worker":"...","pymupdf":"...","mupdf":"...","pillow":"..."}
           {"v":1,"type":"progress","id":"...","done":1,"total":3,"stage":"..."}
           {"v":1,"type":"result","id":"...","data":{...}}
           {"v":1,"type":"error","id":"...","code":"...","message":"...","details":{...}}
           {"v":1,"type":"cancelled","id":"..."}

Passwords travel in params, so requests are never logged. Only op names, ids and timings are.
"""

from __future__ import annotations

import json
import os
import queue
import re
import sys
import threading
import time
import traceback
from typing import Any, BinaryIO

MAX_QUEUED_JOBS = 32
JOB_ID_PATTERN = re.compile(r"^[A-Za-z0-9_-]{1,64}$")


def _claim_stdout() -> BinaryIO:
    """Keep the protocol stream private: anything else that prints ends up on stderr."""
    protocol_fd = os.dup(1)
    os.dup2(2, 1)
    sys.stdout = sys.stderr
    return os.fdopen(protocol_fd, "wb", buffering=0)


def log(message: str) -> None:
    print(f"[worker] {message}", file=sys.stderr, flush=True)


class Server:
    def __init__(self, out: BinaryIO):
        self.out = out
        self.write_lock = threading.Lock()
        self.jobs: queue.Queue[dict[str, Any] | None] = queue.Queue()
        self.state_lock = threading.Lock()
        self.queued_ids: dict[str, bool] = {}  # id -> cancelled while waiting
        self.active: Any = None

    def send(self, event: dict[str, Any]) -> None:
        line = json.dumps({"v": 1, **event}, ensure_ascii=False, separators=(",", ":"))
        with self.write_lock:
            self.out.write(line.encode("utf-8") + b"\n")

    def error(self, job_id: str | None, code: str, message: str, details: dict | None = None) -> None:
        self.send({"type": "error", "id": job_id, "code": code, "message": message, "details": details or {}})

    def reader(self, stream: BinaryIO) -> None:
        for raw in stream:
            try:
                message = json.loads(raw.decode("utf-8"))
                if not isinstance(message, dict):
                    raise ValueError("not an object")
            except (ValueError, UnicodeDecodeError):
                self.error(None, "INVALID_REQUEST", "The worker received a malformed message.")
                continue
            kind = message.get("type")
            if message.get("v") != 1:
                self.error(_safe_id(message), "INVALID_REQUEST", "Unsupported protocol version.")
            elif kind == "job":
                self._enqueue(message)
            elif kind == "cancel":
                self._cancel(message.get("id"))
            elif kind == "shutdown":
                break
            else:
                self.error(_safe_id(message), "INVALID_REQUEST", "Unknown message type.")
        self.jobs.put(None)

    def _enqueue(self, message: dict[str, Any]) -> None:
        job_id = _safe_id(message)
        if job_id is None:
            self.error(None, "INVALID_REQUEST", "A job needs a valid id.")
            return
        with self.state_lock:
            if len(self.queued_ids) >= MAX_QUEUED_JOBS:
                self.error(job_id, "QUEUE_FULL", "Too many jobs are waiting. Try again in a moment.")
                return
            self.queued_ids[job_id] = False
        self.jobs.put(message)

    def _cancel(self, job_id: Any) -> None:
        with self.state_lock:
            if job_id in self.queued_ids:
                self.queued_ids[job_id] = True
            elif self.active is not None and self.active.job_id == job_id:
                self.active.cancel()

    def progress(self, job_id: str, done: int, total: int, stage: str) -> None:
        self.send({"type": "progress", "id": job_id, "done": done, "total": total, "stage": stage})

    def run(self) -> None:
        from .errors import JobCancelled, WorkerError, from_os_error
        from .job import JobContext
        from .ops import HANDLERS
        from .validate import OP_SPECS, check

        while True:
            message = self.jobs.get()
            if message is None:
                return
            job_id = message["id"]
            with self.state_lock:
                cancelled_early = self.queued_ids.pop(job_id, False)
                ctx = JobContext(job_id, self.progress)
                self.active = ctx
            started = time.monotonic()
            op = message.get("op")
            try:
                if cancelled_early:
                    raise JobCancelled()
                if op not in HANDLERS:
                    raise WorkerError("INVALID_REQUEST", "Unknown operation.")
                params = message.get("params")
                check(params, OP_SPECS[op])
                result = HANDLERS[op](params, ctx)
                ctx.check_cancelled()
                self.send({"type": "result", "id": job_id, "data": result})
                log(f"op={op} id={job_id} ok ms={int((time.monotonic() - started) * 1000)}")
            except JobCancelled:
                self.send({"type": "cancelled", "id": job_id})
                log(f"op={op} id={job_id} cancelled")
            except WorkerError as exc:
                self.error(job_id, exc.code, exc.message, exc.details)
                log(f"op={op} id={job_id} error={exc.code}")
            except OSError as exc:
                mapped = from_os_error(exc)
                self.error(job_id, mapped.code, mapped.message)
                log(f"op={op} id={job_id} error={mapped.code}")
            except Exception as exc:  # noqa: BLE001 - a job failure must not kill the worker
                self.error(
                    job_id,
                    "INTERNAL",
                    "PaperForge hit an unexpected problem with this document. "
                    "The source files are unchanged.",
                )
                # Type and location only: exception text can quote document content.
                frames = traceback.extract_tb(exc.__traceback__)
                where = f"{os.path.basename(frames[-1].filename)}:{frames[-1].lineno}" if frames else "?"
                log(f"op={op} id={job_id} error=INTERNAL type={type(exc).__name__} at={where}")
            finally:
                with self.state_lock:
                    self.active = None


def _safe_id(message: dict[str, Any]) -> str | None:
    job_id = message.get("id")
    return job_id if isinstance(job_id, str) and JOB_ID_PATTERN.match(job_id) else None


def main() -> int:
    out = _claim_stdout()
    server = Server(out)

    import PIL
    import pymupdf

    from . import __version__

    pymupdf.TOOLS.mupdf_display_errors(False)
    pymupdf.TOOLS.mupdf_display_warnings(False)

    server.send(
        {
            "type": "ready",
            "worker": __version__,
            "pymupdf": pymupdf.VersionBind,
            "mupdf": pymupdf.VersionFitz,
            "pillow": PIL.__version__,
            "pid": os.getpid(),
        }
    )
    reader = threading.Thread(target=server.reader, args=(sys.stdin.buffer,), daemon=True)
    reader.start()
    server.run()
    return 0


if __name__ == "__main__":
    sys.exit(main())
