//! Custom, extension, and hook entries retain producer identity and raw data.

use gpui::{App, Div, ParentElement, Styled, px};
use veyyon_gui_core::model::Value;
use veyyon_gui_kit::{
	theme::space,
	ui::{Badge, Icon, Tone, text},
};

use super::generic_json;

pub fn custom(id: &str, discriminator: &str, raw: &Value, cx: &mut App) -> Div {
	text::stack(space::TIGHT)
		.w_full()
		.min_w(px(0.0))
		.child(
			Badge::new(if discriminator.trim().is_empty() {
				"Custom entry"
			} else {
				discriminator
			})
			.tone(Tone::Muted)
			.icon(Icon::Tool),
		)
		.child(generic_json::detail(&format!("{id}-custom"), raw, cx))
}
