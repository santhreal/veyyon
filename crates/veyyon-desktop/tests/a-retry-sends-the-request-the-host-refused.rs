//! WHY: the `Retry` under a refused control did nothing for almost every
//! control that drew one. Two defects made it:
//!
//! 1. Whether a `Retry` was offered at all was read off the error's SCOPE, not
//!    off the `retryable` flag the host states per error. Sixteen of nineteen
//!    scopes are retryable by that reading, so a refusal the host had called
//!    final -- no turn is in flight to abort, this session does not exist,
//!    these arguments are invalid -- still drew a `Retry`.
//! 2. Pressing it dispatched `Intent::RetryControl(surface)`, which resolved
//!    through a hand-written table of ten surfaces. Every other control -- the
//!    composer's send, steer, queue, abort and take-back, every session row,
//!    every settings field, the terminal and the panel tabs -- fell through to
//!    an empty action list, so the click cleared the error, set the control
//!    Pending, and sent nothing at all.
//!
//! CLASS CLOSED: a control offers to send a request again exactly when the
//! host said that request could be sent again, and pressing it sends THAT
//! request -- the one the host refused, with the prompt, session and
//! attachments it carried -- rather than an action re-derived from the surface
//! id. The sweep drives every sample intent through the production
//! `actions_for`, records what it sent the way the window records it, fails it
//! through the production reducer, and requires the retry to return the same
//! action. A new `Intent` variant fails to compile in `intent_samples`, and a
//! new action kind reaching a control is swept the moment a sample intent
//! produces it.
//!
//! NOT CAUGHT: whether the window draws the hairline at a given width (the
//! surface region sweeps own that), and whether the host's own `retryable`
//! flag is right for a given failure (the host's suites own that).

mod support;

use support::{intent_samples::every_sample_intent, session};
use veyyon_desktop::{SessionIndex, actions_for, land_failure, record_sent, surface_for_action};
use veyyon_desktop_model::{
	BackendError, Capability, CapabilityStatus, ErrorScope, HostAction, HostEvent, QueuePartition,
	RequestId, RequestRegistry, SessionId, Store, SurfaceId, reduce,
};
use veyyon_desktop_surface::{Intent, ShellState};

const NOW_MS: u64 = 1_700_000_000_000;

fn seeded() -> (Store, SessionIndex) {
	let mut store = Store::new();
	let id = SessionId::from("s1");
	store.sessions.insert(session("s1", QueuePartition::Live));
	store.persisted.shell.active_session = Some(id.clone());
	for capability in Capability::ALL {
		store
			.capabilities
			.set(capability, CapabilityStatus::Available);
	}
	let mut index = SessionIndex::new();
	let _ = index.row_of(&id);
	(store, index)
}

fn refusal(request: RequestId, scope: ErrorScope, retryable: bool) -> BackendError {
	BackendError {
		scope,
		code: Some("REFUSED".to_string()),
		message: "the host refused it".to_string(),
		retryable,
		request: Some(request),
		occurred_at_ms: NOW_MS,
	}
}

/// Every request a control can send, refused, and sent again by that
/// control's retry.
#[test]
fn a_refused_request_is_what_its_control_sends_again() {
	let (mut store, index) = seeded();
	let active = store.persisted.shell.active_session.clone();
	let mut registry = RequestRegistry::new();
	let mut next = 1_u64;
	let mut swept = 0_usize;

	for intent in every_sample_intent() {
		for action in actions_for(&intent, &index, &mut store) {
			let surface = surface_for_action(&intent, &action, active.as_ref());
			// A retry re-sends the request, so a control whose own action IS a
			// retry would otherwise be swept against itself.
			if matches!(intent, Intent::RetryControl(_)) {
				continue;
			}
			let request = RequestId(next);
			next += 1;
			record_sent(&mut store, &mut registry, request, &action, surface.clone(), NOW_MS);
			reduce(&mut store, HostEvent::RequestFailed {
				request,
				error: refusal(request, ErrorScope::Session, true),
			});
			assert_eq!(
				actions_for(&Intent::RetryControl(surface.clone()), &index, &mut store),
				vec![action.clone()],
				"the retry on {surface:?} must send the request the host refused"
			);
			swept += 1;
		}
	}

	assert!(swept > 30, "the sweep drove {swept} requests, too few to be every control's");
}

