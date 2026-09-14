//! The part of a file a mono pane draws: the rows and the columns its own box
//! shows (§5.11).
//!
//! A pane scrolls, so the file it holds is taller and wider than the box it
//! draws in. Building a cell for every line and a run for every span drew the
//! whole file on every frame instead. 40 lines of 900 columns arrive from
//! syntect as some 13,000 spans, about 400 of which are inside the pane's own
//! 300px of width; the other 12,600 were laid out, shaped and painted under a
//! scissor that discarded them. One frame cost 140ms of a core in software
//! rendering, the window redrew at 7fps, and a pointer press, a keystroke and
//! a wheel over the pane all landed on a surface that had stopped answering. A
//! diff of a few thousand rows reaches the same state, and on a GPU as well.
//!
//! The scroll offset is what states which part is on screen, so the offsets
//! are read from the panes' own scroll handles before their cells are built,
//! and the rows and columns outside them are replaced by padding of the exact
//! extent they would have occupied. The scroll extent is therefore unchanged
//! and every line stays reachable: the wheel moves the offset, the next frame
//! reads it, and the rows it now covers are the ones built.
//!
//! Rows are admitted through one cursor in document order rather than by index
//! arithmetic, because the rows are not one height — a hunk header is taller
//! than a line, a file header and a divider sit between two files' rows, and a
//! split diff pairs a spanning row against a blank one. A cursor advanced by
//! the height each row actually draws at needs none of that stated twice.
//! Both columns of a pane take the same padding from the same cursor, so the
//! numbers stay in step with the lines across the seam.

use unicode_width::UnicodeWidthChar;
use veyyon_desktop_kit::ColorRole;
use veyyon_gpui::{Pixels, ScrollHandle, Window};

use crate::right_panel::content::HighlightSpan;

/// How much of the file above and below the pane's box is built anyway, so a
/// wheel that arrives between two frames scrolls onto rows that are already
/// there rather than onto padding.
const OVERSCAN_PX: f32 = 256.0;

/// The same allowance sideways, in monospace cells.
const COLUMN_OVERSCAN: usize = 16;

/// Where a pane's scroll region stands: how far into its content it is
/// scrolled, and how large the box it scrolls is.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Scrolled {
	pub scroll_x_px: f32,
	pub scroll_y_px: f32,
	pub width_px:    f32,
	pub height_px:   f32,
}

/// Reads a scroll handle as a distance into its content and a box.
///
/// The offset a handle carries is negative as the content travels up and left,
/// which is the opposite sign from the distance into the file, so it is taken
/// back here rather than at each call.
///
/// A handle no frame has laid out yet reports a zero box. The window's own
/// extent bounds any pane inside it, so it stands in until a frame has
/// measured the pane, and the pane draws more than it shows for one frame
/// rather than drawing a whole file on every frame.
pub fn scrolled(handle: &ScrollHandle, window: &Window) -> Scrolled {
	let offset = handle.offset();
	let extent = handle.max_offset();
	let bounds = handle.bounds();
	let viewport = window.viewport_size();
	Scrolled {
		scroll_x_px: distance(offset.x, extent.x),
		scroll_y_px: distance(offset.y, extent.y),
		width_px:    measured_or(bounds.size.width, viewport.width),
		height_px:   measured_or(bounds.size.height, viewport.height),
	}
}

/// How far into its content an offset of `offset` reaches, against an extent
/// of `extent`.
///
/// Every wheel that arrives between two frames adds its delta to the offset
/// and the next layout clamps it, so the offset read here is the sum of the
/// deltas rather than the distance the pane can travel: a run of the wheel
/// left a diff of nine rows reporting itself 520px down a file 250px tall, the
/// rows on screen were measured as rows above the box, and the pane drew the
/// padding that stands in for them instead of the lines. The extent the last
/// frame measured is the bound, so the distance is taken against it here.
fn distance(offset: Pixels, extent: Pixels) -> f32 {
	f32::from(offset)
		.min(0.0)
		.abs()
		.min(f32::from(extent).max(0.0))
}

/// A measured extent, or `fallback` where no frame has measured one yet.
fn measured_or(measured: Pixels, fallback: Pixels) -> f32 {
	let measured = f32::from(measured);
	if measured > 0.0 {
		measured
	} else {
		f32::from(fallback)
	}
}

/// A cursor through one scroll region's rows in the order they are drawn,
/// which admits the rows inside the box and measures the ones outside it.
///
/// One walk covers every pane in the region: a diff view scrolls its files
/// together, so the second file's rows are admitted against the same box as
/// the first file's, and the header and hairline between them are part of the
/// distance the cursor has travelled.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct RowWalk {
	/// The band of content the pane draws, or `None` to admit every row.
	band:          Option<(f32, f32)>,
	/// How far into the content the rows built so far reach.
	cursor:        f32,
	/// The extent skipped before the current pane's first admitted row.
	lead_px:       f32,
	/// The extent skipped after it.
	tail_px:       f32,
	/// Whether the current pane has admitted a row yet, which is what decides
	/// whether a skipped row is padding above the pane's rows or below them.
	admitted_here: bool,
}

