//! A fenced block.
//!
//! A well set into whatever it sits in, with the language named once above it
//! and the body lexed. The lexer is in core and returns byte ranges into the
//! exact string it was handed, so the body is one text element with styled runs
//! rather than one element per token: a hundred elements per block is what
//! makes a long transcript stutter, and a single run also wraps and selects as
//! one piece of text.
//!
//! A block carries the one thing a reader wants from code on a screen: a way to
//! take it. The clipboard is not the store, so copying is not a command; it is
//! this control, here, beside the text it copies.

use gpui::{
	App, ClipboardItem, Div, HighlightStyle, ParentElement, Styled, StyledText, Window, div, px,
};
use veyyon_gui_core::text::syntax;
use veyyon_gui_kit::{
	theme::{Theme, size, space},
	ui::{Button, Fill, Icon, Size, Tone, card, text},
};

/// One fenced block: the language, the way to take it, and the body.
pub fn well(id: &str, lang: &str, body: &str, cx: &mut App) -> Div {
	let theme = Theme::get(cx);
	let copy = body.to_owned();
	let named = !lang.is_empty();

	card::well(&theme)
		.w_full()
		.child(
			div()
				.flex()
				.items_center()
				.h(px(26.0))
				.w_full()
				.pl(px(space::BASE))
				.pr(px(space::TIGHT))
				.child(if named {
					text::meta(lang.to_owned(), &theme)
				} else {
					// An unnamed fence still gets the row, so a block with a
					// language and one without are the same height and the
					// copy control is in the same place.
					div()
				})
				.child(text::spacer())
				.child(
					Button::new(format!("copy-{id}"), Icon::Copy)
						.tone(Tone::Muted)
						.fill(Fill::Ghost)
						.size(Size::Small)
						.tip("Copy this block")
						.on_click(move |_, _window: &mut Window, cx: &mut App| {
							cx.write_to_clipboard(ClipboardItem::new_string(copy.clone()));
						}),
				),
		)
		.child(
			div()
				.w_full()
				.px(px(space::BASE))
				.pb(px(space::BASE))
				.child(lexed(lang, body, &theme)),
		)
}

/// The body, lexed, as one text element with styled runs.
pub fn lexed(lang: &str, body: &str, theme: &Theme) -> Div {
	let runs: Vec<(std::ops::Range<usize>, HighlightStyle)> = syntax::spans(lang, body)
		.into_iter()
		.map(|(range, token)| {
			(range, HighlightStyle { color: Some(theme.syntax.of(token)), ..Default::default() })
		})
		.collect();

	div()
		.w_full()
		.font_family(theme.font_mono)
		.text_size(px(size::SMALL))
		.line_height(px(size::SMALL * size::LINE_CODE))
		.text_color(theme.text)
		.child(StyledText::new(body.to_owned()).with_highlights(runs))
}

/// The style one run of code takes inside a line of prose.
///
/// A tint rather than a well: inline code sits on a line of text, and a block
/// with its own ground would change that line's height. The words keep the
/// colour of the prose around them, because the accent is what a link is, and
/// a span that is coloured like a link and is not one is a span somebody tries
/// to press.
pub fn inline(theme: &Theme) -> HighlightStyle {
	HighlightStyle { background_color: Some(theme.text.opacity(0.08)), ..Default::default() }
}
