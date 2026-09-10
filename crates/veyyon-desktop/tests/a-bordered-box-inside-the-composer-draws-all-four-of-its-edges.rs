//! WHY THIS SUITE EXISTS
//!
//! An attachment card drew as two horizontal rules and two short vertical
//! stubs: the arcs at its corners and the ends of all four edges were missing,
//! in the native window and in the offscreen renderer alike. The card asked for
//! a one pixel border on every side and the layout tree agreed it had one, so
//! every suite that reads requested geometry stayed green while the surface a
//! reviewer looks at was wrong.
//!
//! The cause was in the renderer: a border-only quad is split into four strips
//! so the transparent interior of a large outline is not shaded, and each strip
//! narrowed the quad's content mask to its own bounds while keeping that mask's
//! corner radii. Inside the composer float, which rounds its corners and clips
//! its content, every descendant inherited an eighteen pixel rounded mask, so
//! each strip was clipped by a corner the mask never reached.
//!
//! THE CLASS THIS CLOSES:
//! 1. A bordered box inside a rounded, clipped surface losing edges or corners
//!    in the raster while its layout box reports four sides.
//! 2. A renderer revision that reintroduces the defect: the pin moves, this
//!    suite goes red.
//! 3. A new bordered box added to the composer that draws the same way: the
//!    sweep reads the boxes out of the rendered scene, so it arrives covered.
//!
//! WHAT IT DOES NOT CATCH:
//! Bordered boxes outside the composer float, boxes whose border colour is
//! within the tolerance of what they sit on, and anything about the border's
//! colour being the intended one.

use std::path::PathBuf;

use veyyon_desktop::{
	AssetPaths, StartupBundle, load_startup_bundle,
	scene::{Assets, SceneWindow, matching},
};
use veyyon_desktop_scene::{
	Appearance, BoxBounds, LayoutBox, RenderOptions, RgbaColor, RgbaFrame, SceneRegistry,
	headless_context,
};

/// The scene the sweep reads: two attachment cards inside the composer float,
/// one of them refused and drawn in the accent, so both a hairline box and an
/// accent box are under a rounded clip.
const SCENE: &str = "composer/attachments";

/// How far each channel may sit from the authored border colour and still be
/// that border. A hairline is twenty per channel away from the ground it draws
/// on, so this admits the shader's rounding without admitting the ground.
const CHANNEL_TOLERANCE: i32 = 12;

/// The corner square an arc has to pass through, in pixels. The smallest radius
/// the composer authors is four, so an arc crosses this square on both axes.
const CORNER_PROBE: f32 = 6.0;

/// How many pixels carrying the border's ink a corner square must hold for its
/// arc to be drawn.
const CORNER_MIN_PIXELS: usize = 3;

/// How much of the border's ink a pixel must carry to count as part of an arc.
/// A one pixel arc is antialiased along its whole length, so a corner is read
/// by coverage rather than by the colour a straight edge lands on exactly.
const ARC_MIN_COVERAGE: f32 = 0.15;

fn startup_assets() -> StartupBundle {
	let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../crates/veyyon-desktop-tokens");
	load_startup_bundle(AssetPaths {
		tokens_dir: root.join("tokens"),
		themes_dir: root.join("themes"),
	})
	.expect("load startup bundle")
}

fn is_border(frame: &RgbaFrame, x: i32, y: i32, colour: RgbaColor) -> bool {
	if x < 0 || y < 0 {
		return false;
	}
	match frame.pixel(x as u32, y as u32) {
		Some(pixel) => {
			(i32::from(pixel.r) - i32::from(colour.r)).abs() <= CHANNEL_TOLERANCE
				&& (i32::from(pixel.g) - i32::from(colour.g)).abs() <= CHANNEL_TOLERANCE
				&& (i32::from(pixel.b) - i32::from(colour.b)).abs() <= CHANNEL_TOLERANCE
		},
		None => false,
	}
}

/// How much of the way from `ground` to `colour` the pixel at `x, y` sits,
/// measured on the channel the two differ by most.
fn ink_coverage(frame: &RgbaFrame, x: i32, y: i32, ground: RgbaColor, colour: RgbaColor) -> f32 {
	if x < 0 || y < 0 {
		return 0.0;
	}
	let Some(pixel) = frame.pixel(x as u32, y as u32) else {
		return 0.0;
	};
	let channels = [
		(f32::from(pixel.r), f32::from(ground.r), f32::from(colour.r)),
		(f32::from(pixel.g), f32::from(ground.g), f32::from(colour.g)),
		(f32::from(pixel.b), f32::from(ground.b), f32::from(colour.b)),
	];
	let Some(&(drawn, from, to)) =
		channels.iter().max_by(|a, b| (a.2 - a.1).abs().total_cmp(&(b.2 - b.1).abs()))
	else {
		return 0.0;
	};
	if (to - from).abs() < 1.0 {
		return 0.0;
	}
	((drawn - from) / (to - from)).clamp(0.0, 1.0)
}

