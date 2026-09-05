//! Resizable container primitive with splitter handle (§8.25).
//!
//! The handle starts a renderer drag; the container listens for that drag
//! and reports the share the pointer's travel from the press puts the first
//! pane at, as a ratio of the container's extent. The caller owns the ratio:
//! it stores what `on_resize` reports and passes it back through
//! [`Resizable::ratio`] on the next frame. The only state the split holds is
//! the press a drag is measured from, which no surface needs to see.

use std::sync::Arc;

use veyyon_gpui::{
	AnyElement, App, Context, ElementId, Empty, Entity, IntoElement, MouseButton, Pixels, Point,
	Render, RenderOnce, Window, div, prelude::*, relative,
};

use crate::{
	geometry::Axis,
	token_set::{ColorRole, SpacingStep, StrokeStep, TokenSet},
};

/// Where the handle was pressed and the share the first pane had then. The
/// split moves by the pointer's travel from here, so the handle stays under
/// the finger that took it, wherever in the grip that was, and a frame that
/// re-renders mid-drag with the new share does not compound the travel.
#[derive(Clone, Copy)]
struct Grab {
	pressed: Point<Pixels>,
	ratio:   f32,
}

/// The drag a resize handle starts.
///
/// Its type is what the container listens for, so a file drag or a card
/// drag crossing the split does not resize it, and the grab it carries is
/// what the container checks is its own, so a resize drag crossing from
/// another split does not either.
pub struct ResizeDrag {
	axis: Axis,
	grab: Entity<Option<Grab>>,
}

impl ResizeDrag {
	/// The axis the drag resizes along.
	#[must_use]
	pub const fn axis(&self) -> Axis {
		self.axis
	}
}

/// The drag preview: a resize draws nothing under the pointer.
struct ResizeGhost;

impl Render for ResizeGhost {
	fn render(&mut self, _window: &mut Window, _cx: &mut Context<Self>) -> impl IntoElement {
		Empty
	}
}

/// Resizable split container with draggable separator handle.
#[derive(IntoElement)]
pub struct Resizable {
	id:        ElementId,
	axis:      Axis,
	first:     AnyElement,
	second:    AnyElement,
	ratio:     f32,
	on_resize: Option<Arc<dyn Fn(f32, &mut Window, &mut App) + Send + Sync + 'static>>,
}

impl Resizable {
	/// Creates a resizable split container.
	#[must_use]
	pub fn new(axis: Axis, first: impl IntoElement, second: impl IntoElement) -> Self {
		Self {
			id: ElementId::from("resizable"),
			axis,
			first: first.into_any_element(),
			second: second.into_any_element(),
			ratio: 0.5,
			on_resize: None,
		}
	}

	/// Sets the element id, which the handle derives its own from.
	#[must_use]
	pub fn id(mut self, id: impl Into<ElementId>) -> Self {
		self.id = id.into();
		self
	}

	/// Sets the split ratio: the first child's share of the extent, clamped to
	/// `0.05..=0.95` so neither side can be dragged shut.
	#[must_use]
	pub fn ratio(mut self, ratio: f32) -> Self {
		self.ratio = ratio.clamp(0.05, 0.95);
		self
	}

	/// Sets the handler that receives the ratio the pointer is dragged to.
	#[must_use]
	pub fn on_resize(
		mut self,
		handler: impl Fn(f32, &mut Window, &mut App) + Send + Sync + 'static,
	) -> Self {
		self.on_resize = Some(Arc::new(handler));
		self
	}

	/// The extent the handle takes along the split axis: the 8px hit area
	/// around a 1px line (§5.6). A caller placing the second pane at a
	/// declared measure subtracts it, so the handle sits inside that measure
	/// rather than pushing the pane past it.
	#[must_use]
	pub fn handle_extent(tokens: &TokenSet) -> Pixels {
		tokens.spacing(SpacingStep::S4)
	}
}

impl RenderOnce for Resizable {
	fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
		let default_tokens = TokenSet::default();
		let tokens = cx.try_global::<TokenSet>().unwrap_or(&default_tokens);

		let handle_color = tokens.color(ColorRole::Hairline);
		let stroke_px = tokens.stroke(StrokeStep::Hairline);
		let grip_px = Self::handle_extent(tokens);
		let axis = self.axis;
		let ratio = self.ratio;

		let child_id = |name: &'static str| match &self.id {
			ElementId::Name(base) => ElementId::Name(format!("{base}-{name}").into()),
			other => ElementId::NamedChild(Arc::new(other.clone()), name.into()),
		};
		let handle_id = child_id("handle");
		// The press outlives the frame it lands in: a drag re-renders the
		// split with each new share, and the travel is measured from the
		// press, not from the last frame.
		let grab = window.use_keyed_state(child_id("grab"), cx, |_, _| None::<Grab>);

		// The hairline is what the operator sees; the grip around it is what
		// the pointer catches, so a 1px line is not a 1px target.
		let handle = div()
			.id(handle_id)
			.flex_shrink_0()
			.flex()
			.items_center()
			.justify_center()
			.on_mouse_down(MouseButton::Left, {
				let grab = grab.clone();
				move |event, _, cx| {
					let pressed = event.position;
					grab.update(cx, |grab, _| *grab = Some(Grab { pressed, ratio }));
				}
			})
			.on_drag(ResizeDrag { axis, grab: grab.clone() }, |_, _, _, cx| cx.new(|_| ResizeGhost));
		let handle = match axis {
			Axis::Horizontal => handle
				.w(grip_px)
				.h_full()
				.cursor_col_resize()
				.child(div().w(stroke_px).h_full().bg(handle_color)),
			Axis::Vertical => handle
				.h(grip_px)
				.w_full()
				.cursor_row_resize()
				.child(div().h(stroke_px).w_full().bg(handle_color)),
		};

		let mut container = div().id(self.id).w_full().h_full().flex().overflow_hidden();
		if let Some(handler) = self.on_resize {
			container = container.on_drag_move::<ResizeDrag>(move |event, window, cx| {
				let drag = event.drag(cx);
				if drag.axis != axis || drag.grab.entity_id() != grab.entity_id() {
					return;
				}
				let Some(Grab { pressed, ratio }) = *grab.read(cx) else {
					return;
				};
				let travel = event.event.position - pressed;
				let extent = event.bounds.size;
				let share = match axis {
					Axis::Horizontal => f32::from(travel.x) / f32::from(extent.width).max(1.0),
					Axis::Vertical => f32::from(travel.y) / f32::from(extent.height).max(1.0),
				};
				handler((ratio + share).clamp(0.05, 0.95), window, cx);
			});
		}

		// The first pane takes its share of the extent; the second takes the
		// rest, so the handle's own width is never double-counted.
		let first = div()
			.flex_shrink_0()
			.min_w_0()
			.min_h_0()
			.overflow_hidden()
			.child(self.first);
		let second = div()
			.flex_1()
			.min_w_0()
			.min_h_0()
			.overflow_hidden()
			.child(self.second);
		match axis {
			Axis::Horizontal => container
				.flex_row()
				.child(first.w(relative(self.ratio)).h_full())
				.child(handle)
				.child(second.h_full()),
			Axis::Vertical => container
				.flex_col()
				.child(first.h(relative(self.ratio)).w_full())
				.child(handle)
				.child(second.w_full()),
		}
	}
}
