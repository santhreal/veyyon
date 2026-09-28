"""X11 access for the desktop bench: window lookup, XShm capture, XTest input.

Everything goes through ctypes over libX11, libXext and libXtst, so the bench
needs no Python X binding. Every app under test is an X11 client of the same
Xwayland server, so capture and input are the same code path for each.
"""

from __future__ import annotations

import ctypes
import time
from dataclasses import dataclass

import numpy as np

_X11 = ctypes.CDLL("libX11.so.6")
_XEXT = ctypes.CDLL("libXext.so.6")
_XTST = ctypes.CDLL("libXtst.so.6")
_LIBC = ctypes.CDLL("libc.so.6", use_errno=True)

c_int = ctypes.c_int
c_uint = ctypes.c_uint
c_ulong = ctypes.c_ulong
c_long = ctypes.c_long
c_void_p = ctypes.c_void_p
c_char_p = ctypes.c_char_p

Window = c_ulong
Atom = c_ulong

IS_VIEWABLE = 2
INPUT_OUTPUT = 1
Z_PIXMAP = 2
ALL_PLANES = c_ulong(0xFFFFFFFFFFFFFFFF)
IPC_PRIVATE = 0
IPC_CREAT = 0o1000
IPC_RMID = 0
ANY_PROPERTY_TYPE = 0


class XWindowAttributes(ctypes.Structure):
	_fields_ = [
		("x", c_int),
		("y", c_int),
		("width", c_int),
		("height", c_int),
		("border_width", c_int),
		("depth", c_int),
		("visual", c_void_p),
		("root", Window),
		("class_", c_int),
		("bit_gravity", c_int),
		("win_gravity", c_int),
		("backing_store", c_int),
		("backing_planes", c_ulong),
		("backing_pixel", c_ulong),
		("save_under", c_int),
		("colormap", c_ulong),
		("map_installed", c_int),
		("map_state", c_int),
		("all_event_masks", c_long),
		("your_event_mask", c_long),
		("do_not_propagate_mask", c_long),
		("override_redirect", c_int),
		("screen", c_void_p),
	]


class XImage(ctypes.Structure):
	_fields_ = [
		("width", c_int),
		("height", c_int),
		("xoffset", c_int),
		("format", c_int),
		("data", c_void_p),
		("byte_order", c_int),
		("bitmap_unit", c_int),
		("bitmap_bit_order", c_int),
		("bitmap_pad", c_int),
		("depth", c_int),
		("bytes_per_line", c_int),
		("bits_per_pixel", c_int),
		("red_mask", c_ulong),
		("green_mask", c_ulong),
		("blue_mask", c_ulong),
		("obdata", c_void_p),
		("f", c_void_p * 6),
	]


class XShmSegmentInfo(ctypes.Structure):
	_fields_ = [
		("shmseg", c_ulong),
		("shmid", c_int),
		("shmaddr", c_void_p),
		("readOnly", c_int),
	]


class XErrorEvent(ctypes.Structure):
	_fields_ = [
		("type", c_int),
		("display", c_void_p),
		("resourceid", c_ulong),
		("serial", c_ulong),
		("error_code", ctypes.c_ubyte),
		("request_code", ctypes.c_ubyte),
		("minor_code", ctypes.c_ubyte),
	]


def _sig(lib: ctypes.CDLL, name: str, restype, *argtypes) -> None:
	fn = getattr(lib, name)
	fn.restype = restype
	fn.argtypes = list(argtypes)


