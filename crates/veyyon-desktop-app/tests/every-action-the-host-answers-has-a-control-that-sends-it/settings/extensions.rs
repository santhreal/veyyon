//! The Extensions page: its sources and the items found in them.

use veyyon_desktop_model::SnapshotSectionKind;

use super::{open, press, seed};
use crate::harness::Win;

pub fn entry(w: &mut Win<'_>) {
	w.keys("secondary-,");
	w.outbox();
	w.click("settings.page:extensions");
}

/// The switch of the corpus skill `review`, which is on.
pub fn item_switch(w: &mut Win<'_>) {
	seed(w, &[SnapshotSectionKind::Extensions]);
	open(w, "extensions");
	press(w, "extension-switch-skill:review");
}

/// The switch of the corpus source `claude`, which is on.
pub fn source_switch(w: &mut Win<'_>) {
	seed(w, &[SnapshotSectionKind::Extensions]);
	open(w, "extensions");
	press(w, "extension-source-switch-claude");
}
