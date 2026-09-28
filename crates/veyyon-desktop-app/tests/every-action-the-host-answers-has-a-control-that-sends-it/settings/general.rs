//! The General, Appearance and Keybindings pages.

use serde_json::json;
use veyyon_desktop_model::{HostEvent, SnapshotSectionKind};

use super::{open, press, seed};
use crate::harness::{Win, section};

/// `retry.enabled`, set off in the profile against an on default, so its row
/// draws a switch and a Reset.
fn retry_set_off(w: &mut Win<'_>) {
	let settings = section(json!({ "Settings": {
		"retry.enabled": {
			"value": false, "default": true, "source": "profile", "type": "boolean",
			"label": "Retry failed requests", "tab": "context", "group": "Retry",
		},
	} }));
	w.apply(vec![HostEvent::Snapshot(settings)]);
}

pub fn chord(w: &mut Win<'_>) {
	w.keys("secondary-,");
}

pub fn flip_switch(w: &mut Win<'_>) {
	retry_set_off(w);
	open(w, "general");
	press(w, "toggle-retry.enabled");
}

pub fn reset(w: &mut Win<'_>) {
	retry_set_off(w);
	open(w, "general");
	press(w, "reset-retry.enabled");
}

pub fn appearance_entry(w: &mut Win<'_>) {
	w.keys("secondary-,");
	w.outbox();
	w.click("settings.page:appearance");
}

pub fn hotkeys_row(w: &mut Win<'_>) {
	w.palette("/hotkeys");
}

/// Edit on the corpus binding of `composer.send`, the keys replaced and
/// Enter pressed.
pub fn rebind(w: &mut Win<'_>) {
	seed(w, &[SnapshotSectionKind::Keybindings]);
	open(w, "keybindings");
	press(w, "edit-binding-composer.send");
	w.click("settings.field:keybinding");
	w.keys("ctrl-a backspace");
	w.typed("ctrl+p");
	w.keys("enter");
}
