//! WHY: The keyboard table declares the `queue` scope's chords (§5.14), and
//! GPUI matches a chord against the key contexts on the focus path. The
//! rail declares `key_context("Queue")` but held no focus handle, so the
//! context never entered the focus path and all seven chords of the day
//! resolved to nothing: park, defer, pin, open, filter and both selection
//! moves were unreachable from the keyboard, while the same actions worked
//! from the pointer.
//!
//! CLASS CLOSED: a chord declared in a region scope whose context no element
//! can hold. The sweep reads the table at run time and requires every
//! `Scope::Queue` row to reach the shell after the pointer focused the rail,
//! so the next queue chord is covered the moment it is declared, and a scope
//! whose region stops taking focus fails here rather than in a user's hands.
//!
//! GAPS: it does not state which intent each chord dispatches -- that is the
//! contract of `queue-row-hover-actions-and-menu-dispatch.rs` and of the
//! partition tests -- and it says nothing about how the rail reads once
//! focused, which is a capture's business.

#[path = "support/queue-actions/mod.rs"]
mod queue_actions;

use std::path::Path;

use queue_actions::{QueueMetrics, center_of, find_queue_rows, make_per_section_state};
use veyyon_desktop_kit::{load_bundled_theme, load_bundled_tokens};
use veyyon_desktop_scene::{
	HeadlessSession,
	headless::{RenderOptions, headless_context},
};
use veyyon_desktop_surface::{
	Keymap, Row, Scope, ShellState, ShellView, install_tokens, model::Section,
};
use veyyon_gpui::{App, AppContext, Bounds, Pixels};

/// Opens the shell with the shipped keymap bound, which is what makes a
/// keystroke resolve to an action at all.
fn open_with_keys(
	cx: &mut veyyon_desktop_scene::headless::Headless,
	state: ShellState,
) -> HeadlessSession<'_, ShellView> {
	let tokens = load_bundled_tokens().expect("bundled tokens load");
	let theme = load_bundled_theme("dark").expect("bundled dark theme loads");
	let options =
		RenderOptions { width: 1440, height: 900, scale_factor: 1.0, ..RenderOptions::default() };
	HeadlessSession::open(cx, &options, move |_window, app: &mut App| {
		let installed =
			install_tokens(app, &tokens, &theme, Path::new("surface")).expect("tokens install");
		app.bind_keys(Keymap::default().bindings());
		app.new(|_| ShellView::new(installed, state))
	})
	.expect("session opens offscreen")
}

fn live_row(session: &mut HeadlessSession<'_, ShellView>) -> Bounds<Pixels> {
	let metrics = QueueMetrics::load();
	let frame = session.frame().expect("initial frame renders");
	let rows = find_queue_rows(&frame, &metrics);
	let sections = Section::all();
	assert_eq!(
		rows.len(),
		sections.len(),
		"the per-section fixture draws one row per section, top to bottom"
	);
	let live = sections
		.iter()
		.position(|section| *section == Section::Live)
		.expect("Live is a section");
	rows[live]
}

/// Seeds the row the cursor sits on for the verb about to be pressed.
///
/// A fold verb acts on a branch, and the per-section fixture has none, so the
/// cursor's row is made a parent held open for the chord that folds it and
/// folded for the chord that opens it. Every other verb reads the row as the
/// fixture built it.
fn seed_for(row: &mut Row, command: &str) {
	let collapsed = match command {
		"FoldSelectedBranch" => false,
		"UnfoldSelectedBranch" => true,
		_ => return,
	};
	row.is_parent = true;
	row.collapsed = collapsed;
	row.path = format!("branch/{}", row.id);
}

#[test]
fn every_queue_chord_reaches_the_rail_the_pointer_focused() {
	let queue_chords: Vec<(String, String)> = Keymap::default()
		.rows()
		.into_iter()
		.filter(|row| row.scope == Scope::Queue)
		.map(|row| (row.chord, row.command.name().to_owned()))
		.collect();
	assert!(
		queue_chords.len() >= 7,
		"the shipped table declares the queue scope's chords; found {queue_chords:?}"
	);

	let mut cx = headless_context().expect("headless renderer is required");
	let mut session = open_with_keys(&mut cx, make_per_section_state());
	let row = live_row(&mut session);

	let mut unreachable: Vec<String> = Vec::new();
	for (chord, command) in &queue_chords {
		// The pointer establishes the rail's scope, exactly as it does for the
		// transcript, and the cursor is seeded on a row with a listed row on
		// either side of it and with the open session somewhere else. That is
		// the one arrangement where every queue verb has work: §5.14 leaves an
		// arrow nothing to do at the end of the rail and leaves `Enter`
		// nothing to do while the cursor is on the session already open.
		session
			.click(center_of(row))
			.expect("pointer focuses the rail");
		let before = session
			.update(|view, _window, _cx| {
				let listed: Vec<u64> = view.state().listed_rows().map(|row| row.id).collect();
				assert!(
					listed.len() >= 3,
					"the fixture lists {} rows, and the cursor needs one on either side of it",
					listed.len()
				);
				let anchor = listed[listed.len() / 2];
				assert_ne!(
					anchor,
					view.state().current_id,
					"the seeded cursor is the open session, so Enter has nothing to open"
				);
				view.state_mut().keymap.queue_cursor = Some(anchor);
				if let Some(row) = view
					.state_mut()
					.sections
					.iter_mut()
					.flat_map(|(_, rows)| rows.iter_mut())
					.find(|row| row.id == anchor)
				{
					seed_for(row, command);
				}
				let _ = view.drain_intents();
				view.state().clone()
			})
			.expect("state before the chord");
		let handled = session.keystroke(chord).expect("chord dispatches");
		// A chord reaches the shell either as an intent a host must answer or
		// as a window-local change: `MoveSelection` is local, so an empty
		// intent queue is not silence.
		let observed = session
			.update(|view, _window, _cx| !view.drain_intents().is_empty() || *view.state() != before)
			.expect("effect read");
		if !handled || !observed {
			unreachable.push(format!("{chord} (handled={handled}, observed={observed})"));
		}
		session
			.keystroke("escape")
			.expect("dismiss whatever opened");
		session.frame().expect("frame after the chord");
	}

	assert_eq!(
		unreachable,
		Vec::<String>::new(),
		"every chord the table declares in the queue scope must reach the shell once the rail is \
		 focused"
	);
}
