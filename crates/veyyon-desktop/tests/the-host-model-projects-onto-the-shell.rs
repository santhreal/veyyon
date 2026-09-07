//! WHY: the window drew a fixture. Nothing turned what the host reported into
//! what the surfaces draw, so a session the host listed, a changes snapshot,
//! a terminal it ran and the model it reported reached no pixel. `project` is
//! that turn; this suite is its session, changes, drawer and footer half.
//!
//! CLASS CLOSED: a member of the protocol model the projection drops or
//! misplaces. The partitions and badges are swept from their enums at run
//! time, so a variant added to the model fails here until the projection
//! states what it draws.
//!
//! NOT CAUGHT: whether the shell draws the projected state correctly; that is
//! the surface crate's pixel suites. Whether the host sends what the model
//! expects; that is the live handshake suite. The transcript half is in
//! `a-transcript-projects-as-turns-of-blocks.rs`; the usage half is in
//! `the-accounting-reaches-the-usage-tab-the-footer-opens.rs`; the intent
//! direction is in `an-intent-maps-to-the-actions-the-host-answers.rs`.

mod support;

use std::{collections::HashMap, fmt::Write as _};

use strum::IntoEnumIterator as _;
use support::{NOW_MS, session, terminal};
use veyyon_desktop::{PANE_LINE_CEILING, SessionIndex, drawer_lines, project};
use veyyon_desktop_model::{
	BadgeKind, Capability, CapabilityStatus, ChangeScope, ChangeStatus, ChangedFile, ChangesView,
	FileKind, FileNode, FileTreeView, HostEvent, QueuePartition, SessionId, SnapshotSection, Store,
	TerminalOutputChunk, TerminalStatus, reduce,
};
use veyyon_desktop_surface::{Badge, DiffStatus, Section, ShellState, TreeStatus};

/// One tree row as the assertions read it: depth, name, line counts.
type TreeCell<'a> = (usize, &'a str, Option<(u32, u32)>);

/// Every badge the row draws, so a variant added to the surface's vocabulary
/// without a projection fails here.
const SURFACE_BADGES: [Badge; 8] = [
	Badge::Working,
	Badge::Watching,
	Badge::Approval,
	Badge::Input,
	Badge::Plan,
	Badge::Due,
	Badge::Done,
	Badge::Failed,
];

#[test]
fn every_partition_lands_in_its_section_and_a_row_keeps_its_id_across_a_move() {
	let mut store = Store::new();
	for (n, partition) in QueuePartition::ALL.iter().enumerate() {
		store.sessions.insert(session(&format!("s{n}"), *partition));
	}
	let mut index = SessionIndex::new();
	let mut state = ShellState::default();
	project(&store, &mut index, &HashMap::new(), NOW_MS, &mut state);

	let sections: Vec<Section> = state.sections.iter().map(|(section, _)| *section).collect();
	assert_eq!(
		sections,
		[Section::Unsent, Section::Pinned, Section::Live, Section::Deferred, Section::Parked],
		"one section per partition, in queue order"
	);
	for (section, rows) in &state.sections {
		assert_eq!(rows.len(), 1, "{section:?} holds its one session");
	}
	let first_id = state.sections[0].1[0].id;
	assert_ne!(first_id, 0, "zero is the id of no session");

	// Move s0 from Unsent to Parked: the row id follows the session.
	let mut moved = session("s0", QueuePartition::Parked);
	moved.title = "moved".to_string();
	store.sessions.insert(moved);
	project(&store, &mut index, &HashMap::new(), NOW_MS, &mut state);
	let parked = &state.sections.last().expect("parked section").1;
	assert!(
		parked
			.iter()
			.any(|row| row.id == first_id && row.title == "moved")
	);
	assert!(
		!state
			.sections
			.iter()
			.any(|(section, _)| *section == Section::Unsent),
		"an emptied partition draws no section"
	);
	assert_eq!(index.session_of(first_id), Some(&SessionId::from("s0")));
}

