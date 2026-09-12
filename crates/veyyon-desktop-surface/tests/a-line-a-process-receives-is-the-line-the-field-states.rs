//! WHY: the supervisor's row drew a `Send` whose press always raised
//! `ProcessSend { data: [] }`. The host writes that payload to the process's
//! input verbatim, so the press wrote zero bytes and the host answered
//! success: the control could not do the thing it names, from any state, and
//! there was nowhere on the surface to state what to send. It was the sibling
//! of the `Start` that asked the host to run nothing, and it was worse, since
//! a start at least came back refused.
//!
//! CLASS CLOSED: a supervisor control sends what the operator stated, or it
//! sends nothing and says why. The press is swept over the states a line can
//! be in and over which process it is for -- the row that was pressed, the one
//! process running when the submit came from inside the field, several running
//! at once, and none running at all -- and each press is required either to
//! raise a `ProcessSend` carrying exactly the line the field states and the
//! process the surface named, or to raise nothing at all and leave a refusal
//! on the surface. An empty payload reaching the host is what the defect was,
//! so no case may produce one.
//!
//! The press is the drawn `Send`, located by the word the frame recorded and
//! pressed at its centre, so a control wired to nothing fails here rather than
//! passing on a direct call to the submit it should have been wired to.
//!
//! GAPS: it drives the window, not the daemon: that a line written to a
//! process's input reaches the process is the host's contract. Whitespace is
//! data here rather than an empty line, because a byte typed into a field that
//! writes to stdin is a byte the process asked for; a line that states nothing
//! at all is the refusal case.

use std::path::Path;

use veyyon_desktop_kit::{input::Editor, load_bundled_theme, load_bundled_tokens};
use veyyon_desktop_model::{SessionId, SurfaceId};
use veyyon_desktop_scene::{
	headless::{Captured, RenderOptions, headless_context},
	session::HeadlessSession,
};
use veyyon_desktop_surface::{
	Availability, DrawerContent, DrawerTab, Intent, Keymap, ProcessRow, ShellState, ShellView,
	fixture, install_tokens,
};
use veyyon_gpui::{App, AppContext, Entity, Point, px};

const WIDTH: u32 = 1440;
const HEIGHT: u32 = 900;

/// Everything the drawer draws in a 900-high window sits below this: the
/// midline, so a word the transcript or the composer also drew is not read as
/// the drawer's control.
const DRAWER_TOP: f32 = 450.0;

