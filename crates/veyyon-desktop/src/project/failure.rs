//! Where a backend failure lands (§1.5, §4.4).
//!
//! An error with a request lands on the control that sent it; one without
//! goes to its scope's fallback surface, and only the titlebar line is global.
//! The window and the scene catalogue both route through here, so a scene of
//! an error scope shows the error where the window would.
//!
//! Whether the control offers to send it again is the host's statement, which
//! it makes per error: a session the host has never heard of and a turn that
//! is already running are both `Session` errors, and only the second one is
//! worth sending again. Reading retryability off the scope offered a `Retry`
//! under every refusal in that scope, including the hundred the host had
//! already said were final.

use veyyon_desktop_model::{BackendError, RequestRegistry, SessionId, SurfaceId, route_error};
use veyyon_desktop_surface::{ControlError, ShellState};

/// Attaches the error to its control and returns the line the attention
/// strip owes when the error went global.
pub fn land_failure(
	error: &BackendError,
	registry: &RequestRegistry,
	active: Option<&SessionId>,
	state: &mut ShellState,
) -> Option<String> {
	let active_ui = active.map(|id| {
		if state.current_id > 0 {
			SessionId::from(state.current_id.to_string())
		} else {
			id.clone()
		}
	});
	let surface = route_error(error, registry, active_ui.as_ref());
	state
		.controls
		.set_error(surface.clone(), ControlError::new(&error.message, error.retryable));
	(surface == SurfaceId::GlobalTitlebarLine).then(|| error.message.clone())
}
