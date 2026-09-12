"""Retry and transient-error classification for veyyon-rpc and client transports."""

from __future__ import annotations

import asyncio
import time
from collections.abc import Callable, Coroutine, Mapping, Sequence
from typing import Any, TypeVar

T = TypeVar("T")

TRANSIENT_RETRY_DELAYS: tuple[float, ...] = (1.0, 3.0, 10.0)
_IDEMPOTENT_METHODS = frozenset({"GET", "HEAD", "OPTIONS", "TRACE"})


def is_transient_retryable(exc: BaseException, method: str = "GET") -> bool:
    """Whether `exc` is a transient transport error safe to retry for `method`.

    Idempotent reads retry through any transient connect/timeout error;
    non-idempotent writes retry ONLY on connection-establishment failures,
    never a read/write timeout that may have already applied the effect.
    """
    try:
        import httpx

        httpx_types: tuple[type[BaseException], ...] = (httpx.ConnectError, httpx.TimeoutException, ConnectionError, TimeoutError, OSError)
        connect_types: tuple[type[BaseException], ...] = (httpx.ConnectError, httpx.ConnectTimeout, httpx.PoolTimeout, ConnectionError, OSError)
    except ImportError:
        httpx_types = (ConnectionError, TimeoutError, OSError)
        connect_types = (ConnectionError, OSError)

    if not isinstance(exc, httpx_types):
        return False
    if method.upper() in _IDEMPOTENT_METHODS:
        return True
    return isinstance(exc, connect_types)


def parse_retry_after(resp_or_headers: Any) -> float | None:
    """Extract retry-after delay in seconds from HTTP headers or response object."""
    headers = getattr(resp_or_headers, "headers", resp_or_headers)
    if not isinstance(headers, Mapping):
        return None
    ra = headers.get("retry-after")
    if ra:
        try:
            return float(ra)
        except (ValueError, TypeError):
            pass
    reset = headers.get("x-ratelimit-reset")
    if reset:
        try:
            return max(0.0, float(reset) - time.time())
        except (ValueError, TypeError):
            pass
    return None


def retry_transient(
    func: Callable[[], T],
    *,
    method: str = "GET",
    delays: Sequence[float] = TRANSIENT_RETRY_DELAYS,
    on_retry: Callable[[BaseException, int, float], None] | None = None,
) -> T:
    """Execute synchronous callable with exponential backoff on transient errors."""
    last_exc: BaseException | None = None
    for attempt, delay in enumerate((*delays, None)):
        try:
            return func()
        except BaseException as exc:
            if not is_transient_retryable(exc, method):
                raise
            last_exc = exc
            if delay is None:
                break
            if on_retry is not None:
                on_retry(exc, attempt + 1, delay)
            time.sleep(delay)
    assert last_exc is not None
    raise last_exc


async def retry_transient_async(
    coro_fn: Callable[[], Coroutine[Any, Any, T]],
    *,
    method: str = "GET",
    delays: Sequence[float] = TRANSIENT_RETRY_DELAYS,
    on_retry: Callable[[BaseException, int, float], None] | None = None,
) -> T:
    """Execute asynchronous coroutine with exponential backoff on transient errors."""
    last_exc: BaseException | None = None
    for attempt, delay in enumerate((*delays, None)):
        try:
            return await coro_fn()
        except BaseException as exc:
            if not is_transient_retryable(exc, method):
                raise
            last_exc = exc
            if delay is None:
                break
            if on_retry is not None:
                on_retry(exc, attempt + 1, delay)
            await asyncio.sleep(delay)
    assert last_exc is not None
    raise last_exc


__all__ = [
    "TRANSIENT_RETRY_DELAYS",
    "is_transient_retryable",
    "parse_retry_after",
    "retry_transient",
    "retry_transient_async",
]
