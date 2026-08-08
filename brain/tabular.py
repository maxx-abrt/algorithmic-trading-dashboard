"""Tabular learners: ridge logistic, LightGBM and a PyTorch MLP.

Why three model classes instead of one
--------------------------------------
The engine already had a single ridge logistic regression whose "evolution" only
mutated a feature mask. That family cannot represent an interaction like
"breakout works when volatility is compressed AND the book is thin AND it is the
London/New York overlap". Trees can. A small MLP can. And because different
families make different mistakes, averaging their calibrated probabilities is a
free variance reduction.

Everything is validated with PURGED walk-forward folds and judged on an economic
metric, not just log-loss: the mean net R of the trades the model would actually
have taken, minus the mean net R of taking everything. If that number is not
positive out of sample, the model is marked unusable and never ships.
"""
from __future__ import annotations

import math
import os
import time
from typing import Any

import numpy as np

from data import TapeBatch, TapeReader, purged_walk_forward
from registry import Registry

os.environ.setdefault("OMP_NUM_THREADS", "4")

try:
    import lightgbm as lgb

    HAS_LGB = True
except Exception:  # noqa: BLE001
    HAS_LGB = False

try:
    import torch
    import torch.nn as nn

    torch.set_num_threads(int(os.environ.get("TORCH_NUM_THREADS", "4")))
    HAS_TORCH = True
except Exception:  # noqa: BLE001
    HAS_TORCH = False


# --------------------------------------------------------------------------- #
#  Metrics                                                                     #
# --------------------------------------------------------------------------- #

def _auc(scores: np.ndarray, labels: np.ndarray) -> float:
    positives = scores[labels == 1]
    negatives = scores[labels == 0]
    if positives.size == 0 or negatives.size == 0:
        return 0.5
    order = np.argsort(scores)
    ranks = np.empty_like(order, dtype=np.float64)
    ranks[order] = np.arange(1, scores.size + 1)
    positive_rank_sum = ranks[labels == 1].sum()
    return float((positive_rank_sum - positives.size * (positives.size + 1) / 2) / (positives.size * negatives.size))


def _brier(probabilities: np.ndarray, labels: np.ndarray) -> float:
    return float(np.mean((probabilities - labels) ** 2))


def _economics(probabilities: np.ndarray, net_r: np.ndarray, quantile: float) -> dict[str, float]:
    if probabilities.size == 0:
        return {"threshold": 0.5, "coverage": 0.0, "meanRTaken": 0.0, "meanRAll": 0.0, "meanRLift": 0.0, "sumRTaken": 0.0}
    threshold = float(np.quantile(probabilities, quantile))
    taken = probabilities >= threshold
    if taken.sum() < 5:
        taken = probabilities >= float(np.quantile(probabilities, 0.5))
    mean_all = float(np.mean(net_r))
    mean_taken = float(np.mean(net_r[taken])) if taken.sum() else 0.0
    return {
        "threshold": threshold,
        "coverage": float(taken.mean()),
        "meanRTaken": mean_taken,
        "meanRAll": mean_all,
        "meanRLift": mean_taken - mean_all,
        "sumRTaken": float(np.sum(net_r[taken])),
    }


# --------------------------------------------------------------------------- #
#  Learners                                                                    #
# --------------------------------------------------------------------------- #

class Standardiser:
    def __init__(self, x: np.ndarray):
        self.mean = x.mean(axis=0)
        self.scale = x.std(axis=0)
        self.scale[self.scale < 1e-6] = 1.0

    def __call__(self, x: np.ndarray) -> np.ndarray:
        return (x - self.mean) / self.scale


def fit_logistic(x: np.ndarray, y: np.ndarray, l2: float = 1e-3, epochs: int = 400, lr: float = 0.3) -> dict[str, Any]:
    scaler = Standardiser(x)
    xs = scaler(x)
    n, f = xs.shape
    weights = np.zeros(f, dtype=np.float64)
    bias = 0.0
    labels = y.astype(np.float64)
    for _ in range(epochs):
        logits = xs @ weights + bias
        predictions = 1.0 / (1.0 + np.exp(-np.clip(logits, -30, 30)))
        error = predictions - labels
        grad_w = xs.T @ error / n + l2 * weights
        grad_b = float(error.mean())
        weights -= lr * grad_w
        bias -= lr * grad_b
    return {"kind": "logistic", "mean": scaler.mean, "scale": scaler.scale, "weights": weights, "bias": bias}


