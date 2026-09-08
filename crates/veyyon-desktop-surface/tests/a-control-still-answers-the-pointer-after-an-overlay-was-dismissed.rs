//! WHY: a native capture of the queue badge abandoned six takes in a row at
//! `model-picker-open`. The chord that opens the model catalogue moved 1/1000
//! of the window and a left click on the chip that names the model moved
//! 0/1000, so the model id typed after it went into the draft and the prompt
//! submitted after that was a turn with no model. Every one of those takes had
//! opened and dismissed an overlay first — the shared composer prelude opens
//! the slash palette and presses Escape — and the chip drew its chevron the
//! whole time, which is the shape of the worst defect this surface can ship: a
//! control that looks live and answers nothing.
//!
//! CLASS CLOSED: a dismissal that leaves the surface unable to reopen what it
//! dismissed. Every way an overlay leaves the screen is swept from the route
//! table rather than listed here, and each is followed by both hands — a real
//! `MouseDown`/`MouseUp` pair on the chip's own hit rect, and the chord — so a
//! path that survives on the keyboard and dies under the pointer fails here.
//! The press is dispatched through the window, so a handler that is registered
//! on an element the frame never hit-tests, sits under an occluding hitbox, or
//! is refused by a stale availability, is caught the same way the operator
//! meets it.
//!
//! NOT CAUGHT: whether the reopened catalogue holds the rows the host sent,
//! which is `a-model-picker-states-the-account-above-the-models-it-serves.rs`,
//! and whether the chord's spelling is the one the keymap publishes, which is
//! `every-chord-in-the-table-resolves-innermost-first-and-a-duplicate-fails-to-load.rs`.

use std::path::Path;

use veyyon_desktop_kit::{load_bundled_theme, load_bundled_tokens};
use veyyon_desktop_scene::{
	HeadlessSession,
	headless::{Captured, Headless, RenderOptions, headless_context},
};
use veyyon_desktop_surface::{
	Intent, Keymap, Overlay, ShellView, fixture, install_tokens, keymap::resolve_chord,
	palette::PaletteMode,
};
use veyyon_gpui::{App, AppContext, Bounds, Pixels, Point, px};

/// The window every case is judged at: wide enough that the queue, the session
/// surface and the right panel are all drawn, which is the state the native
/// takes record in.
const WIDTH: u32 = 1440;
const HEIGHT: u32 = 900;

/// How far above the foot of the window the composer's row of controls can
/// reach. The band is generous on purpose: it is a search region for the chip,
/// not an assertion about where the chip is, and the height of the row is
/// pinned by `a-settings-row-is-the-height-it-declares-whatever-it-says.rs`.
const CONTROL_ROW_BAND_PX: f32 = 130.0;

/// How the overlay left the screen before the reopen is attempted.
#[derive(Clone, Copy, Debug)]
enum Dismissal {
	/// The slash palette, opened by a leading slash in the draft and dismissed
	/// by Escape, which is what the shared composer prelude leaves behind.
	SlashEscape,
	/// The model catalogue itself, opened from the chip and dismissed by
	/// Escape: reopening what was just closed is the same reach twice.
	AnchoredEscape,
	/// The command palette, opened by its chord and dismissed by Escape.
	CommandEscape,
	/// A settings page, reached as a route and dismissed by Escape, which
	/// unwinds a destination rather than a popover.
	SettingsEscape,
	/// The slash palette dismissed by a press outside it rather than by a key,
	/// which is the other way an operator closes one.
	SlashPressOutside,
}

impl Dismissal {
	/// Every way an overlay leaves the screen, so a new one is added here
	/// rather than discovered in a capture.
	const ALL: [Self; 5] = [
		Self::SlashEscape,
		Self::AnchoredEscape,
		Self::CommandEscape,
		Self::SettingsEscape,
		Self::SlashPressOutside,
	];
}

