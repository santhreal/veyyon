//! WHY: identical line text is not an identity, and adjacent diff rows can be
//! separated by omitted source. Production parser output must preserve those
//! distinctions. This suite does not exercise native pointer placement.

use veyyon_desktop_model::{
	ChangeScope,
	review::{ReviewPlacement, ReviewSide, ReviewsStore},
};
use veyyon_desktop_surface::{
	DiffStatus, PanelContent,
	diff::parse_diff,
	right_panel::review::{anchor_for_line, placement, reconcile},
};

fn snapshot(diff: &str) -> PanelContent {
	PanelContent {
		review_repository: Some(("/repo".to_owned(), ChangeScope::WorkingTree)),
		diff_status: DiffStatus::Loaded,
		diff: parse_diff(diff),
		..PanelContent::default()
	}
}

#[test]
fn equal_text_in_distinct_context_moves_to_its_own_context_only() {
	let original = snapshot(
		"diff --git a/app.rs b/app.rs\n--- a/app.rs\n+++ b/app.rs\n@@ -1,4 +1,6 @@\n \
		 first\n+target\n end first\n second\n+target\n end second\n",
	);
	let anchor = anchor_for_line(&original, "app.rs", ReviewSide::New, 5).unwrap();
	assert!(!anchor.ambiguous);
	let mut reviews = ReviewsStore::default();
	reviews.create(anchor, "Review second occurrence").unwrap();
	let moved = snapshot(
		"diff --git a/app.rs b/app.rs\n--- a/app.rs\n+++ b/app.rs\n@@ -21,4 +31,6 @@\n \
		 first\n+target\n end first\n second\n+target\n end second\n",
	);
	reconcile(&moved, &mut reviews);
	assert_eq!(placement(&moved, &reviews.threads[0]), ReviewPlacement::Attached(35));
}

#[test]
fn omitted_source_does_not_become_adjacent_context() {
	let original = snapshot(
		"diff --git a/app.rs b/app.rs\n--- a/app.rs\n+++ b/app.rs\n@@ -1,1 +1,2 @@\n \
		 before\n+target\n@@ -50,1 +51,1 @@\n far away\n",
	);
	let anchor = anchor_for_line(&original, "app.rs", ReviewSide::New, 2).unwrap();
	assert_eq!(anchor.before.as_deref(), Some("before"));
	assert_eq!(anchor.after, None);
	let mut reviews = ReviewsStore::default();
	reviews.create(anchor, "Review target").unwrap();
	let moved = snapshot(
		"diff --git a/app.rs b/app.rs\n--- a/app.rs\n+++ b/app.rs\n@@ -11,1 +11,2 @@\n \
		 before\n+target\n@@ -60,1 +61,1 @@\n another distant line\n",
	);
	reconcile(&moved, &mut reviews);
	assert_eq!(placement(&moved, &reviews.threads[0]), ReviewPlacement::Attached(12));
}

#[test]
fn non_source_rows_cannot_create_a_line_comment() {
	let binary =
		snapshot("diff --git a/app.rs b/app.rs\nBinary files a/app.rs and b/app.rs differ\n");
	assert!(anchor_for_line(&binary, "app.rs", ReviewSide::New, 1).is_none());
	let mut detached = snapshot("diff --git a/app.rs b/app.rs\n@@ -1,1 +1,1 @@\n-old\n+new\n");
	detached.review_repository = None;
	assert!(anchor_for_line(&detached, "app.rs", ReviewSide::New, 1).is_none());
}
