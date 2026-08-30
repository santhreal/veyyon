//! Between bytes and pixels: the offset under a point, the point of an offset,
//! the row a caret is on, and the utf16 offsets an IME speaks in.

use super::*;

impl Editor {
	pub(super) fn visual_rows(&self) -> usize {
		self
			.shaped
			.as_ref()
			.map(|shaped| rows_in(&shaped.lines))
			.unwrap_or(1)
	}

	/// The byte offset nearest a window-space point.
	pub(super) fn offset_at(&self, position: Point<Pixels>) -> usize {
		let Some(shaped) = self.shaped.as_ref() else {
			return self.caret();
		};
		let local = point(
			position.x - shaped.bounds.origin.x,
			position.y - shaped.bounds.origin.y + shaped.scroll,
		);
		if local.y < px(0.0) {
			return 0;
		}
		let last = shaped.lines.len().saturating_sub(1);
		let mut start = 0;
		let mut top = px(0.0);
		for (index, line) in shaped.lines.iter().enumerate() {
			let height = shaped.line_height * (line.wrap_boundaries().len() + 1) as f32;
			if local.y < top + height || index == last {
				let inside = point(local.x, (local.y - top).max(px(0.0)));
				let within = line
					.closest_index_for_position(inside, shaped.line_height)
					.unwrap_or_else(|fallback| fallback);
				return start + within.min(line.len());
			}
			top += height;
			start += line.len() + 1;
		}
		self.text.len()
	}

	/// Where a byte offset is, in field-local coordinates before scrolling.
	pub(super) fn position_of(&self, offset: usize) -> Option<Point<Pixels>> {
		let shaped = self.shaped.as_ref()?;
		let mut start = 0;
		let mut top = px(0.0);
		for line in shaped.lines.iter() {
			let end = start + line.len();
			if offset <= end {
				let local = line.position_for_index(offset - start, shaped.line_height)?;
				return Some(point(local.x, local.y + top));
			}
			top += shaped.line_height * (line.wrap_boundaries().len() + 1) as f32;
			start = end + 1;
		}
		None
	}

	/// The offset one visual row above or below the caret, at the same x.
	pub(super) fn vertical(&self, rows: i32) -> Option<usize> {
		let shaped = self.shaped.as_ref()?;
		let at = self.position_of(self.caret())?;
		let target_y = at.y + shaped.line_height * rows as f32;
		if target_y < px(0.0) {
			return None;
		}
		let offset = self.offset_at(point(
			at.x + shaped.bounds.origin.x,
			target_y + shaped.bounds.origin.y - shaped.scroll,
		));
		(offset != self.caret()).then_some(offset)
	}

	/// The byte range of the visual row the caret is on.
	pub(super) fn row_bounds(&self) -> Option<(usize, usize)> {
		let shaped = self.shaped.as_ref()?;
		let caret = self.caret();
		let mut start = 0;
		for line in shaped.lines.iter() {
			let end = start + line.len();
			if caret <= end {
				let mut row = (start, end);
				for (from, to) in rows_of(line, start) {
					if caret <= to {
						row = (from, to);
						break;
					}
				}
				return Some(row);
			}
			start = end + 1;
		}
		None
	}

	// utf16, which is what a platform IME counts in.

	pub(super) fn to_utf16(&self, range: &Range<usize>) -> Range<usize> {
		text::offset_to_utf16(&self.text, range.start)..text::offset_to_utf16(&self.text, range.end)
	}

	pub(super) fn to_offsets(&self, range: &Range<usize>) -> Range<usize> {
		text::offset_from_utf16(&self.text, range.start)
			..text::offset_from_utf16(&self.text, range.end)
	}
}
