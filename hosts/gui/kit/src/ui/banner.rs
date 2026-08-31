//! Something the window has to say, in the place it applies to.
//!
//! An engine that will not attach, a request waiting for an answer, a write
//! that failed. A banner sits inside the surface it is about: under the
//! composer for a send that failed, at the top of a settings page for a value
//! that will not load. It is never a floating toast, because a message that
//! leaves before it is read is a message nobody sent.
//!
//! A banner says what happened and what to do about it. Its tone is the
//! difference between a failure and a question, and both are drawn with a fill
//! rather than a colour of text alone, because a red word on a dark ground is a
//! detail and a failure is not.

use gpui::{
	AnyElement, App, IntoElement, ParentElement, RenderOnce, SharedString, Styled, Window, div, px,
};

use super::{Icon, Tone, card::Card, icon, text};
use crate::theme::{Theme, radius, size, space, weight};

/// A notice about the surface it sits in.
#[derive(IntoElement)]
pub struct Banner {
	tone:    Tone,
	what:    SharedString,
	detail:  Option<SharedString>,
	icon:    Option<Icon>,
	actions: Vec<AnyElement>,
}

impl Banner {
	/// A failure: something did not happen.
	pub fn failure(what: impl Into<SharedString>) -> Banner {
		Banner::new(Tone::Danger, what).icon(Icon::Failed)
	}

	/// A question: something is waiting on an answer.
	pub fn waiting(what: impl Into<SharedString>) -> Banner {
		Banner::new(Tone::Warn, what).icon(Icon::Notice)
	}

	/// A statement of fact the reader needs before acting.
	pub fn notice(what: impl Into<SharedString>) -> Banner {
		Banner::new(Tone::Muted, what).icon(Icon::Notice)
	}

	pub fn new(tone: Tone, what: impl Into<SharedString>) -> Banner {
		Banner { tone, what: what.into(), detail: None, icon: None, actions: Vec::new() }
	}

	/// The part a reader needs only if they are going to fix it: an error from
	/// the engine, a path, an exit status.
	pub fn detail(mut self, detail: impl Into<SharedString>) -> Banner {
		self.detail = Some(detail.into());
		self
	}

	pub fn icon(mut self, icon: Icon) -> Banner {
		self.icon = Some(icon);
		self
	}
}

/// The actions, at the far end: retry, allow, dismiss.
impl ParentElement for Banner {
	fn extend(&mut self, elements: impl IntoIterator<Item = AnyElement>) {
		self.actions.extend(elements);
	}
}

impl RenderOnce for Banner {
	fn render(self, _window: &mut Window, cx: &mut App) -> impl IntoElement {
		let theme = Theme::get(cx);
		let ink = self.tone.ink(&theme);

		Card::new()
			.tone(self.tone)
			.radius(radius::ROW)
			.pad(space::BASE)
			.gap(space::SNUG)
			.full_width()
			.child(
				text::line_of(space::BASE)
					.items_start()
					.child(div().flex().flex_none().mt(px(1.0)).child(icon::at(
						self.icon.unwrap_or(Icon::Notice),
						icon::scale::SMALL + 1.0,
						ink,
					)))
					.child(
						text::stack(space::TIGHT - 1.0)
							// The words shrink and the actions do not. A path or
							// an exit status arrives as one unbroken run, whose
							// automatic minimum would otherwise push retry and
							// dismiss out through the edge of the card.
							.flex_1()
							.min_w(px(0.0))
							.overflow_hidden()
							.child(
								div()
									.text_size(px(size::BODY))
									.font_weight(weight::MEDIUM)
									.line_height(px(size::BODY * size::LINE_TIGHT))
									.text_color(theme.text)
									.child(self.what),
							)
							.children(self.detail.map(|detail| {
								div()
									.font_family(theme.font_mono)
									.text_size(px(size::SMALL))
									.line_height(px(size::SMALL * size::LINE_CODE))
									.text_color(theme.text_muted)
									.child(detail)
							})),
					)
					.children((!self.actions.is_empty()).then(|| {
						text::line_of(space::TIGHT)
							.flex_none()
							.children(self.actions)
					})),
			)
	}
}
