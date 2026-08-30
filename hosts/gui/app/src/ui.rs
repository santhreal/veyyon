//! The pieces every surface is built from.
//!
//! A row, a button, a hairline, an icon glyph. They are functions
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
	theme::{Theme, radius, size},
};

/// Glyphs, by what they mean rather than what they look like.
pub mod glyph {
	/// A group that is open.
	pub const OPEN: &str = "\u{25be}";
	/// A group that is folded.
	pub const FOLDED: &str = "\u{25b8}";
	/// A new conversation.
	pub const NEW: &str = "+";
	/// Send.
	pub const SEND: &str = "\u{2191}";
	/// Close.
	pub const CLOSE: &str = "\u{00d7}";
	/// Settings.
	pub const SETTINGS: &str = "\u{2699}";
	/// The search field in the palette.
	pub const SEARCH: &str = "\u{2315}";
	/// A setting that is on.
	pub const CHECK: &str = "\u{2713}";
	/// The sidebar, shown or hidden.
	pub const SIDEBAR: &str = "\u{25e7}";
}

/// A horizontal hairline, for the one edge the window still draws as a line.
pub fn hairline(theme: &Theme) -> Div {
	div().h(px(1.0)).w_full().bg(theme.stroke)
}

/// The ground a hoverable surface takes this frame, blended rather than
/// snapped.
///
/// gpui's own `.hover()` applies its style the frame the pointer arrives, which
/// is a step change; every other application on the machine fades it over
/// 150ms. The caller pairs this with [`hover_listener`](crate::motion) on the
/// same key.
pub fn wash(motion: &mut Motion, key: Key, rest: Hsla, hovered: Hsla, now: u64) -> Hsla {
	motion::mix(rest, hovered, motion.value(key, now))
}

/// A round control: a window control, a titlebar action, the send button.
///
/// `id` is the element id gpui needs for a click target, and the same string is
/// the motion key for its hover wash.
pub fn button(id: &'static str, glyph: &'static str, theme: &Theme, ground: Hsla) -> Stateful<Div> {
	div()
		.id(id)
		.flex()
		.items_center()
		.justify_center()
		.size(px(28.0))
		.rounded(px(radius::PILL))
		.bg(ground)
		.text_size(px(size::BODY))
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
