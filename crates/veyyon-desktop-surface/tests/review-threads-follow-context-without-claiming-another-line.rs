//! WHY: line-number anchors move to unrelated code after rediff. These tests
//! drive the production diff parser, contextual projection, review mutations
//! and versioned persistence document. Missing and duplicate identities stay
//! orphaned across later snapshots and relaunch. Native pointer/focus behavior
//! and filesystem writes are exercised by the desktop integration workflow, not
//! this display-free suite.

use veyyon_desktop_model::{
	ChangeScope, PersistedState, StoreKind,
	review::{ReviewPlacement, ReviewSide, ReviewsStore},
};
use veyyon_desktop_surface::{
	DiffStatus, PanelContent,
	diff::parse_diff,
	right_panel::{
		review::{anchor_for_line, placement, reconcile},
		review_controls::ReviewCounts,
	},
};

fn panel(repository: &str, path: &str, start: usize, rows: &str) -> PanelContent {
	let old_count = rows.lines().filter(|line| !line.starts_with('+')).count();
	let new_count = rows.lines().filter(|line| !line.starts_with('-')).count();
	PanelContent {
		review_repository: Some((repository.to_owned(), ChangeScope::WorkingTree)),
		diff_status: DiffStatus::Loaded,
		diff: parse_diff(&format!(
			"diff --git a/{path} b/{path}\n--- a/{path}\n+++ b/{path}\n@@ -{start},{old_count} \
			 +{start},{new_count} @@\n{rows}"
		)),
		..PanelContent::default()
	}
}

fn create(panel: &PanelContent, side: ReviewSide, line: usize) -> ReviewsStore {
	let mut reviews = ReviewsStore::default();
	let anchor = anchor_for_line(panel, "src/app.rs", side, line).expect("real parsed source line");
	reviews
		.create(anchor, "Check this change")
		.expect("nonempty comment");
	reviews
}

fn relaunch(reviews: ReviewsStore) -> ReviewsStore {
	let persisted = PersistedState { reviews, ..PersistedState::default() };
	let document = persisted
		.write_document(StoreKind::Reviews)
		.expect("serialize reviews");
	let mut restored = PersistedState::default();
	assert!(
		restored
			.read_document(StoreKind::Reviews, &document)
			.is_empty()
	);
	restored.reviews
}

#[test]
fn moved_lines_preserve_both_source_sides_and_comments_across_relaunch() {
	let rows = " before\n-old value\n+new value\n after\n";
	for side in [ReviewSide::Old, ReviewSide::New] {
		let original = panel("/repo/first", "src/app.rs", 1, rows);
		let mut reviews = create(&original, side, 2);
		let moved = panel("/repo/first", "src/app.rs", 41, rows);
		reconcile(&moved, &mut reviews);
		assert_eq!(placement(&moved, &reviews.threads[0]), ReviewPlacement::Attached(42));
		let restored = relaunch(reviews);
		assert_eq!(placement(&moved, &restored.threads[0]), ReviewPlacement::Attached(42));
		assert_eq!(restored.threads[0].comments, ["Check this change"]);
		assert_eq!(ReviewCounts::of(&moved, &restored).files.get("src/app.rs"), Some(&1));
	}
}

#[test]
fn duplicate_context_never_uses_original_or_nearest_line_as_a_tiebreaker() {
	let original = panel("/repo", "src/app.rs", 1, " before\n+target\n after\n");
	let duplicate =
		panel("/repo", "src/app.rs", 1, " before\n+target\n after\n before\n+target\n after\n");
	let mut reviews = create(&original, ReviewSide::New, 2);
	assert_eq!(placement(&duplicate, &reviews.threads[0]), ReviewPlacement::Ambiguous);
	reconcile(&duplicate, &mut reviews);
	let mut restored = relaunch(reviews);
	reconcile(&original, &mut restored);
	assert_eq!(placement(&original, &restored.threads[0]), ReviewPlacement::Missing);
	assert_eq!(ReviewCounts::of(&original, &restored).total, 1);
	// Ambiguity present at creation must not disappear when one copy is removed.
	let initially_ambiguous = create(&duplicate, ReviewSide::New, 2);
	assert_eq!(placement(&original, &initially_ambiguous.threads[0]), ReviewPlacement::Ambiguous);
}

