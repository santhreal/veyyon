//! A question the operator answers before the tool continues.

use super::Badge;

/// A question with the choices that answer it.
///
/// A question inside a tool result is what a tool has instead of blocking on
/// stdin. It carries the answer once one is given, so a transcript redrawn from
/// history shows what was chosen rather than an open question nobody can answer
/// twice.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Question {
	pub prompt:   String,
	pub choices:  Vec<Choice>,
	/// The index of the choice that was taken, or [`None`] while it is open.
	pub answered: Option<usize>,
	/// Whether more than one choice can be taken.
	pub multiple: bool,
}

impl Question {
	pub fn new(prompt: impl Into<String>, choices: Vec<Choice>) -> Question {
		Question { prompt: prompt.into(), choices, answered: None, multiple: false }
	}

	pub fn multiple(mut self) -> Question {
		self.multiple = true;
		self
	}

	pub fn answered(mut self, index: usize) -> Question {
		self.answered = Some(index);
		self
	}

	/// Whether the question still wants an answer.
	pub fn is_open(&self) -> bool {
		self.answered.is_none() && !self.choices.is_empty()
	}

	/// The choice that was taken.
	///
	/// Read through here rather than by indexing: the index arrives from
	/// outside, and a session that dropped a choice between the answer and the
	/// redraw would panic a window that indexed it directly.
	pub fn answer(&self) -> Option<&Choice> {
		self.choices.get(self.answered?)
	}
}

/// One choice.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Choice {
	pub label:       String,
	/// The line under the label: what taking this choice means.
	pub detail:      Option<String>,
	pub badges:      Vec<Badge>,
	/// The choice a host offers first.
	pub recommended: bool,
}

impl Choice {
	pub fn new(label: impl Into<String>) -> Choice {
		Choice {
			label:       label.into(),
			detail:      None,
			badges:      Vec::new(),
			recommended: false,
		}
	}

	pub fn detail(mut self, detail: impl Into<String>) -> Choice {
		self.detail = Some(detail.into());
		self
	}

	pub fn recommended(mut self) -> Choice {
		self.recommended = true;
		self
	}

	pub fn badge(mut self, badge: Badge) -> Choice {
		self.badges.push(badge);
		self
	}
}

#[cfg(test)]
mod tests {
	//! WHY THIS SUITE EXISTS.
	//!
	//! An answered index arrives from a session and is used to draw. Indexing
	//! it directly panics the window when the choice list changed underneath —
	//! a redraw from history against a shorter list, or a producer that revised
	//! its choices. [`Question::answer`] is the accessor that has to absorb
	//! that, and [`Question::is_open`] decides whether a host draws an
	//! answerable control at all.
	//!
	//! WHAT IT DOES NOT CATCH. Multiple selection, which has one index here and
	//! needs a set before a host can offer it.

	use super::*;

	#[test]
	fn an_unanswered_question_is_open() {
		let question = Question::new("Overwrite?", vec![Choice::new("Yes"), Choice::new("No")]);
		assert!(question.is_open());
		assert_eq!(question.answer(), None);
	}

	#[test]
	fn an_answered_question_reports_the_choice_taken() {
		let question =
			Question::new("Overwrite?", vec![Choice::new("Yes"), Choice::new("No")]).answered(1);
		assert!(!question.is_open());
		assert_eq!(question.answer().map(|choice| choice.label.as_str()), Some("No"));
	}

	#[test]
	fn an_answer_past_the_end_reads_as_no_answer_rather_than_panicking() {
		let question = Question::new("Overwrite?", vec![Choice::new("Yes")]).answered(4);
		assert_eq!(question.answer(), None);
		assert!(!question.is_open());
	}

	#[test]
	fn a_question_with_no_choices_is_not_open() {
		assert!(!Question::new("Overwrite?", Vec::new()).is_open());
	}
}
