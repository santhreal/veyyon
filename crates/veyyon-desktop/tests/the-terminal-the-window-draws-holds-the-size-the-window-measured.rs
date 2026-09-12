//! WHY: the window measures how many cells the drawer has room for, and that
//! measure has to reach the text. It travels as `Intent::ResizeTerminal`,
//! which the host answers by resizing the pty; what the operator reads until
//! then is this side of it, and it was not wired at all. The grid was built
//! at a constant 80x24 wherever the window replays output itself -- a
//! terminal whose chunks arrived before it was opened, a supervised process's
//! log, an empty drawer -- so a wide window drew a narrow column of text with
//! blank space beside it, and a resize moved nothing.
//!
//! CLASS CLOSED:
//! 1. A measured size that reaches no emulator the window holds, so the text
//!    keeps the breaks of the width it was first drawn at.
//! 2. A measure that reaches only the terminal that is open, leaving the others
//!    to re-break when the operator switches to them.
//! 3. Output the window replays itself -- a terminal's held chunks, a process
//!    log, the blank grid of an empty drawer -- built at a constant rather than
//!    at the size the window measured.
//! 4. A frame that resizes without re-projecting, which draws the new size one
//!    frame late.
//!
//! WHAT THIS DOES NOT CATCH: whether the host applies the size it is sent,
//! which is its own; whether the re-break is correct, which is
//! `output-is-broken-again-when-the-grid-changes-width` in the model; and
//! what the window measures the box as, which is
//! `the-terminal-grid-holds-the-cells-the-window-has-room-for` in the
//! surface.

mod support;

use std::collections::HashMap;

use support::{session, terminal};
use veyyon_desktop::{SessionIndex, project, resize_terminals};
use veyyon_desktop_model::{
	Capability, CapabilityStatus, ProcessLogView, ProcessView, QueuePartition, SessionId, Store,
	TerminalOutputChunk, TerminalStatus, text::terminal::TerminalEmulator,
};
use veyyon_desktop_surface::{DrawerTab, Intent, ShellState};

/// A window attached to a host that runs two terminals and supervises one
/// process.
struct Attached {
	store:     Store,
	index:     SessionIndex,
	emulators: HashMap<String, TerminalEmulator>,
	state:     ShellState,
}

impl Attached {
	fn new() -> Self {
		let mut store = Store::new();
		let id = SessionId::from("s1");
		store.sessions.insert(session("s1", QueuePartition::Live));
		store.persisted.shell.active_session = Some(id.clone());
		store
			.capabilities
			.set(Capability::Terminals, CapabilityStatus::Available);
		store
			.capabilities
			.set(Capability::ProcessSupervisor, CapabilityStatus::Available);
		store
			.domains
			.terminals
			.push(terminal("t1", TerminalStatus::Running));
		store
			.domains
			.terminals
			.push(terminal("t2", TerminalStatus::Running));
		let mut index = SessionIndex::new();
		let _ = index.row_of(&id);

		Self { store, index, emulators: HashMap::new(), state: ShellState::default() }
	}

	/// Puts an emulator the window holds behind a terminal, the way the
	/// window does when it reads that terminal's chunks live.
	fn hold(&mut self, id: &str, bytes: &[u8]) {
		let (cols, rows) = self.state.drawer.grid_cells;
		let mut emulator = TerminalEmulator::new(usize::from(cols), usize::from(rows));
		emulator.feed(bytes);
		self.emulators.insert(id.to_owned(), emulator);
	}

	/// Records output the window has not opened a terminal on yet.
	fn chunk(&mut self, id: &str, bytes: &[u8]) {
		self
			.store
			.domains
			.terminal_output
			.entry(id.to_owned())
			.or_default()
			.append_chunk(TerminalOutputChunk {
				terminal: id.to_owned(),
				seq:      1,
				data:     bytes.to_vec(),
				reset:    false,
			});
	}

	fn project(&mut self) {
		project(&self.store, &mut self.index, &self.emulators, 2_000, &mut self.state);
	}

	/// What the window does with the intents a frame raised: the measure
	/// reaches every terminal it holds, and a frame that resized re-projects.
	fn frame_raised(&mut self, intents: &[Intent]) -> bool {
		for intent in intents {
			intent.apply(&mut self.state);
		}
		let resized = resize_terminals(&mut self.emulators, intents);
		if resized {
			self.project();
		}
		resized
	}

	fn open_tab(&mut self, tab: &DrawerTab) {
		self.state.drawer.tab_chosen = true;
		self.project();
		let index = self
			.state
			.drawer
			.tabs
			.iter()
			.position(|held| held == tab)
			.unwrap_or_else(|| panic!("no {tab:?} among {:?}", self.state.drawer.tabs));
		self.state.drawer.active_tab = index;
		self.project();
	}

