//! WHY THIS SUITE EXISTS.
//!
//! The transcript is the one surface that can lie. Everything else in the
//! window says what it is; this one says what an engine did, and the defect
//! class it closes is a window that reads as though something answered when
//! nothing did, or reads as detached while a reply is on its way.
//!
//! Both halves of that are decided here rather than while drawing, and both are
//! swept over every [`Engine`] state so a new state cannot be added and left
//! saying whatever the last arm happened to say.
//!
//! WHAT IT DOES NOT CATCH. Where the line is drawn, and whether the mark beside
//! it is visible at eleven pixels.

use veyyon_gui_core::store::model::{
	Appearance, Block, Engine, Message, Role, Store, ToolCall, ToolKind, ToolState,
};

use super::logic::{Tail, opening, tail};

fn store() -> Store {
	Store::opened_in("veyyon", "/repo/veyyon")
}

fn written(id: u64, text: &str) -> Message {
	Message::written(id, 0, text)
}

fn answered(id: u64, streaming: bool) -> Message {
	Message {
		id,
		role: Role::Engine,
		blocks: vec![Block::Tool(ToolCall {
			id:     "t1".to_owned(),
			kind:   ToolKind::Ran,
			what:   "cargo test".to_owned(),
			detail: String::new(),
			state:  ToolState::Done,
		})],
		at_ms: 0,
		streaming,
	}
}

/// Every engine state, so an added one turns this red until it is decided.
fn states() -> Vec<Engine> {
	vec![Engine::Detached, Engine::Connecting, Engine::Attached {
		what:  "veyyon".to_owned(),
		model: "a-model".to_owned(),
	}]
}

#[test]
fn a_detached_window_says_so_under_the_last_message() {
	// The defect: silence that a reader takes for a failure, or worse, for an
	// answer that has not rendered.
	let store = store();
	let tail = tail(&store, &[written(1, "hello")]);
	assert_eq!(tail, Tail::Note("No engine attached, so nothing answers yet.".to_owned()));
	assert!(!tail.turning(), "nothing is running, so nothing turns");
}

#[test]
fn a_detached_window_says_it_whether_or_not_anything_was_written() {
	let store = store();
	assert_eq!(tail(&store, &[]), tail(&store, &[written(1, "hello")]));
}

#[test]
fn connecting_turns_and_attached_and_answered_says_nothing() {
	let mut store = store();

	store.engine = Engine::Connecting;
	let connecting = tail(&store, &[written(1, "hello")]);
	assert!(connecting.turning(), "a connection in progress is something running");
	assert_eq!(connecting.what(), Some("Connecting"));

	store.engine = Engine::Attached { what: "veyyon".to_owned(), model: "a-model".to_owned() };
	// The last word was the engine's: there is nothing to wait for and nothing
	// to say, and a line here would be a status bar with no status.
	assert_eq!(tail(&store, &[written(1, "hello"), answered(2, false)]), Tail::Silent);
}

#[test]
fn an_attached_engine_that_owes_a_reply_says_it_is_working() {
	let mut store = store();
	store.engine = Engine::Attached { what: "veyyon".to_owned(), model: "a-model".to_owned() };
	let tail = tail(&store, &[written(1, "hello")]);
	assert_eq!(tail, Tail::Working("veyyon is working".to_owned()));
	assert!(tail.turning());
}

#[test]
fn a_message_still_being_written_carries_the_only_mark() {
	// Two turning marks for one reply is two claims about one thing: the message
	// has its own, so the tail stands down.
	let mut store = store();
	store.engine = Engine::Attached { what: "veyyon".to_owned(), model: "a-model".to_owned() };
	assert_eq!(tail(&store, &[written(1, "hello"), answered(2, true)]), Tail::Silent);
}

#[test]
fn every_engine_state_decides_both_the_tail_and_the_opening() {
	// The sweep. A new state that falls through to a stale arm shows up as an
	// empty phrase or as a claim that something is attached when it is not.
	for state in states() {
		let mut store = store();
		let attached = state.is_attached();
		store.engine = state.clone();

		let opening = opening(&store);
		assert!(!opening.what.trim().is_empty(), "{state:?}: an empty headline");
		assert!(!opening.note.trim().is_empty(), "{state:?}: an empty note");
		// The note is drawn centred in a measure of 320 points, which is 56
		// characters at the body size. A note past that breaks with one word
		// alone on the second line, under a headline that is one line: the
		// bound is the measure, not a paragraph.
		assert!(
			opening.what.len() < 60 && opening.note.chars().count() <= 56,
			"{state:?}: the opening does not fit the measure it is drawn in: {:?}",
			opening.note
		);

		let waiting = tail(&store, &[written(1, "hello")]);
		match waiting {
			Tail::Silent => panic!("{state:?}: an unanswered message and nothing said"),
			Tail::Note(what) => {
				assert!(!attached, "{state:?}: something is attached, so a flat note is wrong");
				assert!(what.contains("No engine"), "{state:?}: {what:?} does not say what is wrong");
			},
			Tail::Working(what) => {
				assert!(!what.trim().is_empty(), "{state:?}: a turning mark with no words");
			},
		}
	}
}

#[test]
fn nothing_here_claims_an_answer_that_was_not_produced() {
	// The honesty rule, as an assertion: with nothing attached, no phrase this
	// surface produces mentions a reply in the past tense, and none of them is
	// the engine's own words.
	let store = store();
	let opening = opening(&store);
	for phrase in [opening.what.as_str(), opening.note.as_str()] {
		let lower = phrase.to_lowercase();
		for claim in ["replied", "answered", "said", "responded"] {
			assert!(!lower.contains(claim), "{phrase:?} claims {claim}");
		}
	}
}

#[test]
fn the_opening_names_what_is_attached_when_something_is() {
	let mut store = store();
	store.engine = Engine::Attached { what: "veyyon".to_owned(), model: "opus-4".to_owned() };
	let opening = opening(&store);
	assert!(opening.what.contains("veyyon"), "{:?} does not name it", opening.what);
	assert!(opening.note.contains("opus-4"), "{:?} does not name the model", opening.note);
}

#[test]
fn appearance_is_no_part_of_what_the_transcript_says() {
	// Guards against a phrase built from the theme, which is how a line ends up
	// saying "dark" to somebody in light.
	let mut store = store();
	let dark = (tail(&store, &[written(1, "x")]), opening(&store));
	store.settings.appearance = Appearance::Light;
	assert_eq!(dark, (tail(&store, &[written(1, "x")]), opening(&store)));
}