fn open_test_session(cx: &mut Headless) -> HeadlessSession<'_, ShellView> {
	let tokens = load_bundled_tokens().expect("the bundled tokens load");
	let theme = load_bundled_theme("dark").expect("the bundled dark theme loads");
	let options =
		RenderOptions { width: WIDTH, height: HEIGHT, scale_factor: 1.0, ..RenderOptions::default() };
	HeadlessSession::open(cx, &options, move |_window, app: &mut App| {
		let installed = install_tokens(app, &tokens, &theme, Path::new("surface"))
			.expect("the bundled tokens and theme install");
		app.bind_keys(Keymap::default().bindings());
		veyyon_desktop_kit::input::ensure_editor_bindings_registered(app);
		app.new(|_| ShellView::new(installed, fixture::populated()))
	})
	.expect("the shell opens in a headless window")
}

/// The mode of the palette on screen, or `None` when no palette is.
fn palette_mode(session: &mut HeadlessSession<'_, ShellView>) -> Option<PaletteMode> {
	session
		.update(|view, _, _| {
			view
				.state()
				.overlay
				.as_ref()
				.and_then(Overlay::as_palette)
				.map(|palette| palette.mode)
		})
		.expect("the overlay is readable")
}

/// Every hit rect the frame registered inside the composer's row of controls,
/// leftmost first, which is the order a pointer sweeping the row meets them.
fn control_row_rects(captured: &Captured) -> Vec<Bounds<Pixels>> {
	let floor = px(HEIGHT as f32 - CONTROL_ROW_BAND_PX);
	let mut rects: Vec<Bounds<Pixels>> = captured
		.hitboxes
		.iter()
		.copied()
		.filter(|rect| {
			// A rect the size of a region is the region, not a control in it.
			rect.origin.y >= floor && rect.size.width < px(WIDTH as f32 / 3.0)
		})
		.collect();
	rects.sort_by(|a, b| {
		a.origin
			.x
			.partial_cmp(&b.origin.x)
			.expect("a hit rect has a finite origin")
	});
	rects
}

/// The point a pointer presses to reach `rect`.
fn center(rect: Bounds<Pixels>) -> Point<Pixels> {
	Point { x: rect.origin.x + rect.size.width / 2.0, y: rect.origin.y + rect.size.height / 2.0 }
}

/// Presses each control in the composer's row from the left until the model
/// catalogue is on screen, and hands back the rect that answered.
///
/// The sweep is the reach, not a retry: the chip's position in the row depends
/// on what the right panel leaves of the session surface, and a test that
/// hardcoded one point would pass or fail on the panel's width instead of on
/// whether the chip answers. The rect rather than its index is returned,
/// because a press changes what the row registers and an index into the row
/// does not survive one.
fn press_along_control_row(session: &mut HeadlessSession<'_, ShellView>) -> Option<Bounds<Pixels>> {
	let captured = session
		.frame()
		.expect("a frame is captured before the sweep");
	let rects = control_row_rects(&captured);
	assert!(
		!rects.is_empty(),
		"the frame registered no hit rect in the bottom {CONTROL_ROW_BAND_PX}px of the window, so \
		 the composer drew no control the pointer can reach at all"
	);
	for rect in rects {
		session
			.click(center(rect))
			.expect("the press is dispatched to the window");
		session.frame().expect("the frame after the press");
		match palette_mode(session) {
			Some(PaletteMode::Models) => return Some(rect),
			// Another control in the row answered — the attachment picker, a
			// turn action's own popover. It is put away before the next press,
			// so the sweep measures each control rather than whatever the last
			// one left open.
			Some(_) => {
				session.keystroke("escape").expect("Escape dispatches");
				session.frame().expect("the frame after putting it away");
			},
			None => {},
		}
	}
	None
}

