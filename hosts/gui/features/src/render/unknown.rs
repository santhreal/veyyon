//! Forward-compatible unknown entry and content rendering.

use gpui::{App, Div, ParentElement, Styled, px};
use veyyon_gui_core::model::Value;
use veyyon_gui_kit::{
	theme::space,
	ui::{Badge, Icon, Tone, text},
};

use super::generic_json;

pub fn unknown(id: &str, tag: &str, value: &Value, cx: &mut App) -> Div {
	let label = if tag.trim().is_empty() {
		"Unknown entry".to_owned()
	} else {
		format!("Unknown · {tag}")
	};
	text::stack(space::TIGHT)
		.w_full()
		.min_w(px(0.0))
		.child(Badge::new(label).tone(Tone::Warn).icon(Icon::Notice))
		.child(generic_json::detail(&format!("{id}-unknown"), value, cx))
}
