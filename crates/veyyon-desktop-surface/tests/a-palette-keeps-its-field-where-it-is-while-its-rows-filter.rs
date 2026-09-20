//! WHY: the palette was centred on its own height, and its height is the rows
//! it holds. Every keystroke narrowed the list, the card shrank, and the field
//! being typed into slid up the window under the pointer and the eye. The box
//! the palette may fill is centred now, and the card is drawn at the top of
//! it, so the field is in one place for the whole of a search.
//!
//! THE CLASS THIS CLOSES: an overlay whose content moves the control the
//! operator is using. The sweep is every palette mode, enumerated from the
//! enum at run time, each rendered at a full list and at a single row, with
//! the y the frame drew the mode's own heading at read back off the frame. A
//! mode added to the enum arrives here with no edit, and a placement that
//! centres on content fails by the mode and the row counts that moved it.
//!
//! WHAT IT DOES NOT CATCH: horizontal movement, which no mode changes, and the
//! anchored popover the composer's model control opens, which is placed
//! against that control rather than over the window.

use std::path::Path;

use strum::IntoEnumIterator;
use veyyon_desktop_kit::{load_bundled_theme, load_bundled_tokens};
use veyyon_desktop_scene::{
	headless::{Captured, RenderOptions, headless_context},
	session::HeadlessSession,
};
use veyyon_desktop_surface::{
	Intent, Overlay, PaletteItem, PaletteMode, PaletteState, ShellView, fixture, install_tokens,
};
use veyyon_gpui::{App, AppContext};

const WIDTH: u32 = 1440;
const HEIGHT: u32 = 900;

/// A list of `count` rows, which is all this suite needs of them: the palette
/// is being measured by how tall it is, not by what it lists.
fn rows(count: usize) -> Vec<PaletteItem> {
	(0..count)
		.map(|i| PaletteItem::command(i as u64, format!("Row {i:02}"), Intent::PaletteRun, None))
		.collect()
}

fn palette(mode: PaletteMode, count: usize) -> Overlay {
	let mut state = PaletteState::new(mode);
	state.set_items(rows(count));
	Overlay::Palette(state)
}

fn render(overlay: Overlay) -> Captured {
	let mut cx = headless_context().expect("a headless renderer is required");
	let tokens = load_bundled_tokens().expect("the bundled tokens load");
	let theme = load_bundled_theme("dark").expect("the bundled dark theme loads");
	let options =
		RenderOptions { width: WIDTH, height: HEIGHT, scale_factor: 1.0, ..RenderOptions::default() };

	let mut session = HeadlessSession::open(&mut cx, &options, move |_window, app: &mut App| {
		let installed = install_tokens(app, &tokens, &theme, Path::new("surface"))
			.expect("the bundled tokens and theme install");
		app.new(|_| {
			let mut state = fixture::populated();
			state.overlay = Some(overlay);
			ShellView::new(installed, state)
		})
	})
	.expect("the shell opens offscreen");
	// The overlay is retained on the frame that opens it and drawn from the
	// next one, so the frame this suite measures is the second.
	let _ = session.frame().expect("the shell renders");
	session
		.frame()
		.expect("the shell renders with the palette open")
}

/// The y the frame drew the palette's input field at, read off the prompt the
/// mode sets in it.
fn field_top(captured: &Captured, label: &str) -> f32 {
	let tops: Vec<f32> = captured
		.text_runs
		.iter()
		.filter(|run| run.text.as_ref().trim() == label)
		.map(|run| f32::from(run.bounds.origin.y))
		.collect();
	assert_eq!(tops.len(), 1, "the frame draws the prompt `{label}` once, drew {}", tops.len());
	tops[0]
}

#[test]
fn a_palette_narrowed_to_one_row_keeps_its_field_where_it_drew_it() {
	let mut anchors = Vec::new();

	for mode in PaletteMode::iter() {
		let prompt = mode.placeholder();
		let full = field_top(&render(palette(mode, 12)), prompt);
		let narrowed = field_top(&render(palette(mode, 1)), prompt);

		assert!(
			(full - narrowed).abs() < 0.5,
			"{} drew its field at {full} with twelve rows and at {narrowed} with one, so the field \
			 moves as the list filters",
			mode.label()
		);
		anchors.push((mode.label(), full));
	}

	// One palette, one place. A mode that anchors somewhere of its own moves
	// the field as the operator descends into it, which is the same defect a
	// keystroke away.
	let (first_label, first) = anchors[0];
	for (label, top) in &anchors[1..] {
		assert!(
			(first - top).abs() < 0.5,
			"{label} opens at {top} and {first_label} at {first}, so descending from one mode to the \
			 other moves the field"
		);
	}
}
