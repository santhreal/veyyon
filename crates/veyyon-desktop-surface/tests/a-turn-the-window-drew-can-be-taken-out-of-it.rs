//! WHY: the window drew every word an agent produced and handed none of them
//! back. The composer's editor could copy its own text, and the kit's clipboard
//! was reached from nowhere else, so a model's answer, the command it ran, the
//! path it named and the refusal it reported were readable on screen and
//! unreachable from anywhere a reader could paste. A transcript that cannot be
//! quoted is a screenshot.
//!
//! CLASS CLOSED: a press on a drawn turn takes THAT turn out of the window.
//! The press is driven through the real window: the turn under the pointer is
//! resolved from the boxes the frame recorded, the `Copy` row is located by the
//! word the frame drew, and the clipboard is read back from the platform after
//! the press, once per turn, so a menu that copies the first turn whatever was
//! pressed, or the words of some other turn, turns this red. The two negative
//! cases pin the guards: a press away from every turn opens nothing, and a
//! dismissing press leaves the clipboard as it was. What each block and each
//! kind of turn states when it is taken out is swept by
//! `every-turn-the-window-drew-states-its-words.rs`.
//!
//! GAPS: it proves what the clipboard holds, not what a foreign application
//! reads out of it -- the headless platform's clipboard is in-memory, and the
//! X11 and Wayland writes are the framework's. It sweeps the turns a state
//! holds, not scrolling: a turn outside the viewport has no box, which is the
//! behaviour `turn_at` states and not a case this presses. Whether the intent
//! stays inside the window rather than reaching a host belongs to
//! `an-intent-the-shell-finishes-alone-is-the-only-one-it-does-not-report`.

use std::path::Path;

use veyyon_desktop_kit::{load_bundled_theme, load_bundled_tokens};
use veyyon_desktop_scene::{
	headless::{Captured, RenderOptions, headless_context},
	session::HeadlessSession,
};
use veyyon_desktop_surface::{
	Intent, Keymap, ShellState, ShellView, damage::Region, fixture, install_tokens,
	transcript::turn_text,
};
use veyyon_gpui::{App, AppContext, ClipboardItem, Pixels, Point, px};

const WIDTH: u32 = 1440;
const HEIGHT: u32 = 900;

/// The word the menu offers, which is the one row a turn menu draws.
const COPY: &str = "Copy";

/// What the clipboard is seeded with before a press that must not write to it,
/// so an untouched clipboard is told apart from an empty one.
const SENTINEL: &str = "what was on the clipboard before the press";

fn seeded_state() -> ShellState {
	let mut state = fixture::populated();
	state.keymap.panel_collapsed = true;
	state.drawer_open = false;
	state
}

/// Opens the window on the fixture, with the clipboard seeded, and runs `test`.
fn render_session<R>(test: impl FnOnce(&mut HeadlessSession<'_, ShellView>) -> R) -> R {
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
		app.write_to_clipboard(ClipboardItem::new_string(SENTINEL.to_owned()));
		app.new(|_| ShellView::new(installed, seeded_state()))
	})
	.expect("session opens");

	test(&mut session)
}

/// What the platform clipboard holds as text.
fn clipboard(session: &mut HeadlessSession<'_, ShellView>) -> Option<String> {
	session
		.update(|_view, _window, cx| cx.read_from_clipboard().and_then(|item| item.text()))
		.expect("read the clipboard")
}

/// The centre of the one text run whose content is exactly `label`.
fn drawn_label(captured: &Captured, label: &str) -> Point<f32> {
	let runs: Vec<Point<f32>> = captured
		.text_runs
		.iter()
		.filter(|run| run.text.as_ref().trim() == label)
		.map(|run| Point {
			x: f32::from(run.bounds.origin.x) + f32::from(run.bounds.size.width) / 2.0,
			y: f32::from(run.bounds.origin.y) + f32::from(run.bounds.size.height) / 2.0,
		})
		.collect();
	assert_eq!(runs.len(), 1, "the frame draws `{label}` exactly once, drew {}", runs.len());
	runs[0]
}

/// The centre of the box the last frame drew `region` in, when it drew one.
fn drawn_region_centre(
	session: &mut HeadlessSession<'_, ShellView>,
	region: Region,
) -> Option<Point<Pixels>> {
	session
		.update(|view, _window, _cx| {
			view.laid_out().drawn_bounds(region).map(|bounds| Point {
				x: bounds.origin.x + bounds.size.width / 2.0,
				y: bounds.origin.y + bounds.size.height / 2.0,
			})
		})
		.expect("read the boxes the frame recorded")
}

