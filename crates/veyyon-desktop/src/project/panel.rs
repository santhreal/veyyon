//! The right panel's content: what the run changed, file views, and directory
//! tree.

use veyyon_desktop_model::{ChangesView, Domains, FileTreeView};
use veyyon_desktop_surface::{
	DiffFile, PanelContent, PanelTab, TreeContent, TreeRowItem, diff::parse_diff,
	right_panel::highlight_source,
};

/// Projects domain models from the store onto the right panel's content,
/// preserving window-owned state (active tab, diff mode, tree expansion,
/// selection).
#[must_use]
pub fn project_panel(domains: &Domains, previous: &PanelContent) -> PanelContent {
	let diff = domains
		.changes
		.as_ref()
		.map(|changes| {
			if !changes.diff.is_empty() {
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
			}
		})
		.unwrap_or_default();

	let file = domains
		.file_content
		.as_ref()
		.map(|fc| highlight_source(&fc.path, &fc.content, fc.truncated, fc.binary));

	let tree = project_tree(domains.file_tree.as_ref(), domains.changes.as_ref(), &previous.tree);

	let tabs = vec![PanelTab::Diff, PanelTab::File, PanelTab::Tree];
	let active_tab = if tabs.contains(&previous.active_tab) {
		previous.active_tab
	} else {
		PanelTab::Diff
	};

	PanelContent { tabs, active_tab, diff, file, tree, diff_mode: previous.diff_mode }
}

fn project_tree(
	file_tree: Option<&FileTreeView>,
	changes: Option<&ChangesView>,
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
		}
	} else if let Some(changes) = changes {
		TreeContent {
			rows:           tree_rows_from_changes(changes),
			selected_path:  previous_tree.selected_path.clone(),
			expanded_paths: previous_tree.expanded_paths.clone(),
		}
	} else {
		TreeContent::default()
	}
}

/// Builds tree rows from a changes view when no full file tree is loaded.
#[must_use]
pub fn tree_rows_from_changes(changes: &ChangesView) -> Vec<TreeRowItem> {
	let mut files: Vec<_> = changes.files.iter().collect();
	files.sort_by(|a, b| a.path.cmp(&b.path));

	let mut rows = Vec::with_capacity(files.len());
	let mut open: Vec<&str> = Vec::new();
	for file in files {
		let mut parts = file
			.path
			.split('/')
			.filter(|part| !part.is_empty())
			.peekable();
		let mut depth = 0;
		let mut current_path = String::new();

		while let Some(part) = parts.next() {
			if !current_path.is_empty() {
				current_path.push('/');
			}
			current_path.push_str(part);

			let is_file = parts.peek().is_none();
			if is_file {
				open.truncate(depth);
				rows.push(TreeRowItem {
					path: file.path.clone(),
					name: part.to_string(),
					depth,
					is_dir: false,
					is_expanded: false,
					changed: Some((clamp_u32(file.additions), clamp_u32(file.deletions))),
				});
				break;
			}
			if open.get(depth) != Some(&part) {
				open.truncate(depth);
				open.push(part);
				rows.push(TreeRowItem {
					path: current_path.clone(),
					name: part.to_string(),
					depth,
					is_dir: true,
					is_expanded: true,
					changed: None,
				});
			}
			depth += 1;
		}
	}
	rows
}

fn clamp_u32(n: u64) -> u32 {
	u32::try_from(n).unwrap_or(u32::MAX)
}
