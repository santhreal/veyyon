//! A number as a length.
//!
//! The context window a conversation has used, a download, a rate limit. A
//! meter is for a fraction with a known ceiling; work with no ceiling is a
//! [`Spinner`](super::Spinner), and a fraction that never changes is a
//! [`Badge`](super::Badge).
//!
//! THE NUMBER IS PART OF THE METER. A bar alone answers "roughly how full" and
//! nothing else, and every question a reader actually has ("how many left",
//! "will this fit") needs the figure. The caller supplies the words, because
//! only the caller knows whether they are tokens, bytes or requests.
//!
//! The tone changes as it fills, because a meter's job is to be noticed before
//! it is full, not when it is.

use gpui::{App, IntoElement, ParentElement, RenderOnce, SharedString, Styled, Window, div, px};

use super::{Tone, text};
use crate::theme::{Theme, radius, space};

/// How full something is.
#[derive(IntoElement)]
pub struct Meter {
	/// 0 to 1. Clamped, because a fraction over one is a bar drawn outside its
	/// track.
	filled: f32,
	what:   Option<SharedString>,
	figure: Option<SharedString>,
	tone:   Option<Tone>,
	/// The bar alone, for a meter inside a row that has its own labels.
	bare:   bool,
	height: f32,
}

impl Meter {
	pub fn new(filled: f32) -> Meter {
		Meter {
			filled: filled.clamp(0.0, 1.0),
			what:   None,
			figure: None,
			tone:   None,
			bare:   false,
			height: 5.0,
		}
	}

	/// What is being measured, at the left of the label line.
	pub fn what(mut self, what: impl Into<SharedString>) -> Meter {
		self.what = Some(what.into());
		self
	}

	/// The figure, at the right: the caller's own words for the number.
	pub fn figure(mut self, figure: impl Into<SharedString>) -> Meter {
		self.figure = Some(figure.into());
		self
	}

	/// Force a tone rather than taking the one the fraction implies.
	pub fn tone(mut self, tone: Tone) -> Meter {
		self.tone = Some(tone);
		self
	}

	/// The bar with no label line.
	pub fn bare(mut self) -> Meter {
		self.bare = true;
		self
	}

	pub fn height(mut self, height: f32) -> Meter {
		self.height = height;
		self
	}

	/// The tone a fraction implies: quiet until most of it is gone, a warning
	/// while there is still room to act, a failure when there is not.
	fn implied(&self) -> Tone {
		match self.filled {
			filled if filled >= 0.95 => Tone::Danger,
			filled if filled >= 0.80 => Tone::Warn,
			_ => Tone::Accent,
		}
	}
}

impl RenderOnce for Meter {
	fn render(self, _window: &mut Window, cx: &mut App) -> impl IntoElement {
		let theme = Theme::get(cx);
		let tone = self.tone.unwrap_or_else(|| self.implied());
		let ink = tone.ink(&theme);

		let bar = div()
			.w_full()
			.h(px(self.height))
			.rounded(px(radius::PILL))
			.bg(theme.sunken)
			// Zero is an empty track: a sliver of fill at nothing used says the
			// opposite of what the number does. Above zero the fill is at least
			// as wide as the bar is thick, so a hundredth is a dot rather than a
			// hairline that reads as a rendering fault.
			.children((self.filled > 0.0).then(|| {
				div()
					.h_full()
					.w(gpui::relative(self.filled))
					.min_w(px(self.height))
					.rounded(px(radius::PILL))
					.bg(ink)
			}));

		if self.bare {
			return bar;
		}

		text::stack(space::TIGHT)
			.w_full()
			.child(
				text::line_of(space::SNUG)
					.children(self.what.map(|what| text::meta(what, &theme).flex_1()))
					.children(
						self
							.figure
							.map(|figure| text::meta(figure, &theme).flex_none().text_color(ink)),
					),
			)
			.child(bar)
	}
}
