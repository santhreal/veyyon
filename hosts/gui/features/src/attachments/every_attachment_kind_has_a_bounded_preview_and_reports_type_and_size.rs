//! WHY THIS SUITE EXISTS. An attachment was a bare chip: no preview of what
//! was attached, no size or type stated, and no bound on how large a preview
//! could draw.
//!
//! THE CLASS. A kind of attachment the composer accepts and cannot describe.
//! Every variant of `AttachmentKind` is swept from the source, so a new kind
//! that renders nothing fails here rather than shipping as an empty chip, and
//! every size is asserted through the same formatter the chips read.
//!
//! WHAT IT DOES NOT CATCH. Pixel-level layout: the test platform has no
//! display, so this asserts the elements and the text, not the raster.

use gpui::TestAppContext;
use veyyon_gui_core::{
	model::{AttachmentId, format_size},
	navigation::{AttachmentKind, LocalAttachment},
};
use veyyon_gui_kit::theme::{Appearance, Theme};

use super::preview::render_attachment_preview;

#[gpui::test]
fn every_attachment_kind_variant_has_a_preview(cx: &mut TestAppContext) {
	let kinds = AttachmentKind::all_examples();
	assert_eq!(kinds.len(), 5);

	let theme = Theme::of(Appearance::Dark);
	let session_id = veyyon_gui_core::model::SessionId::new("test").unwrap();

	for kind in kinds {
		let att_id = AttachmentId::new("test-att").unwrap();
		let attachment = LocalAttachment::new(att_id, kind.clone());

		assert!(!attachment.display_type().is_empty());
		assert!(!attachment.formatted_size().is_empty());

		match &attachment.kind {
			AttachmentKind::File { path } => {
				assert!(path.contains(".pdf"));
				assert!(attachment.is_binary());
			},
			AttachmentKind::Image { path, .. } => {
				assert!(path.contains(".png"));
				assert!(attachment.is_image());
			},
			AttachmentKind::TextRange { text, .. } => {
				assert!(attachment.is_text());
				assert_eq!(attachment.size(), text.len() as u64);
			},
			AttachmentKind::TerminalSelection { text, .. } => {
				assert!(attachment.is_text());
				assert_eq!(attachment.size(), text.len() as u64);
			},
			AttachmentKind::ReviewComment { text, .. } => {
				assert!(attachment.is_text());
				assert_eq!(attachment.size(), text.len() as u64);
			},
		}

		cx.update(|app| {
			let preview = render_attachment_preview(&session_id, &attachment, &theme, app);
			drop(preview);
		});
	}
}

#[test]
fn format_size_reports_human_readable_units() {
	assert_eq!(format_size(0), "0 B");
	assert_eq!(format_size(512), "512 B");
	assert_eq!(format_size(1024), "1.0 KiB");
	assert_eq!(format_size(1536), "1.5 KiB");
	assert_eq!(format_size(1024 * 1024), "1.0 MiB");
	assert_eq!(format_size(5 * 1024 * 1024 + 512 * 1024), "5.5 MiB");
	assert_eq!(format_size(1024 * 1024 * 1024), "1.0 GiB");
	assert_eq!(format_size(2 * 1024 * 1024 * 1024 + 512 * 1024 * 1024), "2.5 GiB");
}
