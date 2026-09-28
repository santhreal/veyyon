//! Gestures on the dock over the composer: the card of the oldest decision,
//! the goal strip and the autoswarm console, each seeded as the host sends
//! it and then clicked where the dock draws it.

use gpui::{point, px};
use serde_json::json;
use veyyon_desktop_model::{HostEvent, SnapshotSectionKind};
use veyyon_desktop_ui::theme::{size, space};

use super::{click_text_in, text_in};
use crate::harness::{Win, corpus, section};

/// An autoswarm console on `sess-1` with a preset row whose selected option
/// is a saved preset (drawn last, so its delete control follows it), the
/// text row a preset is saved under, holding a name, and one action.
fn console() -> HostEvent {
	HostEvent::Snapshot(section(json!({ "AutoswarmConsole": { "session": "sess-1", "console": {
		"session": "sess-1",
		"swarm": null,
		"fields": [
			{ "id": "preset", "kind": "Segmented", "label": "Preset",
				"hint": "The setup the rows start from", "display": "Nightly",
				"text": null, "placeholder": null, "number": null, "min": null, "max": null,
				"on": null, "options": [
					{ "value": "fast", "label": "Fast", "selected": false, "removable": false },
					{ "value": "nightly", "label": "Nightly", "selected": true, "removable": true }
				] },
			{ "id": "save", "kind": "Text", "label": "Save as",
				"hint": "The name this setup is saved under", "display": "nightly",
				"text": "nightly", "placeholder": "preset name", "number": null, "min": null,
				"max": null, "on": null, "options": [] }
		],
		"notes": [],
		"actions": [
			{ "action": "start", "label": "Start swarm", "verb": "Start a swarm on this setup",
				"primary": true, "blocker": null }
		],
		"runs": [],
		"save_field": "save"
	} } })))
}

/// The oldest decision the corpus holds is an approval.
pub(super) fn respond_to_interaction(w: &mut Win<'_>) {
	w.apply(vec![corpus(SnapshotSectionKind::Interactions)]);
	click_text_in(w, "dock", "Allow once");
}

/// The corpus goal is active, so the strip offers Pause.
pub(super) fn control_goal(w: &mut Win<'_>) {
	w.apply(vec![corpus(SnapshotSectionKind::Goal)]);
	click_text_in(w, "dock", "Pause");
}

pub(super) fn set_autoswarm_field(w: &mut Win<'_>) {
	w.apply(vec![console()]);
	click_text_in(w, "dock", "Fast");
}

pub(super) fn run_autoswarm_action(w: &mut Win<'_>) {
	w.apply(vec![console()]);
	click_text_in(w, "dock", "Start swarm");
}

pub(super) fn save_autoswarm_preset(w: &mut Win<'_>) {
	w.apply(vec![console()]);
	click_text_in(w, "dock", "Save preset");
}

/// The delete control is an icon with no words, drawn after the last option
/// of the row: the option's small button (its inset and 1 px border), the
/// row's gap, then half of the icon button.
pub(super) fn delete_autoswarm_preset(w: &mut Win<'_>) {
	w.apply(vec![console()]);
	let option = text_in(w, "dock", "Nightly");
	let offset = space::S2 + px(1.0) + space::S1 + size::CONTROL / 2.0;
	w.click_at(point(option.right() + offset, option.center().y));
}

pub(super) fn close_autoswarm_console(w: &mut Win<'_>) {
	w.apply(vec![console()]);
	click_text_in(w, "dock", "Close");
}
