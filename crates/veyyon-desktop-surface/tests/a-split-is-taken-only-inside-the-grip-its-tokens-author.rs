//! WHY: the splitter grip had two measures and one of them was a decoration.
//! `panels.chrome.resize_handle_hit_px` authored an 8px hit area, and the only
//! thing reading it was a dash the drawer chrome painted in the middle of its
//! tab row: an 8x1 mark with no listener, no cursor and nothing behind it, at
//! a height where the split is not. The grip the pointer had to catch was a
//! spacing step compiled into the kit primitive, agreeing with the authored 8
//! by coincidence of the scale. The hairline never changed under the pointer
//! either, so the one place an 8px target shows itself showed nothing. The
//! docked drawer then drew its own top border under the handle's line, so the
//! split read as two hairlines four pixels apart.
//!
//! THE CLASS THIS CLOSES: a split whose grip is not the measure its surface
//! tokens author, a grip that draws no response to being taken, an edge drawn
//! twice where one surface owns it, and a token whose only reader is a mark
//! that does nothing. Both splits the shell has are swept — the vertical
//! drawer split and the horizontal panel split — and each is checked against
//! the same token: the frame's own hit rect at the split's edge is exactly the
//! authored extent, a drag inside it moves that edge by the travel, the
//! hairline inside it is the accent while the pointer holds it and the
//! hairline colour before and after, the band above the drawer carries one
//! hairline row whether the drawer docks or overlays, and the chrome row the
//! dash was painted in carries no line at all. Editing `resize_handle_hit_px`
//! moves every assertion here. A third split added to the shell is not
//! covered, which is why the extent case asserts the set of grip-shaped hit
//! rects at each edge is exactly one.
//!
//! WHAT IT DOES NOT CATCH: whether 8px is the right target, which is a
//! judgement about pointing rather than about the frame, the cursor shape the
//! grip asks for, which the renderer resolves outside anything a frame
//! records, and the spring the split settles with on release (§7.1), which
//! the motion suite drives. The chrome row is swept for a run of the
//! hairline's own colour at least half a grip long, so a decoration returning
//! in another role, or shorter than 4px, reads as text antialiasing and
//! passes.

use veyyon_desktop_kit::ColorRole;
use veyyon_desktop_scene::headless::headless_context;
use veyyon_desktop_surface::damage::Region;
use veyyon_gpui::{Point, px};

#[path = "support/split-grip/mod.rs"]
#[allow(dead_code, reason = "this module uses a subset of the shared split helpers")]
mod split_grip;

use split_grip::{
	HEIGHT, NARROW, SHORT, TRAVEL, WIDTH, authored_chrome_row, authored_grip, band_above,
	docked_panel_width, in_grip, mid_x, near, nearest_row, open, pixel_at, region_box, role_bytes,
	rows_matching, runs_in,
};

#[test]
fn the_grip_at_each_split_is_the_hit_area_the_tokens_author() {
	let mut cx = headless_context().expect("a headless renderer is required to render the shell");
	let mut session = open(&mut cx, WIDTH, HEIGHT);
	let captured = session.frame().expect("a frame captures");
	let grip = authored_grip();
	let drawer = region_box(&mut session, Region::Drawer);
	let panel_edge = WIDTH - docked_panel_width();

	let near_drawer = near(&captured, f32::from(drawer.origin.y), |hit| {
		(
			f32::from(hit.origin.y) + f32::from(hit.size.height),
			f32::from(hit.size.width),
			f32::from(hit.size.height),
		)
	});

	// The drawer's grip is the full-width band whose bottom edge is the
	// drawer's top edge: a band taller than the token is a primitive keeping
	// its own measure, and a band that is not there is a split with no handle.
	let above_drawer: Vec<f32> = near_drawer
		.iter()
		.filter(|(bottom, width, _)| {
			(bottom - f32::from(drawer.origin.y)).abs() <= 1.0
				&& (width - f32::from(drawer.size.width)).abs() <= 1.0
		})
		.map(|(_, _, height)| *height)
		.collect();
	assert_eq!(
		above_drawer,
		vec![grip],
		"the hit rects ending at the drawer's {}px top edge and spanning its {}px width are \
		 {above_drawer:?}, not one band of the {grip}px the panels tokens author; the rects within \
		 24px of that edge, as (bottom, width, height), are {near_drawer:?}",
		f32::from(drawer.origin.y),
		f32::from(drawer.size.width)
	);

	// The panel's grip is the column-tall band starting at the panel's
	// declared leading edge, on the other axis of the same primitive.
	let near_panel = near(&captured, panel_edge, |hit| {
		(f32::from(hit.origin.x), f32::from(hit.size.width), f32::from(hit.size.height))
	});
	let at_panel_edge: Vec<f32> = near_panel
		.iter()
		.filter(|(left, _, height)| {
			(left - panel_edge).abs() <= 1.0 && *height >= f32::from(drawer.size.height)
		})
		.map(|(_, width, _)| *width)
		.collect();
	assert_eq!(
		at_panel_edge,
		vec![grip],
		"the column-tall hit rects at the panel's {panel_edge}px leading edge are \
		 {at_panel_edge:?}, not one band of the {grip}px the panels tokens author; the rects within \
		 24px of that edge, as (left, width, height), are {near_panel:?}"
	);
}

