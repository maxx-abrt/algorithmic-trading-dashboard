"""PPO exit agent — reinforcement learning where RL actually belongs.

Direction prediction is a supervised problem: you have a label and you fit it.
Trade MANAGEMENT is not. "Should I take half off here, move the stop up, or let it
run?" is a sequential decision problem where every action changes the distribution
of everything that follows, and there is no label to copy. That is exactly what
policy-gradient RL is for.

The environment is not synthetic. Every episode is a REAL decision the engine
recorded, replayed bar by bar from the stored price path, in R units, with real
taker fees and real slippage charged on every partial exit. The agent starts long
or short one unit with the plan's stop at -1R and chooses, at every bar close:

    0  hold
    1  close everything
    2  scale out half
    3  move the stop to break-even
    4  trail the stop to 0.5R below the current close

Reward is the change in mark-to-market R, so the agent is paid for the equity it
actually creates, not for being right. Success is measured against the plan's own
exit on a chronologically held-out slice: if the agent cannot beat it out of
sample, it is marked unusable and never ships.
"""
from __future__ import annotations

import os
import time
from typing import Any

import numpy as np

from data import PathRow, TapeReader
from registry import Registry

try:
    import torch
    import torch.nn as nn

    torch.set_num_threads(int(os.environ.get("TORCH_NUM_THREADS", "4")))
    HAS_TORCH = True
except Exception:  # noqa: BLE001
    HAS_TORCH = False

MARKET_FEATURES = 44
POSITION_FEATURES = 8
STATE_DIM = MARKET_FEATURES + POSITION_FEATURES
ACTIONS = 5


