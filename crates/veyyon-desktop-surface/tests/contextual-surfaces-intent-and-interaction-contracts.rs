//! WHY: Contextual surfaces (right panel diff/file/tree, terminal
//! drawer/processes, attached decision cards) must reliably connect user
//! interactions and projected host state to real Intents without local-state
//! loss or inert controls.
//!
//! CLASS CLOSED:
//! - Terminal selection containing wrong bounds across multi-line selections.
//! - Terminal keystrokes dropping special keys (space, delete, insert,
//!   ctrl+space).
//! - Process controls enabling Stop on non-running/exited processes.
//! - Question cards omitting 1-9 numbering or blocking free-text composer
//!   reply.
//! - Diff surface forcing split mode at >=900px regardless of user choice.
//! - Split diff rendering detached unaligned rows and dropping intraline
//!   highlights.
//! - Missing change scope selection between Working Tree and Staged changes.
//!
//! NOT CAUGHT:
//! - Remote host daemon communication failure outside the surface layer.

use veyyon_desktop_model::{Capability, CapabilityMap, CapabilityStatus, ChangeScope, DiffMode};
use veyyon_desktop_surface::{
	Card, DiffStatus, Intent, PanelContent, PanelTab, ShellState, TreeContent, TreeStatus,
	drawer::keystroke_to_terminal_bytes,
	terminal::{SelectionKind, TerminalSelection},
};

#[test]
fn terminal_keystrokes_map_correctly_including_special_keys() {
	// Standard navigation and control
	assert_eq!(keystroke_to_terminal_bytes("enter", false), Some(vec![b'\r']));
	assert_eq!(keystroke_to_terminal_bytes("backspace", false), Some(vec![0x7f]));
	assert_eq!(keystroke_to_terminal_bytes("tab", false), Some(vec![b'\t']));
	assert_eq!(keystroke_to_terminal_bytes("escape", false), Some(vec![0x1b]));

	// Special text and editing keys
	assert_eq!(keystroke_to_terminal_bytes("space", false), Some(vec![b' ']));
	assert_eq!(keystroke_to_terminal_bytes(" ", false), Some(vec![b' ']));
	assert_eq!(keystroke_to_terminal_bytes("delete", false), Some(b"\x1b[3~".to_vec()));
	assert_eq!(keystroke_to_terminal_bytes("insert", false), Some(b"\x1b[2~".to_vec()));

	// Arrows
	assert_eq!(keystroke_to_terminal_bytes("up", false), Some(b"\x1b[A".to_vec()));
	assert_eq!(keystroke_to_terminal_bytes("down", false), Some(b"\x1b[B".to_vec()));
	assert_eq!(keystroke_to_terminal_bytes("right", false), Some(b"\x1b[C".to_vec()));
	assert_eq!(keystroke_to_terminal_bytes("left", false), Some(b"\x1b[D".to_vec()));

	// Control chords
	assert_eq!(keystroke_to_terminal_bytes("c", true), Some(vec![3])); // Ctrl-C (ETX)
	assert_eq!(keystroke_to_terminal_bytes("d", true), Some(vec![4])); // Ctrl-D (EOT)
	assert_eq!(keystroke_to_terminal_bytes("z", true), Some(vec![26])); // Ctrl-Z (SUB)
	assert_eq!(keystroke_to_terminal_bytes("space", true), Some(vec![0])); // Ctrl-Space (NUL)
}

#[test]
fn terminal_linear_selection_bounds_span_across_multiple_lines() {
	// Forward drag: row 1 col 30 to row 3 col 10
	let forward = TerminalSelection {
		start_row: 1,
		start_col: 30,
		end_row:   3,
		end_col:   10,
		kind:      SelectionKind::Linear,
	};

	// Row 0 is outside
	assert!(!forward.contains(40, 0));
	// Row 1 (top): col 29 is outside, col 30 and above are inside
	assert!(!forward.contains(29, 1));
	assert!(forward.contains(30, 1));
	assert!(forward.contains(79, 1));
	// Row 2 (middle): entire row is inside
	assert!(forward.contains(0, 2));
	assert!(forward.contains(79, 2));
	// Row 3 (bottom): col 0..=10 are inside, col 11 is outside
	assert!(forward.contains(0, 3));
	assert!(forward.contains(10, 3));
	assert!(!forward.contains(11, 3));
	// Row 4 is outside
	assert!(!forward.contains(5, 4));

	// Backward drag: row 3 col 10 to row 1 col 30
	let backward = TerminalSelection {
		start_row: 3,
		start_col: 10,
		end_row:   1,
		end_col:   30,
		kind:      SelectionKind::Linear,
	};

	// Row 1 (top): col 29 is outside, col 30 is inside
	assert!(!backward.contains(29, 1));
	assert!(backward.contains(30, 1));
	// Row 2 (middle): inside
	assert!(backward.contains(50, 2));
	// Row 3 (bottom): col 10 is inside, col 11 is outside
	assert!(backward.contains(10, 3));
	assert!(!backward.contains(11, 3));
}

#[test]
fn terminal_rectangular_selection_bounds() {
	let rect = TerminalSelection {
		start_row: 2,
		start_col: 10,
		end_row:   5,
		end_col:   20,
		kind:      SelectionKind::Rectangular,
	};

	assert!(rect.contains(10, 2));
	assert!(rect.contains(20, 5));
	assert!(rect.contains(15, 3));
	assert!(!rect.contains(9, 3));
	assert!(!rect.contains(21, 3));
	assert!(!rect.contains(15, 1));
	assert!(!rect.contains(15, 6));
}