#[test]
fn every_badge_variant_reaches_the_row_and_the_run_bar_states_its_detail() {
	for kind in BadgeKind::iter() {
		let mut store = Store::new();
		store.sessions.insert(session("s", QueuePartition::Live));
		store.persisted.shell.active_session = Some(SessionId::from("s"));
		let detail = support::seed_badge(&mut store, "s", kind);
		let mut state = ShellState::default();
		project(&store, &mut SessionIndex::new(), &HashMap::new(), NOW_MS, &mut state);

		let row = state
			.sections
			.iter()
			.flat_map(|(_, rows)| rows)
			.find(|row| row.title == "title s")
			.unwrap_or_else(|| panic!("{kind:?} projects no row"));
		let badge = row
			.badge
			.unwrap_or_else(|| panic!("{kind:?} projects no badge"));
		// The chip states the state, so the line states what the state is
		// about and never repeats the chip's own label.
		assert_eq!(state.run_status, Some((badge, detail.to_string())), "{kind:?}");
		assert_ne!(
			state.run_status.as_ref().map(|(_, line)| line.as_str()),
			Some(badge.label()),
			"{kind:?} restates its badge in the run bar"
		);
		assert_eq!(state.title, "title s");
		if kind == BadgeKind::Working {
			assert_eq!(row.meta.as_deref(), Some("5s"), "a working row shows its elapsed time");
		} else if kind != BadgeKind::Due {
			assert_eq!(row.meta.as_deref(), Some("1m"), "an idle row shows its age");
		}
	}
	assert_eq!(
		SURFACE_BADGES.len(),
		BadgeKind::iter().count(),
		"the two badge vocabularies are the same size"
	);
}

#[test]
fn a_projection_leaves_what_the_window_owns_alone() {
	let mut store = Store::new();
	store.sessions.insert(session("s", QueuePartition::Live));
	store
		.capabilities
		.set(Capability::Files, CapabilityStatus::Available);
	// The drawer is a surface the host offers (§5.13), and this claim is about
	// what the window owns once it is offered.
	store
		.capabilities
		.set(Capability::Terminals, CapabilityStatus::Available);
	let mut state = ShellState {
		drawer_open: true,
		panel: veyyon_desktop_surface::PanelContent {
			active_tab: veyyon_desktop_surface::PanelTab::File,
			diff_mode: veyyon_desktop_model::DiffMode::Split,
			..veyyon_desktop_surface::PanelContent::default()
		},
		..ShellState::default()
	};

	project(&store, &mut SessionIndex::new(), &HashMap::new(), NOW_MS, &mut state);

	assert!(state.drawer_open);
	assert_eq!(state.panel.active_tab, veyyon_desktop_surface::PanelTab::File);
	assert_eq!(state.panel.diff_mode, veyyon_desktop_model::DiffMode::Split);
	assert_eq!(state.sections.len(), 1, "and the host-owned fields were written");
	assert_eq!(state.drawer.tabs.len(), 0, "the drawer shows the host's terminal");
}

fn changed(path: &str, additions: u64, deletions: u64) -> ChangedFile {
	ChangedFile {
		path: path.to_string(),
		previous_path: None,
		status: ChangeStatus::Modified,
		additions,
		deletions,
	}
}

