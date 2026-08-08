"""Read-only access to the engine's decision tape.

The engine owns the SQLite file. SQLite in WAL mode supports any number of
concurrent readers alongside one writer, so the brain opens the same file with
`mode=ro` and never writes a byte to it. Model artifacts live in a separate
directory on the same persistent volume.
"""
from __future__ import annotations

import base64
import json
import sqlite3
from dataclasses import dataclass
from typing import Any, Iterable

import numpy as np


@dataclass
class TapeBatch:
    features: np.ndarray
    labels: np.ndarray
    net_r: np.ndarray
    at: np.ndarray
    horizon_end: np.ndarray
    symbols: list[str]
    regime: np.ndarray

    def __len__(self) -> int:
        return int(self.features.shape[0])


@dataclass
class PathRow:
    features: np.ndarray
    at: int
    symbol: str
    side: int
    risk_frac: float
    targets_r: list[float]
    allocations: list[float]
    max_hold: int
    fee_bps: float
    slippage_bps: float
    baseline_net_r: float
    path_r: np.ndarray


def decode_path(blob: str | None) -> np.ndarray:
    """Decode the engine's Float32 path blob: open, high, low, close per bar."""
    if not blob:
        return np.zeros((0, 4), dtype=np.float32)
    raw = base64.b64decode(blob)
    stride = 16
    usable = len(raw) - (len(raw) % stride)
    if usable <= 0:
        return np.zeros((0, 4), dtype=np.float32)
    values = np.frombuffer(raw[:usable], dtype="<f4")
    return values.reshape(-1, 4).astype(np.float32)


def _where(filters: dict[str, Any]) -> tuple[str, tuple[Any, ...]]:
    clauses: list[str] = []
    params: list[Any] = []
    for column in ("playbook", "inst_type", "timeframe", "feature_schema", "symbol"):
        value = filters.get(column)
        if value:
            clauses.append(f"{column}=?")
            params.append(value)
    excluded = filters.get("exclude_symbols") or []
    if excluded:
        clauses.append(f"symbol NOT IN ({','.join('?' for _ in excluded)})")
        params.extend(excluded)
    return (f"WHERE {' AND '.join(clauses)}" if clauses else "", tuple(params))


