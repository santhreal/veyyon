//! Text layout state, visual line mapping, and coordinate geometry for Editor
//! (§8.25).

use std::{ops::Range, sync::Arc};

use veyyon_gpui::{Bounds, Pixels, Point, Size, WrappedLine, point, px};

/// Descriptor for a single visual wrapped subline row.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct VisualLine {
	/// Index of the physical line in the layout.
	pub physical_index:  usize,
	/// Global start byte offset in full buffer text.
	pub start_offset:    usize,
	/// Global end byte offset in full buffer text.
	pub end_offset:      usize,
	/// Start byte offset relative to the physical line.
	pub rel_start:       usize,
	/// End byte offset relative to the physical line.
	pub rel_end:         usize,
	/// 0-indexed visual line number.
	pub visual_index:    usize,
	/// Vertical offset in pixels from the top of text content.
	pub y_offset:        Pixels,
	/// Horizontal start offset in unwrapped layout.
	pub start_unwrapped: Pixels,
}

/// Layout snapshot computed during editor layout and used for paint and input
/// hit-testing.
#[derive(Clone, Debug)]
pub struct EditorLayoutState {
	/// Shaped and wrapped lines produced by TextSystem.
	pub lines:        Arc<[WrappedLine]>,
	/// Line height in pixels.
	pub line_height:  Pixels,
	/// Font size in pixels.
	pub font_size:    Pixels,
	/// Outer element bounds in window logical coordinates.
	pub bounds:       Bounds<Pixels>,
	/// Current vertical scroll position in pixels.
	pub scroll_top:   Pixels,
	/// List of all mapped visual wrapped subline segments.
	pub visual_lines: Vec<VisualLine>,
	/// Total content height across all visual lines.
	pub total_height: Pixels,
	/// Physical line starting byte offsets.
	pub line_starts:  Vec<usize>,
}

impl EditorLayoutState {
	/// Builds a layout state from shaped lines, bounds, and scroll position.
	#[must_use]
	pub fn new(
		lines: Arc<[WrappedLine]>,
		line_height: Pixels,
		font_size: Pixels,
		bounds: Bounds<Pixels>,
		scroll_top: Pixels,
	) -> Self {
		let mut visual_lines = Vec::new();
		let mut line_starts = Vec::new();
		let mut current_offset = 0;
		let mut visual_idx = 0;

		for (p_idx, line) in lines.iter().enumerate() {
			line_starts.push(current_offset);
			let line_len = line.text.len();
			let wrap_bounds = line.wrap_boundaries();

			if wrap_bounds.is_empty() {
				let y_offset = line_height * visual_idx as f32;
				visual_lines.push(VisualLine {
					physical_index: p_idx,
					start_offset: current_offset,
					end_offset: current_offset + line_len,
					rel_start: 0,
					rel_end: line_len,
					visual_index: visual_idx,
					y_offset,
					start_unwrapped: Pixels::ZERO,
				});
			} else {
				let mut seg_start = 0;
				for wb in wrap_bounds {
					let run = &line.unwrapped_layout.runs[wb.run_ix];
					let glyph = &run.glyphs[wb.glyph_ix];
					let seg_end = glyph.index;
					let start_unwrapped = line.unwrapped_layout.x_for_index(seg_start);
					let y_offset = line_height * visual_idx as f32;

					visual_lines.push(VisualLine {
						physical_index: p_idx,
						start_offset: current_offset + seg_start,
						end_offset: current_offset + seg_end,
						rel_start: seg_start,
						rel_end: seg_end,
						visual_index: visual_idx,
						y_offset,
						start_unwrapped,
					});

					seg_start = seg_end;
					visual_idx += 1;
				}

				let start_unwrapped = line.unwrapped_layout.x_for_index(seg_start);
				let y_offset = line_height * visual_idx as f32;
				visual_lines.push(VisualLine {
					physical_index: p_idx,
					start_offset: current_offset + seg_start,
					end_offset: current_offset + line_len,
					rel_start: seg_start,
					rel_end: line_len,
					visual_index: visual_idx,
					y_offset,
					start_unwrapped,
				});
			}
			visual_idx += 1;
			// Plus 1 for newline delimiter between physical lines
			current_offset += line_len + 1;
		}

		let total_height = line_height * visual_idx.max(1) as f32;

		Self {
			lines,
			line_height,
			font_size,
			bounds,
			scroll_top,
			visual_lines,
			total_height,
			line_starts,
		}
	}

