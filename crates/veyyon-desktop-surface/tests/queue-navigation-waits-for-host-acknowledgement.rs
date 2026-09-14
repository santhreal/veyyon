//! WHY: filtering and keyboard movement must not replace the acknowledged
//! session before its host request succeeds. This covers the shared Intents
//! dispatch boundary and creation; actual host acknowledgement and pointer
//! projection are exercised by desktop tests.

mod support;

use veyyon_desktop_surface::{Intent, intent::Intents};

#[test]
fn filtering_changes_only_the_filter_even_when_the_active_row_is_hidden() {
	for query in ["second", "THIRD", "missing", " ", ""] {
		let mut state = support::state();
		let before = state.clone();
		let mut intents = Intents::new();
		intents.dispatch(Intent::FilterQueue(query.into()), &mut state);
		assert_eq!(state.current_id, before.current_id);
		assert_eq!(state.title, before.title);
		assert_eq!(state.composer, before.composer);
		assert_eq!(state.sections, before.sections);
		assert_eq!(state.keymap.queue_filter.as_deref(), (!query.trim().is_empty()).then_some(query));
		assert!(intents.drain().is_empty());
	}
}

#[test]
fn movement_dispatches_the_filtered_target_without_changing_the_displayed_session() {
	for (current, filter, delta, target) in [
		(7, None, 1, Some(9)),
		(9, None, -1, Some(7)),
		(9, None, i32::MAX, Some(11)),
		(9, None, i32::MIN, Some(7)),
		(7, None, -1, None),
		(11, None, 1, None),
		(9, None, 0, None),
		(7, Some("third"), 1, Some(11)),
		(7, Some("third"), -1, Some(11)),
		(7, Some("missing"), 1, None),
	] {
		let mut state = support::state();
		state.current_id = current;
		state.title = state.row(current).unwrap().title.clone();
		state.keymap.queue_filter = filter.map(str::to_owned);
		let before = state.clone();
		let mut intents = Intents::new();
		intents.dispatch(Intent::MoveQueueSelection(delta), &mut state);
		assert_eq!(state, before, "keyboard movement must await host acknowledgement");
		assert_eq!(
			intents.drain(),
			target
				.map(Intent::SelectSession)
				.into_iter()
				.collect::<Vec<_>>()
		);
	}
}

#[test]
fn creation_and_branch_requests_preserve_the_current_draft_and_session() {
	for intent in [Intent::NewSession, Intent::BranchSession(7), Intent::BranchTurn(0)] {
		let mut state = support::state();
		state.composer.attachments.push(support::attachment());
		state.keymap.queue_filter = Some("second".into());
		let before = state.clone();
		let mut intents = Intents::new();
		intents.dispatch(intent.clone(), &mut state);
		assert_eq!(state.current_id, before.current_id);
		assert_eq!(state.title, before.title);
		assert_eq!(state.composer, before.composer);
		if intent == Intent::NewSession {
			assert_eq!(state.keymap.queue_filter, None);
		}
		assert_eq!(intents.drain(), [intent]);
	}
}
