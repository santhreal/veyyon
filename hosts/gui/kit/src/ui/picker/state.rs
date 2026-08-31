//! Retained motion identities for pickers and their items.
//!
//! Every picker keys its sheet, scroll handle, search field, preview panel,
//! and rows through `kit::motion::owners` so two pickers a window can draw at
//! once never share an animation track.

use crate::motion::{OwnerNamespace, RetainedKey, control, owner};

/// The track the picker container animates on.
pub fn picker_owner(id: &str) -> RetainedKey {
	owner(OwnerNamespace::Overlays, "picker", id)
}

/// The track the picker's scroll container animates on.
pub fn picker_scroll(id: &str) -> RetainedKey {
	control(OwnerNamespace::Overlays, "picker", id, 1)
}

/// The track the picker's search field animates on.
pub fn picker_search(id: &str) -> RetainedKey {
	control(OwnerNamespace::Overlays, "picker", id, 2)
}

/// The track the picker's preview panel animates on.
pub fn picker_preview(id: &str) -> RetainedKey {
	control(OwnerNamespace::Overlays, "picker", id, 3)
}

/// The track a picker result row animates on.
pub fn picker_row(row_id: &str) -> RetainedKey {
	owner(OwnerNamespace::Overlays, "row", row_id)
}
