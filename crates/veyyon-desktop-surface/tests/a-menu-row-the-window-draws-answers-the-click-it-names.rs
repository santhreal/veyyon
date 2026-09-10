//! WHY: the run bar drew the word `Stop` beside a running turn as plain text --
//! no id, no hitbox, no click handler -- so the one thing on the surface that
//! named the stop answered nothing. The model was right and the drawing was
//! wrong, which is a gap every assertion about a label's disabled flag or its
//! gate walks straight past: `row_menu_items` returning the right rows proves
//! nothing about whether the rows the window drew from them can be pressed.
//!
//! CLASS CLOSED: every row a queue row menu draws is a control that gives the
//! answer its word states. For each `RowMenuKind`, the labels come from
//! `row_menu_items` at run time, each label is located by the text the frame
//! recorded drawing, and each is required to sit inside a registered hitbox of
//! its own -- not the dismissing scrim -- and to raise its own paired intent
//! when the centre of that text is pressed, one fresh session per press. The
//! third test pins the vocabulary itself by exact equality, since a sweep that
//! reads both the word and the intent from one table agrees with that table
//! even when the table is wrong: a row whose intent is swapped for its
//! neighbour's, and a row added to any menu, both turn this red.
//!
//! GAPS: it sweeps the row menus, not every word the window draws. The
//! composer's own stop control, its chord and the run bar's `Stop` are swept
//! over every `TurnPhase` by
//! `a-turn-parked-on-a-decision-can-still-be-stopped`; the gate that decides
//! whether a row is selectable, and where its failure lands, stay with
//! `every-control-resolves-through-the-gate-and-a-failure-lands-on-its-control`.
//! A disabled row is excluded from the two press tests rather than asserted
//! inert, since a gate holding a row back is that suite's subject.

use std::path::Path;

use veyyon_desktop_kit::{load_bundled_theme, load_bundled_tokens};
use veyyon_desktop_scene::{
	headless::{Captured, RenderOptions, headless_context},
	session::HeadlessSession,
};
use veyyon_desktop_surface::{
	Availability, ControlStates, Intent, Keymap, ShellState, ShellView, fixture, install_tokens,
	queue::{RowMenu, RowMenuKind, card_row_answers, row_menu_items},
};
use veyyon_gpui::{App, AppContext, Point, px};

const WIDTH: u32 = 1440;
const HEIGHT: u32 = 900;

/// The tallest a box may be and still be a menu row rather than a layer over
/// the window: a quarter of the window, against a row of about 28 px.
const ROW_CEILING_PX: f32 = 225.0;

/// The row the menus in this suite open on.
const ROW: u64 = 1;

/// Every kind of row menu the queue opens, with the origin a right-click on a
/// row would put it at.
///
/// The kinds come from the enum rather than from a list written here, so a new
/// kind is swept by name the moment it exists.
fn every_menu() -> Vec<RowMenu> {
	[RowMenuKind::Card, RowMenuKind::Pinned, RowMenuKind::Parked, RowMenuKind::Deferred]
		.into_iter()
		.map(|kind| RowMenu { id: ROW, origin: Point { x: px(120.0), y: px(300.0) }, kind })
		.collect()
}

/// Every control the menus reach, enabled, so the sweep reads the drawing
/// rather than a gate holding a row back.
fn enabled_controls() -> ControlStates {
	let mut controls = ControlStates::new();
	for answer in card_row_answers(ROW) {
		controls.set_availability(answer.surface, Availability::Enabled);
	}
	controls
}

fn seeded_state() -> ShellState {
	let mut state = fixture::populated();
	state.keymap.panel_collapsed = true;
	state.controls = enabled_controls();
	state
}

fn render_session<R>(menu: RowMenu, test: impl FnOnce(&mut HeadlessSession<ShellView>) -> R) -> R {
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
		app.new(|_| {
			let mut view = ShellView::new(installed, seeded_state());
			view.open_row_menu(menu);
			view
		})
	})
	.expect("session opens");

	test(&mut session)
}

/// Where the frame drew `label`, as the centre of the one text run whose
/// content is exactly that word.
///
/// A label the frame drew more than once is refused rather than guessed at: the
/// press has to land on the row that names the answer, and this suite would
/// otherwise report a pass for a press on some other copy of the word.
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

