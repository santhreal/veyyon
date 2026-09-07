//! WHY THIS SUITE EXISTS:
//! Backend errors with no matching in-flight request land on their scope's
//! fallback target rather than being lost or displayed as a blanket global
//! error banner. Session-dependent fallbacks must correctly route to the
//! rendered numeric UI `SessionIndex` rather than the wire `SessionId`, so that
//! visual controls (Composer, Queue, Terminal Drawer) can observe and render
//! their per-control error hairlines.
//!
//! CLASS CLOSED:
//! - An error scope variant added without its fallback surface routing,
//!   retryability, or contextual scene visibility decision being recorded.
//! - A mismatch between wire `SessionId` and UI `SessionIndex` row translation
//!   that silently renders controls without their error hairlines.
//! - A requestless error with no active session that fails to fall back to the
//!   global titlebar attention strip.
//! - A matching in-flight request failure that fails to route to its
//!   originating control.
//! - An error on a hidden or overlay target (Settings, Mcp, Extensions,
//!   Diagnostics, Usage, Terminal) that fails to expose an error hairline when
//!   its surface is open.
//! - A retryable error whose retry action fails to dispatch the corresponding
//!   `HostAction`.
//!
//! WHAT IT DOES NOT CATCH:
//! - GPU raster anti-aliasing differences across platform graphic drivers.

mod support;

use std::path::PathBuf;

use strum::IntoEnumIterator as _;
use veyyon_desktop::{
	AssetPaths, SessionIndex, StartupBundle, actions_for, land_failure, load_startup_bundle,
	scene::{
		Assets, SceneRoot, SceneWindow,
		build::{error_scope, error_scope_baseline},
	},
};
use veyyon_desktop_model::{
	BackendError, ErrorScope, HostAction, HostActionKind, RequestId, RequestRegistry, SessionId,
	Store, SurfaceId, fallback_surface, is_scope_retryable,
};
use veyyon_desktop_scene::{Appearance, RenderOptions, headless_context};
use veyyon_desktop_surface::{Availability, ControlError, Intent, ShellState};

fn startup_assets() -> StartupBundle {
	let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../crates/veyyon-desktop-tokens");
	load_startup_bundle(AssetPaths {
		tokens_dir: root.join("tokens"),
		themes_dir: root.join("themes"),
	})
	.expect("load startup bundle")
}

#[test]
fn requestless_errors_translate_session_index_and_land_on_fallback_targets() {
	for scope in ErrorScope::iter() {
		let registry = RequestRegistry::new();
		let mut state = ShellState { current_id: 1, ..ShellState::default() };

		let error = BackendError {
			scope,
			code: Some(format!("E_{}", scope.as_str().to_ascii_uppercase())),
			message: format!("failure for {}", scope.as_str()),
			retryable: is_scope_retryable(scope),
			request: None,
			occurred_at_ms: 10_000,
		};

		let wire_session = SessionId::from("session_wire_0042");
		let ui_session = SessionId::from("1");
		let global_notice = land_failure(&error, &registry, Some(&wire_session), &mut state);

		let expected_surface = fallback_surface(scope, Some(&ui_session));

		match expected_surface {
			SurfaceId::GlobalTitlebarLine => {
				let notice_text = global_notice.expect("global error must return notice line");
				assert_eq!(
					notice_text, error.message,
					"global titlebar notice text must match error message"
				);
			},
			surface => {
				assert!(
					global_notice.is_none(),
					"scoped fallback error must not return global titlebar notice"
				);
				let control_err = state
					.controls
					.error(&surface)
					.unwrap_or_else(|| panic!("scope {scope:?} must set error on {surface:?}"));
				assert_eq!(
					control_err.message, error.message,
					"control error message on {surface:?} must match backend error message"
				);
				assert_eq!(
					control_err.retryable,
					is_scope_retryable(scope),
					"retryability on {surface:?} must reflect scope contract"
				);
			},
		}
	}
}

#[test]
fn requestless_errors_without_active_session_fall_back_to_global_titlebar() {
	for scope in ErrorScope::iter() {
		let registry = RequestRegistry::new();
		let mut state = ShellState::default();

		let error = BackendError {
			scope,
			code: Some(format!("E_{}", scope.as_str().to_ascii_uppercase())),
			message: format!("orphaned error for {}", scope.as_str()),
			retryable: is_scope_retryable(scope),
			request: None,
			occurred_at_ms: 10_000,
		};

		let global_notice = land_failure(&error, &registry, None, &mut state);

		let expected_surface = fallback_surface(scope, None);

		match expected_surface {
			SurfaceId::GlobalTitlebarLine => {
				let notice_text = global_notice.unwrap_or_else(|| {
					panic!("scope {scope:?} with no active session must set titlebar notice")
				});
				assert_eq!(notice_text, error.message);
			},
			surface => {
				assert!(
					state.controls.error(&surface).is_some(),
					"requestless error for {scope:?} with fixed surface must land on {surface:?}"
				);
			},
		}
	}
}

