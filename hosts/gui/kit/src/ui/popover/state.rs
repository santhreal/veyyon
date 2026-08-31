//! Dismissal lifecycle, focus containment, and single-popover state management.
//!
//! Enforces that at most one popover is open in the window at a time, returns
//! focus to the anchor upon dismissal if controls were contained, and handles
//! all dismissal routes.

use gpui::{App, Bounds, Pixels, Point, SharedString, Window};

use crate::ui::focus::FocusScope;

/// Every route through which an open popover can be dismissed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum DismissalRoute {
	OutsidePress,
	Escape,
	AnchorGone,
	ScrolledOutOfView,
	SecondPopoverOpened,
}

impl DismissalRoute {
	/// Every dismissal route, swept by tests at run time.
	pub const ALL: [DismissalRoute; 5] = [
		DismissalRoute::OutsidePress,
		DismissalRoute::Escape,
		DismissalRoute::AnchorGone,
		DismissalRoute::ScrolledOutOfView,
		DismissalRoute::SecondPopoverOpened,
	];

	/// The name of this dismissal route.
	pub const fn name(self) -> &'static str {
		match self {
			Self::OutsidePress => "outside-press",
			Self::Escape => "escape",
			Self::AnchorGone => "anchor-gone",
			Self::ScrolledOutOfView => "scrolled-out-of-view",
			Self::SecondPopoverOpened => "second-popover-opened",
		}
	}
}

/// Request parameters to open a popover.
pub struct OpenPopover {
	pub id:             SharedString,
	pub anchor_bounds:  Bounds<Pixels>,
	pub popover_bounds: Bounds<Pixels>,
	pub has_controls:   bool,
	pub focus_scope:    Option<FocusScope>,
}

impl OpenPopover {
	pub fn new(
		id: impl Into<SharedString>,
		anchor_bounds: Bounds<Pixels>,
		popover_bounds: Bounds<Pixels>,
	) -> Self {
		Self { id: id.into(), anchor_bounds, popover_bounds, has_controls: false, focus_scope: None }
	}

	pub fn controls(mut self, has_controls: bool) -> Self {
		self.has_controls = has_controls;
		self
	}

	pub fn focus_scope(mut self, scope: FocusScope) -> Self {
		self.focus_scope = Some(scope);
		self.has_controls = true;
		self
	}
}

/// State tracking for active popovers within a window.
#[derive(Default)]
pub struct PopoverState {
	active_id:      Option<SharedString>,
	anchor_bounds:  Option<Bounds<Pixels>>,
	popover_bounds: Option<Bounds<Pixels>>,
	has_controls:   bool,
	focus_scope:    Option<FocusScope>,
	last_dismissal: Option<DismissalRoute>,
}

impl PopoverState {
	pub fn new() -> Self {
		Self::default()
	}

	/// Opens a popover. If one was already open, closes it with
	/// [`DismissalRoute::SecondPopoverOpened`].
	pub fn open(
		&mut self,
		req: OpenPopover,
		mut window: Option<&mut Window>,
		mut cx: Option<&mut App>,
	) -> Option<DismissalRoute> {
		let previous_dismissal = if self.is_open() {
			let previous_route = DismissalRoute::SecondPopoverOpened;
			if self.has_controls
				&& let (Some(scope), Some(w), Some(c)) =
					(&self.focus_scope, window.as_deref_mut(), cx.as_deref_mut())
			{
				scope.leave(w, c);
			}
			self.last_dismissal = Some(previous_route);
			Some(previous_route)
		} else {
			None
		};

		if req.has_controls
			&& let (Some(scope), Some(w), Some(c)) = (&req.focus_scope, window, cx)
		{
			scope.enter(w, c);
		}

		self.active_id = Some(req.id);
		self.anchor_bounds = Some(req.anchor_bounds);
		self.popover_bounds = Some(req.popover_bounds);
		self.has_controls = req.has_controls;
		self.focus_scope = req.focus_scope;
		self.last_dismissal = None;

		previous_dismissal
	}

