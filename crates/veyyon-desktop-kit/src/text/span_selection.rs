//! What a pointer dragged over drawn text comes to (§8.25).
//!
//! WHY: a transcript could be read and nothing in it could be taken out by
//! hand. The whole of a turn could be copied from its menu, which is the
//! answer for a turn and no answer at all for one sentence of it, one path out
//! of a refusal, or one line of a command's output.
//!
//! A selection is two points in one document, and a point is a byte offset in
//! one drawn span. A span is one piece of text the frame draws through one
//! layout: a paragraph, a heading, a bullet's body, a quote, one line of a
//! code pane. Its id orders it against every other span of the document, so
//! the selection between two points covers the whole of every span between
//! them without either end naming the spans in the middle.
//!
//! The offsets are into the text the frame DREW, not the source it came from:
//! a marker the renderer took off the line is no byte a reader can select,
//! because there is nothing on the frame to drag over.

use std::{ops::Range, sync::Arc};

use veyyon_gpui::{App, Window};

/// Which drawn span a point is in.
///
/// The order is the document's own: a span drawn before another has the
/// smaller id. A caller that draws a document of its own composes the id out
/// of the positions it nests -- entry, block, then span inside the block --
/// so a comparison of two ids is a comparison of two places on the frame.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Default, Hash)]
pub struct SpanId(pub u64);

impl SpanId {
	/// The id of the `index`th span inside the piece of the document this id
	/// opens, which is how a block of prose numbers the spans it draws.
	#[must_use]
	pub const fn nth(self, index: u16) -> Self {
		Self(self.0 + index as u64)
	}
}

/// One end of a selection: a span, and a byte offset into the text that span
/// drew.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Default)]
pub struct SpanPoint {
	pub span:   SpanId,
	pub offset: usize,
}

impl SpanPoint {
	/// A point `offset` bytes into `span`.
	#[must_use]
	pub const fn new(span: SpanId, offset: usize) -> Self {
		Self { span, offset }
	}
}

/// What the pointer has selected: where the drag started, and where it is now.
///
/// The anchor stays where the press landed while the head follows the pointer,
/// so a drag back over its own start selects backwards without the two ends
/// swapping. Every reader of a selection asks it for a range rather than
/// comparing the two ends itself.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct TextSelection {
	pub anchor: SpanPoint,
	pub head:   SpanPoint,
}

impl TextSelection {
	/// A selection anchored at `anchor` with its head at `head`.
	#[must_use]
	pub const fn new(anchor: SpanPoint, head: SpanPoint) -> Self {
		Self { anchor, head }
	}

	/// A selection of nothing, at `at`, which is what a press with no drag
	/// after it comes to.
	#[must_use]
	pub const fn collapsed(at: SpanPoint) -> Self {
		Self { anchor: at, head: at }
	}

	/// Whether the two ends are the same point, so nothing is selected.
	#[must_use]
	pub fn is_collapsed(&self) -> bool {
		self.anchor == self.head
	}

	/// The end that comes first in the document.
	#[must_use]
	pub fn min(&self) -> SpanPoint {
		self.anchor.min(self.head)
	}

	/// The end that comes last in the document.
	#[must_use]
	pub fn max(&self) -> SpanPoint {
		self.anchor.max(self.head)
	}

	/// The byte range of `span`'s drawn text, which is `len` bytes long, that
	/// this selection covers. `None` when the span is outside the selection or
	/// the selection covers nothing of it.
	///
	/// A span between the two ends is covered whole, which is what makes a
	/// selection across blocks one selection rather than a set of them. An
	/// offset past the end of the text is clamped to it, so a span that drew
	/// less text than it did when the drag started never states a range its
	/// own string cannot be cut at.
	#[must_use]
	pub fn range_in(&self, span: SpanId, len: usize) -> Option<Range<usize>> {
		let (min, max) = (self.min(), self.max());
		if span < min.span || span > max.span {
			return None;
		}
		let start = if span == min.span {
			min.offset.min(len)
		} else {
			0
		};
		let end = if span == max.span {
			max.offset.min(len)
		} else {
			len
		};
		(start < end).then_some(start..end)
	}
}

/// What the pointer did over a span of drawn text.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SpanGesture {
	/// A press landed at `at`. `extend` is a press with Shift held, which
	/// leaves the anchor where it is and moves the head to the press.
	Press { at: SpanPoint, extend: bool },
	/// The pointer moved to `at` with the button still down.
	Extend(SpanPoint),
}

