//! A mono pane's code scrolled sideways under a gutter that stays put.
//!
//! A pane that does not wrap holds lines wider than its box. Every row draws
//! its code in a column that clips it, shifted left by the one offset the
//! pane holds, so the line numbers stay in place while the code travels. The
//! wheel's horizontal travel moves the offset, bounded so the widest line's
//! end stops at the column's right edge.

use std::{cell::Cell, rc::Rc};

use veyyon_desktop_ui::theme::text;
use veyyon_gpui::{
	Div, IntoElement, ParentElement, Pixels, ScrollWheelEvent, Styled, TextRun, Window, canvas, div,
	font,
};

/// How many of the longest lines, by bytes, are shaped to find the widest.
/// A line of wide characters holds more bytes per column than one of ASCII,
/// so it ranks among them.
const SHAPED: usize = 16;

/// The sideways offset a pane's code columns share.
#[derive(Default)]
pub struct Sideways {
	offset:  Pixels,
	/// How wide the pane's widest line draws; `None` until measured.
	content: Option<Pixels>,
	/// How wide the last frame laid a code column out.
	column:  Rc<Cell<Pixels>>,
}

impl Sideways {
	/// Returns to the lines' start and forgets the widest line, for a pane
	/// that holds new lines.
	pub const fn reset(&mut self) {
		self.offset = Pixels::ZERO;
		self.content = None;
	}

	/// Measures the widest of `lines` in the mono face, once per
	/// [`Sideways::reset`], and keeps the offset inside the bound.
	pub fn measure<'a>(&mut self, lines: impl Iterator<Item = &'a str>, window: &Window) {
		if self.content.is_none() {
			let mut longest: Vec<&str> = Vec::with_capacity(SHAPED + 1);
			for line in lines.filter(|line| !line.is_empty()) {
				let at = longest.partition_point(|held| held.len() >= line.len());
				if at < SHAPED {
					longest.insert(at, line);
					longest.truncate(SHAPED);
				}
			}
			let mut face = font(text::MONO.family);
			face.weight = text::MONO.weight;
			let shaper = window.text_system();
			let widest = longest
				.into_iter()
				.map(|line| {
					let run = TextRun { len: line.len(), font: face.clone(), ..TextRun::default() };
					shaper
						.layout_line(line, text::MONO.size, &[run], None)
						.width
				})
				.fold(Pixels::ZERO, Pixels::max);
			self.content = Some(widest);
		}
		self.offset = self.offset.min(self.max());
	}

	/// The farthest the code scrolls: the widest line's overhang past the
	/// column.
	fn max(&self) -> Pixels {
		(self.content.unwrap_or_default() - self.column.get()).max(Pixels::ZERO)
	}

	/// Moves the code by the wheel's horizontal travel, when the gesture
	/// travels more sideways than down, so a scroll down the lines never
	/// slides the code. Returns whether it moved.
	pub fn wheel(&mut self, event: &ScrollWheelEvent) -> bool {
		let travel = event.delta.pixel_delta(text::MONO.line_height);
		if travel.x.abs() <= travel.y.abs() {
			return false;
		}
		let next = (self.offset - travel.x).clamp(Pixels::ZERO, self.max());
		let moved = next != self.offset;
		self.offset = next;
		moved
	}

	/// `code` in a column that clips it, shifted by the offset, which states
	/// its width to the bound. A lead before the code goes on the column as a
	/// margin: padding inside it widens the code past the widest line, and
	/// the end of that line then stops beyond the column's edge.
	pub fn column(&self, code: impl IntoElement) -> Div {
		let column = self.column.clone();
		let record = canvas(move |bounds, _, _| column.set(bounds.size.width), |_, (), _, _| {})
			.absolute()
			.size_full();
		div()
			.relative()
			.flex_1()
			.min_w_0()
			.overflow_hidden()
			.child(record)
			.child(div().ml(-self.offset).whitespace_nowrap().child(code))
	}
}
