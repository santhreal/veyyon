//! A state, said in one word.
//!
//! Not a button and not a label: a badge is what something is. A tool that
//! failed, a session that is running, a diff's line count, a model's name in
//! the composer. It is never pressable, so a reader who tries to press one has
//! been misled by a badge that should have been a [`Button`](super::Button).
//!
//! The tone carries the meaning and the word repeats it. A badge with a tone
//! and no word is a coloured dot, which says something happened without saying
//! what.

use gpui::{App, IntoElement, ParentElement, RenderOnce, SharedString, Styled, Window, px};

use super::{Fill, Icon, Size, Tone, icon, text};
use crate::theme::{Theme, radius, space, weight};

/// What something is, in a word.
#[derive(IntoElement)]
pub struct Badge {
	what:  SharedString,
	icon:  Option<Icon>,
	tone:  Tone,
	fill:  Fill,
	size:  Size,
	/// Drawn in the monospace family, for a count, a path fragment or a hash.
	exact: bool,
}

impl Badge {
	pub fn new(what: impl Into<SharedString>) -> Badge {
		Badge {
			what:  what.into(),
			icon:  None,
			tone:  Tone::Muted,
			fill:  Fill::Tinted,
			size:  Size::Small,
			exact: false,
		}
	}

	/// A badge with a glyph in front of the word: a tool's kind, an engine's
	/// state.
	pub fn icon(mut self, icon: Icon) -> Badge {
		self.icon = Some(icon);
		self
	}

	pub fn tone(mut self, tone: Tone) -> Badge {
		self.tone = tone;
		self
	}

	/// No fill: a word in its tone, for a badge inside a surface that is
	/// already tinted.
	pub fn bare(mut self) -> Badge {
		self.fill = Fill::Ghost;
		self
	}

	/// Full weight. For the one state a reader must not miss.
	pub fn solid(mut self) -> Badge {
		self.fill = Fill::Solid;
		self
	}

	pub fn size(mut self, size: Size) -> Badge {
		self.size = size;
		self
	}

	/// Numbers and paths, where the characters matter one at a time.
	pub fn exact(mut self) -> Badge {
		self.exact = true;
		self
	}
}

impl RenderOnce for Badge {
	fn render(self, _window: &mut Window, cx: &mut App) -> impl IntoElement {
		let theme = Theme::get(cx);
		let (ground, ink) = match self.fill {
			Fill::Ghost => (gpui::transparent_black(), self.tone.ink(&theme)),
			Fill::Tinted => (self.tone.tint(&theme), self.tone.ink(&theme)),
			Fill::Solid => self.tone.solid(&theme),
		};
		let height = match self.size {
			Size::Small => 19.0,
			Size::Base => 24.0,
		};

		let mut badge = text::line_of(space::TIGHT)
			.flex_none()
			.h(px(height))
			// Padding holds ink off a fill, so a badge with no fill has none: it
			// is a word, and it lines up with the words above and below it
			// rather than sitting a few points inside them.
			.px(px(match (self.fill, self.icon.is_some()) {
				(Fill::Ghost, _) => 0.0,
				(_, true) => space::SNUG,
				(_, false) => space::TIGHT + 1.0,
			}))
			.rounded(px(radius::CHIP))
			.bg(ground)
			.text_size(px(self.size.text() - 0.5))
			.font_weight(weight::MEDIUM)
			.text_color(ink)
			.children(
				self
					.icon
					.map(|glyph| icon::at(glyph, self.size.glyph() - 1.0, ink)),
			);

		if self.exact {
			badge = badge.font_family(theme.font_mono);
		}
		badge.child(text::line(self.what))
	}
}
