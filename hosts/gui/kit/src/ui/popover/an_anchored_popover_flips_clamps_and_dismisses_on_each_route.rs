//! WHY. An anchored popover renders floating cards above other content. If
//! placement arithmetic does not flip when overflowing the window boundary,
//! cards render off-screen; if dismissal routes fail to close the popover or
//! return focus to the anchor, the UI locks keyboard navigation or accumulates
//! phantom open states.
//!
//! THE CLASS. Flips, edge clamping, focus containment/restoration, and
//! dismissal lifecycles across every side, alignment, and dismissal route.
//!
//! WHAT IT DOES NOT CATCH. GPU composite shader blending and platform window
//! manager window-level clipping.

use std::collections::HashSet;

use gpui::{Bounds, Point, Size, px};

use super::{
	placement::{Alignment, Side, compute_bounds, default_margin, default_offset},
	state::{DismissalRoute, PopoverState},
	view::AnchoredPopover,
};

#[test]
fn sweeps_every_side_and_alignment_forcing_flip_and_asserting_adjacency() {
	let window_size = Size { width: px(300.0), height: px(200.0) };
	let content_size = Size { width: px(120.0), height: px(80.0) };
	let margin = default_margin();
	let offset = default_offset();

	// Test each side positioned near its boundary to force a flip
	for side in Side::ALL {
		for alignment in Alignment::ALL {
			let anchor = match side {
				Side::Bottom => Bounds {
					origin: Point { x: px(100.0), y: px(150.0) },
					size:   Size { width: px(40.0), height: px(20.0) },
				},
				Side::Top => Bounds {
					origin: Point { x: px(100.0), y: px(20.0) },
					size:   Size { width: px(40.0), height: px(20.0) },
				},
				Side::Right => Bounds {
					origin: Point { x: px(220.0), y: px(80.0) },
					size:   Size { width: px(40.0), height: px(20.0) },
				},
				Side::Left => Bounds {
					origin: Point { x: px(20.0), y: px(80.0) },
					size:   Size { width: px(40.0), height: px(20.0) },
				},
			};

			let result =
				compute_bounds(anchor, content_size, window_size, side, alignment, offset, margin);

			assert!(
				result.flipped,
				"expected flip for side {side:?} alignment {alignment:?} near edge"
			);
			assert_eq!(result.side, side.opposite(), "expected side to flip to opposite for {side:?}");

			// Assert inside window
			assert!(
				result.bounds.origin.x >= margin,
				"x {} below margin {margin} for {side:?} {alignment:?}",
				result.bounds.origin.x
			);
			assert!(
				result.bounds.origin.y >= margin,
				"y {} below margin {margin} for {side:?} {alignment:?}",
				result.bounds.origin.y
			);
			assert!(
				result.bounds.right() <= window_size.width - margin + px(0.01),
				"right {} exceeds window width for {side:?} {alignment:?}",
				result.bounds.right()
			);
			assert!(
				result.bounds.bottom() <= window_size.height - margin + px(0.01),
				"bottom {} exceeds window height for {side:?} {alignment:?}",
				result.bounds.bottom()
			);

			// Assert adjacent to anchor
			assert!(
				result.is_adjacent_to_anchor(anchor, offset),
				"resulting bounds {:?} not adjacent to anchor {:?} for {side:?} {alignment:?}",
				result.bounds,
				anchor
			);
		}
	}
}

