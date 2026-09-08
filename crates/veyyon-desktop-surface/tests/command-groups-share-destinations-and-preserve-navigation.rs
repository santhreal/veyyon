//! WHY: command destinations previously opened unrelated flat settings pages
//! and relied on synthetic method calls rather than pointer hit targets.
//! This suite verifies pointer Back and Close interactions, nested editor
//! Escape consumption, parent query restoration, composer focus transitions,
//! and multiline draft preservation across Account, Settings, and Agents
//! routes.

use std::path::Path;

use strum::IntoEnumIterator;
use veyyon_desktop_kit::{load_bundled_theme, load_bundled_tokens};
use veyyon_desktop_scene::{
	HeadlessSession,
	headless::{Headless, RenderOptions, headless_context},
};
use veyyon_desktop_surface::{
	Intent, Keymap, Overlay, PaletteState, SettingsPage, ShellView, fixture, install_tokens,
	navigation::SurfaceRoute,
};
use veyyon_gpui::{App, AppContext, Bounds, Pixels, Point};

fn open_test_session(cx: &mut Headless, width: u32, height: u32) -> HeadlessSession<'_, ShellView> {
	let tokens = load_bundled_tokens().expect("bundled tokens load");
	let theme = load_bundled_theme("dark").expect("bundled dark theme loads");
	let options = RenderOptions { width, height, scale_factor: 1.0, ..RenderOptions::default() };
	HeadlessSession::open(cx, &options, move |_window, app: &mut App| {
		let installed = install_tokens(app, &tokens, &theme, Path::new("surface"))
			.expect("tokens and theme install");
		app.bind_keys(Keymap::default().bindings());
		veyyon_desktop_kit::input::ensure_editor_bindings_registered(app);
		app.new(|_| ShellView::new(installed, fixture::populated()))
	})
	.expect("session opens")
}

fn find_close_hitbox(hitboxes: &[Bounds<Pixels>], window_w: f32) -> Bounds<Pixels> {
	let dialog_right = f32::midpoint(window_w, 560.0);
	*hitboxes
		.iter()
		.filter(|hb| {
			let (w, h, x) =
				(f32::from(hb.size.width), f32::from(hb.size.height), f32::from(hb.origin.x));
			(25.0..=90.0).contains(&w)
				&& (20.0..=36.0).contains(&h)
				&& (dialog_right - 140.0..=dialog_right).contains(&x)
		})
		.max_by(|a, b| {
			f32::from(a.origin.x)
				.partial_cmp(&f32::from(b.origin.x))
				.unwrap()
		})
		.expect("close button hitbox")
}

fn find_back_hitbox(hitboxes: &[Bounds<Pixels>], window_w: f32) -> Bounds<Pixels> {
	let dialog_left = (window_w - 560.0) / 2.0;
	*hitboxes
		.iter()
		.filter(|hb| {
			let (w, h, x) =
				(f32::from(hb.size.width), f32::from(hb.size.height), f32::from(hb.origin.x));
			(25.0..=90.0).contains(&w)
				&& (20.0..=36.0).contains(&h)
				&& (dialog_left..=dialog_left + 140.0).contains(&x)
		})
		.min_by(|a, b| {
			f32::from(a.origin.x)
				.partial_cmp(&f32::from(b.origin.x))
				.unwrap()
		})
		.expect("back button hitbox")
}

fn click_bounds(session: &mut HeadlessSession<'_, ShellView>, bounds: Bounds<Pixels>) {
	let point = Point {
		x: bounds.origin.x + bounds.size.width / 2.0,
		y: bounds.origin.y + bounds.size.height / 2.0,
	};
	session.click(point).expect("pointer click on hitbox");
}

fn assert_composer_focused(session: &mut HeadlessSession<'_, ShellView>, expected: bool) {
	session
		.update(|view, window, cx| {
			let focused = view
				.composer()
				.is_some_and(|ed| ed.read(cx).focus_handle().is_focused(window));
			assert_eq!(focused, expected, "composer focus expected {expected}, got {focused}");
		})
		.expect("verify composer focus");
}

fn assert_search_focused(session: &mut HeadlessSession<'_, ShellView>, expected: bool) {
	session
		.update(|view, window, cx| {
			let focused = view
				.palette_editor()
				.is_some_and(|ed| ed.read(cx).focus_handle().is_focused(window));
			assert_eq!(focused, expected, "search focus expected {expected}, got {focused}");
		})
		.expect("verify palette search focus");
}

fn assert_draft(session: &mut HeadlessSession<'_, ShellView>, expected: &str) {
	session
		.update(|view, _, _| {
			assert_eq!(view.composer_text(), expected, "draft was not preserved");
		})
		.expect("verify draft");
}

fn assert_route_and_query(
	session: &mut HeadlessSession<'_, ShellView>,
	route: SurfaceRoute,
	query: &str,
) {
	session
		.update(|view, _, _| {
			assert_eq!(view.state().overlay.as_ref().and_then(Overlay::route), Some(route));
			assert_eq!(
				view
					.state()
					.overlay
					.as_ref()
					.and_then(Overlay::as_palette)
					.unwrap()
					.query(),
				query
			);
		})
		.expect("route and query verified");
}