#[test]
fn deleted_target_cannot_be_replaced_by_same_text_in_different_context() {
	let original = panel("/repo", "src/app.rs", 1, " before\n+target\n after\n");
	let mut reviews = create(&original, ReviewSide::New, 2);
	let deleted = panel("/repo", "src/app.rs", 1, " elsewhere\n+target\n other\n");
	reconcile(&deleted, &mut reviews);
	assert_eq!(placement(&deleted, &reviews.threads[0]), ReviewPlacement::Missing);
	let mut restored = relaunch(reviews);
	reconcile(&original, &mut restored);
	assert_eq!(placement(&original, &restored.threads[0]), ReviewPlacement::Missing);
	assert_eq!(restored.threads[0].anchor.text, "target");
	assert_eq!(restored.threads[0].anchor.before.as_deref(), Some("before"));
}

#[test]
fn replies_resolution_and_reopen_survive_the_same_document() {
	let current = panel("/repo", "src/app.rs", 1, " before\n+target\n after\n");
	let mut reviews = create(&current, ReviewSide::New, 2);
	let id = reviews.threads[0].id;
	assert!(!reviews.reply(id, "  \n "));
	assert!(reviews.reply(id, "Addressed in the next change"));
	assert!(reviews.set_resolved(id, true));
	assert_eq!(ReviewCounts::of(&current, &reviews).total, 0);
	let mut restored = relaunch(reviews);
	assert!(restored.threads[0].resolved);
	assert_eq!(restored.threads[0].comments, ["Check this change", "Addressed in the next change"]);
	assert!(restored.set_resolved(id, false));
	assert_eq!(ReviewCounts::of(&current, &restored).total, 1);
	assert!(!restored.set_resolved(id + 1, true));
}

#[test]
fn repository_file_and_scope_are_isolated_and_missing_files_remain_listed_in_totals() {
	let original = panel("/repo/first", "src/app.rs", 1, " before\n+target\n after\n");
	let mut reviews = create(&original, ReviewSide::New, 2);
	let other_repo = panel("/repo/second", "src/app.rs", 1, " before\n+target\n after\n");
	assert_eq!(ReviewCounts::of(&other_repo, &reviews).total, 0);
	reconcile(&other_repo, &mut reviews);
	assert!(!reviews.threads[0].orphaned);
	let mut staged = original;
	staged.review_repository.as_mut().unwrap().1 = ChangeScope::Staged;
	reconcile(&staged, &mut reviews);
	assert_eq!(ReviewCounts::of(&staged, &reviews).total, 0);
	assert!(!reviews.threads[0].orphaned);
	let other_file = panel("/repo/first", "src/other.rs", 1, " before\n+target\n after\n");
	reconcile(&other_file, &mut reviews);
	assert_eq!(placement(&other_file, &reviews.threads[0]), ReviewPlacement::Missing);
	let counts = ReviewCounts::of(&other_file, &reviews);
	assert_eq!(counts.total, 1);
	assert_eq!(counts.files.get("src/app.rs"), Some(&1));
	assert_eq!(counts.files.get("src/other.rs"), None);
}

#[test]
fn loading_or_truncated_snapshots_do_not_permanently_orphan_threads() {
	let original = panel("/repo", "src/app.rs", 1, " before\n+target\n after\n");
	for partial in 0..3 {
		let mut reviews = create(&original, ReviewSide::New, 2);
		let mut absent = original.clone();
		absent.diff.clear();
		match partial {
			0 => absent.diff_status = DiffStatus::Loading,
			1 => absent.withheld.diff_truncated = true,
			_ => absent.withheld.files_withheld = 1,
		}
		reconcile(&absent, &mut reviews);
		reconcile(&original, &mut reviews);
		assert_eq!(placement(&original, &reviews.threads[0]), ReviewPlacement::Attached(2));
	}
}

#[test]
fn resolved_threads_whose_source_disappears_still_require_attention() {
	let original = panel("/repo", "src/app.rs", 1, " before\n+target\n after\n");
	let mut reviews = create(&original, ReviewSide::New, 2);
	let id = reviews.threads[0].id;
	assert!(reviews.set_resolved(id, true));
	let mut deleted = original;
	deleted.diff.clear();
	reconcile(&deleted, &mut reviews);
	assert_eq!(ReviewCounts::of(&deleted, &reviews).total, 1);
	assert!(reviews.set_resolved(id, false));
	assert_eq!(ReviewCounts::of(&deleted, &reviews).total, 1);
}
