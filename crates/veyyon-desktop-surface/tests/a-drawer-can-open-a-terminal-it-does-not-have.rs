//! WHY: the drawer's only route to a terminal was opening the drawer. The
//! window turns `SetDrawer { open: true }` into an attach of the newest
//! running terminal, or a create when there is none, and it runs that once.
//! A drawer left open therefore reached no second terminal, and one whose
//! last terminal was closed drew an empty strip captioned `Terminal` with no
//! control on it at all: the operator's way back to a terminal was to close
//! the drawer and open it again. `SurfaceId::TerminalCreateButton` was gated
//! for a control the window drew nowhere.
//!
//! CLASS CLOSED: every tab the drawer can show states what it offers, pinned
//! as the whole chrome row by exact equality, and the terminal contexts --
//! a terminal tab, and the empty strip that is a drawer with no terminal in
//! it -- offer a route to one more. The sweep matches over `DrawerTab`
//! exhaustively, so a new tenant turns this red until its row is recorded,
//! and reads the row off the frame rather than a vocabulary list, so a
//! control added to the chrome fails here until it is stated.
//!
//! The press is the drawn `New`, located by the word the frame recorded and
//! pressed at its centre, so a control wired to nothing fails here rather
//! than passing on a direct dispatch of the intent it should carry.
//!
//! GAPS: it drives the window, not the host. That `CreateTerminal` opens a
//! terminal is the host's contract, and that the intent reaches that action
//! is `an-intent-maps-to-the-actions-the-host-answers`. A process log tab
//! carries no control of its own here: its process is worked from the row it
//! has on the list tab, which is another suite's subject.

use std::path::Path;

use veyyon_desktop_kit::{load_bundled_theme, load_bundled_tokens};
use veyyon_desktop_model::{SessionId, SurfaceId};
use veyyon_desktop_scene::{
	headless::{Captured, RenderOptions, headless_context},
	session::HeadlessSession,
};
use veyyon_desktop_surface::{
	Availability, DrawerContent, DrawerTab, Intent, Keymap, ProcessRow, ShellState, ShellView,
	fixture, install_tokens,
};
use veyyon_gpui::{App, AppContext, Point, px};

const WIDTH: u32 = 1440;
const HEIGHT: u32 = 900;

/// Everything the drawer draws in a 900-high window sits below this: the
/// midline, so a word another surface drew is not read as the drawer's.
const DRAWER_TOP: f32 = 450.0;

/// How far off a run may sit and still be on the same drawn row.
const ROW_TOLERANCE_PX: f32 = 6.0;

/// A terminal tab carrying `title`.
fn terminal(title: &str) -> DrawerTab {
	DrawerTab::Terminal { title: title.to_owned(), id: "t-1".to_owned() }
}

/// One running row, so the supervisor tab has a list to draw.
fn running_row() -> ProcessRow {
	ProcessRow {
		name:          "web".to_owned(),
		pid:           Some(4_242),
		status:        "running".to_owned(),
		elapsed_label: "12s".to_owned(),
		terminated_by: None,
		exit_code:     None,
	}
}

/// A session with the drawer open on `tabs`, `active` selected.
fn drawer_state(tabs: Vec<DrawerTab>, active: usize) -> ShellState {
	let mut state = fixture::populated();
	state.keymap.panel_collapsed = true;
	state.drawer_open = true;
	state.drawer = DrawerContent {
		offered: true,
		tabs,
		active_tab: active,
		processes: vec![running_row()],
		..DrawerContent::default()
	};
	state
}

/// Opens a window on `state` and runs `drive`.
fn driven<R>(state: ShellState, drive: impl FnOnce(&mut HeadlessSession<'_, ShellView>) -> R) -> R {
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
		app.new(|_| ShellView::new(installed, state))
	})
	.expect("session opens");
	drive(&mut session)
}

/// The words the drawer's chrome row drew, left to right, taken from the row
/// `anchor` is on. The anchor is the tab or caption at the row's left, so the
/// row is read off the frame and a control added to it appears here without
/// this suite naming a vocabulary.
fn chrome_row_words(captured: &Captured, anchor: &str) -> Vec<String> {
	let anchor_y = captured
		.text_runs
		.iter()
		.filter(|run| run.text.as_ref().trim() == anchor)
		.map(|run| f32::from(run.bounds.origin.y))
		.filter(|y| *y > DRAWER_TOP)
		.fold(None::<f32>, |lowest, y| Some(lowest.map_or(y, |low: f32| low.max(y))))
		.unwrap_or_else(|| panic!("the drawer's chrome draws `{anchor}`"));

	let mut row: Vec<(f32, String)> = captured
		.text_runs
		.iter()
		.filter(|run| (f32::from(run.bounds.origin.y) - anchor_y).abs() <= ROW_TOLERANCE_PX)
		.map(|run| (f32::from(run.bounds.origin.x), run.text.as_ref().trim().to_owned()))
		.filter(|(_, text)| !text.is_empty())
		.collect();
	row.sort_by(|left, right| left.0.total_cmp(&right.0));
	row.into_iter().map(|(_, text)| text).collect()
}

