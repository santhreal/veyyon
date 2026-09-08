//! WHY THIS SUITE EXISTS:
//! Three domains the reducer filled reached no pixel. The host answered
//! `ProcessLogs` with a supervised process's output, `ExportSession` with the
//! document it wrote and `CallMcpTool` with a tool's result; the store held all
//! three and `project` read none of them, so an operator who pressed the
//! control watched nothing happen. The defect is invisible from either side:
//! the reducer test passes because the store changed, and the surface tests
//! pass because they never ask what filled the field.
//!
//! THE CLASS THIS CLOSES: a snapshot section the client accepts, stores and
//! draws nowhere. The corpus this sweeps is the one
//! `veyyon-desktop-model/tests/
//! every-snapshot-section-in-the-shared-corpus-decodes.rs` pins at one entry
//! per `SnapshotSection`, and `ALL_SECTION_NAMES` is pinned to the enum's
//! variants in that crate's `a_new_protocol_variant_cannot_be_added_in_silence.
//! rs`, so a section added to the protocol arrives here with no edit and turns
//! this red until it draws or is recorded below. `prepare_for` matches the kind
//! exhaustively, so the same variant also fails to compile until its
//! precondition is stated.
//!
//! `NOT_DRAWN` is pinned by exact equality in both directions: a section that
//! starts drawing is red until the row is removed, and one that stops drawing
//! is red until somebody decides it should not.
//!
//! WHAT IT DOES NOT CATCH: whether the section reaches the *right* surface, or
//! reaches it legibly. The per-surface projections own that
//! (`the-host-model-projects-onto-the-shell.rs`,
//! `a-transcript-projects-as-turns-of-blocks.rs`,
//! `the-accounting-reaches-the-usage-tab-the-footer-opens.rs`), and the scene
//! catalogue owns the pixels. It also does not prove the host sends the
//! section; the gui-host suites own that.

mod support;

use std::{collections::HashMap, fs, path::PathBuf};

use strum::IntoEnumIterator as _;
use support::{NOW_MS, session, terminal};
use veyyon_desktop::{SessionIndex, project};
use veyyon_desktop_model::{
	Capability, CapabilityStatus, ConnectionState, HostEvent, PROTOCOL_VERSION, ProcessView,
	QueuePartition, SessionId, SnapshotSection, SnapshotSectionKind, Store, TerminalStatus, reduce,
};
use veyyon_desktop_surface::{Intent, Overlay, PaletteMode, PaletteState, ShellState};

/// The session, terminal and process every corpus section names.
const SESSION: &str = "sess-1";
const TERMINAL: &str = "term-1";
const PROCESS: &str = "web";

/// Sections the window stores and draws nowhere, with the reason.
///
/// `McpToolResult` answers `CallMcpTool`, and the desktop calls no tool
/// directly: a tool call needs arbitrary JSON arguments, which is an editor
/// surface the product does not have (§1.3). The tool calls an operator sees
/// are the agent's, and those arrive as `ToolCall` and `ToolResult` blocks in
/// the transcript with their own presentation.
const NOT_DRAWN: &[SnapshotSectionKind] = &[SnapshotSectionKind::McpToolResult];

