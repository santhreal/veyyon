//! WHY THIS SUITE EXISTS
//!
//! Patch P6 adds the backdrop material primitive (`backdrop_blur`,
//! `backdrop_saturation`, `backdrop_tint`): a dual-Kawase blur of what lies
//! beneath a quad, mixed with the quad's own fill, drawn beneath the quad's
//! border.
//!
//! A floating palette or dialog rendered with a blurred backdrop keeps a crisp
//! border, and that border and the blurred body do not change when a repaint
//! happens elsewhere in the window (a hover flip, a cursor blink, a status
//! update), because the material is composited from the frame beneath the
//! float and not from the region that changed.
//!
//! THE CLASS THIS CLOSES: the blurred backdrop bleeding over the border quad,
//! the border being blurred with the body, and a repaint outside the float
//! altering the float's pixels.
//!
//! WHAT IT DOES NOT CATCH: the blur kernel's exact weights, and a repaint that
//! overlaps the float, which is expected to change the blurred body.

use veyyon_desktop_scene::{HeadlessSession, RenderOptions, headless_context};
use veyyon_gpui::{
	App, AppContext, Context, IntoElement, ParentElement as _, Render, Styled as _, Window, div,
	hsla, px, rgb, white,
};

const WIDTH: usize = 200;
const WIDTH_PX: u32 = 200;

/// The blue block the float sits over: x 20..180, y 15..55.
const BLOCK: (f32, f32, f32, f32) = (20.0, 15.0, 160.0, 40.0);
/// The float: x 30..170, y 20..50, with a 2px white border.
const FLOAT: (f32, f32, f32, f32) = (30.0, 20.0, 140.0, 30.0);
/// The trigger that repaints: x 20..100, y 60..85, outside the float.
const TRIGGER: (f32, f32, f32, f32) = (20.0, 60.0, 80.0, 25.0);

struct BlurredFloatScene {
	trigger_hovered: bool,
}

fn placed(at: (f32, f32, f32, f32)) -> veyyon_gpui::Div {
	let (left, top, width, height) = at;
	div()
		.absolute()
		.left(px(left))
		.top(px(top))
		.w(px(width))
		.h(px(height))
}

impl Render for BlurredFloatScene {
	fn render(&mut self, _window: &mut Window, _cx: &mut Context<Self>) -> impl IntoElement {
		let trigger_fill = if self.trigger_hovered {
			rgb(0x22c5_5e)
		} else {
			rgb(0xef44_44)
		};
		div()
			.size_full()
			.bg(rgb(0x1010_18))
			.child(placed(BLOCK).bg(rgb(0x3b82_f6)).z_index(1))
			.child(
				placed(FLOAT)
					.border_2()
					.border_color(white())
					.backdrop_blur(px(15.0))
					.backdrop_saturation(1.2)
					.bg(hsla(0.0, 0.0, 0.0, 0.4))
					.z_index(2),
			)
			.child(placed(TRIGGER).bg(trigger_fill).z_index(3))
	}
}

fn sample_pixel(bytes: &[u8], x: usize, y: usize) -> (u8, u8, u8, u8) {
	let idx = (y * WIDTH + x) * 4;
	(bytes[idx], bytes[idx + 1], bytes[idx + 2], bytes[idx + 3])
}

/// The top border row (y = 20) and the left border column (x = 30), away from
/// the corners, plus one sample of the blurred body.
fn float_samples(bytes: &[u8]) -> Vec<((usize, usize), (u8, u8, u8, u8))> {
	let top = (40..160).map(|x| (x, 20));
	let left = (25..45).map(|y| (30, y));
	top.chain(left)
		.chain(std::iter::once((100, 35)))
		.map(|(x, y)| ((x, y), sample_pixel(bytes, x, y)))
		.collect()
}

#[test]
fn a_blurred_float_keeps_its_borders_across_a_repaint_elsewhere() {
	let mut cx = headless_context().expect("headless context");
	let options =
		RenderOptions { width: WIDTH_PX, height: 200, scale_factor: 1.0, ..Default::default() };

	let mut session = HeadlessSession::open(&mut cx, &options, |_window, app: &mut App| {
		app.new(|_| BlurredFloatScene { trigger_hovered: false })
	})
	.expect("open blurred float session");

	let frame1 = session.frame().expect("capture frame 1");
	let bytes1 = frame1.frame.as_bytes();

	let trigger1 = sample_pixel(bytes1, 60, 72);
	assert!(
		trigger1.0 > 200 && trigger1.1 < 100,
		"trigger is red before the flip, got {trigger1:?}"
	);

	// The border is drawn above the material: every border pixel is the border
	// colour, not a blur of the blue block beneath it.
	let samples1 = float_samples(bytes1);
	for ((x, y), pixel) in &samples1[..samples1.len() - 1] {
		assert!(
			pixel.0 >= 240 && pixel.1 >= 240 && pixel.2 >= 240,
			"border pixel at ({x}, {y}) is white above the blur, got {pixel:?}"
		);
	}

	// The body is the blue block seen through a 40% black tint: darker than the
	// block, still blue-dominant, and not the border colour.
	let (_, body1) = samples1[samples1.len() - 1];
	assert!(
		body1.2 > body1.0 && body1.2 > body1.1 && body1.2 < 230 && body1.0 < 120,
		"blurred body at (100, 35) is a tinted blue, got {body1:?}"
	);

	session
		.update(|view, _, cx| {
			view.trigger_hovered = true;
			cx.notify();
		})
		.expect("flip trigger hover");

	let frame2 = session.frame().expect("capture frame 2");
	let bytes2 = frame2.frame.as_bytes();

	let trigger2 = sample_pixel(bytes2, 60, 72);
	assert!(
		trigger2.1 > 150 && trigger2.0 < 100,
		"trigger is green after the flip, got {trigger2:?}"
	);

	let samples2 = float_samples(bytes2);
	assert_eq!(
		samples2, samples1,
		"the float's border and blurred body do not change across a repaint elsewhere"
	);
}
