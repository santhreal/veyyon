//! Presentation logic for review threads, comments, and change requests.

use veyyon_gui_core::model::{LineRange, OrphanReason, ReviewThread};

pub fn thread_location_label(path: &str, range: &LineRange) -> String {
	if range.start == range.end {
		format!("{path}:{}", range.start)
	} else {
		format!("{path}:{}-{}", range.start, range.end)
	}
}

pub fn thread_status_label(thread: &ReviewThread) -> &'static str {
	if thread.resolved {
		"Resolved"
	} else if thread.is_orphaned() {
		"Orphaned"
	} else {
		"Open"
	}
}

pub fn orphan_detail(reason: OrphanReason) -> &'static str {
	reason.label()
}

pub fn unresolved_badge_text(count: usize) -> Option<String> {
	if count == 0 {
		None
	} else if count == 1 {
		Some("1 unresolved".to_string())
	} else {
		Some(format!("{count} unresolved"))
	}
}
