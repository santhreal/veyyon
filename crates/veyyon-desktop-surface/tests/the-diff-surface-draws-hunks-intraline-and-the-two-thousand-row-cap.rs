//! WHY: a diff surface is judged by whether it renders file modifications,
//! intraline word-level highlights, hunk headers with symbols, and handles
//! large generated files without dropping frames.
//!
//! The defect class here is "a diff parser misidentifies renames, misses
//! intraline spans, drops symbols, or overflows memory when diffing large
//! generated files".
//!
//! This suite tests unified diff parsing of renames, binary files, hunk
//! symbols, word-level intraline highlights, the 2,000 changed-row ceiling, and
//! headless rendering in both unified and split modes.

use std::{fmt::Write as _, path::Path};

use veyyon_desktop_kit::{load_bundled_theme, load_bundled_tokens};
use veyyon_desktop_model::{ChangeStatus, DiffMode};
use veyyon_desktop_scene::headless::{RenderOptions, headless_context, render_view_captured};
use veyyon_desktop_surface::{
	DiffRow, Intent, PanelContent, PanelTab, ShellState, ShellView, diff::parse_diff, install_tokens,
};
use veyyon_gpui::{App, AppContext};

fn make_test_diff_text() -> String {
	let mut s = String::new();

	// 1. Renamed file with hunk symbol and intraline change
	s.push_str("diff --git a/old_path.rs b/new_path.rs\n");
	s.push_str("similarity index 95%\n");
	s.push_str("rename from old_path.rs\n");
	s.push_str("rename to new_path.rs\n");
	s.push_str("index 1234567..89abcdef 100644\n");
	s.push_str("--- a/old_path.rs\n");
	s.push_str("+++ b/new_path.rs\n");
	s.push_str("@@ -1,4 +1,4 @@ pub fn calculate_total()\n");
	s.push_str(" context before\n");
	s.push_str("-let total_count = 100;\n");
	s.push_str("+let total_count = 200;\n");
	s.push_str(" context after\n");

	// 2. Binary file
	s.push_str("diff --git a/assets/logo.png b/assets/logo.png\n");
	s.push_str("index 0000000..89abcdef 100644\n");
	s.push_str("Binary files a/assets/logo.png and b/assets/logo.png differ\n");

	// 3. Large generated file with 2,500 added lines
	s.push_str("diff --git a/src/generated.rs b/src/generated.rs\n");
	s.push_str("new file mode 100644\n");
	s.push_str("index 0000000..89abcdef\n");
	s.push_str("--- /dev/null\n");
	s.push_str("+++ b/src/generated.rs\n");
	s.push_str("@@ -0,0 +1,2500 @@ pub fn all_constants()\n");
	for i in 0..2500 {
		writeln!(s, "+pub const CONST_{i}: u32 = {i};").expect("writing to a String cannot fail");
	}

	s
}