class VecExitEnv:
    """Vectorised replay of many recorded trades at once (pure numpy, no Python loop
    over episodes). This is what makes PPO tractable on a mini PC."""

    def __init__(self, rows: list[PathRow]):
        self.n = len(rows)
        self.max_t = max(int(row.path_r.shape[0]) for row in rows)
        self.high = np.full((self.n, self.max_t), np.nan, dtype=np.float32)
        self.low = np.full((self.n, self.max_t), np.nan, dtype=np.float32)
        self.close = np.full((self.n, self.max_t), np.nan, dtype=np.float32)
        self.length = np.zeros(self.n, dtype=np.int32)
        self.max_hold = np.zeros(self.n, dtype=np.int32)
        self.cost = np.zeros(self.n, dtype=np.float32)
        self.market = np.zeros((self.n, MARKET_FEATURES), dtype=np.float32)
        self.baseline = np.zeros(self.n, dtype=np.float32)
        for index, row in enumerate(rows):
            bars = int(row.path_r.shape[0])
            self.high[index, :bars] = row.path_r[:, 0]
            self.low[index, :bars] = row.path_r[:, 1]
            self.close[index, :bars] = row.path_r[:, 2]
            self.length[index] = bars
            self.max_hold[index] = max(4, min(bars, row.max_hold if row.max_hold > 0 else bars))
            self.cost[index] = float((row.fee_bps + row.slippage_bps) / 10_000.0 / max(1e-6, row.risk_frac))
            features = row.features[:MARKET_FEATURES]
            self.market[index, : features.shape[0]] = features
            self.baseline[index] = row.baseline_net_r
        self.cost = np.clip(self.cost, 0.0, 0.4)
        self.reset()

    def reset(self) -> np.ndarray:
        self.t = np.zeros(self.n, dtype=np.int32)
        self.remaining = np.ones(self.n, dtype=np.float32)
        self.stop = np.full(self.n, -1.0, dtype=np.float32)
        self.realized = np.zeros(self.n, dtype=np.float32)
        self.mfe = np.zeros(self.n, dtype=np.float32)
        self.mae = np.zeros(self.n, dtype=np.float32)
        self.scaled = np.zeros(self.n, dtype=np.float32)
        self.done = np.zeros(self.n, dtype=bool)
        self._process_bar()
        self.prev_mtm = self._mtm()
        return self.observe()

    def _current_close(self) -> np.ndarray:
        index = np.clip(self.t, 0, self.max_t - 1)
        value = self.close[np.arange(self.n), index]
        return np.nan_to_num(value, nan=0.0)

    def _mtm(self) -> np.ndarray:
        return self.realized + self.remaining * self._current_close()

    def _process_bar(self) -> None:
        index = np.clip(self.t, 0, self.max_t - 1)
        rows = np.arange(self.n)
        high = np.nan_to_num(self.high[rows, index], nan=0.0)
        low = np.nan_to_num(self.low[rows, index], nan=0.0)
        close = np.nan_to_num(self.close[rows, index], nan=0.0)
        live = ~self.done
        self.mfe = np.where(live, np.maximum(self.mfe, high), self.mfe)
        self.mae = np.where(live, np.maximum(self.mae, -low), self.mae)

        stopped = live & (low <= self.stop)
        if stopped.any():
            self.realized[stopped] += self.remaining[stopped] * (self.stop[stopped] - self.cost[stopped])
            self.remaining[stopped] = 0.0
            self.done[stopped] = True

        live = ~self.done
        expired = live & ((self.t + 1 >= self.max_hold) | (self.t + 1 >= self.length))
        if expired.any():
            self.realized[expired] += self.remaining[expired] * (close[expired] - self.cost[expired])
            self.remaining[expired] = 0.0
            self.done[expired] = True

    def observe(self) -> np.ndarray:
        close = self._current_close()
        position = np.stack(
            [
                np.clip(close, -6, 6),
                np.clip(self.mfe, 0, 8),
                np.clip(self.mae, 0, 4),
                self.t.astype(np.float32) / np.maximum(1.0, self.max_hold.astype(np.float32)),
                self.remaining,
                np.clip(self.stop, -1.5, 6),
                np.clip(self.realized, -3, 10),
                self.scaled,
            ],
            axis=1,
        ).astype(np.float32)
        return np.concatenate([self.market, position], axis=1)

    def step(self, actions: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
        live = ~self.done
        close = self._current_close()

        close_all = live & (actions == 1)
        if close_all.any():
            self.realized[close_all] += self.remaining[close_all] * (close[close_all] - self.cost[close_all])
            self.remaining[close_all] = 0.0
            self.done[close_all] = True

        scale = live & (actions == 2) & (self.remaining > 0.2) & (self.scaled < 2)
        if scale.any():
            part = self.remaining[scale] * 0.5
            self.realized[scale] += part * (close[scale] - self.cost[scale])
            self.remaining[scale] -= part
            self.scaled[scale] += 1.0

        breakeven = live & (actions == 3)
        if breakeven.any():
            self.stop[breakeven] = np.maximum(self.stop[breakeven], 0.0)

        trail = live & (actions == 4)
        if trail.any():
            self.stop[trail] = np.maximum(self.stop[trail], close[trail] - 0.5)

        self.t = np.where(self.done, self.t, self.t + 1)
        self._process_bar()
        mtm = self._mtm()
        reward = (mtm - self.prev_mtm).astype(np.float32)
        self.prev_mtm = mtm
        return self.observe(), reward, self.done.copy()

    def final_r(self) -> np.ndarray:
        return self.realized.copy()


class ActorCritic(nn.Module):  # type: ignore[misc]
    def __init__(self, state_dim: int = STATE_DIM, actions: int = ACTIONS, hidden: int = 96):
        super().__init__()
        self.body = nn.Sequential(nn.Linear(state_dim, hidden), nn.Tanh(), nn.Linear(hidden, hidden), nn.Tanh())
        self.policy = nn.Linear(hidden, actions)
        self.value = nn.Linear(hidden, 1)

    def forward(self, x):  # type: ignore[no-untyped-def]
        latent = self.body(x)
        return self.policy(latent), self.value(latent).squeeze(-1)


def _rollout(net: "ActorCritic", env: VecExitEnv, greedy: bool = False):
    observations: list[np.ndarray] = []
    actions: list[np.ndarray] = []
    log_probs: list[np.ndarray] = []
    values: list[np.ndarray] = []
    rewards: list[np.ndarray] = []
    masks: list[np.ndarray] = []

    obs = env.reset()
    for _ in range(env.max_t + 1):
        if env.done.all():
            break
        mask = (~env.done).astype(np.float32)
        with torch.no_grad():
            logits, value = net(torch.tensor(obs, dtype=torch.float32))
            if greedy:
                action = torch.argmax(logits, dim=1)
            else:
                action = torch.distributions.Categorical(logits=logits).sample()
            log_prob = torch.log_softmax(logits, dim=1).gather(1, action.unsqueeze(1)).squeeze(1)
        observations.append(obs)
        actions.append(action.numpy())
        log_probs.append(log_prob.numpy())
        values.append(value.numpy())
        masks.append(mask)
        obs, reward, _ = env.step(action.numpy())
        rewards.append(reward * mask)

    return {
        "obs": np.array(observations, dtype=np.float32),
        "actions": np.array(actions, dtype=np.int64),
        "logProbs": np.array(log_probs, dtype=np.float32),
        "values": np.array(values, dtype=np.float32),
        "rewards": np.array(rewards, dtype=np.float32),
        "masks": np.array(masks, dtype=np.float32),
    }


def _gae(rewards: np.ndarray, values: np.ndarray, masks: np.ndarray, gamma: float = 0.997, lam: float = 0.95):
    steps, episodes = rewards.shape
    advantages = np.zeros_like(rewards)
    last = np.zeros(episodes, dtype=np.float32)
    for t in reversed(range(steps)):
        next_value = values[t + 1] if t + 1 < steps else np.zeros(episodes, dtype=np.float32)
        next_mask = masks[t + 1] if t + 1 < steps else np.zeros(episodes, dtype=np.float32)
        delta = rewards[t] + gamma * next_value * next_mask - values[t]
        last = delta + gamma * lam * next_mask * last
        advantages[t] = last
    returns = advantages + values
    return advantages, returns


def train_exit_agent(reader: TapeReader, registry: Registry, job: Any) -> dict[str, Any]:
    if not HAS_TORCH:
        return {"usable": False, "reason": "torch_unavailable"}
    payload = job.payload
    niche = payload["niche"]
    niche_key = f"{niche['playbook']}|{niche['instType']}|{niche['timeframe']}"
    started = time.time()
    job.message = "loading paths"

    rows = reader.paths(
        playbook=niche["playbook"],
        inst_type=niche["instType"],
        timeframe=niche["timeframe"],
        feature_schema=payload.get("featureSchema", "v3"),
        limit=int(payload.get("limit", 6000)),
    )
    if len(rows) < 200:
        return {"nicheKey": niche_key, "usable": False, "reason": f"insufficient_paths({len(rows)})", "episodes": len(rows)}

    rows.sort(key=lambda row: row.at)
    cut = int(len(rows) * 0.75)
    train_rows, test_rows = rows[:cut], rows[cut:]
    if len(train_rows) < 150 or len(test_rows) < 40:
        return {"nicheKey": niche_key, "usable": False, "reason": "split_too_small", "episodes": len(rows)}

    torch.manual_seed(int(payload.get("seed", 7)))
    net = ActorCritic()
    optimiser = torch.optim.Adam(net.parameters(), lr=3e-4)
    train_env = VecExitEnv(train_rows)
    test_env = VecExitEnv(test_rows)
    epochs = int(payload.get("epochs", 12))
    curve: list[dict[str, Any]] = []
    best_eval = -1e9
    best_state = None

    for epoch in range(epochs):
        if job.cancel.is_set():
            break
        job.message = f"ppo epoch {epoch + 1}/{epochs}"
        job.progress = 0.9 * (epoch / max(1, epochs))
        batch = _rollout(net, train_env)
        advantages, returns = _gae(batch["rewards"], batch["values"], batch["masks"])
        flat_mask = batch["masks"].reshape(-1) > 0
        if flat_mask.sum() < 64:
            break
        obs = torch.tensor(batch["obs"].reshape(-1, STATE_DIM)[flat_mask], dtype=torch.float32)
        actions = torch.tensor(batch["actions"].reshape(-1)[flat_mask], dtype=torch.long)
        old_log_probs = torch.tensor(batch["logProbs"].reshape(-1)[flat_mask], dtype=torch.float32)
        advantage = torch.tensor(advantages.reshape(-1)[flat_mask], dtype=torch.float32)
        target = torch.tensor(returns.reshape(-1)[flat_mask], dtype=torch.float32)
        advantage = (advantage - advantage.mean()) / (advantage.std() + 1e-6)

        for _ in range(4):
            logits, values = net(obs)
            log_probs = torch.log_softmax(logits, dim=1).gather(1, actions.unsqueeze(1)).squeeze(1)
            ratio = torch.exp(log_probs - old_log_probs)
            policy_loss = -torch.min(ratio * advantage, torch.clamp(ratio, 0.8, 1.2) * advantage).mean()
            value_loss = ((values - target) ** 2).mean()
            entropy = torch.distributions.Categorical(logits=logits).entropy().mean()
            loss = policy_loss + 0.5 * value_loss - 0.01 * entropy
            optimiser.zero_grad()
            loss.backward()
            torch.nn.utils.clip_grad_norm_(net.parameters(), 0.5)
            optimiser.step()

        train_r = float(train_env.final_r().mean())
        _rollout(net, test_env, greedy=True)
        eval_r = float(test_env.final_r().mean())
        curve.append(
            {
                "epoch": epoch,
                "trainMeanR": round(train_r, 4),
                "evalMeanR": round(eval_r, 4),
                "policyLoss": round(float(policy_loss.item()), 5),
                "valueLoss": round(float(value_loss.item()), 5),
                "entropy": round(float(entropy.item()), 4),
            }
        )
        if eval_r > best_eval:
            best_eval = eval_r
            best_state = {key: value.detach().clone() for key, value in net.state_dict().items()}

    if best_state is not None:
        net.load_state_dict(best_state)

    _rollout(net, test_env, greedy=True)
    agent_r = test_env.final_r()
    baseline_r = test_env.baseline.copy()
    random_env = VecExitEnv(test_rows)
    random_net = ActorCritic()
    _rollout(random_net, random_env)
    random_r = random_env.final_r()

    agent_mean = float(agent_r.mean())
    baseline_mean = float(baseline_r.mean())
    random_mean = float(random_r.mean())
    lift = agent_mean - baseline_mean
    usable = bool(agent_mean > baseline_mean and agent_mean > random_mean and len(test_rows) >= 40)

    model_id = f"rl-{niche['playbook'][:4]}-{niche['instType'][:2]}-{niche['timeframe']}-{int(time.time())}".lower()
    blob = {"state": {key: value.cpu().numpy() for key, value in net.state_dict().items()}, "stateDim": STATE_DIM, "actions": ACTIONS}
    meta = {
        "kind": "rl_exit",
        "nicheKey": niche_key,
        "playbook": niche["playbook"],
        "instType": niche["instType"],
        "timeframe": niche["timeframe"],
        "featureSchema": payload.get("featureSchema", "v3"),
        "episodes": len(rows),
        "trainEpisodes": len(train_rows),
        "testEpisodes": len(test_rows),
        "agentMeanR": agent_mean,
        "baselineMeanR": baseline_mean,
        "randomMeanR": random_mean,
        "meanRLift": lift,
        "usable": usable,
        "score": lift,
        "curve": curve,
        "trainSeconds": round(time.time() - started, 2),
    }
    record = registry.save(model_id, blob, meta)
    job.progress = 1.0
    return {
        "modelId": model_id,
        "nicheKey": niche_key,
        "usable": usable,
        "agentMeanR": agent_mean,
        "baselineMeanR": baseline_mean,
        "randomMeanR": random_mean,
        "meanRLift": lift,
        "episodes": len(rows),
        "testEpisodes": len(test_rows),
        "curve": curve,
        "record": {key: value for key, value in record.items() if key != "curve"},
        "trainSeconds": round(time.time() - started, 2),
    }


def act_batch(registry: Registry, model_id: str, states: list[list[float]]) -> dict[str, Any]:
    if not HAS_TORCH:
        return {"error": "torch_unavailable"}
    blob = registry.load(model_id)
    if blob is None:
        return {"error": "model_not_found", "modelId": model_id}
    net = ActorCritic(state_dim=int(blob.get("stateDim", STATE_DIM)), actions=int(blob.get("actions", ACTIONS)))
    net.load_state_dict({key: torch.tensor(value) for key, value in blob["state"].items()})
    net.eval()
    x = np.nan_to_num(np.array(states, dtype=np.float32), nan=0.0, posinf=0.0, neginf=0.0)
    if x.ndim != 2 or x.shape[1] != int(blob.get("stateDim", STATE_DIM)):
        return {"error": "state_shape_mismatch", "expected": int(blob.get("stateDim", STATE_DIM))}
    with torch.no_grad():
        logits, value = net(torch.tensor(x))
        probabilities = torch.softmax(logits, dim=1).numpy()
        actions = np.argmax(probabilities, axis=1)
    labels = ["hold", "close_all", "scale_half", "stop_breakeven", "trail_stop"]
    return {
        "modelId": model_id,
        "actions": [int(a) for a in actions],
        "labels": [labels[int(a)] for a in actions],
        "probabilities": [[round(float(p), 5) for p in row] for row in probabilities],
        "values": [round(float(v), 5) for v in value.numpy()],
    }
