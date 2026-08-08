"""Model registry on the shared persistent volume.

Every trained artifact is written as a file plus a JSON metadata record. A redeploy
mounts the same volume, so the brain wakes up with all of its models intact. Nothing
here depends on the engine's database, so a corrupted tape can never take the
registry down with it.
"""
from __future__ import annotations

import json
import os
import pickle
import threading
import time
from typing import Any


class Registry:
    def __init__(self, directory: str):
        self.directory = directory
        os.makedirs(self.directory, exist_ok=True)
        self.index_path = os.path.join(self.directory, "index.json")
        self.lock = threading.Lock()
        self.index: dict[str, dict[str, Any]] = {}
        self.cache: dict[str, Any] = {}
        self._load_index()

    def _load_index(self) -> None:
        try:
            with open(self.index_path, "r", encoding="utf-8") as handle:
                self.index = json.load(handle)
        except Exception:  # noqa: BLE001
            self.index = {}

    def _save_index(self) -> None:
        tmp = f"{self.index_path}.tmp"
        with open(tmp, "w", encoding="utf-8") as handle:
            json.dump(self.index, handle)
        os.replace(tmp, self.index_path)

    def save(self, model_id: str, payload: Any, meta: dict[str, Any]) -> dict[str, Any]:
        path = os.path.join(self.directory, f"{model_id}.pkl")
        with open(path, "wb") as handle:
            pickle.dump(payload, handle, protocol=pickle.HIGHEST_PROTOCOL)
        record = {**meta, "modelId": model_id, "path": path, "savedAt": int(time.time() * 1000), "bytes": os.path.getsize(path)}
        with self.lock:
            self.index[model_id] = record
            self._save_index()
            self.cache[model_id] = payload
        return record

    def load(self, model_id: str) -> Any | None:
        with self.lock:
            cached = self.cache.get(model_id)
            if cached is not None:
                return cached
            record = self.index.get(model_id)
        if not record:
            return None
        try:
            with open(record["path"], "rb") as handle:
                payload = pickle.load(handle)
        except Exception:  # noqa: BLE001
            return None
        with self.lock:
            self.cache[model_id] = payload
        return payload

    def get(self, model_id: str) -> dict[str, Any] | None:
        return self.index.get(model_id)

    def list(self, limit: int = 200) -> list[dict[str, Any]]:
        rows = sorted(self.index.values(), key=lambda row: row.get("savedAt", 0), reverse=True)
        return rows[:limit]

    def best_for(self, niche_key: str, kind: str) -> dict[str, Any] | None:
        rows = [
            row
            for row in self.index.values()
            if row.get("nicheKey") == niche_key and row.get("kind") == kind and row.get("usable")
        ]
        if not rows:
            return None
        return sorted(rows, key=lambda row: row.get("score", -1e9), reverse=True)[0]

    def summary(self) -> dict[str, Any]:
        kinds: dict[str, int] = {}
        for row in self.index.values():
            kinds[str(row.get("kind", "unknown"))] = kinds.get(str(row.get("kind", "unknown")), 0) + 1
        return {"count": len(self.index), "kinds": kinds, "directory": self.directory}

    def prune(self, keep: int = 400) -> int:
        rows = sorted(self.index.values(), key=lambda row: row.get("savedAt", 0), reverse=True)
        removed = 0
        for row in rows[keep:]:
            try:
                os.remove(row["path"])
            except Exception:  # noqa: BLE001
                pass
            with self.lock:
                self.index.pop(row["modelId"], None)
                self.cache.pop(row["modelId"], None)
            removed += 1
        if removed:
            with self.lock:
                self._save_index()
        return removed
