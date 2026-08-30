//! Nothing here, and what to do about it.
//!
//! An empty list, a conversation with no messages, a search with no matches.
//! The window has several and they are all this, because the alternative is
//! each surface inventing its own way to say the same thing.
//!
//! Three parts and the middle one is required: a glyph that says which kind of
//! nothing, one line that says what is missing, and at most one action. An
//! empty state with no line is a decorative glyph in the middle of a pane.

use gpui::{
	AnyElement, App, IntoElement, ParentElement, RenderOnce, SharedString, Styled, Window, div, px,
};

use super::{Icon, icon, text};
use crate::theme::{Theme, size, space, weight};

/// What is missing, and what fills it.
#[derive(IntoElement)]
pub struct Empty {
	icon:   Option<Icon>,
	what:   SharedString,
	note:   Option<SharedString>,
	action: Vec<AnyElement>,
	/// Fill the pane and centre in it, rather than sitting where it is placed.
	fills:  bool,
}

impl Empty {
	pub fn new(what: impl Into<SharedString>) -> Empty {
		Empty { icon: None, what: what.into(), note: None, action: Vec::new(), fills: false }
	}

	/// Which kind of nothing: a search with no matches, a list with no rows.
	pub fn icon(mut self, icon: Icon) -> Empty {
		self.icon = Some(icon);
		self
	}

	/// One more line, for a case where what to do next is not obvious from the
	/// action.
	pub fn note(mut self, note: impl Into<SharedString>) -> Empty {
		self.note = Some(note.into());
		self
	}

	/// Centre in the whole pane. For a surface whose entire content is missing.
	pub fn filling(mut self) -> Empty {
		self.fills = true;
		self
	}
}

/// At most one action, which is the thing that fills the emptiness.
impl ParentElement for Empty {
	fn extend(&mut self, elements: impl IntoIterator<Item = AnyElement>) {
		self.action.extend(elements);
	}
}

impl RenderOnce for Empty {
	fn render(self, _window: &mut Window, cx: &mut App) -> impl IntoElement {
		let theme = Theme::get(cx);
		let mut empty = div()
			.flex()
			.flex_col()
			.items_center()
			.justify_center()
			.gap(px(space::SNUG))
			.p(px(space::HUGE))
			.children(self.icon.map(|glyph| {
				div()
					.flex()
					.items_center()
					.justify_center()
					.size(px(38.0))
					.rounded_full()
					.bg(theme.raised)
					.mb(px(space::TIGHT))
					.child(icon::at(glyph, icon::scale::LARGE, theme.text_faint))
			}))
			.child(
				text::line(self.what)
					.text_size(px(size::BODY))
					.font_weight(weight::MEDIUM)
					.text_color(theme.text_muted),
			)
			.children(self.note.map(|note| {
				text::note_wrapping(note, &theme)
					.max_w(px(320.0))
					.text_center()
			}));

		if !self.action.is_empty() {
			empty = empty.child(div().mt(px(space::SNUG)).children(self.action));
		}
		if self.fills {
			empty = empty.size_full();
		}
		empty
	}
}
