//! Type, and the shapes text is arranged in.
//!
//! Six roles, matching the six sizes the token layer names, and each one says
//! what it is for. A surface that needs a seventh is a surface asking for a
//! distinction the window does not make; it says it with weight, colour or
//! space instead.
//!
//! Every run of text that could be longer than its box goes through [`line`],
//! which clips with an ellipsis. A path, a session title and a tool's argument
//! are all arbitrary length, and text that escapes its box is the one rendering
//! defect a reader cannot work around.

use gpui::{Div, SharedString, div, prelude::*, px};

use crate::theme::{Theme, size, weight};

/// Text truncated to one line with an ellipsis.
///
/// The default for anything whose length is not the window's to decide.
pub fn line(text: impl Into<SharedString>) -> Div {
	div()
		.overflow_hidden()
		.text_ellipsis()
		.whitespace_nowrap()
		.child(text.into())
}

/// A run of children laid out along the line, centred against each other.
pub fn line_of(gap: f32) -> Div {
	div().flex().items_center().gap(px(gap))
}

/// A stack of children down the page.
pub fn stack(gap: f32) -> Div {
	div().flex().flex_col().gap(px(gap))
}

/// Space that pushes what follows to the far edge.
pub fn spacer() -> Div {
	div().flex_1().min_w(px(0.0))
}

/// The window's one hairline: chrome against content, and a sheet's edge.
///
/// Every other boundary in the window is a change of ground. A second line
/// anywhere is a line to delete, not a line to match.
pub fn hairline(theme: &Theme) -> Div {
	div().h(px(1.0)).w_full().bg(theme.stroke)
}

/// A vertical hairline, for the one place a column boundary is a line: a
/// gutter inside a well, where both sides share a ground.
pub fn rule(theme: &Theme) -> Div {
	div().w(px(1.0)).h_full().bg(theme.stroke)
}

/// A page's title. One per screen.
pub fn title(text: impl Into<SharedString>, theme: &Theme) -> Div {
	line(text)
		.text_size(px(size::TITLE))
		.font_weight(weight::STRONG)
		.line_height(px(size::TITLE * size::LINE_TIGHT))
		.text_color(theme.text)
}

/// A section heading inside a page, and the name of what is on screen.
pub fn heading(text: impl Into<SharedString>, theme: &Theme) -> Div {
	line(text)
		.text_size(px(size::LEAD))
		.font_weight(weight::MEDIUM)
		.line_height(px(size::LEAD * size::LINE_TIGHT))
		.text_color(theme.text)
}

/// Body text: a message, a row's title, a paragraph.
///
/// Not clipped, because the window decides where a message wraps and a message
/// is allowed to be long.
pub fn body(text: impl Into<SharedString>, theme: &Theme) -> Div {
	div()
		.text_size(px(size::BODY))
		.line_height(px(size::BODY * size::LINE))
		.text_color(theme.text)
		.child(text.into())
}

/// A control's label, or a row's title: body size, carrying a little more
/// weight than what is under it.
pub fn label(text: impl Into<SharedString>, theme: &Theme) -> Div {
	line(text)
		.text_size(px(size::BODY))
		.font_weight(weight::MEDIUM)
		.line_height(px(size::BODY * size::LINE_TIGHT))
		.text_color(theme.text)
}

/// A second line: a row's preview, a setting's description.
pub fn note(text: impl Into<SharedString>, theme: &Theme) -> Div {
	line(text)
		.text_size(px(size::SMALL))
		.line_height(px(size::SMALL * size::LINE))
		.text_color(theme.text_muted)
}

/// The same, allowed to wrap. A setting's description under its label.
pub fn note_wrapping(text: impl Into<SharedString>, theme: &Theme) -> Div {
	div()
		.text_size(px(size::SMALL))
		.line_height(px(size::SMALL * size::LINE))
		.text_color(theme.text_muted)
		.child(text.into())
}

/// A count, a duration, a keystroke: text read only when looked for.
pub fn meta(text: impl Into<SharedString>, theme: &Theme) -> Div {
	line(text)
		.text_size(px(size::META))
		.line_height(px(size::META * size::LINE_TIGHT))
		.text_color(theme.text_faint)
}

/// A path, a hash, an identifier: anything where the characters matter one at a
/// time.
pub fn mono(text: impl Into<SharedString>, theme: &Theme) -> Div {
	line(text)
		.font_family(theme.font_mono)
		.text_size(px(size::SMALL))
		.line_height(px(size::SMALL * size::LINE_CODE))
		.text_color(theme.text_muted)
}

/// A group's name over the rows it holds: the smallest type in the window, in
/// the weight that lets it read at that size.
pub fn overline(text: impl Into<SharedString>, theme: &Theme) -> Div {
	line(text)
		.text_size(px(size::META))
		.font_weight(weight::MEDIUM)
		.line_height(px(size::META * size::LINE_TIGHT))
		.text_color(theme.text_faint)
}