#[test]
fn matching_request_error_lands_on_originating_control_not_fallback() {
	let req_id = RequestId(42);
	let originating_surface = SurfaceId::RightPanelDiffTab(SessionId::from("1"));

	let mut registry = RequestRegistry::new();
	registry.register(
		req_id,
		HostActionKind::RefreshChanges,
		originating_surface.clone(),
		10_000,
		30_000,
	);

	let mut state = ShellState { current_id: 1, ..ShellState::default() };

	let error = BackendError {
		scope:          ErrorScope::Change,
		code:           Some("E_DIFF_FAILED".to_string()),
		message:        "failed to diff working tree".to_string(),
		retryable:      true,
		request:        Some(req_id),
		occurred_at_ms: 10_500,
	};
	let wire_session = SessionId::from("session_wire_0042");
	let global_notice = land_failure(&error, &registry, Some(&wire_session), &mut state);

	assert!(
		global_notice.is_none(),
		"matching request error must not return global titlebar notice line"
	);

	let err = state
		.controls
		.error(&originating_surface)
		.expect("error must land on originating control");
	assert_eq!(err.message, "failed to diff working tree");
	assert!(err.retryable);
}

#[test]
fn error_scope_scenes_render_distinct_pixels_from_baseline() {
	let mut cx = headless_context().expect("headless context must be available on GPU host");
	let bundle = startup_assets();
	let assets = Assets {
		tokens:       &bundle.tokens,
		theme:        &bundle.theme,
		surface_path: &bundle.surface_path,
	};
	let options = RenderOptions {
		width: 1180,
		height: 800,
		scale_factor: 1.0,
		appearance: Appearance::Dark,
		..RenderOptions::default()
	};
	let mut window = SceneWindow::open(&mut cx, &options).expect("open the scene window");

	for scope in ErrorScope::iter() {
		let error_built = SceneRoot::Shell(Box::new(error_scope(scope)));
		let baseline_built = SceneRoot::Shell(Box::new(error_scope_baseline(scope)));

		let rendered_error = window
			.render_root(&assets, error_built)
			.unwrap_or_else(|err| panic!("render error scene for {scope:?}: {err}"));
		let rendered_baseline = window
			.render_root(&assets, baseline_built)
			.unwrap_or_else(|err| panic!("render baseline scene for {scope:?}: {err}"));

		let error_bytes = rendered_error.captured.frame.as_bytes();
		let baseline_bytes = rendered_baseline.captured.frame.as_bytes();

		assert_ne!(
			error_bytes, baseline_bytes,
			"scope {scope:?} error scene must render distinct pixel bytes from its baseline"
		);
	}
}

#[test]
fn retry_control_and_dismiss_error_intents_behave_deterministically() {
	let mut state = ShellState::default();
	let target = SurfaceId::DiagnosticRefreshButton;

	state
		.controls
		.set_error(target.clone(), ControlError::new("network timeout", true));
	assert!(state.controls.error(&target).is_some());
	// Dismissing via intent.apply clears the error from controls without
	// side-effects
	Intent::DismissError(target.clone()).apply(&mut state);
	assert!(
		state.controls.error(&target).is_none(),
		"DismissError must clear error via UI intent application"
	);
	let mut store = Store::new();
	let index = SessionIndex::new();
	let dismiss_actions = actions_for(&Intent::DismissError(target.clone()), &index, &mut store);
	assert!(dismiss_actions.is_empty(), "DismissError must not dispatch host actions");

	// Re-inject error and apply RetryControl intent
	state
		.controls
		.set_error(target.clone(), ControlError::new("network timeout", true));
	Intent::RetryControl(target.clone()).apply(&mut state);
	assert!(state.controls.error(&target).is_none(), "RetryControl must clear active error");
	assert_eq!(
		state.controls.availability(&target),
		Availability::Pending,
		"RetryControl must transition control to Pending availability"
	);

	// Retrying maps to the corresponding HostAction
	let retry_actions = actions_for(&Intent::RetryControl(target), &index, &mut store);
	assert_eq!(
		retry_actions,
		vec![HostAction::RefreshDiagnostics],
		"retrying diagnostic refresh must dispatch RefreshDiagnostics"
	);
}
