//! WHY THIS SUITE EXISTS: Review surface presentation logic produces labels,
//! badges, and status descriptions for threads and change requests. This suite
//! verifies that location formatting, status calculations, badge text, and
//! orphan descriptions behave deterministically across all states.
//!
//! WHAT IT DOES NOT CATCH: Pixel-level widget layout in GPUI.

use veyyon_gui_core::model::{
	AnchorContext, LineRange, OrphanReason, ReviewComment, ReviewCommentId, ReviewThread,
	ReviewThreadId,
};

use super::logic::*;

fn make_thread(start: u32, end: u32) -> ReviewThread {
	ReviewThread::new(
		ReviewThreadId::new("t1"),
		"src/main.rs",
		LineRange { start, end },
		AnchorContext::default(),
		ReviewComment::new(ReviewCommentId::new("c1"), "You", "Text"),
	)
}

#[test]
fn location_label_formatting() {
	assert_eq!(
		thread_location_label("src/main.rs", &LineRange { start: 10, end: 10 }),
		"src/main.rs:10"
	);
	assert_eq!(
		thread_location_label("src/main.rs", &LineRange { start: 10, end: 20 }),
		"src/main.rs:10-20"
	);
}

#[test]
fn status_label_transitions() {
	let mut thread = make_thread(5, 8);
	assert_eq!(thread_status_label(&thread), "Open");

	thread.orphan = Some(OrphanReason::ContentModified);
	assert_eq!(thread_status_label(&thread), "Orphaned");

	thread.resolve();
	assert_eq!(thread_status_label(&thread), "Resolved");
}

#[test]
fn unresolved_badge_text_values() {
	assert_eq!(unresolved_badge_text(0), None);
	assert_eq!(unresolved_badge_text(1), Some("1 unresolved".to_string()));
	assert_eq!(unresolved_badge_text(4), Some("4 unresolved".to_string()));
}

#[test]
fn orphan_details_for_all_reasons() {
	for reason in OrphanReason::ALL {
		assert!(!orphan_detail(reason).is_empty());
	}
}
