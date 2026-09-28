//! The thread header's buttons: pause or resume the agents, compact, export,
//! and share, stop sharing or leave by the side of the share the window is
//! on.

use serde_json::json;
use veyyon_desktop_model::{HostEvent, SnapshotSectionKind};

use crate::harness::{Win, corpus, section};

pub(super) fn pause(w: &mut Win<'_>) {
	w.click("thread.pause");
}

/// Presses the same button once the host states its agents frozen.
pub(super) fn resume(w: &mut Win<'_>) {
	w.apply(vec![corpus(SnapshotSectionKind::AgentPause)]);
	w.click("thread.pause");
}

pub(super) fn compact(w: &mut Win<'_>) {
	w.click("thread.compact");
}

pub(super) fn export(w: &mut Win<'_>) {
	w.click("thread.export");
}

pub(super) fn share(w: &mut Win<'_>) {
	w.click("thread.share");
}

/// Presses the share button once the host states this window hosts one.
pub(super) fn stop_sharing(w: &mut Win<'_>) {
	w.apply(vec![corpus(SnapshotSectionKind::Share)]);
	w.click("thread.share");
}

/// Presses the share button once the host states this window joined one.
pub(super) fn leave(w: &mut Win<'_>) {
	let joined = section(json!({ "Share": {
		"state": "joined", "role": "Guest", "relay_url": "wss://relay.example.com",
		"link": null, "web_link": null, "view_link": null, "web_view_link": null,
		"participants": [],
		"guest": { "room": "room-1", "host_name": "Host", "read_only": false, "connected": true },
		"error": null
	} }));
	w.apply(vec![HostEvent::Snapshot(joined)]);
	w.click("thread.share");
}
