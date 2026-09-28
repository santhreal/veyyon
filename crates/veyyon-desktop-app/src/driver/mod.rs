//! The test driver: a Unix socket named by `VEYYON_DESKTOP_DRIVER` that acts
//! on the window and reports what it drew, and the target registry the views
//! write to.
//!
//! A client dispatches actions, types text, reads where a named target is
//! drawn, subscribes to frames and waits for the window to settle.
//!
//! Without the variable no socket is opened and [`target`] returns its
//! element unchanged, so a window that is not driven records nothing. A test
//! drives a window through a [`Client`] in its own process instead.

#[cfg(unix)]
mod answer;
#[cfg(unix)]
mod client;
mod element;
#[cfg(unix)]
mod probe;
mod protocol;
#[cfg(unix)]
mod socket;

use std::{
	collections::HashMap,
	fmt::Display,
	sync::atomic::{AtomicBool, Ordering},
};

use gpui::{AnyElement, App, Bounds, Global, IntoElement, Pixels, SharedString, Window, WindowId};

pub use self::element::FrameProbe;
use self::element::Target;
#[cfg(unix)]
pub use self::{
	client::{Client, waiting},
	socket::start,
};

/// Opens the driver socket. Unix domain sockets are unavailable here.
///
/// # Errors
///
/// Always returns `Unsupported`.
#[cfg(not(unix))]
pub fn start(_: &std::path::Path, _: &mut App) -> std::io::Result<()> {
	Err(std::io::Error::new(
		std::io::ErrorKind::Unsupported,
		"the desktop driver needs Unix domain sockets",
	))
}

/// Reports a painted frame to the subscribed clients.
fn frame_painted(cx: &mut App) {
	#[cfg(unix)]
	answer::frame_painted(cx);
	#[cfg(not(unix))]
	let _ = cx;
}

/// The environment variable naming the driver socket.
pub const SOCKET_VAR: &str = "VEYYON_DESKTOP_DRIVER";

static ENABLED: AtomicBool = AtomicBool::new(false);

/// Makes [`target`] record bounds from now on in this process. The socket
/// calls it when it opens; a view test calls it to read targets back with
/// [`bounds`].
pub fn enable() {
	ENABLED.store(true, Ordering::Relaxed);
}

/// Whether targets are recorded.
#[must_use]
pub fn is_enabled() -> bool {
	ENABLED.load(Ordering::Relaxed)
}

/// A target id: `&'static str`, `String` and `SharedString` stand for
/// themselves, and `(prefix, value)` stands for `prefix:value`, formatted only
/// when the driver is on.
pub trait TargetId {
	/// The id as the driver reports it.
	fn into_target_id(self) -> SharedString;
}

impl TargetId for &'static str {
	fn into_target_id(self) -> SharedString {
		SharedString::new_static(self)
	}
}

impl TargetId for String {
	fn into_target_id(self) -> SharedString {
		self.into()
	}
}

impl TargetId for SharedString {
	fn into_target_id(self) -> SharedString {
		self
	}
}

impl<D: Display> TargetId for (&'static str, D) {
	fn into_target_id(self) -> SharedString {
		format!("{}:{}", self.0, self.1).into()
	}
}

/// Wraps `element` so its window bounds are recorded under `id` each time it
/// is laid out. The wrapper adds no layout node. Returns `element` unchanged
/// when the driver is off.
pub fn target(id: impl TargetId, element: impl IntoElement) -> AnyElement {
	if is_enabled() {
		Target::new(id.into_target_id(), element.into_any_element()).into_any_element()
	} else {
		element.into_any_element()
	}
}

/// Drops the bounds recorded for `id` in `window`, for a target that is no
/// longer drawn.
///
/// A cached view that was not re-rendered keeps its targets: only the view
/// that stops drawing one can drop them.
pub fn forget(window: &Window, id: &str, cx: &mut App) {
	if !is_enabled() || !cx.has_global::<Targets>() {
		return;
	}
	let window = window.window_handle().window_id();
	if let Some(targets) = cx.global_mut::<Targets>().windows.get_mut(&window) {
		targets.remove(id);
	}
}

/// Where each target of each window was last laid out.
#[derive(Default)]
pub(crate) struct Targets {
	windows: HashMap<WindowId, HashMap<SharedString, Bounds<Pixels>>>,
}

impl Global for Targets {}

impl Targets {
	pub(crate) fn record(cx: &mut App, window: WindowId, id: SharedString, bounds: Bounds<Pixels>) {
		cx.default_global::<Self>()
			.windows
			.entry(window)
			.or_default()
			.insert(id, bounds);
	}
}

/// The window bounds `id` was last laid out at in `window`.
#[must_use]
pub fn bounds(cx: &App, window: WindowId, id: &str) -> Option<Bounds<Pixels>> {
	cx.try_global::<Targets>()?
		.windows
		.get(&window)?
		.get(id)
		.copied()
}
