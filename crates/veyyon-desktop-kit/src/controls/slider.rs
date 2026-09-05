//! Slider continuous value input primitive (§8.25).
//!
//! The pointer sets the value: a press on the track moves the thumb to the
//! press, and a drag that started on the slider follows the pointer until it
//! is released. Both resolve the value from the track's painted bounds, so the
//! thumb lands under the pointer at any width.

use std::{cell::Cell, rc::Rc, sync::Arc};

use veyyon_gpui::{
	App, Bounds, Context, ElementId, IntoElement, MouseButton, Pixels, Render, RenderOnce, Window,
	div, prelude::*, px, relative,
};

use crate::{
	state::InteractiveState,
	token_set::{ColorRole, RadiusStep, SpacingStep, TokenSet},
};

/// Continuous range slider primitive element.
#[derive(IntoElement)]
pub struct Slider {
	id:        Option<ElementId>,
	value:     f32,
	min:       f32,
	max:       f32,
	state:     InteractiveState,
	on_change: Option<Arc<dyn Fn(f32, &mut Window, &mut App) + Send + Sync + 'static>>,
}

/// The drag a slider starts; carries nothing, since the value is read from
/// the pointer's position over the track on every move.
struct SliderDrag;

/// What the pointer shows while a slider drag is in flight: nothing, because
/// the thumb itself follows the pointer.
struct SliderDragPreview;

impl Render for SliderDragPreview {
	fn render(&mut self, _window: &mut Window, _cx: &mut Context<Self>) -> impl IntoElement {
		div()
	}
}

impl Slider {
	/// Creates a slider with current value and bounds.
	#[must_use]
	pub fn new(value: f32, min: f32, max: f32) -> Self {
		Self { id: None, value, min, max, state: InteractiveState::default(), on_change: None }
	}

	/// Sets element ID.
	#[must_use]
	pub fn id(mut self, id: impl Into<ElementId>) -> Self {
		self.id = Some(id.into());
		self
	}

	/// Sets interactive state.
	#[must_use]
	pub const fn state(mut self, state: InteractiveState) -> Self {
		self.state = state;
		self
	}

	/// Sets value change callback.
	#[must_use]
	pub fn on_change(
		mut self,
		handler: impl Fn(f32, &mut Window, &mut App) + Send + Sync + 'static,
	) -> Self {
		self.on_change = Some(Arc::new(handler));
		self
	}
}

/// The value at horizontal position `x` over a track spanning `bounds`, for a
/// slider ranging `min..=max`.
fn value_at(min: f32, max: f32, x: Pixels, bounds: Bounds<Pixels>) -> f32 {
	let width = f32::from(bounds.size.width);
	if width <= 0.0 {
		return min;
	}
	let fraction = (f32::from(x - bounds.origin.x) / width).clamp(0.0, 1.0);
	(max - min).mul_add(fraction, min)
}

impl RenderOnce for Slider {
	fn render(self, _window: &mut Window, cx: &mut App) -> impl IntoElement {
		let resolved_tokens = TokenSet::for_app(cx);
		let tokens: &TokenSet = &resolved_tokens;

		let track_height = tokens.spacing(SpacingStep::S2);
		let thumb_size = tokens.spacing(SpacingStep::S6);
		let radius = tokens.radius(RadiusStep::Full);
		let span = self.max - self.min;
		let fraction = if span > 0.0 {
			((self.value - self.min) / span).clamp(0.0, 1.0)
		} else {
			0.0
		};
		let disabled = self.state == InteractiveState::Disabled;

		// The track is the hairline, the travelled part the accent, and the
		// thumb the foreground; nothing here is a neutral fill (§6.10). The
		// thumb is centred on the value by pulling back half its size.
		let track = div()
			.w_full()
			.h(track_height)
			.rounded(radius)
			.bg(tokens.color(ColorRole::Hairline))
			.child(
				div()
					.h_full()
					.rounded(radius)
					.bg(tokens.color(ColorRole::Accent))
					.w(relative(fraction)),
			);
		let thumb = div()
			.absolute()
			.top(px(0.0))
			.left(relative(fraction))
			.ml(-thumb_size / 2.0)
			.size(thumb_size)
			.rounded(radius)
			.bg(tokens.color(ColorRole::Foreground));

		// The track's painted bounds, taken at prepaint so a press in the same
		// frame resolves its value from where the track was drawn; a drag reads
		// the bounds the event carries instead. The listener attaches before
		// the id, since it is the plain div's.
		let track_bounds: Rc<Cell<Option<Bounds<Pixels>>>> = Rc::new(Cell::new(None));
		let seen = Rc::clone(&track_bounds);
		let id = self.id.unwrap_or_else(|| ElementId::from("slider"));
		let mut container = div()
			.on_children_prepainted(move |bounds, _window, _cx| {
				seen.set(bounds.first().copied());
			})
			.id(id)
			.relative()
			.w_full()
			.h(thumb_size)
			.flex()
			.items_center()
			.child(track)
			.child(thumb);

		if disabled {
			return container.opacity(0.4).cursor_not_allowed();
		}
		container = container.cursor_pointer();

		let Some(handler) = self.on_change else {
			return container;
		};
		let (min, max) = (self.min, self.max);
		let press_handler = Arc::clone(&handler);
		container
			.on_mouse_down(MouseButton::Left, move |event, window, cx| {
				if let Some(bounds) = track_bounds.get() {
					press_handler(value_at(min, max, event.position.x, bounds), window, cx);
				}
			})
			.on_drag(SliderDrag, |_, _, _, cx| cx.new(|_| SliderDragPreview))
			.on_drag_move::<SliderDrag>(move |event, window, cx| {
				handler(value_at(min, max, event.event.position.x, event.bounds), window, cx);
			})
	}
}
