//! WHY: an extension's calls on its UI surface reached the desktop nowhere.
//! Status text, the working message and widgets were dropped, an edit to the
//! draft never reached the composer, extension completions were never
//! offered, and a notice was never announced.
//!
//! THE CLASS THIS CLOSES:
//! - An edit queue that changes what the draft becomes. Every sequence of up to
//!   five `Set` and `Paste` edits, over every edit kind, is queued and the
//!   queue applied to a draft; the result must equal applying the edits one by
//!   one, and the queue must never hold more than two entries.
//! - An edit taken twice, or taken by the wrong session.
//! - A late answer to an earlier completion query replacing the newest one.
//! - A notice level announced at a priority other than the one the terminal
//!   level maps to, for every `ExtensionNoticeLevel`, and a repeated notice
//!   filling the stack.
//!
//! WHAT IT DOES NOT CATCH: whether the composer applies an edit at the caret
//! the way this suite's model of a paste does, which is the composer's suite;
//! and whether the host numbers its edits in the order it makes them, which
//! the host suite drives.

use strum::IntoEnumIterator as _;
use veyyon_desktop_model::{
	Damage, HostEvent, NotificationPriority, NotificationSource, SessionId, SnapshotSection, Store,
	domain::{
		ComposerCompletionView, ComposerCompletionsView, ComposerEditKind, ComposerEditView,
		ExtensionNoticeLevel, ExtensionNoticeView, ExtensionStatusView, ExtensionUiView,
		queue_composer_edit,
	},
	reduce,
};

fn edit(session: &str, seq: u64, kind: ComposerEditKind, text: &str) -> HostEvent {
	HostEvent::Snapshot(SnapshotSection::ComposerEdit {
		session: session.into(),
		edit:    ComposerEditView { seq, kind, text: text.into() },
	})
}

/// A draft with the caret at its end after every edit, which is where a set
/// leaves it and where a paste leaves it.
fn apply(draft: &str, edits: &[ComposerEditView]) -> String {
	let mut text = draft.to_owned();
	for edit in edits {
		match edit.kind {
			ComposerEditKind::Set => text.clone_from(&edit.text),
			ComposerEditKind::Paste => text.push_str(&edit.text),
		}
	}
	text
}

/// Every sequence of `len` edit kinds, in a fixed order.
fn sequences(len: usize) -> Vec<Vec<ComposerEditKind>> {
	let kinds: Vec<ComposerEditKind> = ComposerEditKind::iter().collect();
	let mut out = vec![Vec::new()];
	for _ in 0..len {
		out = out
			.into_iter()
			.flat_map(|prefix| {
				kinds.iter().map(move |kind| {
					let mut next = prefix.clone();
					next.push(*kind);
					next
				})
			})
			.collect();
	}
	out
}

#[test]
fn a_queued_edit_sequence_leaves_the_draft_the_edits_leave_it_and_holds_at_most_two() {
	for len in 1..=5 {
		for kinds in sequences(len) {
			let edits: Vec<ComposerEditView> = kinds
				.iter()
				.enumerate()
				.map(|(index, kind)| ComposerEditView {
					seq:  index as u64 + 1,
					kind: *kind,
					text: format!("<{index}>"),
				})
				.collect();
			let mut queue = Vec::new();
			for one in &edits {
				queue_composer_edit(&mut queue, one.clone());
			}
			assert!(queue.len() <= 2, "{kinds:?} queued {} edits", queue.len());
			assert_eq!(
				queue.last().map(|last| last.seq),
				Some(len as u64),
				"{kinds:?}: the queue does not end at the last edit"
			);
			assert_eq!(
				apply("draft", &queue),
				apply("draft", &edits),
				"{kinds:?}: the queue leaves a different draft than the edits"
			);
		}
	}
}

#[test]
fn an_edit_is_taken_once_and_only_by_its_session() {
	let mut store = Store::new();
	let damage = reduce(&mut store, edit("s1", 1, ComposerEditKind::Set, "hello"));
	assert_eq!(damage.iter().cloned().collect::<Vec<_>>(), [Damage::Composer("s1".into())]);
	reduce(&mut store, edit("s2", 2, ComposerEditKind::Paste, " there"));

	let taken = store.domains.take_composer_edits(&SessionId::from("s1"));
	assert_eq!(taken, [ComposerEditView {
		seq:  1,
		kind: ComposerEditKind::Set,
		text: "hello".into(),
	}]);
	assert!(
		store
			.domains
			.take_composer_edits(&SessionId::from("s1"))
			.is_empty()
	);
	assert_eq!(
		store
			.domains
			.take_composer_edits(&SessionId::from("s2"))
			.len(),
		1
	);
}

