//! WHY: the queue's arrows opened. `MoveQueueSelection` resolved the row a
//! press landed on and dispatched `SelectSession` for it, which a host answers
//! with `OpenSession` and `RefreshChanges`, so holding `down` opened every
//! session the cursor passed over and loaded every transcript on the way. §5.14
//! gives the arrows one job, moving the selection, and `Enter` the other,
//! opening the row the selection is on. With the open already on the arrows,
//! `Enter` had nothing left to do: its handler re-selected the session that was
//! already open, and `P`, `D` and `K` moved that session rather than the row
//! under the cursor, so the rail could not be navigated without opening it.
//!
//! CLASS CLOSED: the split, from both sides. Every command §5.14 scopes to the
//! queue is read out of the shipped keymap at run time rather than listed here,
//! so a chord added to the queue scope fails this suite until it is classified
//! as one that reaches a host, one that records nothing, or one that records a
//! fold the window answers itself, and every command classified as recording
//! nothing is pressed as its own chord and observed to record nothing. The
//! chords are sent to the real rail, focused the way an operator focuses it, so
//! the scope that gates them and the action each name resolves to are carried
//! by the press rather than restated here. The row every verb acts on is
//! asserted with the cursor moved off the open session, which is the only
//! arrangement that tells the two apart, and the cursor is asserted to hold no
//! row the rail has stopped drawing.
//!
//! NOT CAUGHT: the host's answer to an open, which the desktop crate owns, and
//! the rail's scroll to the cursor, which the queue's motion suites measure. A
//! binding moved out of the queue scope still reads as classified here; what
//! fails then is the press, which reaches no handler. Which arrow steps which
//! way is the keymap's argument, which the delta sweep on the model states.

mod support;

use std::collections::BTreeSet;

use veyyon_desktop_kit::{load_bundled_theme, load_bundled_tokens};
use veyyon_desktop_scene::{
	HeadlessSession,
	headless::{Headless, RenderOptions, headless_context},
};
use veyyon_desktop_surface::{
	ConnectionPhase, Intent, Keymap, ShellState, ShellView, damage::Region, install_tokens,
	intent::Intents, keymap::Scope, model::Section,
};
use veyyon_gpui::{App, AppContext, Pixels, Point, point};

/// The rows the fixture lists, in the order the rail lists them.
const LISTED: [u64; 3] = [7, 9, 11];

/// The three decisions a command the queue scopes carries: it reaches a host,
/// it records nothing at all, or it records a fold the window answers itself
/// by writing its own store. A queue chord added without one fails
/// `every_command_the_queue_scopes_is_classified`. What a fold records with a
/// branch under the cursor is pinned by
/// `the-queue-rail-draws-branch-hierarchies-as-an-indented-collapsible-tree.
/// rs`, since this fixture lists three flat rows.
const REACHES_A_HOST: [&str; 4] =
	["OpenSelectedSession", "TogglePinSelected", "ToggleDeferSelected", "ToggleParkSelected"];
const RECORDS_NOTHING: [&str; 2] = ["MoveSelection", "FilterQueue"];
const RECORDS_A_FOLD: [&str; 2] = ["FoldSelectedBranch", "UnfoldSelectedBranch"];

/// The fixture with `current` open and the cursor wherever the arrows left it.
///
/// Attached, because a window that is still attaching draws the attach screen
/// in place of the columns, and the rail a press lands on is one of them.
fn state_open_at(current: u64) -> ShellState {
	let mut state = support::state();
	state.connection = ConnectionPhase::Attached;
	state.current_id = current;
	state.title = state
		.row(current)
		.expect("the fixture lists the open row")
		.title
		.clone();
	state
}

/// The commands the shipped keymap scopes to the queue.
fn queue_commands() -> BTreeSet<&'static str> {
	Keymap::load_default()
		.expect("the shipped keymap loads")
		.rows()
		.into_iter()
		.filter(|row| row.scope == Scope::Queue)
		.map(|row| row.command.name())
		.collect()
}

