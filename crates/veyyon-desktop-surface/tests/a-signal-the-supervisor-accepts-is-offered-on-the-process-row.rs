//! WHY: the supervisor's row offered `Stop` and `Restart`, which are one
//! signal of the five the daemon accepts, chosen for the operator and spelled
//! as a literal beside the action. A process that traps `SIGTERM` -- a shell
//! holding a handler, a watcher that swallows it -- answered the only press the
//! window had and kept running, and there was nowhere to ask for the interrupt
//! it wanted or the kill it could not refuse. `Intent::ProcessSignal` existed
//! and nothing dispatched it: the action was reachable from no press at all.
//!
//! CLASS CLOSED: a closed vocabulary the host accepts is offered in full or the
//! suite is red. The rows the press opens are pinned by exact equality against
//! the five spellings the daemon validates, so a variant added to
//! `SupervisorSignal` turns this red until its row is recorded, and a variant
//! removed from the menu is red for the same reason. Every row is then pressed,
//! one press per signal, and each is required to raise that signal for the
//! process whose row was pressed -- so a menu wired to one signal, to the wrong
//! process, or to a default, fails here rather than on the signal nobody tried.
//!
//! The presses are the drawn controls, located by the words the frame recorded
//! and pressed at their centres, so a control wired to nothing fails here
//! rather than passing on a direct call to the state behind it.
//!
//! GAPS: it drives the window, not the daemon: that a signal reaching the host
//! is delivered to the process is the host's contract, and the spelling the
//! host reads is pinned in
//! `crates/veyyon-desktop/tests/
//! a-vocabulary-the-host-closed-is-sent-in-the-spelling-it-accepts.rs`. Whether
//! the gate holds a signal back is the control projection's subject,
//! and the menu's own drawing -- fill, radius, icon gutter -- is the kit's.

use std::path::Path;

use strum::IntoEnumIterator;
use veyyon_desktop_kit::{load_bundled_theme, load_bundled_tokens};
use veyyon_desktop_model::{SessionId, SupervisorSignal, SurfaceId};
use veyyon_desktop_scene::{
	headless::{Captured, RenderOptions, headless_context},
	session::HeadlessSession,
};
use veyyon_desktop_surface::{
	Availability, DrawerContent, DrawerTab, Intent, Keymap, ProcessRow, ShellState, ShellView,
	SignalMenu, fixture, install_tokens, signal_menu_items,
};
use veyyon_gpui::{App, AppContext, Pixels, Point};

const WIDTH: u32 = 1440;
const HEIGHT: u32 = 900;

/// Everything the drawer draws in a 900-high window sits below this: the
/// midline, so a word the transcript or the composer also drew is not read as
/// the drawer's control.
const DRAWER_TOP: f32 = 450.0;

/// The process the presses are made on.
const PROCESS: &str = "dev-server";

/// Every row the menu offers, in the order it draws them.
///
/// Recorded rather than derived: a set built by iterating the same enum the
/// menu iterates would agree with itself whatever either says. `DAEMON_SIGNALS`
/// in `packages/coding-agent/src/launch/protocol.ts` is the set the daemon
/// validates against, and these are the spellings it holds.
const MENU_ROWS: [&str; 5] = [
	"Interrupt (SIGINT)",
	"Terminate (SIGTERM)",
	"Hang up (SIGHUP)",
	"Quit (SIGQUIT)",
	"Kill (SIGKILL)",
];

/// One row of the supervisor's list, running or not.
fn row(name: &str, status: &str) -> ProcessRow {
	ProcessRow {
		name:          name.to_owned(),
		pid:           (status == "running").then_some(4_242),
		status:        status.to_owned(),
		elapsed_label: "12s".to_owned(),
		terminated_by: None,
		exit_code:     None,
	}
}

