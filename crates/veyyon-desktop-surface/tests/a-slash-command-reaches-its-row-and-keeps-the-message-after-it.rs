//! WHY: the composer's draft IS the palette's query while a slash menu is
//! open, and the two halves of that arrangement disagreed about case. The
//! ranker folds case, so `/Steer` scores against `/steer`; the query
//! derivation matched the message-carrying spellings with `matches!(first,
//! "steer" | "queue")` and the prefix consumer stripped with
//! `strip_prefix`, both case-sensitive. `/Steer fix the tests` therefore
//! scored the whole message against a six-character row, listed nothing, and
//! Enter did nothing at all; had it reached the consumer, the fallback drops
//! the draft's whole first line, which is the message.
//!
//! CLASS CLOSED: every slash spelling the command table authors — the eight
//! command rows, the settings-page rows, each `SurfaceRoute` alias and each
//! `ComposerCommand` name — selects its own row typed in any case, and a
//! command that declares `carries_draft` keeps the message written after it
//! and sends exactly that message. The variant space is read off
//! `command_items()`, `SettingsPage::iter()` and `ComposerCommand::iter()` at
//! run time, and `carries_draft` is an exhaustive match, so a new command,
//! page or alias fails here or fails to compile until it decides.
//!
//! GAPS: an abbreviated or fuzzy spelling (`/acct mgr`) cannot say where the
//! command ends, so it still drops the first line; that is the design, not a
//! defect this suite defends. The host's execution of `Steer`/`Queue` and the
//! capability pruning of a row belong to their own suites, and the file
//! dialog `/attach` opens is not driven here.

use std::{cell::RefCell, path::Path, rc::Rc};

use strum::IntoEnumIterator;
use veyyon_desktop_kit::{load_bundled_theme, load_bundled_tokens};
use veyyon_desktop_model::QueueMode;
use veyyon_desktop_scene::{
	HeadlessSession,
	headless::{RenderOptions, headless_context},
};
use veyyon_desktop_surface::{
	Intent, Keymap, Overlay, PaletteState, ShellState, ShellView,
	composer::TurnPhase,
	fixture, install_tokens,
	navigation::SurfaceRoute,
	palette::{
		PaletteItemKind,
		commands::{ComposerCommand, command_items},
	},
	settings::SettingsPage,
};
use veyyon_gpui::{App, AppContext, Entity, Window};

const MESSAGE: &str = "check the failing tests too";

/// The spellings of one command as an operator may type it: as authored, in
/// capitals, and with alternating case.
fn cases(spelling: &str) -> Vec<String> {
	let mut alternating = String::with_capacity(spelling.len());
	let mut upper = true;
	for character in spelling.chars() {
		if character.is_ascii_alphabetic() {
			alternating.push(if upper {
				character.to_ascii_uppercase()
			} else {
				character.to_ascii_lowercase()
			});
			upper = !upper;
		} else {
			alternating.push(character);
		}
	}
	vec![spelling.to_owned(), spelling.to_ascii_uppercase(), alternating]
}

fn shell(
	state: ShellState,
	drained: Rc<RefCell<Vec<Intent>>>,
) -> impl FnOnce(&mut Window, &mut App) -> Entity<ShellView> {
	move |_window, app| {
		let tokens = load_bundled_tokens().expect("tokens load");
		let theme = load_bundled_theme("dark").expect("theme loads");
		let installed = install_tokens(app, &tokens, &theme, Path::new("surface"))
			.expect("tokens and theme install");
		app.bind_keys(Keymap::default().bindings());
		veyyon_desktop_kit::input::ensure_editor_bindings_registered(app);
		let view = app.new(|_| ShellView::new(installed, state));
		app.observe(&view, move |view, app| {
			let intents = view.update(app, |view, _| view.drain_intents());
			drained.borrow_mut().extend(intents);
		})
		.detach();
		view
	}
}

fn options() -> RenderOptions {
	RenderOptions { width: 1180, height: 800, scale_factor: 1.0, ..RenderOptions::default() }
}

/// The title of the row the palette would run for `typed`, or `None` when the
/// draft opened no palette or ranked no row.
///
/// The draft is written through the composer, so the palette is opened by the
/// editor's own change event: the same path a keystroke takes. The event is
/// delivered when the update it was emitted in ends, so the read is its own
/// update.
fn selected_for(session: &mut HeadlessSession<'_, ShellView>, typed: &str) -> Option<String> {
	session
		.update(|view, _, cx| view.set_composed("", cx))
		.expect("draft clears");
	session
		.update(|view, _, cx| view.set_composed(typed, cx))
		.expect("draft reaches the composer");
	session
		.update(|view, _, _| {
			view
				.state()
				.overlay
				.as_ref()
				.and_then(Overlay::as_palette)
				.and_then(PaletteState::selected_item)
				.map(|item| item.title.clone())
		})
		.expect("the palette answers what it would run")
}

/// How many rows the palette the draft opened would draw.
fn rows_for(session: &mut HeadlessSession<'_, ShellView>, typed: &str) -> usize {
	session
		.update(|view, _, cx| view.set_composed("", cx))
		.expect("draft clears");
	session
		.update(|view, _, cx| view.set_composed(typed, cx))
		.expect("draft reaches the composer");
	session
		.update(|view, _, _| {
			view
				.state()
				.overlay
				.as_ref()
				.and_then(Overlay::as_palette)
				.map_or(0, |palette| palette.filtered_items().len())
		})
		.expect("the palette answers what it would draw")
}

