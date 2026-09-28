//! The command palette lists every window action, host command, thread,
//! matched file and settings page, ranks them against the query, and runs the
//! row picked with the keys or the pointer.
//!
//! WHY: the palette is the one surface that reaches every action the window
//! registers. An action registered without a row, or a terminal spelling
//! (`exit`, `/logout`, `/mcp test`) no row answers to, is a command the
//! operator cannot find. A row that runs the wrong thing (another thread than
//! the one it reads, a command line without its argument, a page other than
//! the one named) is worse than no row. The palette re-lists on store events;
//! one notified per streamed delta costs a render per token. The suite drives
//! the real `CommandPalette` and `SettingsView` inside the real `Workspace`
//! over an `AppState` fed host events, and reads the drawn text and the
//! driver targets back.
//!
//! Gap: the card's opacity is not read, only where it is laid out and when it
//! leaves; the platform folder prompt of "New thread in folder…" is not
//! answered here.

mod arguments;
mod commands;
mod harness;
mod modes;
mod motion;

use std::collections::HashSet;

use gpui::{Pixels, TestAppContext, px};
use veyyon_desktop_app::{
	actions::{self, workspace as act},
	keymap,
	palette::{Group, Hint},
	settings::Page,
};
use veyyon_desktop_model::{Capability, CapabilityStatus, HostAction, HostEvent, SnapshotSection};
use veyyon_desktop_ui::theme::size as measure;

use self::harness::{WINDOW, delta, seeded, sid, window};

fn near(a: Pixels, b: Pixels) -> bool {
	(f32::from(a) - f32::from(b)).abs() < 0.5
}

#[gpui::test]
fn the_palette_opens_centred_a_fifth_of_the_way_down_and_asks_the_host_for_its_commands(
	app: &mut TestAppContext,
) {
	let mut w = window(app, seeded(), true);
	assert_eq!(w.bounds("palette"), None, "a closed palette draws no card");
	w.open();
	assert!(w.is_open() && w.layout().palette_open);
	assert_eq!(w.sent(), vec![HostAction::ListCommands], "the host has sent no commands yet");

	let card = w.bounds("palette").expect("the card is laid out");
	assert_eq!(card.size.width, measure::PALETTE);
	assert!(near(card.origin.y, px(WINDOW.1 * 0.18)), "the card's top is at {:?}", card.origin.y);
	let centred = (px(WINDOW.0) - measure::PALETTE) / 2.0;
	assert!(near(card.origin.x, centred), "the card's left is at {:?}", card.origin.x);
	let row = w
		.bounds("palette.row:0")
		.expect("the first row is laid out");
	assert_eq!(row.size.height, measure::MENU_ROW);

	let texts = w.texts();
	for drawn in ["Commands", "Threads", "Settings", "title b", "title c", "MCP servers"] {
		assert!(texts.iter().any(|text| text == drawn), "{drawn:?} is drawn in {texts:?}");
	}
}

#[gpui::test]
fn every_action_the_window_registers_has_a_row_its_name_reaches_with_its_shortcut(
	app: &mut TestAppContext,
) {
	let mut w = window(app, Vec::new(), true);
	w.open();
	let everywhere: HashSet<&str> = keymap::table()
		.iter()
		.filter(|binding| binding.context.is_none())
		.map(|binding| binding.name)
		.collect();
	let bound: HashSet<&str> = keymap::table().iter().map(|binding| binding.name).collect();
	let mut unreachable = Vec::new();
	for entry in actions::registry() {
		w.query(&entry.name.to_lowercase());
		let rows = w.rows();
		let Some(item) = rows
			.iter()
			.find(|item| item.group == Group::Commands && item.label == entry.label)
		else {
			unreachable.push(entry.name);
			continue;
		};
		let shortcut = matches!(item.hint, Hint::Shortcut(_));
		if everywhere.contains(entry.name) {
			assert!(shortcut, "the {} row shows its binding", entry.name);
		} else if !bound.contains(entry.name) {
			assert!(!shortcut, "the {} row shows no binding", entry.name);
		}
	}
	assert_eq!(unreachable, Vec::<&str>::new(), "actions no row reaches");
}

#[gpui::test]
fn the_terminal_spellings_reach_the_rows_that_do_what_they_did(app: &mut TestAppContext) {
	let mut w = window(app, seeded(), true);
	w.open();
	let spellings = [
		("exit", "Quit"),
		("quit", "Quit"),
		("/logout", "Sign out of an account…"),
		("/settings", "General"),
		("/statusline", "Status line"),
		("/hotkeys", "Keybindings"),
		("/setup", "Providers"),
		("/providers", "Providers"),
		("/login", "Providers"),
		("/mcp test", "MCP servers"),
		("/mcp unauth", "MCP servers"),
		("/mcp notifications", "MCP servers"),
		("smithery", "Search MCP registry"),
		("/mcp smithery", "Search MCP registry"),
		("/extensions", "Extensions"),
		("/status", "Extensions"),
		("skills", "Extensions"),
		("/new", "New thread"),
		("/terminal", "Toggle terminal drawer"),
		("/abort", "Stop the turn"),
		("/background", "Move the running command to the background"),
		("/history", "Search threads"),
		("/resume", "Search threads"),
		("/prompts", "Search prompt history"),
		("/files", "Show files"),
		("/search", "Show files"),
		("/agents", "Show agents"),
		("/hub", "Show agents"),
		("/settings diagnostics", "Show diagnostics"),
		("/lsp", "Show diagnostics"),
		("/usage", "Show usage"),
		("/context", "Show usage"),
		("/model", "Choose model"),
		("/switch", "Choose model"),
		("/effort", "Choose thinking level"),
		("/queue-mode", "Toggle steer or queue"),
		("/queue", "Toggle steer or queue"),
		("/attach", "Attach files"),
		("/plan", "Plan mode"),
		("/vibe", "Vibe mode"),
		("/loop", "Loop mode"),
		("/plan off", "Leave mode"),
		("/vibe off", "Leave mode"),
		("/loop off", "Leave mode"),
		("/plan-review", "Review plan"),
		("/drop", "Delete selected thread"),
		("/profile", "Switch profile"),
		("/profiles", "Switch profile"),
	];
	for (typed, label) in spellings {
		w.query(typed);
		let labels = w.labels();
		assert!(labels.iter().any(|drawn| drawn == label), "{typed:?} reaches {label:?}: {labels:?}");
	}
}