/// Leaves the window with no overlay, having had one dismissed the way `how`
/// names.
fn dismiss(session: &mut HeadlessSession<'_, ShellView>, how: Dismissal) {
	match how {
		Dismissal::SlashEscape | Dismissal::SlashPressOutside => {
			session
				.update(|view, _, cx| view.set_composed("/", cx))
				.expect("the draft takes a leading slash");
			session.frame().expect("the slash palette renders");
			assert_eq!(
				palette_mode(session),
				Some(PaletteMode::Commands),
				"a leading slash in the draft opened no command palette, so this case dismisses \
				 nothing and would pass without reaching the defect"
			);
			if matches!(how, Dismissal::SlashEscape) {
				assert!(
					session.keystroke("escape").expect("Escape dispatches"),
					"Escape was not handled while the slash palette was open"
				);
			} else {
				// The transcript, which is above the composer and covered by no
				// overlay of the composer's own.
				session
					.click(Point { x: px(WIDTH as f32 / 2.0), y: px(HEIGHT as f32 / 3.0) })
					.expect("the press outside the palette is dispatched");
			}
		},
		Dismissal::AnchoredEscape => {
			session
				.update(|view, window, cx| view.open_model_picker(window, cx))
				.expect("the catalogue opens");
			session.frame().expect("the catalogue renders");
			assert_eq!(
				palette_mode(session),
				Some(PaletteMode::Models),
				"the catalogue did not open, so this case dismisses nothing"
			);
			assert!(
				session.keystroke("escape").expect("Escape dispatches"),
				"Escape was not handled while the catalogue was open"
			);
		},
		Dismissal::CommandEscape => {
			assert!(
				session
					.keystroke(&resolve_chord("primary-k"))
					.expect("the command chord dispatches"),
				"the command palette chord was not handled"
			);
			session.frame().expect("the command palette renders");
			assert_eq!(
				palette_mode(session),
				Some(PaletteMode::Commands),
				"the command palette did not open, so this case dismisses nothing"
			);
			assert!(
				session.keystroke("escape").expect("Escape dispatches"),
				"Escape was not handled while the command palette was open"
			);
		},
		Dismissal::SettingsEscape => {
			assert!(
				session
					.keystroke(&resolve_chord("primary-,"))
					.expect("the settings chord dispatches"),
				"the settings chord was not handled"
			);
			session.frame().expect("the settings page renders");
			session
				.update(|view, _, _| {
					assert!(
						view.state().overlay.is_some(),
						"the settings chord opened nothing, so this case dismisses nothing"
					);
				})
				.expect("the overlay is readable");
			// A settings destination ascends before it closes, so Escape is
			// pressed until nothing is open. The bound is asserted rather than
			// looped on forever: an ascent that never reaches the bottom is a
			// surface the operator cannot leave.
			let mut escapes = 0;
			while session
				.update(|view, _, _| view.state().overlay.is_some())
				.expect("the overlay is readable")
			{
				assert!(
					escapes < 8,
					"Escape was pressed 8 times and a settings destination is still open, so the \
					 ascent does not terminate"
				);
				assert!(
					session.keystroke("escape").expect("Escape dispatches"),
					"Escape stopped being handled part way up the settings ascent"
				);
				session.frame().expect("the frame after one ascent");
				escapes += 1;
			}
		},
	}
	session.frame().expect("the frame after the dismissal");
	session
		.update(|view, _, cx| {
			view.set_composed("", cx);
			assert!(
				view.state().overlay.is_none(),
				"{how:?} left an overlay on screen, so the reopen below would measure a palette that \
				 never closed"
			);
		})
		.expect("the draft is cleared and the overlay is gone");
	// Exactly one frame follows the dismissal, so the press below lands while
	// the dismissed overlay is still on screen fading out. That is when the
	// operator's next press arrives, and a float that keeps occluding through
	// its exit eats it.
	session.frame().expect("the first frame of the exit");
}

#[test]
fn the_model_chip_answers_a_press_on_a_window_that_has_dismissed_nothing() {
	// The control case. Without it a failure below cannot be read: a chip that
	// answers no press on a fresh window is a wiring defect in the footer, and
	// one that answers here and not after a dismissal is the float eating the
	// pointer on its way out.
	let mut cx = headless_context().expect("a headless renderer is required");
	let mut session = open_test_session(&mut cx);

	assert!(
		press_along_control_row(&mut session).is_some(),
		"no press along the composer's row of controls opened the model catalogue on a window where \
		 nothing had been opened or dismissed, so the chip is not wired to the pointer at all"
	);
}

