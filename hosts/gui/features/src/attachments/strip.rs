//! Attachment strip container for composer draft previews.

use gpui::{App, Div, ParentElement, Styled, div, px};
use veyyon_gui_core::Store;
use veyyon_gui_kit::theme::{Theme, space};

use super::preview::render_attachment_preview;
use crate::composer::logic;

pub fn attachment_strip(store: &Store, cx: &mut App) -> Option<Div> {
	let (session, draft) = logic::selected_draft(store)?;
	if draft.attachments.is_empty() {
		return None;
	}
	let theme = Theme::get(cx);
	let mut strip = div()
		.flex()
		.flex_wrap()
		.gap(px(space::X8))
		.w_full()
		.min_w(px(0.0));

	for attachment in &draft.attachments {
		strip = strip.child(render_attachment_preview(session, attachment, &theme, cx));
	}
	Some(strip)
}
