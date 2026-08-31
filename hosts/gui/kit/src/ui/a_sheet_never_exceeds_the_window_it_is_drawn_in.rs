//! WHY THIS SUITE EXISTS. A sheet took the width its caller asked for and gave
//! its content the reading measure in height, and neither was measured against
//! the window. The palette asks for the sheet width plus a preview column, so
//! on a window at the layout's own minimum width the panel was drawn wider than
//! the window and the preview, the hint row and the right edge of every row sat
//! off the screen; the command list is taller than the reading measure allows
//! for a short window, so its last rows ran off the bottom with no border under
//! them and no way to scroll to them.
//!
//! It closes the class rather than those two sizes: the box a sheet may occupy
//! is one function of the window, so every sheet — palette, model picker,
//! confirmation, image viewer — is bounded by the window it is drawn in,
//! whatever width its caller asks for and whatever drop it hangs from.
//!
//! WHAT IT DOES NOT CATCH. Whether the content inside the box scrolls to its
//! end (the picker body's own flex and scroll region decide that), whether the
//! platform reports a viewport smaller than the window, and how a sheet reads
//! once it is bounded — a panel that fits can still be too cramped to use, and
//! only a capture shows that.

use gpui::{px, size};

use super::sheet::bounded;
use crate::theme::layout;

/// The window every scene records the narrow arm at, and the smallest window
/// the app opens: the size a sheet has to fit first.
fn floor() -> gpui::Size<gpui::Pixels> {
	size(px(layout::MIN_WINDOW_WIDTH), px(layout::MIN_WINDOW_HEIGHT))
}

#[test]
fn a_width_the_window_has_room_for_is_the_width_the_caller_asked_for() {
	let room = size(px(1_440.0), px(920.0));
	let (width, _) = bounded(room, Some(layout::SHEET_TOP), layout::SHEET);

	assert_eq!(width, layout::SHEET);
}

#[test]
fn a_width_wider_than_the_window_is_cut_to_the_window_less_its_margins() {
	// What the palette asks for when it reserves a preview column, on the
	// narrowest window the app opens.
	let asked = layout::SHEET + layout::INSPECTOR_MIN;
	let (width, _) = bounded(floor(), Some(layout::SHEET_TOP), asked);

	assert_eq!(width, layout::MIN_WINDOW_WIDTH - 2.0 * layout::OVERLAY_MARGIN);
	assert!(width < asked, "the sheet kept a width the window has no room for");
}

#[test]
fn the_height_is_the_room_left_under_the_drop_the_sheet_hangs_from() {
	let (_, height) = bounded(floor(), Some(layout::SHEET_TOP), layout::SHEET);

	assert_eq!(height, layout::MIN_WINDOW_HEIGHT - layout::SHEET_TOP - layout::OVERLAY_MARGIN);
}

#[test]
fn a_centred_sheet_is_measured_from_a_margin_rather_than_a_drop() {
	// A centred sheet overflows by half its excess at each end, so it is
	// measured from the margin it keeps instead of the drop it does not have.
	let (_, height) = bounded(floor(), None, layout::SHEET);

	assert_eq!(height, layout::MIN_WINDOW_HEIGHT - 2.0 * layout::OVERLAY_MARGIN);
}

#[test]
fn a_window_with_no_room_left_still_gives_a_positive_box() {
	// A window shorter than the drop, which the platform can report while a
	// window is being resized: the box stays positive rather than going
	// negative and inverting the panel's constraints.
	let (width, height) = bounded(size(px(8.0), px(8.0)), Some(layout::SHEET_TOP), layout::SHEET);

	assert!(width > 0.0 && height > 0.0, "a sheet was given a box of {width}x{height}");
}

#[test]
fn every_window_the_app_opens_bounds_every_sheet_width_a_caller_can_ask_for() {
	// The sweep: every window from the app's floor to a large desktop, against
	// every width a sheet in this app asks for. A sheet is never wider than the
	// window and never taller than the room under its drop, and it never
	// collapses to nothing on a window that has room.
	let asked = [
		layout::SHEET,
		layout::SHEET + layout::INSPECTOR_MIN,
		layout::SHEET + layout::INSPECTOR_MAX,
		layout::MIN_WINDOW_WIDTH,
	];
	let drops = [Some(layout::SHEET_TOP), None];

	let mut width = layout::MIN_WINDOW_WIDTH;
	while width <= 2_560.0 {
		let mut height = layout::MIN_WINDOW_HEIGHT;
		while height <= 1_600.0 {
			let room = size(px(width), px(height));
			for max_width in asked {
				for top in drops {
					let (bounded_width, bounded_height) = bounded(room, top, max_width);
					let drop = top.unwrap_or(layout::OVERLAY_MARGIN);

					assert!(
						bounded_width <= width,
						"{width}x{height}: a sheet asking {max_width} was drawn wider than the window"
					);
					assert!(
						bounded_width <= max_width,
						"{width}x{height}: a sheet was drawn wider than it asked for"
					);
					assert!(
						bounded_height <= height - drop,
						"{width}x{height}: a sheet hanging from {drop} was drawn past the bottom edge"
					);
					assert!(
						bounded_width > 0.0 && bounded_height > 0.0,
						"{width}x{height}: a sheet was given nothing to draw in"
					);
				}
			}
			height += 97.0;
		}
		width += 113.0;
	}
}