_sig(_X11, "XOpenDisplay", c_void_p, c_char_p)
_sig(_X11, "XCloseDisplay", c_int, c_void_p)
_sig(_X11, "XDefaultRootWindow", Window, c_void_p)
_sig(_X11, "XDefaultScreen", c_int, c_void_p)
_sig(_X11, "XFlush", c_int, c_void_p)
_sig(_X11, "XSync", c_int, c_void_p, c_int)
_sig(_X11, "XFree", c_int, c_void_p)
_sig(
	_X11,
	"XQueryTree",
	c_int,
	c_void_p,
	Window,
	ctypes.POINTER(Window),
	ctypes.POINTER(Window),
	ctypes.POINTER(ctypes.POINTER(Window)),
	ctypes.POINTER(c_uint),
)
_sig(_X11, "XGetWindowAttributes", c_int, c_void_p, Window, ctypes.POINTER(XWindowAttributes))
_sig(_X11, "XInternAtom", Atom, c_void_p, c_char_p, c_int)
_sig(
	_X11,
	"XGetWindowProperty",
	c_int,
	c_void_p,
	Window,
	Atom,
	c_long,
	c_long,
	c_int,
	Atom,
	ctypes.POINTER(Atom),
	ctypes.POINTER(c_int),
	ctypes.POINTER(c_ulong),
	ctypes.POINTER(c_ulong),
	ctypes.POINTER(c_void_p),
)
_sig(_X11, "XStringToKeysym", c_ulong, c_char_p)
_sig(_X11, "XKeysymToKeycode", ctypes.c_ubyte, c_void_p, c_ulong)
_sig(_X11, "XDestroyImage", c_int, ctypes.POINTER(XImage))
_ERROR_HANDLER = ctypes.CFUNCTYPE(c_int, c_void_p, ctypes.POINTER(XErrorEvent))
_sig(_X11, "XSetErrorHandler", c_void_p, _ERROR_HANDLER)
_sig(_XEXT, "XShmQueryExtension", c_int, c_void_p)
_sig(
	_XEXT,
	"XShmCreateImage",
	ctypes.POINTER(XImage),
	c_void_p,
	c_void_p,
	c_uint,
	c_int,
	c_void_p,
	ctypes.POINTER(XShmSegmentInfo),
	c_uint,
	c_uint,
)
_sig(_XEXT, "XShmAttach", c_int, c_void_p, ctypes.POINTER(XShmSegmentInfo))
_sig(_XEXT, "XShmDetach", c_int, c_void_p, ctypes.POINTER(XShmSegmentInfo))
_sig(_XEXT, "XShmGetImage", c_int, c_void_p, Window, ctypes.POINTER(XImage), c_int, c_int, c_ulong)
_sig(_XTST, "XTestFakeKeyEvent", c_int, c_void_p, c_uint, c_int, c_ulong)
_sig(_XTST, "XTestFakeButtonEvent", c_int, c_void_p, c_uint, c_int, c_ulong)
_sig(_XTST, "XTestFakeMotionEvent", c_int, c_void_p, c_int, c_int, c_int, c_ulong)
_sig(_LIBC, "shmget", c_int, c_int, ctypes.c_size_t, c_int)
_sig(_LIBC, "shmat", c_void_p, c_int, c_void_p, c_int)
_sig(_LIBC, "shmdt", c_int, c_void_p)
_sig(_LIBC, "shmctl", c_int, c_int, c_int, c_void_p)

_x_errors: list[tuple[int, int]] = []


@_ERROR_HANDLER
def _record_error(_display, event):
	_x_errors.append((event.contents.error_code, event.contents.request_code))
	return 0


_X11.XSetErrorHandler(_record_error)


def take_x_errors() -> list[tuple[int, int]]:
	"""The X errors raised since the last call, as (error code, request code)."""
	errors = list(_x_errors)
	_x_errors.clear()
	return errors


@dataclass(frozen=True)
class Rect:
	x: int
	y: int
	w: int
	h: int

	def to_json(self) -> dict[str, int]:
		return {"x": self.x, "y": self.y, "w": self.w, "h": self.h}


@dataclass(frozen=True)
class WindowInfo:
	id: int
	x: int
	y: int
	width: int
	height: int
	depth: int
	visual: int
	pid: int | None