fn answer(query: u64, label: &str) -> HostEvent {
	HostEvent::Snapshot(SnapshotSection::ComposerCompletions {
		session:     "s1".into(),
		completions: ComposerCompletionsView {
			query,
			items: vec![ComposerCompletionView {
				label:         label.into(),
				description:   None,
				replace_start: 0,
				replace_end:   1,
				insert:        label.into(),
				caret:         1,
			}],
		},
	})
}

fn held_query(store: &Store) -> Option<(u64, String)> {
	store
		.domains
		.completions
		.get(&SessionId::from("s1"))
		.map(|held| (held.query, held.items[0].label.clone()))
}

#[test]
fn a_late_answer_to_an_earlier_query_never_replaces_the_newest() {
	let mut store = Store::new();
	reduce(&mut store, answer(2, "newer"));
	let damage = reduce(&mut store, answer(1, "older"));
	assert!(damage.is_empty(), "a stale answer repainted {damage:?}");
	assert_eq!(held_query(&store), Some((2, "newer".into())));

	reduce(&mut store, answer(2, "restated"));
	assert_eq!(held_query(&store), Some((2, "restated".into())));
	reduce(&mut store, answer(3, "next"));
	assert_eq!(held_query(&store), Some((3, "next".into())));
}

#[test]
fn chrome_that_states_nothing_leaves_no_entry() {
	let mut store = Store::new();
	let chrome = |ui: ExtensionUiView| {
		HostEvent::Snapshot(SnapshotSection::ExtensionUi { session: "s1".into(), ui })
	};
	reduce(
		&mut store,
		chrome(ExtensionUiView {
			statuses: vec![ExtensionStatusView { key: "lint".into(), text: "2 warnings".into() }],
			..ExtensionUiView::default()
		}),
	);
	assert!(
		store
			.domains
			.extension_ui
			.contains_key(&SessionId::from("s1"))
	);
	reduce(&mut store, chrome(ExtensionUiView::default()));
	assert!(store.domains.extension_ui.is_empty());
}

fn notice(session: &str, level: ExtensionNoticeLevel, message: &str) -> HostEvent {
	HostEvent::Snapshot(SnapshotSection::ExtensionNotice {
		session: session.into(),
		notice:  ExtensionNoticeView { level, message: message.into(), raised_at_ms: 1_000 },
	})
}

#[test]
fn every_notice_level_is_announced_at_the_priority_the_terminal_gives_it() {
	for level in ExtensionNoticeLevel::iter() {
		let expected = match level {
			ExtensionNoticeLevel::Info => NotificationPriority::Low,
			ExtensionNoticeLevel::Warning => NotificationPriority::Normal,
			ExtensionNoticeLevel::Error => NotificationPriority::Urgent,
		};
		let mut store = Store::new();
		let damage = reduce(&mut store, notice("s1", level, "lint server exited"));
		assert_eq!(damage.iter().cloned().collect::<Vec<_>>(), [Damage::Notifications]);
		let [held] = store.notifications.raised() else {
			panic!("{level:?} raised {} cards", store.notifications.len());
		};
		assert_eq!(held.source, NotificationSource::Extension);
		assert_eq!(held.priority, expected, "{level:?}");
		assert_eq!(held.title, "lint server exited");
	}
}

#[test]
fn a_repeated_notice_is_one_card_and_another_message_or_session_is_another() {
	let mut store = Store::new();
	for _ in 0..10 {
		reduce(&mut store, notice("s1", ExtensionNoticeLevel::Error, "lint server exited"));
	}
	assert_eq!(store.notifications.len(), 1);
	reduce(&mut store, notice("s1", ExtensionNoticeLevel::Error, "formatter exited"));
	reduce(&mut store, notice("s2", ExtensionNoticeLevel::Error, "lint server exited"));
	assert_eq!(store.notifications.len(), 3);
}
