//! Something is running, and nobody knows for how long.
//!
//! The one indicator in the window that repeats. It exists to say that work is
//! in flight when there is no number to show; the moment a count, a token total
//! or a step is available, a [`Meter`](super::Meter) or a
//! [`Badge`](super::Badge) says more and this comes off the screen.
//!
//! It turns on the same clock as every other moving thing, so it does not
//! animate while the window is idle: the frame it stops being drawn, its
//! channel is retired and the window stops asking for frames. Under reduced
//! motion it stands still, which is the honest alternative to spinning.

use gpui::{App, IntoElement, ParentElement, RenderOnce, SharedString, Styled, Window, px};

use super::{Size, Tone, icon, square, text};
use crate::{
	motion::{Channel, Key},
	paint,
	theme::{Theme, space},
};

/// Work in flight.
#[derive(IntoElement)]
pub struct Spinner {
	id:    SharedString,
	what:  Option<SharedString>,
	tone:  Tone,
	size:  Size,
	glyph: icon::Icon,
}

impl Spinner {
	/// `id` addresses the turn, so two indicators on screen keep their own
	/// phase and one that leaves and comes back starts where it should.
	pub fn new(id: impl Into<SharedString>) -> Spinner {
		Spinner {
			id:    id.into(),
			what:  None,
			tone:  Tone::Muted,
			size:  Size::Base,
			glyph: icon::Icon::Running,
		}
	}

	/// What is running, next to the indicator. A spinner with no word says only
	/// that something is happening.
	pub fn what(mut self, what: impl Into<SharedString>) -> Spinner {
		self.what = Some(what.into());
		self
	}

	pub fn tone(mut self, tone: Tone) -> Spinner {
		self.tone = tone;
		self
	}

	pub fn size(mut self, size: Size) -> Spinner {
		self.size = size;
		self
	}

	/// Turn a different glyph: the engine's own mark while it connects.
	pub fn glyph(mut self, glyph: icon::Icon) -> Spinner {
		self.glyph = glyph;
		self
	}
}

impl RenderOnce for Spinner {
	fn render(self, _window: &mut Window, cx: &mut App) -> impl IntoElement {
		let theme = Theme::get(cx);
		let ink = self.tone.ink(&theme);
		let turns = paint::spinning(cx, Key::named(Channel::Spin, self.id.as_ref()));
		let glyph = self.size.glyph();

		text::line_of(space::SNUG)
			.flex_none()
			.child(square(glyph).child(icon::turning(self.glyph, glyph, ink, turns)))
			.children(self.what.map(|what| {
				text::line(what)
					.text_size(px(self.size.text()))
					.text_color(theme.text_muted)
			}))
	}
}
