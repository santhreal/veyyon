//! Platform text input: typed characters and input-method composition.
//!
//! The platform addresses text in UTF-16 code units; the buffer in UTF-8
//! bytes. Every range crossing this boundary is converted here.

use std::ops::Range;

use veyyon_gpui::{
	Bounds, Context, EntityInputHandler, Pixels, Point, UTF16Selection, Window, size,
};

use super::{EditKind, Editor, MASK_GLYPH, motion::floor_char};
use crate::theme::size as measure;

/// The UTF-16 offset of byte `offset`.
fn to_utf16(text: &str, offset: usize) -> usize {
	text[..floor_char(text, offset)].encode_utf16().count()
}

/// The byte offset of UTF-16 offset `offset`, clamped to the text.
fn from_utf16(text: &str, offset: usize) -> usize {
	let mut units = 0;
	for (index, ch) in text.char_indices() {
		if units >= offset {
			return index;
		}
		units += ch.len_utf16();
	}
	text.len()
}

fn range_to_utf16(text: &str, range: &Range<usize>) -> Range<usize> {
	to_utf16(text, range.start)..to_utf16(text, range.end)
}

fn range_from_utf16(text: &str, range: &Range<usize>) -> Range<usize> {
	from_utf16(text, range.start)..from_utf16(text, range.end)
}

impl Editor {
	/// The byte range an input method edit replaces: the one it names, else
	/// the marked text, else the selection.
	fn input_range(&self, range_utf16: Option<Range<usize>>) -> Range<usize> {
		range_utf16
			.map(|range| range_from_utf16(self.buffer.text(), &range))
			.or_else(|| self.marked.clone())
			.unwrap_or_else(|| self.buffer.selection().range())
	}
}

impl EntityInputHandler for Editor {
	/// The text in `range_utf16`; while masked, one [`MASK_GLYPH`] per UTF-16
	/// unit, so the input method reads no secret and its offsets still hold.
	fn text_for_range(
		&mut self,
		range_utf16: Range<usize>,
		adjusted_range: &mut Option<Range<usize>>,
		_window: &mut Window,
		_cx: &mut Context<Self>,
	) -> Option<String> {
		let text = self.buffer.text();
		let range = range_from_utf16(text, &range_utf16);
		let adjusted = range_to_utf16(text, &range);
		let masked = std::iter::repeat_n(MASK_GLYPH, adjusted.len());
		let result = if self.masked {
			masked.collect()
		} else {
			text[range].to_owned()
		};
		adjusted_range.replace(adjusted);
		Some(result)
	}

	fn selected_text_range(
		&mut self,
		_ignore_disabled_input: bool,
		_window: &mut Window,
		_cx: &mut Context<Self>,
	) -> Option<UTF16Selection> {
		let selection = self.buffer.selection();
		Some(UTF16Selection {
			range:    range_to_utf16(self.buffer.text(), &selection.range()),
			reversed: selection.is_reversed(),
		})
	}

	fn marked_text_range(
		&self,
		_window: &mut Window,
		_cx: &mut Context<Self>,
	) -> Option<Range<usize>> {
		self
			.marked
			.as_ref()
			.map(|range| range_to_utf16(self.buffer.text(), range))
	}

	fn unmark_text(&mut self, _window: &mut Window, cx: &mut Context<Self>) {
		self.marked = None;
		cx.notify();
	}

	/// Commits `text`. With marked text and no named range, the text replaces
	/// the composition and joins its undo step.
	fn replace_text_in_range(
		&mut self,
		range_utf16: Option<Range<usize>>,
		text: &str,
		_window: &mut Window,
		cx: &mut Context<Self>,
	) {
		let kind = if self.marked.is_some() {
			EditKind::Composition
		} else {
			EditKind::Typing
		};
		let range = self.input_range(range_utf16);
		self.replace_with(range, text, kind, cx);
	}

	/// Replaces the composition with `new_text` and marks it. The selection
	/// the input method names is relative to `new_text`.
	fn replace_and_mark_text_in_range(
		&mut self,
		range_utf16: Option<Range<usize>>,
		new_text: &str,
		new_selected_range_utf16: Option<Range<usize>>,
		_window: &mut Window,
		cx: &mut Context<Self>,
	) {
		let range = self.input_range(range_utf16);
		let inserted = self.buffer.edit(range, new_text, EditKind::Composition);
		if let Some(selected) = new_selected_range_utf16 {
			let selected = range_from_utf16(new_text, &selected);
			self
				.buffer
				.select_within_edit(inserted.start + selected.start, inserted.start + selected.end);
		}
		self.marked = (!inserted.is_empty()).then_some(inserted);
		self.changed(cx);
	}

	/// The box of `range_utf16` in window coordinates, for placing the
	/// candidate window. A collapsed range is the caret.
	fn bounds_for_range(
		&mut self,
		range_utf16: Range<usize>,
		element_bounds: Bounds<Pixels>,
		_window: &mut Window,
		_cx: &mut Context<Self>,
	) -> Option<Bounds<Pixels>> {
		let layout = self.layout.as_ref()?;
		let range = range_from_utf16(self.buffer.text(), &range_utf16);
		let (start, end) = if layout.placeholder {
			(Point::default(), Point::default())
		} else {
			(layout.position(range.start), layout.position(range.end))
		};
		let width = if end.y == start.y && end.x > start.x {
			end.x - start.x
		} else {
			measure::CARET
		};
		let origin = element_bounds.origin - self.scroll + start;
		Some(Bounds::new(origin, size(width, layout.line_height)))
	}

	fn character_index_for_point(
		&mut self,
		point: Point<Pixels>,
		_window: &mut Window,
		_cx: &mut Context<Self>,
	) -> Option<usize> {
		let offset = self.offset_at(point)?;
		Some(to_utf16(self.buffer.text(), offset))
	}
}
