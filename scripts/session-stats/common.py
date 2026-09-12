"""
Shared utilities for scripts/session-stats/ analysis and plotting tools.
"""

from __future__ import annotations

import argparse
import re
import sqlite3
import sys
import time
from pathlib import Path
from typing import Any

DB_PATH = Path.home() / ".veyyon" / "stats.db"

RANGE_RE = re.compile(r"^(\d+)(?:([-+])(\d+))?$")
DEFAULT_PAGE = 500


def parse_path_range(path: str, default_page: int = DEFAULT_PAGE) -> tuple[str, int | None, int | None, str]:
    """Parse path selector into (base_path, start, end, kind)."""
    if not path:
        return path, None, None, "none"
    tail_idx = path.rfind("/")
    tail = path[tail_idx + 1 :]
    colon = tail.rfind(":")
    if colon < 0:
        return path, None, None, "none"
    suffix = tail[colon + 1 :]
    base = (path[: tail_idx + 1] + tail[:colon]) if tail_idx >= 0 else tail[:colon]
    if suffix == "raw":
        return base, None, None, "raw"
    if suffix == "conflicts":
        return base, None, None, "conflicts"
    m = RANGE_RE.match(suffix)
    if not m:
        return path, None, None, "none"
    start = int(m.group(1))
    op = m.group(2)
    nval = m.group(3)
    if op == "-" and nval is not None:
        return base, start, int(nval), "range"
    if op == "+" and nval is not None:
        return base, start, start + int(nval) - 1, "range"
    return base, start, start + default_page - 1, "range"


def open_ro(db_path: Path = DB_PATH) -> sqlite3.Connection:
    if not db_path.exists():
        sys.exit(f"db not found: {db_path}. Run sync.py first.")
    conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row
    return conn


def commas(n: int | float) -> str:
    if isinstance(n, float):
        return f"{n:,.1f}"
    return f"{n:,}"


def pct(part: int | float, total: int | float) -> float:
    return 0.0 if total == 0 else (100.0 * part / total)


def thousands(v: float, _=None) -> str:
    return f"{v / 1e3:.0f}k"


def millions(v: float, _=None) -> str:
    return f"{v / 1e6:.1f}M"


def truncate_line(s: str, n: int) -> str:
    s = s.replace("\n", " | ")
    if len(s) <= n:
        return s
    return s[: n - 1] + "…"


def parse_bucket(spec: str) -> int:
    """`h`,`d`,`w`,`m`,`<N>h`,`<N>d`,`<N>w` -> seconds."""
    units = {"h": 3600, "d": 86400, "w": 604800, "m": 2592000, "hour": 3600, "day": 86400, "week": 604800}
    if spec in units:
        return units[spec]
    if spec[-1] in units and spec[:-1].isdigit():
        return int(spec[:-1]) * units[spec[-1]]
    raise ValueError(f"bad --by spec: {spec}")


def since_cutoff_ms(args: argparse.Namespace) -> int | None:
    """Resolve --since spec (h/d/w/m/<N>{h,d,w}) to an epoch-ms cutoff, or None."""
    spec = getattr(args, "since", None)
    if not spec:
        return None
    return int(time.time() * 1000) - parse_bucket(spec) * 1000


def percentile(values: list[int] | list[float], p: float) -> float:
    if not values:
        return 0.0
    s = sorted(values)
    k = (len(s) - 1) * (p / 100.0)
    lo, hi = int(k), min(int(k) + 1, len(s) - 1)
    if lo == hi:
        return float(s[lo])
    return s[lo] + (s[hi] - s[lo]) * (k - lo)


def smooth_nan(arr: Any, window: int) -> Any:
    """Moving average along 1-D array ignoring NaNs."""
    import numpy as np

    out = np.full_like(arr, np.nan, dtype=float)
    half = window // 2
    n = len(arr)
    for i in range(n):
        lo = max(0, i - half)
        hi = min(n, i + half + 1)
        chunk = arr[lo:hi]
        valid = chunk[~np.isnan(chunk)]
        if len(valid) >= max(1, window // 3):
            out[i] = float(np.mean(valid))
    return out


def parse_iso_ms(s: str | None) -> int:
    if not s:
        return 0
    try:
        if s.endswith("Z"):
            s = s[:-1] + "+00:00"
        from datetime import datetime

        return int(datetime.fromisoformat(s).timestamp() * 1000)
    except Exception:
        return 0


_RE_FAILURE_HEAD = re.compile(
    r"^(edit rejected|error\b|failed\b|invalid\b|unrecognized\b|cannot\b|"
    r"no enclosing|file has been (modified|changed)|file has not been read|"
    r"permission denied|tool execution was aborted|request was aborted|"
    r"cancelled|canceled|line \d+:|expected|unexpected|patch failed|"
    r"no replacements|0 matches)",
    re.IGNORECASE,
)


def looks_successful(text: str) -> bool:
    if not text:
        return False
    head = ""
    for ln in text.split("\n"):
        if ln.strip():
            head = ln
            break
    if not head:
        return False
    return _RE_FAILURE_HEAD.match(head.lstrip()) is None


def extract_warnings(text: str) -> list[str]:
    out: list[str] = []
    for ln in text.split("\n"):
        t = ln.lstrip()
        if t.startswith("Auto-rebased anchor"):
            out.append("auto-rebased")
        elif t.startswith("Auto-absorbed"):
            out.append("auto-absorbed")
        elif t.startswith("Auto-dropped"):
            out.append("auto-dropped")
    return out


def find_longest_repeat(block: list[str], min_len: int = 4) -> tuple[int, int] | None:
    """Returns (start_index, repeat_len) if a repeat of >= min_len with at least
    half meaningful lines exists. O(n^2) per block — fine for typical edits."""
    n = len(block)
    if n < 2 * min_len:
        return None
    best: tuple[int, int] | None = None
    for i in range(n - min_len + 1):
        for j in range(i + min_len, n - min_len + 1):
            k = 0
            while i + k < j and j + k < n and block[i + k] == block[j + k]:
                k += 1
            if k < min_len:
                continue
            meaningful = sum(1 for s in block[i : i + k] if len(s.strip()) >= 4)
            if meaningful < max((k + 1) // 2, 2):
                continue
            if best is None or k > best[1]:
                best = (i, k)
    return best
