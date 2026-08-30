//! The pieces every surface is built from.
//!
//! A row, a chip, a button, a hairline, an icon glyph. They are functions
//! returning elements rather than components with state, because none of them
//! has any: what they look like is a function of the store and the motion
//! registry, both of which the caller already holds.
//!
//! The window has no icon font and no SVG set. Glyphs are single characters
//! from the text font, chosen for being present in every family the app
//! resolves to, so a missing font is a differently shaped triangle rather than
//! a row of empty boxes.

use gpui::{Div, Hsla, SharedString, Stateful, Styled, div, prelude::*, px};

use crate::{
	motion::{self, Key, Motion},
	theme::{Theme, radius, size, space},
};

/// Glyphs, by what they mean rather than what they look like.
pub mod glyph {
	/// A group that is open.
	pub const OPEN: &str = "\u{25be}";
	/// A group that is folded.
	pub const FOLDED: &str = "\u{25b8}";
	/// A running session.
	pub const WORKING: &str = "\u{25cf}";
	/// A session that wants an answer.
	pub const WAITING: &str = "\u{25c6}";
	/// A session that broke.
	pub const FAILED: &str = "\u{2715}";
	/// A finished session.
	pub const DONE: &str = "\u{2713}";
	/// A new session.
	pub const NEW: &str = "+";
	/// Send.
	pub const SEND: &str = "\u{2191}";
	/// Stop.
	pub const STOP: &str = "\u{25a0}";
	/// A tool call.
	pub const TOOL: &str = "\u{2699}";
	/// Close.
	pub const CLOSE: &str = "\u{00d7}";
	/// Settings.
	pub const SETTINGS: &str = "\u{2699}";
	/// The search field in the palette.
	pub const SEARCH: &str = "\u{2315}";
}

/// A horizontal hairline, for the edge between two regions.
pub fn hairline(theme: &Theme) -> Div {
	div().h(px(1.0)).w_full().bg(theme.stroke)
}

/// A vertical hairline.
pub fn hairline_v(theme: &Theme) -> Div {
	div().w(px(1.0)).h_full().bg(theme.stroke)
}

/// Small upper-case text: a group header, a column label.
pub fn eyebrow(text: impl Into<SharedString>, theme: &Theme) -> Div {
	div()
		.text_size(px(size::MICRO))
		.font_weight(gpui::FontWeight::SEMIBOLD)
		.text_color(theme.text_faint)
		.child(text.into().to_uppercase())
}

/// A pill carrying a word: a model name, a branch, an activity.
pub fn chip(text: impl Into<SharedString>, color: Hsla, theme: &Theme) -> Div {
	div()
		.flex()
		.items_center()
		.h(px(18.0))
		.px(px(space::SNUG))
		.rounded(px(radius::CHIP))
		.bg(theme.wash(color))
		.border_1()
		.border_color(theme.edge(color))
		.text_size(px(size::MICRO))
		.text_color(color)
		.child(text.into())
}

/// A chip with no fill, for a word that should not shout.
pub fn tag(text: impl Into<SharedString>, theme: &Theme) -> Div {
	div()
		.flex()
		.items_center()
		.h(px(18.0))
		.px(px(space::SNUG))
		.rounded(px(radius::CHIP))
		.bg(theme.sunken)
		.text_size(px(size::MICRO))
		.text_color(theme.text_muted)
		.child(text.into())
}

/// The ground a hoverable surface takes this frame, blended rather than
/// snapped.
///
/// gpui's own `.hover()` applies its style the frame the pointer arrives, which
/// is a step change; every other application on the machine fades it over
/// 150ms. The caller pairs this with [`hover_listener`] on the same key.
pub fn wash(motion: &mut Motion, key: Key, rest: Hsla, hovered: Hsla, now: u64) -> Hsla {
	motion::mix(rest, hovered, motion.value(key, now))
}

/// A square control: the caption buttons, a tab's close, the send button.
///
/// `id` is the element id gpui needs for a click target, and the same string is
/// the motion key for its hover wash.
pub fn button(id: &'static str, glyph: &'static str, theme: &Theme, ground: Hsla) -> Stateful<Div> {
	div()
		.id(id)
		.flex()
		.items_center()
		.justify_center()
		.size(px(24.0))
		.rounded(px(radius::CHIP))
		.bg(ground)
		.text_size(px(size::SMALL))
		.text_color(theme.text_muted)
		.cursor_pointer()
		.child(glyph)
}

/// Text truncated to one line with an ellipsis.
pub fn line(text: impl Into<SharedString>) -> Div {
	div()
		.overflow_hidden()
		.text_ellipsis()
		.whitespace_nowrap()
		.child(text.into())
}

/// A run of children with a gap.
pub fn line_of(gap: f32) -> Div {
	div().flex().items_center().gap(px(gap))
}

/// Space that pushes what follows to the far edge.
pub fn spacer() -> Div {
	div().flex_1()
}