/// Every chord the shipped keymap binds to `command` inside the queue. Both
/// arrows name `MoveSelection` and are separated by an argument a keymap row
/// does not carry, so one chord per command takes whichever the file lists
/// first, and for the arrows that is the one that clamps on the top row.
fn chords_for(command: &str) -> Vec<String> {
	let chords: Vec<String> = Keymap::load_default()
		.expect("the shipped keymap loads")
		.rows()
		.into_iter()
		.filter(|row| row.scope == Scope::Queue && row.command.name() == command)
		.map(|row| row.chord)
		.collect();
	assert!(!chords.is_empty(), "the queue binds no chord to {command}");
	chords
}

/// The one chord the queue binds to `command`, for a verb that takes one.
fn chord_for(command: &str) -> String {
	let mut chords = chords_for(command);
	assert_eq!(chords.len(), 1, "the queue binds {} chords to {command}", chords.len());
	chords.remove(0)
}

/// Opens the shell on `state` with the shipped keymap and editor bindings, so a
/// chord routes through the same table the window routes it through.
fn open(cx: &mut Headless, state: ShellState) -> HeadlessSession<'_, ShellView> {
	let tokens = load_bundled_tokens().expect("the bundled tokens load");
	let theme = load_bundled_theme("dark").expect("the bundled dark theme loads");
	let options =
		RenderOptions { width: 1440, height: 900, scale_factor: 1.0, ..RenderOptions::default() };
	HeadlessSession::open(cx, &options, move |_window, app: &mut App| {
		let installed =
			install_tokens(app, &tokens, &theme, std::path::Path::new("surface")).expect("install");
		app.bind_keys(Keymap::default().bindings());
		veyyon_desktop_kit::input::ensure_editor_bindings_registered(app);
		app.new(|_| ShellView::new(installed, state))
	})
	.expect("the session opens offscreen")
}

/// The middle of the box the last frame drew for the first row of the rail,
/// whichever item index and row shape it took: a section draws cards or lines,
/// and its header takes an item index of its own, so the index a row lands on
/// is the fixture's business and not this suite's.
fn first_row_center(session: &mut HeadlessSession<'_, ShellView>) -> Point<Pixels> {
	let bounds = session
		.update(|view, _window, _cx| {
			(0..8)
				.flat_map(|ix| [Region::QueueCardRow(ix), Region::QueueLineRow(ix)])
				.find_map(|region| view.laid_out().drawn_bounds(region))
		})
		.expect("the view is live")
		.expect("the rail drew a row to press");
	point(bounds.origin.x + bounds.size.width / 2.0, bounds.origin.y + bounds.size.height / 2.0)
}

/// Hands the keyboard to the rail the way an operator does, by pressing a row
/// in it, and hands back the row that press left the cursor on.
///
/// Without the press the queue's chords reach no handler: the scope §5.14
/// gives them is on the rail's own focus. The rail's list measures on the
/// first frame and lays its rows out on the second, so a press taken after
/// one frame lands on a rail that has drawn no row to press.
fn focus_rail(session: &mut HeadlessSession<'_, ShellView>) -> u64 {
	session.frame().expect("the first frame renders");
	session.frame().expect("the settling frame renders");
	let at = first_row_center(session);
	session.click(at).expect("the rail answers the press");
	session
		.update(|view, _window, _cx| view.drain_intents())
		.expect("the view is live");
	let focused = cursor(session);
	assert!(focused != 0, "the press on a row left the cursor on no row");
	focused
}

/// Presses the queue's arrows until the cursor leaves `from`, and hands back
/// the row it landed on. One of the two clamps, since the press that focuses
/// the rail lands on its top row. Each press is asserted to reach no host, so
/// the walk is also the proof that an arrow is local.
fn arrow_off(session: &mut HeadlessSession<'_, ShellView>, from: u64) -> u64 {
	for chord in chords_for("MoveSelection") {
		assert!(
			press(session, &chord).is_empty(),
			"{chord} reached a host, and an arrow moves the cursor and nothing else"
		);
		let landed = cursor(session);
		if landed != from {
			return landed;
		}
	}
	panic!("neither arrow moved the cursor off row {from}");
}