#[test]
fn a_drag_inside_the_grip_moves_the_edge_it_took_by_the_travel() {
	let mut cx = headless_context().expect("a headless renderer is required to render the shell");
	let mut session = open(&mut cx, WIDTH, HEIGHT);
	let grip = authored_grip();

	// The drawer grows upward, so its recorded top edge moves by the travel.
	let before = region_box(&mut session, Region::Drawer);
	let held = in_grip(mid_x(before), f32::from(before.origin.y), grip);
	session
		.drag(held, Point::new(held.x, held.y - px(TRAVEL)))
		.expect("the drawer drag dispatches");
	session
		.frame()
		.expect("the frame after the drawer drag renders");
	let after = region_box(&mut session, Region::Drawer);
	let moved = f32::from(before.origin.y) - f32::from(after.origin.y);
	assert!(
		(moved - TRAVEL).abs() <= 1.0,
		"a {TRAVEL}px drag of the drawer's grip moved its top edge {moved}px, from {}px to {}px",
		f32::from(before.origin.y),
		f32::from(after.origin.y)
	);

	// The panel widens leftward from the same primitive on the other axis.
	let panel_before = region_box(&mut session, Region::Panel);
	let edge = f32::from(panel_before.origin.x) - grip;
	let handle = Point::new(px(edge + grip / 2.0), px(HEIGHT / 2.0));
	session
		.drag(handle, Point::new(handle.x - px(TRAVEL), handle.y))
		.expect("the panel drag dispatches");
	session
		.frame()
		.expect("the frame after the panel drag renders");
	let panel_after = region_box(&mut session, Region::Panel);
	let panel_moved = f32::from(panel_before.origin.x) - f32::from(panel_after.origin.x);
	assert!(
		(panel_moved - TRAVEL).abs() <= 1.0,
		"a {TRAVEL}px drag of the panel's grip moved its leading edge {panel_moved}px, from {}px to \
		 {}px",
		f32::from(panel_before.origin.x),
		f32::from(panel_after.origin.x)
	);
}

#[test]
fn the_drawer_draws_one_edge_above_itself_wherever_it_is_placed() {
	let mut cx = headless_context().expect("a headless renderer is required to render the shell");
	let hairline = role_bytes(ColorRole::Hairline);
	let grip = authored_grip();

	// Docked, the split's handle draws the edge. A drawer that also draws its
	// own border puts a second hairline a grip's half-height under the first.
	let mut docked = open(&mut cx, WIDTH, HEIGHT);
	let captured = docked.frame().expect("the docked frame captures");
	let drawer = region_box(&mut docked, Region::Drawer);
	let x = mid_x(drawer);
	let top = f32::from(drawer.origin.y);
	let edges = rows_matching(&captured.frame, x, band_above(top, grip), hairline, 24);
	assert_eq!(
		edges.len(),
		1,
		"the {grip}px band above the docked drawer's {top}px edge draws hairline rows {edges:?}, \
		 not the one line the split's handle carries"
	);

	// The dash the chrome painted in its tab row was the token's only reader
	// and was nowhere near the split. It sat centred in whatever the tab strip
	// and the controls left of the row, which is at neither the row's middle
	// nor any column this test could name, so the whole interior of the row is
	// swept for a mark drawn in the line's own colour instead.
	let chrome = authored_chrome_row();
	let interior = (top + 1.0, top + chrome - 2.0);
	let across = (
		f32::from(drawer.origin.x) + 1.0,
		f32::from(drawer.origin.x) + f32::from(drawer.size.width) - 1.0,
	);
	let marks = runs_in(&captured.frame, across, interior, hairline, 12, (grip / 2.0) as u32);
	assert!(
		marks.is_empty(),
		"the drawer's {chrome}px chrome row draws the hairline in runs {marks:?}, as (row, first \
		 column, length), where the grip token's decorative {grip}px dash was"
	);
	drop(docked);

	// Overlaid, there is no split, so the drawer draws that edge itself.
	let mut overlaid = open(&mut cx, NARROW, SHORT);
	let captured = overlaid.frame().expect("the overlaid frame captures");
	let drawer = region_box(&mut overlaid, Region::Drawer);
	let x = mid_x(drawer);
	let top = f32::from(drawer.origin.y);
	let edges = rows_matching(&captured.frame, x, band_above(top, grip), hairline, 24);
	assert_eq!(
		edges.len(),
		1,
		"the {grip}px band above the overlaid drawer's {top}px edge draws hairline rows {edges:?}, \
		 not the one edge it owns where no handle draws one"
	);
}