#[test]
fn sweeps_every_dismissal_route() {
	let mut seen_routes = HashSet::new();

	for route in DismissalRoute::ALL {
		seen_routes.insert(route);
		let mut state = PopoverState::new();

		let anchor = Bounds {
			origin: Point { x: px(50.0), y: px(50.0) },
			size:   Size { width: px(30.0), height: px(20.0) },
		};
		let popover = Bounds {
			origin: Point { x: px(50.0), y: px(80.0) },
			size:   Size { width: px(100.0), height: px(100.0) },
		};

		state.open_pure("popover-1", anchor, popover, false);
		assert!(state.is_open());
		assert_eq!(state.open_count(), 1);

		match route {
			DismissalRoute::OutsidePress => {
				let outside_point = Point { x: px(10.0), y: px(10.0) };
				let dismissed = state.handle_outside_press(outside_point, None, None);
				assert!(dismissed);
			},
			DismissalRoute::Escape => {
				let dismissed = state.handle_escape(None, None);
				assert!(dismissed);
			},
			DismissalRoute::AnchorGone => {
				let dismissed = state.handle_anchor_removed(None, None);
				assert!(dismissed);
			},
			DismissalRoute::ScrolledOutOfView => {
				let distant_viewport = Bounds {
					origin: Point { x: px(500.0), y: px(500.0) },
					size:   Size { width: px(200.0), height: px(200.0) },
				};
				let dismissed = state.handle_anchor_scrolled(distant_viewport, None, None);
				assert!(dismissed);
			},
			DismissalRoute::SecondPopoverOpened => {
				let second_anchor = Bounds {
					origin: Point { x: px(200.0), y: px(50.0) },
					size:   Size { width: px(30.0), height: px(20.0) },
				};
				let previous = state.open_pure("popover-2", second_anchor, popover, false);
				assert_eq!(previous, Some(DismissalRoute::SecondPopoverOpened));
				assert_eq!(state.active_id().map(|s| s.as_ref()), Some("popover-2"));
			},
		}

		if route != DismissalRoute::SecondPopoverOpened {
			assert!(!state.is_open());
			assert_eq!(state.open_count(), 0);
			assert_eq!(state.last_dismissal(), Some(route));
		}
	}

	assert_eq!(seen_routes.len(), DismissalRoute::ALL.len(), "not all dismissal routes swept");
}

#[test]
fn focus_containment_and_contentless_popover_behavior() {
	let mut state = PopoverState::new();
	let anchor = Bounds {
		origin: Point { x: px(50.0), y: px(50.0) },
		size:   Size { width: px(30.0), height: px(20.0) },
	};
	let popover = Bounds {
		origin: Point { x: px(50.0), y: px(80.0) },
		size:   Size { width: px(100.0), height: px(100.0) },
	};

	// A contentless popover has no controls
	state.open_pure("contentless", anchor, popover, false);
	assert!(state.is_open());
	// Tab handling returns false because no controls to cycle
	assert!(!state.handle_tab(true, None, None));
}

#[test]
fn bounds_clamp_and_overflow_scroll_when_taller_than_window() {
	let window_size = Size { width: px(400.0), height: px(300.0) };
	let tall_content = Size { width: px(200.0), height: px(600.0) };
	let anchor = Bounds {
		origin: Point { x: px(100.0), y: px(100.0) },
		size:   Size { width: px(50.0), height: px(30.0) },
	};
	let margin = default_margin();
	let offset = default_offset();

	let result = compute_bounds(
		anchor,
		tall_content,
		window_size,
		Side::Bottom,
		Alignment::Start,
		offset,
		margin,
	);

	assert!(result.clamped, "expected tall popover to be clamped");
	assert!(result.scroll_required, "expected scroll requirement for overflowing content");
	assert!(
		result.bounds.size.height <= window_size.height - margin * 2.0,
		"height {} exceeds available window height",
		result.bounds.size.height
	);
	assert!(result.bounds.origin.y >= margin, "y {} below margin {margin}", result.bounds.origin.y);
	assert!(
		result.bounds.bottom() <= window_size.height - margin,
		"bottom {} exceeds window height margin",
		result.bounds.bottom()
	);
}

#[test]
fn two_anchors_get_two_distinct_motion_tracks() {
	let popover_a = AnchoredPopover::new("anchor-row-a", true);
	let popover_b = AnchoredPopover::new("anchor-row-b", true);

	let key_a = popover_a.motion_owner();
	let key_b = popover_b.motion_owner();

	assert_ne!(key_a, key_b, "two popovers for different anchors must not share a motion track");

	let key_a_again = AnchoredPopover::new("anchor-row-a", false).motion_owner();
	assert_eq!(key_a, key_a_again, "same anchor id must produce stable motion track");
}
