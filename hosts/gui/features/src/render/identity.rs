//! Stable retained identities for controls inside virtualized transcript rows.

use veyyon_gui_kit::motion::{OwnerNamespace, RetainedKey};

pub fn owner(id: &str) -> RetainedKey {
	let mut hash = 0xcbf2_9ce4_8422_2325_u64;
	for byte in id.bytes() {
		hash ^= u64::from(byte);
		hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
	}
	RetainedKey::new(((OwnerNamespace::Render as u64) << 56) | (hash & 0x00ff_ffff_ffff_ffff), 0)
}
