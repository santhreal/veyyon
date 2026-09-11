//! Popover floating container primitive (§8.25).
//!
//! The container is drawn through GPUI's `anchored` element inside a
//! `deferred` layer, so it floats above the surface that opened it and sits at
//! the window-space origin the caller measured.
//!
//! A popover that states the size it may take is flipped to the opposite
//! corner when the corner it was asked for would take it past a window edge.
//! The corner is decided here, where the size the caller declared is known
//! before layout, and the renderer's own fit is left as the slide it always
//! is: a card the flip could not place has nowhere to go that does not
//! overflow, and one the flip placed is already inside the margin, so the
//! slide never moves it.

use std::rc::Rc;

use veyyon_desktop_motion::FloatFrame;
use veyyon_gpui::{
	Anchor, AnyElement, App, FocusHandle, IntoElement, MouseButton, MouseDownEvent, Pixels, Point,
	RenderOnce, SharedString, Size, Window, anchored, deferred, div, prelude::*, px,
};

use crate::{
	geometry::{AnchorCorner, flip_corner},
	token_set::{ColorRole, RadiusStep, SpacingStep, TokenSet},
};

/// Maps a kit anchor corner onto the renderer's anchor.
const fn renderer_anchor(corner: AnchorCorner) -> Anchor {
	match corner {
		AnchorCorner::TopLeft => Anchor::TopLeft,
		AnchorCorner::TopRight => Anchor::TopRight,
		AnchorCorner::BottomLeft => Anchor::BottomLeft,
		AnchorCorner::BottomRight => Anchor::BottomRight,
	}
}

/// Anchored floating popover container with elevation level 4 glass styling.
#[derive(IntoElement)]
pub struct Popover {
	origin:     Point<Pixels>,
	anchor:     AnchorCorner,
	id:         Option<SharedString>,
	size:       Option<Size<Pixels>>,
	entrance:   Option<FloatFrame>,
	focus:      Option<FocusHandle>,
	on_dismiss: Option<Rc<dyn Fn(&mut Window, &mut App)>>,
	child:      AnyElement,
}

impl Popover {
	/// Creates a popover with origin point and anchor corner.
	#[must_use]
	pub fn new(origin: Point<Pixels>, anchor: AnchorCorner, child: impl IntoElement) -> Self {
		Self {
			origin,
			anchor,
			id: None,
			size: None,
			entrance: None,
			focus: None,
			on_dismiss: None,
			child: child.into_any_element(),
		}
	}

	/// Returns anchor origin point.
	#[must_use]
	pub fn origin(&self) -> Point<Pixels> {
		self.origin
	}

	/// Returns anchor corner.
	#[must_use]
	pub fn anchor(&self) -> AnchorCorner {
		self.anchor
	}

	/// Names the element, which is what a press outside it is reported
	/// against. A popover that answers a dismissal needs one.
	#[must_use]
	pub fn id(mut self, id: impl Into<SharedString>) -> Self {
		self.id = Some(id.into());
		self
	}

	/// States the box the popover may take, which is the size its corner is
	/// chosen against and the ceiling its content is drawn inside.
	#[must_use]
	pub fn size(mut self, size: Size<Pixels>) -> Self {
		self.size = Some(size);
		self
	}

	/// Draws the card at the point the float track resolved, so the whole
	/// surface arrives rather than its content arriving inside a card that was
	/// already there.
	#[must_use]
	pub const fn entrance(mut self, frame: FloatFrame) -> Self {
		self.entrance = Some(frame);
		self
	}

	/// Holds the window's focus while the popover is drawn, so the keystrokes
	/// the surface underneath would answer do not reach it.
	#[must_use]
	pub fn focus(mut self, focus: &FocusHandle) -> Self {
		self.focus = Some(focus.clone());
		self
	}

	/// Answers a press that lands outside the popover.
	#[must_use]
	pub fn on_dismiss(mut self, handler: impl Fn(&mut Window, &mut App) + 'static) -> Self {
		self.on_dismiss = Some(Rc::new(handler));
		self
	}
}

impl RenderOnce for Popover {
	fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
		let resolved_tokens = TokenSet::for_app(cx);
		let tokens: &TokenSet = &resolved_tokens;

		let bg = tokens.color(ColorRole::Float);
		let border_color = tokens.color(ColorRole::Hairline);
		let radius = tokens.radius(RadiusStep::Xl);
		let pad = tokens.spacing(SpacingStep::S4);
		let margin = tokens.spacing(SpacingStep::S2);

		// The corner is chosen against the size the caller declared, which is
		// a ceiling the drawn card is no larger than: a card the flip placed
		// is inside the margin already, so the slide under it is the backstop
		// for the one case the flip cannot answer, a card too large for either
		// side of its origin.
		let anchor = self.size.map_or(self.anchor, |size| {
			flip_corner(self.anchor, self.origin, size, window.viewport_size(), margin)
		});

		let mut card = div()
			.occlude()
			.bg(bg)
			.rounded(radius)
			.border_1()
			.border_color(border_color)
			.p(pad)
			.shadow_lg()
			.child(div().min_w_0().overflow_hidden().child(self.child));
		if let Some(size) = self.size {
			card = card.max_w(size.width).max_h(size.height);
		}
		// The whole card carries the entrance, content and ground together: a
		// transition on the content alone draws a card that was already there
		// with its facts arriving inside it.
		if let Some(frame) = self.entrance {
			card = card.opacity(frame.opacity).translate_y(px(frame.offset_y));
		}
		if let Some(focus) = &self.focus {
			card = card.track_focus(focus);
		}
		// The press is reported against the card's own rect, so the element
		// that answers an outside press is the card and not a wrapper around
		// it, whose bounds a deferred layer does not share.
		let mut card = card.id(
			self
				.id
				.unwrap_or_else(|| SharedString::new_static("popover")),
		);
		if let Some(handler) = self.on_dismiss {
			card = card.on_mouse_down_out(move |event: &MouseDownEvent, window, app| {
				if event.button == MouseButton::Left {
					handler(window, app);
				}
			});
		}

		let floating = anchored()
			.position(self.origin)
			.anchor(renderer_anchor(anchor))
			.snap_to_window_with_margin(margin);
		deferred(floating.child(card)).with_priority(1)
	}
}
