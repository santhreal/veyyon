//! `EntityInputHandler` implementation and UTF-16 coordinate conversions for
//! Editor (§8.25).

use std::ops::Range;

use veyyon_gpui::{Bounds, Context, EntityInputHandler, Pixels, Point, UTF16Selection, Window};

use super::{Editor, EditorEvent};
use crate::input::buffer::{Selection, grapheme::snap_to_grapheme};

pub(crate) fn offset_to_utf16(text: &str, byte_offset: usize) -> usize {
	let clamped = snap_to_grapheme(text, byte_offset);
	let mut count = 0;
	for (idx, ch) in text.char_indices() {
		if idx >= clamped {
			break;
		}
		count += ch.len_utf16();
	}
	count
}

pub(crate) fn offset_from_utf16(text: &str, utf16_offset: usize) -> usize {
	let mut count = 0;
	for (idx, ch) in text.char_indices() {
		if count >= utf16_offset {
			return idx;
		}
		count += ch.len_utf16();
	}
	text.len()
}

pub(crate) fn range_to_utf16(text: &str, range: Range<usize>) -> Range<usize> {
	offset_to_utf16(text, range.start)..offset_to_utf16(text, range.end)
}

pub(crate) fn range_from_utf16(text: &str, range_utf16: Range<usize>) -> Range<usize> {
	offset_from_utf16(text, range_utf16.start)..offset_from_utf16(text, range_utf16.end)
}

impl EntityInputHandler for Editor {
	fn text_for_range(
		&mut self,
		range_utf16: Range<usize>,
		actual_range: &mut Option<Range<usize>>,
		_window: &mut Window,
		_cx: &mut Context<Self>,
	) -> Option<String> {
		let text = self.buffer.text();
		let range = range_from_utf16(text, range_utf16);
		actual_range.replace(range_to_utf16(text, range.clone()));
		Some(text[range].to_string())
	}

	fn selected_text_range(
		&mut self,
		_ignore_disabled_input: bool,
		_window: &mut Window,
		_cx: &mut Context<Self>,
	) -> Option<UTF16Selection> {
		let text = self.buffer.text();
		let sel = self.buffer.selection();
		let start_u16 = offset_to_utf16(text, sel.min());
		let end_u16 = offset_to_utf16(text, sel.max());
		Some(UTF16Selection { range: start_u16..end_u16, reversed: sel.is_reversed() })
	}

	fn marked_text_range(
		&self,
		_window: &mut Window,
		_cx: &mut Context<Self>,
	) -> Option<Range<usize>> {
		let text = self.buffer.text();
		self
			.marked_range
			.as_ref()
			.map(|r| range_to_utf16(text, r.clone()))
	}

	fn unmark_text(&mut self, _window: &mut Window, cx: &mut Context<Self>) {
		self.marked_range = None;
		cx.notify();
	}

	fn replace_text_in_range(
		&mut self,
		range_utf16: Option<Range<usize>>,
		new_text: &str,
		_window: &mut Window,
		cx: &mut Context<Self>,
	) {
		let text = self.buffer.text();
		let range = range_utf16
			.map(|r| range_from_utf16(text, r))
			.unwrap_or_else(|| self.buffer.selection().range());

		self.buffer.replace_range(range, new_text);
		self.marked_range = None;
		self.goal_column = None;
		self.reset_blink(cx);
		cx.emit(EditorEvent::Changed);
		cx.notify();
	}

	fn replace_and_mark_text_in_range(
		&mut self,
		range_utf16: Option<Range<usize>>,
		new_text: &str,
		new_selected_range_utf16: Option<Range<usize>>,
		_window: &mut Window,
		cx: &mut Context<Self>,
	) {
		let text = self.buffer.text();
		let range = range_utf16
			.map(|r| range_from_utf16(text, r))
			.unwrap_or_else(|| self.buffer.selection().range());

		let start = range.start;
		self.buffer.replace_range(range, new_text);
		self.marked_range = Some(start..start + new_text.len());

		if let Some(new_sel_u16) = new_selected_range_utf16 {
			let updated_text = self.buffer.text();
			let sel_range = range_from_utf16(updated_text, new_sel_u16);
			self
				.buffer
				.set_selection(Selection::new(sel_range.start, sel_range.end));
		}

		self.goal_column = None;
		self.reset_blink(cx);
		cx.emit(EditorEvent::Changed);
		cx.notify();
	}

	fn bounds_for_range(
		&mut self,
		range_utf16: Range<usize>,
		element_bounds: Bounds<Pixels>,
		_window: &mut Window,
		_cx: &mut Context<Self>,
	) -> Option<Bounds<Pixels>> {
		let text = self.buffer.text();
		let range = range_from_utf16(text, range_utf16);
		let layout = self.last_layout.as_ref()?;
		layout.bounds_for_range(range, element_bounds)
	}

	fn character_index_for_point(
		&mut self,
		point: Point<Pixels>,
		_window: &mut Window,
		_cx: &mut Context<Self>,
	) -> Option<usize> {
		let layout = self.last_layout.as_ref()?;
		let doc_offset = layout.character_index_for_point(point)?;
		let text = self.buffer.text();
		Some(offset_to_utf16(text, doc_offset))
	}
}