#[gpui::test]
fn each_settings_row_opens_its_page_and_asks_the_host_for_what_the_page_draws(
	app: &mut TestAppContext,
) {
	let mut w = window(app, seeded(), true);
	for page in Page::ALL {
		w.open();
		w.sent();
		w.query(&page.label().to_lowercase());
		w.pick(page.label());
		assert!(!w.is_open(), "choosing {page:?} closes the palette");
		let layout = w.layout();
		assert!(layout.settings_open && !layout.palette_open);
		assert_eq!(layout.settings_page.as_deref(), Some(page.name()));
		assert_eq!(w.settings.read_with(&*w.cx, |settings, _| settings.page()), page);
		assert_eq!(w.sent(), page.loads(), "{page:?} asks for what it draws");
		assert!(
			w.bounds(&format!("settings.page:{}", page.name()))
				.is_some()
		);
	}

	w.open();
	w.query("/logout");
	w.pick("Sign out of an account…");
	assert_eq!(w.settings.read_with(&*w.cx, |settings, _| settings.page()), Page::Providers);
	assert_eq!(w.layout().settings_page.as_deref(), Some("providers#accounts"));
	assert!(w.texts().iter().any(|text| text == "Stored accounts"));
}

#[gpui::test]
fn enter_opens_the_highlighted_thread_and_the_arrows_move_the_highlight_around(
	app: &mut TestAppContext,
) {
	let mut w = window(app, seeded(), true);
	w.open();
	w.sent();
	w.typed("title");
	assert_eq!(w.labels(), vec!["title b", "title a", "title c"], "newest first");
	assert_eq!(w.selected(), 0);
	w.keys("up");
	assert_eq!(w.selected(), 2, "up from the first row wraps to the last");
	w.keys("down");
	w.keys("down");
	assert_eq!(w.selected(), 1);
	w.keys("enter");
	assert_eq!(w.sent(), vec![HostAction::OpenSession { session: sid("a") }]);
	assert!(!w.is_open() && !w.layout().palette_open, "a row that runs closes the palette");
	assert_eq!(w.bounds("palette"), None, "the closed card is forgotten");
	assert_eq!(w.bounds("palette.row:0"), None, "its rows are forgotten");
}

#[gpui::test]
fn a_click_runs_the_row_under_the_pointer_and_a_click_outside_closes_the_palette(
	app: &mut TestAppContext,
) {
	let mut w = window(app, seeded(), true);
	w.open();
	w.sent();
	w.typed("title");
	w.click("palette.row:2");
	assert_eq!(w.sent(), vec![HostAction::OpenSession { session: sid("c") }]);
	assert!(!w.is_open());

	w.open();
	w.sent();
	let card = w.bounds("palette").expect("the card is laid out");
	w.click_at(gpui::point(card.origin.x / 2.0, card.origin.y / 2.0));
	assert!(!w.is_open() && !w.layout().palette_open, "a click outside the card closes it");
	assert_eq!(w.sent(), Vec::<HostAction>::new(), "and runs nothing");
}

#[gpui::test]
fn a_row_the_host_refuses_is_drawn_with_its_reason_and_runs_nothing(app: &mut TestAppContext) {
	let mut events = seeded();
	events.push(HostEvent::Snapshot(SnapshotSection::Capabilities(vec![(
		Capability::Sessions,
		CapabilityStatus::Unavailable { reason: "The host lists no sessions".to_owned() },
	)])));
	let mut w = window(app, events, true);
	w.open();
	w.sent();
	w.typed("title b");
	let rows = w.rows();
	let row = rows
		.iter()
		.find(|item| item.label.as_ref() == "title b")
		.expect("the thread is listed");
	assert_eq!(row.blocked.as_deref(), Some("The host lists no sessions"));
	assert_eq!(w.selected(), w.row_of("title b"));
	w.keys("enter");
	assert_eq!(w.sent(), Vec::<HostAction>::new());
	assert!(w.is_open(), "a refused row leaves the palette open");
}

#[gpui::test]
fn a_streamed_turn_renders_neither_the_palette_nor_settings_per_delta(app: &mut TestAppContext) {
	let mut w = window(app, seeded(), true);
	w.dispatch(act::OpenSettings { page: Some("general".into()) });
	w.open();
	w.apply(vec![delta(2)]);
	let started = w.renders();
	for revision in 3..40 {
		w.apply(vec![delta(revision)]);
	}
	assert_eq!(w.renders(), started, "no render per delta");
}
