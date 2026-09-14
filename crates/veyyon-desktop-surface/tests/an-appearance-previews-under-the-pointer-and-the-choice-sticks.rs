//! WHY: §6.9 makes an appearance a thing the operator judges by looking at
//! it, which is three separate behaviours a preview can get wrong one at a
//! time: the pointer arriving has to restyle the whole window and not just
//! the row it is on, the pointer leaving has to put the chosen appearance
//! back with nothing left behind, and a click has to outlive the pointer. A
//! preview that wrote the choice looks identical to a selection the moment
//! the pointer moves, and a preview that never reverted would commit an
//! appearance to anyone who read the page.
//!
//! CLASS CLOSED, from captured frames of a live window rather than from the
//! state alone:
//! 1. Hovering a row that is not the drawn appearance changes the window, not a
//!    row: the frame differs over a large share of its pixels and its mean luma
//!    moves.
//! 2. The choice is untouched by a preview: `chosen()` is what it was, and the
//!    frame after the pointer leaves is byte-for-byte the frame before it
//!    arrived -- so a preview that leaked into the choice, the store or a stray
//!    repaint fails.
//! 3. A selection survives the pointer leaving: the window still draws the
//!    selected appearance with nothing hovered, and `chosen()` is the one that
//!    was clicked.
//! 4. Every bundled appearance previews, swept from `APPEARANCES`, so an
//!    appearance added to the build is measured the moment it exists.
//!
//! NOT CAUGHT: what the appearance looks like, which is the scene's; and
//! persistence across a restart, which is
//! `the-shape-a-window-was-left-in-comes-back-when-it-opens.rs` in the binary
//! crate, where the store is.

#[path = "support/appearance/mod.rs"]
#[allow(dead_code, reason = "this binary uses a subset of the shared appearance helpers")]
mod appearance;

use appearance::{
	centre_of_run, changed_pixels, driven, off_every_row, on_default, on_the_themes_page,
};
use veyyon_desktop_scene::frame::RgbaFrame;
use veyyon_desktop_tokens::{APPEARANCES, DEFAULT_APPEARANCE, load_bundled_theme};

/// The mean Rec. 709 luma of a frame, which is how a restyled window is told
/// from a restyled row: a ground swap moves it and a hover tint does not.
fn mean_luma(frame: &RgbaFrame) -> f32 {
	let mut total = 0.0;
	let mut counted = 0.0;
	for pixel in frame.pixels() {
		total += pixel.luma_255();
		counted += 1.0;
	}
	total / counted
}

/// The name the row of `appearance` draws, which is the theme's own `[meta]`
/// name rather than a label this test invents.
fn row_label(appearance: &str) -> String {
	load_bundled_theme(appearance)
		.expect("the bundled theme loads")
		.name
}

/// The appearances that are not the one the window opened in.
fn others(drawn: &str) -> Vec<&'static str> {
	APPEARANCES
		.into_iter()
		.filter(|appearance| *appearance != drawn)
		.collect()
}

#[test]
fn a_pointer_on_an_appearance_row_draws_the_window_in_it() {
	for other in others(DEFAULT_APPEARANCE) {
		let label = row_label(other);
		on_default(on_the_themes_page(), |session| {
			session
				.hover(off_every_row())
				.expect("the pointer reaches the sheet");
			let resting = session.frame().expect("the resting frame renders").frame;

			let captured = session.frame().expect("the page frame renders");
			let row = centre_of_run(&captured.text_runs, &label);
			session.hover(row).expect("the pointer reaches the row");
			let previewed = session.frame().expect("the previewed frame renders").frame;

			let changed = changed_pixels(&resting, &previewed);
			let total = (resting.width() * resting.height()) as usize;
			assert!(
				changed > total / 4,
				"hovering the {other} row changed {changed} of {total} pixels: a preview restyles the \
				 window, so a change confined to the row means the appearance never reached the \
				 colours"
			);
			let moved = (mean_luma(&previewed) - mean_luma(&resting)).abs();
			assert!(
				moved > 1.0,
				"hovering the {other} row moved the mean luma by {moved:.2}, so the window is drawn \
				 in the same colours it was"
			);

			session
				.update(|view, _window, _cx| {
					assert_eq!(
						view.state().appearance.drawn(),
						other,
						"the pointer is on the {other} row and the window states it is drawing \
						 something else"
					);
					assert_eq!(
						view.state().appearance.chosen(),
						DEFAULT_APPEARANCE,
						"a preview wrote the choice: reading the page committed an appearance"
					);
				})
				.expect("the state is read back");
		});
	}
}

