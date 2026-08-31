//! Reusable task and phase presentation pieces.

use gpui::{App, Div, ParentElement, SharedString, Styled, div, px};
use veyyon_gui_kit::{
	theme::{Theme, size, space, weight},
	ui::{Badge, Card, Icon, Meter, Tone, icon, text},
};

pub fn phase_summary(
	title: impl Into<SharedString>,
	state: impl Into<SharedString>,
	tone: Tone,
	completed: usize,
	total: usize,
	cx: &mut App,
) -> Card {
	let theme = Theme::get(cx);
	let progress = if total == 0 {
		None
	} else {
		Some(completed as f32 / total as f32)
	};
	let mut card = Card::new().child(
		text::line_of(space::SNUG)
			.w_full()
			.min_w(px(0.0))
			.child(icon::at(Icon::Engine, icon::scale::small(), tone.ink(&theme)))
			.child(
				text::line(title)
					.flex_1()
					.min_w(px(0.0))
					.text_size(px(size::body()))
					.font_weight(weight::MEDIUM)
					.text_color(theme.text),
			)
			.child(Badge::new(state).tone(tone)),
	);
	if let Some(progress) = progress {
		card = card.child(
			Meter::new(progress)
				.figure(format!("{completed} / {total}"))
				.bare(),
		);
	}
	card
}

pub fn relation(
	label: impl Into<SharedString>,
	value: impl Into<SharedString>,
	cx: &mut App,
) -> Div {
	let theme = Theme::get(cx);
	div()
		.flex()
		.items_baseline()
		.gap(px(space::SNUG))
		.min_w(px(0.0))
		.child(
			text::line(label)
				.flex_none()
				.text_size(px(size::meta()))
				.text_color(theme.text_faint),
		)
		.child(
			text::line(value)
				.min_w(px(0.0))
				.text_size(px(size::meta()))
				.text_color(theme.text_muted),
		)
}