/// The line the operator states, which a shell reading stdin answers with.
const LINE: &str = "y";

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
	// The gate holding a control back is another suite's subject, so every
	// row's `Send` is enabled here and this suite reads the drawing.
	let session = SessionId::from(state.current_id.to_string());
	for process in &processes {
		state.controls.set_availability(
			SurfaceId::ProcessSendButton(session.clone(), process.name.clone()),
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

/// Puts `line` in the drawer's input field and hands the editor back.
fn state_line(session: &mut HeadlessSession<'_, ShellView>, line: &str) -> Entity<Editor> {
	let text = line.to_owned();
	session
		.update(move |view, _window, cx| {
			let editor = view.process_input_field_editor(cx);
			editor.update(cx, |editor, cx| editor.set_text(text, cx));
			editor
		})
		.expect("the input field exists where a process is running")
}

/// What a press left behind: the intents it raised, the refusal the surface
/// states, and what the field is still holding.
struct Pressed {
	intents: Vec<Intent>,
	notice:  Option<String>,
	left:    String,
}

/// States `line` and presses `Send` for `target`, or submits from inside the
/// field when the target is `None`, which is what a return on it does.
fn send(processes: Vec<ProcessRow>, line: &str, target: Option<&str>) -> Pressed {
	let target = target.map(str::to_owned);
	driven(processes, |session| {
		session.frame().expect("the supervisor tab renders");
		let editor = state_line(session, line);
		session
			.update(|view, _window, _cx| view.drain_intents())
			.expect("the opening frame's intents are dropped");
		session
			.update(move |view, _window, cx| view.send_process_input(target, cx))
			.expect("send the line the field states");
		session
			.update(move |view, _window, cx| Pressed {
				intents: view.drain_intents(),
				notice:  view.notice().map(str::to_owned),
				left:    editor.read(cx).text().to_owned(),
			})
			.expect("read back what the press did")
	})
}

/// Where the frame drew `label` inside the drawer, as the centre of the one
/// run below the window's midline whose text is exactly that word.
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

#[test]
fn pressing_the_send_a_row_draws_writes_what_the_field_states_to_that_process() {
	// The press an operator makes, on the word the frame drew, rather than a
	// call to the submit behind it: a `Send` wired to an empty payload, or to
	// nothing at all, fails here.
	let intents = driven(vec![row("dev-server", "running")], |session| {
		let captured = session.frame().expect("the supervisor tab renders");
		state_line(session, LINE);
		session
			.update(|view, _window, _cx| view.drain_intents())
			.expect("the opening frame's intents are dropped");
		let at = drawn_word_in_drawer(&captured, "Send");
		session
			.click(Point { x: px(at.x), y: px(at.y) })
			.expect("press the row's send");
		session
			.update(|view, _window, _cx| view.drain_intents())
			.expect("read back what the press did")
	});
	let sent: Vec<&Intent> = intents
		.iter()
		.filter(|intent| matches!(intent, Intent::ProcessSend { .. }))
		.collect();
	assert_eq!(
		sent,
		vec![&Intent::ProcessSend { process: "dev-server".to_owned(), data: b"y\n".to_vec() }],
		"the drawn `Send` writes the line the field states to the row it is on, raised {intents:?}"
	);
}

#[test]
fn a_line_reaches_the_process_as_the_bytes_it_states_and_a_terminator() {
	for line in ["y", " ", "  padded  ", "quit", "{\"json\":true}"] {
		let pressed = send(vec![row("dev-server", "running")], line, Some("dev-server"));
		let mut wanted = line.as_bytes().to_vec();
		wanted.push(b'\n');
		let sent = pressed
			.intents
			.iter()
			.find_map(|intent| match intent {
				Intent::ProcessSend { process, data } => Some((process.clone(), data.clone())),
				_ => None,
			})
			.unwrap_or_else(|| panic!("`{line}` states a line, so it is sent: {:?}", pressed.intents));
		assert_eq!(sent, ("dev-server".to_owned(), wanted), "`{line}` reaches the process verbatim");
		assert_eq!(
			pressed.notice, None,
			"`{line}` is a line the window can send, so nothing refuses it"
		);
		assert!(
			pressed.left.is_empty(),
			"`{line}` was sent, so the field it came from is empty: {:?}",
			pressed.left
		);
	}
}

#[test]
fn a_line_that_states_nothing_sends_nothing_and_says_why() {
	let pressed = send(vec![row("dev-server", "running")], "", Some("dev-server"));
	assert!(
		!pressed
			.intents
			.iter()
			.any(|intent| matches!(intent, Intent::ProcessSend { .. })),
		"an empty field states no line, so nothing is sent: {:?}",
		pressed.intents
	);
	assert_eq!(
		pressed.notice.as_deref(),
		Some("Sending to a process needs something to send"),
		"the refusal is stated where the line was typed"
	);
}

#[test]
fn a_submit_that_names_no_row_reaches_the_one_process_running() {
	let pressed = send(vec![row("dev-server", "running"), row("build", "exited")], LINE, None);
	assert_eq!(
		pressed.intents.iter().find_map(|intent| match intent {
			Intent::ProcessSend { process, .. } => Some(process.clone()),
			_ => None,
		}),
		Some("dev-server".to_owned()),
		"one process is running, so a return on the field reaches it: {:?}",
		pressed.intents
	);
}

#[test]
fn a_submit_that_names_no_row_with_several_running_sends_nothing_and_says_why() {
	let pressed = send(vec![row("dev-server", "running"), row("worker", "running")], LINE, None);
	assert!(
		!pressed
			.intents
			.iter()
			.any(|intent| matches!(intent, Intent::ProcessSend { .. })),
		"a line is not sent to a process picked for the operator: {:?}",
		pressed.intents
	);
	assert_eq!(
		pressed.notice.as_deref(),
		Some("Press Send on the process this line is for"),
		"the surface states which press would send it"
	);
	assert_eq!(pressed.left, LINE, "a line that was not sent is left in the field");
}

#[test]
fn no_press_of_send_ever_writes_nothing_to_a_process() {
	// The reported defect in one assertion: whatever the field holds and
	// whichever row is pressed, the window never writes an empty payload to a
	// process's input.
	for line in ["", " ", "y", "quit"] {
		for target in [Some("dev-server"), None] {
			let pressed = send(vec![row("dev-server", "running")], line, target);
			for intent in &pressed.intents {
				if let Intent::ProcessSend { data, .. } = intent {
					assert!(!data.is_empty(), "`{line}` sent a write of no bytes");
				}
			}
		}
	}
}

#[test]
fn the_field_the_send_reads_is_drawn_where_a_process_is_running() {
	let with_running = driven(vec![row("dev-server", "running")], |session| {
		let captured = session.frame().expect("the supervisor tab renders");
		captured
			.text_runs
			.iter()
			.find(|run| run.text.as_ref().contains("Line to send"))
			.map(|run| f32::from(run.bounds.origin.y))
	});
	let top = with_running.expect("a running process offers somewhere to state a line for it");
	assert!(top > 450.0, "the input field belongs to the drawer, drawn at y={top}");

	let with_nothing_running = driven(vec![row("build", "exited")], |session| {
		let captured = session.frame().expect("the supervisor tab renders");
		captured
			.text_runs
			.iter()
			.any(|run| run.text.as_ref().contains("Line to send"))
	});
	assert!(
		!with_nothing_running,
		"nothing is running to take a line, so the field that writes one is not drawn"
	);
}