/// A session with the supervisor's tab open on `processes`.
fn supervisor_state(processes: Vec<ProcessRow>) -> ShellState {
	let mut state = fixture::populated();
	state.keymap.panel_collapsed = true;
	state.drawer_open = true;
	state.drawer = DrawerContent {
		offered: true,
		tabs: vec![DrawerTab::Processes],
		active_tab: 0,
		processes: processes.clone(),
		..DrawerContent::default()
	};
	// The gate holding a control back is the projection's subject, so every
	// row's signal press is enabled here and this suite reads the drawing.
	let session = SessionId::from(state.current_id.to_string());
	for process in &processes {
		state.controls.set_availability(
			SurfaceId::ProcessSignalButton(session.clone(), process.name.clone()),
			Availability::Enabled,
		);
	}
	state
}

/// Opens a window on the supervisor tab of `processes` and runs `drive`.
fn driven<R>(
	processes: Vec<ProcessRow>,
	drive: impl FnOnce(&mut HeadlessSession<'_, ShellView>) -> R,
) -> R {
	let mut cx = headless_context().expect("headless context available");
	let tokens = load_bundled_tokens().expect("tokens load");
	let theme = load_bundled_theme("dark").expect("theme loads");
	let options =
		RenderOptions { width: WIDTH, height: HEIGHT, scale_factor: 1.0, ..RenderOptions::default() };

	let mut session = HeadlessSession::open(&mut cx, &options, move |_window, app: &mut App| {
		let installed = install_tokens(app, &tokens, &theme, Path::new("surface"))
			.expect("tokens and theme install");
		app.bind_keys(Keymap::default().bindings());
		veyyon_desktop_kit::input::ensure_editor_bindings_registered(app);
		app.new(|_| ShellView::new(installed, supervisor_state(processes)))
	})
	.expect("session opens");
	drive(&mut session)
}

/// Every run below the midline whose text `matches`, as its centre, in the
/// order the frame drew them.
fn all_drawn_in_drawer(captured: &Captured, matches: impl Fn(&str) -> bool) -> Vec<Point<Pixels>> {
	captured
		.text_runs
		.iter()
		.filter(|run| matches(run.text.as_ref().trim()))
		.filter(|run| f32::from(run.bounds.origin.y) > DRAWER_TOP)
		.map(|run| Point {
			x: run.bounds.origin.x + run.bounds.size.width / 2.0,
			y: run.bounds.origin.y + run.bounds.size.height / 2.0,
		})
		.collect()
}

/// Where the frame drew the one run below the midline whose text `matches`, as
/// its centre.
fn drawn_in_drawer(
	captured: &Captured,
	what: &str,
	matches: impl Fn(&str) -> bool,
) -> Point<Pixels> {
	let runs = all_drawn_in_drawer(captured, matches);
	assert_eq!(runs.len(), 1, "the drawer draws `{what}` once, drew {}", runs.len());
	runs[0]
}

/// Presses the drawn signal control of a running process and hands back what
/// the menu that opened is for.
fn press_signal(session: &mut HeadlessSession<'_, ShellView>) -> Option<SignalMenu> {
	let captured = session.frame().expect("the supervisor tab renders");
	let at = drawn_in_drawer(&captured, "Signal", |text| text == "Signal");
	session
		.update(|view, _window, _cx| view.drain_intents())
		.expect("the opening frame's intents are dropped");
	session.click(at).expect("press the row's signal");
	session
		.update(|view, _window, _cx| view.signal_menu().cloned())
		.expect("read back the menu the press opened")
}

#[test]
fn the_rows_the_press_opens_are_every_signal_the_daemon_accepts() {
	let menu = driven(vec![row(PROCESS, "running")], |session| {
		press_signal(session).expect("the press opens a menu")
	});
	let drawn: Vec<String> = signal_menu_items(&menu)
		.iter()
		.map(|(item, _)| item.label.to_string())
		.collect();
	assert_eq!(
		drawn,
		MENU_ROWS.map(str::to_owned).to_vec(),
		"the menu offers another set of signals than the daemon accepts"
	);
	assert_eq!(
		SupervisorSignal::iter().count(),
		MENU_ROWS.len(),
		"a signal was added to the union and the menu's recorded rows were not"
	);
}

#[test]
fn pressing_a_row_sends_that_signal_to_the_process_the_row_was_opened_on() {
	// One press per signal, each from a window of its own: a menu wired to one
	// signal, or to the enum's default, is red on the four it is not.
	for signal in SupervisorSignal::iter() {
		let label = format!("{} ({})", signal.label(), signal.wire());
		let intents = driven(vec![row(PROCESS, "running")], |session| {
			press_signal(session).expect("the press opens a menu");
			let captured = session.frame().expect("the menu renders over the drawer");
			let at = drawn_in_drawer(&captured, &label, |text| text == label);
			session.click(at).expect("press the menu's row");
			session
				.update(|view, _window, _cx| view.drain_intents())
				.expect("read back what the row did")
		});
		let sent: Vec<&Intent> = intents
			.iter()
			.filter(|intent| matches!(intent, Intent::ProcessSignal { .. }))
			.collect();
		assert_eq!(
			sent,
			vec![&Intent::ProcessSignal { process: PROCESS.to_owned(), signal }],
			"pressing `{label}` raised {intents:?}"
		);
	}
}

#[test]
fn the_row_drawn_as_destructive_is_the_signal_a_process_cannot_refuse() {
	let menu = SignalMenu { process: PROCESS.to_owned(), origin: Point::default() };
	let danger: Vec<String> = signal_menu_items(&menu)
		.iter()
		.filter(|(item, _)| item.is_danger)
		.map(|(item, _)| item.label.to_string())
		.collect();
	assert_eq!(
		danger,
		vec!["Kill (SIGKILL)".to_owned()],
		"a signal a process can catch is drawn as though it ends it, or the one it cannot is not"
	);
}

#[test]
fn the_menu_opens_at_the_row_that_was_pressed() {
	// Two rows running, the second pressed: a menu that takes the list's first
	// process, or opens at a fixed point, states the wrong process to signal.
	let (menu, at) = driven(vec![row("api", "running"), row(PROCESS, "running")], |session| {
		let captured = session.frame().expect("the supervisor tab renders");
		let presses = all_drawn_in_drawer(&captured, |text| text == "Signal");
		assert_eq!(presses.len(), 2, "two running processes offer two signal presses");
		let at = presses[1];
		session.click(at).expect("press the second row's signal");
		let menu = session
			.update(|view, _window, _cx| view.signal_menu().cloned())
			.expect("read back the menu the press opened")
			.expect("the press opens a menu");
		(menu, at)
	});
	assert_eq!(menu.process, PROCESS, "the menu is for another row than the one pressed");
	assert_eq!(menu.origin, at, "the menu opened away from the press that opened it");
}

#[test]
fn escape_closes_the_menu_and_leaves_the_drawer_under_it_open() {
	let (open, drawer_open) = driven(vec![row(PROCESS, "running")], |session| {
		press_signal(session).expect("the press opens a menu");
		session.keystroke("escape").expect("dismiss the menu");
		session
			.update(|view, _window, _cx| (view.signal_menu().is_some(), view.state().drawer_open))
			.expect("read back what the dismiss did")
	});
	assert!(!open, "escape left the menu on screen");
	assert!(drawer_open, "escape closed the drawer under the menu as well as the menu");
}

#[test]
fn a_process_that_is_not_running_offers_no_signal_to_send_it() {
	let (menu, intents) = driven(vec![row("build", "exited")], |session| {
		let captured = session.frame().expect("the supervisor tab renders");
		let at = drawn_in_drawer(&captured, "Signal", |text| text == "Signal");
		session
			.update(|view, _window, _cx| view.drain_intents())
			.expect("the opening frame's intents are dropped");
		session.click(at).expect("press the row's signal");
		session
			.update(|view, _window, _cx| (view.signal_menu().cloned(), view.drain_intents()))
			.expect("read back what the press did")
	});
	assert!(menu.is_none(), "an exited process offered a menu of signals to send it");
	assert!(
		!intents
			.iter()
			.any(|intent| matches!(intent, Intent::ProcessSignal { .. })),
		"an exited process was sent a signal, raised {intents:?}"
	);
}
