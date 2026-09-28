//! The terminal drawer opens a terminal in the thread's directory, sizes it
//! to the box it is drawn in, draws what it writes, writes what is typed on
//! it, and sends what its controls pick; its processes tab starts, stops,
//! restarts and signals what the supervisor runs and draws each process's
//! output.
//!
//! WHY: a terminal told the wrong size wraps every line the shell draws, a
//! key the window keeps never reaches the shell, and output streaming into a
//! tab nobody looks at must not redraw the window. The suite drives the real
//! `TerminalDrawer` inside the real `Workspace` over an `AppState` fed host
//! events, types on its grid, clicks the driver targets it registers and
//! reads the drawn text, the requests queued and the drawer's render count.
//!
//! Gap: the emulator's own escape handling is the model crate's; only plain
//! text and line breaks are drawn here. Selection by drag is not driven.

mod harness;
mod processes;
mod refusals;
mod scrollback;

use gpui::TestAppContext;
use veyyon_desktop_app::drawer::DrawerTab;
use veyyon_desktop_model::{HostAction, TerminalStatus};
use veyyon_desktop_ui::theme::text;

use self::harness::{
	CWD, Win, both, delta, opened, output, refused, succeeded, terminal, terminals, window,
};

/// The drawer open on terminal `t1`, which it asked for and the host
/// started, with every request since drained.
fn running(app: &mut TestAppContext) -> Win<'_> {
	let mut w = window(app, opened(both()));
	w.toggle();
	let create = w.one();
	w.apply(vec![terminals(vec![terminal("t1", TerminalStatus::Running)]), succeeded(create.id)]);
	w.requests();
	w
}

fn t1() -> DrawerTab {
	DrawerTab::Terminal("t1".to_owned())
}

fn write(id: &str, data: &[u8]) -> HostAction {
	HostAction::WriteTerminal { terminal_id: id.to_owned(), data: data.to_vec() }
}

#[gpui::test]
fn opening_asks_for_a_terminal_in_the_threads_directory_and_tells_it_the_cells_its_box_holds(
	app: &mut TestAppContext,
) {
	let mut w = window(app, opened(both()));
	assert_eq!(w.sent(), Vec::<HostAction>::new(), "a closed drawer asks the host for nothing");

	w.toggle();
	let create = w.one();
	assert_eq!(create.action, HostAction::CreateTerminal {
		cwd:   Some(CWD.to_owned()),
		shell: None,
	});
	assert!(w.bounds("drawer.control:new").is_some(), "the new-terminal control waits in place");

	w.apply(vec![terminals(vec![terminal("t1", TerminalStatus::Running)]), succeeded(create.id)]);
	assert_eq!(w.shown(), Some(t1()), "the terminal asked for is shown once it arrives");
	assert!(w.draws("zsh"), "its tab is named after its shell");
	let (cols, rows) = w.cells().expect("the grid's box was measured");
	assert_eq!(w.sent(), vec![
		HostAction::AttachTerminal { terminal_id: "t1".to_owned() },
		HostAction::ResizeTerminal { terminal_id: "t1".to_owned(), cols, rows },
	]);

	let grid = w
		.bounds("drawer.grid:terminal:t1")
		.expect("the grid is laid out");
	let cell = w.cx.update(|window, _| {
		let system = window.text_system();
		let face = system.resolve_font(&gpui::font(text::MONO.family));
		system
			.advance(face, text::MONO.size, 'm')
			.expect("the mono face has an advance")
			.width
	});
	let fits = |cells: u16, step: f32, extent: f32| {
		f32::from(cells) * step <= extent && f32::from(cells + 1) * step > extent
	};
	assert!(fits(cols, f32::from(cell), f32::from(grid.size.width)), "{cols} columns fill {grid:?}");
	let line = f32::from(text::MONO.line_height);
	assert!(fits(rows, line, f32::from(grid.size.height)), "{rows} rows fill {grid:?}");

	w.toggle();
	w.toggle();
	assert_eq!(w.sent(), Vec::<HostAction>::new(), "a reopened drawer asks for nothing it holds");
}

#[gpui::test]
fn output_is_drawn_on_the_grid_and_keys_typed_there_are_written_to_the_terminal(
	app: &mut TestAppContext,
) {
	let mut w = running(app);
	w.apply(vec![output("t1", 1, "hello from zsh\r\n$ ")]);
	assert!(w.draws("hello from zsh"));

	w.keys("l s enter up ctrl-c");
	assert_eq!(w.sent(), vec![
		write("t1", b"l"),
		write("t1", b"s"),
		write("t1", b"\r"),
		write("t1", b"\x1b[A"),
		write("t1", &[0x03]),
	]);

	w.keys("ctrl-b");
	assert_eq!(w.sent(), vec![write("t1", &[0x02])], "the shell's control keys reach the shell");
	assert!(w.layout().sidebar_visible, "and not the window's binding for them");

	w.cx
		.write_to_clipboard(gpui::ClipboardItem::new_string("echo one\necho two".to_owned()));
	w.keys("ctrl-shift-v");
	assert_eq!(
		w.sent(),
		vec![write("t1", b"echo one\recho two")],
		"a paste ends lines as Enter does"
	);

	w.keys("ctrl-j");
	assert!(!w.layout().drawer_open, "the window keeps the drawer's own binding");
	assert_eq!(w.sent(), Vec::<HostAction>::new());
}

