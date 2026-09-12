"""Logging configuration for veyyon-rpc and clients — JSON to file, pretty ANSI to stdout."""

from __future__ import annotations

import json
import logging
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

_RESERVED = frozenset(
    {
        "args",
        "asctime",
        "created",
        "exc_info",
        "exc_text",
        "filename",
        "funcName",
        "levelname",
        "levelno",
        "lineno",
        "module",
        "msecs",
        "message",
        "msg",
        "name",
        "pathname",
        "process",
        "processName",
        "relativeCreated",
        "stack_info",
        "thread",
        "threadName",
    }
)

_RST = "\033[0m"
_DIM = "\033[2m"

_LEVEL_COLOR: dict[str, str] = {
    "DEBUG": "\033[36m",
    "INFO": "\033[32m",
    "WARNING": "\033[33m",
    "ERROR": "\033[31m",
    "CRITICAL": "\033[35m",
}

_PRETTY_SKIP = _RESERVED | {"color_message", "color_levelname"}


class PrettyFormatter(logging.Formatter):
    """Human-readable single-line formatter with ANSI colour."""

    def format(self, record: logging.LogRecord) -> str:  # noqa: A003
        color = _LEVEL_COLOR.get(record.levelname, "")
        time_str = datetime.fromtimestamp(record.created, tz=UTC).strftime("%H:%M:%S")
        head = f"{_DIM}{time_str}{_RST} {color}{record.levelname:<7}{_RST} {_DIM}{record.name}:{_RST} {record.getMessage()}"
        extras = {k: v for k, v in record.__dict__.items() if k not in _PRETTY_SKIP and not k.startswith("_")}
        if extras:
            extra_str = " ".join(f"{_DIM}{k}={_RST}{v}" for k, v in sorted(extras.items()))
            line = f"{head}  {extra_str}"
        else:
            line = head
        if record.exc_info:
            line += "\n" + self.formatException(record.exc_info)
        return line


class JsonFormatter(logging.Formatter):
    """Structured JSON formatter for persistent logs."""

    def format(self, record: logging.LogRecord) -> str:  # noqa: A003
        payload: dict[str, Any] = {
            "ts": datetime.fromtimestamp(record.created, tz=UTC).isoformat(),
            "level": record.levelname,
            "logger": record.name,
            "message": record.getMessage(),
        }
        for k, v in record.__dict__.items():
            if k not in _RESERVED and not k.startswith("_"):
                payload[k] = v
        if record.exc_info:
            payload["exc"] = self.formatException(record.exc_info)
        return json.dumps(payload, default=str)


_INITIALIZED = False


def configure_logging(
    log_dir: Path | None = None,
    level: int = logging.INFO,
    *,
    extra_filters: tuple[logging.Filter, ...] = (),
) -> None:
    """Idempotently configure logging: pretty ANSI to stdout, JSON to file."""
    global _INITIALIZED
    if _INITIALIZED:
        return

    root = logging.getLogger()
    root.setLevel(level)

    console = logging.StreamHandler()
    console.setLevel(level)
    console.setFormatter(PrettyFormatter())
    for filt in extra_filters:
        console.addFilter(filt)
    root.addHandler(console)

    if log_dir is not None:
        log_dir.mkdir(parents=True, exist_ok=True)
        file_handler = logging.FileHandler(log_dir / "veybot.log", encoding="utf-8")
        file_handler.setLevel(level)
        file_handler.setFormatter(JsonFormatter())
        for filt in extra_filters:
            file_handler.addFilter(filt)
        root.addHandler(file_handler)

    _INITIALIZED = True


def reset_logging_for_tests() -> None:
    global _INITIALIZED
    _INITIALIZED = False
    root = logging.getLogger()
    for handler in list(root.handlers):
        root.removeHandler(handler)


def get_logger(name: str) -> logging.Logger:
    return logging.getLogger(name)


__all__ = [
    "JsonFormatter",
    "PrettyFormatter",
    "configure_logging",
    "get_logger",
    "reset_logging_for_tests",
]
