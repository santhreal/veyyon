//! The elements the driver draws: a target wrapper that records its child's
//! bounds, and a probe that reports each painted frame.

use gpui::{
	AnyElement, App, Bounds, Element, ElementId, GlobalElementId, InspectorElementId, IntoElement,
	LayoutId, Pixels, Position, SharedString, Style, Window,
};

use super::{Targets, frame_painted};

/// A pass-through wrapper recording its child's window bounds under `id`.
pub(super) struct Target {
	id:    SharedString,
	child: AnyElement,
}

impl Target {
	pub(super) const fn new(id: SharedString, child: AnyElement) -> Self {
		Self { id, child }
	}
}

impl IntoElement for Target {
	type Element = Self;

	fn into_element(self) -> Self::Element {
		self
	}
}

impl Element for Target {
	type PrepaintState = ();
	type RequestLayoutState = ();

	fn id(&self) -> Option<ElementId> {
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
		(self.child.request_layout(window, cx), ())
	}

	fn prepaint(
		&mut self,
		_: Option<&GlobalElementId>,
		_: Option<&InspectorElementId>,
		bounds: Bounds<Pixels>,
		(): &mut Self::RequestLayoutState,
		window: &mut Window,
		cx: &mut App,
	) -> Self::PrepaintState {
		Targets::record(cx, window.window_handle().window_id(), self.id.clone(), bounds);
		self.child.prepaint(window, cx);
	}

	fn paint(
		&mut self,
		_: Option<&GlobalElementId>,
		_: Option<&InspectorElementId>,
		_: Bounds<Pixels>,
		(): &mut Self::RequestLayoutState,
		(): &mut Self::PrepaintState,
		window: &mut Window,
		cx: &mut App,
	) {
		self.child.paint(window, cx);
	}
}

/// A zero-size element the workspace paints last in every frame; when the
/// driver is on it reports the frame to the subscribed clients.
#[derive(Default)]
pub struct FrameProbe;

impl IntoElement for FrameProbe {
	type Element = Self;

	fn into_element(self) -> Self::Element {
		self
	}
}

impl Element for FrameProbe {
	type PrepaintState = ();
	type RequestLayoutState = ();

	fn id(&self) -> Option<ElementId> {
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
		let style = Style { position: Position::Absolute, ..Style::default() };
		(window.request_layout(style, [], cx), ())
	}

	fn prepaint(
		&mut self,
		_: Option<&GlobalElementId>,
		_: Option<&InspectorElementId>,
		_: Bounds<Pixels>,
		(): &mut Self::RequestLayoutState,
		_: &mut Window,
		_: &mut App,
	) -> Self::PrepaintState {
	}

	fn paint(
		&mut self,
		_: Option<&GlobalElementId>,
		_: Option<&InspectorElementId>,
		_: Bounds<Pixels>,
		(): &mut Self::RequestLayoutState,
		(): &mut Self::PrepaintState,
		_: &mut Window,
		cx: &mut App,
	) {
		frame_painted(cx);
	}
}
