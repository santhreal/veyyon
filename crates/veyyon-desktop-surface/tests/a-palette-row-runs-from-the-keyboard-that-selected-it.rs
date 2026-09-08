//! WHY: A native take of `proof/scenes/desktop-navigation.sh` filtered the
//! model catalogue to one provider, pressed Return, and published a frame
//! byte-identical to the one before it: the palette had neither closed nor
//! sent anything. Every suite covering the palette called `run_palette`
//! directly, so nothing exercised the key that reaches it.
//!
//! CLASS CLOSED: For every `PaletteMode`, a row selected in a palette the
//! shell opened is run by the `enter` key travelling the real dispatch tree of
//! a rendered frame: an action row closes the palette and records the intent
//! its click would record, and a directory row descends instead of doing
//! nothing. The mode set is swept from `PaletteMode::iter()` through an
//! exhaustive match, so a seventh mode fails to compile until it states what
//! its Enter does.
//!
//! GAPS: The X11 recorder's own key delivery is not covered here; this drives
//! GPUI's keystroke dispatch, not xdotool. A row's availability gate is
//! covered by `support/composer-submission.rs`.

use std::path::Path;

use strum::IntoEnumIterator;
use veyyon_desktop_kit::{load_bundled_theme, load_bundled_tokens};
use veyyon_desktop_scene::{
	headless::{RenderOptions, headless_context},
	session::HeadlessSession,
};
use veyyon_desktop_surface::{
	Intent, Keymap, Overlay, PaletteState, ShellState, ShellView, fixture, install_tokens,
	palette::{PaletteItem, PaletteMode},
};
use veyyon_gpui::{App, AppContext, Context, Window};

fn render_session<R>(
	state: ShellState,
	test: impl FnOnce(&mut HeadlessSession<ShellView>) -> R,
) -> R {
	let mut cx = headless_context().expect("headless context available");
	let tokens = load_bundled_tokens().expect("tokens load");
	let theme = load_bundled_theme("dark").expect("theme loads");
	let options =
		RenderOptions { width: 1440, height: 900, scale_factor: 1.0, ..RenderOptions::default() };
	let mut session = HeadlessSession::open(&mut cx, &options, move |_window, app: &mut App| {
		let installed = install_tokens(app, &tokens, &theme, Path::new("surface"))
			.expect("tokens and theme install");
		app.bind_keys(Keymap::default().bindings());
		veyyon_desktop_kit::input::ensure_editor_bindings_registered(app);
		app.new(|_| ShellView::new(installed, state))
	})
	.expect("session opens");
	test(&mut session)
}

/// What Enter is expected to do with the row a mode's query leaves selected.
#[derive(Debug, Clone, PartialEq, Eq)]
enum Outcome {
	/// The palette closes and the shell records this intent for the host.
	Runs(Intent),
	/// The palette stays open and steps into the directory named.
	Descends(&'static str),
}

/// The rows a mode carries when no host has projected any, so a mode no
/// surface opens yet is still driven by the same key.
fn seeded_rows(mode: PaletteMode) -> Vec<PaletteItem> {
	match mode {
		PaletteMode::Files | PaletteMode::ContentSearch => {
			vec![PaletteItem::file(1, "src/app.rs"), PaletteItem::file(2, "src/other.rs")]
		},
		PaletteMode::Browse => {
			vec![PaletteItem::directory(1, "crates"), PaletteItem::directory(2, "packages")]
		},
		PaletteMode::Commands | PaletteMode::Sessions | PaletteMode::Models => Vec::new(),
	}
}

/// Opens the palette for `mode` the way the shell opens it, so the editor the
/// keystroke lands in is the one the window owns.
fn open(mode: PaletteMode, view: &mut ShellView, window: &mut Window, cx: &mut Context<ShellView>) {
	match mode {
		PaletteMode::Commands => view.open_command_palette(window, cx),
		PaletteMode::Models => view.open_model_picker(window, cx),
		PaletteMode::Sessions => view.open_queue_search(window, cx),
		// No control opens these three yet: the host projects their rows onto
		// an open palette (`project_palette_domains`). The command surface is
		// opened for its editor and focus, then the mode's rows are put in
		// front of it, which is the state that projection leaves behind.
		PaletteMode::Files | PaletteMode::ContentSearch | PaletteMode::Browse => {
			view.open_command_palette(window, cx);
			let mut state = PaletteState::new(mode);
			state.set_items(seeded_rows(mode));
			view.state_mut().overlay = Some(Overlay::Palette(state));
		},
	}
}

/// The query that leaves exactly the row whose outcome is asserted selected,
/// and what Enter must then do.
fn case(mode: PaletteMode) -> (&'static str, Outcome) {
	match mode {
		PaletteMode::Commands => ("/new", Outcome::Runs(Intent::NewSession)),
		PaletteMode::Sessions => ("Backdrop", Outcome::Runs(Intent::SelectSession(8))),
		PaletteMode::Models => (
			"opus",
			Outcome::Runs(Intent::SelectModel(veyyon_desktop_surface::composer::ModelChoice {
				provider: "anthropic".to_owned(),
				model:    "claude-opus-4.1".to_owned(),
			})),
		),
		PaletteMode::Files | PaletteMode::ContentSearch => {
			("app", Outcome::Runs(Intent::OpenFile("src/app.rs".to_owned())))
		},
		PaletteMode::Browse => ("crates", Outcome::Descends("crates")),
	}
}

#[test]
fn every_palette_mode_runs_its_selected_row_from_the_enter_key() {
	for mode in PaletteMode::iter() {
		let (query, outcome) = case(mode);
		render_session(fixture::populated(), |session| {
			session
				.update(|view, window, cx| {
					open(mode, view, window, cx);
					view.drain_intents();
				})
				.expect("palette opens");
			session.frame().expect("palette frame");
			session.type_text(query).expect("query typed");
			session.frame().expect("filtered frame");
			session
				.update(|view, _window, _cx| {
					let palette = view
						.state()
						.overlay
						.as_ref()
						.and_then(Overlay::as_palette)
						.expect("palette open after typing");
					assert_eq!(palette.query(), query, "{mode:?}: the query reached the editor");
					assert!(
						!palette.filtered_items().is_empty(),
						"{mode:?}: the query left a row to run"
					);
				})
				.expect("query state");

			let handled = session.keystroke("enter").expect("enter dispatched");
			assert!(handled, "{mode:?}: the enter key reached a handler");

			session
				.update(|view, _window, _cx| {
					let overlay = view.state().overlay.clone();
					match &outcome {
						Outcome::Runs(intent) => {
							assert_eq!(view.drain_intents(), vec![intent.clone()], "{mode:?}");
							assert!(overlay.is_none(), "{mode:?}: the palette closed behind the row");
						},
						Outcome::Descends(into) => {
							assert_eq!(view.drain_intents(), vec![], "{mode:?}");
							let palette = overlay
								.as_ref()
								.and_then(Overlay::as_palette)
								.expect("palette stays open on a directory row");
							assert_eq!(palette.browse_path, vec![(*into).to_owned()], "{mode:?}");
							assert!(palette.query().is_empty(), "{mode:?}: the query cleared");
						},
					}
				})
				.expect("enter outcome");
		});
	}
}