class Display:
	"""One connection to an X display."""

	def __init__(self, name: str) -> None:
		self.name = name
		self.ptr = _X11.XOpenDisplay(name.encode())
		if not self.ptr:
			raise RuntimeError(f"cannot open X display {name}")
		if not _XEXT.XShmQueryExtension(self.ptr):
			raise RuntimeError(f"X display {name} has no MIT-SHM extension")
		self.root = _X11.XDefaultRootWindow(self.ptr)
		self._pid_atom = _X11.XInternAtom(self.ptr, b"_NET_WM_PID", 0)
		self._keycodes: dict[str, int] = {}

	def close(self) -> None:
		if self.ptr:
			_X11.XCloseDisplay(self.ptr)
			self.ptr = None

	def sync(self) -> None:
		_X11.XSync(self.ptr, 0)

	def flush(self) -> None:
		_X11.XFlush(self.ptr)

	def _window_pid(self, window: int) -> int | None:
		actual_type = Atom()
		actual_format = c_int()
		count = c_ulong()
		remaining = c_ulong()
		data = c_void_p()
		status = _X11.XGetWindowProperty(
			self.ptr,
			window,
			self._pid_atom,
			0,
			1,
			0,
			ANY_PROPERTY_TYPE,
			ctypes.byref(actual_type),
			ctypes.byref(actual_format),
			ctypes.byref(count),
			ctypes.byref(remaining),
			ctypes.byref(data),
		)
		if status != 0 or not data.value:
			return None
		try:
			if count.value < 1 or actual_format.value != 32:
				return None
			return int(ctypes.cast(data, ctypes.POINTER(c_ulong))[0])
		finally:
			_X11.XFree(data)

	def top_level_windows(self) -> list[WindowInfo]:
		"""Mapped InputOutput children of the root window, top of the stack last."""
		root_ret = Window()
		parent_ret = Window()
		children = ctypes.POINTER(Window)()
		count = c_uint()
		if not _X11.XQueryTree(
			self.ptr, self.root, ctypes.byref(root_ret), ctypes.byref(parent_ret), ctypes.byref(children), ctypes.byref(count)
		):
			return []
		ids = [children[i] for i in range(count.value)]
		if children:
			_X11.XFree(children)
		out: list[WindowInfo] = []
		for wid in ids:
			attrs = XWindowAttributes()
			if not _X11.XGetWindowAttributes(self.ptr, wid, ctypes.byref(attrs)):
				continue
			if attrs.map_state != IS_VIEWABLE or attrs.class_ != INPUT_OUTPUT:
				continue
			out.append(
				WindowInfo(
					id=wid,
					x=attrs.x,
					y=attrs.y,
					width=attrs.width,
					height=attrs.height,
					depth=attrs.depth,
					visual=attrs.visual or 0,
					pid=self._window_pid(wid),
				)
			)
		take_x_errors()
		return out

	def app_window(self, min_width: int = 400, min_height: int = 300) -> WindowInfo | None:
		"""The largest mapped top-level window, which on a private display is the app."""
		windows = [w for w in self.top_level_windows() if w.width >= min_width and w.height >= min_height]
		if not windows:
			return None
		return max(windows, key=lambda w: w.width * w.height)

	# Input -----------------------------------------------------------------

	def keycode(self, keysym_name: str) -> int:
		code = self._keycodes.get(keysym_name)
		if code is None:
			keysym = _X11.XStringToKeysym(keysym_name.encode())
			if keysym == 0:
				raise ValueError(f"unknown keysym {keysym_name}")
			code = _X11.XKeysymToKeycode(self.ptr, keysym)
			if code == 0:
				raise ValueError(f"keysym {keysym_name} has no keycode on {self.name}")
			self._keycodes[keysym_name] = code
		return code

	def key(self, keysym_name: str, press: bool) -> None:
		_XTST.XTestFakeKeyEvent(self.ptr, self.keycode(keysym_name), 1 if press else 0, 0)
		_X11.XFlush(self.ptr)

	def tap(self, keysym_name: str, modifiers: tuple[str, ...] = ()) -> None:
		for mod in modifiers:
			_XTST.XTestFakeKeyEvent(self.ptr, self.keycode(mod), 1, 0)
		code = self.keycode(keysym_name)
		_XTST.XTestFakeKeyEvent(self.ptr, code, 1, 0)
		_XTST.XTestFakeKeyEvent(self.ptr, code, 0, 0)
		for mod in reversed(modifiers):
			_XTST.XTestFakeKeyEvent(self.ptr, self.keycode(mod), 0, 0)
		_X11.XSync(self.ptr, 0)

	def type_text(self, text: str, gap_s: float = 0.015) -> None:
		names = {" ": "space", "\n": "Return", ".": "period", ",": "comma", "-": "minus", "/": "slash"}
		for ch in text:
			name = names.get(ch, ch)
			if ch.isupper():
				self.tap(ch.lower(), ("Shift_L",))
			else:
				self.tap(name)
			time.sleep(gap_s)

	def move(self, x: int, y: int) -> None:
		_XTST.XTestFakeMotionEvent(self.ptr, -1, x, y, 0)
		_X11.XFlush(self.ptr)

	def button(self, button: int, press: bool) -> None:
		_XTST.XTestFakeButtonEvent(self.ptr, button, 1 if press else 0, 0)
		_X11.XFlush(self.ptr)

	def click(self, x: int, y: int, button: int = 1) -> None:
		self.move(x, y)
		self.sync()
		time.sleep(0.02)
		self.button(button, True)
		self.button(button, False)
		self.sync()


