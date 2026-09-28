"""A client of veyyon-desktop's driver socket (`VEYYON_DESKTOP_DRIVER`).

The socket takes one JSON request per line and answers each with one line
carrying the request's `id`. After `{"subscribe": "frames"}` it also sends
`{"event": "frame", "n": N, "t_ns": T}` for every frame the window paints,
with `t_ns` on CLOCK_MONOTONIC, the clock `time.monotonic_ns()` reads. The
client keeps every frame time it reads in `frames`.
"""

from __future__ import annotations

import json
import select
import socket
import time
from pathlib import Path


class Driver:
	"""One connection to the driver socket of a running veyyon-desktop."""

	def __init__(self, path: Path, timeout_s: float = 30.0) -> None:
		deadline = time.monotonic() + timeout_s
		while True:
			sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
			try:
				sock.connect(str(path))
				break
			except OSError as error:
				sock.close()
				if time.monotonic() > deadline:
					raise TimeoutError(f"the driver socket {path} did not accept within {timeout_s:.0f} s") from error
				time.sleep(0.05)
		self.sock = sock
		self.buffer = b""
		self.frames: list[int] = []
		self.last_id = 0

	def close(self) -> None:
		self.sock.close()

	def pump(self, timeout_s: float) -> list[dict]:
		"""Reads what arrives within `timeout_s`: the replies read, frame events kept in `frames`."""
		ready, _, _ = select.select([self.sock], [], [], max(0.0, timeout_s))
		if not ready:
			return []
		chunk = self.sock.recv(1 << 16)
		if not chunk:
			raise ConnectionError("the app closed the driver socket")
		*lines, self.buffer = (self.buffer + chunk).split(b"\n")
		replies: list[dict] = []
		for line in lines:
			if not line.strip():
				continue
			message = json.loads(line)
			if message.get("event") == "frame":
				self.frames.append(int(message["t_ns"]))
			else:
				replies.append(message)
		return replies

	def request(self, body: dict, timeout_s: float = 30.0) -> dict:
		"""Sends `body` and returns its reply; an `error` reply raises."""
		self.last_id += 1
		ident = self.last_id
		self.sock.sendall((json.dumps({"id": ident, **body}) + "\n").encode())
		deadline = time.monotonic() + timeout_s
		while True:
			for reply in self.pump(deadline - time.monotonic()):
				if reply.get("id") != ident:
					continue
				if "error" in reply:
					raise RuntimeError(f"the driver answered {body} with {reply['error']!r}")
				return reply
			if time.monotonic() >= deadline:
				raise TimeoutError(f"the driver did not answer {body} within {timeout_s:.0f} s")

	def bounds(self, target: str) -> dict | None:
		"""The window bounds of `target`, or None when it is not laid out."""
		try:
			return self.request({"bounds": target})["bounds"]
		except RuntimeError:
			return None

	def idle(self, timeout_s: float = 30.0) -> None:
		"""Returns once the window requests no frame and runs no motion."""
		self.request({"wait": "idle"}, timeout_s)

	def frames_until_quiet(self, since_ns: int, quiet_ms: int, timeout_s: float) -> list[int]:
		"""The frame times after `since_ns`, read until `quiet_ms` pass without a frame."""
		quiet = quiet_ms * 1_000_000
		limit = since_ns + int(timeout_s * 1e9)
		while True:
			self.pump(0.005)
			now = time.monotonic_ns()
			after = [t for t in self.frames if t > since_ns]
			if after and now - after[-1] >= quiet:
				return after
			if now >= limit:
				return after
