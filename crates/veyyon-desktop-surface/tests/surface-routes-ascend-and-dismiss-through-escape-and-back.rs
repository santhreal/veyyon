//! WHY: Escape must ascend modal destinations even when their editors have
//! focus. This suite exercises keyboard navigation, draft retention, palette
//! selection, query editing and direct dismissal across every settings page.
//! It does not verify pointer hit targets, native focus or frame cadence.

use std::path::Path;

use strum::IntoEnumIterator;
use veyyon_desktop_kit::{load_bundled_theme, load_bundled_tokens};
use veyyon_desktop_scene::{
	HeadlessSession,
	headless::{Headless, RenderOptions, headless_context},
};
use veyyon_desktop_surface::{
	Keymap, Overlay, SettingsPage, ShellView, fixture, install_tokens, keymap::resolve_chord,
	navigation::SurfaceRoute,
};
use veyyon_gpui::{App, AppContext};

fn open_test_session(cx: &mut Headless) -> HeadlessSession<'_, ShellView> {
	let tokens = load_bundled_tokens().expect("tokens load");
	let theme = load_bundled_theme("dark").expect("theme loads");
	let options =
		RenderOptions { width: 1440, height: 900, scale_factor: 1.0, ..RenderOptions::default() };
	HeadlessSession::open(cx, &options, move |_window, app: &mut App| {
		let installed = install_tokens(app, &tokens, &theme, Path::new("surface"))
			.expect("tokens and theme install");
		app.bind_keys(Keymap::default().bindings());
		veyyon_desktop_kit::input::ensure_editor_bindings_registered(app);
		app.new(|_| ShellView::new(installed, fixture::populated()))
	})
	.expect("session opens")
}

fn assert_route(session: &mut HeadlessSession<'_, ShellView>, route: Option<SurfaceRoute>) {
	session
		.update(|view, _, _| {
			assert_eq!(view.state().overlay.as_ref().and_then(Overlay::route), route);
			if route.is_none() {
				assert!(view.state().overlay.is_none());
			}
		})
		.expect("route verified");
}

fn assert_draft(session: &mut HeadlessSession<'_, ShellView>, draft: &str) {
	session
		.update(|view, _, _| assert_eq!(view.composer_text(), draft))
		.expect("draft preserved");
}

fn navigate(session: &mut HeadlessSession<'_, ShellView>, route: SurfaceRoute) {
	session
		.update(|view, _, cx| view.navigate_surface(route, cx))
		.expect("navigate to surface");
	session.frame().expect("surface renders");
	assert_route(session, Some(route));
}

fn open_commands(session: &mut HeadlessSession<'_, ShellView>, draft: &str) {
	session
		.update(|view, _, cx| view.set_composed(draft, cx))
		.expect("set draft");
	session.frame().expect("initial frame renders");
	assert!(
		session
			.keystroke(&resolve_chord("primary-k"))
			.expect("open commands")
	);
	session.frame().expect("commands render");
	assert_route(session, Some(SurfaceRoute::Commands));
}

fn escape_to(session: &mut HeadlessSession<'_, ShellView>, route: Option<SurfaceRoute>) {
	assert!(session.keystroke("escape").expect("Escape dispatches"));
	session.frame().expect("frame after Escape");
	assert_route(session, route);
}

#[test]
fn general_page_opened_via_keystrokes_ascends_and_dismisses_via_escape() {
	let mut cx = headless_context().expect("headless context available");
	let mut session = open_test_session(&mut cx);
	let draft = "Draft before keystroke navigation";
	open_commands(&mut session, draft);
	session.type_text("settings").expect("type settings query");
	session.frame().expect("filtered commands render");
	session
		.update(|view, _, _| {
			let palette = view.state().overlay_palette().expect("palette active");
			assert_eq!(palette.query, "settings");
			assert_eq!(palette.filtered_items()[0].title, "/settings");
		})
		.expect("settings command selected");

	for route in [SurfaceRoute::Settings, SurfaceRoute::Page(SettingsPage::General)] {
		session
			.keystroke("enter")
			.expect("enter selected destination");
		session.frame().expect("destination renders");
		assert_route(&mut session, Some(route));
	}
	for route in [Some(SurfaceRoute::Settings), Some(SurfaceRoute::Commands), None] {
		escape_to(&mut session, route);
	}
	assert_draft(&mut session, draft);
}

