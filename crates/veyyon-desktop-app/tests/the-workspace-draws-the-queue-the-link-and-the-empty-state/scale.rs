//! A region's logical bounds do not depend on the display's scale factor.
//!
//! WHY: the workspace lays its regions out in logical pixels and the
//! platform scales the frame to device pixels. A size scaled by the scale
//! factor on its way to layout draws every region at twice or half its width
//! on a high-density display, and lays a window out anew when it moves
//! between displays.
//!
//! Class: every region the workspace draws, with a session open and with the
//! empty state in the thread's place, is drawn at the same logical bounds at
//! scale factor 1 and 2, each edge within the one logical pixel that snapping
//! to device pixels moves it at scale factor 1.
//!
//! Gap: no frame is rasterized, so a frame drawn at the wrong device size
//! over the right logical bounds is not caught. Fractional scale factors are
//! not swept.

use gpui::{Bounds, Pixels, TestAppContext, VisualTestContext};
use veyyon_desktop_model::{PanelsStore, Store};

use super::{open_laid_out, remembering};

/// What a window with a session open draws, every region open.
const WITH_SESSION: [&str; 4] =
	["sidebar-region", "thread-region", "panel-region", "drawer-region"];

/// What a window with no session open draws, every region open: the empty
/// state's titlebar and action in the thread's place.
const WITHOUT_SESSION: [&str; 5] =
	["sidebar-region", "empty-drag-region", "empty-new-thread", "panel-region", "drawer-region"];

/// The logical bounds each of `selectors` is drawn at, at scale factor
/// `scale`: left, top, right and bottom.
fn drawn_at(cx: &mut VisualTestContext, scale: f32, selectors: &[&'static str]) -> Vec<[f32; 4]> {
	cx.update(|window, _| window.set_scale_factor(scale));
	cx.run_until_parked();
	cx.update(|window, _| window.refresh());
	assert_eq!(cx.update(|window, _| window.scale_factor()), scale, "the window draws at {scale}");
	selectors
		.iter()
		.map(|&selector| {
			let bounds: Bounds<Pixels> = cx
				.debug_bounds(selector)
				.unwrap_or_else(|| panic!("`{selector}` is drawn at scale factor {scale}"));
			let [left, top] = [bounds.left(), bounds.top()].map(f32::from);
			let [right, bottom] = [bounds.right(), bounds.bottom()].map(f32::from);
			[left, top, right, bottom]
		})
		.collect()
}

#[test]
fn every_region_keeps_its_logical_bounds_when_the_scale_factor_doubles() {
	let arms = [(remembering("s1"), &WITH_SESSION[..]), (Store::new(), &WITHOUT_SESSION[..])];
	for (store, selectors) in arms {
		let mut cx = TestAppContext::single();
		let panels =
			PanelsStore { right_panel_visible: true, drawer_visible: true, ..PanelsStore::default() };
		let (_, _, cx) = open_laid_out(&mut cx, store, panels);
		let single = drawn_at(cx, 1.0, selectors);
		let double = drawn_at(cx, 2.0, selectors);
		for ((selector, at_one), at_two) in selectors.iter().zip(&single).zip(&double) {
			assert!(
				at_one[2] > at_one[0] && at_one[3] > at_one[1],
				"`{selector}` has an area at scale factor 1: {at_one:?}"
			);
			let apart = at_one
				.iter()
				.zip(at_two)
				.map(|(one, two)| (one - two).abs());
			assert!(
				apart.fold(0.0, f32::max) <= 1.0,
				"`{selector}` is drawn at {at_one:?} at scale factor 1 and {at_two:?} at 2"
			);
		}
	}
}
