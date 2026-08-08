"""
BRAIN — the learning sidecar.

The TypeScript engine owns market truth: ingestion, playbooks, risk, execution and
the decision tape. It is very good at that and hopeless at gradient descent. This
service owns everything that needs real numerical machinery:

  • gradient-boosted trees (LightGBM) and neural nets (PyTorch) trained with
    PURGED walk-forward splits, because financial labels overlap in time
  • a PPO reinforcement-learning agent that manages an open position bar by bar
    (hold / scale out / tighten / exit) on the REAL price paths recorded by the
    engine — no synthetic environment, no toy data
  • a model registry on the shared volume, so a redeploy never loses a brain

Design rules
  • read-only access to the engine's SQLite (WAL allows concurrent readers), so
    there is exactly one source of truth and no data duplication
  • every job runs in a background worker behind a resource governor, so training
    can never starve the live decision loop
  • an unavailable brain is "no opinion", never an error: the engine degrades to
    its local models and keeps trading
"""
from __future__ import annotations

import os
import threading
import time
import traceback
import uuid
from typing import Any, Callable, Literal

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from data import TapeReader, coverage
from governor import Governor, resource_snapshot
from registry import Registry
from rl import act_batch, train_exit_agent
from tabular import HAS_LGB, HAS_TORCH, predict_batch, train_tabular

APP_VERSION = "brain-1.0.0"

app = FastAPI(title="MYCROFT Brain", version=APP_VERSION)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

DATA_DIR = os.environ.get("BRAIN_DATA_DIR", "/app/engine/data")
DB_PATH = os.environ.get("BRAIN_DB_PATH") or os.path.join(DATA_DIR, "mycroft.sqlite")
ARTIFACT_DIR = os.environ.get("BRAIN_ARTIFACT_DIR") or os.path.join(DATA_DIR, "brain")

registry = Registry(ARTIFACT_DIR)
governor = Governor(
    max_rss_mb=int(os.environ.get("BRAIN_MAX_RSS_MB", "2200")),
    max_load=float(os.environ.get("RESEARCH_MAX_LOAD", "6")),
)


class Job:
    def __init__(self, kind: str, payload: dict[str, Any]):
        self.id = uuid.uuid4().hex[:12]
        self.kind = kind
        self.payload = payload
        self.status: Literal["queued", "running", "done", "failed", "cancelled"] = "queued"
        self.created_at = time.time()
        self.started_at: float | None = None
        self.finished_at: float | None = None
        self.progress = 0.0
        self.message = "queued"
        self.result: dict[str, Any] | None = None
        self.error: str | None = None
        self.cancel = threading.Event()

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "kind": self.kind,
            "niche": self.payload.get("niche"),
            "status": self.status,
            "createdAt": int(self.created_at * 1000),
            "startedAt": int(self.started_at * 1000) if self.started_at else None,
            "finishedAt": int(self.finished_at * 1000) if self.finished_at else None,
            "progress": round(self.progress, 4),
            "message": self.message,
            "result": self.result,
            "error": self.error,
        }


class JobQueue:
    def __init__(self, workers: int = 1):
        self.jobs: dict[str, Job] = {}
        self.order: list[str] = []
        self.pending: list[str] = []
        self.lock = threading.Lock()
        self.wake = threading.Event()
        self.runners: dict[str, Callable[[Job], dict[str, Any]]] = {}
        for index in range(max(1, workers)):
            threading.Thread(target=self._loop, name=f"brain-worker-{index}", daemon=True).start()

    def register(self, kind: str, runner: Callable[[Job], dict[str, Any]]) -> None:
        self.runners[kind] = runner

    def submit(self, kind: str, payload: dict[str, Any]) -> Job:
        job = Job(kind, payload)
        with self.lock:
            self.jobs[job.id] = job
            self.order.insert(0, job.id)
            self.pending.append(job.id)
            for stale in self.order[300:]:
                self.jobs.pop(stale, None)
            self.order = self.order[:300]
        self.wake.set()
        return job

    def get(self, job_id: str) -> Job | None:
        return self.jobs.get(job_id)

    def list(self, limit: int = 40) -> list[dict[str, Any]]:
        with self.lock:
            ids = self.order[:limit]
        return [self.jobs[i].to_dict() for i in ids if i in self.jobs]

    def running(self) -> int:
        return sum(1 for job in self.jobs.values() if job.status == "running")

    def queued(self) -> int:
        return sum(1 for job in self.jobs.values() if job.status == "queued")

    def _loop(self) -> None:
        while True:
            job_id: str | None = None
            with self.lock:
                if self.pending:
                    job_id = self.pending.pop(0)
            if job_id is None:
                self.wake.wait(1.0)
                self.wake.clear()
                continue
            job = self.jobs.get(job_id)
            if job is None or job.cancel.is_set():
                continue
            runner = self.runners.get(job.kind)
            if runner is None:
                job.status = "failed"
                job.error = f"unknown_job_kind:{job.kind}"
                continue
            job.status = "running"
            job.started_at = time.time()
            job.message = "started"
            try:
                governor.wait_for_headroom(job)
                job.result = runner(job)
                job.status = "cancelled" if job.cancel.is_set() else "done"
                job.progress = 1.0
                job.message = job.status
            except Exception as error:  # noqa: BLE001 - a failed job must never kill the worker
                job.status = "failed"
                job.error = f"{type(error).__name__}: {error}"
                job.message = job.error
                traceback.print_exc()
            finally:
                job.finished_at = time.time()


