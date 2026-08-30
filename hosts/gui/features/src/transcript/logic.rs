//! What the transcript says about itself.
//!
//! Two decisions, both about honesty rather than layout, and both made without
//! a window so they can be pinned by a test: what the line under the last
//! message says, and what an empty conversation says instead of pretending to
//! be one.

use veyyon_gui_core::store::model::{Engine, Message, Role, Store};

/// The line under the last message, where a reply would be.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Tail {
	/// Nothing to add: something is attached and the last word was its own.
	Silent,
	/// One faint line. Nothing is coming, and this says why.
	Note(String),
	/// A turning mark and a line. Something is on its way.
	Working(String),
}

impl Tail {
	/// The words, for a caller that draws them the same either way.
	pub fn what(&self) -> Option<&str> {
		match self {
			Tail::Silent => None,
			Tail::Note(what) | Tail::Working(what) => Some(what),
		}
	}

	/// Whether the mark beside the line turns.
	pub fn turning(&self) -> bool {
		matches!(self, Tail::Working(_))
	}
}

/// What to say under the last message of a conversation.
///
/// The rule in one sentence: say what is true about the engine, and say nothing
/// once the engine has spoken. A window with nothing attached says so under
/// every message rather than once at the top, because that is where a reader
/// looks for the reply that did not arrive.
pub fn tail(store: &Store, messages: &[Message]) -> Tail {
	let waiting = messages
		.last()
		.is_some_and(|message| message.role == Role::Operator);
	let streaming = messages.last().is_some_and(|message| message.streaming);
	match &store.engine {
		// The only state the window is ever in today. Said plainly: a reader who
		// takes silence for a failure is a reader the window misled.
		Engine::Detached => Tail::Note("No engine attached, so nothing answers yet.".to_owned()),
		Engine::Connecting => Tail::Working("Connecting".to_owned()),
		// While it writes, the message itself carries the mark, so a second one
		// under it would be two claims about one thing.
		Engine::Attached { .. } if streaming => Tail::Silent,
		Engine::Attached { what, .. } if waiting => Tail::Working(format!("{what} is working")),
		Engine::Attached { .. } => Tail::Silent,
	}
}

/// What an empty conversation says: a headline, and the line under it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Opening {
	pub what: String,
	pub note: String,
}

/// What to put in a conversation with no messages in it.
///
/// One sentence about what this window is, and one about what happens to what
/// is written in it. Both change with the engine, because a reader deciding
/// whether to type needs the answer before typing rather than after.
///
/// A note is drawn centred in a measure of 320 points, which is 56 characters
/// at the body size, and a note that runs past it breaks with one word alone on
/// the second line.
pub fn opening(store: &Store) -> Opening {
	match &store.engine {
		Engine::Detached => Opening {
			what: "Nothing is attached".to_owned(),
			note: "What you write stays here until an engine is attached.".to_owned(),
		},
		Engine::Connecting => Opening {
			what: "Connecting".to_owned(),
			note: "Write while it connects; the draft is kept.".to_owned(),
		},
		Engine::Attached { what, model } => {
			Opening { what: format!("Ask {what} something"), note: format!("Running {model}.") }
		},
	}
}
