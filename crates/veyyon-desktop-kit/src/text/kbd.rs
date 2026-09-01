//! Keyboard shortcut display chip primitive (§8.25).

use veyyon_gpui::{App, IntoElement, RenderOnce, SharedString, Window, div, prelude::*};

use crate::{
	state::KeyChord,
	token_set::{ColorRole, MonoSizeStep, RadiusStep, SpacingStep, TokenSet},
};

/// Keyboard shortcut indicator element rendering chords and modifier keys.
#[derive(IntoElement)]
pub struct Kbd {
	chords: Vec<KeyChord>,
}

impl Kbd {
	/// Creates a kbd display with a single key chord.
	#[must_use]
	pub fn new(key: impl Into<SharedString>) -> Self {
		Self { chords: vec![KeyChord::key(key)] }
	}

	/// Creates a kbd display with structured key chords.
	#[must_use]
	pub fn chords(chords: impl IntoIterator<Item = KeyChord>) -> Self {
		Self { chords: chords.into_iter().collect() }
	}
}

impl RenderOnce for Kbd {
	fn render(self, _window: &mut Window, cx: &mut App) -> impl IntoElement {
		let default_tokens = TokenSet::default();
		let tokens = cx.try_global::<TokenSet>().unwrap_or(&default_tokens);

		let bg = tokens.color(ColorRole::Inset);
		let border_color = tokens.color(ColorRole::Hairline);
		let text_color = tokens.color(ColorRole::Foreground);
		let radius = tokens.radius(RadiusStep::Xs);
		let font_size = tokens.mono_font_size(MonoSizeStep::Small);
		let pad_x = tokens.spacing(SpacingStep::S2);
		let gap = tokens.spacing(SpacingStep::S1);

		let mut container = div().flex().flex_row().items_center().gap(gap);

		for chord in self.chords {
			for modifier in chord.modifiers() {
				let chip = div()
					.bg(bg)
					.border_1()
					.border_color(border_color)
					.rounded(radius)
					.px(pad_x)
					.font_family(".SystemMonoFont")
					.text_size(font_size)
					.text_color(text_color)
					.child(SharedString::from(modifier));
				container = container.child(chip);
			}

			let key_chip = div()
				.bg(bg)
				.border_1()
				.border_color(border_color)
				.rounded(radius)
				.px(pad_x)
				.font_family(".SystemMonoFont")
				.text_size(font_size)
				.text_color(text_color)
				.child(chord.key);
			container = container.child(key_chip);
		}

		container
	}
}
