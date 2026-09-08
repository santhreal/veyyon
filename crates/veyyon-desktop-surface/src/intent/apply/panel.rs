//! What a panel intent changes in the right panel the window owns (§5.14).

use crate::{
	model::ShellState,
	right_panel::{DiffRow, PanelTab},
	tool_view::ToolViewTarget,
};

/// Opens the panel on `tab`, revealing it when it was collapsed.
const fn reveal(state: &mut ShellState, tab: PanelTab) {
	state.keymap.panel_collapsed = false;
	state.panel.active_tab = tab;
}

/// Shows a file in the panel's file tab.
pub fn open_file(state: &mut ShellState, path: &str) {
	reveal(state, PanelTab::File);
	state.panel.tree.selected_path = Some(path.to_string());
}

/// Shows the usage tab, listing it when the host has not yet.
pub fn open_usage(state: &mut ShellState) {
	reveal(state, PanelTab::Usage);
	// The turn footer can be clicked before the host has listed the tab.
	// Adding it here keeps the click answerable; a host that reports usage
	// unavailable drops it again on the next projection.
	if !state.panel.tabs.contains(&PanelTab::Usage) {
		state.panel.tabs.push(PanelTab::Usage);
	}
}

/// Shows the diff tab for a change scope.
pub const fn select_change_scope(state: &mut ShellState) {
	reveal(state, PanelTab::Diff);
}

/// Shows the file a tool view points at; other targets are the host's to open.
pub fn open_tool_target(state: &mut ShellState, target: &ToolViewTarget) {
	if let ToolViewTarget::File { path, .. } = target {
		open_file(state, path);
	}
}

/// Flips one tree node open or closed, in the set and in the drawn rows.
pub fn toggle_tree_node(state: &mut ShellState, path: &str) {
	if state.panel.tree.expanded_paths.contains(path) {
		state.panel.tree.expanded_paths.remove(path);
	} else {
		state.panel.tree.expanded_paths.insert(path.to_string());
	}
	for row in &mut state.panel.tree.rows {
		if row.path == *path {
			row.is_expanded = !row.is_expanded;
		}
	}
}

/// Replaces a collapsed diff run with the context rows it stood for.
pub fn expand_context(state: &mut ShellState, file: usize, row: usize) {
	let Some(diff_file) = state.panel.diff.get_mut(file) else {
		return;
	};
	let Some(DiffRow::Collapsed { hidden, before_line, after_line }) =
		diff_file.rows.get(row).cloned()
	else {
		return;
	};
	let mut expanded = Vec::with_capacity(hidden);
	for offset in 0..hidden {
		expanded.push(DiffRow::Context {
			old_line: before_line + 1 + offset,
			new_line: after_line + 1 + offset,
			text:     String::new(),
		});
	}
	diff_file.rows.splice(row..=row, expanded);
}
