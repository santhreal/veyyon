#!/usr/bin/env python3
"""Scripted OpenAI-compatible streaming server for the desktop bench.

Serves `POST /v1/chat/completions` and `POST /v1/responses` as server-sent
events and `GET /v1/models`. A request that offers tools is a turn: it gets
the scripted reply, `--tokens` words from a vocabulary shuffled by `--seed`,
one word every `--rate-ms` after `--first-token-delay-ms`. A turn whose prompt
holds `--tool-marker` and whose history has no tool result yet gets one call
of the offered shell tool instead, sent whole after `--tool-call-delay-ms`. A
request without tools (title generation, summaries) gets a three-word reply at
once.

Every token is logged to `--log` as one JSON line with the CLOCK_MONOTONIC
time at which its bytes were handed to the socket, so a probe on the same host
reads send times on its own clock.
"""

from __future__ import annotations

import argparse
import json
import os
import random
import socket
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

VOCABULARY = (
	"parser arena span token buffer render frame layout glyph cursor window sidebar "
	"thread message stream socket commit branch review module crate struct method "
	"closure vector string format number column record schema entity region motion "
	"spring damping velocity theme palette border shadow margin padding gutter scroll "
	"viewport anchor offset cache revision snapshot reducer store action intent event"
).split()


def scripted_words(seed: int, count: int) -> list[str]:
	rng = random.Random(seed)
	return [rng.choice(VOCABULARY) for _ in range(count)]


class Log:
	def __init__(self, path: str) -> None:
		self._file = open(path, "a", buffering=1, encoding="utf-8")
		self._lock = threading.Lock()
		self._next_request = 0

	def request_id(self) -> int:
		with self._lock:
			self._next_request += 1
			return self._next_request

	def write(self, record: dict[str, Any]) -> None:
		line = json.dumps(record, separators=(",", ":"))
		with self._lock:
			self._file.write(line + "\n")


def last_user_text(body: dict[str, Any]) -> str:
	messages = body.get("messages")
	items = body.get("input")
	candidates: list[Any] = []
	if isinstance(messages, list):
		candidates = [m for m in messages if isinstance(m, dict) and m.get("role") == "user"]
	elif isinstance(items, list):
		candidates = [m for m in items if isinstance(m, dict) and m.get("role") == "user"]
	if not candidates:
		return ""
	content = candidates[-1].get("content")
	if isinstance(content, str):
		return content
	if isinstance(content, list):
		return " ".join(str(part.get("text", "")) for part in content if isinstance(part, dict))
	return ""


def offered_tools(body: dict[str, Any]) -> list[tuple[str, str]]:
	"""(name, type) of every tool the request offers, namespaces flattened.

	Codex sends its tools as an `additional_tools` input item rather than the
	top-level `tools` array, so both are read.
	"""
	found: list[tuple[str, str]] = []

	def walk(tools: Any) -> None:
		for tool in tools or []:
			if not isinstance(tool, dict):
				continue
			if tool.get("type") == "namespace":
				walk(tool.get("tools"))
				continue
			fn = tool.get("function")
			name = fn.get("name") if isinstance(fn, dict) else tool.get("name")
			if isinstance(name, str):
				found.append((name, str(tool.get("type", "function"))))

	walk(body.get("tools"))
	for item in body.get("input") or []:
		if isinstance(item, dict) and item.get("type") == "additional_tools":
			walk(item.get("tools"))
	return found


# Arguments for the shell tool each client offers: codex `shell` and
# `exec_command`, the veyyon `bash` tool.
SHELL_TOOL_ARGUMENTS = {
	"exec_command": {"cmd": "ls"},
	"shell": {"command": ["bash", "-lc", "ls"]},
	"shell_command": {"command": "ls"},
	"bash": {"command": "ls"},
}

# Codex code mode offers one custom `exec` tool that runs JavaScript calling
# the nested tools.
CODEX_EXEC_SOURCE = 'const listing = await tools.exec_command({ cmd: "ls" });\ntext(listing);\n'

TOOL_OUTPUT_TYPES = ("function_call_output", "custom_tool_call_output")


