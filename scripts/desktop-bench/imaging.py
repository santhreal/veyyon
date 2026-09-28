"""PNG output for bench captures, written with zlib so the bench needs only numpy."""

from __future__ import annotations

import struct
import zlib

import numpy as np

from xdisplay import to_rgb


def _chunk(kind: bytes, data: bytes) -> bytes:
	return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)


def write_png(path: str, pixels: np.ndarray) -> None:
	"""Writes uint32 BGRX pixels (as captured) to an RGB PNG."""
	rgb = to_rgb(pixels)
	height, width, _ = rgb.shape
	raw = b"".join(b"\x00" + rgb[row].tobytes() for row in range(height))
	header = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
	with open(path, "wb") as handle:
		handle.write(b"\x89PNG\r\n\x1a\n")
		handle.write(_chunk(b"IHDR", header))
		handle.write(_chunk(b"IDAT", zlib.compress(raw, 6)))
		handle.write(_chunk(b"IEND", b""))


def read_png(path: str) -> np.ndarray:
	"""Reads a PNG this module wrote back into uint32 BGRX pixels."""
	with open(path, "rb") as handle:
		data = handle.read()
	if data[:8] != b"\x89PNG\r\n\x1a\n":
		raise ValueError(f"{path} is not a PNG")
	pos = 8
	width = height = 0
	idat = b""
	while pos < len(data):
		(length,) = struct.unpack(">I", data[pos : pos + 4])
		kind = data[pos + 4 : pos + 8]
		body = data[pos + 8 : pos + 8 + length]
		pos += 12 + length
		if kind == b"IHDR":
			width, height, depth, color, _c, _f, interlace = struct.unpack(">IIBBBBB", body)
			if depth != 8 or color != 2 or interlace != 0:
				raise ValueError(f"{path}: only 8-bit RGB non-interlaced PNGs are read")
		elif kind == b"IDAT":
			idat += body
	raw = zlib.decompress(idat)
	stride = width * 3
	rows = np.frombuffer(raw, dtype=np.uint8).reshape(height, stride + 1)
	if np.any(rows[:, 0] != 0):
		raise ValueError(f"{path}: only unfiltered PNG rows are read")
	rgb = rows[:, 1:].reshape(height, width, 3).astype(np.uint32)
	return (rgb[..., 0] << 16) | (rgb[..., 1] << 8) | rgb[..., 2]