queue = JobQueue(workers=int(os.environ.get("BRAIN_WORKERS", "1")))
queue.register("tabular", lambda job: train_tabular(TapeReader(DB_PATH), registry, job))
queue.register("rl", lambda job: train_exit_agent(TapeReader(DB_PATH), registry, job))


class NicheSpec(BaseModel):
    playbook: str
    instType: str
    timeframe: str


class TrainRequest(BaseModel):
    niche: NicheSpec
    limit: int = Field(default=12000, ge=200, le=200000)
    folds: int = Field(default=4, ge=2, le=8)
    seed: int = 7
    holdoutSymbols: list[str] = Field(default_factory=list)
    models: list[str] = Field(default_factory=lambda: ["logistic", "lightgbm", "mlp"])
    featureSchema: str = "v3"


class RlRequest(BaseModel):
    niche: NicheSpec
    limit: int = Field(default=6000, ge=200, le=60000)
    epochs: int = Field(default=12, ge=1, le=200)
    seed: int = 7
    featureSchema: str = "v3"


class PredictRequest(BaseModel):
    modelId: str
    features: list[list[float]]


class ActRequest(BaseModel):
    modelId: str
    states: list[list[float]]


@app.get("/health")
def health() -> dict[str, Any]:
    readable = True
    tape_rows = -1
    try:
        tape_rows = TapeReader(DB_PATH).count()
    except Exception as error:  # noqa: BLE001
        readable = False
        print(f"[brain] tape unreadable: {error}")
    return {
        "ok": True,
        "version": APP_VERSION,
        "db": DB_PATH,
        "dbReadable": readable,
        "tapeRows": tape_rows,
        "artifacts": registry.summary(),
        "jobsRunning": queue.running(),
        "jobsQueued": queue.queued(),
        "capabilities": {"lightgbm": HAS_LGB, "torch": HAS_TORCH},
        "resources": resource_snapshot(),
        "governor": governor.state(),
    }


@app.get("/coverage")
def tape_coverage() -> dict[str, Any]:
    try:
        return {"niches": coverage(TapeReader(DB_PATH))}
    except Exception as error:  # noqa: BLE001
        return {"niches": [], "error": str(error)}


@app.post("/train/tabular")
def post_train_tabular(request: TrainRequest) -> dict[str, Any]:
    job = queue.submit("tabular", request.model_dump())
    return {"jobId": job.id, "status": job.status}


@app.post("/train/rl")
def post_train_rl(request: RlRequest) -> dict[str, Any]:
    job = queue.submit("rl", request.model_dump())
    return {"jobId": job.id, "status": job.status}


@app.get("/jobs")
def list_jobs(limit: int = 40) -> dict[str, Any]:
    return {"jobs": queue.list(limit), "running": queue.running(), "queued": queue.queued()}


@app.get("/jobs/{job_id}")
def get_job(job_id: str) -> dict[str, Any]:
    job = queue.get(job_id)
    return job.to_dict() if job else {"error": "not_found"}


@app.post("/jobs/{job_id}/cancel")
def cancel_job(job_id: str) -> dict[str, Any]:
    job = queue.get(job_id)
    if job is None:
        return {"error": "not_found"}
    job.cancel.set()
    if job.status == "queued":
        job.status = "cancelled"
    return job.to_dict()


@app.get("/models")
def list_models(limit: int = 200) -> dict[str, Any]:
    return {"models": registry.list(limit)}


@app.get("/models/{model_id}")
def get_model(model_id: str) -> dict[str, Any]:
    return registry.get(model_id) or {"error": "not_found"}


@app.get("/best")
def best_model(nicheKey: str, kind: str = "tabular") -> dict[str, Any]:
    return registry.best_for(nicheKey, kind) or {"error": "not_found"}


@app.post("/predict")
def post_predict(request: PredictRequest) -> dict[str, Any]:
    return predict_batch(registry, request.modelId, request.features)


@app.post("/act")
def post_act(request: ActRequest) -> dict[str, Any]:
    return act_batch(registry, request.modelId, request.states)
