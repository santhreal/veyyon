//! The two columns a mono pane draws in: the gutter it pins and the code it
//! scrolls sideways (§5.11).
//!
//! §5.11 authors the mono panes with word wrap off, horizontal scroll, and both
//! gutters pinned. A pane that only clips is a pane whose long lines do not
//! exist: a code line wider than 540px of panel was cut at the panel's edge
//! mid-glyph, with no ellipsis to say it was cut and no way to reach the rest,
//! and a diff of a generated file was unreadable past its first column of
//! text.
//!
//! Clipping and scrolling are not alternatives here. The line numbers must stay
//! where they are while the text moves, so the pane is two columns: the gutter
//! column outside the scroll region, and one code column inside it. Both draw
//! one cell per line at the same authored row height, so a row reads across the
//! seam, and the scroll region carries the whole file rather than one line, so
//! every line moves by the same offset and the columns stay aligned.

use veyyon_desktop_kit::{MonoText, TokenSet, mono_advance};
use veyyon_desktop_tokens::PanelsSurfaceTokens;
use veyyon_gpui::{
	Div, ElementId, InteractiveElement, ParentElement, ScrollHandle, StatefulInteractiveElement,
	Styled, Window, div, px, relative,
};

/// Composes a mono pane's body from its pinned gutter column and its
/// scrolling code column.
///
/// `PaneParts::content_width_px` is how wide the widest line is. It is stated
/// rather than left to the layout because a column of auto width inside a
/// scroll region resolves to the region's own width: the lines then overflow
/// their boxes, the scroll extent is zero, and the pane reads as clipped with
/// a wheel that does nothing. The region's own width is a floor, so a file of
/// short lines still fills the pane rather than leaving a strip of rail beside
/// the text.
///
/// The wheel is restricted to the axis of the gesture. Without that, GPUI maps
/// a vertical wheel onto the one axis a region scrolls, so every scroll down
/// the file would have slid the code sideways instead.
///
/// The pane states no width of its own: a docked file pane fills the panel,
/// and a split diff draws two panes that each take half of it, so the caller
/// states which.
pub fn pinned_gutter_pane(
	pane: PaneParts<'_>,
	geometry: &PanelsSurfaceTokens,
	tokens: &TokenSet,
) -> Div {
	let (lead_px, tail_px) = pane.padding;
	div()
		.flex()
		.flex_row()
		.items_start()
		.mono_type(tokens, &geometry.diff_font_size)
		.child(column(pane.gutter, lead_px, tail_px).flex_shrink_0())
		.child(
			div()
				.id(pane.id)
				.track_scroll(pane.columns)
				.flex_1()
				.min_w_0()
				.overflow_x_scroll()
				.restrict_scroll_to_axis()
				.child(
					column(pane.code, lead_px, tail_px)
						.flex_none()
						.w(px(pane.content_width_px))
						.min_w(relative(1.0)),
				),
		)
}

/// What a pane is composed from: the columns, the region that scrolls them,
/// and the extent of the rows outside the box.
///
/// Stated as one value because a pane whose padding, id and scroll handle
/// arrive as four positional arguments is a pane whose two columns can be
/// given different padding by a caller that transposes two of them, which
/// reads as the numbers drifting out of step with the lines.
pub struct PaneParts<'a> {
	/// Names the scroll region, which is what retains the offset across
	/// frames: two panes sharing an id would share one offset.
	pub id:               ElementId,
	/// The handle the region reports its offset and box through, which is
	/// what says which rows the next frame builds.
	pub columns:          &'a ScrollHandle,
	/// The pinned column, one cell per built row.
	pub gutter:           Div,
	/// The scrolled column, one cell per built row.
	pub code:             Div,
	/// How wide the widest line is.
	pub content_width_px: f32,
	/// The extent of the rows skipped above the built ones and below them.
	pub padding:          (f32, f32),
}

/// One column of a pane: its cells between the padding that stands in for the
/// rows outside the box.
fn column(cells: Div, lead_px: f32, tail_px: f32) -> Div {
	div()
		.flex()
		.flex_col()
		.child(pane_padding(lead_px))
		.child(cells.flex().flex_col())
		.child(pane_padding(tail_px))
}

/// A box of the exact extent of the rows a pane did not build.
///
/// The scroll extent is the sum of the column's children, so padding of the
/// skipped rows' own height leaves the extent, and every offset the wheel can
/// reach, the same as a pane that built the whole file.
fn pane_padding(height_px: f32) -> Div {
	div().h(px(height_px)).flex_shrink_0()
}

/// How wide `columns` monospace cells are at the size the pane's rows are
/// authored at.
pub fn pane_content_px(
	window: &mut Window,
	tokens: &TokenSet,
	geometry: &PanelsSurfaceTokens,
	columns: usize,
) -> f32 {
	mono_advance(window, tokens, &geometry.diff_font_size) * columns as f32
}

/// One cell of a pane column, at the authored row height.
///
/// Every cell of both columns is built here, so a gutter cell and the code
/// beside it cannot disagree about how tall a row is, which is what would show
/// as the numbers drifting out of step with the lines further down a file.
///
/// This is the one place `diff.row_height_px` reaches a box. Stating it here
/// and again as the pane's line height would have left a row standing on
/// whichever of the two a reader deleted, and a shaped line is a little shorter
/// than the rhythm the panel authors, so the rows would have closed up by a
/// couple of pixels each with both still in the file.
pub fn pane_cell(geometry: &PanelsSurfaceTokens) -> Div {
	div()
		.h(px(geometry.diff_row_height_px))
		.flex_shrink_0()
		.flex()
		.flex_row()
		.items_center()
		.whitespace_nowrap()
}
