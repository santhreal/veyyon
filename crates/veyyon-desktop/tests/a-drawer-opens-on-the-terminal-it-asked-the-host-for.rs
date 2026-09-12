//! WHY: opening the drawer asks the host for a terminal -- it attaches the
//! newest running one, and creates one where there is none -- and the answer
//! arrives a round trip later. The projection carried the active tab across
//! that round trip by identity, so the index the drawer held before the
//! answer, which stands for whatever sits at zero, was carried forward as
//! though something had chosen it. On a host that supervises processes that
//! index is the process list, so `Primary-J`, the titlebar control and
//! `/terminal` all opened the drawer, created a terminal, and left the
//! supervisor drawn over it; the terminal was reachable only by clicking its
//! tab.
//!
//! CLASS CLOSED: a default carried as a choice. The projection carries a tab
//! only once a click, a process's log or a remembered shape has chosen it,
//! and follows the newest running terminal until then. The sweep drives the
//! real projection twice per case -- the state before the host answers, then
//! the state with the terminal in it -- and covers every tab the drawer can
//! show, choosing each the way the window chooses it, with an exhaustive
//! match over `DrawerTab` so a new tenant fails to compile until the way it
//! is chosen is stated.
//!
//! GAPS: it pins which tab the projection makes active, not what the tab
//! draws once active, and not that the drawer's opening asks the host for a
//! terminal at all -- `Intent::SetDrawer` and the host's `CreateTerminal` own
//! that, and `a-drawer-can-open-a-terminal-it-does-not-have` owns the control
//! that asks for another one. A window relaunched onto a host whose
//! remembered tab no longer exists falls back to this same default, which is
//! the behaviour these cases pin rather than a separate one.

mod support;

use std::collections::HashMap;

use support::{session, terminal};
use veyyon_desktop::{SessionIndex, project};
use veyyon_desktop_model::{
	Capability, CapabilityStatus, ProcessView, QueuePartition, SessionId, Store, TerminalStatus,
	text::terminal::TerminalEmulator,
};
use veyyon_desktop_surface::{DrawerTab, Intent, ShellState};

/// A window attached to a host that runs terminals and supervises processes,
/// projected as often as the state changes.
struct Attached {
	store:     Store,
	index:     SessionIndex,
	emulators: HashMap<String, TerminalEmulator>,
	state:     ShellState,
}

impl Attached {
	/// A host with both tenants available and one session, listing nothing
	/// yet: the state the window is in while the drawer's own request for a
	/// terminal is in flight.
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
		let mut index = SessionIndex::new();
		let _ = index.row_of(&id);
		Self { store, index, emulators: HashMap::new(), state: ShellState::default() }
	}

	/// Runs the real projection over the state as it now stands.
	fn project(&mut self) {
		project(&self.store, &mut self.index, &self.emulators, 2_000, &mut self.state);
	}

	/// The tab the drawer draws.
	fn active(&self) -> &DrawerTab {
		let drawer = &self.state.drawer;
		drawer
			.tabs
			.get(drawer.active_tab)
			.unwrap_or_else(|| panic!("no tab at {} of {:?}", drawer.active_tab, drawer.tabs))
	}

	/// Applies an intent the way the window applies one.
	fn apply(&mut self, intent: &Intent) {
		intent.apply(&mut self.state);
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

/// The intent the window sends when this tab is chosen, at `index` in the
/// strip.
///
/// Exhaustive over `DrawerTab`: a tenant added to the drawer fails to compile
/// here until the way it is chosen is stated, and the sweep below then covers
/// it.
fn choose(tab: &DrawerTab, index: usize) -> Intent {
	match tab {
		DrawerTab::Terminal { .. } | DrawerTab::Processes => Intent::SelectDrawerTab(index),
		DrawerTab::Process { name } => Intent::OpenProcessLogs(name.clone()),
	}
}

#[test]
fn the_terminal_the_drawer_asked_for_is_the_tab_it_draws() {
	let mut host = Attached::new();
	host.project();
	assert_eq!(
		host.active(),
		&DrawerTab::Processes,
		"a host that lists no terminal yet has only the supervisor to draw: {:?}",
		host.state.drawer.tabs
	);

	host.store.domains.terminals = vec![terminal("term-1", TerminalStatus::Running)];
	host.project();
	assert_eq!(
		host.active(),
		&DrawerTab::Terminal { id: "term-1".to_owned(), title: "/bin/sh".to_owned() },
		"the terminal the drawer asked for is the tab it draws: {:?}",
		host.state.drawer.tabs
	);
}

#[test]
fn every_tab_the_operator_can_choose_is_kept_when_a_terminal_arrives() {
	let mut listing = Attached::new();
	listing.store.domains.terminals = vec![terminal("term-1", TerminalStatus::Running)];
	listing.store.domains.processes = vec![process("web")];
	listing.project();
	let strip = listing.state.drawer.tabs.clone();
	assert_eq!(
		strip,
		vec![
			DrawerTab::Terminal { id: "term-1".to_owned(), title: "/bin/sh".to_owned() },
			DrawerTab::Processes,
			DrawerTab::Process { name: "web".to_owned() },
		],
		"the strip every case below chooses from"
	);

	for (index, tab) in strip.iter().enumerate() {
		let mut host = Attached::new();
		host.store.domains.terminals = vec![terminal("term-1", TerminalStatus::Running)];
		host.store.domains.processes = vec![process("web")];
		host.project();
		host.apply(&choose(tab, index));
		assert_eq!(host.active(), tab, "the chosen tab is the one the drawer draws");

		host
			.store
			.domains
			.terminals
			.push(terminal("term-2", TerminalStatus::Running));
		host.project();
		assert_eq!(
			host.active(),
			tab,
			"a terminal arriving beside a chosen {tab:?} does not take the strip from it: {:?}",
			host.state.drawer.tabs
		);
	}
}

#[test]
fn a_drawer_nothing_chose_follows_the_newest_running_terminal() {
	// The other half of the fix: the projection follows the terminal only
	// while nothing has chosen a tab, so a second terminal the host opens is
	// the one the drawer draws.
	let mut host = Attached::new();
	host.store.domains.terminals = vec![terminal("term-1", TerminalStatus::Running)];
	host.project();
	host
		.store
		.domains
		.terminals
		.push(terminal("term-2", TerminalStatus::Running));
	host.project();
	assert_eq!(
		host.active(),
		&DrawerTab::Terminal { id: "term-2".to_owned(), title: "/bin/sh".to_owned() },
		"an unchosen drawer draws the newest running terminal: {:?}",
		host.state.drawer.tabs
	);
}

#[test]
fn a_chosen_terminal_that_left_the_list_gives_way_to_a_running_one() {
	let mut host = Attached::new();
	host.store.domains.terminals = vec![
		terminal("term-1", TerminalStatus::Running),
		terminal("term-2", TerminalStatus::Running),
	];
	host.project();
	host.apply(&Intent::SelectDrawerTab(0));
	assert_eq!(
		host.active(),
		&DrawerTab::Terminal { id: "term-1".to_owned(), title: "/bin/sh".to_owned() },
		"the chosen terminal is the one the drawer draws"
	);

	host.store.domains.terminals = vec![terminal("term-2", TerminalStatus::Running)];
	host.project();
	assert_eq!(
		host.active(),
		&DrawerTab::Terminal { id: "term-2".to_owned(), title: "/bin/sh".to_owned() },
		"a chosen tab that is gone gives way to the running terminal: {:?}",
		host.state.drawer.tabs
	);
}
