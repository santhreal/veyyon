//! A remembered sidebar width is read back inside the sidebar's bounds.
//!
//! WHY: the width the sidebar was dragged to is written into the panels
//! store. A record written before the field existed holds no width, and a
//! record edited by hand holds whatever number was typed into it. A width read
//! back unchecked lays the sidebar out narrower than its minimum or wider than
//! its maximum, and an absent width read as zero hides the sidebar.
//!
//! Class: every remembered width, absent, below, at, inside and above the
//! bounds `size::SIDEBAR_MIN..=size::SIDEBAR_MAX` state, is drawn inside
//! them, an absent one at the default, and the store the window writes back
//! holds the width it drew, so the launch that reads an out-of-range record
//! corrects it.
//!
//! Gap: the bounds are fixed. The legacy client capped the width by the
//! window's own width; the rebuild caps it at `size::SIDEBAR_MAX` whatever the
//! window width, so a window narrower than that is not covered. Rejecting a
//! stale record version is the model crate's and is not exercised here.

use gpui::{Pixels, TestAppContext, px};
use veyyon_desktop_model::{PanelsStore, Store};
use veyyon_desktop_ui::theme::size;

use super::open_laid_out;

/// The width the sidebar opens to, the width it is drawn at, and the width
/// the window writes back, for a store that remembers `width`.
fn read_back(width: Option<u32>) -> (Pixels, Pixels, Option<u32>) {
	let mut cx = TestAppContext::single();
	let panels = PanelsStore { queue_width: width, ..PanelsStore::default() };
	let (_, workspace, cx) = open_laid_out(&mut cx, Store::new(), panels);
	cx.update(|window, _| window.refresh());
	let drawn = cx
		.debug_bounds("sidebar-region")
		.expect("the sidebar is open")
		.size
		.width;
	let (opens, written) = workspace.read_with(cx, |workspace, cx| {
		(workspace.sizes().sidebar, workspace.panels_store(cx).queue_width)
	});
	(opens, drawn, written)
}

#[test]
fn a_remembered_sidebar_width_is_drawn_and_written_back_inside_its_bounds() {
	let min = f32::from(size::SIDEBAR_MIN) as u32;
	let max = f32::from(size::SIDEBAR_MAX) as u32;
	let inside = u32::midpoint(min, max);
	let cases = [
		(None, size::SIDEBAR),
		(Some(0), size::SIDEBAR_MIN),
		(Some(min - 1), size::SIDEBAR_MIN),
		(Some(min), size::SIDEBAR_MIN),
		(Some(inside), px(inside as f32)),
		(Some(max), size::SIDEBAR_MAX),
		(Some(max + 1), size::SIDEBAR_MAX),
		(Some(u32::MAX), size::SIDEBAR_MAX),
	];
	let read: Vec<_> = cases
		.iter()
		.map(|(width, _)| (*width, read_back(*width)))
		.collect();
	let expected: Vec<_> = cases
		.iter()
		.map(|(width, bounded)| {
			let written = width.map(|_| f32::from(*bounded) as u32);
			(*width, (*bounded, *bounded, written))
		})
		.collect();
	assert_eq!(read, expected, "each remembered width is opened, drawn and written back in bounds");
}
