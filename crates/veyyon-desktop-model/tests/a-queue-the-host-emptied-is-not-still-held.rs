//! WHY THIS SUITE EXISTS:
//! `QueuedPrompts` is the one snapshot section whose destination is neither a
//! domain view nor the transcript: it lands in `Store::queued`, per session,
//! and the composer draws a row per prompt it finds there. A report that
//! empties both queues is the frame a turn's end produces, and a reducer that
//! merged rather than replaced would leave prompts the session already ran on
//! the strip in front of the operator, with a take-back control that pops a
//! queue holding nothing.
//!
//! THE CLASS THIS CLOSES: held-prompt state surviving the report that says the
//! session holds nothing, and the one-frame `restored` text leaking into
//! store state, where a later frame would refill the draft from it.
//!
//! WHAT IT DOES NOT CATCH: whether the composer reads `Store::queued`
//! (`veyyon-desktop/tests/
//! a-dequeue-intent-maps-to-the-queued-prompt-host-action.rs`
//! owns the projection), or whether the host reports the queue at all (the
//! gui-host suites own that).

use veyyon_desktop_model::{
	Damage, HostEvent, QueuedPromptsView, SessionId, SnapshotSection, Store, reduce,
};

fn report(session: &SessionId, steering: &[&str], follow_up: &[&str]) -> HostEvent {
	HostEvent::Snapshot(SnapshotSection::QueuedPrompts(QueuedPromptsView {
		session:   session.clone(),
		steering:  steering.iter().map(|text| (*text).to_owned()).collect(),
		follow_up: follow_up.iter().map(|text| (*text).to_owned()).collect(),
		restored:  None,
	}))
}

#[test]
fn a_report_of_an_empty_queue_leaves_the_session_holding_nothing() {
	let mut store = Store::new();
	let session = SessionId::from("sess-1");

	reduce(&mut store, report(&session, &["steer one"], &["follow one", "follow two"]));
	let held = store
		.queued
		.get(&session)
		.expect("the reported queue is held");
	assert_eq!(
		held.in_delivery_order().collect::<Vec<_>>(),
		vec!["steer one", "follow one", "follow two"],
		"the steering queue runs at the turn's next boundary, the follow-ups after it ends"
	);
	assert_eq!(held.len(), 3, "three prompts are held");

	// The frame a turn's end produces: the queues drained, nothing held.
	reduce(&mut store, report(&session, &[], &[]));
	assert!(
		!store.queued.contains_key(&session),
		"a session that holds nothing holds no entry, so no strip is drawn for it"
	);
}

#[test]
fn one_session_emptying_its_queue_leaves_another_session_holding_its_own() {
	let mut store = Store::new();
	let first = SessionId::from("sess-1");
	let second = SessionId::from("sess-2");

	reduce(&mut store, report(&first, &["first steers"], &[]));
	reduce(&mut store, report(&second, &[], &["second follows"]));
	reduce(&mut store, report(&first, &[], &[]));

	assert!(!store.queued.contains_key(&first), "the session that drained holds nothing");
	assert_eq!(
		store
			.queued
			.get(&second)
			.expect("the other session still holds its own")
			.in_delivery_order()
			.collect::<Vec<_>>(),
		vec!["second follows"],
		"a report names one session and replaces only that session's queue"
	);
}

#[test]
fn the_text_a_take_back_hands_over_is_not_kept_as_state() {
	let mut session_store = Store::new();
	let mut answer_store = Store::new();
	let session = SessionId::from("sess-1");

	let plain = report(&session, &["still held"], &[]);
	let answer = HostEvent::Snapshot(SnapshotSection::QueuedPrompts(QueuedPromptsView {
		session,
		steering: vec!["still held".to_owned()],
		follow_up: Vec::new(),
		restored: Some("the prompt taken back".to_owned()),
	}));

	reduce(&mut session_store, plain);
	reduce(&mut answer_store, answer);

	assert_eq!(
		session_store.queued, answer_store.queued,
		"`restored` answers one action on one frame; keeping it would refill the draft from store \
		 state on every later frame"
	);
}

#[test]
fn a_queue_report_repaints_the_composer_of_the_session_it_names() {
	let mut store = Store::new();
	let session = SessionId::from("sess-1");

	let damage = reduce(&mut store, report(&session, &["held"], &[]));
	assert!(
		damage.contains(&Damage::Composer(session.clone())),
		"the strip is composer chrome, so the composer of that session repaints"
	);

	let emptied = reduce(&mut store, report(&session, &[], &[]));
	assert!(
		emptied.contains(&Damage::Composer(session)),
		"the frame that empties the queue must repaint the strip away"
	);
}