/// The request is sent again once. A second press has nothing to send, and
/// falls back to what the control sends at rest -- nothing, for a control the
/// fallback table does not name.
#[test]
fn a_request_is_sent_again_once_and_a_taken_request_is_gone() {
	let (mut store, index) = seeded();
	let mut registry = RequestRegistry::new();
	let session = SessionId::from("s1");
	let surface = SurfaceId::ComposerSendButton(session.clone());
	let action = HostAction::SubmitPrompt {
		session,
		text: "the prompt the host refused".to_string(),
		attachments: Vec::new(),
	};

	record_sent(&mut store, &mut registry, RequestId(7), &action, surface.clone(), NOW_MS);
	reduce(&mut store, HostEvent::RequestFailed {
		request: RequestId(7),
		error:   refusal(RequestId(7), ErrorScope::Session, true),
	});

	assert_eq!(
		actions_for(&Intent::RetryControl(surface.clone()), &index, &mut store),
		vec![action],
		"the first press sends the refused prompt"
	);
	assert!(
		actions_for(&Intent::RetryControl(surface), &index, &mut store).is_empty(),
		"the second press has nothing left to send"
	);
}

/// A request the host took is not one anything sends again.
#[test]
fn a_request_the_host_took_is_not_sent_again() {
	let (mut store, index) = seeded();
	let mut registry = RequestRegistry::new();
	let session = SessionId::from("s1");
	let surface = SurfaceId::ComposerSendButton(session.clone());
	let action =
		HostAction::SubmitPrompt { session, text: "accepted".to_string(), attachments: Vec::new() };

	record_sent(&mut store, &mut registry, RequestId(9), &action, surface.clone(), NOW_MS);
	reduce(&mut store, HostEvent::RequestSucceeded { request: RequestId(9) });
	reduce(&mut store, HostEvent::RequestFailed {
		request: RequestId(9),
		error:   refusal(RequestId(9), ErrorScope::Session, true),
	});

	assert!(
		actions_for(&Intent::RetryControl(surface), &index, &mut store).is_empty(),
		"a request the host accepted is forgotten, so the control has nothing to send again"
	);
}

/// An error the window raised itself carries no request the host refused, so
/// the control falls back to the action it sends at rest.
#[test]
fn a_control_with_no_refused_request_falls_back_to_its_own_action() {
	let (mut store, index) = seeded();

	assert_eq!(
		actions_for(&Intent::RetryControl(SurfaceId::DiagnosticRefreshButton), &index, &mut store),
		vec![HostAction::RefreshDiagnostics],
		"a refresh button with nothing refused still refreshes"
	);
	assert!(
		actions_for(
			&Intent::RetryControl(SurfaceId::ComposerSendButton(SessionId::from("s1"))),
			&index,
			&mut store,
		)
		.is_empty(),
		"a composer with nothing refused has no prompt to send again"
	);
}

/// Whether a control offers to send again is the host's statement, in every
/// scope it can make it in.
#[test]
fn the_offer_to_send_again_is_the_hosts_statement() {
	let mut registry = RequestRegistry::new();
	let session = SessionId::from("s1");
	registry.register(
		RequestId(3),
		HostAction::AbortTurn { session: session.clone() }.kind(),
		SurfaceId::ComposerAbortButton(session.clone()),
		NOW_MS,
		30_000,
	);

	for scope in ErrorScope::ALL {
		for retryable in [false, true] {
			let mut state = ShellState::default();
			let error = refusal(RequestId(3), scope, retryable);
			land_failure(&error, &registry, Some(&session), &mut state);
			let landed = state
				.controls
				.error(&SurfaceId::ComposerAbortButton(session.clone()))
				.expect("the refusal lands on the control that sent the request");
			assert_eq!(
				landed.retryable, retryable,
				"a {scope:?} refusal the host called retryable={retryable} must offer exactly that"
			);
		}
	}
}
