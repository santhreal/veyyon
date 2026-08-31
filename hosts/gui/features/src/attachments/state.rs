//! Retained animation and hit-test identities for attachment previews.

use veyyon_gui_core::model::AttachmentId;
use veyyon_gui_kit::motion::{OwnerNamespace, RetainedKey, control as control_key, owner};

const ATTACHMENT_PREVIEW: &str = "attachment-preview";

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum PreviewSlot {
	Remove = 1,
	Retry  = 2,
}

impl PreviewSlot {
	pub const ALL: [PreviewSlot; 2] = [PreviewSlot::Remove, PreviewSlot::Retry];

	pub const fn offset(self) -> u8 {
		self as u8
	}
}

pub fn preview_owner(id: &AttachmentId) -> RetainedKey {
	owner(OwnerNamespace::Conversation, ATTACHMENT_PREVIEW, id.as_str())
}

pub fn preview_control(id: &AttachmentId, slot: PreviewSlot) -> RetainedKey {
	control_key(OwnerNamespace::Conversation, ATTACHMENT_PREVIEW, id.as_str(), slot.offset())
}