#[test]
fn every_domain_page_has_one_parent_and_aliases_resolve_to_the_same_destination() {
	for page in SettingsPage::iter() {
		let route = SurfaceRoute::Page(page);
		let parent = route.parent().expect("a page has a parent");
		let overlay = parent.overlay();
		let palette = overlay
			.as_palette()
			.expect("parents use the shared intermediate surface");
		let destinations_count = palette
			.items()
			.iter()
			.filter_map(|item| match &item.kind {
				veyyon_desktop_surface::palette::PaletteItemKind::Command { intent } => {
					Some(intent.as_ref())
				},
				_ => None,
			})
			.filter(|intent| **intent == Intent::Navigate(route))
			.count();
		assert_eq!(destinations_count, 1, "{page:?} must have one destination in {parent:?}");
		for alias in route.aliases() {
			let mut commands = PaletteState::commands();
			commands.set_query(alias.trim_start_matches('/'));
			assert_eq!(commands.run_intent(), Some(Intent::Navigate(route)), "{alias}");
		}
	}
}

#[test]
fn unfiltered_commands_disclose_groups_instead_of_listing_their_children() {
	let commands = PaletteState::commands();
	let visible: Vec<_> = commands
		.filtered_items()
		.iter()
		.filter_map(|item| match &item.kind {
			veyyon_desktop_surface::palette::PaletteItemKind::Command { intent } => {
				Some(intent.as_ref())
			},
			_ => None,
		})
		.cloned()
		.collect();
	assert!(visible.contains(&Intent::Navigate(SurfaceRoute::Account)));
	assert!(visible.contains(&Intent::Navigate(SurfaceRoute::Settings)));
	assert!(!visible.contains(&Intent::Navigate(SurfaceRoute::Page(SettingsPage::Providers))));
	assert!(!visible.contains(&Intent::Navigate(SurfaceRoute::Page(SettingsPage::Themes))));
	let mut search = commands;
	search.set_query("account manager");
	assert_eq!(
		search.run_intent(),
		Some(Intent::Navigate(SurfaceRoute::Page(SettingsPage::Providers)))
	);
}

#[test]
fn pointer_clicks_on_back_and_close_buttons_navigate_and_dismiss_preserving_composer_and_focus() {
	let width = 1180;
	let height = 800;
	let mut cx = headless_context().expect("headless context available");
	let mut session = open_test_session(&mut cx, width, height);
	let multiline_draft =
		"Line 1: Refactor navigation\nLine 2: Retain draft\nLine 3: Pointer clicks";

	session
		.update(|view, window, cx| {
			view.set_composed(multiline_draft, cx);
			let focus = view.ensure_composer(cx).read(cx).focus_handle().clone();
			window.focus(&focus, cx);
		})
		.expect("set multiline draft and focus");
	session.frame().expect("initial frame renders");
	assert_composer_focused(&mut session, true);
	// 1. Account route hierarchy: Commands ("account") -> Account ("prov") ->
	//    Providers
	session
		.update(|view, _, cx| view.navigate_surface(SurfaceRoute::Commands, cx))
		.expect("open commands");
	session.frame().expect("commands frame");
	session.type_text("account").expect("type account");
	session.frame().expect("typed account frame");

	session
		.update(|view, _, cx| view.navigate_surface(SurfaceRoute::Account, cx))
		.expect("navigate account");
	session.frame().expect("account frame");
	session.type_text("prov").expect("type prov");
	session.frame().expect("typed prov frame");

	session
		.update(|view, _, cx| view.navigate_surface(SurfaceRoute::Page(SettingsPage::Providers), cx))
		.expect("navigate providers");
	let frame = session.frame().expect("providers frame");
	assert_composer_focused(&mut session, false);

	// Click Back from Providers -> restores Account with "prov" query
	let back_hb = find_back_hitbox(&frame.hitboxes, width as f32);
	click_bounds(&mut session, back_hb);
	let frame = session.frame().expect("frame after back to account");
	assert_route_and_query(&mut session, SurfaceRoute::Account, "prov");
	assert_search_focused(&mut session, true);
	assert_composer_focused(&mut session, false);

	// Click Back from Account -> restores Commands with "account" query
	let back_hb = find_back_hitbox(&frame.hitboxes, width as f32);
	click_bounds(&mut session, back_hb);
	let frame = session.frame().expect("frame after back to commands");
	assert_route_and_query(&mut session, SurfaceRoute::Commands, "account");

	// Click Close on Commands -> dismisses overlay, restores composer focus and
	// draft
	let close_hb = find_close_hitbox(&frame.hitboxes, width as f32);
	click_bounds(&mut session, close_hb);
	session.frame().expect("frame after close");
	session
		.update(|view, _, _| assert!(view.state().overlay.is_none()))
		.expect("overlay dismissed");
	assert_composer_focused(&mut session, true);
	assert_draft(&mut session, multiline_draft);

	// 2. Agents route: Commands ("agent") -> Agents (Extensions) -> Back restores
	//    "agent" -> Agents -> Close dismisses
	session
		.update(|view, _, cx| view.navigate_surface(SurfaceRoute::Commands, cx))
		.expect("open commands");
	session.frame().expect("commands frame");
	session.type_text("agent").expect("type agent");
	session.frame().expect("typed agent frame");

	session
		.update(|view, _, cx| view.navigate_surface(SurfaceRoute::Page(SettingsPage::Extensions), cx))
		.expect("navigate agents");
	let frame = session.frame().expect("agents frame");

	// Click Back from Agents -> restores Commands with "agent" query
	let back_hb = find_back_hitbox(&frame.hitboxes, width as f32);
	click_bounds(&mut session, back_hb);
	session
		.frame()
		.expect("frame after back to commands from agents");
	assert_route_and_query(&mut session, SurfaceRoute::Commands, "agent");

	// Navigate back to Agents and click Close directly
	session
		.update(|view, _, cx| view.navigate_surface(SurfaceRoute::Page(SettingsPage::Extensions), cx))
		.expect("navigate agents again");
	let frame = session.frame().expect("agents frame");
	let close_hb = find_close_hitbox(&frame.hitboxes, width as f32);
	click_bounds(&mut session, close_hb);
	session.frame().expect("frame after close from agents");
	session
		.update(|view, _, _| assert!(view.state().overlay.is_none()))
		.expect("overlay dismissed");
	assert_composer_focused(&mut session, true);
	assert_draft(&mut session, multiline_draft);
}

