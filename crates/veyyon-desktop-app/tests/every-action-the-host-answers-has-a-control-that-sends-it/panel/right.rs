//! Gestures on the right panel: its chord, the palette rows that show a tab,
//! a click on a tab of its strip, and the controls each tab draws.

use serde_json::json;
use veyyon_desktop_model::{HostEvent, SnapshotSectionKind};

use crate::harness::{Win, corpus, section};

/// Opens the right panel with its chord. A session never shown opens on the
/// diff tab.
fn open_panel(w: &mut Win<'_>) {
	w.keys("secondary-shift-d");
}

pub(super) fn refresh_changes(w: &mut Win<'_>) {
	open_panel(w);
}

pub(super) fn select_change_scope(w: &mut Win<'_>) {
	open_panel(w);
	w.click_text("Staged");
}

pub(super) fn load_file_tree(w: &mut Win<'_>) {
	w.palette("Show files");
}

/// Expands `src` in the host's tree and opens the file under it.
pub(super) fn read_file(w: &mut Win<'_>) {
	w.apply(vec![corpus(SnapshotSectionKind::FileTree)]);
	w.palette("Browse files");
	w.click_text("src");
	w.click_text("app.ts");
}

pub(super) fn search_content(w: &mut Win<'_>) {
	w.palette("Show files");
	w.click_text("Search files and contents");
	w.typed("needle");
	w.keys("enter");
}

/// The roster the host sent is on screen, so showing the tab asks for none;
/// the refresh button asks again.
pub(super) fn refresh_agents(w: &mut Win<'_>) {
	w.palette("Show agents");
	w.click("agents-refresh");
}

/// A roster holding one agent whose session was disposed.
pub(super) fn revive_agent(w: &mut Win<'_>) {
	w.apply(vec![HostEvent::Snapshot(section(json!({ "Agents": [{
		"id": "agent-9", "call_sign": "Heron", "display_name": "Reviewer", "kind": "sub",
		"status": "parked", "parent": "main", "scope": "/repo", "session": null,
		"activity": null, "model": null
	}] })))]);
	w.palette("Show agents");
	w.click_text("Revive");
}

pub(super) fn spawn_task(w: &mut Win<'_>) {
	w.palette("Show agents");
	w.click_text("Spawn an agent on a task");
	w.typed("summarise the changelog");
	w.keys("enter");
}

/// `agent-0` is inside a turn and is not the session's own agent.
pub(super) fn cancel_task(w: &mut Win<'_>) {
	w.palette("Show agents");
	w.click_text("End");
	w.click_text("End agent");
}

/// `agent-0` runs in session `history-1`.
pub(super) fn preview_session_transcript(w: &mut Win<'_>) {
	w.palette("Show agents");
	w.click_text("Preview");
}

pub(super) fn refresh_diagnostics(w: &mut Win<'_>) {
	open_panel(w);
	w.click("panel.tab:diagnostics");
}

/// Diagnostics naming one source that failed.
pub(super) fn retry_diagnostic_source(w: &mut Win<'_>) {
	w.apply(vec![HostEvent::Snapshot(section(json!({ "Diagnostics": {
		"sources": [{ "name": "lsp", "status": "error", "message": "the server exited" }]
	} })))]);
	w.palette("Show diagnostics");
	w.click_text("Retry");
}

pub(super) fn clear_output(w: &mut Win<'_>) {
	w.palette("Show diagnostics");
	w.click_text("Clear output");
}

pub(super) fn get_usage(w: &mut Win<'_>) {
	w.palette("Show usage");
}

pub(super) fn get_context_breakdown(w: &mut Win<'_>) {
	open_panel(w);
	w.click("panel.tab:usage");
}
