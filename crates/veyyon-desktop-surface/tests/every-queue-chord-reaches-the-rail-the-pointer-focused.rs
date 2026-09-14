//! WHY: The keyboard table declares seven chords in the `queue` scope (§5.14),
//! and GPUI matches a chord against the key contexts on the focus path. The
//! rail declares `key_context("Queue")` but held no focus handle, so the
//! context never entered the focus path and all seven chords resolved to
//! nothing: park, defer, pin, open, filter and both selection moves were
//! unreachable from the keyboard, while the same actions worked from the
//! pointer.
//!
//! CLASS CLOSED: a chord declared in a region scope whose context no element
//! can hold. The sweep reads the table at run time and requires every
//! `Scope::Queue` row to reach the shell after the pointer focused the rail, so
//! an eighth queue chord is covered the moment it is declared, and a scope
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
	Keymap, Scope, ShellState, ShellView, install_tokens, model::Section,
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

#[test]
fn every_queue_chord_reaches_the_rail_the_pointer_focused() {
	let queue_chords: Vec<String> = Keymap::default()
		.rows()
		.into_iter()
		.filter(|row| row.scope == Scope::Queue)
		.map(|row| row.chord)
		.collect();
	assert!(
		queue_chords.len() >= 7,
		"the shipped table declares the queue scope's chords; found {queue_chords:?}"
	);

	let mut cx = headless_context().expect("headless renderer is required");
	let mut session = open_with_keys(&mut cx, make_per_section_state());
	let row = live_row(&mut session);

	let mut unreachable: Vec<String> = Vec::new();
	for chord in &queue_chords {
		// The pointer establishes the rail's scope, exactly as it does for the
		// transcript, and each chord starts from that same state.
		session
			.click(center_of(row))
			.expect("pointer focuses the rail");
		let before = session
			.update(|view, _window, _cx| {
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
