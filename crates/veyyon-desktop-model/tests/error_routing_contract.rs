//! WHY THIS SUITE EXISTS
//!
//! An error that surfaces in the wrong place is indistinguishable from an error
//! that was swallowed: the operator retries a control that never failed. The
//! routing table is the whole contract, and it is per-scope, so the sweep below
//! is over `ErrorScope::ALL` with a fallback surface pinned for every one of
//! the 19 scopes. The pinned table is written HERE rather than read from the
//! implementation on purpose; a test that asks the code what it does agrees
//! with whatever the code does.
//!
//! WHAT IT DOES NOT CATCH: whether the surface each scope names is the one an
//! operator would look at. That is a judgement the capture pairs settle, not an
//! assertion.

use veyyon_desktop_model::{
	BackendError, ErrorScope, HostActionKind, RequestId, RequestRegistry, SessionId, SurfaceId,
	is_scope_retryable, route_error,
};

/// The surface each scope falls back to when the error carries no request id.
/// One arm per scope, so a new scope fails to compile rather than falling
/// through to a default that looks correct.
fn expected_fallback(scope: ErrorScope, session: &SessionId) -> SurfaceId {
	match scope {
		ErrorScope::Connection
		| ErrorScope::Session
		| ErrorScope::Transcript
		| ErrorScope::File
		| ErrorScope::Change
		| ErrorScope::Provider
		| ErrorScope::Agent
		| ErrorScope::Task
		| ErrorScope::Authentication
		| ErrorScope::Lifecycle => SurfaceId::GlobalTitlebarLine,
		ErrorScope::Tool => SurfaceId::QueueSessionRow(session.clone()),
		ErrorScope::Interaction | ErrorScope::Plan => SurfaceId::ComposerSendButton(session.clone()),
		ErrorScope::Terminal => SurfaceId::TerminalCreateButton(session.clone()),
		ErrorScope::Usage => SurfaceId::UsageRefreshButton,
		ErrorScope::Mcp => SurfaceId::SettingsField("mcp".to_string()),
		ErrorScope::Extension => SurfaceId::SettingsField("extensions".to_string()),
		ErrorScope::Settings => SurfaceId::SettingsField("general".to_string()),
		ErrorScope::Diagnostic => SurfaceId::DiagnosticRefreshButton,
	}
}

/// True for a surface that only exists in the context of one session.
const fn is_session_scoped(surface: &SurfaceId) -> bool {
	matches!(
		surface,
		SurfaceId::QueueSessionRow(_)
			| SurfaceId::ComposerSendButton(_)
			| SurfaceId::TerminalCreateButton(_)
	)
}

#[test]
fn test_all_error_scopes_routing_and_retryability() {
	let scopes = ErrorScope::ALL;

	// Assert count dynamically from enum
	assert_eq!(scopes.len(), 19, "Expected exactly 19 error scopes");

	let session_id = SessionId::from("test-session");
	let mut registry = RequestRegistry::new();

	for &scope in &scopes {
		let is_retryable = is_scope_retryable(scope);

		// Non-retryable scopes per specification
		if matches!(scope, ErrorScope::Transcript | ErrorScope::Extension | ErrorScope::Lifecycle) {
			assert!(!is_retryable, "Scope {scope:?} should not be retryable");
		} else {
			assert!(is_retryable, "Scope {scope:?} should be retryable");
		}

		// 1. Fallback when request is None.
		//
		// This asserts the CONCRETE surface each scope falls back to. Comparing
		// `route_error` against `fallback_surface` would be a tautology:
		// `route_error` delegates to it, so the two agree no matter which
		// surface the mapping names, including a wrong one.
		let error_no_req = BackendError {
			scope,
			code: None,
			message: "Error without request".to_string(),
			retryable: is_retryable,
			request: None,
			occurred_at_ms: 1000,
		};

		let expected = expected_fallback(scope, &session_id);
		assert_eq!(
			route_error(&error_no_req, &registry, Some(&session_id)),
			expected,
			"scope {scope:?} must fall back to {expected:?}",
		);

		// The same scope with no active session cannot route to a session-scoped
		// surface, because there is no session to scope it to.
		let without_session = route_error(&error_no_req, &registry, None);
		assert!(
			!is_session_scoped(&without_session),
			"scope {scope:?} routed to the session-scoped surface {without_session:?} with no active \
			 session",
		);

		// 2. Direct routing when matching request exists in registry
		let req_id = RequestId(12345);
		let target_surface = SurfaceId::ComposerSendButton(session_id.clone());
		registry.register(req_id, HostActionKind::SubmitPrompt, target_surface.clone(), 1000, 5000);

		let error_with_req = BackendError {
			scope,
			code: None,
			message: "Error with request".to_string(),
			retryable: is_retryable,
			request: Some(req_id),
			occurred_at_ms: 1000,
		};

		let routed = route_error(&error_with_req, &registry, Some(&session_id));
		assert_eq!(routed, target_surface, "Direct routing failed for scope {scope:?}");

		registry.complete(&req_id);
	}
}
