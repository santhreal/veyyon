//! WHY: A native take of `proof/scenes/desktop-content-search.sh` ran
//! `/search` from the composer and typed a query: every keystroke landed in the
//! draft, the palette kept the rows of the command list it was opened from, and
//! the frame after the emptied field still inked the earlier matches. The row
//! reported its lookup to the host and then handed the keyboard back to the
//! composer, because `run_palette` closed the palette and restored composer
//! focus for every row alike, including the three rows whose whole answer is
//! another mode's rows. The prompt was wrong for the same reason: the retained
//! editor carried the one placeholder it was built with, so the per-mode prompt
//! in `PaletteMode::placeholder` never reached a frame that drew a real editor.
//!
//! THE CLASS THIS CLOSES: a palette row that opens another mode and does not
//! hand it the keyboard, its query or its prompt. The rows are swept from
//! `command_items()` at run time and each one's mode is read from what its
//! intent leaves open, so a fourth lookup row enters this sweep by existing.
//! Both ways in are driven -- the slash menu the composer opens and the command
//! palette a chord opens -- because the two differ in which editor holds focus
//! when the row runs. Every assertion is made after a rendered frame through
//! GPUI's own keystroke dispatch, so a fix that only moves state without moving
//! focus stays red.
//!
//! WHAT IT DOES NOT CATCH: what the host answers a lookup with, which
//! `a-content-search-lists-the-lines-the-host-found` and
//! `a-browse-row-lists-the-directory-it-opened` own; the descent inside
//! `Browse`, driven by `a-palette-row-runs-from-the-keyboard-that-selected-it`;
//! the width the lookup takes once it leaves the composer's anchor, which
//! `a-popover-anchored-to-a-control-is-narrower-than-the-palette` measures and
//! the scene capture shows; and the X11 recorder's own key delivery, which no
//! in-process suite reaches.

use std::path::Path;

use strum::{EnumIter, IntoEnumIterator};
use veyyon_desktop_kit::{load_bundled_theme, load_bundled_tokens};
use veyyon_desktop_scene::{
	headless::{RenderOptions, headless_context},
	session::HeadlessSession,
};
use veyyon_desktop_surface::{
	Intent, Keymap, Overlay, PaletteState, ShellState, ShellView, fixture, install_tokens,
	palette::{PaletteItem, PaletteItemKind, PaletteMode, commands::command_items},
};
use veyyon_gpui::{App, AppContext};

/// The text typed into the lookup once it is open, which belongs to its query
/// and to nothing else.
const TYPED: &str = "deadline";

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

/// The two ways a command row is reached, which differ in the editor that holds
/// focus when the row runs.
#[derive(Debug, Clone, Copy, EnumIter)]
enum Entry {
	/// Typed as a slash command in the composer, whose editor keeps the draft.
	Slash,
	/// Typed in the command palette, whose editor is the window's own.
	Palette,
}

/// The command rows that open another palette mode, with the mode each one
/// leaves open. The mode is read from what the row's intent applies, so this is
/// the same answer the shell reaches rather than a second list of it.
fn openers() -> Vec<(String, Intent, PaletteMode)> {
	command_items()
		.into_iter()
		.filter_map(|item| {
			let PaletteItemKind::Command { intent } = &item.kind else {
				return None;
			};
			let intent = (**intent).clone();
			let mut state = ShellState::default();
			intent.apply(&mut state);
			let mode = state.overlay_palette().map(|palette| palette.mode)?;
			(mode != PaletteMode::Commands).then_some((item.title.clone(), intent, mode))
		})
		.collect()
}

/// The rows a mode is answered with, so an emptied field has something to
/// clear or to keep. Exhaustive, so a seventh mode states its own rows before
/// this compiles.
fn answer_rows(mode: PaletteMode) -> Vec<PaletteItem> {
	match mode {
		PaletteMode::Files => {
			vec![PaletteItem::file(1, "src/app.rs"), PaletteItem::file(2, "src/other.rs")]
		},
		PaletteMode::ContentSearch => vec![
			PaletteItem::content_match(1, "src/app.rs", 12, "let deadline = now();"),
			PaletteItem::content_match(2, "src/other.rs", 3, "// deadline"),
		],
		PaletteMode::Browse => {
			vec![PaletteItem::directory(1, "crates"), PaletteItem::directory(2, "packages")]
		},
		PaletteMode::Commands | PaletteMode::Sessions | PaletteMode::Models => Vec::new(),
	}
}