def tool_call(body: dict[str, Any], marker: str) -> tuple[str, str, str] | None:
	"""The (tool, input, kind) to call when the prompt holds the marker and no tool ran yet."""
	if not marker or marker not in last_user_text(body):
		return None
	messages = body.get("messages")
	items = body.get("input")
	last: Any = None
	if isinstance(messages, list) and messages:
		last = messages[-1]
	elif isinstance(items, list) and items:
		last = items[-1]
	if isinstance(last, dict) and (last.get("role") == "tool" or last.get("type") in TOOL_OUTPUT_TYPES):
		return None
	tools = offered_tools(body)
	if ("exec", "custom") in tools:
		return "exec", CODEX_EXEC_SOURCE, "custom"
	for name, _kind in tools:
		if name in SHELL_TOOL_ARGUMENTS:
			return name, json.dumps(SHELL_TOOL_ARGUMENTS[name]), "function"
	return None



class Handler(BaseHTTPRequestHandler):
	server_version = "desktop-bench-fake-llm/1"
	protocol_version = "HTTP/1.1"

	def log_message(self, fmt: str, *args: Any) -> None:  # noqa: D401 - silence stderr access log
		return

	@property
	def cfg(self) -> argparse.Namespace:
		return self.server.cfg  # type: ignore[attr-defined]

	@property
	def log(self) -> Log:
		return self.server.log  # type: ignore[attr-defined]

	def do_GET(self) -> None:
		if self.path.rstrip("/").endswith("/models"):
			body = json.dumps(
				{
					"object": "list",
					"data": [{"id": self.cfg.model, "object": "model", "created": 0, "owned_by": "bench"}],
				}
			).encode()
			self.send_response(200)
			self.send_header("Content-Type", "application/json")
			self.send_header("Content-Length", str(len(body)))
			self.end_headers()
			self.wfile.write(body)
			return
		self.send_error(404)

	def do_POST(self) -> None:
		length = int(self.headers.get("Content-Length") or 0)
		raw = self.rfile.read(length) if length else b""
		try:
			body = json.loads(raw or b"{}")
		except json.JSONDecodeError:
			self.send_error(400, "body is not JSON")
			return
		path = self.path.split("?", 1)[0].rstrip("/")
		if path.endswith("/chat/completions"):
			api = "chat"
		elif path.endswith("/responses"):
			api = "responses"
		else:
			self.send_error(404)
			return
		rid = self.log.request_id()
		if self.cfg.dump_requests:
			os.makedirs(self.cfg.dump_requests, exist_ok=True)
			with open(os.path.join(self.cfg.dump_requests, f"{rid:05d}-{api}.json"), "wb") as handle:
				handle.write(raw)
		tools = offered_tools(body)
		turn = bool(tools)
		words = scripted_words(self.cfg.seed, self.cfg.tokens) if turn else ["Bench", "title", "reply"]
		call = tool_call(body, self.cfg.tool_marker) if turn else None
		self.log.write(
			{
				"event": "request",
				"req": rid,
				"api": api,
				"turn": turn,
				"model": body.get("model"),
				"tools": [name for name, _kind in tools],
				"tool_call": call[0] if call else None,
				"prompt": last_user_text(body)[-200:],
				"t_ns": time.monotonic_ns(),
			}
		)
		self.connection.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
		self.send_response(200)
		self.send_header("Content-Type", "text/event-stream")
		self.send_header("Cache-Control", "no-cache")
		self.send_header("Transfer-Encoding", "chunked")
		self.send_header("Connection", "close")
		self.end_headers()
		self.close_connection = True
		try:
			if call is not None:
				self._stream_tool_call(rid, api, body, call)
			elif api == "chat":
				self._stream_chat(rid, body, words, turn)
			else:
				self._stream_responses(rid, body, words, turn)
			self._chunk(b"")
		except (BrokenPipeError, ConnectionResetError):
			self.log.write({"event": "aborted", "req": rid, "t_ns": time.monotonic_ns()})

	# Transport ---------------------------------------------------------------

	def _chunk(self, data: bytes) -> None:
		self.wfile.write(f"{len(data):x}\r\n".encode() + data + b"\r\n")
		self.wfile.flush()

	def _sse(self, payload: dict[str, Any], event: str | None = None) -> None:
		head = f"event: {event}\n" if event else ""
		self._chunk(f"{head}data: {json.dumps(payload, separators=(',', ':'))}\n\n".encode())

	@staticmethod
	def _wait_until(due_ns: float) -> None:
		"""Sleeps until CLOCK_MONOTONIC reaches `due_ns`, in steps short enough to send on time."""
		while True:
			now = time.monotonic_ns()
			if now >= due_ns:
				return
			time.sleep(min((due_ns - now) / 1e9, 0.002))

	def _pace(self, rid: int, words: list[str], turn: bool, emit) -> str:
		"""Emits each word on the fixed schedule and logs its send time."""
		start = time.monotonic_ns()
		delay_ns = self.cfg.first_token_delay_ms * 1_000_000 if turn else 0
		rate_ns = self.cfg.rate_ms * 1_000_000 if turn else 0
		text = ""
		for index, word in enumerate(words):
			piece = word if index == 0 else f" {word}"
			self._wait_until(start + delay_ns + index * rate_ns)
			emit(piece)
			sent = time.monotonic_ns()
			text += piece
			if turn:
				self.log.write({"event": "token", "req": rid, "i": index, "text": piece, "t_ns": sent})
		self.log.write({"event": "done", "req": rid, "tokens": len(words), "t_ns": time.monotonic_ns()})
		return text

	# Tool calls ----------------------------------------------------------------

	def _stream_tool_call(self, rid: int, api: str, body: dict[str, Any], call: tuple[str, str, str]) -> None:
		name, arguments, kind = call
		call_id = f"call_bench_{rid}"
		model = body.get("model") or self.cfg.model
		self._wait_until(time.monotonic_ns() + self.cfg.tool_call_delay_ms * 1_000_000)
		self.log.write({"event": "tool_call", "req": rid, "tool": name, "t_ns": time.monotonic_ns()})
		if api == "chat":
			cid = f"chatcmpl-bench-{rid}"
			base = {"id": cid, "object": "chat.completion.chunk", "created": int(time.time()), "model": model}
			delta = {
				"role": "assistant",
				"tool_calls": [
					{"index": 0, "id": call_id, "type": "function", "function": {"name": name, "arguments": arguments}}
				],
			}
			self._sse({**base, "choices": [{"index": 0, "delta": delta, "finish_reason": None}]})
			self._sse({**base, "choices": [{"index": 0, "delta": {}, "finish_reason": "tool_calls"}]})
			usage = {"prompt_tokens": 100, "completion_tokens": 10, "total_tokens": 110}
			self._sse({**base, "choices": [], "usage": usage})
			self._chunk(b"data: [DONE]\n\n")
			return
		resp_id = f"resp_bench_{rid}"
		item_id = f"fc_bench_{rid}"
		base = {"id": resp_id, "object": "response", "created_at": int(time.time()), "model": model}
		self._sse({"type": "response.created", "response": {**base, "status": "in_progress", "output": []}}, "response.created")
		if kind == "custom":
			item = {"id": item_id, "type": "custom_tool_call", "status": "in_progress", "call_id": call_id, "name": name, "input": ""}
			delta_type, done_type, done_key = (
				"response.custom_tool_call_input.delta",
				"response.custom_tool_call_input.done",
				"input",
			)
		else:
			item = {"id": item_id, "type": "function_call", "status": "in_progress", "call_id": call_id, "name": name, "arguments": ""}
			delta_type, done_type, done_key = (
				"response.function_call_arguments.delta",
				"response.function_call_arguments.done",
				"arguments",
			)
		self._sse({"type": "response.output_item.added", "output_index": 0, "item": item}, "response.output_item.added")
		self._sse({"type": delta_type, "item_id": item_id, "output_index": 0, "delta": arguments}, delta_type)
		self._sse({"type": done_type, "item_id": item_id, "output_index": 0, done_key: arguments}, done_type)
		done_item = {**item, "status": "completed", done_key: arguments}
		self._sse({"type": "response.output_item.done", "output_index": 0, "item": done_item}, "response.output_item.done")
		usage = {
			"input_tokens": 100,
			"input_tokens_details": {"cached_tokens": 0},
			"output_tokens": 10,
			"output_tokens_details": {"reasoning_tokens": 0},
			"total_tokens": 110,
		}
		self._sse(
			{"type": "response.completed", "response": {**base, "status": "completed", "output": [done_item], "usage": usage}},
			"response.completed",
		)

	# Chat completions ----------------------------------------------------------

	def _stream_chat(self, rid: int, body: dict[str, Any], words: list[str], turn: bool) -> None:
		cid = f"chatcmpl-bench-{rid}"
		model = body.get("model") or self.cfg.model
		created = int(time.time())

		def chunk(delta: dict[str, Any], finish: str | None = None) -> dict[str, Any]:
			return {
				"id": cid,
				"object": "chat.completion.chunk",
				"created": created,
				"model": model,
				"choices": [{"index": 0, "delta": delta, "finish_reason": finish}],
			}

		self._sse(chunk({"role": "assistant", "content": ""}))
		self._pace(rid, words, turn, lambda piece: self._sse(chunk({"content": piece})))
		self._sse(chunk({}, "stop"))
		usage = {"prompt_tokens": 100, "completion_tokens": len(words), "total_tokens": 100 + len(words)}
		self._sse({"id": cid, "object": "chat.completion.chunk", "created": created, "model": model, "choices": [], "usage": usage})
		self._chunk(b"data: [DONE]\n\n")

	# Responses -----------------------------------------------------------------

	def _stream_responses(self, rid: int, body: dict[str, Any], words: list[str], turn: bool) -> None:
		resp_id = f"resp_bench_{rid}"
		item_id = f"msg_bench_{rid}"
		model = body.get("model") or self.cfg.model
		base = {"id": resp_id, "object": "response", "created_at": int(time.time()), "model": model}
		self._sse({"type": "response.created", "response": {**base, "status": "in_progress", "output": []}}, "response.created")
		item = {"id": item_id, "type": "message", "role": "assistant", "status": "in_progress", "content": []}
		self._sse({"type": "response.output_item.added", "output_index": 0, "item": item}, "response.output_item.added")
		part = {"type": "output_text", "text": "", "annotations": []}
		self._sse(
			{"type": "response.content_part.added", "item_id": item_id, "output_index": 0, "content_index": 0, "part": part},
			"response.content_part.added",
		)
		text = self._pace(
			rid,
			words,
			turn,
			lambda piece: self._sse(
				{
					"type": "response.output_text.delta",
					"item_id": item_id,
					"output_index": 0,
					"content_index": 0,
					"delta": piece,
				},
				"response.output_text.delta",
			),
		)
		done_part = {"type": "output_text", "text": text, "annotations": []}
		self._sse(
			{"type": "response.output_text.done", "item_id": item_id, "output_index": 0, "content_index": 0, "text": text},
			"response.output_text.done",
		)
		self._sse(
			{"type": "response.content_part.done", "item_id": item_id, "output_index": 0, "content_index": 0, "part": done_part},
			"response.content_part.done",
		)
		done_item = {**item, "status": "completed", "content": [done_part]}
		self._sse({"type": "response.output_item.done", "output_index": 0, "item": done_item}, "response.output_item.done")
		usage = {
			"input_tokens": 100,
			"input_tokens_details": {"cached_tokens": 0},
			"output_tokens": len(words),
			"output_tokens_details": {"reasoning_tokens": 0},
			"total_tokens": 100 + len(words),
		}
		self._sse(
			{"type": "response.completed", "response": {**base, "status": "completed", "output": [done_item], "usage": usage}},
			"response.completed",
		)