	fn drawn_width(&self) -> usize {
		self
			.state
			.drawer
			.grid_rows
			.first()
			.map_or(0, |row| row.iter().map(|cell| usize::from(cell.width.max(1))).sum())
	}
}

fn process(name: &str) -> ProcessView {
	ProcessView {
		name:          name.to_owned(),
		pid:           Some(4242),
		application:   "bun".to_owned(),
		args:          vec!["run".to_owned(), "dev".to_owned()],
		cwd:           "/repo".to_owned(),
		lifetime:      "short".to_owned(),
		status:        "running".to_owned(),
		exit_code:     None,
		started_at_ms: 1_000,
		terminated_by: None,
	}
}

#[test]
fn the_measure_reaches_every_terminal_the_window_holds() {
	let mut attached = Attached::new();
	attached.hold("t1", b"the quick brown fox jumps over the lazy dog");
	attached.hold("t2", b"a second terminal nobody is looking at");

	let resized = attached.frame_raised(&[Intent::ResizeTerminal { cols: 140, rows: 30 }]);

	assert!(resized, "the frame states that it resized, which is what makes it re-project");
	for id in ["t1", "t2"] {
		let grid = attached
			.emulators
			.get(id)
			.unwrap_or_else(|| panic!("{id} is held"))
			.grid();
		assert_eq!((grid.cols, grid.rows), (140, 30), "{id} holds the measured size");
	}
}

#[test]
fn the_drawn_grid_is_the_measured_width_on_the_frame_that_measured_it() {
	let mut attached = Attached::new();
	attached.hold("t1", b"output written before anything was resized");
	attached.open_tab(&DrawerTab::Terminal { id: "t1".to_owned(), title: "/bin/sh".to_owned() });
	assert_eq!(attached.drawn_width(), 80, "the drawer opens at the size it was built at");

	attached.frame_raised(&[Intent::ResizeTerminal { cols: 140, rows: 30 }]);

	assert_eq!(attached.state.drawer.grid_cells, (140, 30), "the window holds the measured size");
	assert_eq!(attached.drawn_width(), 140, "and the frame that measured it draws it");
	assert_eq!(attached.state.drawer.grid_rows.len(), 30, "every measured row is drawn");
}

#[test]
fn output_the_window_replays_itself_is_broken_at_the_measured_width() {
	let mut attached = Attached::new();
	attached.chunk("t1", b"a terminal whose output arrived before it was opened");
	attached.frame_raised(&[Intent::ResizeTerminal { cols: 120, rows: 14 }]);
	attached.open_tab(&DrawerTab::Terminal { id: "t1".to_owned(), title: "/bin/sh".to_owned() });

	assert_eq!(attached.drawn_width(), 120, "the replay grid is the measured width");
	assert_eq!(attached.state.drawer.grid_rows.len(), 14, "and the measured height");
}

#[test]
fn a_process_log_is_broken_at_the_measured_width() {
	let mut attached = Attached::new();
	attached.store.domains.processes.push(process("dev"));
	attached
		.store
		.domains
		.process_logs
		.insert("dev".to_owned(), ProcessLogView {
			lines:  vec!["a line of log output from a supervised process".to_owned()],
			cursor: 1,
		});
	attached.frame_raised(&[Intent::ResizeTerminal { cols: 100, rows: 12 }]);
	attached.open_tab(&DrawerTab::Process { name: "dev".to_owned() });

	assert_eq!(attached.drawn_width(), 100, "the log grid is the measured width");
	assert_eq!(attached.state.drawer.grid_rows.len(), 12, "and the measured height");
}

#[test]
fn an_empty_drawer_is_blank_at_the_measured_size_rather_than_at_a_constant() {
	let mut attached = Attached::new();
	attached.store.domains.terminals.clear();
	attached.frame_raised(&[Intent::ResizeTerminal { cols: 96, rows: 18 }]);
	attached.open_tab(&DrawerTab::Processes);

	assert_eq!(attached.drawn_width(), 96, "the blank grid is the measured width");
	assert_eq!(attached.state.drawer.grid_rows.len(), 18, "and the measured height");
}

#[test]
fn a_frame_that_measured_nothing_resizes_nothing() {
	let mut attached = Attached::new();
	attached.hold("t1", b"settled output");
	let before = attached.emulators["t1"].grid().cols;

	let resized = attached.frame_raised(&[Intent::SetDrawer { open: true }]);

	assert!(!resized, "a frame with no measure in it does not re-project for one");
	assert_eq!(attached.emulators["t1"].grid().cols, before, "and nothing was re-broken");
}
