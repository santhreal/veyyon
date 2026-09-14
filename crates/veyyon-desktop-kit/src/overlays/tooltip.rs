//! Tooltip wrapper primitive (§8.25).
//!
//! The tag stays unpainted until the pointer rests on the anchor, and it is
//! drawn on the deferred layer rather than beside the anchor: a row in a list
//! paints its own children before the next row paints its text, so a tag laid
//! out inside the row is covered by the row under it and clipped away by the
//! scroll container the row sits in. Layout is the anchor's alone — the tag
//! takes no space and moves nothing.

use std::{cell::Cell, panic::Location, rc::Rc};

use veyyon_gpui::{
	Anchor, AnyElement, App, AvailableSpace, Bounds, Element, ElementId, GlobalElementId, Hitbox,
	HitboxBehavior, InspectorElementId, IntoElement, LayoutId, MouseMoveEvent, Pixels, SharedString,
	Window, anchored, div, point, prelude::*, px,
};

use crate::token_set::{ColorRole, RadiusStep, SpacingStep, TextRamp, TokenSet};

/// The deferred layer the tag draws on. Above the surface that owns the anchor
/// and below a modal overlay, which opens its own layer.
const TAG_PRIORITY: usize = 1;

/// Whether the pointer was on the anchor when the last mouse event was
/// dispatched, carried across frames so the tag opens on the frame after the
/// pointer arrives and closes on the frame after it leaves.
type Hovered = Rc<Cell<bool>>;

/// Where the tag opens relative to its anchor.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum TooltipSide {
	/// Below the anchor, which is the room a row or a header has.
	#[default]
	Below,
	/// Above the anchor. A control at the bottom edge of the window has
	/// nothing below it: the composer's own row is the last thing drawn there,
	/// and a tag opening downwards lands under the attention strip.
	Above,
}

/// Which edge of the anchor the tag is aligned to.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum TooltipAlign {
	/// The tag's left edge meets the anchor's left edge.
	#[default]
	Start,
	/// The tag's right edge meets the anchor's right edge, for an anchor near
	/// the right edge of its column, where a tag running rightwards is clipped.
	End,
}

/// Floating tooltip indicator tag element.
pub struct Tooltip {
	text:   SharedString,
	anchor: AnyElement,
	key:    SharedString,
	side:   TooltipSide,
	align:  TooltipAlign,
	wrap:   Option<Pixels>,
}

impl Tooltip {
	/// Creates a tooltip with text content and anchor element. The text is the
	/// tooltip's identity, so two anchors carrying the same words open
	/// together unless one of them is `keyed`.
	#[must_use]
	pub fn new(text: impl Into<SharedString>, anchor: impl IntoElement) -> Self {
		let text = text.into();
		Self {
			key: text.clone(),
			text,
			anchor: anchor.into_any_element(),
			side: TooltipSide::Below,
			align: TooltipAlign::Start,
			wrap: None,
		}
	}

	/// Names the tooltip, for one whose text is shared with another anchor on
	/// the same surface: a row's description repeated down a page, or a
	/// control's reason repeated across a group of controls.
	#[must_use]
	pub fn keyed(mut self, key: impl Into<SharedString>) -> Self {
		self.key = key.into();
		self
	}

	/// Wraps the tag's text inside `max_width` instead of running it out on one
	/// line, for a tag carrying a sentence rather than a name.
	#[must_use]
	pub const fn wrapping(mut self, max_width: Pixels) -> Self {
		self.wrap = Some(max_width);
		self
	}

	/// Opens the tag above the anchor.
	#[must_use]
	pub const fn above(mut self) -> Self {
		self.side = TooltipSide::Above;
		self
	}

	/// Aligns the tag's right edge to the anchor's right edge.
	#[must_use]
	pub const fn aligned_end(mut self) -> Self {
		self.align = TooltipAlign::End;
		self
	}

	/// Builds the tag itself: a floating card carrying the text.
	fn tag(&self, tokens: &TokenSet) -> AnyElement {
		let tag = div()
			.bg(tokens.color(ColorRole::Float))
			.rounded(tokens.radius(RadiusStep::Sm))
			.border_1()
			.border_color(tokens.color(ColorRole::Hairline))
			.px(tokens.spacing(SpacingStep::S2))
			.py(tokens.spacing(SpacingStep::S1))
			.text_size(tokens.font_size(TextRamp::Small))
			.text_color(tokens.color(ColorRole::Foreground))
			.shadow_md();
		let tag = match self.wrap {
			Some(max_width) => tag.w(max_width),
			None => tag.whitespace_nowrap(),
		};
		tag.child(self.text.clone()).into_any_element()
	}

