//! Rendering and motion integration for anchored popovers.

use gpui::{
	AnyElement, App, Bounds, IntoElement, ParentElement, Pixels, RenderOnce, SharedString, Styled,
	Window, div, px,
};

use super::{
	placement::{Alignment, Side},
	state::DismissalRoute,
};
use crate::{
	motion::{MotionKey, OwnerNamespace, Property, RetainedKey, owner},
	paint,
	theme::{Theme, radius, space},
	ui::{Float, Floating, focus::FocusScope},
};

type DismissListener = Box<dyn Fn(DismissalRoute, &mut Window, &mut App) + 'static>;

/// An anchored floating popover container.
#[derive(IntoElement)]
pub struct AnchoredPopover {
	id:            SharedString,
	owner:         RetainedKey,
	open:          bool,
	anchor_bounds: Option<Bounds<Pixels>>,
	side:          Side,
	alignment:     Alignment,
	offset:        f32,
	has_controls:  bool,
	focus_scope:   Option<FocusScope>,
	children:      Vec<AnyElement>,
	on_dismiss:    Option<DismissListener>,
}

impl AnchoredPopover {
	/// Creates a new popover keyed by the given identifier.
	pub fn new(id: impl Into<SharedString>, open: bool) -> Self {
		let id = id.into();
		let owner = owner(OwnerNamespace::Kit, "popover", id.as_ref());
		Self {
			id,
			owner,
			open,
			anchor_bounds: None,
			side: Side::Bottom,
			alignment: Alignment::Start,
			offset: space::SNUG,
			has_controls: false,
			focus_scope: None,
			children: Vec::new(),
			on_dismiss: None,
		}
	}

	/// Sets a custom motion owner key.
	pub fn owner(mut self, owner: RetainedKey) -> Self {
		self.owner = owner;
		self
	}

	/// Sets the anchor bounds used for positioning.
	pub fn anchor_bounds(mut self, bounds: Bounds<Pixels>) -> Self {
		self.anchor_bounds = Some(bounds);
		self
	}

	/// Sets the preferred side.
	pub fn side(mut self, side: Side) -> Self {
		self.side = side;
		self
	}

	/// Sets the preferred transverse alignment.
	pub fn alignment(mut self, alignment: Alignment) -> Self {
		self.alignment = alignment;
		self
	}

	/// Sets the gap between anchor and popover.
	pub fn offset(mut self, offset: f32) -> Self {
		self.offset = offset;
		self
	}

	/// Flags whether this popover contains interactive controls.
	pub fn has_controls(mut self, has_controls: bool) -> Self {
		self.has_controls = has_controls;
		self
	}

	/// Supplies a focus scope for keyboard containment and restoration.
	pub fn focus_scope(mut self, scope: FocusScope) -> Self {
		self.focus_scope = Some(scope);
		self.has_controls = true;
		self
	}

	/// Registers a callback invoked upon dismissal.
	pub fn on_dismiss(
		mut self,
		listener: impl Fn(DismissalRoute, &mut Window, &mut App) + 'static,
	) -> Self {
		self.on_dismiss = Some(Box::new(listener));
		self
	}

	/// Returns the identifier.
	pub fn id(&self) -> &SharedString {
		&self.id
	}

	/// Returns the motion owner key.
	pub fn motion_owner(&self) -> RetainedKey {
		self.owner
	}
}

impl ParentElement for AnchoredPopover {
	fn extend(&mut self, items: impl IntoIterator<Item = AnyElement>) {
		self.children.extend(items);
	}
}

impl RenderOnce for AnchoredPopover {
	fn render(self, _window: &mut Window, cx: &mut App) -> impl IntoElement {
		if !self.open {
			return div().into_any_element();
		}

		let theme = Theme::get(cx);
		let opacity = paint::sample(cx, MotionKey::new(self.owner, Property::Opacity), 1.0);

		div()
			.opacity(opacity)
			.p(px(space::BASE))
			.floating(&theme, Float::Menu, radius::POPOVER)
			.overflow_hidden()
			.children(self.children)
			.into_any_element()
	}
}
