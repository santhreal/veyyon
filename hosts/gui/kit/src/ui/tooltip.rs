//! What a control is for, and how to reach it from the keyboard.
//!
//! A tooltip is the answer to the question an icon raises. Every control drawn
//! as a glyph alone carries one, and it names the action in the same words the
//! command palette uses, so the three ways to reach a thing agree on what it is
//! called.
//!
//! A tooltip that repeats a visible label says nothing. A control with its
//! label on screen carries one only to add its keystroke.

use gpui::{AnyView, App, Context, IntoElement, Render, SharedString, Window, div, prelude::*, px};

use super::{kbd, text};
use crate::theme::{Theme, radius, size, space};

/// A control's name, and the keystroke that reaches it.
pub struct Tip {
	what: SharedString,
	keys: Option<SharedString>,
}

impl Tip {
	/// A tooltip that names an action.
	pub fn view(what: impl Into<SharedString>, cx: &mut App) -> AnyView {
		cx.new(|_| Tip { what: what.into(), keys: None }).into()
	}

	/// A tooltip that names an action and the chord that runs it.
	///
	/// `keys` is a chord in the form the keys table writes them
	/// (`primary-shift-p`); [`kbd`] spells it for the platform.
	pub fn keyed(
		what: impl Into<SharedString>,
		keys: impl Into<SharedString>,
		cx: &mut App,
	) -> AnyView {
		cx.new(|_| Tip { what: what.into(), keys: Some(keys.into()) })
			.into()
	}
}

impl Render for Tip {
	fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
		let theme = Theme::get(cx);
		// A tooltip is offset from the pointer by gpui, so this wrapper only
		// carries the gap that keeps the card off the control it describes.
		div().pt(px(space::SNUG)).child(
			text::line_of(space::SNUG)
				.px(px(space::BASE))
				.py(px(space::TIGHT + 1.0))
				.rounded(px(radius::CONTROL))
				.bg(theme.overlay)
				.border_1()
				.border_color(theme.stroke)
				.shadow(theme.shadow_menu())
				.text_size(px(size::meta()))
				.text_color(theme.text)
				.child(text::line(self.what.clone()))
				.children(self.keys.clone().map(|keys| kbd::caps(&keys, &theme))),
		)
	}
}