	/// The window point the tag hangs from, and the corner of the tag that
	/// meets it. A tag that would leave the window switches corners rather
	/// than being clipped, which is the anchored element's own fit mode.
	fn placement(
		&self,
		bounds: Bounds<Pixels>,
		gap: Pixels,
	) -> (veyyon_gpui::Point<Pixels>, Anchor) {
		match (self.side, self.align) {
			(TooltipSide::Below, TooltipAlign::Start) => {
				(point(bounds.left(), bounds.bottom() + gap), Anchor::TopLeft)
			},
			(TooltipSide::Below, TooltipAlign::End) => {
				(point(bounds.right(), bounds.bottom() + gap), Anchor::TopRight)
			},
			(TooltipSide::Above, TooltipAlign::Start) => {
				(point(bounds.left(), bounds.top() - gap), Anchor::BottomLeft)
			},
			(TooltipSide::Above, TooltipAlign::End) => {
				(point(bounds.right(), bounds.top() - gap), Anchor::BottomRight)
			},
		}
	}
}

impl Element for Tooltip {
	type PrepaintState = (Hitbox, Hovered);
	type RequestLayoutState = ();

	fn id(&self) -> Option<ElementId> {
		Some(ElementId::Name(self.key.clone()))
	}

	fn source_location(&self) -> Option<&'static Location<'static>> {
		None
	}

	fn request_layout(
		&mut self,
		_id: Option<&GlobalElementId>,
		_inspector_id: Option<&InspectorElementId>,
		window: &mut Window,
		cx: &mut App,
	) -> (LayoutId, Self::RequestLayoutState) {
		(self.anchor.request_layout(window, cx), ())
	}

	fn prepaint(
		&mut self,
		id: Option<&GlobalElementId>,
		_inspector_id: Option<&InspectorElementId>,
		bounds: Bounds<Pixels>,
		_request_layout: &mut Self::RequestLayoutState,
		window: &mut Window,
		cx: &mut App,
	) -> Self::PrepaintState {
		self.anchor.prepaint(window, cx);

		// The hitbox is the anchor's own rect, so the tag opens for the region
		// the operator can see, and an overlay drawn over the anchor takes the
		// hover with it rather than leaving a tag hanging over itself.
		let hitbox = window.insert_hitbox(bounds, HitboxBehavior::Normal);
		let hovered = match id {
			Some(id) => window.with_element_state::<Hovered, _>(id, |state, _window| {
				let hovered = state.unwrap_or_default();
				(hovered.clone(), hovered)
			}),
			None => Hovered::default(),
		};
		if !hovered.get() {
			return (hitbox, hovered);
		}

		let tokens = TokenSet::for_app(cx);
		let (position, corner) = self.placement(bounds, tokens.spacing(SpacingStep::S1));
		let mut tag = anchored()
			.position(position)
			.anchor(corner)
			.child(self.tag(&tokens))
			.into_any_element();
		// The deferred pipeline prepaints and paints what it is handed and
		// never lays it out, so the tag is measured here.
		tag.layout_as_root(AvailableSpace::min_size(), window, cx);
		window.defer_draw(tag, point(px(0.0), px(0.0)), TAG_PRIORITY, None);
		(hitbox, hovered)
	}

	fn paint(
		&mut self,
		_id: Option<&GlobalElementId>,
		_inspector_id: Option<&InspectorElementId>,
		_bounds: Bounds<Pixels>,
		_request_layout: &mut Self::RequestLayoutState,
		prepaint: &mut Self::PrepaintState,
		window: &mut Window,
		cx: &mut App,
	) {
		self.anchor.paint(window, cx);

		// The pointer's own position is read from the hit test, which is the
		// one place that knows what the frame drew over the anchor. A frame
		// resolves it during event dispatch and the next frame opens the tag,
		// which is how every hover style in the window is resolved.
		let (hitbox, hovered) = (prepaint.0.clone(), prepaint.1.clone());
		let view = window.current_view();
		window.on_mouse_event(move |_: &MouseMoveEvent, _phase, window, cx| {
			let is_hovered = hitbox.is_hovered(window);
			if is_hovered != hovered.get() {
				hovered.set(is_hovered);
				cx.notify(view);
			}
		});
	}
}

impl IntoElement for Tooltip {
	type Element = Self;

	fn into_element(self) -> Self::Element {
		self
	}
}