class TapeReader:
    def __init__(self, db_path: str):
        self.db_path = db_path
        self._conn: sqlite3.Connection | None = None

    def connect(self) -> sqlite3.Connection:
        if self._conn is None:
            self._conn = sqlite3.connect(
                f"file:{self.db_path}?mode=ro", uri=True, check_same_thread=False, timeout=15.0
            )
            self._conn.row_factory = sqlite3.Row
        return self._conn

    def count(self, **filters: Any) -> int:
        where, params = _where(filters)
        cursor = self.connect().execute(f"SELECT count(*) AS n FROM decision_tape {where}", params)
        return int(cursor.fetchone()["n"])

    def batch(
        self,
        playbook: str | None = None,
        inst_type: str | None = None,
        timeframe: str | None = None,
        feature_schema: str | None = "v3",
        limit: int = 20000,
        exclude_symbols: Iterable[str] | None = None,
    ) -> TapeBatch:
        where, params = _where(
            {
                "playbook": playbook,
                "inst_type": inst_type,
                "timeframe": timeframe,
                "feature_schema": feature_schema,
                "exclude_symbols": list(exclude_symbols or []),
            }
        )
        sql = (
            "SELECT at,symbol,features_json,baseline_label,baseline_net_r,horizon_end_at,regime_id "
            f"FROM decision_tape {where} ORDER BY at DESC LIMIT ?"
        )
        rows = list(reversed(self.connect().execute(sql, (*params, int(limit))).fetchall()))
        if not rows:
            return TapeBatch(
                np.zeros((0, 0), dtype=np.float32),
                np.zeros((0,), dtype=np.int8),
                np.zeros((0,), dtype=np.float32),
                np.zeros((0,), dtype=np.int64),
                np.zeros((0,), dtype=np.int64),
                [],
                np.zeros((0,), dtype=np.int16),
            )
        features = np.array([json.loads(row["features_json"]) for row in rows], dtype=np.float32)
        features = np.nan_to_num(features, nan=0.0, posinf=0.0, neginf=0.0)
        return TapeBatch(
            features,
            np.array([int(row["baseline_label"] or 0) for row in rows], dtype=np.int8),
            np.array([float(row["baseline_net_r"] or 0.0) for row in rows], dtype=np.float32),
            np.array([int(row["at"]) for row in rows], dtype=np.int64),
            np.array([int(row["horizon_end_at"]) for row in rows], dtype=np.int64),
            [str(row["symbol"]) for row in rows],
            np.array([int(row["regime_id"]) if row["regime_id"] is not None else -1 for row in rows], dtype=np.int16),
        )

    def paths(
        self,
        playbook: str | None = None,
        inst_type: str | None = None,
        timeframe: str | None = None,
        feature_schema: str | None = "v3",
        limit: int = 6000,
    ) -> list[PathRow]:
        where, params = _where(
            {"playbook": playbook, "inst_type": inst_type, "timeframe": timeframe, "feature_schema": feature_schema}
        )
        sql = (
            "SELECT at,symbol,side,features_json,entry,stop,targets_json,max_hold_bars,fee_bps,slippage_bps,"
            f"baseline_net_r,path_blob FROM decision_tape {where} ORDER BY at DESC LIMIT ?"
        )
        rows = self.connect().execute(sql, (*params, int(limit))).fetchall()
        out: list[PathRow] = []
        for row in reversed(rows):
            entry = float(row["entry"])
            stop = float(row["stop"])
            if entry <= 0 or stop <= 0 or entry == stop:
                continue
            side = 1 if str(row["side"]) == "LONG" else -1
            risk_frac = abs(entry - stop) / entry
            if risk_frac <= 1e-9:
                continue
            path = decode_path(row["path_blob"])
            if path.shape[0] < 4:
                continue
            if side == 1:
                high_r = path[:, 1] / risk_frac
                low_r = path[:, 2] / risk_frac
            else:
                high_r = -path[:, 2] / risk_frac
                low_r = -path[:, 1] / risk_frac
            close_r = side * path[:, 3] / risk_frac
            path_r = np.stack([high_r, low_r, close_r], axis=1).astype(np.float32)
            targets_r: list[float] = []
            allocations: list[float] = []
            for target in json.loads(row["targets_json"]):
                price = float(target.get("price", 0.0))
                if price <= 0:
                    continue
                targets_r.append(float(side * (price / entry - 1.0) / risk_frac))
                allocations.append(float(target.get("allocation", 0.0)))
            total = sum(allocations) or 1.0
            allocations = [value / total for value in allocations]
            features = np.nan_to_num(np.array(json.loads(row["features_json"]), dtype=np.float32), nan=0.0)
            out.append(
                PathRow(
                    features=features,
                    at=int(row["at"]),
                    symbol=str(row["symbol"]),
                    side=side,
                    risk_frac=risk_frac,
                    targets_r=targets_r,
                    allocations=allocations,
                    max_hold=int(row["max_hold_bars"]),
                    fee_bps=float(row["fee_bps"]),
                    slippage_bps=float(row["slippage_bps"]),
                    baseline_net_r=float(row["baseline_net_r"] or 0.0),
                    path_r=path_r,
                )
            )
        return out


def coverage(reader: TapeReader) -> list[dict[str, Any]]:
    sql = (
        "SELECT playbook, inst_type, timeframe, count(*) AS rows, sum(baseline_label) AS wins, "
        "COALESCE(sum(baseline_net_r),0) AS sum_r, count(DISTINCT symbol) AS symbols, max(at) AS last_at "
        "FROM decision_tape GROUP BY playbook, inst_type, timeframe ORDER BY rows DESC"
    )
    return [
        {
            "nicheKey": f"{row['playbook']}|{row['inst_type']}|{row['timeframe']}",
            "playbook": row["playbook"],
            "instType": row["inst_type"],
            "timeframe": row["timeframe"],
            "rows": int(row["rows"]),
            "wins": int(row["wins"] or 0),
            "sumR": float(row["sum_r"] or 0.0),
            "symbols": int(row["symbols"] or 0),
            "lastAt": int(row["last_at"] or 0),
        }
        for row in reader.connect().execute(sql).fetchall()
    ]


def purged_walk_forward(
    at: np.ndarray, horizon_end: np.ndarray, folds: int, embargo_ms: int = 0
) -> list[tuple[np.ndarray, np.ndarray]]:
    """Chronological folds where a training row is dropped when its label was still
    unknown at the moment the test window opened. This is the only correct way to
    validate overlapping financial labels."""
    n = int(at.shape[0])
    if n < 80:
        return []
    fold_size = n // (folds + 1)
    if fold_size < 20:
        return []
    splits: list[tuple[np.ndarray, np.ndarray]] = []
    for fold in range(folds):
        train_end = fold_size * (fold + 1)
        test_end = n if fold == folds - 1 else fold_size * (fold + 2)
        test_idx = np.arange(train_end, test_end)
        if test_idx.size < 15:
            continue
        opens_at = at[train_end]
        candidate = np.arange(0, train_end)
        train_idx = candidate[horizon_end[candidate] + embargo_ms < opens_at]
        if train_idx.size < 40:
            continue
        splits.append((train_idx, test_idx))
    return splits
