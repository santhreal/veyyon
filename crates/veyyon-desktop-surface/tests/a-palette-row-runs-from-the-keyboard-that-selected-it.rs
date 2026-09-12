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
use veyyon_desktop_kit::load_bundled_theme;
use veyyon_desktop_scene::{
	headless::{RenderOptions, headless_context},
	session::HeadlessSession,
};
use veyyon_desktop_surface::{
	Intent, Keymap, Overlay, PaletteState, ShellState, ShellView, fixture, install_tokens,
	palette::{PaletteItem, PaletteMode},
};
use veyyon_gpui::{App, AppContext, Context, Window};

#[allow(dead_code, reason = "only the existing still-token fixture is needed")]
#[path = "support/appearance/mod.rs"]
mod appearance;
#[path = "support/menu_bar_contract.rs"]
mod menu_bar_contract;
#[path = "support/menu_picker_contract.rs"]
mod menu_picker_contract;
#[path = "support/picker_availability.rs"]
mod picker_availability;
#[path = "support/picker_contract.rs"]
mod picker_contract;

fn render_session<R>(
	state: ShellState,
	test: impl FnOnce(&mut HeadlessSession<ShellView>) -> R,
) -> R {
	let mut cx = headless_context().expect("headless context available");
	let tokens = appearance::still_tokens();
	let theme = load_bundled_theme("dark").expect("theme loads");
	let options =
		RenderOptions { width: 1440, height: 900, scale_factor: 1.0, ..RenderOptions::default() };
	let mut session = HeadlessSession::open(&mut cx, &options, move |_window, app: &mut App| {
		let installed = install_tokens(app, &tokens, &theme, Path::new("surface"))
			.expect("tokens and theme install");
		app.bind_keys(Keymap::default().bindings());
		let themes = veyyon_desktop_tokens::APPEARANCES
			.into_iter()
			.map(|name| load_bundled_theme(name).expect("bundled appearance"))
			.collect();
		app.set_global(veyyon_desktop_surface::ThemeLibrary::new(
			&tokens,
			themes,
			Path::new("surface"),
		));
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
		PaletteMode::Files => {
			vec![PaletteItem::file(1, "src/app.rs"), PaletteItem::file(2, "src/other.rs")]
		},
		PaletteMode::ContentSearch => {
			vec![
				PaletteItem::content_match(1, "src/app.rs", 12, "let app = App::new();"),
				PaletteItem::content_match(2, "src/other.rs", 3, "let other = 1;"),
			]
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
		// `/files`, `/search` and `/project` open these three, and the host
		// projects their rows onto the open palette
		// (`project_palette_domains`). The command surface is opened for its
		// editor and focus, then the mode's rows are put in front of it,
		// which is the state that projection leaves behind.
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
					// A mode whose rows are the host's answer to what was
					// typed reports each keystroke's lookup; a mode that ranks
					// the rows it already holds reports nothing, so the
					// assertion on Enter below reads what Enter alone sent.
					let reported = view.drain_intents();
					let expected: Vec<Intent> = (1..=query.len())
						.map(|end| mode.query_intent(query[..end].to_owned()))
						.filter(|intent| !intent.is_local())
						.collect();
					assert_eq!(reported, expected, "{mode:?}: what typing asked the host for");
				})
				.expect("query state");

			let handled = session.keystroke("enter").expect("enter dispatched");
			assert!(handled, "{mode:?}: the enter key reached a handler");

			session
				.update(|view, _window, cx| {
					let overlay = view.state().overlay.clone();
					match &outcome {
						Outcome::Runs(intent) => {
							assert_eq!(view.drain_intents(), vec![intent.clone()], "{mode:?}");
							assert!(overlay.is_none(), "{mode:?}: the palette closed behind the row");
						},
						Outcome::Descends(into) => {
							// The descent is a listing the host owns, so Enter reports
							// it and the palette stays open over the rows it will
							// answer with.
							assert_eq!(
								view.drain_intents(),
								vec![Intent::BrowseTo { path: Some((*into).to_owned()) }],
								"{mode:?}"
							);
							let palette = overlay
								.as_ref()
								.and_then(Overlay::as_palette)
								.expect("palette stays open on a directory row");
							assert_eq!(palette.browse_root(), Some(*into), "{mode:?}");
							assert!(palette.query().is_empty(), "{mode:?}: the query cleared");
							// The field the operator types into is the state
							// the descent left, or the next keystroke appends
							// to a query the palette no longer holds.
							let editor = view.palette_editor().expect("the palette's own editor");
							assert_eq!(
								editor.read(cx).text(),
								"",
								"{mode:?}: the field cleared with the query"
							);
						},
					}
				})
				.expect("enter outcome");
		});
	}
}

