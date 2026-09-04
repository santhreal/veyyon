"""Aggregate token, cost, and tool-call metrics from agent session logs."""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path


SUPPORTED_USAGE_DIALECTS: tuple[str, ...] = ("omp",)


@dataclass(frozen=True)
class Usage:
    input_tokens: int
    output_tokens: int
    cache_tokens: int
    cost_usd: float
    tool_calls: dict[str, int]


def aggregate_usage(sessions_dir: Path | str, dialect: str) -> Usage:
    """Aggregate token usage and tool call counts across session transcripts."""
    if dialect not in SUPPORTED_USAGE_DIALECTS:
        supported = ", ".join(repr(d) for d in SUPPORTED_USAGE_DIALECTS)
        raise ValueError(
            f"Unsupported usage dialect {dialect!r}; expected one of: {supported}"
        )

    path = Path(sessions_dir)
    if not path.is_dir():
        return Usage(
            input_tokens=0,
            output_tokens=0,
            cache_tokens=0,
            cost_usd=0.0,
            tool_calls={},
        )

    if dialect == "omp":
        return _aggregate_omp_usage(path)

    raise ValueError(f"Unhandled usage dialect: {dialect!r}")


def _aggregate_omp_usage(sessions_dir: Path) -> Usage:
    n_input = 0
    n_output = 0
    n_cache = 0
    cost = 0.0
    tool_calls: dict[str, int] = {}

    for session_file in sorted(sessions_dir.glob("*.jsonl")):
        try:
            content = session_file.read_text(encoding="utf-8", errors="ignore")
        except OSError:
            continue

        for line in content.splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                entry = json.loads(line)
            except json.JSONDecodeError:
                continue
            if not isinstance(entry, dict):
                continue

            message = entry.get("message")
            if not isinstance(message, dict):
                continue
            if message.get("role") != "assistant":
                continue

            usage = message.get("usage")
            if isinstance(usage, dict):
                n_input += int(usage.get("input", 0) or 0)
                n_output += int(usage.get("output", 0) or 0)
                n_cache += int(usage.get("cacheRead", 0) or 0) + int(
                    usage.get("cacheWrite", 0) or 0
                )
                cost_dict = usage.get("cost")
                if isinstance(cost_dict, dict):
                    cost += float(cost_dict.get("total", 0.0) or 0.0)

            blocks = message.get("content")
            if isinstance(blocks, list):
                for block in blocks:
                    if not isinstance(block, dict):
                        continue
                    if block.get("type") == "toolCall":
                        name = block.get("name")
                        if isinstance(name, str) and name:
                            tool_calls[name] = tool_calls.get(name, 0) + 1

    return Usage(
        input_tokens=n_input,
        output_tokens=n_output,
        cache_tokens=n_cache,
        cost_usd=cost,
        tool_calls=tool_calls,
    )
