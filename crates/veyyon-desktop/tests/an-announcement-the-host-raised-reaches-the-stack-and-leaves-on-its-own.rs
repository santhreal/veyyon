//! WHY: the queue and the stack are two halves of one thing, and either half
//! alone is a silent failure. A queue that holds an announcement the window
//! never draws states nothing; a stack drawn from window-local state would
//! keep a card the host has already settled, and a card dismissed by a press
//! would come back on the next frame the host sent.
//!
//! CLASS CLOSED: the whole path, driven end to end -- the host's event
//! reduces into the queue, the projection puts it on the stack, the clock
//! takes it off when its time is up, and a dismissal reaches the queue so the
//! next projection agrees with the frame already drawn. Also the termination
//! property that makes this safe to run on a one-second tick: expiry ends,
//! and it reports whether anything changed so an idle window repaints for
//! nothing.
//!
//! NOT CAUGHT: what the cards look like, which is the surface suite, and the
//! queue's own dedupe, order and bound, which is the model's queue suite.

mod support;

use std::collections::HashMap;

use support::session;
use veyyon_desktop::{SessionIndex, actions_for, expire_notices, project};
use veyyon_desktop_model::{
	BackendError, ErrorScope, HostEvent, NOTIFICATION_CAPACITY, NotificationPriority,
	QueuePartition, RequestId, SessionId, Store, reduce,
};
use veyyon_desktop_surface::{Intent, ShellState};

const NOW_MS: u64 = 1_700_000_000_000;

fn store_with_session() -> (Store, SessionIndex, ShellState) {
	let mut store = Store::new();
	store.sessions.insert(session("s", QueuePartition::Live));
	store.persisted.shell.active_session = Some(SessionId::from("s"));
	(store, SessionIndex::new(), ShellState::default())
}

fn refuse(store: &mut Store, code: &str, message: &str, at_ms: u64) {
	reduce(store, HostEvent::RequestFailed {
		request: RequestId(1),
		error:   BackendError {
			scope:          ErrorScope::Settings,
			code:           Some(code.to_owned()),
			message:        message.to_owned(),
			retryable:      true,
			request:        Some(RequestId(1)),
			occurred_at_ms: at_ms,
		},
	});
}

fn keys(state: &ShellState) -> Vec<&str> {
	state
		.notices
		.iter()
		.map(|notice| notice.key.as_str())
		.collect()
}

#[test]
fn a_refusal_the_host_sent_is_on_the_stack_the_next_frame_draws() {
	let (mut store, mut index, mut state) = store_with_session();
	refuse(&mut store, "EACCES", "cannot write", NOW_MS);
	project(&store, &mut index, &HashMap::new(), NOW_MS, &mut state);

	assert_eq!(state.notices.len(), 1, "the window draws what the host raised");
	assert_eq!(state.notices[0].title, "cannot write");
	assert_eq!(
		state.notices[0].priority,
		NotificationPriority::Normal,
		"a refusal the session carries on from does not hold the stack open"
	);
}

#[test]
fn a_card_whose_time_is_up_is_not_drawn_even_between_two_ticks() {
	let (mut store, mut index, mut state) = store_with_session();
	refuse(&mut store, "EACCES", "cannot write", NOW_MS);
	let ttl = NotificationPriority::Normal
		.ttl_ms()
		.expect("a routine announcement states a lifetime");

	project(&store, &mut index, &HashMap::new(), NOW_MS + ttl - 1, &mut state);
	assert_eq!(state.notices.len(), 1, "it is still up a millisecond before it is due");

	project(&store, &mut index, &HashMap::new(), NOW_MS + ttl, &mut state);
	assert!(
		state.notices.is_empty(),
		"a projection between two ticks draws the stack the next tick will hold"
	);
	assert_eq!(
		store.notifications.len(),
		1,
		"the queue still holds it: the clock takes it off, not the projection"
	);
}

