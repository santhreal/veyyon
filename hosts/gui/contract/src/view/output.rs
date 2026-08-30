//! Captured text, and the two things that are not prose: source, and an
//! argument that did not parse.

use super::Tone;

/// Text a tool captured, capped at a line count.
///
/// The cap is part of the data rather than the renderer's own limit, because
/// the producer knows what it truncated. A host that decided the cap itself
/// would have to say "10 more lines" without knowing whether there are ten.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Output {
	/// The title above the block, if it has one: `stdout`, `stderr`.
	pub title:     Option<String>,
	pub text:      String,
	/// How many lines to show before collapsing. [`None`] shows all of them.
	pub max_lines: Option<usize>,
	/// Lines the producer dropped, which is what a "N more lines" line reports.
	pub omitted:   usize,
	pub variant:   OutputVariant,
}

impl Output {
	pub fn new(text: impl Into<String>) -> Output {
		Output {
			title:     None,
			text:      text.into(),
			max_lines: None,
			omitted:   0,
			variant:   OutputVariant::Plain,
		}
	}

	/// Output that reports a failure. Drawn on a ground of its own, so a failure
	/// is not read as the command's ordinary output.
	pub fn error(text: impl Into<String>) -> Output {
		Output { variant: OutputVariant::Error, ..Output::new(text) }
	}

	pub fn title(mut self, title: impl Into<String>) -> Output {
		self.title = Some(title.into());
		self
	}

	pub fn max_lines(mut self, max_lines: usize) -> Output {
		self.max_lines = Some(max_lines);
		self
	}

	pub fn omitted(mut self, omitted: usize) -> Output {
		self.omitted = omitted;
		self
	}

	/// The lines a renderer draws, and how many it left out.
	///
	/// The count it returns includes lines the producer already dropped, so the
	/// "more" line is right whether the truncation happened here or upstream.
	pub fn visible(&self) -> (Vec<&str>, usize) {
		let lines: Vec<&str> = self.text.lines().collect();
		match self.max_lines {
			Some(max) if lines.len() > max => {
				let hidden = lines.len() - max;
				(lines[..max].to_vec(), hidden + self.omitted)
			},
			_ => (lines, self.omitted),
		}
	}
}

/// What the ground under an [`Output`] block says about it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum OutputVariant {
	#[default]
	Plain,
	/// A failure: standard error, a non-zero exit, a rejected patch.
	Error,
	/// Set back from the reading colour: context a reader skims past.
	Muted,
}

/// Source, with the language it is highlighted as.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Code {
	pub text:       String,
	/// The language tag, as a highlighter names it. [`None`] draws
	/// unhighlighted.
	pub language:   Option<String>,
	/// The line number the first line has, for a fragment out of a file.
	pub first_line: Option<usize>,
	pub title:      Option<String>,
}

impl Code {
	pub fn new(text: impl Into<String>) -> Code {
		Code { text: text.into(), language: None, first_line: None, title: None }
	}

	pub fn language(mut self, language: impl Into<String>) -> Code {
		self.language = Some(language.into());
		self
	}

	pub fn first_line(mut self, first_line: usize) -> Code {
		self.first_line = Some(first_line);
		self
	}

	pub fn title(mut self, title: impl Into<String>) -> Code {
		self.title = Some(title.into());
		self
	}
}

/// An argument that did not parse.
///
/// This is a view kind rather than an error string because the operator needs
/// both halves: what arrived, and what the tool wanted. A renderer that had
/// only a message would print the model's mistake without the shape it missed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Invalid {
	/// The argument's name, or [`None`] when the whole payload failed to parse.
	pub name:     Option<String>,
	/// What arrived, as text. Never parsed further: it did not parse.
	pub received: String,
	/// What was expected: a type, an enum's members, a range.
	pub expected: Option<String>,
}

impl Invalid {
	pub fn new(received: impl Into<String>) -> Invalid {
		Invalid { name: None, received: received.into(), expected: None }
	}

	pub fn name(mut self, name: impl Into<String>) -> Invalid {
		self.name = Some(name.into());
		self
	}

	pub fn expected(mut self, expected: impl Into<String>) -> Invalid {
		self.expected = Some(expected.into());
		self
	}

	/// An invalid argument always reports a failure.
	pub fn tone(&self) -> Tone {
		Tone::Err
	}
}

#[cfg(test)]
mod tests {
	//! WHY THIS SUITE EXISTS.
	//!
	//! [`Output::visible`] decides both halves of a truncated block: the lines
	//! drawn, and the number in "N more lines". Getting the second wrong is the
	//! failure that survives review, because the block still looks right —
	//! `omitted` counts what the producer already dropped, and a renderer that
	//! only subtracted its own cap would under-report every capped tool.
	//!
	//! WHAT IT DOES NOT CATCH. Wrapping. A line longer than the window counts
	//! as one line here and occupies three on screen.

	use super::*;

	#[test]
	fn an_uncapped_block_shows_every_line() {
		let output = Output::new("one\ntwo\nthree");
		assert_eq!(output.visible(), (vec!["one", "two", "three"], 0));
	}

	#[test]
	fn a_capped_block_reports_its_own_truncation() {
		let output = Output::new("one\ntwo\nthree").max_lines(2);
		assert_eq!(output.visible(), (vec!["one", "two"], 1));
	}

	#[test]
	fn the_more_line_adds_what_the_producer_already_dropped() {
		let output = Output::new("one\ntwo\nthree").max_lines(2).omitted(40);
		assert_eq!(output.visible(), (vec!["one", "two"], 41));
	}

	#[test]
	fn an_uncapped_block_still_reports_upstream_truncation() {
		let output = Output::new("one\ntwo").omitted(7);
		assert_eq!(output.visible(), (vec!["one", "two"], 7));
	}
}
