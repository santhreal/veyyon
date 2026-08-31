//! A cached, truthful transcript image viewer.

use std::sync::Arc;

use gpui::{
	AnyElement, App, Image, ImageFormat, IntoElement, ObjectFit, ParentElement, Styled, StyledImage,
	div, img, px,
};
use veyyon_gui_core::{
	Store, UiCommand,
	model::{ContentBlock, EntryId, RemoteData},
};
use veyyon_gui_kit::{
	theme::{Theme, layout, space},
	ui::{Banner, Button, Empty, Icon, Sheet, Spinner, text},
};

use super::state::owner_of;
use crate::act;

#[derive(Default)]
pub struct ImageViewerHandle {
	key:   Option<(EntryId, u64, usize)>,
	image: Option<Arc<Image>>,
	alt:   Option<String>,
	error: Option<String>,
}

impl ImageViewerHandle {
	pub fn sync(&mut self, store: &Store, entry_id: &EntryId, index: usize) {
		let Some(transcript) = store.replica.transcript.readable() else {
			self.clear();
			return;
		};
		let Some(entry) = transcript.value.iter().find(|entry| &entry.id == entry_id) else {
			self.clear_with("The image entry is no longer available");
			return;
		};
		let key = (entry.id.clone(), entry.revision, index);
		if self.key.as_ref() == Some(&key) {
			return;
		}
		let Some(block) = entry.content.get(index) else {
			self.clear_with("The selected image is no longer available");
			return;
		};
		let ContentBlock::Image { media_type, data, alt } = block else {
			self.clear_with("The selected content is not an image");
			return;
		};
		let Some(format) = image_format(media_type) else {
			self.clear_with("This image format is unavailable");
			return;
		};
		self.key = Some(key);
		self.image = Some(Arc::new(Image::from_bytes(format, data.clone())));
		self.alt = alt.clone();
		self.error = None;
	}

	fn clear(&mut self) {
		self.key = None;
		self.image = None;
		self.alt = None;
		self.error = None;
	}

	fn clear_with(&mut self, message: &str) {
		self.clear();
		self.error = Some(message.to_owned());
	}
}

pub fn render(
	store: &Store,
	entry: &EntryId,
	index: usize,
	handle: &mut ImageViewerHandle,
	open: bool,
	cx: &mut App,
) -> AnyElement {
	handle.sync(store, entry, index);
	let theme = Theme::get(cx);
	let sheet_owner = owner_of(&format!("image-viewer:{entry}:{index}"));
	let close_owner = owner_of(&format!("image-viewer:{entry}:{index}:close"));
	// A preferred height rather than a floor: the sheet gives a fitted child the
	// height the title row leaves, and a floor taller than that is clipped,
	// which takes the bottom off the image at the smallest window the app opens
	// at. This shrinks instead, so the image is whole at every window size.
	let mut content = div()
		.flex()
		.flex_col()
		.h(px(layout::SHEET))
		.min_h(px(0.0))
		.max_h(px(layout::reading()))
		.gap(px(space::SNUG));

	content = match (&handle.image, &handle.error, &store.replica.transcript) {
		(Some(image), _, remote) => {
			let mut body = div()
				.flex_1()
				.min_h(px(0.0))
				.overflow_hidden()
				.rounded(px(veyyon_gui_kit::theme::radius::CARD))
				.bg(theme.sunken)
				.child(
					img(image.clone())
						.w_full()
						.h_full()
						.object_fit(ObjectFit::Contain),
				);
			if let RemoteData::Stale { reason, .. } = remote {
				body = body.child(Banner::notice("Showing cached image").detail(format!("{reason:?}")));
			}
			content.child(body)
		},
		(_, Some(error), _) => content.child(Empty::new(error.clone()).icon(Icon::Failed)),
		(_, _, RemoteData::Unrequested | RemoteData::Loading { .. }) => {
			let spinner =
				Spinner::new(owner_of(&format!("image-viewer:{entry}:{index}:loading")), Icon::Running)
					.into_any_element();
			content.child(
				div()
					.flex_1()
					.min_h(px(0.0))
					.flex()
					.items_center()
					.justify_center()
					.child(spinner),
			)
		},
		(_, _, RemoteData::Empty) => {
			content.child(Empty::new("No image is available").icon(Icon::Notice))
		},
		(_, _, RemoteData::Error { message, .. }) => {
			content.child(Banner::failure("Image unavailable").detail(message.clone()))
		},
		(_, _, RemoteData::Ready(_) | RemoteData::Stale { .. }) => {
			content.child(Empty::new("The selected image is unavailable").icon(Icon::Notice))
		},
	};

	let title = handle.alt.clone().unwrap_or_else(|| "Image".to_owned());
	Sheet::new("image-viewer", sheet_owner, open)
		.centred()
		.max_width(layout::reading())
		.on_dismiss(act::click(UiCommand::CloseTopOverlay))
		.child(
			div()
				.flex()
				.items_center()
				.gap(px(space::BASE))
				.child(text::heading(title, &theme).flex_1().min_w(px(0.0)))
				.child(
					Button::new("close-image-viewer", close_owner, Icon::Close)
						.tip("Close image")
						.on_click(act::click(UiCommand::CloseTopOverlay)),
				),
		)
		// The image scales into the height the title row leaves rather than
		// scrolling: a picture has no reading order to scroll through.
		.fitted(content)
		.into_any_element()
}

fn image_format(media_type: &str) -> Option<ImageFormat> {
	match media_type.trim().to_ascii_lowercase().as_str() {
		"image/png" => Some(ImageFormat::Png),
		"image/jpeg" | "image/jpg" => Some(ImageFormat::Jpeg),
		"image/webp" => Some(ImageFormat::Webp),
		"image/gif" => Some(ImageFormat::Gif),
		"image/bmp" => Some(ImageFormat::Bmp),
		"image/tiff" => Some(ImageFormat::Tiff),
		"image/x-icon" | "image/vnd.microsoft.icon" => Some(ImageFormat::Ico),
		"image/svg+xml" => Some(ImageFormat::Svg),
		_ => None,
	}
}