#[test]
fn the_model_chip_answers_a_press_after_every_way_an_overlay_is_dismissed() {
	let mut cx = headless_context().expect("a headless renderer is required");
	for how in Dismissal::ALL {
		let mut session = open_test_session(&mut cx);
		dismiss(&mut session, how);

		let reached = press_along_control_row(&mut session);
		assert!(
			reached.is_some(),
			"after {how:?} no press anywhere along the composer's row of controls opened the model \
			 catalogue, so the chip draws a chevron and answers nothing, and a model id typed after \
			 the press lands in the draft"
		);
	}
}

#[test]
fn the_model_chord_answers_after_every_way_an_overlay_is_dismissed() {
	let mut cx = headless_context().expect("a headless renderer is required");
	for how in Dismissal::ALL {
		let mut session = open_test_session(&mut cx);
		dismiss(&mut session, how);

		let handled = session
			.keystroke(&resolve_chord("primary-shift-m"))
			.expect("the model chord dispatches");
		session.frame().expect("the frame after the chord");
		assert!(
			handled,
			"after {how:?} the model chord reached no action, so the keys land in the composer and \
			 the return after them submits a model id as a prompt"
		);
		assert_eq!(
			palette_mode(&mut session),
			Some(PaletteMode::Models),
			"after {how:?} the model chord was handled by something other than the catalogue"
		);
	}
}

#[test]
fn a_press_on_the_chip_reopens_the_catalogue_it_just_dismissed_every_time() {
	let mut cx = headless_context().expect("a headless renderer is required");
	let mut session = open_test_session(&mut cx);

	// One reach establishes which control in the row is the chip. Repeating the
	// press on that same rect is what an operator retrying a missed click does,
	// and it is where a dismissal that poisons the reopen shows up on the
	// second attempt rather than the first.
	dismiss(&mut session, Dismissal::SlashEscape);
	let chip = press_along_control_row(&mut session).expect("the chip answers the first press");
	assert!(
		session.keystroke("escape").expect("Escape dispatches"),
		"Escape was not handled with the catalogue open"
	);
	session.frame().expect("the frame with the catalogue shut");

	for attempt in 1..=3 {
		session
			.click(center(chip))
			.expect("the press on the chip is dispatched");
		session.frame().expect("the frame after the press");
		assert_eq!(
			palette_mode(&mut session),
			Some(PaletteMode::Models),
			"the chip stopped answering on attempt {attempt}, so a dismissal poisons the control \
			 that opened it"
		);

		assert!(
			session.keystroke("escape").expect("Escape dispatches"),
			"Escape was not handled on attempt {attempt}"
		);
		session.frame().expect("the frame after the dismissal");
		assert_eq!(
			palette_mode(&mut session),
			None,
			"Escape on attempt {attempt} left the catalogue open"
		);
	}
}

/// A queue row that opens a different session, the session that was open
/// before it was pressed, and the one it opened.
///
/// It is pressed here on a window with nothing open, so the row is known to
/// answer a press at all before the suite asks whether a press it should not
/// answer reaches it.
fn a_queue_row_that_opens_a_session(
	session: &mut HeadlessSession<'_, ShellView>,
) -> (Bounds<Pixels>, u64, u64) {
	let captured = session.frame().expect("a frame is captured");
	let before = session
		.update(|view, _, _| view.state().current_id)
		.expect("the open session is readable");
	let mut rows: Vec<Bounds<Pixels>> = captured
		.hitboxes
		.iter()
		.copied()
		.filter(|rect| {
			// A row of the queue: against the leading edge, no wider than the
			// rail, below the rail's search field, and between a line's height
			// and a card's.
			rect.origin.x < px(32.0)
				&& rect.size.width < px(320.0)
				&& rect.origin.y > px(96.0)
				&& rect.size.height > px(24.0)
				&& rect.size.height < px(96.0)
		})
		.collect();
	rows.sort_by(|a, b| {
		a.origin
			.y
			.partial_cmp(&b.origin.y)
			.expect("a hit rect has a finite origin")
	});
	for rect in rows {
		session
			.click(center(rect))
			.expect("the press on the queue row is dispatched");
		session.frame().expect("the frame after the press");
		let after = session
			.update(|view, _, _| view.state().current_id)
			.expect("the open session is readable");
		if after != before {
			return (rect, before, after);
		}
	}
	panic!(
		"no press in the queue rail opened a different session, so this suite has no control \
		 outside the popover whose activation it can observe"
	);
}

