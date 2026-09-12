//! Contextual review anchoring over the same parsed lines the diff surface
//! draws.

use veyyon_desktop_model::review::{
	ReviewAnchor, ReviewLine, ReviewPlacement, ReviewSide, ReviewThread, ReviewsStore,
};

use super::{DiffFile, DiffRow, DiffStatus, PanelContent};

/// Extracts one source side; gaps between hunks remain gaps in line numbers.
#[must_use]
pub fn source_lines(file: &DiffFile, side: ReviewSide) -> Vec<ReviewLine<'_>> {
	file
		.rows
		.iter()
		.filter_map(|row| match (side, row) {
			(
				ReviewSide::Old,
				DiffRow::Context { old_line, text, .. } | DiffRow::Removed { old_line, text, .. },
			) => Some(ReviewLine { number: *old_line, text }),
			(
				ReviewSide::New,
				DiffRow::Context { new_line, text, .. } | DiffRow::Added { new_line, text, .. },
			) => Some(ReviewLine { number: *new_line, text }),
			_ => None,
		})
		.collect()
}

pub fn anchor_for_line(
	panel: &PanelContent,
	path: &str,
	side: ReviewSide,
	line: usize,
) -> Option<ReviewAnchor> {
	let (repository, scope) = panel.review_repository.as_ref()?;
	let file = panel.diff.iter().find(|file| file.path == path)?;
	ReviewAnchor::capture(repository, path, *scope, side, line, &source_lines(file, side))
}

/// An anchor never crosses a repository, file or index/working-tree boundary.
#[must_use]
pub fn placement(panel: &PanelContent, thread: &ReviewThread) -> ReviewPlacement {
	let anchor = &thread.anchor;
	if thread.orphaned {
		return ReviewPlacement::Missing;
	}
	if !in_repository(panel, thread) {
		return ReviewPlacement::Missing;
	}
	let Some(file) = panel.diff.iter().find(|file| file.path == anchor.file) else {
		return ReviewPlacement::Missing;
	};
	anchor.locate(&source_lines(file, anchor.side))
}

#[must_use]
pub fn in_repository(panel: &PanelContent, thread: &ReviewThread) -> bool {
	panel
		.review_repository
		.as_ref()
		.is_some_and(|(repository, scope)| {
			*repository == thread.anchor.repository && *scope == thread.anchor.scope
		})
}

/// Orphans require attention even when the thread was resolved before rediff.
#[must_use]
pub const fn unresolved(thread: &ReviewThread) -> bool {
	!thread.resolved || thread.orphaned || thread.anchor.ambiguous
}

/// Records identity loss while a completed snapshot is current. Orphans are
/// sticky.
pub fn reconcile(panel: &PanelContent, reviews: &mut ReviewsStore) {
	if !complete_snapshot(panel) {
		return;
	}
	for thread in &mut reviews.threads {
		if !thread.orphaned
			&& in_repository(panel, thread)
			&& !matches!(placement(panel, thread), ReviewPlacement::Attached(_))
		{
			thread.orphaned = true;
		}
	}
}

/// Partial or unavailable source context cannot establish that an anchor was
/// deleted.
#[must_use]
pub fn complete_snapshot(panel: &PanelContent) -> bool {
	panel.diff_status == DiffStatus::Loaded
		&& !panel.withheld.diff_truncated
		&& panel.withheld.files_withheld == 0
		&& !panel.diff.iter().any(|file| {
			file.rows.iter().any(|row| {
				matches!(
					row,
					DiffRow::Truncated { .. } | DiffRow::Unavailable { .. } | DiffRow::Collapsed { .. }
				)
			})
		})
}
