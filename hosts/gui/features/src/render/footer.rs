//! Assistant model, provider, stop reason, and usage footer.

use gpui::{App, Div, ParentElement, Styled, div, px};
use veyyon_gui_core::model::EntryMeta;
use veyyon_gui_kit::{
	theme::{Theme, space},
	ui::{Badge, Tone, text},
};

pub fn footer(meta: &EntryMeta, cx: &mut App) -> Div {
	let theme = Theme::get(cx);
	let mut row = div()
		.flex()
		.flex_wrap()
		.items_center()
		.w_full()
		.min_w(px(0.0))
		.gap(px(space::SNUG));
	if let Some(provider) = &meta.provider {
		row = row.child(text::meta(provider.to_string(), &theme));
	}
	if let Some(model) = &meta.model {
		row = row.child(text::meta(model.to_string(), &theme));
	}
	if let Some(usage) = &meta.usage {
		row = row
			.child(
				Badge::new(format!("{} in", usage.input_tokens))
					.tone(Tone::Muted)
					.bare(),
			)
			.child(
				Badge::new(format!("{} out", usage.output_tokens))
					.tone(Tone::Muted)
					.bare(),
			);
		if usage.cache_read_tokens > 0 {
			row = row.child(
				Badge::new(format!("{} cached", usage.cache_read_tokens))
					.tone(Tone::Muted)
					.bare(),
			);
		}
	}
	if let Some(reason) = meta
		.stop_reason
		.as_deref()
		.filter(|reason| !reason.trim().is_empty())
	{
		row = row.child(Badge::new(reason.to_owned()).tone(Tone::Muted).bare());
	}
	if let Some(error) = meta
		.error
		.as_deref()
		.filter(|error| !error.trim().is_empty())
	{
		row = row.child(Badge::new(error.to_owned()).tone(Tone::Danger));
	}
	row
}
