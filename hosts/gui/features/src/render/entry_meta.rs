//! Entry timestamp, copy action, and explicit link actions.

use gpui::{Div, ParentElement, Styled, div, px};
use veyyon_gui_core::{UiCommand, model::EntryId};
use veyyon_gui_kit::{
	theme::{Theme, space},
	ui::{Button, Fill, Icon, Size, Tone, text},
};

use crate::{act, render::identity};

pub fn actions(id: &EntryId, timestamp_ms: u64, links: &[String], theme: &Theme) -> Div {
	let copy_control_id = format!("copy-entry-{id}");
	let mut row = div()
		.flex()
		.flex_wrap()
		.items_center()
		.justify_end()
		.w_full()
		.min_w(px(0.0))
		.gap(px(space::TIGHT))
		.child(text::meta(timestamp(timestamp_ms), theme))
		.child(
			Button::new(copy_control_id.clone(), identity::owner(&copy_control_id), Icon::Copy)
				.tone(Tone::Muted)
				.fill(Fill::Ghost)
				.size(Size::Base)
				.tip("Copy entry")
				.on_click(act::click(UiCommand::CopyEntry(id.clone()))),
		);
	for (index, link) in links.iter().enumerate() {
		let control_id = format!("entry-{id}-link-{index}");
		row = row.child(
			Button::labelled(control_id.clone(), identity::owner(&control_id), "Open link")
				.icon(Icon::Open)
				.tone(Tone::Muted)
				.fill(Fill::Ghost)
				.size(Size::Base)
				.tip(link.clone())
				.on_click(act::click(UiCommand::OpenExternal(link.clone()))),
		);
	}
	row
}

fn timestamp(timestamp_ms: u64) -> String {
	let total_seconds = timestamp_ms / 1_000;
	let seconds = total_seconds % 60;
	let minutes = (total_seconds / 60) % 60;
	let hours = (total_seconds / 3_600) % 24;
	format!("{hours:02}:{minutes:02}:{seconds:02} UTC")
}
