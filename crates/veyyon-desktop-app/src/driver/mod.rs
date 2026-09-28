//! The test driver: a Unix socket named by `VEYYON_DESKTOP_DRIVER` that
//! dispatches actions, types text and reports where named targets are drawn,
//! and the target registry the views write to.
//!
//! Without the variable no socket is opened and [`target`] returns its
//! element unchanged, so a window that is not driven records nothing.

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
pub use self::socket::start;

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
fn frame_painted(window: &mut Window, cx: &mut App) {
	#[cfg(unix)]
	socket::frame_painted(window, cx);
	#[cfg(not(unix))]
	let _ = (window, cx);
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