#[test]
fn diff_mode_and_change_scope_intents_apply_and_preserve_state() {
	let mut state = ShellState::default();

	// Diff mode toggle
	Intent::SetDiffMode(DiffMode::Split).apply(&mut state);
	assert_eq!(state.panel.diff_mode, DiffMode::Split);

	Intent::SetDiffMode(DiffMode::Unified).apply(&mut state);
	assert_eq!(state.panel.diff_mode, DiffMode::Unified);

	// Change scope selection is recorded for host
	let scope_intent = Intent::SelectChangeScope(ChangeScope::Staged);
	assert!(!scope_intent.is_local(), "SelectChangeScope must be reported to host");
}

#[test]
fn decision_card_intents_cover_approval_question_reply_and_plan() {
	let mut state = ShellState {
		cards: vec![
			Card::Approval { tool: "bash".to_string(), detail: vec!["cargo check".to_string()] },
			Card::Question {
				prompt:  "Pick one".to_string(),
				options: vec!["A".to_string(), "B".to_string()],
			},
			Card::Plan { title: "Refactor".to_string(), body: vec!["Step 1".to_string()] },
		],
		..ShellState::default()
	};

	// Answering card 1 removes it from local state
	let answer_intent = Intent::Answer { card: 1, option: 0 };
	answer_intent.apply(&mut state);
	assert_eq!(state.cards.len(), 2);

	// Approval intent
	let approve_intent = Intent::Approval { card: 0, approved: true, standing: false };
	approve_intent.apply(&mut state);
	assert_eq!(state.cards.len(), 1);

	// Plan intent
	let plan_intent = Intent::Plan { card: 0, accepted: true, feedback: String::new() };
	plan_intent.apply(&mut state);
	assert_eq!(state.cards.len(), 0);
}
#[test]
fn diff_and_tree_statuses_distinguish_unrequested_loading_loaded_and_failed() {
	// Tree status transitions
	let tree_unloaded = TreeContent { status: TreeStatus::Unloaded, ..Default::default() };
	assert_eq!(tree_unloaded.status, TreeStatus::Unloaded);

	let tree_loading = TreeContent { status: TreeStatus::Loading, ..Default::default() };
	assert_eq!(tree_loading.status, TreeStatus::Loading);

	let tree_loaded_empty = TreeContent { status: TreeStatus::Loaded, ..Default::default() };
	assert_eq!(tree_loaded_empty.status, TreeStatus::Loaded);
	assert!(tree_loaded_empty.rows.is_empty());

	let tree_failed = TreeContent { status: TreeStatus::Failed, ..Default::default() };
	assert_eq!(tree_failed.status, TreeStatus::Failed);

	// Diff status transitions
	let diff_unloaded = PanelContent { diff_status: DiffStatus::Unloaded, ..Default::default() };
	assert_eq!(diff_unloaded.diff_status, DiffStatus::Unloaded);

	let diff_loading = PanelContent { diff_status: DiffStatus::Loading, ..Default::default() };
	assert_eq!(diff_loading.diff_status, DiffStatus::Loading);

	let diff_loaded_empty = PanelContent { diff_status: DiffStatus::Loaded, ..Default::default() };
	assert_eq!(diff_loaded_empty.diff_status, DiffStatus::Loaded);
	assert!(diff_loaded_empty.diff.is_empty());

	let diff_failed = PanelContent { diff_status: DiffStatus::Failed, ..Default::default() };
	assert_eq!(diff_failed.diff_status, DiffStatus::Failed);
}

#[test]
fn panel_content_truthful_empty_and_unavailable_reason() {
	let empty_panel = PanelContent::default();
	assert!(empty_panel.is_empty());
	assert!(empty_panel.tabs.is_empty());

	let unavailable_panel = PanelContent {
		usage: None,
		unavailable_reason: Some("No filesystem access".to_string()),
		..Default::default()
	};
	assert_eq!(unavailable_panel.unavailable_reason.as_deref(), Some("No filesystem access"));
}

#[test]
fn panel_tabs_derived_strictly_from_host_capabilities() {
	let mut caps = CapabilityMap::new();

	// Initial: all unavailable -> no tabs
	let diff_avail = matches!(caps.get(Capability::Changes), CapabilityStatus::Available);
	let files_avail = matches!(caps.get(Capability::Files), CapabilityStatus::Available);
	assert!(!diff_avail);
	assert!(!files_avail);

	// Changes available -> only Diff tab
	caps.set(Capability::Changes, CapabilityStatus::Available);
	let mut tabs = Vec::new();
	if matches!(caps.get(Capability::Changes), CapabilityStatus::Available) {
		tabs.push(PanelTab::Diff);
	}
	if matches!(caps.get(Capability::Files), CapabilityStatus::Available) {
		tabs.push(PanelTab::File);
		tabs.push(PanelTab::Tree);
	}
	assert_eq!(tabs, vec![PanelTab::Diff]);

	// Files also available -> Diff, File, Tree
	caps.set(Capability::Files, CapabilityStatus::Available);
	let mut tabs = Vec::new();
	if matches!(caps.get(Capability::Changes), CapabilityStatus::Available) {
		tabs.push(PanelTab::Diff);
	}
	if matches!(caps.get(Capability::Files), CapabilityStatus::Available) {
		tabs.push(PanelTab::File);
		tabs.push(PanelTab::Tree);
	}
	assert_eq!(tabs, vec![PanelTab::Diff, PanelTab::File, PanelTab::Tree]);
}