def predict_logistic(model: dict[str, Any], x: np.ndarray) -> np.ndarray:
    xs = (x - model["mean"]) / model["scale"]
    logits = xs @ model["weights"] + model["bias"]
    return 1.0 / (1.0 + np.exp(-np.clip(logits, -30, 30)))


def fit_lightgbm(x: np.ndarray, y: np.ndarray, seed: int = 7) -> dict[str, Any] | None:
    if not HAS_LGB:
        return None
    rows = x.shape[0]
    params = {
        "objective": "binary",
        "learning_rate": 0.05,
        "num_leaves": 15 if rows < 2000 else 31,
        "min_data_in_leaf": max(20, rows // 60),
        "feature_fraction": 0.7,
        "bagging_fraction": 0.8,
        "bagging_freq": 1,
        "lambda_l2": 1.0,
        "verbose": -1,
        "num_threads": int(os.environ.get("OMP_NUM_THREADS", "4")),
        "seed": seed,
        "deterministic": True,
    }
    cut = int(rows * 0.85)
    train = lgb.Dataset(x[:cut], label=y[:cut])
    valid = lgb.Dataset(x[cut:], label=y[cut:], reference=train)
    try:
        booster = lgb.train(
            params,
            train,
            num_boost_round=400,
            valid_sets=[valid],
            callbacks=[lgb.early_stopping(40, verbose=False), lgb.log_evaluation(0)],
        )
    except Exception:  # noqa: BLE001
        return None
    return {"kind": "lightgbm", "booster": booster.model_to_string(), "bestIteration": int(booster.best_iteration or booster.current_iteration())}


def predict_lightgbm(model: dict[str, Any], x: np.ndarray) -> np.ndarray:
    booster = lgb.Booster(model_str=model["booster"])
    return np.asarray(booster.predict(x, num_iteration=model.get("bestIteration") or None), dtype=np.float64)


def fit_mlp(x: np.ndarray, y: np.ndarray, seed: int = 7, epochs: int = 120) -> dict[str, Any] | None:
    if not HAS_TORCH:
        return None
    torch.manual_seed(seed)
    scaler = Standardiser(x)
    xs = torch.tensor(scaler(x), dtype=torch.float32)
    ys = torch.tensor(y.astype(np.float32)).unsqueeze(1)
    hidden = 64 if x.shape[0] >= 1500 else 32
    net = nn.Sequential(
        nn.Linear(x.shape[1], hidden),
        nn.GELU(),
        nn.Dropout(0.15),
        nn.Linear(hidden, hidden // 2),
        nn.GELU(),
        nn.Linear(hidden // 2, 1),
    )
    positive = float(ys.mean().item())
    weight = torch.tensor([(1 - positive) / max(1e-3, positive)], dtype=torch.float32)
    loss_fn = nn.BCEWithLogitsLoss(pos_weight=weight)
    optimiser = torch.optim.AdamW(net.parameters(), lr=2e-3, weight_decay=1e-3)
    batch = min(512, max(64, xs.shape[0] // 8))
    cut = int(xs.shape[0] * 0.85)
    best_state = None
    best_loss = math.inf
    patience = 0
    for _ in range(epochs):
        net.train()
        permutation = torch.randperm(cut)
        for start in range(0, cut, batch):
            index = permutation[start : start + batch]
            optimiser.zero_grad()
            loss = loss_fn(net(xs[index]), ys[index])
            loss.backward()
            torch.nn.utils.clip_grad_norm_(net.parameters(), 1.0)
            optimiser.step()
        net.eval()
        with torch.no_grad():
            valid_loss = float(loss_fn(net(xs[cut:]), ys[cut:]).item()) if xs.shape[0] > cut else float(loss.item())
        if valid_loss < best_loss - 1e-4:
            best_loss = valid_loss
            best_state = {key: value.detach().clone() for key, value in net.state_dict().items()}
            patience = 0
        else:
            patience += 1
            if patience >= 12:
                break
    if best_state is not None:
        net.load_state_dict(best_state)
    net.eval()
    return {
        "kind": "mlp",
        "mean": scaler.mean,
        "scale": scaler.scale,
        "state": {key: value.cpu().numpy() for key, value in net.state_dict().items()},
        "layers": [x.shape[1], hidden, hidden // 2, 1],
    }


def _rebuild_mlp(model: dict[str, Any]):
    layers = model["layers"]
    net = nn.Sequential(
        nn.Linear(layers[0], layers[1]),
        nn.GELU(),
        nn.Dropout(0.0),
        nn.Linear(layers[1], layers[2]),
        nn.GELU(),
        nn.Linear(layers[2], layers[3]),
    )
    net.load_state_dict({key: torch.tensor(value) for key, value in model["state"].items()})
    net.eval()
    return net


def predict_mlp(model: dict[str, Any], x: np.ndarray) -> np.ndarray:
    net = _rebuild_mlp(model)
    xs = torch.tensor((x - model["mean"]) / model["scale"], dtype=torch.float32)
    with torch.no_grad():
        logits = net(xs).squeeze(1).numpy()
    return 1.0 / (1.0 + np.exp(-np.clip(logits, -30, 30)))


PREDICTORS = {"logistic": predict_logistic, "lightgbm": predict_lightgbm, "mlp": predict_mlp}
FITTERS = {"logistic": lambda x, y, seed: fit_logistic(x, y), "lightgbm": fit_lightgbm, "mlp": fit_mlp}


def _platt(probabilities: np.ndarray, labels: np.ndarray) -> tuple[float, float]:
    """One-dimensional logistic recalibration of raw scores."""
    z = np.log(np.clip(probabilities, 1e-6, 1 - 1e-6) / (1 - np.clip(probabilities, 1e-6, 1 - 1e-6)))
    a, b = 1.0, 0.0
    for _ in range(200):
        predictions = 1.0 / (1.0 + np.exp(-np.clip(a * z + b, -30, 30)))
        error = predictions - labels
        a -= 0.1 * float(np.mean(error * z))
        b -= 0.1 * float(np.mean(error))
    return float(a), float(b)


def apply_platt(probabilities: np.ndarray, a: float, b: float) -> np.ndarray:
    z = np.log(np.clip(probabilities, 1e-6, 1 - 1e-6) / (1 - np.clip(probabilities, 1e-6, 1 - 1e-6)))
    return 1.0 / (1.0 + np.exp(-np.clip(a * z + b, -30, 30)))


# --------------------------------------------------------------------------- #
#  Training entry point                                                        #
# --------------------------------------------------------------------------- #

def train_tabular(reader: TapeReader, registry: Registry, job: Any) -> dict[str, Any]:
    payload = job.payload
    niche = payload["niche"]
    niche_key = f"{niche['playbook']}|{niche['instType']}|{niche['timeframe']}"
    started = time.time()
    job.message = "loading tape"

    batch: TapeBatch = reader.batch(
        playbook=niche["playbook"],
        inst_type=niche["instType"],
        timeframe=niche["timeframe"],
        feature_schema=payload.get("featureSchema", "v3"),
        limit=int(payload.get("limit", 12000)),
        exclude_symbols=payload.get("holdoutSymbols") or [],
    )
    if len(batch) < 150:
        return {"nicheKey": niche_key, "usable": False, "reason": f"insufficient_rows({len(batch)})", "rows": len(batch)}

    x = batch.features.astype(np.float64)
    y = batch.labels.astype(np.float64)
    if y.sum() < 20 or (len(y) - y.sum()) < 20:
        return {"nicheKey": niche_key, "usable": False, "reason": "degenerate_labels", "rows": len(batch)}

    splits = purged_walk_forward(batch.at, batch.horizon_end, int(payload.get("folds", 4)))
    if not splits:
        return {"nicheKey": niche_key, "usable": False, "reason": "no_usable_folds", "rows": len(batch)}

    wanted = [name for name in payload.get("models", ["logistic", "lightgbm", "mlp"]) if name in FITTERS]
    seed = int(payload.get("seed", 7))
    per_model: dict[str, dict[str, Any]] = {}
    oos_predictions: dict[str, np.ndarray] = {name: np.full(len(batch), np.nan) for name in wanted}

    total_steps = max(1, len(splits) * len(wanted))
    step = 0
    for fold_index, (train_idx, test_idx) in enumerate(splits):
        for name in wanted:
            if job.cancel.is_set():
                break
            job.message = f"fold {fold_index + 1}/{len(splits)} · {name}"
            fitted = FITTERS[name](x[train_idx], y[train_idx], seed + fold_index)
            step += 1
            job.progress = 0.9 * step / total_steps
            if fitted is None:
                continue
            probabilities = PREDICTORS[name](fitted, x[test_idx])
            oos_predictions[name][test_idx] = probabilities
            record = per_model.setdefault(name, {"folds": []})
            record["folds"].append(
                {
                    "fold": fold_index,
                    "trainRows": int(train_idx.size),
                    "testRows": int(test_idx.size),
                    "auc": _auc(probabilities, y[test_idx].astype(int)),
                    "brier": _brier(probabilities, y[test_idx]),
                    **_economics(probabilities, batch.net_r[test_idx].astype(np.float64), 0.7),
                }
            )

    results: dict[str, Any] = {}
    for name, record in per_model.items():
        mask = ~np.isnan(oos_predictions[name])
        if mask.sum() < 40:
            continue
        probabilities = oos_predictions[name][mask]
        labels = y[mask]
        base_rate = float(labels.mean())
        baseline_brier = float(np.mean((base_rate - labels) ** 2))
        brier = _brier(probabilities, labels)
        economics = _economics(probabilities, batch.net_r[mask].astype(np.float64), 0.7)
        folds_positive = sum(1 for fold in record["folds"] if fold["meanRLift"] > 0)
        results[name] = {
            "auc": _auc(probabilities, labels.astype(int)),
            "brier": brier,
            "baselineBrier": baseline_brier,
            "brierSkill": 1 - brier / baseline_brier if baseline_brier > 0 else 0.0,
            **economics,
            "oosRows": int(mask.sum()),
            "foldsPositive": folds_positive,
            "foldsTotal": len(record["folds"]),
            "folds": record["folds"],
        }

    if not results:
        return {"nicheKey": niche_key, "usable": False, "reason": "all_models_failed", "rows": len(batch)}

    # Ensemble of every model that produced a full out-of-sample column.
    stack = [oos_predictions[name] for name in results]
    ensemble_oos = np.nanmean(np.vstack(stack), axis=0)
    mask = ~np.isnan(ensemble_oos)
    ensemble_economics = _economics(ensemble_oos[mask], batch.net_r[mask].astype(np.float64), 0.7)
    ensemble_brier = _brier(ensemble_oos[mask], y[mask])
    base_rate = float(y[mask].mean())
    baseline_brier = float(np.mean((base_rate - y[mask]) ** 2))
    results["ensemble"] = {
        "auc": _auc(ensemble_oos[mask], y[mask].astype(int)),
        "brier": ensemble_brier,
        "baselineBrier": baseline_brier,
        "brierSkill": 1 - ensemble_brier / baseline_brier if baseline_brier > 0 else 0.0,
        **ensemble_economics,
        "oosRows": int(mask.sum()),
        "foldsPositive": 0,
        "foldsTotal": len(splits),
        "folds": [],
    }

    job.message = "refitting on all data"
    job.progress = 0.93
    final_models: dict[str, Any] = {}
    calibration: dict[str, tuple[float, float]] = {}
    for name in results:
        if name == "ensemble":
            continue
        fitted = FITTERS[name](x, y, seed)
        if fitted is None:
            continue
        final_models[name] = fitted
        mask_name = ~np.isnan(oos_predictions[name])
        if mask_name.sum() >= 60:
            calibration[name] = _platt(oos_predictions[name][mask_name], y[mask_name])

    ranked = sorted(
        (name for name in results if name != "ensemble"),
        key=lambda name: (results[name]["meanRLift"], results[name]["auc"]),
        reverse=True,
    )
    champion = "ensemble" if results["ensemble"]["meanRLift"] >= results[ranked[0]]["meanRLift"] else ranked[0]
    chosen = results[champion]
    usable = bool(chosen["meanRLift"] > 0 and chosen["auc"] > 0.5 and chosen["oosRows"] >= 60)

    importance = _feature_importance(final_models, x, y)

    model_id = f"tab-{niche['playbook'][:4]}-{niche['instType'][:2]}-{niche['timeframe']}-{int(time.time())}".lower()
    payload_blob = {
        "models": final_models,
        "calibration": calibration,
        "champion": champion,
        "threshold": chosen["threshold"],
        "featureCount": int(x.shape[1]),
    }
    meta = {
        "kind": "tabular",
        "nicheKey": niche_key,
        "playbook": niche["playbook"],
        "instType": niche["instType"],
        "timeframe": niche["timeframe"],
        "featureSchema": payload.get("featureSchema", "v3"),
        "featureCount": int(x.shape[1]),
        "rows": len(batch),
        "champion": champion,
        "threshold": chosen["threshold"],
        "metrics": {name: {k: v for k, v in value.items() if k != "folds"} for name, value in results.items()},
        "usable": usable,
        "score": float(chosen["meanRLift"]),
        "importance": importance,
        "trainSeconds": round(time.time() - started, 2),
        "hasLightGbm": HAS_LGB,
        "hasTorch": HAS_TORCH,
    }
    record = registry.save(model_id, payload_blob, meta)
    registry.prune(400)
    job.progress = 1.0
    return {
        "modelId": model_id,
        "nicheKey": niche_key,
        "usable": usable,
        "champion": champion,
        "threshold": chosen["threshold"],
        "rows": len(batch),
        "results": results,
        "importance": importance[:20],
        "record": {key: value for key, value in record.items() if key != "importance"},
        "trainSeconds": round(time.time() - started, 2),
    }


def _feature_importance(models: dict[str, Any], x: np.ndarray, y: np.ndarray) -> list[dict[str, Any]]:
    scores = np.zeros(x.shape[1], dtype=np.float64)
    used = 0
    if "lightgbm" in models and HAS_LGB:
        booster = lgb.Booster(model_str=models["lightgbm"]["booster"])
        gains = np.asarray(booster.feature_importance(importance_type="gain"), dtype=np.float64)
        if gains.sum() > 0:
            scores += gains / gains.sum()
            used += 1
    if "logistic" in models:
        weights = np.abs(models["logistic"]["weights"])
        if weights.sum() > 0:
            scores += weights / weights.sum()
            used += 1
    if used == 0:
        return []
    scores /= used
    order = np.argsort(-scores)
    return [{"index": int(index), "weight": float(scores[index])} for index in order[:40]]


def predict_batch(registry: Registry, model_id: str, features: list[list[float]]) -> dict[str, Any]:
    blob = registry.load(model_id)
    if blob is None:
        return {"error": "model_not_found", "modelId": model_id}
    meta = registry.get(model_id) or {}
    x = np.nan_to_num(np.array(features, dtype=np.float64), nan=0.0, posinf=0.0, neginf=0.0)
    expected = int(blob.get("featureCount", x.shape[1] if x.ndim == 2 else 0))
    if x.ndim != 2 or x.shape[1] != expected:
        return {"error": "feature_shape_mismatch", "expected": expected, "got": None if x.ndim != 2 else int(x.shape[1])}
    champion = blob.get("champion", "logistic")
    calibration = blob.get("calibration", {})
    columns: list[np.ndarray] = []
    per_model: dict[str, list[float]] = {}
    for name, model in blob["models"].items():
        try:
            raw = PREDICTORS[name](model, x)
        except Exception:  # noqa: BLE001
            continue
        if name in calibration:
            raw = apply_platt(raw, *calibration[name])
        columns.append(raw)
        per_model[name] = [round(float(value), 6) for value in raw]
    if not columns:
        return {"error": "no_predictor_available", "modelId": model_id}
    if champion == "ensemble" or champion not in per_model:
        final = np.mean(np.vstack(columns), axis=0)
    else:
        final = np.array(per_model[champion], dtype=np.float64)
    return {
        "modelId": model_id,
        "champion": champion,
        "threshold": float(blob.get("threshold", 0.5)),
        "probabilities": [round(float(value), 6) for value in final],
        "perModel": per_model,
        "nicheKey": meta.get("nicheKey"),
    }
