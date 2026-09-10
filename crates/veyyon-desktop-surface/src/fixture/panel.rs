//! The fixture's right panel: a modified file, its rows, and a tree that
//! names the same path.

use crate::right_panel::{
	DerivedFrom, DiffFile, DiffRow, DiffStatus, PanelContent, PanelTab, TreeContent, TreeRowItem,
	TreeStatus,
};

/// A populated fixture panel.
// A one-span intraline list is deliberate: the field holds every changed span
// and this fixture row changes one.
#[allow(
	clippy::single_range_in_vec_init,
	reason = "a one-span intraline list is deliberate: the field holds every changed span"
)]
pub(super) fn fixture_panel() -> PanelContent {
	PanelContent {
		tabs:               vec![PanelTab::Diff, PanelTab::File, PanelTab::Tree, PanelTab::Usage],
		active_tab:         PanelTab::Diff,
		diff_status:        DiffStatus::Loaded,
		unavailable_reason: None,
		// One answer for each domain the fixture states, as a host that sent
		// this panel once would leave it.
		derived_from:       DerivedFrom { changes: 1, file_content: 1, export: 0 },
		diff:               vec![DiffFile {
			path:      "crates/veyyon-desktop-surface/src/panel.rs".to_string(),
			old_path:  None,
			status:    veyyon_desktop_model::ChangeStatus::Modified,
			additions: 12,
			deletions: 3,
			rows:      vec![
				DiffRow::HunkHeader {
					old_start: 1,
					old_count: 5,
					new_start: 1,
					new_count: 6,
					symbol:    Some("pub fn right_panel".to_string()),
				},
				DiffRow::Context {
					old_line: 1,
					new_line: 1,
					text:     "use veyyon_desktop_kit::TokenSet;".to_string(),
				},
				DiffRow::Removed {
					old_line:  2,
					text:      "fn old_tab_strip() {".to_string(),
					intraline: Vec::from([3..6]),
				},
				DiffRow::Added {
					new_line:  2,
					text:      "fn new_tab_strip() {".to_string(),
					intraline: Vec::from([3..6]),
				},
				DiffRow::Context { old_line: 3, new_line: 3, text: "}".to_string() },
			],
		}],
		file:               None,
		tree:               TreeContent {
			rows:           vec![
				TreeRowItem {
					path:        "crates".to_string(),
					name:        "crates".to_string(),
					depth:       0,
					is_dir:      true,
					is_expanded: true,
					changed:     None,
				},
				TreeRowItem {
					path:        "crates/veyyon-desktop-surface".to_string(),
					name:        "veyyon-desktop-surface".to_string(),
					depth:       1,
					is_dir:      true,
					is_expanded: true,
					changed:     None,
				},
				TreeRowItem {
					path:        "crates/veyyon-desktop-surface/src/panel.rs".to_string(),
					name:        "panel.rs".to_string(),
					depth:       2,
					is_dir:      false,
					is_expanded: false,
					changed:     Some((12, 3)),
				},
			],
			selected_path:  None,
			expanded_paths: std::collections::BTreeSet::new(),
			status:         TreeStatus::Loaded,
		},
		diff_mode:          veyyon_desktop_model::DiffMode::Unified,
		usage:              Some(veyyon_desktop_model::UsageTotals {
			input_tokens:         184_213,
			output_tokens:        12_940,
			cache_read_tokens:    1_402_887,
			cache_write_tokens:   96_004,
			orchestration_tokens: 3_118,
			premium_requests:     42,
			cost_microusd:        Some(3_940_000),
		}),
	}
}