/// Presses `chord` at the rail and hands back the intents it recorded for a
/// host.
fn press(session: &mut HeadlessSession<'_, ShellView>, chord: &str) -> Vec<Intent> {
	let handled = session.keystroke(chord).expect("the chord parses");
	assert!(handled, "{chord} reached no handler, so the rail does not hold the keyboard");
	session
		.update(|view, _window, _cx| view.drain_intents())
		.expect("the view is live")
}

/// The row the rail's cursor is on, as every queue verb reads it.
fn cursor(session: &mut HeadlessSession<'_, ShellView>) -> u64 {
	session
		.update(|view, _window, _cx| view.state().selected_row())
		.expect("the view is live")
}

#[test]
fn moving_the_selection_reaches_no_host_and_leaves_the_open_session_where_it_was() {
	// The table the old contract swept, read against the cursor: the same
	// filters, deltas and bounds, with the open session held still.
	for (current, filter, delta, target) in [
		(7, None, 1, Some(9)),
		(9, None, -1, Some(7)),
		(9, None, i32::MAX, Some(11)),
		(9, None, i32::MIN, Some(7)),
		(7, None, -1, None),
		(11, None, 1, None),
		(9, None, 0, None),
		(7, Some("third"), 1, Some(11)),
		(7, Some("third"), -1, Some(11)),
		(7, Some("missing"), 1, None),
	] {
		let mut state = state_open_at(current);
		state.keymap.queue_filter = filter.map(str::to_owned);
		let before = state.clone();
		let mut intents = Intents::new();
		intents.dispatch(Intent::MoveQueueSelection(delta), &mut state);

		let label = format!("open={current} filter={filter:?} delta={delta}");
		assert_eq!(
			state.selected_row(),
			target.unwrap_or(current),
			"{label}: the cursor is not on the row the movement resolved"
		);
		assert_eq!(
			state.current_id, before.current_id,
			"{label}: moving the selection changed the open session"
		);
		assert_eq!(state.title, before.title, "{label}: moving the selection changed the title");
		assert_eq!(
			state.composer, before.composer,
			"{label}: moving the selection changed the draft"
		);
		assert!(
			intents.drain().is_empty(),
			"{label}: moving the selection reached a host, which opens a session per press"
		);
	}
}

#[test]
fn arrows_held_down_walk_the_list_instead_of_stepping_off_the_open_session() {
	// Anchoring on the open session makes every press after the first resolve
	// the same row, so the rail cannot be walked.
	let mut state = state_open_at(LISTED[0]);
	let mut intents = Intents::new();
	let mut walked = Vec::new();
	for _ in 0..4 {
		intents.dispatch(Intent::MoveQueueSelection(1), &mut state);
		walked.push(state.selected_row());
	}
	assert_eq!(walked, vec![9, 11, 11, 11], "a held arrow does not walk the rail to its end");
	assert!(intents.drain().is_empty(), "walking the rail reached a host");
}

#[test]
fn the_press_that_opens_is_enter_and_it_opens_the_row_the_cursor_is_on() {
	let mut cx = headless_context().expect("the headless context opens");
	let mut session = open(&mut cx, state_open_at(LISTED[0]));
	let focused = focus_rail(&mut session);
	let moved = arrow_off(&mut session, focused);

	assert_eq!(
		press(&mut session, &chord_for("OpenSelectedSession")),
		vec![Intent::SelectSession(moved)],
		"Enter did not open the row the cursor is on"
	);
}

#[test]
fn enter_on_the_row_that_is_already_open_reaches_no_host() {
	// The cursor rests on the open session, so there is nothing to open. The
	// old handler re-selected it here: an open and a transcript load for a
	// press that changed nothing.
	let mut cx = headless_context().expect("the headless context opens");
	let mut session = open(&mut cx, state_open_at(LISTED[0]));
	let focused = focus_rail(&mut session);

	assert_eq!(cursor(&mut session), focused, "the cursor left the row that was pressed");
	assert!(
		press(&mut session, &chord_for("OpenSelectedSession")).is_empty(),
		"Enter re-opened the session that was already open"
	);
}