/// What a surface hands a drawn span so the span can be selected: the id it
/// opens its spans at, the selection to draw, and where a gesture goes.
///
/// The handler is shared rather than owned because one document hands the same
/// one to every span it draws.
#[derive(Clone)]
pub struct SelectableProse {
	base:       SpanId,
	selection:  Option<TextSelection>,
	on_gesture: Arc<dyn Fn(SpanGesture, &mut Window, &mut App) + Send + Sync>,
}

impl SelectableProse {
	/// Spans numbered from `base`, drawing `selection`, reporting to
	/// `on_gesture`.
	#[must_use]
	pub fn new(
		base: SpanId,
		selection: Option<TextSelection>,
		on_gesture: impl Fn(SpanGesture, &mut Window, &mut App) + Send + Sync + 'static,
	) -> Self {
		Self { base, selection, on_gesture: Arc::new(on_gesture) }
	}

	/// The id of the `index`th span of this document.
	#[must_use]
	pub const fn span(&self, index: u16) -> SpanId {
		self.base.nth(index)
	}

	/// The byte range of `span`'s `len` bytes of drawn text to draw as
	/// selected.
	#[must_use]
	pub fn range_in(&self, span: SpanId, len: usize) -> Option<Range<usize>> {
		self
			.selection
			.and_then(|selection| selection.range_in(span, len))
	}

	/// Reports what the pointer did over one of this document's spans.
	pub fn report(&self, gesture: SpanGesture, window: &mut Window, cx: &mut App) {
		(self.on_gesture)(gesture, window, cx);
	}
}

impl std::fmt::Debug for SelectableProse {
	fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
		f.debug_struct("SelectableProse")
			.field("base", &self.base)
			.field("selection", &self.selection)
			.finish_non_exhaustive()
	}
}

#[cfg(test)]
mod tests {
	use super::{SpanId, SpanPoint, TextSelection};

	fn point(span: u64, offset: usize) -> SpanPoint {
		SpanPoint::new(SpanId(span), offset)
	}

	#[test]
	fn a_selection_inside_one_span_covers_the_bytes_between_its_ends() {
		let selection = TextSelection::new(point(4, 2), point(4, 7));
		assert_eq!(selection.range_in(SpanId(4), 20), Some(2..7));
		assert_eq!(selection.range_in(SpanId(3), 20), None);
		assert_eq!(selection.range_in(SpanId(5), 20), None);
	}

	#[test]
	fn a_span_between_the_two_ends_is_covered_whole() {
		let selection = TextSelection::new(point(2, 5), point(6, 3));
		assert_eq!(selection.range_in(SpanId(2), 9), Some(5..9));
		assert_eq!(selection.range_in(SpanId(3), 9), Some(0..9));
		assert_eq!(selection.range_in(SpanId(5), 4), Some(0..4));
		assert_eq!(selection.range_in(SpanId(6), 9), Some(0..3));
		assert_eq!(selection.range_in(SpanId(7), 9), None);
	}

	#[test]
	fn a_drag_backwards_covers_the_same_bytes_as_the_drag_forwards() {
		let forwards = TextSelection::new(point(1, 1), point(3, 2));
		let backwards = TextSelection::new(point(3, 2), point(1, 1));
		for span in 0..5 {
			assert_eq!(
				forwards.range_in(SpanId(span), 6),
				backwards.range_in(SpanId(span), 6),
				"span {span}"
			);
		}
	}

	#[test]
	fn a_collapsed_selection_covers_nothing_anywhere() {
		let selection = TextSelection::collapsed(point(3, 4));
		assert!(selection.is_collapsed());
		for span in 0..6 {
			assert_eq!(selection.range_in(SpanId(span), 8), None, "span {span}");
		}
	}

	#[test]
	fn an_offset_past_the_drawn_text_is_clamped_to_it() {
		let selection = TextSelection::new(point(1, 2), point(1, 40));
		assert_eq!(selection.range_in(SpanId(1), 5), Some(2..5));

		let started_past_the_end = TextSelection::new(point(1, 9), point(2, 3));
		assert_eq!(started_past_the_end.range_in(SpanId(1), 4), None);
		assert_eq!(started_past_the_end.range_in(SpanId(2), 4), Some(0..3));
	}

	#[test]
	fn a_span_is_numbered_from_the_document_it_belongs_to() {
		let base = SpanId(7 << 16);
		assert_eq!(base.nth(0), SpanId(458_752));
		assert_eq!(base.nth(3), SpanId(458_755));
		assert!(base.nth(3) > base.nth(2));
	}
}
