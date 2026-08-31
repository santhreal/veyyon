//! Long-lived retained identities for palette chrome and result rows.

use veyyon_gui_kit::motion::{OwnerNamespace, RetainedKey, owner};

/// The track this result row animates on, keyed by the command or session it
/// runs, so a row keeps its track as the query narrows the list around it.
pub fn row(id: &str) -> RetainedKey {
	owner(OwnerNamespace::Overlays, "row", id)
}

/// The track a fixture of the palette - its field, its spinner, its retry -
/// animates on.
pub fn chrome(name: &str) -> RetainedKey {
	owner(OwnerNamespace::Overlays, "palette", name)
}
