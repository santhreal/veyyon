//! Where a remembered window reopens.

use veyyon_desktop_model::PersistedState;
use veyyon_gpui::{Bounds, Pixels, Point, Size, px};

/// Where a window store reopens the window, and whether it opens maximised.
///
/// The remembered size is raised to the minimum the window can draw at, and
/// the remembered origin is kept only while the window's own centre lands on a
/// display this machine has: a rect left on a monitor that has since been
/// unplugged is a window opened where nothing can reach it, so it is centred
/// on the first display instead (§8.10).
#[must_use]
pub fn placement(
	state: &PersistedState,
	displays: &[Bounds<Pixels>],
	min_width: f32,
	min_height: f32,
) -> (Bounds<Pixels>, bool) {
	let window = &state.window;
	let size = Size {
		width:  px(px_measure(window.width).max(min_width)),
		height: px(px_measure(window.height).max(min_height)),
	};
	let origin = Point { x: px(window.x as f32), y: px(window.y as f32) };
	let bounds = Bounds { origin, size };
	let centre = Point { x: origin.x + size.width / 2.0, y: origin.y + size.height / 2.0 };
	if displays.iter().any(|display| display.contains(&centre)) {
		return (bounds, window.maximized);
	}
	let Some(first) = displays.first() else {
		return (Bounds { origin: Point { x: px(0.0), y: px(0.0) }, size }, window.maximized);
	};
	(Bounds::centered_at(first.center(), size), window.maximized)
}

/// A remembered measure in pixels, with a stored zero meaning the store has
/// none rather than a window with no size.
const fn px_measure(value: u32) -> f32 {
	if value == 0 { 0.0 } else { value as f32 }
}
