//! The sidebar: a thread row's click, keys and menu, the thread search, the
//! refresh and new-thread controls, and the profile menu.

use std::time::Duration;

use gpui::{Modifiers, MouseButton};
use serde_json::json;
use veyyon_desktop_model::{HostEvent, SnapshotSectionKind};

use crate::harness::{Win, corpus, section};

/// The row of the thread the world opens.
const ROW: &str = "sidebar.row:sess-1";

/// Longer than the pause typing takes before the host is asked to search.
const SEARCH_PAUSE: Duration = Duration::from_millis(300);

/// The host listing a second thread beside the open one.
fn second_thread() -> HostEvent {
	let row = |id: &str, title: &str| {
		json!({
			"id": id, "workspace": "repo", "path": format!("/repo/.veyyon/sessions/{id}.jsonl"),
			"cwd": "/repo", "title": title, "parent_path": null,
			"created_at_ms": 1_600_000_000_000_u64, "modified_at_ms": 1_600_000_000_000_u64,
			"message_count": 1, "size_bytes": 1, "first_message": null,
			"searchable_messages": null, "status": "Complete"
		})
	};
	let rows = json!([row("sess-1", "First thread"), row("sess-2", "Second thread")]);
	HostEvent::Snapshot(section(json!({ "Sessions": [{ "revision": 2, "value": rows }, []] })))
}

/// Presses and releases the right button over the driver target `id`.
fn right_click(w: &mut Win<'_>, id: &str) {
	let at = w
		.bounds(id)
		.unwrap_or_else(|| panic!("the window lays out {id}"))
		.center();
	w.cx
		.simulate_mouse_down(at, MouseButton::Right, Modifiers::none());
	w.cx
		.simulate_mouse_up(at, MouseButton::Right, Modifiers::none());
	w.cx.run_until_parked();
}

/// Opens the profile menu over the profiles the host lists: `default`
/// active and `Work laptop (work)` beside it.
fn profile_menu(w: &mut Win<'_>) {
	w.apply(vec![corpus(SnapshotSectionKind::Profiles)]);
	w.palette("Switch profile");
}

pub(super) fn open(w: &mut Win<'_>) {
	w.apply(vec![second_thread()]);
	w.click("sidebar.row:sess-2");
}

pub(super) fn create(w: &mut Win<'_>) {
	w.keys("secondary-n");
}

/// Selects the row with a click, opens its title with F2 and commits an
/// edit with Enter.
pub(super) fn rename(w: &mut Win<'_>) {
	w.click(ROW);
	w.keys("f2");
	w.typed(" renamed");
	w.keys("enter");
}

/// Selects the row with a click, asks with Delete and confirms with Enter.
pub(super) fn delete(w: &mut Win<'_>) {
	w.click(ROW);
	w.keys("delete");
	w.keys("enter");
}

/// Picks Handoff, typed to, from the row's right-click menu.
pub(super) fn handoff(w: &mut Win<'_>) {
	right_click(w, ROW);
	w.keys("h enter");
}

/// Types a query into the search field its chord focuses and pauses.
pub(super) fn search(w: &mut Win<'_>) {
	w.keys("secondary-f");
	w.typed("build");
	w.wait(SEARCH_PAUSE);
}

pub(super) fn refresh(w: &mut Win<'_>) {
	w.click("sidebar.refresh");
}

/// Picks New profile and names it.
pub(super) fn new_profile(w: &mut Win<'_>) {
	profile_menu(w);
	w.keys("n enter");
	w.typed("travel");
	w.keys("enter");
}

/// Picks Rename default and edits its display name.
pub(super) fn rename_profile(w: &mut Win<'_>) {
	profile_menu(w);
	w.keys("r enter");
	w.typed("-home");
	w.keys("enter");
}

/// Picks Delete Work laptop (work), typed to past `default`.
pub(super) fn delete_profile(w: &mut Win<'_>) {
	profile_menu(w);
	w.keys("d e l enter");
}

/// Picks Refresh profiles, typed to past Rename default.
pub(super) fn refresh_profiles(w: &mut Win<'_>) {
	profile_menu(w);
	w.keys("r e f enter");
}