// WHY: New list overlays must not bypass the input contract when their data
// adapter differs. This sweeps modes, composer commands and settings pages;
// read-only history previews and non-picker settings dialogs are exact
// opt-outs. GAPS: Host transport and X11 delivery are integration checks, not
// simulated here.
#[test]
fn every_registered_picker_navigates_cancels_and_restores_the_draft_focus() {
	for source in picker_contract::sources() {
		render_session(fixture::populated(), |session| {
			session
				.update(|view, window, cx| {
					view.set_composed("retained draft", cx);
					picker_contract::open(source, view, window, cx);
				})
				.unwrap();
			picker_contract::navigate(session, source);
			if !matches!(source, picker_contract::Source::Themes) {
				picker_contract::no_matches(session);
			}
			for _ in 0..3 {
				session.frame().unwrap();
				session.keystroke("escape").unwrap();
				if session
					.update(|view, _, _| view.state().overlay.is_none())
					.unwrap()
				{
					break;
				}
			}
			session.frame().unwrap();
			session
				.update(|view, window, cx| {
					assert!(view.state().overlay.is_none(), "{source:?}: bounded Escape ascent");
					assert_eq!(view.composer_text(), "retained draft", "{source:?}");
					assert!(
						view.state().appearance.previewed().is_none(),
						"{source:?}: preview reverted"
					);
					assert!(
						view
							.ensure_composer(cx)
							.read(cx)
							.focus_handle()
							.is_focused(window),
						"{source:?}: composer focus restored"
					);
				})
				.unwrap();
		});
	}
}

#[test]
fn every_registered_picker_confirms_the_same_action_by_pointer_and_enter() {
	for source in picker_contract::sources() {
		let mut outcomes = Vec::new();
		for pointer in [false, true] {
			render_session(fixture::populated(), |session| {
				session
					.update(|view, window, cx| {
						view.set_composed("retained draft", cx);
						picker_contract::open(source, view, window, cx);
					})
					.unwrap();
				session.frame().unwrap();
				session.keystroke("end").unwrap();
				let (title, expected) = session
					.update(|view, _, cx| picker_contract::confirmation(view, cx))
					.unwrap();
				let frame = session.frame().unwrap();
				if pointer {
					let run = frame
						.text_runs
						.iter()
						.find(|run| run.text.as_ref() == title)
						.expect("row label is rendered");
					session
						.click(veyyon_gpui::Point {
							x: run.bounds.origin.x + run.bounds.size.width / 2.0,
							y: run.bounds.origin.y + run.bounds.size.height / 2.0,
						})
						.unwrap();
				} else {
					session.keystroke("enter").unwrap();
				}
				outcomes.push(
					session
						.update(|view, _, _| {
							assert_eq!(view.composer_text(), "retained draft");
							let reported = view.drain_intents();
							picker_contract::confirmed(&expected, &reported, view);
							(reported, view.state().overlay.clone(), view.state().appearance.clone())
						})
						.unwrap(),
				);
			});
		}
		assert_eq!(outcomes[0], outcomes[1], "{source:?}: keyboard and pointer use one action path");
	}
}

#[test]
fn shared_picker_never_confirms_disabled_or_absent_rows() {
	use veyyon_desktop_kit::{Picker, PickerEvent, SelectionState};
	for mask in 0_u8..16 {
		let rows: Vec<bool> = (0..4).map(|index| mask & (1 << index) != 0).collect();
		for selected in 0..rows.len() {
			let picker = Picker::new(&rows, selected);
			let confirm = picker.key("enter", |enabled| *enabled).unwrap();
			assert_eq!(
				confirm,
				if rows[selected] {
					PickerEvent::Confirm(selected)
				} else {
					PickerEvent::Handled
				}
			);
			assert_eq!(picker.pointer(selected, true, |enabled| *enabled), confirm);
			assert_eq!(
				picker.selection(selected, |enabled| *enabled),
				if rows[selected] {
					SelectionState::Selected
				} else {
					SelectionState::None
				}
			);
			for key in ["up", "down", "pageup", "pagedown", "home", "end"] {
				match picker.key(key, |enabled| *enabled).unwrap() {
					PickerEvent::Select(index) => {
						assert!(rows[index], "{mask}: {key} selected disabled row");
					},
					PickerEvent::Handled => assert_eq!(mask, 0),
					other => panic!("{key}: unexpected {other:?}"),
				}
			}
		}
	}
	let empty: [bool; 0] = [];
	for key in ["up", "down", "pageup", "pagedown", "home", "end", "enter"] {
		assert_eq!(Picker::new(&empty, 0).key(key, |enabled| *enabled), Some(PickerEvent::Handled));
	}
	assert_eq!(Picker::new(&empty, 0).key("escape", |enabled| *enabled), Some(PickerEvent::Dismiss));
	assert_eq!(Picker::new(&empty, 0).key("left", |enabled| *enabled), None);
}

#[test]
fn persisted_session_matching_is_not_repeated_against_the_title() {
	let mut state = PaletteState::history("text found only in transcript".into());
	state.set_host_items(vec![PaletteItem::command(
		1,
		"Different title",
		Intent::PreviewSession("history/session.jsonl".into()),
		None,
	)]);
	assert_eq!(state.filtered_items().len(), 1);
	assert_eq!(state.query_intent("next".into()), Intent::FindSessions("next".into()));
	let mut queue = PaletteState::new(PaletteMode::Sessions);
	queue.set_items(state.items().to_vec());
	queue.set_query(state.query());
	assert!(queue.filtered_items().is_empty());
	assert_eq!(queue.query_intent("next".into()), Intent::PaletteQuery("next".into()));
}
