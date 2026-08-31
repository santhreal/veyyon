//! Notices, retry, interruption, and compaction lifecycle entries.

use gpui::{App, Div, ParentElement, Styled, px};
use veyyon_gui_core::model::Value;
use veyyon_gui_kit::{
	theme::space,
	ui::{Badge, Icon, Tone, text},
};

use super::generic_json;

pub fn phase(phase: &str, reason: Option<&str>) -> Div {
	let normalized = phase.to_ascii_lowercase();
	let tone = if normalized.contains("error") || normalized.contains("fatal") {
		Tone::Danger
	} else if normalized.contains("retry") || normalized.contains("interrupt") {
		Tone::Warn
	} else {
		Tone::Muted
	};
	let mut row = text::stack(space::TIGHT)
		.w_full()
		.min_w(px(0.0))
		.child(Badge::new(phase.to_owned()).tone(tone).icon(Icon::Notice));
	if let Some(reason) = reason.filter(|reason| !reason.trim().is_empty()) {
		row = row.child(Badge::new(reason.to_owned()).tone(tone));
	}
	row
}

pub fn lifecycle(id: &str, discriminator: &str, raw: &Value, cx: &mut App) -> Div {
	let normalized = discriminator.to_ascii_lowercase();
	let (label, tone, icon) = if normalized.contains("retry") {
		("Retry", Tone::Warn, Icon::Running)
	} else if normalized.contains("compact") {
		("Compaction", Tone::Muted, Icon::Changed)
	} else if normalized.contains("error") || normalized.contains("fatal") {
		("Unavailable", Tone::Danger, Icon::Failed)
	} else if normalized.contains("interrupt") || normalized.contains("abort") {
		("Interrupted", Tone::Warn, Icon::Stop)
	} else {
		("Notice", Tone::Muted, Icon::Notice)
	};
	text::stack(space::TIGHT)
		.w_full()
		.min_w(px(0.0))
		.child(Badge::new(label).tone(tone).icon(icon))
		.child(generic_json::detail(&format!("{id}-lifecycle"), raw, cx))
}
