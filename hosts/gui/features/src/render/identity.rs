//! Stable retained identities for controls inside virtualized transcript rows.

use veyyon_gui_kit::motion::{OwnerNamespace, RetainedKey, owner as registry_owner};

pub fn owner(id: &str) -> RetainedKey {
	registry_owner(OwnerNamespace::Render, "block", id)
}
