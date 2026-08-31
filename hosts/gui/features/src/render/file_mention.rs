//! File mentions with truthful availability metadata.

use std::sync::Arc;

use gpui::{App, Div, Image, InteractiveElement, ParentElement, ScrollHandle, Styled, div, px};
use veyyon_gui_core::{UiCommand, model::EntryId};
use veyyon_gui_kit::{
	theme::{Elevation, Theme, radius, space},
	ui::{Badge, Button, Fill, Icon, Scrolls, Size, Tone, text},
};

use super::{identity, image};
use crate::act;

pub struct FileMention<'a> {
	pub entry:              &'a EntryId,
	pub index:              usize,
	pub path:               &'a str,
	pub has_content:        bool,
	pub lines:              Option<u64>,
	pub bytes:              Option<u64>,
	pub unavailable_reason: Option<&'a str>,
	pub image_bytes:        Option<&'a [u8]>,
	pub decoded_image:      Option<Arc<Image>>,
}

pub fn mention(value: FileMention<'_>, cx: &mut App) -> Div {
	let theme = Theme::get(cx);
	let mut metadata = Vec::new();
	if let Some(lines) = value.lines {
		metadata.push(format!("{lines} lines"));
	}
	if let Some(bytes) = value.bytes {
		metadata.push(format!("{bytes} bytes"));
	}
	if value.has_content {
		metadata.push("content read by host".to_owned());
	}

	let path = value.path.to_owned();
	let control_id = format!("open-file-{}", value.path);
	let scroll = ScrollHandle::new();
	let mut card = div()
		.w_full()
		.min_w(px(0.0))
		.overflow_hidden()
		.rounded(px(radius::ROW))
		.bg(theme.chrome)
		.border_1()
		.border_color(theme.stroke)
		.px(px(space::BASE))
		.py(px(space::SNUG))
		.child(
			div()
				.flex()
				.items_center()
				.w_full()
				.min_w(px(0.0))
				.gap(px(space::SNUG))
				.child(
					text::mono(value.path.to_owned(), &theme)
						.flex_1()
						.min_w(px(0.0))
						.id(format!("render-file_mention-scroll-{}", value.path))
						.whitespace_nowrap()
						.scrolls_x(&scroll, Elevation::Chrome),
				)
				.child(
					Button::labelled(control_id.clone(), identity::owner(&control_id), "Open")
						.icon(Icon::Read)
						.fill(Fill::Ghost)
						.size(Size::Base)
						.tip("Open file")
						.on_click(act::click(UiCommand::OpenExternal(path))),
				),
		);
	if !metadata.is_empty() {
		card = card.child(text::meta(metadata.join(" · "), &theme));
	}
	if let Some(reason) = value
		.unavailable_reason
		.filter(|reason| !reason.trim().is_empty())
	{
		card = card.child(Badge::new(reason.to_owned()).tone(Tone::Warn));
	}
	if let Some(bytes) = value.image_bytes {
		let media_type = image::detect_media_type(bytes).unwrap_or("image/unknown");
		card = card.child(image::image(
			value.entry,
			value.index,
			media_type,
			bytes.len(),
			Some(value.path),
			value.decoded_image,
			cx,
		));
	}
	card
}
