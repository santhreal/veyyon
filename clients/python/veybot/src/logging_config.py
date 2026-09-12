"""Logging configuration for veybot — JSON to file, pretty ANSI to stdout."""

from __future__ import annotations

import logging
import logging.handlers
import sys
from pathlib import Path

from veyyon_rpc.logging import (
    JsonFormatter,
    PrettyFormatter,
    get_logger,
)

_ACCESS_MUTE_PATHS = ("/api/status", "/api/logs", "/healthz", "/readyz")


class _MuteDashboardPolling(logging.Filter):
    """Drop uvicorn.access lines for high-frequency dashboard polling."""

    def filter(self, record: logging.LogRecord) -> bool:  # noqa: A003
        args = record.args
        if isinstance(args, tuple) and len(args) >= 3:
            method, path = args[1], args[2]
            if method == "GET" and isinstance(path, str):
                base = path.split("?", 1)[0]
                if base in _ACCESS_MUTE_PATHS:
                    return False
        return True


_INITIALIZED = False


def configure_logging(log_dir: Path | None = None, level: int = logging.INFO) -> None:
    """Idempotently configure logging: pretty ANSI to stdout, JSON to file."""
    global _INITIALIZED
    if _INITIALIZED:
        return
    root = logging.getLogger()
    root.setLevel(level)
    for handler in list(root.handlers):
        root.removeHandler(handler)

    stream = logging.StreamHandler(sys.stdout)
    stream.setFormatter(PrettyFormatter())
    root.addHandler(stream)

    if log_dir is not None:
        log_dir.mkdir(parents=True, exist_ok=True)
        file_handler = logging.handlers.RotatingFileHandler(
            log_dir / "veybot.log.jsonl",
            maxBytes=10 * 1024 * 1024,
            backupCount=5,
            encoding="utf-8",
        )
        file_handler.setFormatter(JsonFormatter())
        root.addHandler(file_handler)

    logging.getLogger("httpx").setLevel(logging.WARNING)
    logging.getLogger("httpcore").setLevel(logging.WARNING)
    logging.getLogger("uvicorn.access").addFilter(_MuteDashboardPolling())
    _INITIALIZED = True


def reset_logging_for_tests() -> None:
    global _INITIALIZED
    _INITIALIZED = False
    root = logging.getLogger()
    for handler in list(root.handlers):
        root.removeHandler(handler)


__all__ = [
    "JsonFormatter",
    "PrettyFormatter",
    "configure_logging",
    "get_logger",
    "reset_logging_for_tests",
]
