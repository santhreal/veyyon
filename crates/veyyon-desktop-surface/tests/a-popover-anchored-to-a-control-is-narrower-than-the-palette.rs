//! WHY: the composer's model catalogue and slash-command list are popovers
//! anchored to a control, and both drew at the centred palette's 576px width.
//! An anchored surface that wide covers the turn the operator is reading and
//! overhangs the composer it belongs to; §5.8 authors 384px for it.
//!
//! CLASS CLOSED: an anchored popover drawn at the centred palette's width, and
//! either width taken from a number written in the renderer rather than the
//! token file. Both arms read the drawn field rect out of the live window, so a
//! width that never reaches the frame fails here.
//!
//! NOT CAUGHT: how the popover is placed relative to its trigger, which the
//! pointer-reach suites own, and the clamp to a window narrower than the
//! authored width, which is asserted from the token rather than a 300px window.

#[path = "support/large_queue.rs"]
mod large_queue;
#[allow(dead_code, reason = "this binary uses a subset of the shared session helpers")]
#[path = "support/queue-scroll/mod.rs"]
mod queue_scroll;

use large_queue::make_large_queue_state;
use queue_scroll::open_session;
use veyyon_desktop_kit::load_bundled_tokens;
use veyyon_desktop_scene::headless::headless_context;

const WIDTH: u32 = 1200;
const HEIGHT: u32 = 800;

/// The width of the search field the open palette drew, which spans the
/// surface's inner width and so states the width the surface took.
fn field_width(anchored: bool) -> f32 {
	let mut cx = headless_context().expect("a headless renderer is required");
	let mut session = open_session(&mut cx, make_large_queue_state(), WIDTH, HEIGHT);
	session.frame().expect("the shell draws its first frame");
	let editor = session
		.update(|view, window, cx| {
			if anchored {
				view.open_model_picker(window, cx);
			} else {
				view.open_command_palette(window, cx);
			}
			view.palette_editor()
		})
		.expect("the view opens the palette")
		.expect("the palette draws a search field");
	session.frame().expect("the open palette draws a frame");
	session
		.update(|_view, _window, cx| {
			f32::from(
				editor
					.read(cx)
					.drawn_bounds()
					.expect("the palette's field drew a rect")
					.size
					.width,
			)
		})
		.expect("the field's rect is read out of the editor")
}

#[test]
fn the_anchored_popover_is_the_authored_width_narrower_than_the_centred_palette() {
	let tokens = load_bundled_tokens().expect("the bundled tokens load");
	let palette = &tokens.surface.palette;
	assert!(
		palette.anchored_width_px < palette.width_px,
		"the tokens author an anchored width of {} against a palette width of {}",
		palette.anchored_width_px,
		palette.width_px
	);

	let anchored = field_width(true);
	let centred = field_width(false);
	assert_eq!(
		centred - anchored,
		palette.width_px - palette.anchored_width_px,
		"the anchored popover drew {anchored} and the centred palette {centred}, so one of them \
		 does not take its width from the tokens"
	);
	assert!(
		anchored <= palette.anchored_width_px,
		"the anchored popover's field is {anchored} wide inside a {} surface",
		palette.anchored_width_px
	);
}