/// Whether a hitbox of a row's own size covers `at`, which is what makes a
/// drawn word a control rather than a caption.
///
/// The dismissing scrim the menu floats over spans the window and answers a
/// press anywhere, so a box taller than a quarter of the window is not
/// counted: the scrim closes the menu instead of answering the row, and
/// counting it would report a pass for a word drawn outside every row.
fn hit(captured: &Captured, at: Point<f32>) -> bool {
	let row_ceiling = ROW_CEILING_PX;
	captured.hitboxes.iter().any(|rect| {
		let left = f32::from(rect.origin.x);
		let top = f32::from(rect.origin.y);
		let width = f32::from(rect.size.width);
		let height = f32::from(rect.size.height);
		height <= row_ceiling
			&& left <= at.x
			&& at.x <= left + width
			&& top <= at.y
			&& at.y <= top + height
	})
}

#[test]
fn every_row_a_menu_draws_is_inside_a_hitbox() {
	for menu in every_menu() {
		let label = format!("{:?}", menu.kind);
		let rows: Vec<String> = row_menu_items(&menu, &enabled_controls())
			.into_iter()
			.filter(|(item, _)| !item.is_disabled)
			.map(|(item, _)| item.label.to_string())
			.collect();
		assert!(!rows.is_empty(), "{label} offers rows to press");

		render_session(menu, |session| {
			let captured = session.frame().expect("frame renders");
			for row in &rows {
				let at = drawn_label(&captured, row);
				assert!(
					hit(&captured, at),
					"{label} draws `{row}` at {at:?} with no hitbox over it, so a press on the word it \
					 states does nothing"
				);
			}
		});
	}
}

#[test]
fn pressing_a_row_raises_the_intent_that_row_names() {
	for menu in every_menu() {
		let kind = format!("{:?}", menu.kind);
		let rows: Vec<(String, Intent)> = row_menu_items(&menu, &enabled_controls())
			.into_iter()
			.filter(|(item, _)| !item.is_disabled)
			.map(|(item, intent)| (item.label.to_string(), intent))
			.collect();

		for (row, wanted) in rows {
			let intents = render_session(menu, |session| {
				let captured = session.frame().expect("frame renders");
				let at = drawn_label(&captured, &row);
				session
					.click(Point { x: px(at.x), y: px(at.y) })
					.expect("press the row the menu drew");
				session
					.update(|view, _window, _cx| view.drain_intents())
					.expect("drain intents")
			});
			assert!(
				intents.contains(&wanted),
				"{kind} row `{row}` must raise {wanted:?}, raised {intents:?}"
			);
		}
	}
}

#[test]
fn each_menu_offers_the_answers_it_is_meant_to_and_no_others() {
	let vocabulary: Vec<(RowMenuKind, Vec<(String, String)>)> = every_menu()
		.into_iter()
		.map(|menu| {
			let rows = row_menu_items(&menu, &enabled_controls())
				.into_iter()
				.map(|(item, intent)| (item.label.to_string(), format!("{intent:?}")))
				.collect();
			(menu.kind, rows)
		})
		.collect();

	let card = vec![
		("Open".to_owned(), "SelectSession(1)".to_owned()),
		("Park".to_owned(), "ParkSession(1)".to_owned()),
		("Defer".to_owned(), "DeferSession(1)".to_owned()),
		("Branch".to_owned(), "BranchSession(1)".to_owned()),
		("Export".to_owned(), "ExportSession(Some(1))".to_owned()),
		("Compact".to_owned(), "CompactSession(Some(1))".to_owned()),
		("Handoff".to_owned(), "HandoffSession(Some(1))".to_owned()),
		("Delete".to_owned(), "DeleteSession(1)".to_owned()),
	];
	let mut pinned = card.clone();
	pinned.insert(1, ("Unpin".to_owned(), "UnpinSession(1)".to_owned()));

	assert_eq!(vocabulary, vec![
		(RowMenuKind::Card, card),
		(RowMenuKind::Pinned, pinned),
		(RowMenuKind::Parked, vec![
			("Open".to_owned(), "SelectSession(1)".to_owned()),
			("Unpark".to_owned(), "UnparkSession(1)".to_owned()),
		]),
		(RowMenuKind::Deferred, vec![
			("Open".to_owned(), "SelectSession(1)".to_owned()),
			("Recall".to_owned(), "RecallSession(1)".to_owned()),
		]),
	]);
}
