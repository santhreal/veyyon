//! The reach behind
//! `a-control-still-answers-the-pointer-after-an-overlay-was-dismissed.rs`: the
//! window every case is judged at, every way an overlay leaves the screen,
//! and the pointer sweep that finds the model chip wherever the composer's row
//! of controls puts it.

use std::path::Path;

use veyyon_desktop_kit::{load_bundled_theme, load_bundled_tokens};
use veyyon_desktop_scene::{
	HeadlessSession,
	headless::{Captured, Headless, RenderOptions},
};
use veyyon_desktop_surface::{
	Keymap, Overlay, ShellView, fixture, install_tokens, keymap::resolve_chord, palette::PaletteMode,
};
use veyyon_gpui::{App, AppContext, Bounds, Pixels, Point, px};

/// The window every case is judged at: wide enough that the queue, the session
/// surface and the right panel are all drawn, which is the state the native
/// takes record in.
pub const WIDTH: u32 = 1440;
pub const HEIGHT: u32 = 900;

/// How far above the foot of the window the composer's row of controls can
/// reach. The band is generous on purpose: it is a search region for the chip,
/// not an assertion about where the chip is, and the height of the row is
/// pinned by `a-settings-row-is-the-height-it-declares-whatever-it-says.rs`.
pub const CONTROL_ROW_BAND_PX: f32 = 130.0;

/// How the overlay left the screen before the reopen is attempted.
#[derive(Clone, Copy, Debug)]
pub enum Dismissal {
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
	pub const ALL: [Self; 5] = [
		Self::SlashEscape,
		Self::AnchoredEscape,
		Self::CommandEscape,
		Self::SettingsEscape,
		Self::SlashPressOutside,
	];
}

pub fn open_test_session(cx: &mut Headless) -> HeadlessSession<'_, ShellView> {
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
pub fn palette_mode(session: &mut HeadlessSession<'_, ShellView>) -> Option<PaletteMode> {
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
pub fn control_row_rects(captured: &Captured) -> Vec<Bounds<Pixels>> {
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
pub fn center(rect: Bounds<Pixels>) -> Point<Pixels> {
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
pub fn press_along_control_row(
	session: &mut HeadlessSession<'_, ShellView>,
) -> Option<Bounds<Pixels>> {
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
pub fn dismiss(session: &mut HeadlessSession<'_, ShellView>, how: Dismissal) {
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
