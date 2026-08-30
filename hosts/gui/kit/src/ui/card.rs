//! A surface on the canvas.
//!
//! A message, a tool call, a settings group, a proposed plan. What makes it a
//! card is that its ground differs from what it sits on, which is how the
//! window separates regions: a change of ground, not a line.
//!
//! Elevation is a claim about distance. A card on the canvas has almost none, a
//! menu has some, a sheet over the window has the most, and a card that borrows
//! a sheet's shadow reads as floating over nothing.

use gpui::{
	AnyElement, App, Hsla, IntoElement, ParentElement, RenderOnce, Styled, Window, div, px,
};

use super::Tone;
use crate::{
	motion, paint,
	theme::{Theme, radius, space},
};

/// How far off its ground a card sits.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Lift {
	/// Flat: a change of ground and nothing more. Most cards.
	#[default]
	Flat,
	/// A card that can be picked out from the ones around it: a message the
	/// window is drawing attention to.
	Card,
	/// A menu or a popover, close to what it came from.
	Menu,
}

/// A surface holding content.
#[derive(IntoElement)]
pub struct Card {
	children: Vec<AnyElement>,
	ground:   Option<Hsla>,
	tone:     Option<Tone>,
	lift:     Lift,
	pad:      f32,
	gap:      f32,
	radius:   f32,
	stroked:  bool,
	/// The entrance channel this card animates on, if it animates at all.
	arrives:  Option<(motion::Channel, u64)>,
	full:     bool,
	width:    Option<f32>,
	min_w:    Option<f32>,
	max_h:    Option<f32>,
}

impl Card {
	pub fn new() -> Card {
		Card {
			children: Vec::new(),
			ground:   None,
			tone:     None,
			lift:     Lift::Flat,
			pad:      space::WIDE,
			gap:      space::BASE,
			radius:   radius::CARD,
			stroked:  false,
			arrives:  None,
			full:     false,
			width:    None,
			min_w:    None,
			max_h:    None,
		}
	}

	/// A card in a tone: a failed tool call, a banner, an approval. The ground
	/// is the tone at tint weight, which is the only weight a fill can carry
	/// text.
	pub fn tone(mut self, tone: Tone) -> Card {
		self.tone = Some(tone);
		self
	}

	/// A ground the palette names, for the cases a tone does not cover: the
	/// well a code block sits in.
	pub fn ground(mut self, ground: Hsla) -> Card {
		self.ground = Some(ground);
		self
	}

	pub fn lift(mut self, lift: Lift) -> Card {
		self.lift = lift;
		self
	}

	pub fn pad(mut self, pad: f32) -> Card {
		self.pad = pad;
		self
	}

	pub fn gap(mut self, gap: f32) -> Card {
		self.gap = gap;
		self
	}

	pub fn radius(mut self, radius: f32) -> Card {
		self.radius = radius;
		self
	}

	/// A hairline around the edge. For a card whose ground is close to what it
	/// sits on, where the change of ground alone does not read.
	pub fn stroked(mut self) -> Card {
		self.stroked = true;
		self
	}

	pub fn full_width(mut self) -> Card {
		self.full = true;
		self
	}

	/// An exact width. For a card whose width is the layout rather than the
	/// content: a sheet, a picker.
	pub fn width(mut self, width: f32) -> Card {
		self.width = Some(width);
		self
	}

	/// A floor on the width, for a card whose content decides the rest.
	pub fn min_width(mut self, min: f32) -> Card {
		self.min_w = Some(min);
		self
	}

	/// A ceiling on the height, past which the content scrolls.
	pub fn max_height(mut self, max: f32) -> Card {
		self.max_h = Some(max);
		self
	}

	/// Animate the first appearance: rise and fade in, once, addressed by
	/// `channel` and `id` so a card that merely remounts does not replay it.
	pub fn arriving(mut self, channel: motion::Channel, id: u64) -> Card {
		self.arrives = Some((channel, id));
		self
	}
}

impl Default for Card {
	fn default() -> Card {
		Card::new()
	}
}

impl ParentElement for Card {
	fn extend(&mut self, elements: impl IntoIterator<Item = AnyElement>) {
		self.children.extend(elements);
	}
}

impl RenderOnce for Card {
	fn render(self, _window: &mut Window, cx: &mut App) -> impl IntoElement {
		let theme = Theme::get(cx);
		let ground = match (self.ground, self.tone) {
			(Some(ground), _) => ground,
			(None, Some(tone)) => tone.tint(&theme),
			(None, None) => theme.raised,
		};

		let arrival = match self.arrives {
			Some((channel, id)) => paint::arriving(cx, motion::Key::at(channel, id), motion::ENTER),
			None => 1.0,
		};

		let mut card = div()
			.flex()
			.flex_col()
			.gap(px(self.gap))
			.p(px(self.pad))
			.rounded(px(self.radius))
			.bg(ground)
			.children(self.children);

		if self.full {
			card = card.w_full();
		}
		if let Some(width) = self.width {
			card = card.w(px(width));
		}
		if let Some(min) = self.min_w {
			card = card.min_w(px(min));
		}
		if let Some(max) = self.max_h {
			card = card.max_h(px(max));
		}
		if self.stroked {
			card = card.border_1().border_color(theme.stroke);
		}
		card = match self.lift {
			Lift::Flat => card,
			Lift::Card => card.shadow(theme.shadow_card()),
			Lift::Menu => card.shadow(theme.shadow_menu()),
		};
		if arrival < 1.0 {
			// Rise, rather than grow: a card that scales up drags the text
			// inside it through a size it will never be read at.
			card = card
				.relative()
				.top(px(motion::lerp(6.0, 0.0, arrival)))
				.opacity(arrival);
		}
		card
	}
}
