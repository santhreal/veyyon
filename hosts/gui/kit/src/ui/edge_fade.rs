//! Content that dissolves into its own edges where it continues past them.
//!
//! A scroll region that stops at a hard line tells a reader nothing: a row cut
//! in half by the region's top edge reads as a row that is drawn wrong, not as
//! a row that is above the view. A band of the surface colour, opaque at the
//! edge and clear a short distance in, makes the cut read as depth.
//!
//! WHY THIS IS AN ELEMENT AND NOT A DIV WITH A GRADIENT ON TOP. The bands are
//! gated on whether the region is actually scrolled, and that has to be read
//! after the tracked scroll container has clamped this frame's offset, which
//! happens in prepaint. A gradient placed by a [`RenderOnce`](gpui::RenderOnce)
//! reads the previous frame's offset instead: on the last frame of a content
//! shrink - rows removed while scrolled to the bottom - prepaint clamps the
//! offset to fit, nothing re-renders, and a band with nothing behind it stays
//! on screen. Painting the bands in [`Element::paint`] reads the clamped value
//! for this frame every time.
//!
//! No blur. The pinned gpui rev exposes no backdrop-blur primitive, so a float
//! over its own content is an opaque surface with a shadow, and a fade band is
//! a gradient of a known ground rather than a sample of whatever is behind it.

use gpui::{
	AnyElement, App, Bounds, Element, GlobalElementId, Hsla, InspectorElementId, IntoElement,
	LayoutId, List, ListState, Pixels, Point, ScrollHandle, StatefulInteractiveElement, Styled,
	UniformList, UniformListScrollHandle, Window, fill, linear_color_stop, linear_gradient, px,
	size,
};

use crate::theme::{Elevation, Theme, layout};

mod edges;

pub use edges::FadedEdges;

