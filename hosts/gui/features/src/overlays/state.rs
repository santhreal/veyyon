//! Long-lived retained identities for overlay chrome and controls.

use veyyon_gui_kit::motion::{OwnerNamespace, RetainedKey, owner};

/// The track the overlay object called `identity` animates on. An overlay names
/// its sheet and each of its controls, so two controls one sheet draws at once
/// cannot resolve to one key.
pub fn owner_of(identity: &str) -> RetainedKey {
	owner(OwnerNamespace::Overlays, "overlay", identity)
}
