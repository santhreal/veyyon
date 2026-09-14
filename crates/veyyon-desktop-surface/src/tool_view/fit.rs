//! The width roles §6.7 authors for the text in a row.
//!
//! A tool view is drawn from host text of any length: a bash invocation is
//! prefixed with its environment, a diff path is absolute, a badge label is
//! whatever the tool called itself. §6.7 states the outcome — a row wider than
//! its line truncates its primary text with an ellipsis and keeps the detail
//! beside it, and the detail takes at most half the line — and these roles are
//! that rule, in one place, so a renderer selects a role instead of restating
//! the modifiers that implement it.
//!
//! A text child that takes no role keeps flex's default, which is to measure
//! its own intrinsic width and paint it whether or not the row can hold it. A
//! span in a line that wraps is the one child with no role: what holds it is
//! `max_w_full`, bounding it to the line so it has somewhere to break to, and
//! naming one modifier a role would say less than the modifier does.

use veyyon_gpui::{Styled, relative};

/// A detail is allowed half the line, so a long one cannot starve the text it
/// belongs to (§6.7).
const DETAIL_SHARE: f32 = 0.5;

/// A chip is chrome, not the row's subject, so host text inside one is allowed
/// a quarter of the line.
const CHROME_SHARE: f32 = 0.25;

/// The width roles a row's children take.
pub trait FitsTheRow: Styled + Sized {
	/// Clips to the box flex gives this child, on one line, marked with an
	/// ellipsis. Every role below is this plus a rule for what width to ask
	/// for.
	///
	/// No `min_w_0` here: `overflow_hidden` already sets this child's automatic
	/// minimum size to zero, and the text system truncates against the space
	/// the parent hands down rather than the width this child resolved to.
	#[must_use]
	fn clipped_to_one_line(self) -> Self {
		self.overflow_hidden().whitespace_nowrap().truncate()
	}

	/// The row's subject. Takes the room that is left and yields the rest,
	/// which is what makes an over-long command end in an ellipsis at the
	/// card's edge instead of being drawn through it.
	#[must_use]
	fn fit_primary(self) -> Self {
		self.flex_1().clipped_to_one_line()
	}

	/// Set beside the primary text and states where the row came from: a
	/// `path:line`, a description, a count. Keeps the width it measures, up to
	/// half the line.
	#[must_use]
	fn fit_detail(self) -> Self {
		self
			.flex_shrink_0()
			.max_w(relative(DETAIL_SHARE))
			.clipped_to_one_line()
	}

	/// A chip, tag, language marker or emblem drawn from host text. Holds its
	/// measured width up to a quarter of the line, so an absurd label is
	/// bounded rather than pushing the row's subject out of it.
	#[must_use]
	fn fit_chrome(self) -> Self {
		self
			.flex_shrink_0()
			.max_w(relative(CHROME_SHARE))
			.clipped_to_one_line()
	}
}

impl<T: Styled + Sized> FitsTheRow for T {}