/// Fade `child` at the edges of the region `handle` scrolls.
///
/// The colour is the ground the child sits on, named as an elevation so the
/// palette resolves it: a band is the surface reappearing over its own content,
/// and a band of the wrong ground reads as a stripe.
pub fn edge_fade(handle: &ScrollHandle, under: Elevation, child: impl IntoElement) -> EdgeFade {
	EdgeFade {
		tracked: Tracked::Scroll(handle.clone()),
		under,
		band: layout::fade_band(),
		band_top: None,
		band_bottom: None,
		axes: Axes::Vertical,
		child: child.into_any_element(),
	}
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Axes {
	Vertical,
	Both,
}

/// What the bands are gated on.
///
/// A plain scroll container counts pixels from zero; a [`ListState`] counts
/// rows, keeps its own offset and answers whether it is at the end. Both are
/// read in [`Element::paint`], after this frame's offset is clamped.
enum Tracked {
	Scroll(ScrollHandle),
	List(ListState),
}

pub struct EdgeFade {
	tracked:     Tracked,
	under:       Elevation,
	band:        f32,
	band_top:    Option<f32>,
	band_bottom: Option<f32>,
	axes:        Axes,
	child:       AnyElement,
}

impl EdgeFade {
	/// The ramp depth at every edge that has no depth of its own.
	pub fn band(mut self, band: f32) -> Self {
		self.band = band;
		self
	}

	/// The ramp depth at the top edge alone.
	///
	/// Asymmetric bands are the common case, not the exception: content passes
	/// under a titlebar of one height and a composer stack of another, and a
	/// band deeper than the chrome above it fades content that is still in
	/// plain view.
	pub fn band_top(mut self, band: f32) -> Self {
		self.band_top = Some(band);
		self
	}

	/// The ramp depth at the bottom edge alone.
	pub fn band_bottom(mut self, band: f32) -> Self {
		self.band_bottom = Some(band);
		self
	}

	/// Fade the left and right edges too, for a region that scrolls sideways.
	pub fn horizontal(mut self) -> Self {
		self.axes = Axes::Both;
		self
	}

	fn edges(&self) -> FadedEdges {
		let edges = match &self.tracked {
			Tracked::Scroll(handle) => FadedEdges::of(handle.offset(), handle.max_offset()),
			Tracked::List(state) => FadedEdges::of_list(
				state.logical_scroll_top().item_ix,
				state.logical_scroll_top().offset_in_item,
				state.is_scrolled_to_end(),
				state.item_count(),
			),
		};
		match self.axes {
			Axes::Vertical => edges.vertical(),
			Axes::Both => edges,
		}
	}

	fn paint_bands(&self, bounds: Bounds<Pixels>, ground: Hsla, window: &mut Window) {
		let edges = self.edges();
		if !edges.any() {
			return;
		}
		let clear = Hsla { a: 0.0, ..ground };
		let top = px(self.band_top.unwrap_or(self.band));
		let bottom = px(self.band_bottom.unwrap_or(self.band));
		let side = px(self.band);

		// gpui reads a gradient angle as CSS does: zero points at the top, so
		// the first stop is the edge the angle points away from.
		if edges.top {
			let band =
				Bounds::new(bounds.origin, size(bounds.size.width, top.min(bounds.size.height)));
			window.paint_quad(fill(
				band,
				linear_gradient(0.0, linear_color_stop(clear, 1.0), linear_color_stop(ground, 0.0)),
			));
		}
		if edges.bottom {
			let depth = bottom.min(bounds.size.height);
			let band = Bounds::new(
				Point { x: bounds.origin.x, y: bounds.bottom() - depth },
				size(bounds.size.width, depth),
			);
			window.paint_quad(fill(
				band,
				linear_gradient(0.0, linear_color_stop(ground, 0.0), linear_color_stop(clear, 1.0)),
			));
		}
		if edges.left {
			let depth = side.min(bounds.size.width);
			let band = Bounds::new(bounds.origin, size(depth, bounds.size.height));
			window.paint_quad(fill(
				band,
				linear_gradient(270.0, linear_color_stop(clear, 1.0), linear_color_stop(ground, 0.0)),
			));
		}
		if edges.right {
			let depth = side.min(bounds.size.width);
			let band = Bounds::new(
				Point { x: bounds.right() - depth, y: bounds.origin.y },
				size(depth, bounds.size.height),
			);
			window.paint_quad(fill(
				band,
				linear_gradient(270.0, linear_color_stop(ground, 0.0), linear_color_stop(clear, 1.0)),
			));
		}
	}
}

impl Element for EdgeFade {
	type PrepaintState = ();
	type RequestLayoutState = ();

	fn id(&self) -> Option<gpui::ElementId> {
		None
	}

	fn source_location(&self) -> Option<&'static core::panic::Location<'static>> {
		None
	}

	fn request_layout(
		&mut self,
		_: Option<&GlobalElementId>,
		_: Option<&InspectorElementId>,
		window: &mut Window,
		cx: &mut App,
	) -> (LayoutId, Self::RequestLayoutState) {
		// The child's own layout id, so the wrapper occupies exactly the
		// region it fades and adds no box to the tree.
		(self.child.request_layout(window, cx), ())
	}

	fn prepaint(
		&mut self,
		_: Option<&GlobalElementId>,
		_: Option<&InspectorElementId>,
		_: Bounds<Pixels>,
		_: &mut Self::RequestLayoutState,
		window: &mut Window,
		cx: &mut App,
	) -> Self::PrepaintState {
		self.child.prepaint(window, cx);
	}

	fn paint(
		&mut self,
		_: Option<&GlobalElementId>,
		_: Option<&InspectorElementId>,
		bounds: Bounds<Pixels>,
		_: &mut Self::RequestLayoutState,
		_: &mut Self::PrepaintState,
		window: &mut Window,
		cx: &mut App,
	) {
		let ground = Theme::get(cx).elevation(self.under);
		self.child.paint(window, cx);
		// One layer, so the bands hold their order above the rows they cover:
		// equal draw orders group by primitive kind, and a band quad painted
		// after a glyph still lands under it.
		window.paint_layer(bounds, |window| self.paint_bands(bounds, ground, window));
	}
}

impl IntoElement for EdgeFade {
	type Element = Self;

	fn into_element(self) -> Self::Element {
		self
	}
}

/// Make an element scroll, and fade what it scrolls past.
///
/// One call rather than two, because the two are not separable: a region that
/// scrolls and does not fade has a hard cut at its edge, and every such region
/// in this window was written by copying a neighbouring one. The gate in
/// `scripts/the-gui-crates-only-depend-downward.test.ts` keeps
/// `overflow_y_scroll` and `track_scroll` inside kit, so a surface reaches
/// scrolling only through here and cannot get half of it.
pub trait Scrolls: StatefulInteractiveElement + Styled + IntoElement + Sized {
	/// Scroll vertically, fading the top and bottom edges.
	fn scrolls_y(self, handle: &ScrollHandle, under: Elevation) -> EdgeFade {
		edge_fade(handle, under, self.overflow_y_scroll().track_scroll(handle))
	}

	/// Scroll sideways, fading the left and right edges. A row of tabs or a
	/// diff line: the cut is at the ends, not the top.
	fn scrolls_x(self, handle: &ScrollHandle, under: Elevation) -> EdgeFade {
		edge_fade(handle, under, self.overflow_x_scroll().track_scroll(handle)).horizontal()
	}

	/// Scroll on both axes, fading all four edges.
	fn scrolls(self, handle: &ScrollHandle, under: Elevation) -> EdgeFade {
		edge_fade(handle, under, self.overflow_scroll().track_scroll(handle)).horizontal()
	}
}

impl<T: StatefulInteractiveElement + Styled + IntoElement + Sized> Scrolls for T {}

/// A virtualized list, tracked and faded.
///
/// `uniform_list` windows its own rows, so it is not a `Div` and takes gpui's
/// own handle rather than the extension above. The fade reads the base
/// `ScrollHandle` inside that handle, which is the same offset the list scrolls
/// on, so a virtualized region cuts its first and last row exactly as a plain
/// one does and is faded the same way.
pub fn scrolls_uniform(
	list: UniformList,
	handle: &UniformListScrollHandle,
	under: Elevation,
) -> EdgeFade {
	let base = handle.0.borrow().base_handle.clone();
	edge_fade(&base, under, list.track_scroll(handle))
}

/// A `list()` region, faded at the edges its own state says it has content
/// past.
///
/// A [`ListState`] list scrolls itself and has no `ScrollHandle` to read, which
/// is why the transcript - the largest scroll region in the window - was the
/// one with a hard cut at both edges. It answers the same question in its own
/// units: which row is at the top, how far into that row the view starts, and
/// whether the last row is fully shown.
pub fn scrolls_list(rows: List, state: &ListState, under: Elevation) -> EdgeFade {
	EdgeFade {
		tracked: Tracked::List(state.clone()),
		under,
		band: layout::fade_band(),
		band_top: None,
		band_bottom: None,
		axes: Axes::Vertical,
		child: rows.into_any_element(),
	}
}