#[test]
fn the_pointer_leaving_a_row_puts_the_chosen_appearance_back() {
	for other in others(DEFAULT_APPEARANCE) {
		let label = row_label(other);
		on_default(on_the_themes_page(), |session| {
			session
				.hover(off_every_row())
				.expect("the pointer reaches the sheet");
			let resting = session.frame().expect("the resting frame renders").frame;

			let captured = session.frame().expect("the page frame renders");
			let row = centre_of_run(&captured.text_runs, &label);
			session.hover(row).expect("the pointer reaches the row");
			session.frame().expect("the previewed frame renders");

			session
				.hover(off_every_row())
				.expect("the pointer leaves the row");
			let back = session.frame().expect("the reverted frame renders").frame;

			let changed = changed_pixels(&resting, &back);
			assert_eq!(
				changed, 0,
				"{changed} pixels survived the pointer leaving the {other} row: the window did not \
				 come back to the appearance it was drawn in"
			);
			session
				.update(|view, _window, _cx| {
					assert_eq!(
						view.state().appearance.previewed(),
						None,
						"the pointer left the row and the preview is still held"
					);
					assert_eq!(
						view.state().appearance.drawn(),
						DEFAULT_APPEARANCE,
						"the pointer left the row and the window is drawing the preview"
					);
				})
				.expect("the state is read back");
		});
	}
}

#[test]
fn an_appearance_selected_on_the_page_outlives_the_pointer() {
	for other in others(DEFAULT_APPEARANCE) {
		let label = row_label(other);
		on_default(on_the_themes_page(), |session| {
			session
				.hover(off_every_row())
				.expect("the pointer reaches the sheet");
			let resting = session.frame().expect("the resting frame renders").frame;

			let captured = session.frame().expect("the page frame renders");
			let row = centre_of_run(&captured.text_runs, &label);
			// The row's control is the only Select on the page: the host
			// reported no themes, so the rows under the appearances are the
			// empty state.
			let select = centre_of_run(&captured.text_runs, "Select");
			session.hover(row).expect("the pointer reaches the row");
			session.frame().expect("the previewed frame renders");
			session
				.click(select)
				.expect("the Select control is clicked");
			session.frame().expect("the selected frame renders");

			session
				.hover(off_every_row())
				.expect("the pointer leaves the row");
			let after = session
				.frame()
				.expect("the frame after the pointer left renders")
				.frame;

			session
				.update(|view, _window, _cx| {
					assert_eq!(
						view.state().appearance.chosen(),
						other,
						"clicking Select on the {other} row did not choose it"
					);
					assert_eq!(
						view.state().appearance.previewed(),
						None,
						"the pointer left the page and a preview is still held"
					);
				})
				.expect("the state is read back");

			let moved = (mean_luma(&after) - mean_luma(&resting)).abs();
			assert!(
				moved > 1.0,
				"the pointer left and the window fell back to the appearance it opened in: the mean \
				 luma moved {moved:.2} from the opening frame"
			);
		});
	}
}

#[test]
fn a_window_opened_in_an_appearance_draws_a_row_for_every_one_the_build_ships() {
	for opened in APPEARANCES {
		driven(opened, on_the_themes_page(), |session| {
			let captured = session.frame().expect("the page frame renders");
			let drawn: Vec<&str> = captured
				.text_runs
				.iter()
				.map(|run| run.text.as_ref())
				.collect();
			for appearance in APPEARANCES {
				let label = row_label(appearance);
				assert!(
					drawn.contains(&label.as_str()),
					"a window drawn in {opened} lists no row reading {label:?}; it drew {drawn:?}"
				);
			}
		});
	}
}
