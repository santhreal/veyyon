//! The right panel's content: what the run changed, file views, and directory
//! tree.

use veyyon_desktop_model::{
	Capability, CapabilityMap, CapabilityStatus, ChangesView, Domains, FileTreeView,
};
use veyyon_desktop_surface::{
	DiffFile, DiffStatus, PanelContent, PanelTab, TreeContent, TreeRowItem, TreeStatus,
	diff::parse_diff, right_panel::highlight_source,
};

/// Projects domain models from the store onto the right panel's content,
/// preserving window-owned state (active tab, diff mode, tree expansion,
/// selection).
#[must_use]
pub fn project_panel(
	domains: &Domains,
	capabilities: &CapabilityMap,
	previous: &PanelContent,
) -> PanelContent {
	let (diff, diff_status) = if let Some(changes) = domains.changes.as_ref() {
		let files = if !changes.diff.is_empty() {
			parse_diff(&changes.diff)
		} else if !changes.files.is_empty() {
			// If diff text is not provided, construct stub files from ChangesView.files
			changes
				.files
				.iter()
				.map(|f| DiffFile {
					path:      f.path.clone(),
					old_path:  f.previous_path.clone(),
					status:    f.status,
					additions: usize::try_from(f.additions).unwrap_or(usize::MAX),
					deletions: usize::try_from(f.deletions).unwrap_or(usize::MAX),
					rows:      Vec::new(),
				})
				.collect()
		} else {
			Vec::new()
		};
		(files, DiffStatus::Loaded)
	} else if matches!(capabilities.get(Capability::Changes), CapabilityStatus::Unavailable { .. }) {
		(Vec::new(), DiffStatus::Failed)
	} else {
		(Vec::new(), previous.diff_status)
	};

	let file = domains
		.file_content
		.as_ref()
		.map(|fc| highlight_source(&fc.path, &fc.content, fc.truncated, fc.binary));

	let tree = project_tree(
		domains.file_tree.as_ref(),
		domains.changes.as_ref(),
		capabilities,
		&previous.tree,
	);

	let mut tabs = Vec::with_capacity(3);
	if matches!(capabilities.get(Capability::Changes), CapabilityStatus::Available)
		&& !matches!(capabilities.get(Capability::PendingEdits), CapabilityStatus::Unavailable { .. })
	{
		tabs.push(PanelTab::Diff);
	}
	if matches!(capabilities.get(Capability::Files), CapabilityStatus::Available) {
		tabs.push(PanelTab::File);
		tabs.push(PanelTab::Tree);
	}

	let unavailable_reason = if tabs.is_empty() {
		if let CapabilityStatus::Unavailable { reason } = capabilities.get(Capability::Changes) {
			Some(reason.clone())
		} else if let CapabilityStatus::Unavailable { reason } = capabilities.get(Capability::Files) {
			Some(reason.clone())
		} else if matches!(
			capabilities.get(Capability::Changes),
			CapabilityStatus::UnknownUntilAttached
		) || matches!(
			capabilities.get(Capability::Files),
			CapabilityStatus::UnknownUntilAttached
		) {
			Some("Connecting to host...".to_string())
		} else {
			Some("Panel features unavailable".to_string())
		}
	} else {
		None
	};

	let active_tab = if tabs.contains(&previous.active_tab) {
		previous.active_tab
	} else {
		tabs.first().copied().unwrap_or(PanelTab::Diff)
	};

	PanelContent {
		tabs,
		active_tab,
		diff,
		diff_status,
		file,
		tree,
		diff_mode: previous.diff_mode,
		unavailable_reason,
	}
}

fn project_tree(
	file_tree: Option<&FileTreeView>,
	changes: Option<&ChangesView>,
	capabilities: &CapabilityMap,
	previous_tree: &TreeContent,
) -> TreeContent {
	if let Some(ft) = file_tree {
		let mut rows = Vec::with_capacity(ft.entries.len());
		let change_map: std::collections::HashMap<&str, (u32, u32)> = changes
			.map(|c| {
				c.files
					.iter()
					.map(|f| (f.path.as_str(), (clamp_u32(f.additions), clamp_u32(f.deletions))))
					.collect()
			})
			.unwrap_or_default();

		for entry in &ft.entries {
			let is_dir = matches!(entry.kind, veyyon_desktop_model::FileKind::Directory);
			let is_expanded = previous_tree.expanded_paths.contains(&entry.path);
			let changed = change_map.get(entry.path.as_str()).copied();

			rows.push(TreeRowItem {
				path: entry.path.clone(),
				name: entry.name.clone(),
				depth: usize::try_from(entry.depth).unwrap_or(usize::MAX),
				is_dir,
				is_expanded,
				changed,
			});
		}

		TreeContent {
			rows,
			selected_path: previous_tree.selected_path.clone(),
			expanded_paths: previous_tree.expanded_paths.clone(),
			status: TreeStatus::Loaded,
		}
	} else {
		let status =
			if matches!(capabilities.get(Capability::Files), CapabilityStatus::Unavailable { .. }) {
				TreeStatus::Failed
			} else {
				previous_tree.status
			};

		TreeContent {
			rows: Vec::new(),
			selected_path: previous_tree.selected_path.clone(),
			expanded_paths: previous_tree.expanded_paths.clone(),
			status,
		}
	}
}

fn clamp_u32(n: u64) -> u32 {
	u32::try_from(n).unwrap_or(u32::MAX)
}
