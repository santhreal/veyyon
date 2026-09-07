//! WHY: fixed-height rows let wrapped descriptions paint over adjacent
//! settings. Render the production focused page and isolate each row's ink
//! through its availability state. Their vertical ink ranges must remain
//! disjoint with absent, wrapped, and explicit multiline descriptions. This
//! does not cover native presentation or scrolling.

mod support;

use std::path::Path;

use support::settings_seed::seed_state_for_page;
use veyyon_desktop_kit::{load_bundled_theme, load_bundled_tokens};
use veyyon_desktop_model::SurfaceId;
use veyyon_desktop_scene::{
	HeadlessSession, RgbaFrame,
	headless::{RenderOptions, headless_context},
};
use veyyon_desktop_surface::{
	ConnectionPhase, Overlay, SettingsPage, ShellState, ShellView, controls::Availability,
	install_tokens, navigation::SurfaceRoute,
};
use veyyon_desktop_tokens::MotionModel;
use veyyon_gpui::{App, AppContext};

fn changed_rows(before: &RgbaFrame, after: &RgbaFrame) -> (u32, u32) {
	let mut rows = (0..before.height())
		.filter(|&y| (0..before.width()).any(|x| before.pixel(x, y) != after.pixel(x, y)));
	let first = rows
		.next()
		.expect("changing availability must change the row's ink");
	(first, rows.next_back().unwrap_or(first))
}

#[test]
fn descriptions_do_not_overlap_adjacent_settings() {
	let first_key = "drawer.copy_on_select";
	let second_key = "editor.tab_size";
	let descriptions = [
		None,
		Some(
			"The selection remains available until the next terminal selection replaces it. "
				.repeat(3),
		),
		Some(
			"The selection remains available.\nThe next selection replaces it.\nThe clipboard is \
			 unchanged otherwise."
				.to_owned(),
		),
	];
	for description in descriptions {
		let mut tokens = load_bundled_tokens().expect("bundled tokens load");
		let MotionModel::SpringFade(float) = &mut tokens.motion.float.model else {
			panic!("the float role must use its spring-fade model");
		};
		float.rise_px = 0.0;
		float.fade_duration_ms = 0;
		let theme = load_bundled_theme("dark").expect("bundled theme loads");
		let mut settings = seed_state_for_page(SettingsPage::General);
		settings.route = Some(SurfaceRoute::Page(SettingsPage::General));
		settings
			.settings
			.retain(|key, _| key == first_key || key == second_key);
		settings
			.settings
			.get_mut(first_key)
			.expect("first setting exists")
			.description = description;
		let options = RenderOptions { width: 1180, height: 800, ..RenderOptions::default() };
		let mut cx = headless_context().expect("headless renderer available");
		let mut session = HeadlessSession::open(&mut cx, &options, move |_window, app: &mut App| {
			let installed =
				install_tokens(app, &tokens, &theme, Path::new("surface")).expect("tokens install");
			let state = ShellState {
				connection: ConnectionPhase::Attached,
				overlay: Some(Overlay::Settings(Box::new(settings))),
				..ShellState::default()
			};
			app.new(|_| ShellView::new(installed, state))
		})
		.expect("focused settings page opens");
		let enabled = session.frame().expect("enabled frame renders").frame;
		session
			.update(|view, _, cx| {
				view.state_mut().controls.set_availability(
					SurfaceId::SettingsField(first_key.to_owned()),
					Availability::Pending,
				);
				cx.notify();
			})
			.expect("first row becomes pending");
		let first = session.frame().expect("first row renders pending").frame;
		session
			.update(|view, _, cx| {
				view.state_mut().controls.set_availability(
					SurfaceId::SettingsField(first_key.to_owned()),
					Availability::Enabled,
				);
				view.state_mut().controls.set_availability(
					SurfaceId::SettingsField(second_key.to_owned()),
					Availability::Pending,
				);
				cx.notify();
			})
			.expect("second row becomes pending");
		let second = session.frame().expect("second row renders pending").frame;
		let first_ink = changed_rows(&enabled, &first);
		let second_ink = changed_rows(&enabled, &second);
		assert!(
			first_ink.1 < second_ink.0,
			"adjacent setting ink overlaps: {first_ink:?} and {second_ink:?}"
		);
	}
}
