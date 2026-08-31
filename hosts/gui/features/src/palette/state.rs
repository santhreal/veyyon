//! Long-lived retained identities for palette chrome and result rows.

use std::collections::BTreeMap;

use veyyon_gui_kit::motion::{OwnerNamespace, RetainedKey};

const FIRST_DYNAMIC: u64 = 128;

#[derive(Debug)]
pub struct PaletteMotion {
	rows: BTreeMap<String, RetainedKey>,
	next: u64,
}

impl Default for PaletteMotion {
	fn default() -> Self {
		Self { rows: BTreeMap::new(), next: FIRST_DYNAMIC }
	}
}

impl PaletteMotion {
	pub fn row(&mut self, id: &str) -> Option<RetainedKey> {
		if let Some(owner) = self.rows.get(id) {
			return Some(*owner);
		}
		let owner = RetainedKey::scoped(OwnerNamespace::Overlays, self.next, 0)?;
		self.next = self.next.saturating_add(1);
		self.rows.insert(id.to_owned(), owner);
		Some(owner)
	}
}

pub const fn chrome(local: u64) -> RetainedKey {
	RetainedKey::new(((OwnerNamespace::Overlays as u64) << 56) | local, 0)
}
