//! Columns of cards.
//!
//! The todo board and the agent dashboard are this shape: a fixed set of
//! columns naming a state, and cards that move between them.

use crate::view::{Badge, Tone};

/// A titled set of columns.
#[derive(Debug, Clone, PartialEq)]
pub struct Board {
	pub title:   String,
	pub columns: Vec<BoardColumn>,
	pub footer:  Option<String>,
}

impl Board {
	pub fn new(title: impl Into<String>, columns: Vec<BoardColumn>) -> Board {
		Board { title: title.into(), columns, footer: None }
	}

	/// Cards across every column. What a summary line counts.
	pub fn card_count(&self) -> usize {
		self.columns.iter().map(|column| column.cards.len()).sum()
	}
}

/// One column, which is a state rather than a category: a card is in exactly
/// one, and moving it is what progress looks like.
#[derive(Debug, Clone, PartialEq)]
pub struct BoardColumn {
	pub name:  String,
	pub cards: Vec<BoardCard>,
	/// The tone the column's heading reads in, so "failed" is not the same
	/// colour as "done".
	pub tone:  Option<Tone>,
}

impl BoardColumn {
	pub fn new(name: impl Into<String>, cards: Vec<BoardCard>) -> BoardColumn {
		BoardColumn { name: name.into(), cards, tone: None }
	}

	pub fn tone(mut self, tone: Tone) -> BoardColumn {
		self.tone = Some(tone);
		self
	}
}

/// One card.
#[derive(Debug, Clone, PartialEq)]
pub struct BoardCard {
	pub title:    String,
	/// Lines under the title, in reading order.
	pub lines:    Vec<String>,
	pub badges:   Vec<Badge>,
	/// Completion in 0..=1, when the card is something that runs. Clamped by
	/// the renderer, because a session that reports 1.4 must not draw past the
	/// end of its track.
	pub progress: Option<f32>,
	pub tone:     Option<Tone>,
}

impl BoardCard {
	pub fn new(title: impl Into<String>) -> BoardCard {
		BoardCard {
			title:    title.into(),
			lines:    Vec::new(),
			badges:   Vec::new(),
			progress: None,
			tone:     None,
		}
	}

	pub fn line(mut self, line: impl Into<String>) -> BoardCard {
		self.lines.push(line.into());
		self
	}

	pub fn badge(mut self, badge: Badge) -> BoardCard {
		self.badges.push(badge);
		self
	}

	pub fn progress(mut self, progress: f32) -> BoardCard {
		self.progress = Some(progress);
		self
	}

	pub fn tone(mut self, tone: Tone) -> BoardCard {
		self.tone = Some(tone);
		self
	}
}
