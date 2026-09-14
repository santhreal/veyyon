//! WHY: a row menu drew no hover state at all, and drew a control's hit box
//! under every row including the ones a gate had refused. A menu is the one
//! surface where the pointer is the only thing that states which answer is
//! about to be taken -- eight words one row apart, no selection, no keyboard --
//! and the window showed nothing until the click had already landed. The
//! refused row stated the opposite of the truth: it took the box that paints
//! the pointing cursor and answered nothing.
//!
//! CLASS CLOSED: lighting and answering are one predicate, over every row of
//! every kind of row menu. The rows come from `row_menu_items` at run time
//! under two arms of `ControlStates` -- every answer enabled, then every answer
//! in flight -- so an offered row and a refused one are both swept without
//! either being named here, and a row added to any menu, or a gate that starts
//! or stops holding one back, is swept the moment it exists. Each row is
//! hovered in a fresh window and the pixels of its own word are compared with
//! the frame at rest: a row that answers repaints, a row that refuses does not,
//! and only a row that answers carries a row-sized hit box over its word.
//!
//! GAPS: it reads that a row repainted, not which colour it repainted in -- a
//! row lit in the wrong fill passes here, and the kit's contrast suite is what
//! reads the ink. It sweeps the queue's row menus, which are the menus a
//! `ControlStates` arm can refuse a row in; the turn menu and the
//! process-signal menu draw through the same `Menu` primitive and are not
//! rendered again here. The cursor shape itself is asserted through the hit box
//! that paints it, since a headless frame records no cursor -- and a hit box
//! does not separate a row that lights from a row that answers, because a
//! hover style registers one of its own, so the answer a press gives stays
//! with `a-menu-row-the-window-draws-answers-the-click-it-names`.

use std::path::Path;

use veyyon_desktop_kit::{load_bundled_theme, load_bundled_tokens};
use veyyon_desktop_scene::{
	frame::RgbaFrame,
	headless::{Captured, RenderOptions, headless_context},
	session::HeadlessSession,
};
use veyyon_desktop_surface::{
	Availability, ControlStates, Keymap, ShellState, ShellView, fixture, install_tokens,
	queue::{RowMenu, RowMenuKind, card_row_answers, row_menu_items},
};
use veyyon_gpui::{App, AppContext, Bounds, Pixels, Point, px};

const WIDTH: u32 = 1440;
const HEIGHT: u32 = 900;

/// The row the menus in this suite open on.
const ROW: u64 = 1;

/// The tallest a hit box may be and still be one menu row. A row is 29px at
/// this scale; the boxes above the ceiling are the menu card itself and the
/// queue cards the menu floats over, which answer a different press.
const ROW_CEILING_PX: f32 = 40.0;

/// How many pixels of a row's own word have to change for the row to have lit.
/// A hover fill covers the whole row, so the ground between the glyphs
/// repaints; a floor this low still separates it from the nothing a refused row
/// does.
const LIT_MIN_PIXELS: usize = 20;

/// Every kind of row menu the queue opens, at the origin a right-click on a row
/// would put it at.
///
/// The kinds are listed from the enum rather than by the answers they carry, so
/// a new kind is swept by name the moment it exists.
fn every_menu() -> Vec<RowMenu> {
	[RowMenuKind::Card, RowMenuKind::Pinned, RowMenuKind::Parked, RowMenuKind::Deferred]
		.into_iter()
		.map(|kind| RowMenu { id: ROW, origin: Point { x: px(120.0), y: px(300.0) }, kind })
		.collect()
}

/// The two arms every row is swept under: every answer the menus reach offered,
/// then every one of them in flight. The second arm is what puts a refused row
/// in the sweep without naming which row a gate holds back.
fn arms() -> Vec<(&'static str, ControlStates)> {
	[
		("every answer offered", Availability::Enabled),
		("every answer in flight", Availability::Pending),
	]
	.into_iter()
	.map(|(label, availability)| {
		let mut controls = ControlStates::new();
		for answer in card_row_answers(ROW) {
			controls.set_availability(answer.surface, availability.clone());
		}
		(label, controls)
	})
	.collect()
}

fn seeded_state(controls: ControlStates) -> ShellState {
	let mut state = fixture::populated();
	state.keymap.panel_collapsed = true;
	state.controls = controls;
	state
}

fn render_session<R>(
	menu: RowMenu,
	controls: ControlStates,
	test: impl FnOnce(&mut HeadlessSession<ShellView>) -> R,
) -> R {
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
			let mut view = ShellView::new(installed, seeded_state(controls));
			view.open_row_menu(menu);
			view
		})
	})
	.expect("session opens");

	test(&mut session)
}

