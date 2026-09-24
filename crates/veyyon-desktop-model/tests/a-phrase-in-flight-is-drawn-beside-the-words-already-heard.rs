//! WHY: the recogniser hands the composer a committed utterance and the phrase
//! still being said, and the window draws them as one sentence. It prefixes
//! every segment after the first with a leading space, because the terminal
//! composer inserts segment text at its cursor and that is where the gap
//! between two phrases comes from. The host sends that text unchanged, so the
//! separator arrives inside `partial`. Joining the two on a space here drew two
//! spaces between every committed phrase and the one being said after it.
//!
//! CLASS CLOSED: a projection that re-derives a separator the wire already
//! carries. The preview is swept over every arrangement of empty and non-empty
//! halves rather than over the one that was reported, and the chip over every
//! state with words and without them. `DictationState::iter()` supplies the
//! states, so a fourth one turns this red until it is given a wire string, a
//! label distinct from the others, and a chip that leads with it.
//!
//! NOT CAUGHT: whether the window writes the preview into the field, which is
//! `veyyon-desktop`'s composer and has its own suite; and the recogniser's own
//! prefixing rule, which is `STTController`'s and is pinned on that side.

use strum::IntoEnumIterator as _;
use veyyon_desktop_model::{
	Damage, DictationState, DictationView, HostEvent, SessionId, SnapshotSection, Store, reduce,
};

fn heard(utterance: &str, partial: &str) -> DictationView {
	DictationView {
		utterance: utterance.to_string(),
		partial: partial.to_string(),
		..DictationView::default()
	}
}

#[test]
fn a_prefixed_phrase_in_flight_joins_the_committed_words_with_one_space() {
	// Exactly what the recogniser sends after committing "ship the desktop":
	// the next partial arrives already carrying its separator.
	let view = heard("ship the desktop", " parity work");
	assert_eq!(view.preview(), "ship the desktop parity work");
}

#[test]
fn every_arrangement_of_the_two_halves_previews_without_inventing_a_separator() {
	let cases = [
		(heard("", ""), ""),
		(heard("ship it", ""), "ship it"),
		// The first phrase of a dictation carries no prefix, because nothing
		// has been committed for it to follow.
		(heard("", "ship it"), "ship it"),
		(heard("ship it", " now"), "ship it now"),
	];
	for (view, expected) in cases {
		assert_eq!(view.preview(), expected, "preview of ({:?}, {:?})", view.utterance, view.partial);
	}
}

#[test]
fn a_preview_never_pads_a_half_the_recogniser_left_empty() {
	// A trimmed submit phrase empties the words while a partial is still in
	// flight, and the reverse happens on every commit. Neither may grow a
	// leading or trailing space, which the composer would write into the draft.
	for view in [heard("", "spoken"), heard("spoken", "")] {
		let preview = view.preview();
		assert_eq!(preview.trim(), preview, "{view:?} previewed with padding");
	}
}

#[test]
fn every_state_states_itself_on_the_wire_and_in_the_control() {
	let mut seen_wire = Vec::new();
	let mut seen_labels = Vec::new();
	for state in DictationState::iter() {
		let wire = state.as_str();
		let encoded = serde_json::to_string(&state).expect("a state encodes");
		assert_eq!(
			encoded,
			format!("\"{wire}\""),
			"{state:?}: the wire string and what serde encodes disagree, so the window reads a state \
			 the host never sent"
		);
		let decoded: DictationState = serde_json::from_str(&encoded).expect("a state decodes");
		assert_eq!(decoded, state, "{state:?} did not survive a round trip");
		assert!(!state.label().is_empty(), "{state:?} draws the control with nothing");
		seen_wire.push(wire);
		seen_labels.push(state.label());
	}
	seen_wire.sort_unstable();
	let mut unique = seen_wire.clone();
	unique.dedup();
	assert_eq!(seen_wire, unique, "two states share a wire string");
	seen_labels.sort_unstable();
	let mut unique_labels = seen_labels.clone();
	unique_labels.dedup();
	assert_eq!(seen_labels, unique_labels, "two states draw the same control");
}

#[test]
fn only_a_live_microphone_or_a_running_recogniser_is_active() {
	assert!(!DictationState::Idle.is_active());
	assert!(DictationState::Recording.is_active());
	assert!(DictationState::Transcribing.is_active());
	// The default is what a window holds before it has ever dictated, so it
	// must not draw a control that says a microphone is open.
	assert!(!DictationState::default().is_active());
}

#[test]
fn the_chip_states_the_dictation_and_the_words_heard_so_far() {
	let view = DictationView {
		state: DictationState::Recording,
		..heard("ship the desktop", " parity work")
	};
	assert_eq!(view.chip_text(), "Recording: ship the desktop parity work");
}

#[test]
fn a_chip_with_nothing_heard_yet_states_the_dictation_rather_than_a_bare_colon() {
	let view = DictationView { state: DictationState::Recording, ..DictationView::default() };
	assert_eq!(view.chip_text(), "Recording");
}

#[test]
fn every_state_draws_a_chip_that_leads_with_the_state_and_pads_nothing() {
	for state in DictationState::iter() {
		for view in [DictationView { state, ..heard("said", " aloud") }, DictationView {
			state,
			..DictationView::default()
		}] {
			let chip = view.chip_text();
			assert!(!chip.is_empty(), "{state:?}: the chip drew nothing");
			assert_eq!(chip.trim(), chip, "{state:?}: the chip drew padding");
			assert!(
				chip.starts_with(state.label()),
				"{state:?}: the chip dropped the state word, so the control reads as words with no \
				 dictation behind them"
			);
		}
	}
}

#[test]
fn a_dictation_section_redraws_the_composer_of_the_session_in_hand() {
	let session = SessionId::from("session_0001");
	let mut store = Store::new();
	store.persisted.shell.active_session = Some(session.clone());

	let view = DictationView { state: DictationState::Recording, ..heard("ship it", "") };
	let damage = reduce(&mut store, HostEvent::Snapshot(SnapshotSection::Dictation(view.clone())));

	assert_eq!(store.domains.dictation, Some(view));
	assert!(
		damage.contains(&Damage::Composer(session)),
		"the composer holding the draft was not redrawn, so the words stay unwritten"
	);
}

#[test]
fn a_dictation_section_with_no_session_open_redraws_the_window() {
	let mut store = Store::new();
	assert!(store.persisted.shell.active_session.is_none());

	let damage =
		reduce(&mut store, HostEvent::Snapshot(SnapshotSection::Dictation(DictationView::default())));

	// There is no composer to name, and the control still has to stop showing
	// a microphone that closed.
	assert!(damage.contains(&Damage::FullWindow), "a window with no session open never redrew");
}

#[test]
fn a_later_revision_replaces_the_one_before_it_rather_than_accumulating() {
	let mut store = Store::new();
	let first = DictationView {
		state: DictationState::Recording,
		revision: 7,
		..heard("ship the desktop", " parity")
	};
	let second =
		DictationView { state: DictationState::Idle, revision: 8, ..heard("ship the desktop", "") };

	reduce(&mut store, HostEvent::Snapshot(SnapshotSection::Dictation(first)));
	reduce(&mut store, HostEvent::Snapshot(SnapshotSection::Dictation(second.clone())));

	// The phrase in flight was committed, so the revision that follows holds no
	// partial. A reducer that merged would still be drawing " parity" after it.
	assert_eq!(store.domains.dictation, Some(second));
}