/// Reveals a turn and targets its visible intersection with the transcript
/// viewport.
fn drawn_turn_centre(
	session: &mut HeadlessSession<'_, ShellView>,
	index: usize,
) -> Option<Point<Pixels>> {
	session
		.update(|view, _, cx| {
			view.state_mut().keymap.focused_turn = Some(index);
			view.transcript_viewport().focus_turn(index);
			cx.notify();
		})
		.expect("reveal the turn");
	session.frame().expect("revealed turn frame");
	session
		.update(|view, _, _| {
			let bounds = view.laid_out().drawn_bounds(Region::Turn(index))?;
			let viewport = view.laid_out().drawn_bounds(Region::Transcript)?;
			let left = f32::from(bounds.left()).max(f32::from(viewport.left()));
			let right = f32::from(bounds.right()).min(f32::from(viewport.right()));
			let top = f32::from(bounds.top()).max(f32::from(viewport.top()));
			let bottom = f32::from(bounds.bottom()).min(f32::from(viewport.bottom()));
			(left < right && top < bottom)
				.then(|| Point { x: px(f32::midpoint(left, right)), y: px(f32::midpoint(top, bottom)) })
		})
		.expect("visible turn bounds")
}

#[test]
fn pressing_copy_takes_the_turn_the_pointer_was_over() {
	let turns = seeded_state().transcript;
	assert!(turns.len() > 1, "the fixture holds more than one turn, so the wrong one can be caught");

	let mut pressed = 0usize;
	for (index, turn) in turns.iter().enumerate() {
		let wanted = turn_text(turn);
		let taken = render_session(|session| {
			session.frame().expect("frame renders");
			let at = drawn_turn_centre(session, index)?;
			session
				.right_click(at)
				.expect("press the turn the window drew");
			let captured = session.frame().expect("the menu renders");
			let row = drawn_label(&captured, COPY);
			session
				.click(Point { x: px(row.x), y: px(row.y) })
				.expect("press the row the menu drew");
			let open = session
				.update(|view, _window, _cx| view.turn_menu().is_some())
				.expect("read the menu");
			assert!(!open, "the menu closes when its row is pressed, turn {index}");
			clipboard(session)
		});

		let Some(taken) = taken else {
			continue;
		};
		assert_eq!(
			taken, wanted,
			"pressing `Copy` over turn {index} takes that turn's words out of the window"
		);
		pressed += 1;
	}
	assert_eq!(pressed, turns.len(), "every turn is revealed and copied");
}

#[test]
fn a_press_away_from_every_turn_offers_nothing_to_take() {
	render_session(|session| {
		session.frame().expect("frame renders");
		// The composer's own band, taken from the box the frame drew it in:
		// inside the window, drawn over by no turn.
		let at = drawn_region_centre(session, Region::Composer).expect("the frame drew the composer");
		session.right_click(at).expect("press below every turn");
		let captured = session.frame().expect("frame renders");
		let open = session
			.update(|view, _window, _cx| view.turn_menu().is_some())
			.expect("read the menu");
		assert!(!open, "a press where no turn was drawn opens no menu to copy from");
		assert!(
			!captured
				.text_runs
				.iter()
				.any(|run| run.text.as_ref().trim() == COPY),
			"and the window offers no `{COPY}` to press"
		);
		assert_eq!(
			clipboard(session).as_deref(),
			Some(SENTINEL),
			"and nothing was written to the clipboard"
		);
	});
}

#[test]
fn dismissing_the_menu_takes_nothing_out() {
	render_session(|session| {
		session.frame().expect("frame renders");
		let at = drawn_turn_centre(session, 0).expect("the frame drew the first turn");
		session
			.right_click(at)
			.expect("press the turn the window drew");
		let captured = session.frame().expect("the menu renders");
		let row = drawn_label(&captured, COPY);

		// Left of the menu, which is anchored by its top-left at the pointer:
		// the scrim, not a row.
		let corner = Point { x: px(40.0), y: px(row.y) };
		session.click(corner).expect("press the scrim");
		let open = session
			.update(|view, _window, _cx| view.turn_menu().is_some())
			.expect("read the menu");
		assert!(!open, "a press on the scrim dismisses the menu");
		assert_eq!(
			clipboard(session).as_deref(),
			Some(SENTINEL),
			"and copies nothing on the way out"
		);
	});
}

#[test]
fn a_turn_with_no_words_is_not_written_to_the_clipboard() {
	render_session(|session| {
		session
			.update(|view, _window, cx| view.dispatch(Intent::CopyText(String::new()), cx))
			.expect("dispatch an empty copy");
		assert_eq!(
			clipboard(session).as_deref(),
			Some(SENTINEL),
			"an empty turn leaves the clipboard holding what it held"
		);
	});
}
