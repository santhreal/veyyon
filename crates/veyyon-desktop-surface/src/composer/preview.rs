//! Bounded presentation of attachment bytes; originals remain available for
//! submission.

use std::sync::Arc;

use veyyon_gpui::RenderImage;

use super::media::{MediaKind, MediaType, Payload};
use crate::transcript::blocks::artifact::decode_and_validate_image;

pub const MAX_TEXT_PREVIEW_CHARS: usize = 256;
pub const MAX_BINARY_PREVIEW_BYTES: usize = 16;
pub const MAX_ATTACHMENTS: usize = 8;

#[derive(Clone, Debug)]
pub enum AttachmentPreview {
	Image(Arc<RenderImage>),
	Text(String),
	Binary(String),
	Video,
	Unavailable(String),
}

impl PartialEq for AttachmentPreview {
	fn eq(&self, other: &Self) -> bool {
		match (self, other) {
			(Self::Image(a), Self::Image(b)) => Arc::ptr_eq(a, b),
			(Self::Text(a), Self::Text(b))
			| (Self::Binary(a), Self::Binary(b))
			| (Self::Unavailable(a), Self::Unavailable(b)) => a == b,
			(Self::Video, Self::Video) => true,
			_ => false,
		}
	}
}
impl Eq for AttachmentPreview {}

impl AttachmentPreview {
	pub fn new(media: MediaType, payload: &Payload) -> Self {
		match media.kind() {
			MediaKind::Image => match decode_and_validate_image(payload.bytes(), Some(media.as_str()))
			{
				Ok(decoded) => Self::Image(decoded.gpui_image),
				Err(reason) => Self::Unavailable(reason),
			},
			MediaKind::Video => Self::Video,
			MediaKind::Text => match std::str::from_utf8(payload.bytes()) {
				Ok(text) => Self::Text(
					text
						.chars()
						.take(MAX_TEXT_PREVIEW_CHARS)
						.map(|ch| if ch.is_control() { ' ' } else { ch })
						.collect(),
				),
				Err(_) => Self::Unavailable("Text attachment is not valid UTF-8".into()),
			},
			MediaKind::Binary => Self::Binary(
				payload
					.bytes()
					.iter()
					.take(MAX_BINARY_PREVIEW_BYTES)
					.map(|byte| format!("{byte:02x}"))
					.collect::<Vec<_>>()
					.join(" "),
			),
		}
	}
}
