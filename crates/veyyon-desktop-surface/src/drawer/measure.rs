//! Telling the grid how many cells the window has room for.
//!
//! The measure is taken from the box the grid was just laid out in, in the
//! prepaint of the frame that laid it out. Reading it a frame later, off the
//! boxes the last frame recorded, leaves the grid at the wrong size whenever
//! the geometry changes on a frame nothing else makes dirty -- the rail
//! collapsing, the panel opening -- because no later frame is drawn to read
//! it.
//!
//! The cells are what the emulator is resized to and what the host's pty is
//! told, so they are counted off the drawn box rather than worked out again
//! from the shed: an arithmetic copy beside the renderer is how the count
//! drifts from the pixels.

use veyyon_desktop_model::text::terminal::{MAX_COLUMNS, MAX_ROWS, cells_that_fit};
use veyyon_gpui::{App, Bounds, Context, Div, Pixels, WeakEntity, Window};

use crate::{
	Intent, ShellView,
	damage::{LaidOut, Region},
};

/// Records the grid's box for damage, and asks for the size it has room for.
///
/// `div` holds the cells and nothing else: its box is the grid, without the
/// drawer's chrome or the padding around it.
pub fn track_grid_box(div: Div, laid_out: &LaidOut, cx: &Context<ShellView>) -> Div {
	let laid_out = laid_out.clone();
	let view = cx.weak_entity();
	div.on_children_prepainted(move |children, window, app| {
		let Some(bounds) = children.into_iter().next() else {
			return;
		};
		laid_out.record(Region::TerminalGrid, bounds, window);
		ask_for_the_measured_size(&view, bounds, window, app);
	})
}

/// The columns and rows a box of this size holds, by the drawer's own cell.
fn cells_for(view: &ShellView, bounds: Bounds<Pixels>) -> (u16, u16) {
	let panels = &view.installed().surface.panels;
	let floor = (
		u16::try_from(panels.terminal_min_columns).unwrap_or(MAX_COLUMNS),
		u16::try_from(panels.terminal_min_rows).unwrap_or(MAX_ROWS),
	);
	cells_that_fit(
		f32::from(bounds.size.width),
		f32::from(bounds.size.height),
		panels.terminal_cell_width_px,
		panels.terminal_cell_height_px,
		floor,
	)
}

/// Raises the ordinary resize when the box holds a different number of cells
/// than the grid is at.
///
/// Nothing is raised from the prepaint itself: the frame is being laid out,
/// and the size the window holds is state the next frame draws from. The
/// callback is registered only when the two differ, so a settled window
/// registers nothing and asks for no further frame.
fn ask_for_the_measured_size(
	view: &WeakEntity<ShellView>,
	bounds: Bounds<Pixels>,
	window: &Window,
	app: &App,
) {
	let Some(entity) = view.upgrade() else {
		return;
	};
	let held = entity.read(app);
	if cells_for(held, bounds) == held.state().drawer.grid_cells {
		return;
	}

	let view = view.clone();
	window.on_next_frame(move |_window, app| {
		let _ = view.update(app, |view, cx| {
			let (cols, rows) = cells_for(view, bounds);
			if (cols, rows) != view.state().drawer.grid_cells {
				// The ordinary resize the drawer's own control raises: it is
				// what carries the size to the host, and applying it is what
				// re-breaks the operator's view before the host answers.
				view.dispatch(Intent::ResizeTerminal { cols, rows }, cx);
				cx.notify();
			}
		});
	});
}
