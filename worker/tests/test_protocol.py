"""Drive the real worker process over its stdio protocol."""

from __future__ import annotations

import json
import os
import subprocess
import sys
import time
from pathlib import Path

import pymupdf
import pytest

from conftest import src
from paperforge_worker.errors import WorkerError
from paperforge_worker.validate import OP_SPECS, check

WORKER_DIR = Path(__file__).resolve().parents[1]
CONTRACT_DIR = WORKER_DIR.parent / "tests" / "protocol-fixtures"


class Worker:
    def __init__(self):
        env = {**os.environ, "PYTHONPATH": str(WORKER_DIR), "PYTHONIOENCODING": "utf-8"}
        self.proc = subprocess.Popen(
            [sys.executable, "-m", "paperforge_worker"],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env=env,
            cwd=str(WORKER_DIR),
        )
        self.ready = self.read()
        assert self.ready["type"] == "ready"

    def send(self, message: dict) -> None:
        self.proc.stdin.write(json.dumps(message).encode("utf-8") + b"\n")
        self.proc.stdin.flush()

    def send_raw(self, raw: bytes) -> None:
        self.proc.stdin.write(raw)
        self.proc.stdin.flush()

    def read(self) -> dict:
        line = self.proc.stdout.readline()
        assert line, "worker closed stdout unexpectedly"
        return json.loads(line.decode("utf-8"))

    def job(self, job_id: str, op: str, params: dict) -> None:
        self.send({"v": 1, "type": "job", "id": job_id, "op": op, "params": params})

    def until_terminal(self, job_id: str) -> tuple[dict, list[dict]]:
        progress = []
        while True:
            event = self.read()
            if event.get("id") != job_id:
                continue
            if event["type"] == "progress":
                progress.append(event)
            else:
                return event, progress

    def close(self) -> str:
        try:
            self.proc.stdin.close()
        except OSError:
            pass
        self.proc.wait(timeout=10)
        stderr = self.proc.stderr.read().decode("utf-8", "replace")
        self.proc.stdout.close()
        self.proc.stderr.close()
        return stderr


@pytest.fixture
def worker():
    instance = Worker()
    yield instance
    if instance.proc.poll() is None:
        instance.close()


def test_ready_reports_versions(worker):
    assert worker.ready["pymupdf"] == pymupdf.VersionBind
    assert worker.ready["worker"]


def test_probe_roundtrip_with_unicode_path(worker, fx):
    worker.job("j1", "probe", {"source": {**src(fx["unicode"]), "kind": "pdf"}})
    event, _ = worker.until_terminal("j1")
    assert event["type"] == "result"
    assert event["data"]["name"] == fx["unicode"].name
    assert event["data"]["pageCount"] == 2


def test_malformed_line_does_not_kill_worker(worker, fx):
    worker.send_raw(b"{not json\n")
    event = worker.read()
    assert event["type"] == "error" and event["code"] == "INVALID_REQUEST" and event["id"] is None
    worker.job("j2", "probe", {"source": {**src(fx["a"]), "kind": "pdf"}})
    event, _ = worker.until_terminal("j2")
    assert event["type"] == "result"


def test_invalid_utf8_line_does_not_kill_worker(worker):
    worker.send_raw(b"\xff\xfe\xfd\n")
    assert worker.read()["code"] == "INVALID_REQUEST"


@pytest.mark.parametrize(
    "message",
    [
        {"v": 2, "type": "job", "id": "x", "op": "probe", "params": {}},
        {"v": 1, "type": "nonsense", "id": "x"},
        {"v": 1, "type": "job", "id": "bad id!", "op": "probe", "params": {}},
    ],
)
def test_protocol_violations_rejected(worker, message):
    worker.send(message)
    assert worker.read()["code"] == "INVALID_REQUEST"


def test_unknown_op_and_bad_params(worker, fx):
    worker.job("u1", "format_c_drive", {})
    event, _ = worker.until_terminal("u1")
    assert event["code"] == "INVALID_REQUEST"
    worker.job("u2", "probe", {"source": {"id": "x"}})
    event, _ = worker.until_terminal("u2")
    assert event["code"] == "INVALID_REQUEST"
    worker.job("u3", "split", {"source": src(fx["a"]), "groups": [], "folder": {"path": "x", "overwrite": "error"}})
    event, _ = worker.until_terminal("u3")
    assert event["code"] == "INVALID_REQUEST"


