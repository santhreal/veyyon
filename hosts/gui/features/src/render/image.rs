//! Inline image content with decoding cached by the timeline boundary.

use std::sync::Arc;

use gpui::{
	AnyElement, App, Div, Image, ImageFormat, IntoElement, ObjectFit, ParentElement, Styled,
	StyledImage, div, img, px,
};
use veyyon_gui_core::{UiCommand, model::EntryId};
use veyyon_gui_kit::{
	theme::{Theme, layout, radius, space},
	ui::{Button, Fill, Icon, Size, Tone, icon, square, text},
};

use crate::{act, render::identity};

/// Detect common inline image formats without trusting a file extension.
pub fn detect_media_type(bytes: &[u8]) -> Option<&'static str> {
	if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
		Some("image/png")
	} else if bytes.starts_with(&[0xff, 0xd8, 0xff]) {
		Some("image/jpeg")
	} else if bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP") {
		Some("image/webp")
	} else if bytes.starts_with(b"BM") {
		Some("image/bmp")
	} else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
		Some("image/gif")
	} else {
		None
	}
}

/// Decode once when an entry revision changes. Animated GIFs remain explicit
/// metadata so the transcript does not start a repeating idle clock.
pub fn decode(media_type: &str, bytes: &[u8]) -> Option<Arc<Image>> {
	let format = match media_type {
		"image/png" => ImageFormat::Png,
		"image/jpeg" | "image/jpg" => ImageFormat::Jpeg,
		"image/webp" => ImageFormat::Webp,
		"image/bmp" => ImageFormat::Bmp,
		"image/tiff" => ImageFormat::Tiff,
		"image/x-icon" | "image/vnd.microsoft.icon" => ImageFormat::Ico,
		"image/svg+xml" => ImageFormat::Svg,
		_ => return None,
	};
	Some(Arc::new(Image::from_bytes(format, bytes.to_vec())))
}

pub fn image(
	entry: &EntryId,
	index: usize,
	media_type: &str,
	byte_count: usize,
	alt: Option<&str>,
	decoded: Option<Arc<Image>>,
	cx: &mut App,
) -> Div {
	let theme = Theme::get(cx);
	let content: AnyElement = match decoded {
		Some(image) => {
			let fallback_media = media_type.to_owned();
			let fallback_alt = alt.map(str::to_owned);
			img(image)
				.w_full()
				.max_w(px(layout::measure()))
				.max_h(px(layout::measure()))
				.rounded(px(radius::ROW))
				.object_fit(ObjectFit::Contain)
				.with_fallback(move || {
					fallback(&fallback_media, byte_count, fallback_alt.as_deref(), &theme)
						.into_any_element()
				})
				.into_any_element()
		},
		None => fallback(media_type, byte_count, alt, &theme).into_any_element(),
	};
	let mut root = div()
		.w_full()
		.min_w(px(0.0))
		.overflow_hidden()
		.child(content);
	if byte_count > 0 {
		let control_id = format!("open-image-{entry}-{index}");
		root = root.child(
			Button::labelled(control_id.clone(), identity::owner(&control_id), "Open image")
				.tone(Tone::Muted)
				.fill(Fill::Ghost)
				.size(Size::Base)
				.tip("Open image")
				.on_click(act::click(UiCommand::OpenImage { entry: entry.clone(), index })),
		);
	}
	root
}

fn fallback(media_type: &str, byte_count: usize, alt: Option<&str>, theme: &Theme) -> Div {
	let title = alt
		.filter(|value| !value.trim().is_empty())
		.unwrap_or("Image preview unavailable");
	div()
		.flex()
		.items_center()
		.w_full()
		.min_w(px(0.0))
		.gap(px(space::BASE))
		.child(square(icon::scale::base()).child(icon::base(Icon::Attachment, theme.text_faint)))
		.px(px(space::BASE))
		.py(px(space::SNUG))
		.rounded(px(radius::ROW))
		.bg(theme.chrome)
		.border_1()
		.border_color(theme.stroke)
		.child(
			div()
				.flex_1()
				.min_w(px(0.0))
				.child(text::line(title).text_color(theme.text))
				.child(text::meta(format!("{media_type} · {byte_count} bytes"), theme)),
		)
}
