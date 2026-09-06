//! WHY: the file view and tree view are the inspection tenants of the right
//! panel. The defect class here is syntax highlighting falling back to plain
//! unstyled text or hardcoded colors rather than design system roles, and
//! directory nodes in the tree failing to toggle expansion in place on click.
//!
//! This suite tests syntect highlighting mapping to `ColorRole`s, tree row
//! expansion toggling via `Intent::ToggleTreeNode`, file opening via
//! `Intent::OpenFile`, and headless frame rendering of both tabs.

use std::path::Path;

use veyyon_desktop_kit::{ColorRole, load_bundled_theme, load_bundled_tokens};
use veyyon_desktop_model::DiffMode;
use veyyon_desktop_scene::headless::{RenderOptions, headless_context, render_view_captured};
use veyyon_desktop_surface::{
	Intent, PanelContent, PanelTab, ShellState, ShellView, TreeContent, TreeRowItem, install_tokens,
	right_panel::highlight_source,
};
use veyyon_gpui::{App, AppContext};

#[test]
fn file_view_highlights_rust_syntax_onto_token_roles() {
	let snippet = "pub fn add_numbers(x: u32, y: u32) -> u32 {\n\t// compute sum\n\tx + y\n}";
	let file = highlight_source("src/calc.rs", snippet, false, false);

	assert_eq!(file.lines.len(), 4, "must have 4 highlighted lines");
	assert_eq!(file.path, "src/calc.rs");
	assert!(!file.binary);
	assert!(!file.truncated);

	// Line 1: fn header should contain keyword spans (Accent role)
	let line1 = &file.lines[0];
	let has_accent = line1.spans.iter().any(|s| s.role == ColorRole::Accent);
	assert!(has_accent, "line 1 must have keyword tokens styled with ColorRole::Accent");

	// Line 2: comment line should have Muted role
	let line2 = &file.lines[1];
	let has_muted = line2.spans.iter().any(|s| s.role == ColorRole::Muted);
	assert!(has_muted, "comment line must have tokens styled with ColorRole::Muted");
}

#[test]
fn tree_expands_and_collapses_in_place_and_opens_file() {
	let mut state = ShellState {
		panel: PanelContent {
			tabs:       vec![PanelTab::Diff, PanelTab::File, PanelTab::Tree],
			active_tab: PanelTab::Tree,
			diff:       Vec::new(),
			file:       Some(highlight_source("src/lib.rs", "pub fn init() {}", false, false)),
			tree:       TreeContent {
				rows:           vec![
					TreeRowItem {
						path:        "src".to_string(),
						name:        "src".to_string(),
						depth:       0,
						is_dir:      true,
						is_expanded: true,
						changed:     None,
					},
					TreeRowItem {
						path:        "src/lib.rs".to_string(),
						name:        "lib.rs".to_string(),
						depth:       1,
						is_dir:      false,
						is_expanded: false,
						changed:     Some((5, 1)),
					},
				],
				selected_path:  None,
				expanded_paths: {
					let mut s = std::collections::BTreeSet::new();
					s.insert("src".to_string());
					s
				},
			},
			diff_mode:  DiffMode::Unified,
		},
		..ShellState::default()
	};

	let mut cx = headless_context().expect("headless context");
	let tokens = load_bundled_tokens().expect("tokens");
	let theme = load_bundled_theme("dark").expect("theme");

	let view_entity = cx.update(|app| {
		let installed =
			install_tokens(app, &tokens, &theme, Path::new("surface")).expect("installed");
		app.new(|_| ShellView::new(installed, state.clone()))
	});
	cx.update(|app| {
		view_entity.update(app, |view, cx| {
			// 1. Toggle tree node "src" (collapse)
			view.dispatch(Intent::ToggleTreeNode("src".to_string()), cx);
			assert!(
				!view.state().panel.tree.expanded_paths.contains("src"),
				"expanded_paths must remove collapsed node"
			);
			assert!(!view.state().panel.tree.rows[0].is_expanded, "row is_expanded must be false");

			// 2. Toggle tree node "src" again (expand)
			view.dispatch(Intent::ToggleTreeNode("src".to_string()), cx);
			assert!(
				view.state().panel.tree.expanded_paths.contains("src"),
				"expanded_paths must contain re-expanded node"
			);
			assert!(view.state().panel.tree.rows[0].is_expanded, "row is_expanded must be true");

			// 3. Open file "src/lib.rs"
			view.dispatch(Intent::OpenFile("src/lib.rs".to_string()), cx);
			assert_eq!(
				view.state().panel.active_tab,
				PanelTab::File,
				"OpenFile must switch active tab to File"
			);
			assert_eq!(
				view.state().panel.tree.selected_path.as_deref(),
				Some("src/lib.rs"),
				"OpenFile must update selected_path"
			);
		});
	});
	// 4. Render Tree tab headlessly
	let captured_tree = render_view_captured(
		&mut cx,
		&RenderOptions { width: 1440, height: 900, scale_factor: 1.0, ..RenderOptions::default() },
		|_window, app: &mut App| {
			let installed =
				install_tokens(app, &tokens, &theme, Path::new("surface")).expect("installed");
			app.new(|_| ShellView::new(installed, state.clone()))
		},
	)
	.expect("render tree tab");
	assert!(!captured_tree.hitboxes.is_empty(), "tree frame must capture hitboxes");

	// 5. Render File tab headlessly
	state.panel.active_tab = PanelTab::File;
	let captured_file = render_view_captured(
		&mut cx,
		&RenderOptions { width: 1440, height: 900, scale_factor: 1.0, ..RenderOptions::default() },
		|_window, app: &mut App| {
			let installed =
				install_tokens(app, &tokens, &theme, Path::new("surface")).expect("installed");
			app.new(|_| ShellView::new(installed, state.clone()))
		},
	)
	.expect("render file tab");
	assert!(!captured_file.hitboxes.is_empty(), "file frame must capture hitboxes");
}