def test_progress_is_reported_and_result_arrives(worker, fx, tmp_path):
    out = tmp_path / "p.pdf"
    worker.job(
        "p1",
        "assemble",
        {
            "sources": [src(fx["a"], "a")],
            "pages": [{"kind": "pdf", "sourceId": "a", "pageIndex": i, "rotation": 0} for i in range(5)],
            "options": {"pageSizing": "preserve", "fitSize": "A4", "blankSize": "A4", "imageFit": "contain"},
            "output": {"path": str(out), "overwrite": "error"},
        },
    )
    event, progress = worker.until_terminal("p1")
    assert event["type"] == "result"
    assert event["data"]["verified"] is True
    assert len(progress) >= 5
    assert progress[-1]["done"] <= progress[-1]["total"]
    assert out.exists()


def test_cancel_stops_running_job_and_cleans_up(worker, fx, tmp_path):
    many = [{"name": f"f{i}.pdf", "pages": [0]} for i in range(3000)]
    worker.job("c1", "split", {"source": src(fx["a"]), "groups": many, "folder": {"path": str(tmp_path), "overwrite": "error"}})
    deadline = time.time() + 30
    while time.time() < deadline:
        event = worker.read()
        if event.get("type") == "progress":
            break
    worker.send({"v": 1, "type": "cancel", "id": "c1"})
    event, _ = worker.until_terminal("c1")
    assert event["type"] == "cancelled"
    assert list(tmp_path.iterdir()) == []


def test_cancel_queued_job(worker, fx, tmp_path):
    long_groups = [{"name": f"f{i}.pdf", "pages": [0]} for i in range(200)]
    worker.job("q1", "split", {"source": src(fx["a"]), "groups": long_groups, "folder": {"path": str(tmp_path), "overwrite": "error"}})
    worker.job("q2", "probe", {"source": {**src(fx["a"]), "kind": "pdf"}})
    worker.send({"v": 1, "type": "cancel", "id": "q2"})
    seen = {}
    while "q2" not in seen:
        event = worker.read()
        if event.get("type") in ("result", "cancelled", "error"):
            seen[event["id"]] = event
    assert seen["q2"]["type"] == "cancelled"


def test_bounded_queue_rejects_excess_jobs(worker, fx, tmp_path):
    groups = [{"name": f"f{i}.pdf", "pages": [0]} for i in range(500)]
    worker.job("b0", "split", {"source": src(fx["a"]), "groups": groups, "folder": {"path": str(tmp_path), "overwrite": "error"}})
    for i in range(1, 80):
        worker.job(f"b{i}", "probe", {"source": {**src(fx["a"]), "kind": "pdf"}})
    worker.send({"v": 1, "type": "cancel", "id": "b0"})
    rejected = False
    finished = 0
    while finished < 80:
        event = worker.read()
        if event.get("type") in ("result", "cancelled", "error"):
            finished += 1
            if event.get("code") == "QUEUE_FULL":
                rejected = True
    assert rejected


def test_passwords_and_paths_are_not_logged(worker, fx):
    worker.job("s1", "probe", {"source": {**src(fx["enc_user"], "e", "VERYSECRETPW"), "kind": "pdf"}})
    worker.until_terminal("s1")
    worker.job("s2", "probe", {"source": {**src(fx["enc_user"], "e", "WRONGSECRETPW"), "kind": "pdf"}})
    event, _ = worker.until_terminal("s2")
    assert event["code"] == "WRONG_PASSWORD"
    stderr = worker.close()
    assert "VERYSECRETPW" not in stderr
    assert "WRONGSECRETPW" not in stderr
    assert "op=probe" in stderr


def test_exits_when_host_closes_stdin(worker):
    worker.proc.stdin.close()
    assert worker.proc.wait(timeout=10) == 0


def test_stdout_contains_only_protocol_lines(worker, fx, tmp_path):
    worker.job("o1", "probe", {"source": {**src(fx["garbage"]), "kind": "pdf"}})
    event, _ = worker.until_terminal("o1")
    assert event["code"] == "INVALID_FILE"
    assert worker.proc.poll() is None


def _contract_fixtures(kind: str):
    return sorted((CONTRACT_DIR / kind).glob("*.json"))


@pytest.mark.parametrize("path", _contract_fixtures("valid"), ids=lambda p: p.stem)
def test_contract_valid_fixtures_accepted(path):
    message = json.loads(path.read_text(encoding="utf-8"))
    check(message["params"], OP_SPECS[message["op"]])


@pytest.mark.parametrize("path", _contract_fixtures("invalid"), ids=lambda p: p.stem)
def test_contract_invalid_fixtures_rejected(path):
    message = json.loads(path.read_text(encoding="utf-8"))
    with pytest.raises(WorkerError):
        check(message["params"], OP_SPECS[message["op"]])
