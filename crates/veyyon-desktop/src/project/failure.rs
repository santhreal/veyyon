//! Where a backend failure lands (§1.5, §4.4).
//!
//! An error with a request lands on the control that sent it; one without
//! goes to its scope's fallback surface, and only the titlebar line is global.
//! The window and the scene catalogue both route through here, so a scene of
//! an error scope shows the error where the window would.

use veyyon_desktop_model::{
	BackendError, RequestRegistry, SessionId, SurfaceId, is_scope_retryable, route_error,
};
use veyyon_desktop_surface::{ControlError, ShellState};

/// Attaches the error to its control and returns the line the attention
/// strip owes when the error went global.
pub fn land_failure(
	error: &BackendError,
	registry: &RequestRegistry,
	active: Option<&SessionId>,
	state: &mut ShellState,
) -> Option<String> {
	let surface = route_error(error, registry, active);
	state.controls.set_error(
		surface.clone(),
		ControlError::new(&error.message, is_scope_retryable(error.scope)),
	);
	(surface == SurfaceId::GlobalTitlebarLine).then(|| error.message.clone())
}