#[test]
fn the_grip_line_is_the_accent_only_while_the_pointer_has_it() {
	let mut cx = headless_context().expect("a headless renderer is required to render the shell");
	let mut session = open(&mut cx, WIDTH, HEIGHT);
	let grip = authored_grip();
	let hairline = role_bytes(ColorRole::Hairline);
	let accent = role_bytes(ColorRole::Accent);
	let drawer = region_box(&mut session, Region::Drawer);
	let x = mid_x(drawer);
	let top = f32::from(drawer.origin.y);
	let band = (top - grip, top - 1.0);

	// At rest the line is the hairline, and the row it is on is where every
	// later sample is read: a tint that moved the line would be a different
	// defect from a tint that never arrives.
	let resting = session.frame().expect("the resting frame captures");
	let (row, off) = nearest_row(&resting.frame, x, band, hairline);
	assert!(
		off <= 24,
		"no row of the {grip}px grip band at {x}px is the hairline the tokens resolve; the nearest \
		 is row {row}, {off} off {hairline:?}"
	);
	let at_rest = pixel_at(&resting.frame, x, row);

	// A pointer inside the grip tints the line, which is the whole of what
	// the 8px target has to show for itself.
	session
		.hover(in_grip(x, top, grip))
		.expect("the hover dispatches");
	session
		.frame()
		.expect("the frame that registers the hover renders");
	let hovered = session.frame().expect("the hovered frame captures");
	let under_pointer = pixel_at(&hovered.frame, x, row);
	let off_accent = split_grip::off_by(under_pointer, accent);
	assert!(
		off_accent <= 24,
		"the pointer inside the grip left row {row} at {under_pointer:?}, {off_accent} off the \
		 {accent:?} the accent resolves; at rest it was {at_rest:?}"
	);

	// A drag holds the tint after the pointer has left the grip: the split is
	// still moving, so the line is still the one under the operator's hand.
	let took = in_grip(x, top, grip);
	let held_to = Point::new(took.x, took.y - px(TRAVEL));
	session
		.drag_and_hold(took, held_to)
		.expect("the held drag dispatches");
	let dragging = session.frame().expect("the mid-drag frame captures");
	let dragged = region_box(&mut session, Region::Drawer);
	let dragged_top = f32::from(dragged.origin.y);
	let (line_row, line_off) =
		nearest_row(&dragging.frame, x, (dragged_top - grip, dragged_top - 1.0), accent);
	assert!(
		line_off <= 24,
		"mid-drag no row of the grip band above the drawer's {dragged_top}px edge is the accent; \
		 the nearest is row {line_row}, {line_off} off {accent:?}"
	);
	session.release(held_to).expect("the release dispatches");

	// The pointer leaves, and the line is the hairline again.
	session
		.hover(Point::new(px(x), px(top / 2.0)))
		.expect("the hover away dispatches");
	session
		.frame()
		.expect("the frame that registers the pointer leaving renders");
	let settled = session.frame().expect("the settled frame captures");
	let after = region_box(&mut session, Region::Drawer);
	let after_top = f32::from(after.origin.y);
	let (rest_row, rest_off) =
		nearest_row(&settled.frame, x, (after_top - grip, after_top - 1.0), hairline);
	assert!(
		rest_off <= 24,
		"the pointer left the grip and no row of its band is the hairline again; the nearest is row \
		 {rest_row}, {rest_off} off {hairline:?}"
	);
}