	/// Dismisses the currently open popover via the given route.
	pub fn dismiss(
		&mut self,
		route: DismissalRoute,
		window: Option<&mut Window>,
		cx: Option<&mut App>,
	) -> bool {
		if !self.is_open() {
			return false;
		}

		if self.has_controls
			&& let (Some(scope), Some(w), Some(c)) = (&self.focus_scope, window, cx)
		{
			scope.leave(w, c);
		}

		self.active_id = None;
		self.anchor_bounds = None;
		self.popover_bounds = None;
		self.has_controls = false;
		self.focus_scope = None;
		self.last_dismissal = Some(route);
		true
	}

	/// Pure open helper without gpui window dependency.
	pub fn open_pure(
		&mut self,
		id: impl Into<SharedString>,
		anchor_bounds: Bounds<Pixels>,
		popover_bounds: Bounds<Pixels>,
		has_controls: bool,
	) -> Option<DismissalRoute> {
		let req = OpenPopover::new(id, anchor_bounds, popover_bounds).controls(has_controls);
		self.open(req, None, None)
	}

	/// Pure dismiss helper without gpui window dependency.
	pub fn dismiss_pure(&mut self, route: DismissalRoute) -> bool {
		self.dismiss(route, None, None)
	}

	/// Whether a popover is currently open.
	pub fn is_open(&self) -> bool {
		self.active_id.is_some()
	}

	/// The number of currently open popovers (0 or 1).
	pub fn open_count(&self) -> usize {
		if self.is_open() { 1 } else { 0 }
	}

	/// The identifier of the currently open popover.
	pub fn active_id(&self) -> Option<&SharedString> {
		self.active_id.as_ref()
	}

	/// The last recorded dismissal route.
	pub fn last_dismissal(&self) -> Option<DismissalRoute> {
		self.last_dismissal
	}

	/// Handles an Escape key press.
	pub fn handle_escape(&mut self, window: Option<&mut Window>, cx: Option<&mut App>) -> bool {
		if self.is_open() {
			self.dismiss(DismissalRoute::Escape, window, cx)
		} else {
			false
		}
	}

	/// Handles a pointer press anywhere in the window.
	pub fn handle_outside_press(
		&mut self,
		press_point: Point<Pixels>,
		window: Option<&mut Window>,
		cx: Option<&mut App>,
	) -> bool {
		let Some(bounds) = self.popover_bounds else {
			return false;
		};
		let inside_x = press_point.x >= bounds.origin.x && press_point.x <= bounds.right();
		let inside_y = press_point.y >= bounds.origin.y && press_point.y <= bounds.bottom();
		if !(inside_x && inside_y) {
			self.dismiss(DismissalRoute::OutsidePress, window, cx)
		} else {
			false
		}
	}

	/// Handles anchor scrolling relative to visible viewport bounds.
	pub fn handle_anchor_scrolled(
		&mut self,
		visible_viewport: Bounds<Pixels>,
		window: Option<&mut Window>,
		cx: Option<&mut App>,
	) -> bool {
		let Some(anchor) = self.anchor_bounds else {
			return false;
		};
		let overlaps_x =
			anchor.right() >= visible_viewport.origin.x && anchor.origin.x <= visible_viewport.right();
		let overlaps_y = anchor.bottom() >= visible_viewport.origin.y
			&& anchor.origin.y <= visible_viewport.bottom();
		if !(overlaps_x && overlaps_y) {
			self.dismiss(DismissalRoute::ScrolledOutOfView, window, cx)
		} else {
			false
		}
	}

	/// Handles anchor removal from the view tree.
	pub fn handle_anchor_removed(
		&mut self,
		window: Option<&mut Window>,
		cx: Option<&mut App>,
	) -> bool {
		if self.is_open() {
			self.dismiss(DismissalRoute::AnchorGone, window, cx)
		} else {
			false
		}
	}

	/// Handles Tab or Shift-Tab keyboard focus traversal.
	pub fn handle_tab(
		&self,
		forward: bool,
		mut window: Option<&mut Window>,
		mut cx: Option<&mut App>,
	) -> bool {
		if !self.is_open() || !self.has_controls {
			return false;
		}
		if let (Some(scope), Some(w), Some(c)) = (&self.focus_scope, &mut window, &mut cx) {
			scope.cycle(forward, w, c)
		} else {
			false
		}
	}
}
