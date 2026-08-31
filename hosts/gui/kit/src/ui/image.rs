//! Decoded image preview container.
//!
//! Byte decoding occurs when the host event is applied, never in render. The
//! primitive accepts the resulting image value and keeps containment, optical
//! ground, and object fit consistent across files, transcript attachments, and
//! the image viewer.

use std::sync::Arc;

use gpui::{
	App, Image, ImageFormat, IntoElement, ObjectFit, ParentElement, RenderOnce, SharedString,
	Styled, StyledImage, Window, img,
};

use super::{StateSurface, card};
use crate::{motion::RetainedKey, theme::Theme};

#[derive(IntoElement)]
pub struct ImagePreview {
	image: Arc<Image>,
	alt:   Option<SharedString>,
}
impl ImagePreview {
	pub fn decode(media_type: &str, bytes: Vec<u8>) -> Option<Self> {
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
		Some(Self { image: Arc::new(Image::from_bytes(format, bytes)), alt: None })
	}

	pub fn from_image(image: Arc<Image>) -> Self {
		Self { image, alt: None }
	}

	pub fn alt(mut self, alt: impl Into<SharedString>) -> Self {
		self.alt = Some(alt.into());
		self
	}
}

impl RenderOnce for ImagePreview {
	fn render(self, _window: &mut Window, cx: &mut App) -> impl IntoElement {
		let theme = Theme::get(cx);
		let image = self.image;
		let fallback = self
			.alt
			.unwrap_or_else(|| "Image preview unavailable".into());
		let owner = RetainedKey::semantic(crate::motion::OwnerNamespace::Kit, 1);
		card::well(&theme).size_full().child(
			img(image)
				.size_full()
				.object_fit(ObjectFit::Contain)
				.with_fallback(move || {
					StateSurface::error(owner, fallback.clone())
						.detail("The image decoder could not display these bytes.")
						.filling()
						.into_any_element()
				}),
		)
	}
}
