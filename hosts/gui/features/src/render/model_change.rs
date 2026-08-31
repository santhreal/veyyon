//! Model and thinking-level changes retained as timeline events.

use gpui::{App, Div, ParentElement, Styled, px};
use veyyon_gui_core::model::{ModelId, ProviderId, Value};
use veyyon_gui_kit::{
	theme::space,
	ui::{Badge, Icon, Tone, text},
};

use super::generic_json;

pub fn model(provider: &ProviderId, model: &ModelId) -> Div {
	text::stack(space::TIGHT)
		.w_full()
		.min_w(px(0.0))
		.child(
			Badge::new("Model changed")
				.tone(Tone::Muted)
				.icon(Icon::Engine),
		)
		.child(
			Badge::new(format!("{provider} · {model}"))
				.tone(Tone::Muted)
				.bare(),
		)
}

pub fn thinking_level(level: &str) -> Div {
	text::stack(space::TIGHT)
		.w_full()
		.min_w(px(0.0))
		.child(
			Badge::new("Thinking level changed")
				.tone(Tone::Muted)
				.icon(Icon::Engine),
		)
		.child(Badge::new(level.to_owned()).tone(Tone::Muted).bare())
}

pub fn change(id: &str, discriminator: &str, raw: &Value, cx: &mut App) -> Div {
	let label = if discriminator.contains("thinking") {
		"Thinking level changed"
	} else {
		"Model changed"
	};
	text::stack(space::TIGHT)
		.w_full()
		.min_w(px(0.0))
		.child(Badge::new(label).tone(Tone::Muted).icon(Icon::Engine))
		.child(generic_json::detail(&format!("{id}-change"), raw, cx))
}