#[test]
fn a_file_tree_snapshot_projects_tree_and_decorates_changes() {
	let mut store = Store::new();
	// 1. Changes alone do not project full tree rows or mark tree loaded
	reduce(
		&mut store,
		HostEvent::Snapshot(SnapshotSection::Changes(ChangesView {
			revision:   1,
			repository: Some("/repo".to_string()),
			scope:      ChangeScope::WorkingTree,
			files:      vec![
				changed("src/b/two.rs", 2, 0),
				changed("README.md", 1, 1),
				changed("src/a/one.rs", 3, 4),
				changed("src/a/zero.rs", 0, 9),
			],
			diff:       String::new(),
		})),
	);
	let mut state = ShellState::default();
	project(&store, &mut SessionIndex::new(), &HashMap::new(), NOW_MS, &mut state);

	assert!(state.panel.tree.rows.is_empty(), "changes alone do not synthesize tree rows");
	assert_eq!(state.panel.tree.status, TreeStatus::Unloaded);
	assert_eq!(state.panel.diff_status, DiffStatus::Loaded);
	assert_eq!(state.panel.diff.len(), 4);

	// 2. Real FileTree snapshot populates tree rows and decorates changed files
	reduce(
		&mut store,
		HostEvent::Snapshot(SnapshotSection::FileTree(FileTreeView {
			root:      "/repo".to_string(),
			entries:   vec![
				FileNode {
					path:  "README.md".into(),
					name:  "README.md".into(),
					kind:  FileKind::File,
					depth: 0,
				},
				FileNode {
					path:  "src".into(),
					name:  "src".into(),
					kind:  FileKind::Directory,
					depth: 0,
				},
				FileNode {
					path:  "src/a".into(),
					name:  "a".into(),
					kind:  FileKind::Directory,
					depth: 1,
				},
				FileNode {
					path:  "src/a/one.rs".into(),
					name:  "one.rs".into(),
					kind:  FileKind::File,
					depth: 2,
				},
				FileNode {
					path:  "src/a/zero.rs".into(),
					name:  "zero.rs".into(),
					kind:  FileKind::File,
					depth: 2,
				},
				FileNode {
					path:  "src/b".into(),
					name:  "b".into(),
					kind:  FileKind::Directory,
					depth: 1,
				},
				FileNode {
					path:  "src/b/two.rs".into(),
					name:  "two.rs".into(),
					kind:  FileKind::File,
					depth: 2,
				},
			],
			truncated: false,
		})),
	);
	project(&store, &mut SessionIndex::new(), &HashMap::new(), NOW_MS, &mut state);

	assert_eq!(state.panel.tree.status, TreeStatus::Loaded);
	let rows: Vec<TreeCell<'_>> = state
		.panel
		.tree
		.rows
		.iter()
		.map(|row| (row.depth, row.name.as_str(), row.changed))
		.collect();
	assert_eq!(rows, [
		(0, "README.md", Some((1, 1))),
		(0, "src", None),
		(1, "a", None),
		(2, "one.rs", Some((3, 4))),
		(2, "zero.rs", Some((0, 9))),
		(1, "b", None),
		(2, "two.rs", Some((2, 0))),
	]);

	// 3. Later empty file tree replaces the tree rows
	reduce(
		&mut store,
		HostEvent::Snapshot(SnapshotSection::FileTree(FileTreeView {
			root:      "/repo".to_string(),
			entries:   Vec::new(),
			truncated: false,
		})),
	);
	project(&store, &mut SessionIndex::new(), &HashMap::new(), NOW_MS, &mut state);
	assert!(
		state.panel.tree.rows.is_empty(),
		"a later snapshot replaces the tree, it does not add to it"
	);
	assert_eq!(state.panel.tree.status, TreeStatus::Loaded);
}

fn output(terminal: &str, seq: u64, data: &str) -> HostEvent {
	HostEvent::Snapshot(SnapshotSection::TerminalOutput(TerminalOutputChunk {
		terminal: terminal.to_string(),
		seq,
		data: data.as_bytes().to_vec(),
		reset: false,
	}))
}

#[test]
fn the_drawer_shows_the_last_running_terminal_as_plain_text_from_the_end() {
	let mut store = Store::new();
	reduce(
		&mut store,
		HostEvent::Snapshot(SnapshotSection::Terminals(vec![
			terminal("t1", TerminalStatus::Running),
			terminal("t2", TerminalStatus::Running),
			terminal("t3", TerminalStatus::Exited { code: 0 }),
		])),
	);
	reduce(&mut store, output("t1", 1, "first terminal\n"));
	reduce(&mut store, output("t3", 1, "exited terminal\n"));
	let mut long = String::new();
	for n in 0..PANE_LINE_CEILING + 3 {
		write!(long, "\u{1b}[32mline {n}\u{1b}[0m\r\n").unwrap();
	}
	reduce(&mut store, output("t2", 1, &long));
	reduce(&mut store, output("t2", 2, "\u{1b}]0;title\u{07}$ done"));

	let mut state = ShellState::default();
	project(&store, &mut SessionIndex::new(), &HashMap::new(), NOW_MS, &mut state);

	let lines = drawer_lines(&store.domains);
	assert_eq!(lines.len(), PANE_LINE_CEILING, "held to the pane ceiling");
	assert_eq!(lines[0], "line 4", "the lines dropped are the oldest");
	assert_eq!(lines.last().map(String::as_str), Some("$ done"));
	assert!(
		lines
			.iter()
			.all(|line| !line.contains('\u{1b}') && !line.contains('\r')),
		"control sequences never reach the drawer"
	);
	assert_eq!(state.drawer.tabs.len(), 3, "drawer projects 3 terminal tabs");
	assert_eq!(state.drawer.title, "title", "drawer projects title from OSC");
	reduce(
		&mut store,
		HostEvent::Snapshot(SnapshotSection::Terminals(vec![terminal(
			"t3",
			TerminalStatus::Exited { code: 0 },
		)])),
	);
	project(&store, &mut SessionIndex::new(), &HashMap::new(), NOW_MS, &mut state);
	let lines2 = drawer_lines(&store.domains);
	assert_eq!(lines2, ["exited terminal"], "with nothing running, the last one opened");
}
