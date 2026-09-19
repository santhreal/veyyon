//! WHY: the editor the titlebar opens over a session's name was capped at
//! `320.0` written into the render, beside a titlebar whose height, control
//! size, gap and insets all come from `surface/shell.toml`. §9.3 rests the
//! iteration loop on a visual measure being authored in a token file and read
//! from it: one compiled in is invisible to a sweep of the file, agrees with
//! the authored number only by luck, and drifts from it silently.
//!
//! CLASS CLOSED: the rename field sized by anything but its token. The arms
//! render the field the way an operator reaches it -- the editor the titlebar
//! retained, focused, which is the only state that draws it -- once at the
//! shipped value and once at a value chosen here, and read the box back out of
//! the frame. A number restored to the render fails the second arm.
//!
//! Held shut against: a literal returning to the cap; a cap read from the
//! window or the titlebar's own width, which would follow neither arm; and a
//! field that stretches the centre column instead of capping, which draws
//! wider than either value.
//!
//! NOT CAUGHT: what the field commits, which
//! `the-titlebar-renames-the-session-it-is-naming` owns, and the titlebar's
//! other measures, which the shell token file states and the shell suites
//! read.

use std::path::Path;

use veyyon_desktop_kit::{load_bundled_theme, load_bundled_tokens};
use veyyon_desktop_scene::{
	BoxBounds, Captured, HeadlessSession, headless::RenderOptions, headless_context,
};
use veyyon_desktop_surface::{FieldKey, Keymap, ShellView, fixture, install_tokens};
use veyyon_desktop_tokens::Tokens;
use veyyon_gpui::{App, AppContext};

const WINDOW_W: u32 = 1440;
const WINDOW_H: u32 = 900;

/// A cap no shipped token file states, and narrower than the centre column at
/// this window width: an arm that draws it is reading the file.
const OTHER_RENAME_W: f32 = 236.0;

/// The frame the window draws with the titlebar's rename editor focused, which
/// is the state that draws the field at all.
fn frame_with_rename_field(tokens: Tokens) -> Captured {
	let theme = load_bundled_theme("dark").expect("the bundled dark theme loads");
	let options = RenderOptions {
		width: WINDOW_W,
		height: WINDOW_H,
		scale_factor: 1.0,
		..RenderOptions::default()
	};
	let mut cx = headless_context().expect("a headless renderer is required");
	let shell = fixture::populated();
	let row = shell.current_id;
	let mut session = HeadlessSession::open(&mut cx, &options, move |_window, app: &mut App| {
		let installed = install_tokens(app, &tokens, &theme, Path::new("surface"))
			.expect("the tokens and theme install");
		app.bind_keys(Keymap::default().bindings());
		veyyon_desktop_kit::input::ensure_editor_bindings_registered(app);
		app.new(|_| ShellView::new(installed, shell))
	})
	.expect("the window opens offscreen");
	session.frame().expect("the shell draws");
	let editor = session
		.update(|view, _window, _cx| view.retained_field(&FieldKey::SessionRename(row)))
		.expect("the titlebar's field is read back")
		.expect("the titlebar draws a field for the open session");
	session
		.update(|_view, window, cx| {
			let focus = editor.read(cx).focus_handle().clone();
			window.focus(&focus, cx);
		})
		.expect("the field takes the keyboard");
	session.frame().expect("the focused field draws")
}

/// The field's box: the widest painted box inside the titlebar band that does
/// not span the window.
///
/// The band's own ground and the drag region span it; every other control there
/// -- the two panel toggles, the menu items, the connection state -- is a
/// control-sized square or a short row, so the widest of them is the editor.
fn rename_field(frame: &Captured, titlebar_h: f32) -> BoxBounds {
	let window_w = WINDOW_W as f32;
	frame
		.layout
		.painted_boxes()
		.map(|painted| painted.bounds)
		.filter(|bounds| bounds.bottom <= titlebar_h + 1.0 && bounds.width() < window_w - 1.0)
		.max_by(|a, b| {
			a.width()
				.partial_cmp(&b.width())
				.unwrap_or(std::cmp::Ordering::Equal)
		})
		.unwrap_or_else(|| panic!("the focused titlebar draws no field inside its band"))
}

#[test]
fn the_rename_field_takes_the_cap_the_shell_tokens_author() {
	let shipped = load_bundled_tokens().expect("the bundled tokens load");
	let titlebar_h = shipped.surface.shell.titlebar_height_px;
	let authored = shipped.surface.shell.titlebar_rename_width_px;
	let drawn = rename_field(&frame_with_rename_field(shipped.clone()), titlebar_h);
	assert_eq!(drawn.width(), authored, "the rename field draws the cap its token states");

	let mut other = shipped;
	other.surface.shell.titlebar_rename_width_px = OTHER_RENAME_W;
	let moved = rename_field(&frame_with_rename_field(other), titlebar_h);
	assert_eq!(
		moved.width(),
		OTHER_RENAME_W,
		"editing the token file resizes the rename field, so its cap is not compiled in"
	);
}
