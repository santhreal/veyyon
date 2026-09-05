//! Fixtures for the suites that dispatch intents at a `ShellState`. Each suite
//! pulls in only what it uses, so a helper unused by one binary is expected.
#![allow(dead_code, reason = "each test binary uses a subset of these fixtures")]

pub mod settings_seed;
pub mod shed;

use std::{collections::BTreeSet, path::PathBuf};

use veyyon_desktop_model::{ChangeStatus, DiffMode};
use veyyon_desktop_surface::{
	Attachment, Badge, Card, DiffFile, DiffRow, Intent, PanelContent, PanelTab, Row, Section,
	ShellState, TreeContent, TreeRowItem,
	composer::{MediaType, TurnPhase, payload_for},
	drawer::{DrawerContent, DrawerTab, ProcessRow},
	terminal::{Cell, CellStyle, Ink},
};

/// A one-signature PNG under a fixed name: enough for a reducer, which never
/// decodes it, and small enough that a sweep of every intent stays cheap.
pub fn attachment() -> Attachment {
	let bytes = b"\x89PNG\r\n\x1a\n".to_vec();
	Attachment::from_path(
		PathBuf::from("shot.png"),
		MediaType::Png,
		payload_for(MediaType::Png, bytes),
	)
}

/// A send carrying `text` and one image.
pub fn send(text: &str) -> Intent {
	Intent::Send { text: text.to_owned(), attachments: vec![attachment()] }
}

/// One drawn terminal cell, so a drawer has output to keep or to clear.
pub const fn cell() -> Cell {
	Cell {
		c:      'x',
		ink:    Ink::Default,
		bg_ink: Ink::Default,
		style:  CellStyle::new(),
		width:  1,
	}
}

/// A state with two sections, three tabs, three cards and a closed drawer.
///
/// Built here rather than taken from `fixture` because these assertions name
/// exact positions and counts, and the fixture exists to be awkward to draw.
pub fn state() -> ShellState {
	ShellState {
		title: "first".to_owned(),
		sections: vec![
			(Section::Live, vec![
				Row {
					id:       7,
					title:    "first".to_owned(),
					subtitle: String::new(),
					badge:    Some(Badge::Working),
					meta:     None,
				},
				Row {
					id:       9,
					title:    "second".to_owned(),
					subtitle: String::new(),
					badge:    None,
					meta:     None,
				},
			]),
			(Section::Parked, vec![Row {
				id:       11,
				title:    "third".to_owned(),
				subtitle: String::new(),
				badge:    None,
				meta:     None,
			}]),
		],
		transcript: Vec::new(),
		turn: TurnPhase::Idle,
		run_status: None,
		panel: PanelContent {
			tabs:       vec![PanelTab::Diff, PanelTab::File, PanelTab::Tree],
			active_tab: PanelTab::Diff,
			diff:       vec![DiffFile {
				path:      "src/main.rs".to_string(),
				old_path:  None,
				status:    ChangeStatus::Modified,
				additions: 1,
				deletions: 1,
				rows:      vec![DiffRow::Collapsed { hidden: 10, before_line: 0, after_line: 0 }],
			}],
			file:       None,
			tree:       TreeContent {
				rows:           vec![TreeRowItem {
					path:        "src".to_string(),
					name:        "src".to_string(),
					depth:       0,
					is_dir:      true,
					is_expanded: false,
					changed:     None,
				}],
				selected_path:  None,
				expanded_paths: BTreeSet::new(),
			},
			diff_mode:  DiffMode::Unified,
		},
		cards: vec![
			Card::Approval { tool: "bash".to_owned(), detail: vec!["rm -rf build".to_owned()] },
			Card::Question {
				prompt:  "Which target?".to_owned(),
				options: vec!["debug".to_owned(), "release".to_owned()],
			},
			Card::Plan { title: "Split the loaders".to_owned(), body: vec!["four files".to_owned()] },
		],
		drawer: DrawerContent {
			tabs:           vec![
				DrawerTab::Terminal { id: "t1".to_owned(), title: "Terminal 1".to_owned() },
				DrawerTab::Terminal { id: "t2".to_owned(), title: "Terminal 2".to_owned() },
			],
			active_tab:     0,
			grid_rows:      vec![vec![cell()]],
			cursor_col:     0,
			cursor_row:     0,
			cursor_visible: true,
			title:          "term".to_owned(),
			scroll_offset:  1,
			processes:      vec![ProcessRow {
				name:          "build".to_owned(),
				pid:           Some(123),
				status:        "running".to_owned(),
				elapsed_label: "10s".to_owned(),
				terminated_by: None,
				exit_code:     None,
			}],
			selection:      None,
			search:         None,
		},
		drawer_open: false,
		current_id: 7,
		..ShellState::default()
	}
}