impl RowWalk {
	/// A walk that admits every row, for a caller with no scroll region to
	/// measure against.
	pub const fn everything() -> Self {
		Self {
			band:          None,
			cursor:        0.0,
			lead_px:       0.0,
			tail_px:       0.0,
			admitted_here: false,
		}
	}

	/// A walk that admits the rows `scrolled` shows, with the overscan.
	pub fn of(scrolled: &Scrolled) -> Self {
		let top = (scrolled.scroll_y_px - OVERSCAN_PX).max(0.0);
		let bottom = scrolled.scroll_y_px + scrolled.height_px + OVERSCAN_PX;
		Self { band: Some((top, bottom)), ..Self::everything() }
	}

	/// Records a row of `height_px` that is built whatever the offset is: a
	/// toolbar, a file header, the hairline between two files.
	///
	/// Chrome is a fixed count per file rather than a count per line, so it
	/// costs nothing to build and the pane below it needs the distance.
	pub const fn advance(&mut self, height_px: f32) {
		self.cursor += height_px;
	}

	/// Whether a row of `height_px` is inside the box, advancing past it
	/// either way.
	pub fn admit(&mut self, height_px: f32) -> bool {
		let top = self.cursor;
		self.cursor += height_px;
		let Some((band_top, band_bottom)) = self.band else {
			self.admitted_here = true;
			return true;
		};
		if self.cursor > band_top && top < band_bottom {
			self.admitted_here = true;
			return true;
		}
		if self.admitted_here {
			self.tail_px += height_px;
		} else {
			self.lead_px += height_px;
		}
		false
	}

	/// The padding that stands in for the rows this pane skipped, above its
	/// first built row and below its last, clearing them for the next pane.
	pub const fn take_padding(&mut self) -> (f32, f32) {
		let padding = (self.lead_px, self.tail_px);
		self.lead_px = 0.0;
		self.tail_px = 0.0;
		self.admitted_here = false;
		padding
	}
}

/// The columns a pane draws, in monospace cells.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ColumnWindow {
	/// The first cell drawn.
	pub first: usize,
	/// One past the last cell drawn.
	pub end:   usize,
}

impl ColumnWindow {
	/// Every column, for a caller with no scroll region to measure against.
	pub const fn everything() -> Self {
		Self { first: 0, end: usize::MAX }
	}

	/// The cells `scrolled` shows, given how wide one cell is.
	pub fn of(scrolled: &Scrolled, advance_px: f32) -> Self {
		if advance_px <= 0.0 {
			return Self::everything();
		}
		let first =
			((scrolled.scroll_x_px / advance_px).floor() as usize).saturating_sub(COLUMN_OVERSCAN);
		let end = (((scrolled.scroll_x_px + scrolled.width_px) / advance_px).ceil() as usize)
			.saturating_add(COLUMN_OVERSCAN);
		Self { first, end: end.max(first) }
	}
}

/// One piece of a line a pane draws: a span, or the part of one its columns
/// reach.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Piece<'a> {
	pub text: &'a str,
	pub role: ColorRole,
}

/// The pieces of `spans` that lie inside `columns`, and the cell the first of
/// them starts at.
///
/// A span wider than the pane is cut to the cells on screen rather than kept
/// whole: one line of minified source arrives as a single span of a hundred
/// thousand columns, and a pane that took spans whole would draw all of it to
/// show 40 columns of it.
pub fn visible_pieces(spans: &[HighlightSpan], columns: ColumnWindow) -> (usize, Vec<Piece<'_>>) {
	let mut cell = 0_usize;
	let mut lead = None;
	let mut pieces = Vec::new();
	for span in spans {
		let end = cell.saturating_add(text_columns(&span.text));
		if end <= columns.first {
			cell = end;
			continue;
		}
		if cell >= columns.end {
			break;
		}
		let (skipped, text) = slice_columns(
			&span.text,
			columns.first.saturating_sub(cell),
			columns.end.saturating_sub(cell),
		);
		if !text.is_empty() {
			if lead.is_none() {
				lead = Some(cell.saturating_add(skipped));
			}
			pieces.push(Piece { text, role: span.role });
		}
		cell = end;
	}
	(lead.unwrap_or(0), pieces)
}

/// How many cells `text` occupies, counted as a terminal counts them.
pub fn text_columns(text: &str) -> usize {
	text.chars().map(char_columns).sum()
}

fn char_columns(character: char) -> usize {
	UnicodeWidthChar::width(character).unwrap_or(0)
}

/// The part of `text` between cells `from` and `to`, and the cells dropped
/// before it.
///
/// A glyph that straddles either edge is kept whole, so a slice never starts
/// or ends inside one character.
fn slice_columns(text: &str, from: usize, to: usize) -> (usize, &str) {
	let mut cell = 0_usize;
	let mut start: Option<(usize, usize)> = None;
	for (index, character) in text.char_indices() {
		let width = char_columns(character);
		match start {
			None if cell.saturating_add(width) <= from => cell = cell.saturating_add(width),
			None => {
				start = Some((index, cell));
				cell = cell.saturating_add(width);
			},
			Some((byte, skipped)) if cell >= to => return (skipped, &text[byte..index]),
			Some(_) => cell = cell.saturating_add(width),
		}
	}
	match start {
		Some((byte, skipped)) => (skipped, &text[byte..]),
		None => (cell, ""),
	}
}