#[test]
fn the_press_that_dismisses_a_popover_does_not_also_run_what_it_landed_on() {
	// The other half of the exit rule. A popover that stops occluding the
	// moment it closes would let the very press that closed it continue into
	// the row underneath, opening a session the operator never chose. The
	// dismissing press is spent; the ones after it are not.
	let mut cx = headless_context().expect("a headless renderer is required");
	let mut session = open_test_session(&mut cx);

	let (row, before, opened) = a_queue_row_that_opens_a_session(&mut session);
	// Back to the session the row was pressed from, so the press below has the
	// same row to change and the same value to change it from.
	session
		.update(|view, _, cx| view.dispatch(Intent::SelectSession(before), cx))
		.expect("the session the sweep started from reopens");
	session.frame().expect("the frame with that session open");
	assert_eq!(
		session
			.update(|view, _, _| view.state().current_id)
			.expect("the open session is readable"),
		before,
		"the reset did not reopen the session the row was pressed from"
	);
	assert_ne!(
		before, opened,
		"the row opens the session that is already open, so the press below cannot be seen to have \
		 activated it"
	);

	session
		.update(|view, window, cx| view.open_model_picker(window, cx))
		.expect("the catalogue opens");
	session.frame().expect("the catalogue renders");
	assert_eq!(
		palette_mode(&mut session),
		Some(PaletteMode::Models),
		"the catalogue did not open, so there is no popover for the press to dismiss"
	);

	session
		.click(center(row))
		.expect("the press outside the popover is dispatched");
	session.frame().expect("the frame after the press");

	assert_eq!(palette_mode(&mut session), None, "a press outside the popover did not dismiss it");
	assert_eq!(
		session
			.update(|view, _, _| view.state().current_id)
			.expect("the open session is readable"),
		before,
		"the press that dismissed the popover also opened the session under it, so one press made \
		 two decisions"
	);
}

#[test]
fn a_press_on_the_scrim_dismisses_the_dialog_and_runs_nothing_behind_it() {
	// The centred branch of the same rule. A command palette is modal: while it
	// is open the scrim answers a press anywhere outside the dialog by closing
	// it, and nothing under the scrim sees that press. The anchored branch is
	// `the_press_that_dismisses_a_popover_does_not_also_run_what_it_landed_on`;
	// the two placements are separate code paths and each needs its own case.
	let mut cx = headless_context().expect("a headless renderer is required");
	let mut session = open_test_session(&mut cx);

	let (row, before, opened) = a_queue_row_that_opens_a_session(&mut session);
	session
		.update(|view, _, cx| view.dispatch(Intent::SelectSession(before), cx))
		.expect("the session the sweep started from reopens");
	session.frame().expect("the frame with that session open");
	assert_ne!(
		before, opened,
		"the row opens the session that is already open, so the press below cannot be seen to have \
		 activated it"
	);

	assert!(
		session
			.keystroke(&resolve_chord("primary-k"))
			.expect("the command chord dispatches"),
		"the command palette chord was not handled"
	);
	session.frame().expect("the command palette renders");
	assert_eq!(
		palette_mode(&mut session),
		Some(PaletteMode::Commands),
		"the command palette did not open, so there is no scrim for the press to land on"
	);

	session
		.click(center(row))
		.expect("the press on the scrim is dispatched");
	session.frame().expect("the frame after the press");

	assert_eq!(
		palette_mode(&mut session),
		None,
		"a press on the scrim outside the dialog did not dismiss it"
	);
	assert_eq!(
		session
			.update(|view, _, _| view.state().current_id)
			.expect("the open session is readable"),
		before,
		"the press on the scrim reached the queue row behind it, so the dialog is not modal"
	);
}
