//! Filtering, grouping, and navigation for diagnostics.

use veyyon_gui_core::model::{
	DiagnosticLevel, DiagnosticView, DiagnosticsSnapshot, FileId, NoticeId,
};

/// One severity section inside a file.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SeverityGroup<'a> {
	pub level:       DiagnosticLevel,
	pub diagnostics: Vec<&'a DiagnosticView>,
}

/// One file section in the Problems tab.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProblemGroup<'a> {
	pub file:       &'a FileId,
	pub path:       &'a str,
	pub severities: Vec<SeverityGroup<'a>>,
}

/// Visible diagnostics grouped by their producer-supplied file identity.
pub fn groups<'a>(
	snapshot: &'a DiagnosticsSnapshot,
	query: &str,
	levels: &[DiagnosticLevel],
) -> Vec<ProblemGroup<'a>> {
	let query = query.trim().to_lowercase();
	snapshot
		.files
		.iter()
		.filter_map(|(file, diagnostics)| {
			let matches = |diagnostic: &&'a DiagnosticView| {
				(levels.is_empty() || levels.contains(&diagnostic.level))
					&& (query.is_empty()
						|| diagnostic.message.to_lowercase().contains(&query)
						|| diagnostic.source.to_lowercase().contains(&query)
						|| diagnostic
							.path
							.as_deref()
							.is_some_and(|path| path.to_lowercase().contains(&query)))
			};
			let visible: Vec<_> = diagnostics.iter().filter(matches).collect();
			let path = visible.first()?.path.as_deref().unwrap_or("Unknown file");
			let severities =
				[DiagnosticLevel::Error, DiagnosticLevel::Warning, DiagnosticLevel::Information]
					.into_iter()
					.filter_map(|level| {
						let diagnostics: Vec<_> = visible
							.iter()
							.copied()
							.filter(|diagnostic| diagnostic.level == level)
							.collect();
						(!diagnostics.is_empty()).then_some(SeverityGroup { level, diagnostics })
					})
					.collect();
			Some(ProblemGroup { file, path, severities })
		})
		.collect()
}

pub fn visible_count(groups: &[ProblemGroup<'_>]) -> usize {
	groups
		.iter()
		.flat_map(|group| &group.severities)
		.map(|severity| severity.diagnostics.len())
		.sum()
}

/// Next/previous navigation wraps within the filtered result set.
pub fn adjacent(
	groups: &[ProblemGroup<'_>],
	selected: Option<&NoticeId>,
	direction: i8,
) -> Option<NoticeId> {
	let rows: Vec<_> = groups
		.iter()
		.flat_map(|group| &group.severities)
		.flat_map(|severity| severity.diagnostics.iter().copied())
		.collect();
	if rows.is_empty() {
		return None;
	}
	let current = selected
		.and_then(|selected| rows.iter().position(|row| &row.id == selected))
		.unwrap_or(if direction < 0 { 0 } else { rows.len() - 1 });
	let next = if direction < 0 {
		current.checked_sub(1).unwrap_or(rows.len() - 1)
	} else {
		(current + 1) % rows.len()
	};
	Some(rows[next].id.clone())
}
