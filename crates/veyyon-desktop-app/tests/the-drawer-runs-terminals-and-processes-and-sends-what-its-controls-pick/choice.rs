//! Which tab the drawer draws as the host's lists change under it: the
//! terminal the drawer asked for once it arrives, else the tab the operator
//! picked while the host still lists it, else the newest running terminal.
//!
//! WHY: a terminal the drawer asks for arrives a round trip later, after the
//! strip may have changed under it. The retired window carried its tab across
//! that round trip by position, so a default was kept as though it had been
//! picked and the process list stayed drawn over the terminal the drawer had
//! just asked for. The class is a tab kept or dropped for the wrong reason: the
//! drawer's own terminal drawn behind a pick, a pick taken by a terminal nobody
//! asked for, an unpicked drawer held on an older terminal, and a picked tab
//! the host no longer lists still drawn. Every sweep picks each tab of the
//! strip the window lists at run time, by clicking it, and `withdraw` is
//! exhaustive over `DrawerTab`, so a tab kind added to the drawer fails to
//! compile until the way the host takes it away is stated.
//!
//! Gap: the pick is persisted per session and read back when the session is
//! shown again; that round trip is the workspace's and is not driven here.

use gpui::TestAppContext;
use veyyon_desktop_app::drawer::DrawerTab;
use veyyon_desktop_model::{
	Capability, CapabilityStatus, HostAction, HostEvent, TerminalStatus, TerminalView,
};

use super::harness::{
	Win, both, capabilities, opened, process, processes, succeeded, terminal, terminals, window,
};

/// Two running terminals, one that exited, and one supervised process.
fn listed() -> Vec<TerminalView> {
	vec![
		terminal("t1", TerminalStatus::Running),
		terminal("t2", TerminalStatus::Running),
		terminal("t3", TerminalStatus::Exited { code: 2 }),
	]
}

/// What the host lists before any case: `listed` and the process `dev`.
fn fixture() -> Vec<HostEvent> {
	vec![capabilities(both()), terminals(listed()), processes(vec![process("dev", "running", None)])]
}

/// The drawer open over `fixture`, with every request since answered.
fn open(app: &mut TestAppContext) -> Win<'_> {
	let mut events = opened(both());
	events.extend(fixture());
	let mut w = window(app, events);
	w.toggle();
	settle(&mut w);
	w
}

/// The host taking every request queued. A terminal tab shown for the first
/// time attaches on the create control, which waits for that answer before
/// it takes a click.
fn settle(w: &mut Win<'_>) {
	let asked = w.requests();
	w.apply(
		asked
			.into_iter()
			.map(|request| succeeded(request.id))
			.collect(),
	);
}

/// The events by which the host stops listing `tab`, the rest of `fixture`
/// left as it was.
///
/// Exhaustive over `DrawerTab`: a tab kind added to the drawer fails to
/// compile here until the way the host takes it away is stated.
fn withdraw(tab: &DrawerTab) -> Vec<HostEvent> {
	match tab {
		DrawerTab::Terminal(id) => {
			vec![terminals(listed().into_iter().filter(|t| &t.id != id).collect())]
		},
		DrawerTab::Processes => vec![capabilities(vec![
			(Capability::Terminals, CapabilityStatus::Available),
			(Capability::ProcessSupervisor, CapabilityStatus::Unavailable {
				reason: "the supervisor stopped".to_owned(),
			}),
		])],
		DrawerTab::Process(_) => vec![processes(Vec::new())],
	}
}

/// The newest running terminal among `list`, else its last terminal.
fn newest(list: &[TerminalView]) -> DrawerTab {
	let running = list
		.iter()
		.rev()
		.find(|t| t.status == TerminalStatus::Running);
	let tab = running
		.or_else(|| list.last())
		.expect("the case lists a terminal");
	DrawerTab::Terminal(tab.id.clone())
}

fn pick(w: &mut Win<'_>, tab: &DrawerTab) {
	w.click(&format!("drawer.tab:{}", tab.slug()));
	assert_eq!(w.shown().as_ref(), Some(tab), "a click on {tab:?} shows it");
}

#[gpui::test]
fn the_terminal_the_drawer_asked_for_is_drawn_over_whatever_was_picked(app: &mut TestAppContext) {
	let mut w = open(app);
	let strip = w.strip();
	assert_eq!(strip.len(), 5, "every kind of tab is in the strip the cases pick from: {strip:?}");
	let mut list = listed();
	for (ix, tab) in strip.iter().enumerate() {
		pick(&mut w, tab);
		settle(&mut w);
		w.click("drawer.control:new");
		let create = w.one();
		assert!(matches!(create.action, HostAction::CreateTerminal { .. }), "{:?}", create.action);

		let id = format!("n{ix}");
		list.push(terminal(&id, TerminalStatus::Running));
		w.apply(vec![terminals(list.clone()), succeeded(create.id)]);
		assert_eq!(
			w.shown(),
			Some(DrawerTab::Terminal(id)),
			"the terminal asked for over a picked {tab:?} is the one drawn"
		);
	}
}

#[gpui::test]
fn a_picked_tab_holds_when_a_terminal_nobody_asked_for_arrives(app: &mut TestAppContext) {
	let mut w = open(app);
	let strip = w.strip();
	let mut list = listed();
	for (ix, tab) in strip.iter().enumerate() {
		pick(&mut w, tab);
		list.push(terminal(&format!("o{ix}"), TerminalStatus::Running));
		w.apply(vec![terminals(list.clone())]);
		assert_eq!(
			w.shown().as_ref(),
			Some(tab),
			"a running terminal the drawer did not ask for leaves a picked {tab:?} drawn"
		);
	}
}

#[gpui::test]
fn an_unpicked_drawer_draws_the_newest_running_terminal(app: &mut TestAppContext) {
	let mut w = open(app);
	assert_eq!(w.shown(), Some(newest(&listed())), "the newest running terminal, not an ended one");

	let mut list = listed();
	list.push(terminal("t4", TerminalStatus::Running));
	w.apply(vec![terminals(list.clone())]);
	assert_eq!(w.shown(), Some(DrawerTab::Terminal("t4".to_owned())), "a newer one takes it");

	list[3].status = TerminalStatus::Exited { code: 0 };
	w.apply(vec![terminals(list.clone())]);
	assert_eq!(
		w.shown(),
		Some(DrawerTab::Terminal("t2".to_owned())),
		"one that ended gives way to the newest still running"
	);

	for terminal in &mut list {
		terminal.status = TerminalStatus::Exited { code: 0 };
	}
	w.apply(vec![terminals(list)]);
	assert_eq!(
		w.shown(),
		Some(DrawerTab::Terminal("t4".to_owned())),
		"with none running, the last one listed"
	);
}

#[gpui::test]
fn a_picked_tab_the_host_stops_listing_gives_way_to_the_newest_running_terminal(
	app: &mut TestAppContext,
) {
	let mut w = open(app);
	let strip = w.strip();
	for tab in &strip {
		w.apply(fixture());
		pick(&mut w, tab);
		let withdrawn = withdraw(tab);
		w.apply(withdrawn);
		assert!(!w.strip().contains(tab), "the host no longer lists {tab:?}: {:?}", w.strip());
		let left = match tab {
			DrawerTab::Terminal(id) => listed().into_iter().filter(|t| &t.id != id).collect(),
			DrawerTab::Processes | DrawerTab::Process(_) => listed(),
		};
		assert_eq!(
			w.shown(),
			Some(newest(&left)),
			"a picked {tab:?} the host took away gives way to the newest running terminal"
		);
	}
}
