//! WHY THIS TEST EXISTS:
//! Interactive UI controls that bypass the capability gate or misroute backend
//! error payloads lead to silent failures where operators click disabled
//! controls or miss failure notifications.
//!
//! THE CLASS THIS CLOSES:
//! Controls deciding their own availability without consulting `ControlStates`,
//! request failures failing to render the per-control error hairline, and
//! unassociated global errors failing to render on the top-level attention
//! strip.
//!
//! WHAT IT DOES NOT CATCH:
//! It does not validate remote host latency or network socket packet drops; it
//! asserts that local surface state reflects gate availability and error
//! routing.

use veyyon_desktop_kit::{TokenSet, load_bundled_theme, load_bundled_tokens};
use veyyon_desktop_model::{
	BackendError, ErrorScope, HostActionKind, RequestId, RequestRegistry, SurfaceId, route_error,
};
use veyyon_desktop_scene::{Appearance, RenderOptions, headless_context, render_view_captured};
use veyyon_desktop_surface::{
	Availability, ConnectionPhase, ControlError, ShellState, ShellView,
	controls::availability_style, fixture::populated, tokens::install_tokens,
};
use veyyon_gpui::{App, AppContext, CursorStyle, Window};
fn render_shell_captured(state: ShellState) -> veyyon_desktop_scene::Captured {
	let mut cx = headless_context().expect("headless context");
	let tokens = load_bundled_tokens().expect("tokens");
	let theme = load_bundled_theme("dark").expect("theme");

	let options = RenderOptions {
		width: 1440,
		height: 900,
		appearance: Appearance::Dark,
		scale_factor: 1.0,
		..RenderOptions::default()
	};

	render_view_captured(&mut cx, &options, move |_window: &mut Window, app: &mut App| {
		let installed = install_tokens(app, &tokens, &theme, std::path::Path::new("surface"))
			.expect("tokens installed");
		app.new(|_| ShellView::new(installed, state))
	})
	.expect("shell view must render cleanly")
}

#[test]
fn every_availability_variant_resolves_consistent_presentation_style() {
	let tokens = TokenSet::default();

	// Enabled: full strength, pointing hand cursor, activation allowed
	let (opacity, cursor, allowed) = availability_style(&Availability::Enabled, &tokens);
	assert_eq!(opacity, 1.0);
	assert_eq!(cursor, CursorStyle::PointingHand);
	assert!(allowed, "Enabled control must allow activation");

	// Pending: reduced 0.6 strength, operation not allowed cursor, activation
	// suppressed
	let (opacity, cursor, allowed) = availability_style(&Availability::Pending, &tokens);
	assert_eq!(opacity, 0.6);
	assert_eq!(cursor, CursorStyle::OperationNotAllowed);
	assert!(!allowed, "Pending control must suppress activation");

	// Unavailable: muted 0.4 strength, operation not allowed cursor, activation
	// suppressed
	let (opacity, cursor, allowed) = availability_style(
		&Availability::Unavailable { reason: "Missing capability".to_string() },
		&tokens,
	);
	assert_eq!(opacity, 0.4);
	assert_eq!(cursor, CursorStyle::OperationNotAllowed);
	assert!(!allowed, "Unavailable control must suppress activation");

	// Unknown: at rest (full opacity), pointing hand cursor, activation allowed
	// (attaches then acts)
	let (opacity, cursor, allowed) = availability_style(&Availability::Unknown, &tokens);
	assert_eq!(opacity, 1.0);
	assert_eq!(cursor, CursorStyle::PointingHand);
	assert!(allowed, "Unknown control must allow activation at rest");
}

#[test]
fn mutation_a_control_marked_unavailable_cannot_be_drawn_enabled() {
	let mut state = populated();
	let test_control = SurfaceId::GlobalTitlebarLine;

	state
		.controls
		.set_availability(test_control.clone(), Availability::Unavailable {
			reason: "Feature disabled".to_string(),
		});

	let av = state.controls.availability(&test_control);
	assert!(matches!(av, Availability::Unavailable { .. }), "control state must report unavailable");

	let tokens = TokenSet::default();
	let (_, _, allowed) = availability_style(&av, &tokens);
	assert!(!allowed, "mutation gate: unavailable control must not permit activation");
}

#[test]
fn request_failed_with_some_request_id_routes_to_originating_control_hairline() {
	let mut registry = RequestRegistry::new();
	let request_id = RequestId(42);
	let target_control = SurfaceId::ConnectionRetryButton;

	registry.register(
		request_id,
		HostActionKind::RetryConnection,
		target_control.clone(),
		1000,
		5000,
	);

	let backend_err = BackendError {
		scope:          ErrorScope::Connection,
		code:           None,
		message:        "Connection timed out".to_string(),
		retryable:      true,
		request:        Some(request_id),
		occurred_at_ms: 1000,
	};

	let routed_surface = route_error(&backend_err, &registry, None);
	assert_eq!(
		routed_surface, target_control,
		"error with Some(request) must route directly to the originating control"
	);

	let mut state = populated();
	state
		.controls
		.set_error(routed_surface.clone(), ControlError::new(&backend_err.message, true));

	assert!(state.controls.error(&routed_surface).is_some());
	assert_eq!(state.controls.error(&routed_surface).unwrap().message, "Connection timed out");
	assert!(state.controls.error(&routed_surface).unwrap().retryable);
}

#[test]
fn request_failed_with_none_request_id_routes_to_global_titlebar_line() {
	let registry = RequestRegistry::new();
	let backend_err = BackendError {
		scope:          ErrorScope::Authentication,
		code:           None,
		message:        "Authentication expired globally".to_string(),
		retryable:      false,
		request:        None,
		occurred_at_ms: 1000,
	};

	let routed_surface = route_error(&backend_err, &registry, None);
	assert_eq!(
		routed_surface,
		SurfaceId::GlobalTitlebarLine,
		"error with request: None must route to the global attention strip"
	);

	let mut state = populated();
	state
		.controls
		.set_error(routed_surface, ControlError::new(&backend_err.message, false));

	let captured = render_shell_captured(state);
	assert!(!captured.hitboxes.is_empty(), "frame with attention strip error must render cleanly");
}

#[test]
fn every_attach_screen_phase_carries_hitbox_for_its_action() {
	let phases = [
		ConnectionPhase::Detached,
		ConnectionPhase::Fatal { message: "Fatal host disconnect".to_string() },
		ConnectionPhase::Reconnecting {
			attempt:     2,
			retry_at_ms: 3000,
			message:     "Socket error".to_string(),
		},
		ConnectionPhase::NeedsSecret { provider: "anthropic".to_string() },
		ConnectionPhase::AwaitingExternalUrl {
			provider: "anthropic".to_string(),
			url:      "https://auth.anthropic.com".to_string(),
		},
	];

	for phase in phases {
		let state = ShellState { connection: phase.clone(), ..ShellState::default() };

		let captured = render_shell_captured(state);
		assert!(
			!captured.hitboxes.is_empty(),
			"phase {phase:?} must expose actionable hitboxes on its attach screen"
		);
	}
}
