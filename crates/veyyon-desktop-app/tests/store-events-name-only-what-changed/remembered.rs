//! What the window writes to disk because of a choice made in the window.
//!
//! WHY: the window schedules its debounced write on the store events it
//! receives, and a draft, a fold, a panel tab, the diff layout, the appearance
//! and a review thread changed the persisted state without emitting one. Each
//! reached the disk only when some unrelated host event arrived, or at a clean
//! close, so an idle window that was killed lost them. Every such change now
//! goes through one writer that emits `StoreEvent::Remembered`.
//!
//! The sweep drives each public method that changes the persisted state and
//! asserts it changed the state and emitted `Remembered` and nothing else.
//!
//! Gap: the sweep lists the methods by hand. A new method that writes
//! `store.persisted` directly instead of through `AppState::remember` is not
//! caught here; the store is private to the `state` module, which is the only
//! place such a write can be added.

use std::{cell::RefCell, rc::Rc};

use veyyon_desktop_app::{AppState, StoreEvent};
use veyyon_desktop_model::{
	ChangeScope, ComposerStore, DiffMode, PanelsStore, PersistedState, Store, TranscriptAnchor,
	review::{ReviewAnchor, ReviewSide},
};
use veyyon_desktop_ui::theme::Appearance;
use veyyon_gpui::{AppContext as _, Context, Entity, TestAppContext};

use super::{listing, opened, sid, summary};

/// One change the window makes to a store it writes.
type Change = fn(&mut AppState, &mut Context<AppState>);

/// A review anchor on line 1 of `src/a.rs`.
fn anchor() -> ReviewAnchor {
	ReviewAnchor {
		repository:    "/w/a".to_owned(),
		file:          "src/a.rs".to_owned(),
		scope:         ChangeScope::WorkingTree,
		side:          ReviewSide::New,
		original_line: 1,
		text:          "fn a() {}".to_owned(),
		before:        None,
		after:         None,
		ambiguous:     false,
	}
}

/// Every public change to the persisted state a view makes, by name.
const CHANGES: &[(&str, Change)] = &[
	("choose_appearance", |app, cx| app.choose_appearance(Some(Appearance::Light), cx)),
	("save_draft", |app, cx| {
		let draft =
			ComposerStore { draft_text: "half a prompt".to_owned(), ..ComposerStore::default() };
		app.save_draft(sid("a"), draft, cx);
	}),
	("toggle_section", |app, cx| app.toggle_section("pinned", cx)),
	("toggle_project", |app, cx| app.toggle_project("/w/a", cx)),
	("toggle_branches", |app, cx| app.toggle_branches(&sid("a"), cx)),
	("list_archived_pages", |app, cx| app.list_archived_pages(3, cx)),
	("set_active_right_tab", |app, cx| app.set_active_right_tab("files", cx)),
	("set_active_drawer_tab", |app, cx| app.set_active_drawer_tab("processes", cx)),
	("set_diff_mode", |app, cx| app.set_diff_mode(DiffMode::Split, cx)),
	("record_layout", |app, cx| {
		let layout = PanelsStore { queue_width: Some(333), ..PanelsStore::default() };
		app.record_layout(&layout, cx);
	}),
	("update_reviews", |app, cx| {
		app.update_reviews(cx, |reviews| reviews.create(anchor(), "why this line"));
	}),
	("set_read_position", |app, cx| {
		let anchor = TranscriptAnchor { entry_id: "e2".to_owned(), offset_px: 6 };
		app.set_read_position(sid("a"), Some(anchor), cx);
	}),
];

/// A state listing session `a` with a file, displaying it when `displayed`,
/// and the events it emits from then on.
fn state(cx: &TestAppContext, displayed: bool) -> (Entity<AppState>, Rc<RefCell<Vec<StoreEvent>>>) {
	let state = cx.update(|app| app.new(|_| AppState::new(Store::new())));
	cx.update(|app| {
		state.update(app, |state, cx| {
			let mut events = vec![listing(vec![summary("a", "/w/a", 1, None)])];
			if displayed {
				events.extend(opened("a", 1, 1));
			}
			state.apply(events, cx);
		});
	});
	cx.update(|app| {
		let shown = state.read(app).active_session().cloned();
		assert_eq!(shown, displayed.then(|| sid("a")), "the precondition: `a` displayed");
	});
	let seen: Rc<RefCell<Vec<StoreEvent>>> = Rc::default();
	cx.update(|app| {
		let seen = Rc::clone(&seen);
		app.subscribe(&state, move |_, event: &StoreEvent, _| seen.borrow_mut().push(event.clone()))
			.detach();
	});
	(state, seen)
}

/// The persisted state before and after `change`.
fn around(
	cx: &TestAppContext,
	state: &Entity<AppState>,
	change: Change,
) -> (PersistedState, PersistedState) {
	let persisted = |cx: &TestAppContext| cx.update(|app| state.read(app).store().persisted.clone());
	let before = persisted(cx);
	cx.update(|app| state.update(app, change));
	(before, persisted(cx))
}

#[test]
fn every_change_to_a_remembered_store_emits_remembered_and_nothing_else() {
	for (name, change) in CHANGES {
		let cx = TestAppContext::single();
		let (state, seen) = state(&cx, true);
		let (before, after) = around(&cx, &state, *change);
		assert_ne!(before, after, "{name} changed no store the window writes");
		assert_eq!(seen.take(), vec![StoreEvent::Remembered], "{name}");
	}
}

#[test]
fn a_panel_change_with_no_session_displayed_records_nothing_and_schedules_nothing() {
	let panel = ["set_active_right_tab", "set_active_drawer_tab", "set_diff_mode", "record_layout"];
	for (name, change) in CHANGES.iter().filter(|(name, _)| panel.contains(name)) {
		let cx = TestAppContext::single();
		let (state, seen) = state(&cx, false);
		let (before, after) = around(&cx, &state, *change);
		assert_eq!(before, after, "{name}");
		assert_eq!(seen.take(), Vec::<StoreEvent>::new(), "{name}");
	}
}

#[test]
fn a_read_position_written_again_unchanged_schedules_nothing() {
	let cx = TestAppContext::single();
	let (state, seen) = state(&cx, true);
	let (before, after) = around(&cx, &state, |app, cx| app.set_read_position(sid("a"), None, cx));
	assert_eq!(before, after, "the live edge was already remembered");
	assert_eq!(seen.take(), Vec::<StoreEvent>::new(), "an unchanged position schedules no write");
}
