//! WHY: a scoped frame is correct only when its damage covers every pixel the
//! state change can reach. Two reach rules are invisible until they corrupt a
//! frame: the composer's float blurs the transcript's tail, so a change to the
//! last turn changes pixels inside the float; and the overlay's scrim blurs
//! the whole columns row, so a change beneath an open overlay reaches every
//! column pixel. A damage set that misses the first leaves the float stale;
//! one that stops at the second's region boundary slices the scrim's blur and
//! samples stale pixels across the cut.
//!
//! The class this closes is "damage under-declared against a blur". It does
//! not prove the renderer composites the declared set correctly; the streaming
//! parity bench in the desktop crate proves that end to end.

use veyyon_desktop_surface::{
	Overlay, PaletteState, ShellState,
	damage::{Invalidation, Region, regions_changed},
	model::{Card, Turn},
};

fn state_with_transcript(turns: &[&str]) -> ShellState {
	ShellState {
		transcript: turns
			.iter()
			.map(|text| Turn::Operator((*text).to_owned()))
			.collect(),
		..ShellState::default()
	}
}

fn regions(invalidation: &Invalidation) -> &[Region] {
	match invalidation {
		Invalidation::Within(regions) => regions,
		other => panic!("expected a scoped invalidation, got {other:?}"),
	}
}

#[test]
fn a_change_to_the_last_turn_repaints_the_float_that_blurs_it() {
	let last = state_with_transcript(&["one", "two", "tail"]);
	let mut next = last.clone();
	*next.transcript.last_mut().expect("a last turn") = Turn::Operator("tail grew".to_owned());

	let changed = regions_changed(&last, &next);
	let regions = regions(&changed);
	assert!(regions.contains(&Region::Turn(2)), "the changed turn is its own region: {regions:?}");
	assert!(
		regions.contains(&Region::Composer),
		"the float blurring the tail repaints with it: {regions:?}"
	);
}

#[test]
fn a_change_to_an_earlier_turn_leaves_the_float_alone() {
	let last = state_with_transcript(&["one", "two", "tail"]);
	let mut next = last.clone();
	next.transcript[0] = Turn::Operator("one grew".to_owned());

	let changed = regions_changed(&last, &next);
	let regions = regions(&changed);
	assert!(regions.contains(&Region::Turn(0)), "the changed turn: {regions:?}");
	assert!(
		!regions.contains(&Region::Composer),
		"the first turn is beyond the float's blur: {regions:?}"
	);
}

#[test]
fn a_last_turn_change_with_cards_showing_repaints_the_cards_between() {
	let mut last = state_with_transcript(&["one", "tail"]);
	last.cards = vec![Card::Plan { title: "Ship it".to_owned(), body: vec!["- step".to_owned()] }];
	let mut next = last.clone();
	*next.transcript.last_mut().expect("a last turn") = Turn::Operator("tail grew".to_owned());

	let changed = regions_changed(&last, &next);
	let regions = regions(&changed);
	assert!(regions.contains(&Region::Turn(1)), "the changed turn: {regions:?}");
	assert!(
		regions.contains(&Region::Cards),
		"the cards sit between the tail and the float: {regions:?}"
	);
	assert!(regions.contains(&Region::Composer), "the float below them: {regions:?}");
}

#[test]
fn a_change_beneath_an_open_overlay_repaints_the_window() {
	let last = state_with_transcript(&["one", "tail"]);
	let mut next = last;
	next.overlay = Some(Overlay::Palette(PaletteState::default()));
	next.title = "renamed".to_owned();

	// Opening the overlay is itself a full repaint; the rule under test is
	// what a later change beneath the open overlay does.
	let open = next;
	let mut beneath = open.clone();
	beneath.title = "renamed again".to_owned();

	assert_eq!(
		regions_changed(&open, &beneath),
		Invalidation::Full,
		"a title change beneath the scrim reaches every blurred pixel"
	);
}

#[test]
fn an_unchanged_state_declares_nothing() {
	let state = state_with_transcript(&["one", "tail"]);
	assert_eq!(regions_changed(&state, &state), Invalidation::Nothing);
}
