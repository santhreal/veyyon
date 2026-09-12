//! Where the right panel is drawn at the width the shed resolved (§5.6).
//!
//! Docked, it is the second pane of a split the operator drags, and the handle
//! sits inside the panel's own measure so the session surface keeps the width
//! the shed gave it. Floated, it is a sheet inside the session surface rather
//! than over the root row: it annotates the transcript, so the scrim dims the
//! transcript alone and the composer, the cards above it and the run bar under
//! it stay lit and stay reachable.

use veyyon_desktop_kit::{Axis, Resizable, Sheet, TokenSet};
use veyyon_desktop_tokens::PanelsSurfaceTokens;
use veyyon_gpui::{
	AnyElement, Context, Div, FocusHandle, IntoElement, ParentElement, Styled, Window, div, px,
};

use crate::{
	ShellView,
	damage::Region,
	layout::{RightPanelPlacement, ShellWidths},
	panel::right_panel,
};

/// Builds the floated panel, for the placement that floats it.
///
/// It is built before the surface it is handed to, which takes its height from
/// the transcript's own region.
pub fn panel_float(
	view: &ShellView,
	widths: &ShellWidths,
	panels: &PanelsSurfaceTokens,
	tokens: &TokenSet,
	panel_focus: &FocusHandle,
	window: &mut Window,
	cx: &Context<ShellView>,
) -> Option<Div> {
	let RightPanelPlacement::Overlay { width_px } = widths.right_panel else {
		return None;
	};
	let inset_px = f32::from(Sheet::inset(tokens));
	let body = right_panel(
		&view.state().panel,
		view.review_store(),
		inset_px.mul_add(-2.0, width_px),
		view.pane_scrolls(),
		panels,
		tokens,
		panel_focus,
		view.laid_out(),
		window,
		cx,
	);
	Some(
		view.laid_out().track_children(
			div()
				.absolute()
				.inset_0()
				.flex()
				.flex_row()
				.justify_end()
				.backdrop_blur(px(panels.right_panel_overlay_scrim_blur_px))
				.bg(tokens.scrim())
				.child(Sheet::right(body)),
			|index| (index == 0).then_some(Region::Panel),
		),
	)
}

/// Builds the split whose second pane is the docked panel.
///
/// The grip is the hit area the panels tokens author, handed to the primitive
/// rather than resolved inside it, and it is taken out of the panel's measure
/// so the body draws in what is left.
pub fn docked_split(
	view: &ShellView,
	widths: &ShellWidths,
	panels: &PanelsSurfaceTokens,
	tokens: &TokenSet,
	panel_focus: &FocusHandle,
	session: AnyElement,
	width_px: f32,
	window: &mut Window,
	cx: &Context<ShellView>,
) -> AnyElement {
	let grip_px = panels.chrome_resize_handle_hit_px;
	let body = right_panel(
		&view.state().panel,
		view.review_store(),
		width_px - grip_px,
		view.pane_scrolls(),
		panels,
		tokens,
		panel_focus,
		view.laid_out(),
		window,
		cx,
	);
	let tracked = view
		.laid_out()
		.track_children(div().h_full().w_full().flex().child(body), |index| {
			(index == 0).then_some(Region::Panel)
		});
	let split_px = widths.session_px + width_px;
	let shell = cx.weak_entity();
	let release_shell = shell.clone();
	let min_width = panels.right_panel_min_width_px;
	let max_width = (f32::from(window.viewport_size().width)
		* panels.right_panel_max_viewport_ratio)
		.min(split_px - panels.right_panel_container_margin_px)
		.max(min_width);
	Resizable::new("shell-split", Axis::Horizontal, px(grip_px), session, tracked)
		.ratio(widths.session_px / split_px)
		.on_resize(move |ratio, _window, cx| {
			let asked_px = (1.0 - ratio) * split_px;
			// A released view has no handle to move; the drag ends with the
			// window.
			let _ = shell.update(cx, |view, cx| {
				view.drag_panel(asked_px, min_width, max_width, cx);
				cx.notify();
			});
		})
		.on_resize_end(move |_window, cx| {
			let _ = release_shell.update(cx, |view, cx| {
				view.release_panel(cx);
				cx.notify();
			});
		})
		.into_any_element()
}
