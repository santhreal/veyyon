//! Prose: markdown the model wrote, and a short remark with a verdict.

use super::Tone;

/// Markdown, unparsed.
///
/// Parsing belongs to the host, because the result is host-shaped: the terminal
/// wants spans and the window wants elements. Carrying a parsed tree would make
/// this contract carry one host's idea of a heading.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Markdown {
	pub source: String,
}

impl Markdown {
	pub fn new(source: impl Into<String>) -> Markdown {
		Markdown { source: source.into() }
	}
}

/// A short remark with a verdict attached.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Note {
	pub text: String,
	pub tone: Option<Tone>,
}

impl Note {
	pub fn new(text: impl Into<String>, tone: Tone) -> Note {
		Note { text: text.into(), tone: Some(tone) }
	}

	/// A remark that states a fact rather than a verdict.
	pub fn plain(text: impl Into<String>) -> Note {
		Note { text: text.into(), tone: None }
	}
}
