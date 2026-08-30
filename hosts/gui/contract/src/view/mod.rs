//! What a tool result looks like, as data.
//!
//! A tool reports what it did; it never decides how that reads. The kinds here
//! are the whole vocabulary a tool has for saying so, and a host draws each one
//! its own way: `hosts/terminal/` into cells, `hosts/gui/views/` into a window.
//! Two hosts drawing the same kinds is what makes this a contract rather than
//! one front end's internal shape.
//!
//! # Where the kinds come from
//!
//! `packages/tool-render/src/parts.tsx` is the existing set, used by every one
//! of the ~30 tool renderers: badges, a path, a key-value grid, capped output,
//! a code block, a note, a row, an invalid argument, a diff, an image list and
//! a link to a sub-agent. [`View`] is those, plus the table, progress, markdown
//! and question kinds named in the host-decoupling plan.
//!
//! # The honest gap
//!
//! The TypeScript side is React components, not a data model, so the drift test
//! that guards [`crate::session`] against `packages/wire` has nothing to
//! enumerate here yet. [`ViewKind::ALL`] is checked against the fixtures, which
//! catches a kind nobody draws, and catches nothing about the TypeScript.

pub mod agent;
pub mod diff;
pub mod fields;
pub mod files;
pub mod output;
pub mod progress;
pub mod prose;
pub mod question;
pub mod table;

pub use agent::Agent;
pub use diff::{Diff, DiffFile, DiffHunk, DiffLine, DiffLineKind};
pub use fields::{Fields, Pair};
pub use files::{Files, Image, PathEntry};
pub use output::{Code, Invalid, Output, OutputVariant};
pub use progress::Progress;
pub use prose::{Markdown, Note};
pub use question::{Choice, Question};
pub use table::{Table, TableRow};

/// One part of what a tool has to say.
///
/// A result is a sequence of these. Sequencing rather than one big struct is
/// what lets a renderer stream: a part is drawn when it arrives, and a tool
/// that has produced its summary but not its output has one part, not a struct
/// with holes in it.
#[derive(Debug, Clone, PartialEq)]
pub enum View {
	/// Named values, read down: `path`, `lines`, `bytes`.
	Fields(Fields),
	/// Captured text, capped at a line count.
	Output(Output),
	/// Source, with the language it is highlighted as.
	Code(Code),
	/// Prose the model wrote, as markdown.
	Markdown(Markdown),
	/// A short remark with a verdict attached.
	Note(Note),
	/// Columns and rows.
	Table(Table),
	/// Paths, with what happened to each.
	Files(Files),
	/// A raster, with the dimensions it was decoded at.
	Image(Image),
	/// Changed lines, per file and per hunk.
	Diff(Diff),
	/// How far through a long operation is.
	Progress(Progress),
	/// A question the operator answers before the tool continues.
	Question(Question),
	/// A link into a sub-agent's own transcript.
	Agent(Agent),
	/// An argument that did not parse, and what was expected instead.
	Invalid(Invalid),
}

impl View {
	/// Which kind this is, without its payload.
	pub fn kind(&self) -> ViewKind {
		match self {
			View::Fields(_) => ViewKind::Fields,
			View::Output(_) => ViewKind::Output,
			View::Code(_) => ViewKind::Code,
			View::Markdown(_) => ViewKind::Markdown,
			View::Note(_) => ViewKind::Note,
			View::Table(_) => ViewKind::Table,
			View::Files(_) => ViewKind::Files,
			View::Image(_) => ViewKind::Image,
			View::Diff(_) => ViewKind::Diff,
			View::Progress(_) => ViewKind::Progress,
			View::Question(_) => ViewKind::Question,
			View::Agent(_) => ViewKind::Agent,
			View::Invalid(_) => ViewKind::Invalid,
		}
	}
}

/// The name of a [`View`] kind, with no payload attached.
///
/// [`ViewKind::ALL`] is what a sweep enumerates. A kind added to [`View`]
/// without a line here does not compile, because [`View::kind`] is exhaustive,
/// and a kind added here without a fixture turns the fixture test red.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ViewKind {
	Fields,
	Output,
	Code,
	Markdown,
	Note,
	Table,
	Files,
	Image,
	Diff,
	Progress,
	Question,
	Agent,
	Invalid,
}

impl ViewKind {
	/// Every kind, in the order [`View`] declares them.
	pub const ALL: [ViewKind; 13] = [
		ViewKind::Fields,
		ViewKind::Output,
		ViewKind::Code,
		ViewKind::Markdown,
		ViewKind::Note,
		ViewKind::Table,
		ViewKind::Files,
		ViewKind::Image,
		ViewKind::Diff,
		ViewKind::Progress,
		ViewKind::Question,
		ViewKind::Agent,
		ViewKind::Invalid,
	];
}

/// What a value means, without saying what colour it is.
///
/// These are the four names `parts.tsx` uses, so a tone set on this side is the
/// tone the terminal host already draws. A value with no verdict has no tone:
/// the field is [`Option<Tone>`] and [`None`] is the reading colour, which is
/// why there is no `Neutral` member to pick by accident.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Tone {
	/// The theme's accent: a name, a selection, a link.
	Accent,
	/// It worked.
	Ok,
	/// It worked, and something about it needs reading.
	Warn,
	/// It failed.
	Err,
}

/// A short label beside a row, a card or a header.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Badge {
	pub text: String,
	/// The verdict the badge carries, or [`None`] for a label that carries none.
	pub tone: Option<Tone>,
}

impl Badge {
	pub fn new(text: impl Into<String>, tone: Tone) -> Badge {
		Badge { text: text.into(), tone: Some(tone) }
	}

	/// A badge in the reading colour, for a label that states a fact rather
	/// than a verdict: a mode, a model name, a count.
	pub fn plain(text: impl Into<String>) -> Badge {
		Badge { text: text.into(), tone: None }
	}
}

#[cfg(test)]
mod tests {
	//! WHY THIS SUITE EXISTS.
	//!
	//! [`ViewKind::ALL`] is the list a sweep walks: the fixtures, and every
	//! renderer test that claims to cover the vocabulary. A kind left out of it
	//! makes all of those pass while drawing nothing, and the omission is
	//! invisible — the array still compiles, the sweep still runs, and the
	//! missing kind reaches a window as a blank.
	//!
	//! WHAT IT DOES NOT CATCH. Whether a payload is right, and anything at all
	//! about the TypeScript side, which has no data model to compare against.

	use super::*;

	#[test]
	fn every_kind_is_listed_once_in_all() {
		let mut seen = ViewKind::ALL.to_vec();
		let count = seen.len();
		seen.sort_by_key(|kind| format!("{kind:?}"));
		seen.dedup();
		assert_eq!(seen.len(), count, "ViewKind::ALL repeats a kind");
	}

	#[test]
	fn a_plain_badge_carries_no_verdict() {
		assert_eq!(Badge::plain("read").tone, None);
		assert_eq!(Badge::new("failed", Tone::Err).tone, Some(Tone::Err));
	}
}
