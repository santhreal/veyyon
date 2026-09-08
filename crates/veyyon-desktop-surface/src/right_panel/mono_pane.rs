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

use unicode_width::UnicodeWidthStr;
use veyyon_desktop_kit::{MonoText, TokenSet, mono_advance};
use veyyon_desktop_tokens::PanelsSurfaceTokens;
use veyyon_gpui::{
	Div, ElementId, InteractiveElement, ParentElement, StatefulInteractiveElement, Styled, Window,
	div, px, relative,
};

/// Composes a mono pane's body from its pinned `gutter` column and its
/// scrolling `code` column.
///
/// `id` names the scroll region, which is what retains the offset across
/// frames: two panes sharing one id would share one offset.
///
/// `content_width_px` is how wide the widest line is. It is stated rather than
/// left to the layout because a column of auto width inside a scroll region
/// resolves to the region's own width: the lines then overflow their boxes,
/// the scroll extent is zero, and the pane reads as clipped with a wheel that
/// does nothing. The region's own width is a floor, so a file of short lines
/// still fills the pane rather than leaving a strip of rail beside the text.
///
/// The wheel is restricted to the axis of the gesture. Without that, GPUI maps
/// a vertical wheel onto the one axis a region scrolls, so every scroll down
/// the file would have slid the code sideways instead.
///
/// The pane states no width of its own: a docked file pane fills the panel,
/// and a split diff draws two panes that each take half of it, so the caller
/// says which.
pub fn pinned_gutter_pane(
	id: impl Into<ElementId>,
	gutter: Div,
	code: Div,
	content_width_px: f32,
	geometry: &PanelsSurfaceTokens,
	tokens: &TokenSet,
) -> Div {
	div()
		.flex()
		.flex_row()
		.items_start()
		.mono_type(tokens, &geometry.diff_font_size)
		.child(gutter.flex_shrink_0().flex().flex_col())
		.child(
			div()
				.id(id)
				.flex_1()
				.min_w_0()
				.overflow_x_scroll()
				.restrict_scroll_to_axis()
				.child(
					code
						.flex_none()
						.w(px(content_width_px))
						.min_w(relative(1.0))
						.flex()
						.flex_col(),
				),
		)
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

/// How many monospace cells `text` occupies.
///
/// Counted as a terminal counts them: a double-width glyph takes two, so a line
/// of CJK is twice the cells of its character count and a pane that measured
/// characters would stop halfway along it.
pub fn columns(text: &str) -> usize {
	UnicodeWidthStr::width(text)
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