#[test]
fn a_row_that_opens_a_lookup_hands_it_the_keyboard() {
	let openers = openers();
	assert!(!openers.is_empty(), "the command list carries rows that open a lookup");
	for entry in Entry::iter() {
		for (name, intent, mode) in &openers {
			let case = format!("{entry:?} {name}");
			render_session(fixture::populated(), |session| {
				session.frame().expect("first frame");
				match entry {
					Entry::Slash => {
						session
							.type_text(name)
							.expect("the command name typed in the composer");
					},
					Entry::Palette => {
						session
							.update(|view, window, cx| view.open_command_palette(window, cx))
							.expect("command palette opens");
						session.frame().expect("palette frame");
						session
							.type_text(name)
							.expect("the command name typed in the palette");
					},
				}
				session.frame().expect("filtered frame");
				session
					.update(|view, _window, _cx| {
						let selected = view
							.state()
							.overlay
							.as_ref()
							.and_then(Overlay::as_palette)
							.and_then(PaletteState::selected_item)
							.map(|item| item.title.clone())
							.expect("the command list is open with a row selected");
						assert_eq!(&selected, name, "{case}: the name typed selects its own row");
						view.drain_intents();
					})
					.expect("row selected");

				let handled = session.keystroke("enter").expect("enter dispatched");
				assert!(handled, "{case}: the enter key reached a handler");
				session.frame().expect("frame after the row ran");

				session
					.update(|view, _window, cx| {
						let palette = view
							.state()
							.overlay
							.as_ref()
							.and_then(Overlay::as_palette)
							.expect("the lookup stays open behind the row that opened it");
						assert_eq!(palette.mode, *mode, "{case}: the mode the row opened");
						assert!(palette.query().is_empty(), "{case}: the lookup opens on no query");
						assert_eq!(view.drain_intents(), vec![intent.clone()], "{case}");
						assert_eq!(view.composer_text(), "", "{case}: the row left no draft behind");
						let editor = view
							.palette_editor()
							.expect("the lookup draws the editor the window retains");
						assert_eq!(editor.read(cx).text(), "", "{case}: the query field is empty");
						assert_eq!(
							editor.read(cx).placeholder_text(),
							mode.placeholder(),
							"{case}: the field prompts for what this mode looks up"
						);
					})
					.expect("state after the row ran");

				session
					.type_text(TYPED)
					.expect("the query typed after the lookup opened");
				session.frame().expect("frame after the query");
				session
					.update(|view, _window, _cx| {
						let palette = view
							.state()
							.overlay
							.as_ref()
							.and_then(Overlay::as_palette)
							.expect("the lookup is open over what it is looking up");
						assert_eq!(palette.mode, *mode, "{case}: the mode the query belongs to");
						assert_eq!(palette.query(), TYPED, "{case}: the keystrokes reached the query");
						assert_eq!(
							view.composer_text(),
							"",
							"{case}: and none of them reached the draft"
						);
						// A mode whose rows are the host's answer to what was
						// typed reports each keystroke's lookup; a mode that
						// ranks the rows it already holds reports nothing.
						let expected: Vec<Intent> = (1..=TYPED.len())
							.map(|end| palette.query_intent(TYPED[..end].to_owned()))
							.filter(|intent| !intent.is_local())
							.collect();
						assert_eq!(
							view.drain_intents(),
							expected,
							"{case}: what typing asked the host for"
						);
					})
					.expect("state after the query");

				// The host's answer to what was typed, put in front of the
				// mode the way the projection puts it there.
				session
					.update(|view, _window, _cx| {
						view
							.state_mut()
							.overlay
							.as_mut()
							.and_then(Overlay::as_palette_mut)
							.expect("the lookup is open")
							.set_items(answer_rows(*mode));
					})
					.expect("rows answered");
				session.frame().expect("frame over the rows");
				for _ in 0..TYPED.chars().count() {
					session
						.keystroke("backspace")
						.expect("backspace dispatched");
				}
				session.frame().expect("frame after the field emptied");
				session
					.update(|view, _window, _cx| {
						let palette = view
							.state()
							.overlay
							.as_ref()
							.and_then(Overlay::as_palette)
							.expect("the lookup stays open on an empty field");
						assert!(palette.query().is_empty(), "{case}: the field emptied");
						// Host-backed searches discard the previous answer when
						// their query changes; local lists retain their source rows.
						if palette.query_intent(String::new()).is_local() {
							assert!(
								!palette.items().is_empty(),
								"{case}: rows the window owns survive an emptied field"
							);
						} else {
							assert!(
								palette.items().is_empty(),
								"{case}: the rows followed the query that fetched them"
							);
						}
					})
					.expect("state after the field emptied");
			});
		}
	}
}
