//! WHY: an operator names or renames an active session by double-clicking its
//! title in the window titlebar. If this interaction is unwired or ignores
//! the host's `RenameSession` capability gate, the rename state is unreachable
//! or attempts to rename when the host does not admit it.
//!
//! THE CLASS THIS CLOSES: titlebar interaction defects where pointer events
//! on session chrome fail to transition into the retained field editor or
//! bypass capability gate enforcement.
//!
//! WHAT IT DOES NOT CATCH: window manager titlebar dragging or native zoom
//! integration, which the platform manages outside the headless GPUI tree.

use std::path::Path;

use veyyon_desktop_model::{SessionId, SurfaceId};
use veyyon_desktop_scene::{RenderOptions, headless_context, session::HeadlessSession};
use veyyon_desktop_surface::{Availability, FieldKey, Keymap, ShellView, fixture, install_tokens};
use veyyon_desktop_tokens::{load_bundled_theme, load_bundled_tokens};
use veyyon_gpui::{App, AppContext, point, px};

const WINDOW_W: u32 = 1200;
const WINDOW_H: u32 = 800;

#[test]
fn double_clicking_titlebar_title_opens_rename_editor_prefilled() {
	let tokens = load_bundled_tokens().expect("tokens load");
	let theme = load_bundled_theme("dark").expect("theme loads");
	let options = RenderOptions {
		width: WINDOW_W,
		height: WINDOW_H,
		scale_factor: 1.0,
		..RenderOptions::default()
	};
	let mut cx = headless_context().expect("headless renderer");
	let mut shell = fixture::populated();
	shell.title = "My Project Alpha".into();
	let row = shell.current_id;

	let mut session = HeadlessSession::open(&mut cx, &options, move |_window, app: &mut App| {
		let installed =
			install_tokens(app, &tokens, &theme, Path::new("surface")).expect("tokens install");
		app.bind_keys(Keymap::default().bindings());
		veyyon_desktop_kit::input::ensure_editor_bindings_registered(app);
		app.new(|_| ShellView::new(installed, shell))
	})
	.expect("window opens offscreen");

	session.frame().expect("initial frame draws");

	// Before double click, the rename field is not focused.
	let is_focused_before = session
		.update(|view, window, cx| {
			view
				.retained_field(&FieldKey::SessionRename(row))
				.is_some_and(|ed| ed.read(cx).focus_handle().is_focused(window))
		})
		.expect("read field state");
	assert!(!is_focused_before, "field must not be focused before double click");

	session
		.double_click(point(px((WINDOW_W / 2) as f32), px(18.0)))
		.expect("double click lands");
	session.frame().expect("frame draws after double click");

	// After double click, the rename field is focused and prefilled with the
	// session title.
	let (is_focused_after, text) = session
		.update(|view, window, cx| {
			let ed = view
				.retained_field(&FieldKey::SessionRename(row))
				.expect("field editor must exist for open session");
			let focused = ed.read(cx).focus_handle().is_focused(window);
			let content = ed.read(cx).text().to_string();
			(focused, content)
		})
		.expect("read field state");

	assert!(is_focused_after, "field must be focused after double click");
	assert_eq!(text, "My Project Alpha", "editor must be prefilled with session title");
}

#[test]
fn double_clicking_titlebar_title_is_gated_by_capability() {
	let tokens = load_bundled_tokens().expect("tokens load");
	let theme = load_bundled_theme("dark").expect("theme loads");
	let options = RenderOptions {
		width: WINDOW_W,
		height: WINDOW_H,
		scale_factor: 1.0,
		..RenderOptions::default()
	};
	let mut cx = headless_context().expect("headless renderer");
	let mut shell = fixture::populated();
	shell.title = "Locked Session".into();
	let row = shell.current_id;

	// Gate RenameSession capability to Unavailable.
	shell.controls.set_availability(
		SurfaceId::SessionRenameField(SessionId(row.to_string())),
		Availability::Unavailable { reason: "host forbids renaming".into() },
	);

	let mut session = HeadlessSession::open(&mut cx, &options, move |_window, app: &mut App| {
		let installed =
			install_tokens(app, &tokens, &theme, Path::new("surface")).expect("tokens install");
		app.bind_keys(Keymap::default().bindings());
		veyyon_desktop_kit::input::ensure_editor_bindings_registered(app);
		app.new(|_| ShellView::new(installed, shell))
	})
	.expect("window opens offscreen");

	session.frame().expect("initial frame draws");

	session
		.double_click(point(px((WINDOW_W / 2) as f32), px(18.0)))
		.expect("double click lands");
	session.frame().expect("frame draws after double click");

	let is_focused = session
		.update(|view, window, cx| {
			view
				.retained_field(&FieldKey::SessionRename(row))
				.is_some_and(|ed| ed.read(cx).focus_handle().is_focused(window))
		})
		.expect("read field state");

	assert!(!is_focused, "field must not be focused when RenameSession capability is unavailable");
}
