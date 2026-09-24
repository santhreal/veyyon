//! WHY: `keymap.queue_filter` had no producer. `/` in the Queue scope opened a
//! palette over the rail's own rows and ranked them there, the rail kept
//! listing every session, and `Intent::FilterQueue` -- the command whose label
//! is "Filter queue in place" -- was dispatched with an empty string by the
//! header's clear control and by nothing else. So the rail's narrowed state,
//! the header's filter chip, that clear control and the empty state under them
//! were unreachable: copy nobody could see, which is how the empty state came
//! to restate its own condition without anyone noticing.
//!
//! CLASS CLOSED: a mode that ranks the rows the window already holds narrows
//! the rail as it is typed; one that ranks rows the host answered with does
//! not. The sweep is over `PaletteMode::iter()`, so a mode added to the enum
//! turns this red until its side of that line is recorded:
//! 1. Exactly the rail's own session search narrows the rail. The modes that
//!    leave it alone are pinned by exact equality rather than by count.
//! 2. A query that matches nothing leaves the rail listing no row while the
//!    sections it filters still hold every one of them, which is the state
//!    `EmptySurface::QueueFiltered` states a step out of.
//! 3. The filter outlives the palette it was typed in, so the step that empty
//!    state names -- clearing the filter -- is reachable after the overlay
//!    closes, and the header's clear control widens the rail again.
//! 4. Narrowing reports nothing to the host and moves no session: it is the
//!    window's own filter over rows it already has.
//!
//! NOT CAUGHT: that `/` is the chord bound to it, which
//! `every-chord-a-region-scope-declares-reaches-the-surface-it-names.rs`
//! sweeps; and the sentences the narrowed rail draws, which
//! `a-surface-with-nothing-on-it-states-the-condition-and-the-step.rs` sweeps.

mod support;

use strum::IntoEnumIterator;
use veyyon_desktop_surface::{
	Intent, Overlay,
	intent::Intents,
	palette::{PaletteMode, PaletteState},
};

/// The palette the rail's own search opens: the rail's sections, ranked by the
/// window rather than by the host.
fn rail_search(state: &veyyon_desktop_surface::ShellState) -> PaletteState {
	PaletteState::from_sessions(&state.sections)
}

/// The modes that leave the rail as it is, because their rows are the host's
/// answer to what was typed rather than the rail's own.
fn leaves_the_rail_alone() -> Vec<PaletteMode> {
	vec![
		PaletteMode::Commands,
		PaletteMode::Files,
		PaletteMode::ContentSearch,
		PaletteMode::Browse,
		PaletteMode::Models,
		PaletteMode::PromptHistory,
	]
}

#[test]
fn only_the_rails_own_session_search_narrows_the_rail() {
	let mut untouched: Vec<PaletteMode> = Vec::new();
	for mode in PaletteMode::iter() {
		let mut state = support::state();
		state.overlay = Some(Overlay::Palette(PaletteState::new(mode)));
		let mut intents = Intents::new();
		intents.dispatch(Intent::PaletteQuery("second".to_owned()), &mut state);
		match state.keymap.queue_filter.as_deref() {
			Some(filter) => assert_eq!(
				(mode, filter),
				(PaletteMode::Sessions, "second"),
				"{mode:?} narrowed the rail to {filter:?}"
			),
			None => untouched.push(mode),
		}
	}
	assert_eq!(
		untouched,
		leaves_the_rail_alone(),
		"which modes leave the rail alone is a decision, and this is the record of it"
	);
}

#[test]
fn a_history_search_ranks_the_hosts_sessions_and_leaves_the_rail_listing_its_own() {
	let mut state = support::state();
	state.overlay = Some(Overlay::Palette(PaletteState::history(String::new())));
	let mut intents = Intents::new();
	intents.dispatch(Intent::PaletteQuery("second".to_owned()), &mut state);
	assert_eq!(state.keymap.queue_filter, None);
}

#[test]
fn a_query_matching_no_session_leaves_the_rail_listing_none_of_them() {
	let mut state = support::state();
	let sections = state.sections.clone();
	state.overlay = Some(Overlay::Palette(rail_search(&state)));
	let mut intents = Intents::new();
	intents.dispatch(Intent::PaletteQuery("no-session-carries-this".to_owned()), &mut state);
	assert_eq!(state.keymap.queue_filter.as_deref(), Some("no-session-carries-this"));
	assert_eq!(state.listed_rows().count(), 0);
	// The rows are filtered, not dropped: the step out of the empty rail is to
	// clear the filter, which only works if the sessions are still there.
	assert_eq!(state.sections, sections);
	assert!(state.sections.iter().any(|(_, rows)| !rows.is_empty()));
}

#[test]
fn the_filter_outlives_the_palette_and_the_clear_control_widens_the_rail() {
	let mut state = support::state();
	let listed = state.listed_rows().count();
	assert!(listed > 1, "the fixture rail lists {listed} rows, too few to narrow");
	state.overlay = Some(Overlay::Palette(rail_search(&state)));
	let mut intents = Intents::new();
	intents.dispatch(Intent::PaletteQuery("second".to_owned()), &mut state);
	let narrowed = state.listed_rows().count();
	assert!(
		narrowed < listed,
		"the rail listed {narrowed} of {listed} rows for a query one matches"
	);

	intents.dispatch(Intent::CloseOverlay, &mut state);
	assert!(state.overlay.is_none());
	assert_eq!(
		state.keymap.queue_filter.as_deref(),
		Some("second"),
		"the filter left with the palette, so the chip and its clear control name nothing"
	);
	assert_eq!(state.listed_rows().count(), narrowed);

	// What the header's clear control dispatches.
	intents.dispatch(Intent::FilterQueue(String::new()), &mut state);
	assert_eq!(state.keymap.queue_filter, None);
	assert_eq!(state.listed_rows().count(), listed);
}

#[test]
fn narrowing_the_rail_reports_nothing_and_moves_no_session() {
	let mut state = support::state();
	state.overlay = Some(Overlay::Palette(rail_search(&state)));
	let before = state.clone();
	let mut intents = Intents::new();
	intents.dispatch(Intent::PaletteQuery("second".to_owned()), &mut state);
	assert!(
		intents.drain().is_empty(),
		"the window filters rows it already holds, so the host is asked nothing"
	);
	assert_eq!(state.current_id, before.current_id);
	assert_eq!(state.title, before.title);
	assert_eq!(state.composer, before.composer);
	assert_eq!(state.sections, before.sections);
}