/// Where the frame drew `label` in the drawer, as the centre of the one run
/// below the midline whose text is exactly that word.
fn drawn_word_in_drawer(captured: &Captured, label: &str) -> Point<f32> {
	let runs: Vec<Point<f32>> = captured
		.text_runs
		.iter()
		.filter(|run| run.text.as_ref().trim() == label)
		.filter(|run| f32::from(run.bounds.origin.y) > DRAWER_TOP)
		.map(|run| Point {
			x: f32::from(run.bounds.origin.x) + f32::from(run.bounds.size.width) / 2.0,
			y: f32::from(run.bounds.origin.y) + f32::from(run.bounds.size.height) / 2.0,
		})
		.collect();
	assert_eq!(runs.len(), 1, "the drawer draws `{label}` exactly once, drew {}", runs.len());
	runs[0]
}

/// Presses `label` in the drawer of `state` and hands back what it raised.
fn press(state: ShellState, label: &str) -> Vec<Intent> {
	let label = label.to_owned();
	driven(state, |session| {
		let captured = session.frame().expect("the drawer renders");
		session
			.update(|view, _window, _cx| view.drain_intents())
			.expect("the opening frame's intents are dropped");
		let at = drawn_word_in_drawer(&captured, &label);
		session
			.click(Point { x: px(at.x), y: px(at.y) })
			.expect("press the drawn control");
		session
			.update(|view, _window, _cx| view.drain_intents())
			.expect("read back what the press did")
	})
}

#[test]
fn pressing_new_on_a_terminal_asks_for_one_more() {
	let raised = press(drawer_state(vec![terminal("bash")], 0), "New");
	assert!(
		raised.contains(&Intent::NewTerminal),
		"the drawn `New` asks for another terminal, raised {raised:?}"
	);
}

#[test]
fn a_drawer_whose_last_terminal_was_closed_can_open_another() {
	// The state the `Close` beside it leaves: an open drawer with an empty
	// strip. Before the fix this frame carried the caption and nothing else,
	// so the only way back to a terminal was closing the drawer.
	let raised = press(drawer_state(Vec::new(), 0), "New");
	assert!(
		raised.contains(&Intent::NewTerminal),
		"an empty drawer offers a terminal, raised {raised:?}"
	);
}

#[test]
fn a_host_that_opens_no_terminal_draws_the_control_inert() {
	let mut state = drawer_state(vec![terminal("bash")], 0);
	let session = SessionId::from(state.current_id.to_string());
	state
		.controls
		.set_availability(SurfaceId::TerminalCreateButton(session), Availability::Unavailable {
			reason: "this host runs no terminal".to_owned(),
		});
	let raised = press(state, "New");
	assert!(
		!raised.contains(&Intent::NewTerminal),
		"a withheld control states the capability by staying inert, raised {raised:?}"
	);
}

#[test]
fn every_tab_the_drawer_can_show_states_what_it_offers() {
	// The whole chrome row, read off the frame and pinned by exact equality:
	// a control added to the chrome, or one that stops being drawn, fails
	// here. The match is exhaustive, so a new tenant is red until its row is
	// recorded rather than inheriting whatever the last arm drew.
	for tab in
		[terminal("bash"), DrawerTab::Processes, DrawerTab::Process { name: "web".to_owned() }]
	{
		let (state, anchor, expected): (ShellState, &str, Vec<&str>) = match &tab {
			DrawerTab::Terminal { title, .. } => {
				(drawer_state(vec![tab.clone()], 0), title.as_str(), vec![
					"bash", "New", "Clear", "Restart", "Close",
				])
			},
			DrawerTab::Processes => {
				(drawer_state(vec![tab.clone()], 0), "Processes", vec!["Processes", "Start"])
			},
			// A log tab draws its process's output. Stop, Restart and Send
			// are on that process's row on the list tab, so the chrome
			// carries the two tabs and no control.
			DrawerTab::Process { name } => {
				(drawer_state(vec![DrawerTab::Processes, tab.clone()], 1), name.as_str(), vec![
					"Processes",
					"web",
				])
			},
		};
		let words = driven(state, |session| {
			let captured = session.frame().expect("the drawer renders");
			chrome_row_words(&captured, anchor)
		});
		assert_eq!(words, expected, "the chrome row of {tab:?}");
	}

	let empty = driven(drawer_state(Vec::new(), 0), |session| {
		let captured = session.frame().expect("the drawer renders");
		chrome_row_words(&captured, "Terminal")
	});
	assert_eq!(
		empty,
		vec!["Terminal", "New"],
		"a drawer with no tab offers the terminal it does not have"
	);
}