	/// Returns total number of visual lines.
	#[must_use]
	pub fn visual_line_count(&self) -> usize {
		self.visual_lines.len().max(1)
	}

	/// Finds the visual line index containing `offset`.
	#[must_use]
	pub fn visual_line_for_offset(&self, offset: usize) -> usize {
		if self.visual_lines.is_empty() {
			return 0;
		}

		for (idx, vl) in self.visual_lines.iter().enumerate() {
			if offset <= vl.end_offset || idx == self.visual_lines.len() - 1 {
				return idx;
			}
		}

		self.visual_lines.len().saturating_sub(1)
	}

	/// Computes the pixel position relative to the content area for a byte
	/// offset.
	#[must_use]
	pub fn position_for_offset(&self, offset: usize) -> Option<Point<Pixels>> {
		if self.visual_lines.is_empty() {
			return Some(point(px(0.0), px(0.0)));
		}

		let vl_idx = self.visual_line_for_offset(offset);
		let vl = &self.visual_lines[vl_idx];
		let line = self.lines.get(vl.physical_index)?;

		let rel_offset = offset
			.saturating_sub(vl.start_offset)
			.min(vl.rel_end.saturating_sub(vl.rel_start))
			+ vl.rel_start;

		let unwrapped_x = line.unwrapped_layout.x_for_index(rel_offset);
		let x = (unwrapped_x - vl.start_unwrapped).max(Pixels::ZERO);

		Some(point(x, vl.y_offset))
	}

	/// Maps a content-relative point to the closest byte offset in the buffer.
	#[must_use]
	pub fn character_index_for_point(&self, point: Point<Pixels>) -> Option<usize> {
		if self.visual_lines.is_empty() {
			return Some(0);
		}

		let rel_y = (point.y - self.bounds.top() + self.scroll_top).max(Pixels::ZERO);
		let rel_x = (point.x - self.bounds.left()).max(Pixels::ZERO);

		let line_h_f32 = f32::from(self.line_height);
		let target_visual_idx = if line_h_f32 > 0.0 {
			(f32::from(rel_y) / line_h_f32).floor() as usize
		} else {
			0
		};

		let vl_idx = target_visual_idx.min(self.visual_lines.len().saturating_sub(1));
		let vl = &self.visual_lines[vl_idx];
		let line = self.lines.get(vl.physical_index)?;

		let query_x = vl.start_unwrapped + rel_x;
		let closest_rel = line
			.unwrapped_layout
			.closest_index_for_x(query_x)
			.clamp(vl.rel_start, vl.rel_end);

		let doc_offset = vl.start_offset + (closest_rel - vl.rel_start);
		Some(doc_offset)
	}

	/// Finds the closest buffer offset on visual line `vl_idx` matching goal
	/// column `target_x`.
	#[must_use]
	pub fn closest_offset_for_visual_line_and_x(&self, vl_idx: usize, target_x: Pixels) -> usize {
		if self.visual_lines.is_empty() {
			return 0;
		}

		let clamped_idx = vl_idx.min(self.visual_lines.len().saturating_sub(1));
		let vl = &self.visual_lines[clamped_idx];
		let Some(line) = self.lines.get(vl.physical_index) else {
			return vl.start_offset;
		};

		let query_x = vl.start_unwrapped + target_x;
		let closest_rel = line
			.unwrapped_layout
			.closest_index_for_x(query_x)
			.clamp(vl.rel_start, vl.rel_end);

		vl.start_offset + (closest_rel - vl.rel_start)
	}

	/// Computes visual bounds for a byte range in window coordinates.
	#[must_use]
	pub fn bounds_for_range(
		&self,
		range: Range<usize>,
		element_bounds: Bounds<Pixels>,
	) -> Option<Bounds<Pixels>> {
		let start_pt = self.position_for_offset(range.start)?;
		let end_pt = if range.is_empty() {
			start_pt
		} else {
			self.position_for_offset(range.end).unwrap_or(start_pt)
		};

		let min_x = start_pt.x.min(end_pt.x);
		let max_x = start_pt.x.max(end_pt.x);
		let width = if min_x == max_x {
			px(1.0)
		} else {
			max_x - min_x
		};

		Some(Bounds::new(
			point(element_bounds.left() + min_x, element_bounds.top() + start_pt.y - self.scroll_top),
			Size::new(width, self.line_height),
		))
	}
}