class Capture:
	"""A reusable XShm image of one rectangle of one window."""

	def __init__(self, display: Display, window: WindowInfo, rect: Rect) -> None:
		if rect.w <= 0 or rect.h <= 0:
			raise ValueError(f"empty capture rectangle {rect}")
		if rect.x < 0 or rect.y < 0 or rect.x + rect.w > window.width or rect.y + rect.h > window.height:
			raise ValueError(f"capture rectangle {rect} is outside the {window.width}x{window.height} window")
		self.display = display
		self.window = window
		self.rect = rect
		self.info = XShmSegmentInfo()
		self.image = _XEXT.XShmCreateImage(
			display.ptr, window.visual, window.depth, Z_PIXMAP, None, ctypes.byref(self.info), rect.w, rect.h
		)
		if not self.image:
			raise RuntimeError("XShmCreateImage failed")
		img = self.image.contents
		if img.bits_per_pixel != 32:
			raise RuntimeError(f"window depth {window.depth} gives {img.bits_per_pixel} bits per pixel; 32 expected")
		size = img.bytes_per_line * img.height
		self.info.shmid = _LIBC.shmget(IPC_PRIVATE, size, IPC_CREAT | 0o600)
		if self.info.shmid < 0:
			raise OSError(ctypes.get_errno(), "shmget failed")
		addr = _LIBC.shmat(self.info.shmid, None, 0)
		if addr in (None, ctypes.c_void_p(-1).value):
			raise OSError(ctypes.get_errno(), "shmat failed")
		self.info.shmaddr = addr
		self.info.readOnly = 0
		img.data = addr
		if not _XEXT.XShmAttach(display.ptr, ctypes.byref(self.info)):
			raise RuntimeError("XShmAttach failed")
		display.sync()
		_LIBC.shmctl(self.info.shmid, IPC_RMID, None)
		raw = np.ctypeslib.as_array((ctypes.c_uint8 * size).from_address(addr))
		self._pixels = raw.view(np.uint32).reshape(img.height, img.bytes_per_line // 4)[:, : rect.w]

	def grab(self) -> np.ndarray:
		"""Captures the rectangle; the returned array is overwritten by the next grab."""
		ok = _XEXT.XShmGetImage(
			self.display.ptr, self.window.id, self.image, self.rect.x, self.rect.y, ALL_PLANES.value
		)
		if not ok:
			errors = take_x_errors()
			raise RuntimeError(f"XShmGetImage failed on window {self.window.id:#x}: {errors}")
		return self._pixels

	def snapshot(self) -> np.ndarray:
		"""Captures the rectangle into an array the caller owns (RGB channels only)."""
		return self.grab() & np.uint32(0x00FFFFFF)

	def close(self) -> None:
		if self.image:
			_XEXT.XShmDetach(self.display.ptr, ctypes.byref(self.info))
			self.display.sync()
			_LIBC.shmdt(ctypes.c_void_p(self.info.shmaddr))
			self.image.contents.data = None
			_X11.XDestroyImage(self.image)
			self.image = None

	def __enter__(self) -> Capture:
		return self

	def __exit__(self, *_exc) -> None:
		self.close()


def to_rgb(pixels: np.ndarray) -> np.ndarray:
	"""uint32 BGRX pixels to an (h, w, 3) uint8 RGB array."""
	b = (pixels & 0xFF).astype(np.uint8)
	g = ((pixels >> 8) & 0xFF).astype(np.uint8)
	r = ((pixels >> 16) & 0xFF).astype(np.uint8)
	return np.stack([r, g, b], axis=-1)


def changed_bbox(a: np.ndarray, b: np.ndarray) -> tuple[int, int, int, int] | None:
	"""Bounding box (x, y, w, h) of the pixels that differ between two captures."""
	diff = a != b
	if not diff.any():
		return None
	rows = np.flatnonzero(diff.any(axis=1))
	cols = np.flatnonzero(diff.any(axis=0))
	return int(cols[0]), int(rows[0]), int(cols[-1] - cols[0] + 1), int(rows[-1] - rows[0] + 1)