/// The box the frame drew `label` in.
///
/// A label the frame drew more than once is refused rather than guessed at: the
/// pointer has to land on the row that names the answer, and this suite would
/// otherwise read some other copy of the word.
fn drawn_label(captured: &Captured, label: &str) -> Bounds<Pixels> {
	let runs: Vec<Bounds<Pixels>> = captured
		.text_runs
		.iter()
		.filter(|run| run.text.as_ref().trim() == label)
		.map(|run| run.bounds)
		.collect();
	assert_eq!(runs.len(), 1, "the frame draws `{label}` exactly once, drew {}", runs.len());
	runs[0]
}

fn centre(bounds: Bounds<Pixels>) -> Point<Pixels> {
	Point {
		x: bounds.origin.x + bounds.size.width / 2.0,
		y: bounds.origin.y + bounds.size.height / 2.0,
	}
}

/// Whether one row of `menu` carries a hit box over the whole of `word`, which
/// is what makes the drawn word a control rather than a caption: the pointing
/// cursor and the hover fill are both painted from it.
///
/// The box has to start inside the menu and be no taller than one row, so the
/// queue card the menu floats over and the menu card itself are not mistaken
/// for the row.
fn row_answers_a_press(captured: &Captured, menu: RowMenu, word: Bounds<Pixels>) -> bool {
	captured.hitboxes.iter().any(|rect| {
		f32::from(rect.size.height) <= ROW_CEILING_PX
			&& rect.origin.x >= menu.origin.x
			&& rect.origin.y >= menu.origin.y
			&& rect.origin.x <= word.origin.x
			&& rect.origin.y <= word.origin.y
			&& rect.origin.x + rect.size.width >= word.origin.x + word.size.width
			&& rect.origin.y + rect.size.height >= word.origin.y + word.size.height
	})
}

/// How many pixels inside `area` the two frames disagree on.
fn changed_pixels(rest: &RgbaFrame, lit: &RgbaFrame, area: Bounds<Pixels>) -> usize {
	let scale = rest.scale_factor();
	let device = |value: Pixels| (f32::from(value) * scale).round().max(0.0) as u32;
	let left = device(area.origin.x);
	let top = device(area.origin.y);
	let right = device(area.origin.x + area.size.width);
	let bottom = device(area.origin.y + area.size.height);
	assert!(right > left && bottom > top, "the word's box is {area:?}, which holds no pixels");

	let mut changed = 0;
	for y in top..bottom {
		for x in left..right {
			if rest.pixel(x, y) != lit.pixel(x, y) {
				changed += 1;
			}
		}
	}
	changed
}

#[test]
fn a_row_lights_under_the_pointer_only_where_a_press_answers() {
	for (arm, controls) in arms() {
		for menu in every_menu() {
			let kind = format!("{:?}", menu.kind);
			let rows: Vec<(String, bool)> = row_menu_items(&menu, &controls)
				.into_iter()
				.map(|(item, _)| (item.label.to_string(), item.is_disabled))
				.collect();
			assert!(!rows.is_empty(), "{kind} draws rows under {arm}");

			for (label, refused) in rows {
				let (changed, answers) = render_session(menu, controls.clone(), |session| {
					let rest = session.frame().expect("frame renders");
					let word = drawn_label(&rest, &label);
					session
						.hover(centre(word))
						.expect("the pointer reaches the row");
					let lit = session.frame().expect("frame renders under the pointer");
					(
						changed_pixels(&rest.frame, &lit.frame, word),
						row_answers_a_press(&lit, menu, word),
					)
				});

				if refused {
					assert_eq!(
						changed, 0,
						"{kind} under {arm}: `{label}` is refused and repainted {changed}px under the \
						 pointer, so the window states an answer it will not take"
					);
					assert!(
						!answers,
						"{kind} under {arm}: `{label}` is refused and carries a row-sized hit box, \
						 which is what paints the pointing cursor over a row that answers nothing"
					);
				} else {
					assert!(
						changed >= LIT_MIN_PIXELS,
						"{kind} under {arm}: `{label}` answers a press and repainted {changed}px under \
						 the pointer, under the {LIT_MIN_PIXELS} a lit row draws, so nothing states \
						 which answer the click is about to take"
					);
					assert!(
						answers,
						"{kind} under {arm}: `{label}` answers a press and carries no row-sized hit \
						 box, so the pointer never reaches it"
					);
				}
			}
		}
	}
}