def main() -> None:
	parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
	parser.add_argument("--host", default="127.0.0.1")
	parser.add_argument("--port", type=int, default=0, help="0 picks a free port")
	parser.add_argument("--log", required=True, help="JSON-lines request and token log")
	parser.add_argument("--port-file", help="file the bound port is written to once listening")
	parser.add_argument("--tokens", type=int, default=60)
	parser.add_argument("--rate-ms", type=float, default=100.0)
	parser.add_argument("--first-token-delay-ms", type=float, default=1500.0)
	parser.add_argument("--seed", type=int, default=7)
	parser.add_argument("--dump-requests", help="directory each request body is written to")
	parser.add_argument("--model", default="bench-model")
	parser.add_argument(
		"--tool-marker",
		default="BENCHTOOL",
		help="a turn whose prompt holds this word first calls the offered shell tool",
	)
	parser.add_argument(
		"--tool-call-delay-ms",
		type=float,
		default=0.0,
		help="how long a turn waits before its tool call is sent",
	)
	cfg = parser.parse_args()

	server = ThreadingHTTPServer((cfg.host, cfg.port), Handler)
	server.daemon_threads = True
	server.cfg = cfg  # type: ignore[attr-defined]
	server.log = Log(cfg.log)  # type: ignore[attr-defined]
	port = server.server_address[1]
	if cfg.port_file:
		with open(cfg.port_file + ".tmp", "w", encoding="utf-8") as handle:
			handle.write(f"{port}\n")
		os.replace(cfg.port_file + ".tmp", cfg.port_file)
	server.log.write({"event": "listening", "port": port, "t_ns": time.monotonic_ns()})  # type: ignore[attr-defined]
	server.serve_forever()


if __name__ == "__main__":
	main()