#[test]
fn diff_parser_handles_renames_binary_symbols_and_row_cap() {
	let diff_text = make_test_diff_text();
	let files = parse_diff(&diff_text);

	assert_eq!(files.len(), 3, "must parse exactly 3 files from diff fixture");

	// File 1: Rename with intraline and symbol
	let file1 = &files[0];
	assert_eq!(file1.path, "new_path.rs");
	assert_eq!(file1.old_path, Some("old_path.rs".to_string()));
	assert_eq!(file1.status, ChangeStatus::Renamed);
	assert_eq!(file1.additions, 1);
	assert_eq!(file1.deletions, 1);

	let header_row = file1
		.rows
		.iter()
		.find(|r| matches!(r, DiffRow::HunkHeader { .. }));
	assert!(
		matches!(header_row, Some(DiffRow::HunkHeader { symbol: Some(sym), .. }) if sym == "pub fn calculate_total()"),
		"hunk header must capture the symbol: {header_row:?}"
	);

	let removed_row = file1
		.rows
		.iter()
		.find(|r| matches!(r, DiffRow::Removed { .. }));
	let added_row = file1
		.rows
		.iter()
		.find(|r| matches!(r, DiffRow::Added { .. }));

	match (removed_row, added_row) {
		(
			Some(DiffRow::Removed { text: old_t, intraline: old_hl, .. }),
			Some(DiffRow::Added { text: new_t, intraline: new_hl, .. }),
		) => {
			assert_eq!(old_t, "let total_count = 100;");
			assert_eq!(new_t, "let total_count = 200;");
			assert!(!old_hl.is_empty(), "removed line must have intraline spans");
			assert!(!new_hl.is_empty(), "added line must have intraline spans");
			assert_eq!(&old_t[old_hl[0].clone()], "100");
			assert_eq!(&new_t[new_hl[0].clone()], "200");
		},
		other => panic!("expected removed and added rows with intraline, got {other:?}"),
	}

	// File 2: Binary file
	let file2 = &files[1];
	assert_eq!(file2.path, "assets/logo.png");
	assert!(
		file2
			.rows
			.iter()
			.any(|r| matches!(r, DiffRow::Binary { .. })),
		"binary file must contain DiffRow::Binary"
	);

	// File 3: 2,500 changed lines capped at 2,000 with a Truncated row
	let file3 = &files[2];
	assert_eq!(file3.path, "src/generated.rs");
	assert_eq!(file3.additions, 2500);

	let added_count = file3
		.rows
		.iter()
		.filter(|r| matches!(r, DiffRow::Added { .. }))
		.count();
	assert_eq!(added_count, 2000, "added rows must be capped at exactly 2,000");

	let truncated_row = file3
		.rows
		.iter()
		.find(|r| matches!(r, DiffRow::Truncated { .. }));
	assert!(
		matches!(truncated_row, Some(DiffRow::Truncated { remaining: 500 })),
		"must have a truncation row stating remaining 500 rows, got: {truncated_row:?}"
	);
}

#[test]
fn diff_surface_renders_in_shell_view_and_toggles_mode() {
	let diff_text = make_test_diff_text();
	let files = parse_diff(&diff_text);

	let mut state = ShellState {
		panel: PanelContent {
			tabs:       vec![PanelTab::Diff, PanelTab::File, PanelTab::Tree],
			active_tab: PanelTab::Diff,
			diff:       files,
			file:       None,
			tree:       Default::default(),
			diff_mode:  DiffMode::Unified,
		},
		..ShellState::default()
	};

	let mut cx = headless_context().expect("headless context");
	let tokens = load_bundled_tokens().expect("tokens");
	let theme = load_bundled_theme("dark").expect("theme");

	// 1. Render in unified mode
	let captured = render_view_captured(
		&mut cx,
		&RenderOptions { width: 1440, height: 900, scale_factor: 1.0, ..RenderOptions::default() },
		|_window, app: &mut App| {
			let installed =
				install_tokens(app, &tokens, &theme, Path::new("surface")).expect("installed");
			app.new(|_| ShellView::new(installed, state.clone()))
		},
	)
	.expect("render unified diff");

	assert!(!captured.hitboxes.is_empty(), "frame must capture hitboxes");

	// 2. Dispatch SetDiffMode(DiffMode::Split)
	let installed = cx
		.update(|app| install_tokens(app, &tokens, &theme, Path::new("surface")))
		.expect("installed");
	let mut view = ShellView::new(installed, state.clone());
	view.dispatch(Intent::SetDiffMode(DiffMode::Split));
	assert_eq!(
		view.state().panel.diff_mode,
		DiffMode::Split,
		"SetDiffMode must switch to Split mode"
	);

	state.panel.diff_mode = DiffMode::Split;

	// 3. Render in split mode
	let captured_split = render_view_captured(
		&mut cx,
		&RenderOptions { width: 1440, height: 900, scale_factor: 1.0, ..RenderOptions::default() },
		|_window, app: &mut App| {
			let installed =
				install_tokens(app, &tokens, &theme, Path::new("surface")).expect("installed");
			app.new(|_| ShellView::new(installed, state.clone()))
		},
	)
	.expect("render split diff");

	assert!(!captured_split.hitboxes.is_empty(), "split frame must capture hitboxes");
}