#[test]
fn general_page_escape_sequence_ascends_to_settings_commands_and_dismisses_to_composer() {
	let mut cx = headless_context().expect("headless context available");
	let mut session = open_test_session(&mut cx);
	let draft = "Draft before overlay navigation";
	open_commands(&mut session, draft);
	navigate(&mut session, SurfaceRoute::Settings);
	navigate(&mut session, SurfaceRoute::Page(SettingsPage::General));
	for route in [Some(SurfaceRoute::Settings), Some(SurfaceRoute::Commands), None] {
		escape_to(&mut session, route);
	}
	assert_draft(&mut session, draft);
}

#[test]
fn every_surface_route_page_ascends_via_escape_and_preserves_draft() {
	for page in SettingsPage::iter() {
		let mut cx = headless_context().expect("headless context available");
		let mut session = open_test_session(&mut cx);
		let route = SurfaceRoute::Page(page);
		let parent = route.parent().expect("page has parent");
		let draft = "Persisted draft text";
		open_commands(&mut session, draft);
		if parent != SurfaceRoute::Commands {
			navigate(&mut session, parent);
		}
		navigate(&mut session, route);
		escape_to(&mut session, Some(parent));
		session
			.update(|view, _, cx| view.close_palette(cx))
			.expect("close palette");
		session.frame().expect("frame after close");
		assert_route(&mut session, None);
		assert_draft(&mut session, draft);
	}
}

#[test]
fn close_palette_dismisses_directly_from_every_settings_page() {
	for page in SettingsPage::iter() {
		let mut cx = headless_context().expect("headless context available");
		let mut session = open_test_session(&mut cx);
		let draft = "Draft for close test";
		session
			.update(|view, _, cx| view.set_composed(draft, cx))
			.expect("set draft");
		navigate(&mut session, SurfaceRoute::Page(page));
		session
			.update(|view, _, cx| view.close_palette(cx))
			.expect("close palette");
		session.frame().expect("closed frame renders");
		assert_route(&mut session, None);
		assert_draft(&mut session, draft);
	}
}

#[test]
fn palette_selection_moves_via_up_and_down_arrows_through_focused_editor() {
	let mut cx = headless_context().expect("headless context available");
	let mut session = open_test_session(&mut cx);
	open_commands(&mut session, "");
	session
		.update(|view, _, _| {
			assert_eq!(
				view
					.state()
					.overlay_palette()
					.expect("palette active")
					.selected,
				0
			);
		})
		.expect("initial selection verified");
	for (key, selected) in [("down", 1), ("down", 2), ("up", 1)] {
		session.keystroke(key).expect("selection keystroke");
		session.frame().expect("selection renders");
		session
			.update(|view, _, _| {
				assert_eq!(
					view
						.state()
						.overlay_palette()
						.expect("palette active")
						.selected,
					selected
				);
			})
			.expect("selection verified");
	}
}

#[test]
fn palette_empty_query_backspace_ascends_while_nonempty_query_backspace_deletes_text() {
	let mut cx = headless_context().expect("headless context available");
	let mut session = open_test_session(&mut cx);
	open_commands(&mut session, "");
	navigate(&mut session, SurfaceRoute::Settings);
	session.type_text("gen").expect("type query");
	session.frame().expect("query renders");
	session
		.update(|view, _, _| {
			assert_eq!(
				view
					.state()
					.overlay_palette()
					.expect("palette active")
					.query,
				"gen"
			);
		})
		.expect("typed query verified");

	for query in ["ge", "g", ""] {
		session
			.keystroke("backspace")
			.expect("delete query character");
		session.frame().expect("edited query renders");
		assert_route(&mut session, Some(SurfaceRoute::Settings));
		session
			.update(|view, _, _| {
				assert_eq!(
					view
						.state()
						.overlay_palette()
						.expect("palette active")
						.query,
					query
				);
			})
			.expect("edited query verified");
	}
	for route in [Some(SurfaceRoute::Commands), None] {
		session
			.keystroke("backspace")
			.expect("empty query Backspace");
		session.frame().expect("frame after empty query Backspace");
		assert_route(&mut session, route);
	}
}