/// What must already be on the surface for a section's destination to exist.
///
/// A settings domain reaches only an open settings overlay, a search result
/// only an open palette in the mode that lists them, and a process's output
/// only the tab that shows that process.
enum Prepare {
	/// The attached window at rest.
	Rest,
	/// The settings overlay, open on its first page.
	Settings,
	/// The palette, open in one mode, holding a query. A lookup mode lists
	/// what the host answered for what was typed, so its rows are empty
	/// until something is in the field.
	Palette(PaletteMode, &'static str),
	/// The drawer, showing one process's output.
	ProcessOutput(&'static str),
}

/// Exhaustive over the section kinds: a variant added to the protocol fails to
/// compile here until its precondition is stated.
const fn prepare_for(kind: SnapshotSectionKind) -> Prepare {
	match kind {
		SnapshotSectionKind::Settings
		| SnapshotSectionKind::Themes
		| SnapshotSectionKind::Keybindings
		| SnapshotSectionKind::Providers
		| SnapshotSectionKind::AuthFlow
		| SnapshotSectionKind::Mcp
		| SnapshotSectionKind::McpToolResult
		| SnapshotSectionKind::Agents
		| SnapshotSectionKind::Diagnostics => Prepare::Settings,
		SnapshotSectionKind::SearchResults => Prepare::Palette(PaletteMode::Files, "app"),
		SnapshotSectionKind::ContentMatches => Prepare::Palette(PaletteMode::ContentSearch, "todo"),
		SnapshotSectionKind::ProcessLogs => Prepare::ProcessOutput(PROCESS),
		SnapshotSectionKind::Sessions
		| SnapshotSectionKind::ActiveSession
		| SnapshotSectionKind::Transcript
		| SnapshotSectionKind::Capabilities
		| SnapshotSectionKind::Interactions
		| SnapshotSectionKind::Changes
		| SnapshotSectionKind::FileTree
		| SnapshotSectionKind::FileContent
		| SnapshotSectionKind::Terminals
		| SnapshotSectionKind::TerminalOutput
		| SnapshotSectionKind::Processes
		| SnapshotSectionKind::Models
		| SnapshotSectionKind::Usage
		| SnapshotSectionKind::ContextBreakdown
		| SnapshotSectionKind::Export
		| SnapshotSectionKind::QueuedPrompts => Prepare::Rest,
	}
}

/// The store as the host leaves it once attached, holding the session,
/// terminal and process the corpus sections name, each with values the corpus
/// replaces, so a section that lands is a section that changed something.
fn attached_store() -> Store {
	let mut store = Store::new();
	store.connection = ConnectionState::Connected {
		endpoint: "127.0.0.1:47000".to_string(),
		protocol: PROTOCOL_VERSION,
	};
	for capability in Capability::ALL {
		store
			.capabilities
			.set(capability, CapabilityStatus::Available);
	}
	store
		.sessions
		.insert(session(SESSION, QueuePartition::Live));
	store.persisted.shell.active_session = Some(SessionId::from(SESSION));
	store
		.domains
		.terminals
		.push(terminal(TERMINAL, TerminalStatus::Running));
	store.domains.processes.push(ProcessView {
		name:          PROCESS.to_string(),
		pid:           Some(1),
		status:        "running".to_string(),
		application:   "sh".to_string(),
		args:          Vec::new(),
		cwd:           "/repo".to_string(),
		lifetime:      "last-client-exit".to_string(),
		started_at_ms: NOW_MS - 1_000,
		exit_code:     None,
		terminated_by: None,
	});
	store
}

/// Every section of the shared corpus, in the order the corpus lists them.
fn corpus() -> Vec<SnapshotSection> {
	let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
		.join("../veyyon-desktop-model/tests/fixtures/snapshot-sections.json");
	let raw = fs::read_to_string(&path).unwrap_or_else(|error| {
		panic!("read the shared section corpus at {}: {error}", path.display())
	});
	serde_json::from_str(&raw).expect("the shared section corpus deserializes into every section")
}

/// The window with its precondition met, projected and ready to be compared.
fn prepared(store: &Store, prepare: &Prepare) -> (ShellState, SessionIndex) {
	let mut index = SessionIndex::new();
	let overlay = match prepare {
		Prepare::Rest | Prepare::ProcessOutput(_) => None,
		Prepare::Settings => Some(Overlay::Settings(Box::default())),
		Prepare::Palette(mode, query) => {
			let mut palette = PaletteState::new(*mode);
			palette.set_query((*query).to_string());
			Some(Overlay::Palette(palette))
		},
	};
	let mut state = ShellState { overlay, ..ShellState::default() };
	project(store, &mut index, &HashMap::new(), NOW_MS, &mut state);
	if let Prepare::ProcessOutput(name) = prepare {
		// The tab is reached the way the operator reaches it, so the sweep
		// fails if the click stops selecting it.
		Intent::OpenProcessLogs((*name).to_string()).apply(&mut state);
		assert_eq!(
			state.drawer.active_process_name(),
			Some(*name),
			"the drawer must be showing {name}'s output before its logs arrive"
		);
		project(store, &mut index, &HashMap::new(), NOW_MS, &mut state);
	}
	(state, index)
}

#[test]
fn every_section_the_store_keeps_is_one_the_window_draws() {
	let sections = corpus();
	assert_eq!(
		sections.len(),
		SnapshotSectionKind::iter().count(),
		"the corpus must hold one entry per section kind"
	);

	let mut silent = Vec::new();
	for section in sections {
		let kind = SnapshotSectionKind::from(&section);
		let prepare = prepare_for(kind);
		let store = attached_store();
		let (before, mut index) = prepared(&store, &prepare);

		let mut after_store = store;
		reduce(&mut after_store, HostEvent::Snapshot(section));
		let mut after = before.clone();
		project(&after_store, &mut index, &HashMap::new(), NOW_MS, &mut after);

		if after == before {
			silent.push(kind);
		}
	}

	assert_eq!(silent, NOT_DRAWN, "sections the window stores and draws nowhere");
}