#[test]
fn nested_editor_escape_ascends_and_dismisses_restoring_queries_and_composer_focus() {
	let width = 1180;
	let height = 800;
	let mut cx = headless_context().expect("headless context available");
	let mut session = open_test_session(&mut cx, width, height);
	let multiline_draft = "Multiline draft for Escape test\nSecond line in composer";

	session
		.update(|view, _, cx| view.set_composed(multiline_draft, cx))
		.expect("set draft");
	session.frame().expect("initial frame renders");

	// Open commands and navigate to Settings -> General
	session
		.update(|view, _, cx| view.navigate_surface(SurfaceRoute::Commands, cx))
		.expect("open commands");
	session.frame().expect("commands frame");
	session.type_text("settings").expect("type settings");
	session.frame().expect("typed settings frame");

	session
		.update(|view, _, cx| view.navigate_surface(SurfaceRoute::Settings, cx))
		.expect("navigate settings");
	session.frame().expect("settings frame");
	session.type_text("general").expect("type general");
	session.frame().expect("typed general frame");

	session
		.update(|view, _, cx| view.navigate_surface(SurfaceRoute::Page(SettingsPage::General), cx))
		.expect("navigate general");
	session.frame().expect("general page frame");
	assert_composer_focused(&mut session, false);

	// Escape from General -> ascends to Settings with "general" query restored
	session.keystroke("escape").expect("escape from general");
	session.frame().expect("frame after escape to settings");
	assert_route_and_query(&mut session, SurfaceRoute::Settings, "general");
	assert_search_focused(&mut session, true);

	// Escape from Settings -> ascends to Commands with "settings" query restored
	session.keystroke("escape").expect("escape from settings");
	session.frame().expect("frame after escape to commands");
	assert_route_and_query(&mut session, SurfaceRoute::Commands, "settings");
	assert_search_focused(&mut session, true);

	// Escape from Commands -> dismisses overlay, restores composer focus and draft
	session.keystroke("escape").expect("escape from commands");
	session.frame().expect("frame after escape dismiss");
	session
		.update(|view, _, _| assert!(view.state().overlay.is_none()))
		.expect("overlay dismissed");
	assert_composer_focused(&mut session, true);
	assert_draft(&mut session, multiline_draft);
}

#[test]
fn direct_close_pointer_click_from_every_settings_page_restores_composer_focus_and_draft() {
	let width = 1180;
	let height = 800;
	let mut cx = headless_context().expect("headless context available");
	let multiline_draft = "Unsent multiline draft\nRow 2\nRow 3";
	for page in SettingsPage::iter() {
		let mut session = open_test_session(&mut cx, width, height);
		session
			.update(|view, _, cx| view.set_composed(multiline_draft, cx))
			.expect("set draft");
		session.frame().expect("initial frame renders");

		let route = SurfaceRoute::Page(page);
		session
			.update(|view, _, cx| view.navigate_surface(route, cx))
			.expect("navigate to page");
		let frame = session.frame().expect("page renders");
		assert_composer_focused(&mut session, false);
		let close_hb = find_close_hitbox(&frame.hitboxes, width as f32);
		click_bounds(&mut session, close_hb);
		session.frame().expect("frame after close click");
		session
			.update(|view, _, _| assert!(view.state().overlay.is_none()))
			.expect("overlay dismissed");
		assert_composer_focused(&mut session, true);
		assert_draft(&mut session, multiline_draft);
	}
}