/// Border pixels along one edge line, sampling the two device rows or columns
/// the edge can land on when its bound is fractional.
fn edge_pixels(frame: &RgbaFrame, bounds: BoxBounds, side: Side, colour: RgbaColor) -> usize {
	let (from, to) = match side {
		Side::Top | Side::Bottom => (bounds.left.ceil() as i32, bounds.right.floor() as i32),
		Side::Left | Side::Right => (bounds.top.ceil() as i32, bounds.bottom.floor() as i32),
	};
	(from..to)
		.filter(|along| {
			let (a, b) = match side {
				Side::Top => ((*along, bounds.top.floor() as i32), (*along, bounds.top as i32)),
				Side::Bottom => (
					(*along, bounds.bottom.floor() as i32 - 1),
					(*along, bounds.bottom.ceil() as i32 - 1),
				),
				Side::Left => ((bounds.left.floor() as i32, *along), (bounds.left as i32, *along)),
				Side::Right => (
					(bounds.right.floor() as i32 - 1, *along),
					(bounds.right.ceil() as i32 - 1, *along),
				),
			};
			is_border(frame, a.0, a.1, colour) || is_border(frame, b.0, b.1, colour)
		})
		.count()
}

#[derive(Copy, Clone, Debug)]
enum Side {
	Top,
	Bottom,
	Left,
	Right,
}

impl Side {
	fn extent(self, bounds: BoxBounds) -> f32 {
		match self {
			Side::Top | Side::Bottom => bounds.right - bounds.left,
			Side::Left | Side::Right => bounds.bottom - bounds.top,
		}
	}
}

/// Pixels carrying the border's ink inside the square at `origin`, against the
/// ground `ground`.
fn corner_pixels(
	frame: &RgbaFrame,
	origin: (f32, f32),
	ground: RgbaColor,
	colour: RgbaColor,
) -> usize {
	let mut found = 0;
	for y in origin.1.floor() as i32..(origin.1 + CORNER_PROBE).ceil() as i32 {
		for x in origin.0.floor() as i32..(origin.0 + CORNER_PROBE).ceil() as i32 {
			if ink_coverage(frame, x, y, ground, colour) >= ARC_MIN_COVERAGE {
				found += 1;
			}
		}
	}
	found
}

fn area(bounds: BoxBounds) -> f32 {
	(bounds.right - bounds.left).max(0.0) * (bounds.bottom - bounds.top).max(0.0)
}

fn contains(outer: BoxBounds, inner: BoxBounds) -> bool {
	inner.left >= outer.left
		&& inner.right <= outer.right
		&& inner.top >= outer.top
		&& inner.bottom <= outer.bottom
}

#[test]
fn every_bordered_box_inside_the_composer_float_draws_four_edges_and_four_corners() {
	let bundle = startup_assets();
	let mut cx = headless_context().expect("headless renderer must be available");
	let assets = Assets {
		tokens:       &bundle.tokens,
		theme:        &bundle.theme,
		surface_path: &bundle.surface_path,
	};
	let options = RenderOptions {
		width: 1180,
		height: 800,
		scale_factor: 1.0,
		appearance: Appearance::Dark,
		..RenderOptions::default()
	};
	let registry = SceneRegistry::new();
	let scenes = matching(&registry, SCENE).expect("the composer attachment scene is registered");
	let mut window = SceneWindow::open(&mut cx, &options).expect("open the scene window");
	let rendered = window.render(&assets, &scenes[0]).expect("the scene renders");
	let frame = &rendered.captured.frame;

	let bordered: Vec<&LayoutBox> =
		rendered.captured.layout.iter().filter(|spec| spec.border.is_some()).collect();
	// The float is the largest bordered box in the composer band; everything the
	// sweep reads is a box it clips.
	let float = bordered
		.iter()
		.filter(|spec| spec.bounds.top > options.height as f32 / 2.0)
		.max_by(|a, b| area(a.bounds).total_cmp(&area(b.bounds)))
		.expect("the composer float draws a bordered box");

	let inside: Vec<&&LayoutBox> = bordered
		.iter()
		.filter(|spec| spec.bounds != float.bounds && contains(float.bounds, spec.bounds))
		.collect();
	assert!(
		inside.len() >= 2,
		"the scene attaches two cards, so the float clips at least two bordered boxes, found {}",
		inside.len(),
	);

	for spec in inside {
		let bounds = spec.bounds;
		let colour = spec.border.expect("filtered on a border").color;
		// The ground the box draws on, read just outside its corner: the float's
		// own fill, which an arc's antialiasing is a blend of.
		let ground = frame
			.pixel((bounds.left as u32).saturating_sub(3), (bounds.top as u32).saturating_sub(3))
			.expect("the ground beside a clipped box is inside the frame");
		for side in [Side::Top, Side::Bottom, Side::Left, Side::Right] {
			let drawn = edge_pixels(frame, bounds, side, colour);
			let required = (side.extent(bounds) / 2.0).floor() as usize;
			assert!(
				drawn >= required,
				"the {side:?} edge of the box at {bounds:?} drew {drawn} of the {required} pixels \
				 its length requires: an edge clipped by a corner the mask never reached",
			);
		}
		for corner in [
			(bounds.left, bounds.top),
			(bounds.right - CORNER_PROBE, bounds.top),
			(bounds.left, bounds.bottom - CORNER_PROBE),
			(bounds.right - CORNER_PROBE, bounds.bottom - CORNER_PROBE),
		] {
			let drawn = corner_pixels(frame, corner, ground, colour);
			assert!(
				drawn >= CORNER_MIN_PIXELS,
				"the corner at {corner:?} of the box at {bounds:?} drew {drawn} border pixels, so \
				 its arc is missing",
			);
		}
	}
}