#[test]
fn a_partition_chord_moves_the_row_the_cursor_is_on_not_the_one_that_is_open() {
	let mut cx = headless_context().expect("the headless context opens");
	let mut session = open(&mut cx, state_open_at(LISTED[0]));
	let focused = focus_rail(&mut session);
	let moved = arrow_off(&mut session, focused);

	assert_eq!(
		press(&mut session, &chord_for("TogglePinSelected")),
		vec![Intent::PinSession(moved)],
		"the pin chord moved the open session instead of the row under the cursor"
	);
}

#[test]
fn every_command_the_queue_scopes_is_classified() {
	let mut classified: BTreeSet<&'static str> = REACHES_A_HOST.into_iter().collect();
	classified.extend(RECORDS_NOTHING);
	classified.extend(RECORDS_A_FOLD);
	assert_eq!(
		queue_commands(),
		classified,
		"a command the queue scopes states none of the three decisions"
	);
}

#[test]
fn a_command_classified_local_records_nothing_for_a_host() {
	// Pressed with the cursor off the open session, where a verb acting on the
	// wrong row would have something to send, and once per chord, not command.
	let mut cx = headless_context().expect("the headless context opens");
	let mut session = open(&mut cx, state_open_at(LISTED[0]));
	let focused = focus_rail(&mut session);
	arrow_off(&mut session, focused);

	for command in RECORDS_NOTHING {
		for chord in chords_for(command) {
			assert!(
				press(&mut session, &chord).is_empty(),
				"{command} on {chord} reached a host, and the queue's keyboard is navigation"
			);
		}
	}
}

#[test]
fn the_cursor_waits_for_the_open_it_asked_for_and_then_follows_it() {
	// A press on a row and a palette entry both dispatch `SelectSession`,
	// which the host answers. Until it does, the cursor stays on the session
	// that is open: a cursor on the requested row reveals it, and revealing a
	// row expands the partition holding it, so the rail restructures itself
	// for a load that may be refused.
	let mut state = state_open_at(LISTED[0]);
	let mut intents = Intents::new();
	intents.dispatch(Intent::MoveQueueSelection(1), &mut state);
	assert_eq!(state.selected_row(), LISTED[1]);

	intents.dispatch(Intent::SelectSession(LISTED[2]), &mut state);
	assert_eq!(
		state.selected_row(),
		LISTED[0],
		"the cursor moved to a row the host had not opened yet"
	);

	// What an acknowledgement does: the host's projection sets the open row.
	state.current_id = LISTED[2];
	assert_eq!(
		state.selected_row(),
		LISTED[2],
		"the cursor stayed behind when the open was acknowledged"
	);
	intents.dispatch(Intent::MoveQueueSelection(-1), &mut state);
	assert_eq!(
		state.selected_row(),
		LISTED[1],
		"the arrows did not continue from the row the acknowledgement opened"
	);
	assert_eq!(
		state.row(LISTED[2]).map(|row| row.placement),
		Some(Section::Parked),
		"the fixture no longer lists the third row where this case needs it"
	);
}

#[test]
fn a_cursor_the_rail_stops_listing_falls_back_to_the_open_session() {
	// Two ways a cursor is left pointing at a row that is not drawn: a filter
	// that hides it, and a host refresh that drops it. A press acting on the
	// cursor would then pin, park or open a row the operator cannot see.
	let mut state = state_open_at(LISTED[0]);
	let mut intents = Intents::new();
	intents.dispatch(Intent::MoveQueueSelection(1), &mut state);
	assert_eq!(state.selected_row(), LISTED[1], "the arrow did not move the cursor");

	let hidden = state
		.row(LISTED[1])
		.expect("the fixture lists the second row")
		.title
		.clone();
	assert!(
		!hidden.to_lowercase().contains("third"),
		"the filter this case needs no longer hides the row the cursor is on"
	);
	intents.dispatch(Intent::FilterQueue("third".to_owned()), &mut state);
	assert_eq!(state.selected_row(), LISTED[0], "the cursor held a row the filter hid");

	intents.dispatch(Intent::FilterQueue(String::new()), &mut state);
	assert_eq!(state.selected_row(), LISTED[1], "the cursor did not return when the filter lifted");

	for (_, rows) in &mut state.sections {
		rows.retain(|row| row.id != LISTED[1]);
	}
	assert_eq!(state.selected_row(), LISTED[0], "the cursor held a row the rail dropped");
}
