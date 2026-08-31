//! Long-lived retained identities for overlay chrome and controls.

use std::collections::BTreeMap;

use veyyon_gui_kit::motion::{OwnerNamespace, RetainedKey};

const FIRST_OVERLAY_OWNER: u64 = 4096;

pub struct OverlayState {
	owners: BTreeMap<String, RetainedKey>,
	next:   u64,
}

impl Default for OverlayState {
	fn default() -> Self {
		Self { owners: BTreeMap::new(), next: FIRST_OVERLAY_OWNER }
	}
}

impl OverlayState {
	pub fn owner(&mut self, identity: impl Into<String>) -> Option<RetainedKey> {
		let identity = identity.into();
		if let Some(owner) = self.owners.get(&identity) {
			return Some(*owner);
		}
		let owner = RetainedKey::scoped(OwnerNamespace::Overlays, self.next, 0)?;
		self.next = self.next.saturating_add(1);
		self.owners.insert(identity, owner);
		Some(owner)
	}
}
