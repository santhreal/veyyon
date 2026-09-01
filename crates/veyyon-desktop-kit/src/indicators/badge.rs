//! Badge status chip primitive with tint roles (§8.25).

use veyyon_gpui::{App, IntoElement, RenderOnce, SharedString, Window, div, prelude::*};

use crate::{
	state::BadgeVariant,
	token_set::{RadiusStep, SpacingStep, TextRamp, TintRole, TokenSet},
};

/// Status chip badge indicator with semantic tint styling.
#[derive(IntoElement)]
pub struct Badge {
	label:   SharedString,
	tint:    TintRole,
	variant: BadgeVariant,
}

impl Badge {
	/// Creates a solid badge with label and semantic tint.
	#[must_use]
	pub fn new(label: impl Into<SharedString>, tint: TintRole) -> Self {
		Self { label: label.into(), tint, variant: BadgeVariant::Solid }
	}

	/// Sets visual presentation variant.
	#[must_use]
	pub fn variant(mut self, variant: BadgeVariant) -> Self {
		self.variant = variant;
		self
	}
}

impl RenderOnce for Badge {
	fn render(self, _window: &mut Window, cx: &mut App) -> impl IntoElement {
		let default_tokens = TokenSet::default();
		let tokens = cx.try_global::<TokenSet>().unwrap_or(&default_tokens);
		let tint_pair = tokens.tint(self.tint);

		let (bg, fg, border) = match self.variant {
			BadgeVariant::Solid | BadgeVariant::Default => (tint_pair.fill, tint_pair.ink, None),
			BadgeVariant::Outline => (tokens.transparent(), tint_pair.fill, Some(tint_pair.fill)),
			BadgeVariant::Subtle => (tint_pair.fill, tint_pair.ink, None),
		};

		let radius = tokens.radius(RadiusStep::Sm);
		let pad_x = tokens.spacing(SpacingStep::S2);
		let pad_y = tokens.spacing(SpacingStep::S1);
		let font_size = tokens.font_size(TextRamp::Micro);

		let mut el = div()
			.bg(bg)
			.rounded(radius)
			.px(pad_x)
			.py(pad_y)
			.text_size(font_size)
			.text_color(fg)
			.max_w_full()
			.overflow_hidden()
			.whitespace_nowrap()
			.truncate()
			.child(self.label);

		if let Some(b) = border {
			el = el.border_1().border_color(b);
		}

		el
	}
}
