//! Text bound to a role and a size.
//!
//! The counterpart to [`crate::surface`]: no component sets a text colour from
//! a literal, and the size comes from the scale rather than a number at the
//! call site.

use gpui::{App, Div, IntoElement, ParentElement, Pixels, SharedString, Styled, div};
use veyyon_gui_theme::Role;

use crate::{fonts::ActiveTypography, theme::ActiveTheme, tokens::text};

/// Text in a role, at a size.
pub fn text_in(content: impl Into<SharedString>, role: Role, size: Pixels, cx: &App) -> Div {
	div()
		.text_color(cx.color(role))
		.text_size(size)
		.child(content.into())
}

/// Transcript body text.
pub fn body(content: impl Into<SharedString>, cx: &App) -> Div {
	text_in(content, Role::TextPrimary, text::BODY, cx)
}

/// A label beside a value: a field name, a status segment's caption.
pub fn label(content: impl Into<SharedString>, cx: &App) -> Div {
	text_in(content, Role::TextSecondary, text::SMALL, cx)
}

/// Text that is present but not being read: a timestamp, a byte count.
pub fn caption(content: impl Into<SharedString>, cx: &App) -> Div {
	text_in(content, Role::TextMuted, text::MICRO, cx)
}

/// A dialog or section title.
pub fn title(content: impl Into<SharedString>, cx: &App) -> Div {
	text_in(content, Role::TextPrimary, text::TITLE, cx)
}

/// Code, a path, a command: anything whose alignment carries meaning.
///
/// The family comes from the window's monospace setting rather than being named
/// here, so a font change is one setting and not a search for every code span.
pub fn mono(content: impl Into<SharedString>, role: Role, cx: &App) -> Div {
	div()
		.font_family(cx.mono_family())
		.text_color(cx.color(role))
		.text_size(text::BODY)
		.child(content.into())
}

/// Wrap a child in nothing but a colour and a size. For a subtree that is
/// already elements.
pub fn styled_as(child: impl IntoElement, role: Role, size: Pixels, cx: &App) -> Div {
	div()
		.text_color(cx.color(role))
		.text_size(size)
		.child(child)
}
