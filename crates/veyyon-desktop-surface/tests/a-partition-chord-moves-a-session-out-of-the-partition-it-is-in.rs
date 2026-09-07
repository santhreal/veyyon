//! WHY: `P`, `D` and `K` are declared as toggles -- pin / unpin, defer /
//! recall, park / unpark (§5.14) -- and each dispatched only the move in.
//! Pressing `K` on a parked session parked it again, so nothing the keyboard
//! could do brought a session back to `Live`, and `Pinned` had no way out at
//! all.
//!
//! CLASS CLOSED: a partition chord that reads one direction. Every chord the
//! table declares for a partition is pressed on a row in every section the
//! rail draws, so the pair is asserted in both directions for each, and a new
//! partition chord fails here until its two intents are stated.
//!
//! GAPS: it does not prove the chord is reachable, which is
//! `every-queue-chord-reaches-the-rail-the-pointer-focused.rs`, nor that the
//! store honours the intent, which is the desktop crate's partition suite.

#[path = "support/queue-actions/mod.rs"]
mod queue_actions;

use std::path::Path;

use queue_actions::{QueueMetrics, center_of, find_queue_rows, make_per_section_state};
use veyyon_desktop_kit::{load_bundled_theme, load_bundled_tokens};
use veyyon_desktop_scene::{
	HeadlessSession,
	headless::{Headless, RenderOptions, headless_context},
};
use veyyon_desktop_surface::{
	Command, Intent, Keymap, Scope, ShellState, ShellView, install_tokens, model::Section,
};
use veyyon_gpui::{App, AppContext};

fn open_with_keys(cx: &mut Headless, state: ShellState) -> HeadlessSession<'_, ShellView> {
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

/// The partition a chord names, for the chords that move a session between
/// partitions. A chord that does something else returns `None`.
fn partition_of(command: Command) -> Option<Section> {
	match command {
		Command::TogglePinSelected => Some(Section::Pinned),
		Command::ToggleDeferSelected => Some(Section::Deferred),
		Command::ToggleParkSelected => Some(Section::Parked),
		_ => None,
	}
}

/// What the chord for `target` must dispatch for a session sitting in `held`:
/// the move out when the session is already there, the move in otherwise.
fn expected(target: Section, held: Section, row: u64) -> Intent {
	match (target, target == held) {
		(Section::Pinned, false) => Intent::PinSession(row),
		(Section::Pinned, true) => Intent::UnpinSession(row),
		(Section::Deferred, false) => Intent::DeferSession(row),
		(Section::Deferred, true) => Intent::RecallSession(row),
		(Section::Parked, false) => Intent::ParkSession(row),
		(Section::Parked, true) => Intent::UnparkSession(row),
		(Section::Unsent | Section::Live, _) => {
			panic!("no chord names {target:?}")
		},
	}
}

#[test]
fn a_partition_chord_moves_a_session_out_of_the_partition_it_is_in() {
	let partition_chords: Vec<(String, Section)> = Keymap::default()
		.rows()
		.into_iter()
		.filter(|row| row.scope == Scope::Queue)
		.filter_map(|row| partition_of(row.command).map(|section| (row.chord, section)))
		.collect();
	assert_eq!(
		partition_chords
			.iter()
			.map(|(_, section)| *section)
			.collect::<Vec<_>>(),
		vec![Section::Pinned, Section::Deferred, Section::Parked],
		"the queue scope names one chord per partition an operator moves a session between"
	);

	let mut cx = headless_context().expect("headless renderer is required");
	for (chord, target) in &partition_chords {
		for (index, held) in Section::all().into_iter().enumerate() {
			let row_id = (index as u64) + 101;
			let mut state = make_per_section_state();
			// The chord acts on the session the rail has open, which is the row
			// a click selects.
			state.current_id = row_id;
			let mut session = open_with_keys(&mut cx, state);
			let metrics = QueueMetrics::load();
			let frame = session.frame().expect("initial frame renders");
			let rows = find_queue_rows(&frame, &metrics);
			assert_eq!(rows.len(), Section::all().len(), "one row per section");
			session
				.click(center_of(rows[index]))
				.expect("pointer focuses the rail on the row");
			session
				.update(|view, _window, _cx| {
					let _ = view.drain_intents();
				})
				.expect("intents drained");

			assert!(
				session.keystroke(chord).expect("chord dispatches"),
				"{chord} must reach the rail with the row in {held:?} selected"
			);
			session
				.update(|view, _window, _cx| {
					assert_eq!(
						view.drain_intents(),
						vec![expected(*target, held, row_id)],
						"{chord} on a row in {held:?} must move it {}",
						if *target == held {
							"back out to Live"
						} else {
							"into the partition the chord names"
						}
					);
				})
				.expect("dispatched intent read");
		}
	}
}