/// Every slash spelling the command table authors, paired with the row title
/// it must select. An alias is its own spelling and selects the row of the
/// route that answers to it.
fn spellings() -> Vec<(String, String)> {
	let items = command_items();
	let mut pairs: Vec<(String, String)> = items
		.iter()
		.filter(|item| item.title.starts_with('/'))
		.map(|item| (item.title.clone(), item.title.clone()))
		.collect();
	assert!(
		pairs.len() >= items.len() - 1,
		"the command table is slash-spelled: {} of {} rows are not",
		items.len() - pairs.len(),
		items.len()
	);
	// A page reachable by an alias states which row that alias selects. The
	// General page has no row of its own, since `/settings` opens it, and no
	// alias either.
	for page in SettingsPage::iter() {
		let route = SurfaceRoute::Page(page);
		if route.aliases().is_empty() {
			continue;
		}
		let title = items
			.iter()
			.find(|item| match &item.kind {
				PaletteItemKind::Command { intent } => **intent == Intent::Navigate(route),
				_ => false,
			})
			.map_or_else(
				|| panic!("{page:?} is reachable by an alias and has no row"),
				|item| item.title.clone(),
			);
		for alias in route.aliases() {
			pairs.push(((*alias).to_owned(), title.clone()));
		}
	}
	pairs
}

#[test]
fn every_command_spelling_selects_its_own_row_however_it_is_typed() {
	let mut cx = headless_context().expect("headless context available");
	let drained = Rc::new(RefCell::new(Vec::new()));
	let mut session =
		HeadlessSession::open(&mut cx, &options(), shell(fixture::populated(), Rc::clone(&drained)))
			.expect("session opens");

	for (spelling, expected) in spellings() {
		for typed in cases(&spelling) {
			let selected = selected_for(&mut session, &typed);
			assert_eq!(
				selected.as_deref(),
				Some(expected.as_str()),
				"typing {typed:?} must select {expected:?}"
			);
		}
	}
}

#[test]
fn the_whole_command_list_opens_however_commands_is_typed() {
	let mut cx = headless_context().expect("headless context available");
	let drained = Rc::new(RefCell::new(Vec::new()));
	let mut session =
		HeadlessSession::open(&mut cx, &options(), shell(fixture::populated(), Rc::clone(&drained)))
			.expect("session opens");

	// `/commands` is the one spelling that stands for no row: it blanks the
	// query, so the list is every row the route offers.
	let whole = PaletteState::commands().filtered_items().len();
	assert!(whole > 1, "the command route offers rows");
	for typed in cases("/commands") {
		assert_eq!(rows_for(&mut session, &typed), whole, "typing {typed:?} must list every row");
	}
}

#[test]
fn a_command_that_carries_a_message_keeps_it_however_the_command_is_typed() {
	let mut cx = headless_context().expect("headless context available");
	let drained = Rc::new(RefCell::new(Vec::new()));
	let mut state = fixture::populated();
	state.turn = TurnPhase::Running { queue_mode: QueueMode::Steer };
	let mut session =
		HeadlessSession::open(&mut cx, &options(), shell(state, Rc::clone(&drained))).expect("opens");

	let carriers: Vec<ComposerCommand> = ComposerCommand::iter()
		.filter(|command| command.carries_draft())
		.collect();
	assert!(!carriers.is_empty(), "a command carries the draft written after it");

	for command in carriers {
		let expected = match command {
			ComposerCommand::Steer => Intent::Steer(MESSAGE.to_owned()),
			ComposerCommand::Queue => Intent::Queue(MESSAGE.to_owned()),
			other => panic!("{other:?} declares it carries a message and sends no message"),
		};
		for typed in cases(command.name()) {
			let draft = format!("{typed} {MESSAGE}");
			assert_eq!(
				selected_for(&mut session, &draft).as_deref(),
				Some(command.name()),
				"{draft:?} must select the row it names"
			);
			drained.borrow_mut().clear();
			// The Enter the composer answers to, not the row's own method: the
			// defect was that this path reached no row at all.
			session
				.update(|view, _, cx| view.submit_primary_turn_action(cx))
				.expect("the draft submits");
			let sent: Vec<Intent> = drained
				.borrow()
				.iter()
				.filter(|intent| matches!(intent, Intent::Steer(_) | Intent::Queue(_)))
				.cloned()
				.collect();
			assert_eq!(sent, vec![expected.clone()], "{draft:?} must send the message after it");
			session
				.update(|view, _, _| assert_eq!(view.composer_text(), MESSAGE, "{draft:?}"))
				.expect("the message stays in the draft until the host acknowledges it");
		}
	}
}

#[test]
fn a_command_that_carries_no_message_is_not_ranked_on_its_first_word() {
	let mut cx = headless_context().expect("headless context available");
	let drained = Rc::new(RefCell::new(Vec::new()));
	let mut session =
		HeadlessSession::open(&mut cx, &options(), shell(fixture::populated(), Rc::clone(&drained)))
			.expect("session opens");

	for command in ComposerCommand::iter().filter(|command| !command.carries_draft()) {
		// A row that sends no message has nowhere to put the words after its
		// name, so it must not be selected by them: a first-word ranking
		// applied to every command would list this row and the consumer would
		// drop what was typed after it.
		let draft = format!("{} {MESSAGE}", command.name());
		let selected = selected_for(&mut session, &draft);
		assert_ne!(
			selected.as_deref(),
			Some(command.name()),
			"{draft:?} must not select a row that would discard the message"
		);
		// The name alone still reaches it, in any case.
		for typed in cases(command.name()) {
			assert_eq!(
				selected_for(&mut session, &typed).as_deref(),
				Some(command.name()),
				"typing {typed:?} must select {}",
				command.name()
			);
		}
	}
}
