//! The shaped text of one frame, split into visual rows, with hit testing.
//!
//! A logical line shapes into one [`WrappedLine`]; each wrap boundary starts
//! another visual row. Offsets here are byte offsets into the text that was
//! shaped. Positions are relative to the top-left of the text content, before
//! scrolling.

use veyyon_gpui::{Pixels, Point, WrappedLine, point};

/// One visual row: a slice of one shaped line.
#[derive(Clone, Copy, Debug)]
pub struct Row {
	/// Index of the shaped line.
	pub line:      usize,
	/// Offset of the row start in the whole text.
	pub start:     usize,
	/// Offset of the row end in the whole text.
	pub end:       usize,
	/// Offset of the row start inside its shaped line.
	pub rel_start: usize,
	/// Horizontal position of the row start inside the unwrapped line.
	pub x0:        Pixels,
	/// True when a wrap, not a line break, ends the row.
	pub wrapped:   bool,
}

/// The layout of one frame.
pub struct TextLayout {
	/// The shaped lines, one per logical line.
	pub lines:       Vec<WrappedLine>,
	/// Index of the first row of each shaped line.
	pub first_row:   Vec<usize>,
	/// Every visual row, in order.
	pub rows:        Vec<Row>,
	/// Height of one row.
	pub line_height: Pixels,
	/// Width of the widest row.
	pub width:       Pixels,
	/// Buffer revision the layout was shaped from.
	pub revision:    u64,
	/// True when the placeholder, not the buffer, was shaped.
	pub placeholder: bool,
}

impl TextLayout {
	/// Splits `lines` into rows.
	pub fn new(
		lines: Vec<WrappedLine>,
		line_height: Pixels,
		revision: u64,
		placeholder: bool,
	) -> Self {
		let mut rows = Vec::with_capacity(lines.len());
		let mut first_row = Vec::with_capacity(lines.len());
		let mut width = Pixels::ZERO;
		let mut line_offset = 0;
		for (index, line) in lines.iter().enumerate() {
			first_row.push(rows.len());
			let layout = &line.unwrapped_layout;
			let mut rel_start = 0;
			let ends = line
				.wrap_boundaries()
				.iter()
				.filter_map(|boundary| {
					let glyph = layout.runs.get(boundary.run_ix)?.glyphs.get(boundary.glyph_ix)?;
					Some((glyph.index, true))
				})
				.chain([(line.len(), false)]);
			for (rel_end, wrapped) in ends {
				let rel_end = rel_end.clamp(rel_start, line.len().max(rel_start));
				let x0 = layout.x_for_index(rel_start);
				width = width.max(layout.x_for_index(rel_end) - x0);
				rows.push(Row {
					line: index,
					start: line_offset + rel_start,
					end: line_offset + rel_end,
					rel_start,
					x0,
					wrapped,
				});
				rel_start = rel_end;
			}
			line_offset += line.len() + 1;
		}
		Self { lines, first_row, rows, line_height, width, revision, placeholder }
	}

	/// The number of rows; never zero.
	pub fn row_count(&self) -> usize {
		self.rows.len().max(1)
	}

	/// The height of the whole content.
	pub fn height(&self) -> Pixels {
		self.line_height * self.row_count() as f32
	}

	/// The vertical position of the first row of shaped line `line`.
	pub fn line_top(&self, line: usize) -> Pixels {
		let row = self.first_row.get(line).copied().unwrap_or(line);
		self.line_height * row as f32
	}

	/// The row the caret at `offset` is drawn on. An offset on a wrap boundary
	/// belongs to the row the wrap starts.
	pub fn row_for_offset(&self, offset: usize) -> usize {
		self.rows.partition_point(|row| row.start <= offset).saturating_sub(1)
	}

	/// The horizontal position of `offset` inside row `index`.
	pub fn x_in_row(&self, index: usize, offset: usize) -> Pixels {
		let Some(row) = self.rows.get(index) else {
			return Pixels::ZERO;
		};
		let Some(line) = self.lines.get(row.line) else {
			return Pixels::ZERO;
		};
		let rel = row.rel_start + offset.clamp(row.start, row.end) - row.start;
		line.unwrapped_layout.x_for_index(rel) - row.x0
	}

	/// The top-left of the caret at `offset`.
	pub fn position(&self, offset: usize) -> Point<Pixels> {
		let index = self.row_for_offset(offset);
		point(self.x_in_row(index, offset), self.line_height * index as f32)
	}

	/// The offset in row `index` closest to horizontal position `x`. The end of
	/// a wrapped row is the start of the next one, so a hit past the last glyph
	/// of a wrapped row lands before that glyph instead.
	pub fn offset_in_row(&self, index: usize, x: Pixels) -> usize {
		let Some(row) = self.rows.get(index.min(self.rows.len().saturating_sub(1))) else {
			return 0;
		};
		let Some(line) = self.lines.get(row.line) else {
			return row.start;
		};
		let rel_end = row.rel_start + row.end - row.start;
		let mut rel =
			line.unwrapped_layout.closest_index_for_x(row.x0 + x).clamp(row.rel_start, rel_end);
		if row.wrapped && rel == rel_end && rel > row.rel_start {
			rel -= line.text[..rel].chars().next_back().map_or(0, char::len_utf8);
		}
		row.start + rel - row.rel_start
	}

	/// The offset closest to `position`, relative to the content origin.
	pub fn offset_for_position(&self, position: Point<Pixels>) -> usize {
		let y = f32::from(position.y.max(Pixels::ZERO));
		let height = f32::from(self.line_height);
		let index = if height > 0.0 { (y / height) as usize } else { 0 };
		self.offset_in_row(index, position.x.max(Pixels::ZERO))
	}
}