#[gpui::test]
fn a_refused_control_states_the_refusal_and_retry_sends_it_again(app: &mut TestAppContext) {
	let mut w = running(app);
	w.click("drawer.control:clear");
	let clear = w.one();
	assert_eq!(clear.action, HostAction::ClearTerminal { terminal_id: "t1".to_owned() });

	w.apply(vec![refused(clear.id, "the pty is gone")]);
	assert!(w.bounds("drawer.refused").is_some());
	assert!(w.draws("The host refused clearing the terminal: the pty is gone"));

	w.click_text("Retry");
	assert_eq!(w.sent(), vec![HostAction::ClearTerminal { terminal_id: "t1".to_owned() }]);
	assert_eq!(w.bounds("drawer.refused"), None, "a retried refusal is no longer stated");

	w.click("drawer.control:restart");
	assert_eq!(w.sent(), vec![HostAction::RestartTerminal { terminal_id: "t1".to_owned() }]);
	w.click("drawer.control:close");
	assert_eq!(w.sent(), vec![HostAction::CloseTerminal { terminal_id: "t1".to_owned() }]);

	w.apply(vec![terminals(Vec::new())]);
	assert_eq!(w.strip(), vec![DrawerTab::Processes], "a closed terminal leaves the strip");
	assert_eq!(w.bounds("drawer.tab:terminal:t1"), None);
}

#[gpui::test]
fn a_refused_terminal_is_not_waited_for_and_retry_waits_for_it_again(app: &mut TestAppContext) {
	let mut w = window(app, opened(both()));
	w.toggle();
	let create = w.one();
	assert_eq!(w.shown(), None, "the drawer waits for the terminal it asked for");

	w.apply(vec![refused(create.id, "no pty left")]);
	assert!(w.draws("The host refused opening the terminal: no pty left"));
	assert_eq!(w.shown(), Some(DrawerTab::Processes), "a refused terminal is not waited for");
	assert_eq!(
		w.sent(),
		vec![HostAction::RefreshProcesses],
		"the tab it falls back to is asked for"
	);

	w.click_text("Retry");
	let retry = w.one();
	assert_eq!(retry.action, create.action);
	assert_eq!(w.shown(), None, "a retried terminal is waited for again");
	w.apply(vec![terminals(vec![terminal("t1", TerminalStatus::Running)]), succeeded(retry.id)]);
	assert_eq!(w.shown(), Some(t1()), "and shown once it arrives");
}

#[gpui::test]
fn output_into_a_hidden_tab_a_closed_drawer_or_a_streamed_turn_renders_nothing(
	app: &mut TestAppContext,
) {
	let mut w = running(app);
	w.apply(vec![terminals(vec![
		terminal("t1", TerminalStatus::Running),
		terminal("t2", TerminalStatus::Exited { code: 2 }),
	])]);
	assert_eq!(w.shown(), Some(t1()), "a terminal nobody asked for does not take the drawer");
	assert!(w.draws("zsh (exit 2)"), "an ended terminal's tab states how it ended");
	assert_eq!(w.sent(), Vec::<HostAction>::new(), "a hidden terminal is not attached");

	let before = w.renders();
	let hidden = (1..=20)
		.map(|seq| output("t2", seq, &format!("hidden line {seq}\r\n")))
		.collect();
	w.apply(hidden);
	let turn = (1..=50).map(delta).collect();
	w.apply(turn);
	assert_eq!(w.renders(), before, "neither a hidden tab's output nor a turn redraws the drawer");
	assert!(!w.draws("hidden line 20"));

	w.toggle();
	w.apply(vec![output("t1", 1, "while closed\r\n")]);
	w.toggle();
	assert!(
		w.draws("while closed"),
		"a reopened drawer draws what arrived while it was closed: {:?} in {:?} cells, showing {:?}",
		w.texts(),
		w.cells(),
		w.shown()
	);

	w.click("drawer.tab:terminal:t2");
	assert_eq!(w.shown(), Some(DrawerTab::Terminal("t2".to_owned())));
	assert!(w.draws("hidden line 20"), "a tab shown late replays its retained output");
	assert_eq!(
		w.sent(),
		vec![HostAction::AttachTerminal { terminal_id: "t2".to_owned() }],
		"an ended terminal is attached for its output and never resized"
	);
	assert_eq!(
		w.state
			.read_with(&*w.cx, |state, _| state.active_drawer_tab().map(str::to_owned)),
		Some("terminal:t2".to_owned())
	);
}
