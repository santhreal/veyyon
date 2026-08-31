//! WHY THIS SUITE EXISTS.
//!
//! The titlebar is one flex row holding the workspace, the branch, the route,
//! the spaces, a search button, the engine's state and four panel toggles, with
//! the platform's window controls beside it. It fit because every window was
//! drawn at the design text size. At the largest size in the narrowest window
//! the same row needs half again the width, and what it cannot fit is drawn
//! over the window controls: the close button sits under an icon, and the
//! wordmark under the spaces label.
//!
//! THE CLASS. A row measured against the window width alone, when what runs out
//! of room is text. Every other breakpoint in `layout` is compared against the
//! width itself, and correctly: a sidebar is a fixed measure, and a reader who
//! raised the text size did not ask for a narrower window. The titlebar is the
//! one row whose content is text end to end, so its breakpoints are read in
//! design units.
//!
//! The size space is read from `font_size::CHOICES_MILLI_PX` at run time and
//! swept against the widths the window can open at, so a size added to that
//! list is covered with no edit here.
//!
//! WHAT IT DOES NOT CATCH. Whether the shed row actually fits, which is a
//! measurement of shaped text the recorded frames own, and which segment should
//! go first, which is a judgment rather than an invariant.

use veyyon_gui_core::navigation::font_size;

use super::{TitlebarDensity, layout, scale, titlebar_density};

/// The widths a window is opened and dragged to, from the narrowest the app
/// allows upward.
const WIDTHS: [f32; 6] = [layout::MIN_WINDOW_WIDTH, 920.0, 1180.0, 1440.0, 1920.0, 2560.0];

/// A density ordered by how much it draws, so a sweep can assert the direction
/// a change moves in.
fn drawn(density: TitlebarDensity) -> u8 {
	match density {
		TitlebarDensity::Tight => 0,
		TitlebarDensity::Trimmed => 1,
		TitlebarDensity::Full => 2,
	}
}

fn with_base<R>(milli_px: u16, body: impl FnOnce() -> R) -> R {
	scale::set_base_font(u32::from(milli_px));
	let out = body();
	scale::set_base_font(scale::DEFAULT_MILLI_PX);
	out
}

#[test]
fn the_narrowest_window_holds_every_label_at_the_size_the_tokens_were_drawn_at() {
	assert_eq!(
		titlebar_density(layout::MIN_WINDOW_WIDTH),
		TitlebarDensity::Full,
		"the window as drawn has room for the row as drawn; shedding at the default size would take \
		 a label away from a reader who asked for nothing"
	);
}

#[test]
fn a_larger_text_size_sheds_and_a_wider_window_gives_back() {
	for width in WIDTHS {
		let mut previous = 2;
		for milli_px in font_size::CHOICES_MILLI_PX {
			let density = with_base(milli_px, || titlebar_density(width));
			let now = drawn(density);
			assert!(
				now <= previous,
				"at {width}px the titlebar draws more at {milli_px} thousandths of a pixel than it \
				 did at the size below, so the row grows as the text does"
			);
			previous = now;
		}
	}
	for milli_px in font_size::CHOICES_MILLI_PX {
		with_base(milli_px, || {
			let mut previous = 0;
			for width in WIDTHS {
				let now = drawn(titlebar_density(width));
				assert!(
					now >= previous,
					"at {milli_px} thousandths of a pixel the titlebar draws less at {width}px than in \
					 the narrower window, so a wider window took a label away"
				);
				previous = now;
			}
		});
	}
}

#[test]
fn the_largest_text_in_the_narrowest_window_is_the_state_that_sheds_the_most() {
	let largest = font_size::CHOICES_MILLI_PX[font_size::CHOICES_MILLI_PX.len() - 1];
	assert_eq!(
		with_base(largest, || titlebar_density(layout::MIN_WINDOW_WIDTH)),
		TitlebarDensity::Tight,
		"the row that used to be drawn over the window controls has to be the one that sheds"
	);
}

#[test]
fn every_density_is_reachable_from_a_window_the_app_can_open() {
	let mut reached = Vec::new();
	for width in WIDTHS {
		for milli_px in font_size::CHOICES_MILLI_PX {
			let density = with_base(milli_px, || titlebar_density(width));
			if !reached.contains(&density) {
				reached.push(density);
			}
		}
	}
	for density in [TitlebarDensity::Full, TitlebarDensity::Trimmed, TitlebarDensity::Tight] {
		assert!(
			reached.contains(&density),
			"{density:?} is unreachable from any window size and text size a reader can choose, so \
			 it is a branch nothing draws"
		);
	}
}

#[test]
fn the_boundaries_are_the_stated_design_widths() {
	// Read in design units, so the assertion holds at whatever scale is in
	// force: at twice the design size the same boundary is twice the pixels.
	for milli_px in font_size::CHOICES_MILLI_PX {
		with_base(milli_px, || {
			let scale = scale::interface();
			let full = layout::TITLEBAR_FULL * scale;
			let trimmed = layout::TITLEBAR_TRIMMED * scale;
			assert_eq!(titlebar_density(full), TitlebarDensity::Full);
			assert_eq!(titlebar_density(full - 1.0), TitlebarDensity::Trimmed);
			assert_eq!(titlebar_density(trimmed), TitlebarDensity::Trimmed);
			assert_eq!(titlebar_density(trimmed - 1.0), TitlebarDensity::Tight);
		});
	}
}
