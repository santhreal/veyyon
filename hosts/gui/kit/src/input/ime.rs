//! What the platform's input method sees: the focus handle, the marked text
//! it underlines while composing, and the utf16 offsets it speaks in.

use super::*;

impl Focusable for Editor {
	fn focus_handle(&self, _: &App) -> FocusHandle {
		self.focus.clone()
	}
}

impl EntityInputHandler for Editor {
	fn text_for_range(
		&mut self,
		range_utf16: Range<usize>,
		actual: &mut Option<Range<usize>>,
		_: &mut Window,
		_: &mut Context<Self>,
	) -> Option<String> {
		let range = self.to_offsets(&range_utf16);
		actual.replace(self.to_utf16(&range));
		Some(self.text[range].to_owned())
	}

	fn selected_text_range(
		&mut self,
		_ignore_disabled: bool,
		_: &mut Window,
		_: &mut Context<Self>,
	) -> Option<UTF16Selection> {
		Some(UTF16Selection { range: self.to_utf16(&self.selection), reversed: self.reversed })
	}

	fn marked_text_range(&self, _: &mut Window, _: &mut Context<Self>) -> Option<Range<usize>> {
		self.marked.as_ref().map(|range| self.to_utf16(range))
	}

	fn unmark_text(&mut self, _: &mut Window, _: &mut Context<Self>) {
		self.marked = None;
	}

	fn replace_text_in_range(
		&mut self,
		range_utf16: Option<Range<usize>>,
		new_text: &str,
		_: &mut Window,
		cx: &mut Context<Self>,
	) {
		let range = range_utf16
			.as_ref()
			.map(|range| self.to_offsets(range))
			.or_else(|| self.marked.clone())
			.unwrap_or_else(|| self.selection.clone());
		let new_text = if self.multiline {
			new_text.to_owned()
		} else {
			new_text.replace(['\n', '\r'], " ")
		};
		self.replace(range, &new_text, cx);
	}

	fn replace_and_mark_text_in_range(
		&mut self,
		range_utf16: Option<Range<usize>>,
		new_text: &str,
		new_selection_utf16: Option<Range<usize>>,
		_: &mut Window,
		cx: &mut Context<Self>,
	) {
		let range = range_utf16
			.as_ref()
			.map(|range| self.to_offsets(range))
			.or_else(|| self.marked.clone())
			.unwrap_or_else(|| self.selection.clone());

		let (text, caret) = text::replace(&self.text, range.clone(), new_text);
		let start = text::clamp(&text, range.start);
		self.text = SharedString::from(text);
		self.marked = (!new_text.is_empty()).then(|| start..start + new_text.len());
		self.selection = match new_selection_utf16.as_ref() {
			Some(selected) => {
				let selected = self.to_offsets(selected);
				let from = text::clamp(&self.text, start + selected.start);
				let to = text::clamp(&self.text, start + selected.end);
				from.min(to)..to.max(from)
			},
			None => caret..caret,
		};
		self.reversed = false;
		self.edited(cx);
	}

	fn bounds_for_range(
		&mut self,
		range_utf16: Range<usize>,
		element_bounds: Bounds<Pixels>,
		_: &mut Window,
		_: &mut Context<Self>,
	) -> Option<Bounds<Pixels>> {
		let line_height = self.shaped.as_ref()?.line_height;
		let scroll = self.shaped.as_ref()?.scroll;
		let range = self.to_offsets(&range_utf16);
		let start = self.position_of(range.start)?;
		let end = self.position_of(range.end).unwrap_or(start);
		Some(Bounds::from_corners(
			point(element_bounds.origin.x + start.x, element_bounds.origin.y + start.y - scroll),
			point(
				element_bounds.origin.x + end.x,
				element_bounds.origin.y + end.y + line_height - scroll,
			),
		))
	}

	fn character_index_for_point(
		&mut self,
		point: Point<Pixels>,
		_: &mut Window,
		_: &mut Context<Self>,
	) -> Option<usize> {
		let offset = self.offset_at(point);
		Some(text::offset_to_utf16(&self.text, offset))
	}
}
