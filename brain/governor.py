"""Resource governor: training must never starve the live decision loop."""
from __future__ import annotations

import os
import time
from typing import Any


def process_rss_mb() -> float:
    try:
        with open("/proc/self/statm", "r", encoding="utf-8") as handle:
            pages = int(handle.read().split()[1])
        return pages * os.sysconf("SC_PAGE_SIZE") / (1024 * 1024)
    except Exception:  # noqa: BLE001
        return 0.0


def host_free_mb() -> float:
    try:
        values = {}
        with open("/proc/meminfo", "r", encoding="utf-8") as handle:
            for line in handle:
                parts = line.split(":")
                if len(parts) == 2:
                    values[parts[0].strip()] = float(parts[1].strip().split()[0])
        available = values.get("MemAvailable") or values.get("MemFree") or 0.0
        return available / 1024
    except Exception:  # noqa: BLE001
        return 0.0


def load1() -> float:
    try:
        return os.getloadavg()[0]
    except Exception:  # noqa: BLE001
        return 0.0


def resource_snapshot() -> dict[str, Any]:
    return {
        "rssMb": round(process_rss_mb(), 1),
        "hostFreeMb": round(host_free_mb(), 1),
        "load1": round(load1(), 2),
        "cpuCount": os.cpu_count() or 1,
        "threads": int(os.environ.get("TORCH_NUM_THREADS", "4")),
    }


class Governor:
    """Blocks a queued job until the host has headroom, then lets it run."""

    def __init__(self, max_rss_mb: int = 2200, max_load: float = 6.0):
        self.max_rss_mb = max_rss_mb
        self.max_load = max_load
        self.last_wait_s = 0.0
        self.last_reason = "ok"

    def state(self) -> dict[str, Any]:
        return {
            "maxRssMb": self.max_rss_mb,
            "maxLoad": self.max_load,
            "lastWaitSeconds": round(self.last_wait_s, 2),
            "lastReason": self.last_reason,
        }

    def headroom(self) -> tuple[bool, str]:
        free = host_free_mb()
        if free and free < 400:
            return False, f"host_free_{int(free)}mb"
        current = load1()
        if current > self.max_load:
            return False, f"load_{current:.2f}"
        return True, "ok"

    def wait_for_headroom(self, job: Any = None, timeout_s: float = 90.0) -> None:
        started = time.time()
        while time.time() - started < timeout_s:
            ok, reason = self.headroom()
            self.last_reason = reason
            if ok:
                break
            if job is not None:
                job.message = f"waiting for resources ({reason})"
            time.sleep(2.0)
        self.last_wait_s = time.time() - started