#[test]
fn the_window_clock_takes_an_expired_card_off_and_says_whether_anything_changed() {
	let (mut store, mut index, mut state) = store_with_session();
	refuse(&mut store, "EACCES", "cannot write", NOW_MS);
	project(&store, &mut index, &HashMap::new(), NOW_MS, &mut state);
	let ttl = NotificationPriority::Normal
		.ttl_ms()
		.expect("a routine announcement states a lifetime");

	assert!(
		!expire_notices(&mut store, NOW_MS + 1, &mut state),
		"an idle window does not repaint for a card that is still up"
	);
	assert_eq!(state.notices.len(), 1);

	assert!(
		expire_notices(&mut store, NOW_MS + ttl, &mut state),
		"the tick that takes a card off asks for the repaint that removes it"
	);
	assert!(state.notices.is_empty());
	assert!(store.notifications.is_empty(), "and the queue behind it is cleared");

	assert!(
		!expire_notices(&mut store, NOW_MS + ttl + 60_000, &mut state),
		"expiry on an empty queue terminates and changes nothing"
	);
}

#[test]
fn a_decision_waiting_out_of_view_stays_on_the_stack_across_every_tick() {
	let (mut store, mut index, mut state) = store_with_session();
	reduce(
		&mut store,
		HostEvent::Snapshot(veyyon_desktop_model::SnapshotSection::Interactions {
			session: SessionId::from("other"),
			pending: veyyon_desktop_model::PendingDecisions {
				approvals: vec![veyyon_desktop_model::ApprovalInteraction {
					id:              veyyon_desktop_model::InteractionId::from("a-1"),
					tool_name:       "bash".to_owned(),
					detail:          "rm -rf build".to_owned(),
					requested_at_ms: NOW_MS,
				}],
				questions: Vec::new(),
				plans:     Vec::new(),
			},
		}),
	);
	project(&store, &mut index, &HashMap::new(), NOW_MS, &mut state);
	assert_eq!(state.notices.len(), 1);

	for minutes in 1..=60_u64 {
		let now = NOW_MS + minutes * 60_000;
		assert!(
			!expire_notices(&mut store, now, &mut state),
			"a turn waiting on an answer is not taken away by a clock"
		);
	}
	assert_eq!(keys(&state).len(), 1, "and it is still the one card on the stack");
	assert_eq!(state.notices[0].title, "bash is waiting for approval");
}

#[test]
fn a_dismissal_clears_the_queue_so_the_next_projection_agrees_with_the_frame() {
	let (mut store, mut index, mut state) = store_with_session();
	refuse(&mut store, "EACCES", "cannot write", NOW_MS);
	refuse(&mut store, "ENOENT", "no such file", NOW_MS);
	project(&store, &mut index, &HashMap::new(), NOW_MS, &mut state);
	assert_eq!(state.notices.len(), 2);
	let dismissed = state.notices[0].key.clone();

	let intent = Intent::DismissNotice(dismissed.clone());
	// The press applies to the state the frame drew, and the same intent
	// reaches the queue behind it.
	intent.apply(&mut state);
	assert!(!keys(&state).contains(&dismissed.as_str()));
	assert!(
		actions_for(&intent, &index, &mut store).is_empty(),
		"reading a card asks the host for nothing"
	);

	project(&store, &mut index, &HashMap::new(), NOW_MS, &mut state);
	assert_eq!(state.notices.len(), 1, "the card the press took down does not come back");
	assert!(!keys(&state).contains(&dismissed.as_str()));
	assert!(!store.notifications.holds(&dismissed));
}

#[test]
fn a_failing_loop_never_draws_more_cards_than_the_bound() {
	let (mut store, mut index, mut state) = store_with_session();
	for round in 0..200_u64 {
		refuse(&mut store, &format!("E{round}"), "cannot write", NOW_MS + round);
		project(&store, &mut index, &HashMap::new(), NOW_MS + round, &mut state);
		assert!(
			state.notices.len() <= NOTIFICATION_CAPACITY,
			"round {round} drew {} cards",
			state.notices.len()
		);
	}
	assert_eq!(state.notices.len(), NOTIFICATION_CAPACITY);

	let ttl = NotificationPriority::Normal
		.ttl_ms()
		.expect("a routine announcement states a lifetime");
	assert!(expire_notices(&mut store, NOW_MS + 200 + ttl, &mut state));
	assert!(state.notices.is_empty(), "and the stack empties itself without a press");
}
