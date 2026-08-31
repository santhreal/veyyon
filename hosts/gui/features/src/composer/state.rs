//! Long-lived identity for composer controls and attachment chips.

use std::collections::BTreeMap;

use veyyon_gui_core::{
	model::{AttachmentId, SessionId},
	navigation::Draft,
};
use veyyon_gui_kit::motion::{OwnerNamespace, RetainedKey};

pub struct ComposerState {
	attachments:     BTreeMap<AttachmentId, RetainedKey>,
	next_attachment: u64,
}

impl Default for ComposerState {
	fn default() -> Self {
		Self { attachments: BTreeMap::new(), next_attachment: 1 }
	}
}

impl ComposerState {
	pub fn reconcile(&mut self, drafts: &BTreeMap<SessionId, Draft>) {
		self.attachments.retain(|id, _| {
			drafts
				.values()
				.any(|draft| draft.attachments.iter().any(|a| a.id == *id))
		});
		for draft in drafts.values() {
			for attachment in &draft.attachments {
				if !self.attachments.contains_key(&attachment.id) {
					let local = 0x1000u64.saturating_add(self.next_attachment);
					let owner = RetainedKey::scoped(OwnerNamespace::Conversation, local, 0)
						.unwrap_or_else(|| RetainedKey::semantic(OwnerNamespace::Conversation, 0));
					self.next_attachment = self.next_attachment.saturating_add(1);
					self.attachments.insert(attachment.id.clone(), owner);
				}
			}
		}
	}

	pub fn attachment_owner(&self, id: &AttachmentId) -> RetainedKey {
		self
			.attachments
			.get(id)
			.copied()
			.unwrap_or_else(|| self.control_owner(0))
	}

	pub fn control_owner(&self, slot: u16) -> RetainedKey {
		RetainedKey::semantic(OwnerNamespace::Conversation, slot as u32)
	}
}
