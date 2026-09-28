//! The attachment tray inside the composer frame: one chip per file waiting
//! for the next prompt, an image drawn as its thumbnail, every chip naming
//! the type and size, previewing a text or opaque payload's opening in its
//! tooltip, and removable.

use std::fmt::Write as _;

use gpui::{AnyElement, Context, ObjectFit, SharedString, div, img, prelude::*};
use veyyon_desktop_ui::{
	controls::{IconButton, Tooltip},
	icons::{Icon, IconName},
	theme::{ActiveTheme, TypeStyled, radius, size, space, text},
};

use super::{Composer, MediaType, attach};

/// The characters of a text payload a chip previews.
const TEXT_PREVIEW_CHARS: usize = 256;
/// The leading bytes of an opaque payload a chip previews, in hex.
const BINARY_PREVIEW_BYTES: usize = 16;

/// The opening of a text payload with its line breaks and tabs blanked, or
/// the leading bytes of an opaque one in hex; `None` for other media.
pub(super) fn preview(media: MediaType, bytes: &[u8]) -> Option<SharedString> {
	match media {
		MediaType::Text => {
			let head = &bytes[..bytes.len().min(TEXT_PREVIEW_CHARS * 4)];
			let text = std::str::from_utf8(head).unwrap_or_else(|cut| {
				std::str::from_utf8(&head[..cut.valid_up_to()]).unwrap_or_default()
			});
			let text: String = text
				.chars()
				.take(TEXT_PREVIEW_CHARS)
				.map(|ch| if ch.is_control() { ' ' } else { ch })
				.collect();
			Some(text.into())
		},
		MediaType::Binary => {
			let mut hex = String::with_capacity(BINARY_PREVIEW_BYTES * 3);
			for byte in bytes.iter().take(BINARY_PREVIEW_BYTES) {
				if !hex.is_empty() {
					hex.push(' ');
				}
				let _ = write!(hex, "{byte:02x}");
			}
			Some(hex.into())
		},
		_ => None,
	}
}

/// The icon a chip without a thumbnail draws for `media`.
const fn glyph(media: MediaType) -> IconName {
	match media {
		MediaType::Png | MediaType::Jpeg | MediaType::Gif | MediaType::Webp => IconName::Image,
		MediaType::Mp4 | MediaType::Webm | MediaType::QuickTime => IconName::Play,
		MediaType::Text | MediaType::Pdf => IconName::FileText,
		MediaType::Binary => IconName::File,
	}
}

impl Composer {
	/// Takes attachment `ix` off the next prompt.
	pub(super) fn remove_attachment(&mut self, ix: usize, cx: &mut Context<Self>) {
		if ix >= self.attachments.len() {
			return;
		}
		self.attachments.remove(ix);
		self.notice = None;
		self.save_draft(cx);
		self.reshape(cx);
		cx.notify();
	}

	/// The tray, while anything is attached.
	pub(super) fn render_tray(&self, cx: &Context<Self>) -> Option<AnyElement> {
		if self.attachments.is_empty() {
			return None;
		}
		let palette = cx.theme().palette;
		let chips = self.attachments.iter().enumerate().map(|(ix, attachment)| {
			let preview = match &attachment.image {
				Some(image) => img(image.clone())
					.size(size::CONTROL_LG)
					.rounded(radius::MD)
					.object_fit(ObjectFit::Cover)
					.into_any_element(),
				None => div()
					.flex()
					.flex_none()
					.items_center()
					.justify_center()
					.size(size::CONTROL_LG)
					.rounded(radius::MD)
					.bg(palette.bg.hover)
					.child(
						Icon::new(glyph(attachment.media))
							.size(size::ICON)
							.color(palette.text.muted),
					)
					.into_any_element(),
			};
			let name = SharedString::from(attachment.name.clone());
			let detail =
				format!("{} · {}", attachment.media.spelling(), attach::human_bytes(attachment.size()));
			div()
				.id(("composer-attachment", ix))
				.flex()
				.items_center()
				.gap(space::S2)
				.max_w(size::MENU_MIN_WIDTH + size::CONTROL_LG * 2.0)
				.p(space::S1)
				.pr(space::S0_5)
				.rounded(radius::LG)
				.border_1()
				.border_color(palette.border.subtle)
				.bg(palette.bg.app)
				.child(preview)
				.child(
					div()
						.flex()
						.flex_col()
						.min_w_0()
						.child(
							div()
								.truncate()
								.type_style(text::SMALL)
								.text_color(palette.text.primary)
								.child(name.clone()),
						)
						.child(
							div()
								.truncate()
								.type_style(text::MICRO)
								.text_color(palette.text.muted)
								.child(detail),
						),
				)
				.child(
					IconButton::new(("composer-attachment-remove", ix), IconName::X)
						.tooltip(format!("Remove {name}"))
						.on_click(cx.listener(move |this, _, _, cx| this.remove_attachment(ix, cx))),
				)
				.tooltip(Tooltip::text(match &attachment.preview {
					Some(preview) => SharedString::from(format!("{name}\n{preview}")),
					None => name,
				}))
		});
		Some(
			div()
				.id("composer-tray")
				.flex()
				.flex_wrap()
				.gap(space::S2)
				.children(chips)
				.into_any_element(),
		)
	}
}
