//! A General settings page of arbitrary size, and the session that draws it,
//! for the suites that exercise the virtualized list rather than one page's
//! seeded rows.

use std::path::Path;

use serde_json::Value;
use veyyon_desktop_kit::{load_bundled_theme, load_bundled_tokens};
use veyyon_desktop_model::{SettingEntry, SettingKind, SettingOption, SettingsView};
use veyyon_desktop_scene::{
	HeadlessSession,
	headless::{Headless, RenderOptions},
};
use veyyon_desktop_surface::{
	ConnectionPhase, Overlay, SettingsPage, SettingsState, ShellState, ShellView, install_tokens,
	navigation::SurfaceRoute,
};
use veyyon_gpui::{App, AppContext};

/// `count` settings under `setting.NNN`, cycling every kind and alternating
/// one-line and wrapping descriptions so row heights vary.
pub fn make_large_settings(count: usize) -> SettingsView {
	let mut map = SettingsView::new();
	for i in 0..count {
		let key = format!("setting.{i:03}");
		let kind = match i % 4 {
			0 => SettingKind::Boolean,
			1 => SettingKind::Number,
			2 => SettingKind::Enum,
			_ => SettingKind::String,
		};
		let value = match kind {
			SettingKind::Boolean => Value::Bool(i % 2 == 0),
			SettingKind::Number => Value::Number(serde_json::Number::from((i as i64) * 2)),
			SettingKind::Enum => Value::String("opt_a".to_string()),
			_ => Value::String(format!("value_{i}")),
		};
		let description = if i % 3 == 0 {
			Some(format!(
				"Description for setting {i:03} wrapping across multiple lines to ensure variable \
				 height rows behave correctly in the virtualized list layout without clipping."
			))
		} else {
			Some(format!("Short description for setting {i:03}"))
		};
		map.insert(key.clone(), SettingEntry {
			value: value.clone(),
			default: value,
			source: "default".to_string(),
			kind,
			label: Some(format!("Setting {i:03}")),
			description,
			tab: Some("general".to_string()),
			group: None,
			values: vec!["opt_a".to_string(), "opt_b".to_string()],
			options: vec![
				SettingOption {
					value:       "opt_a".to_string(),
					label:       "Option A".to_string(),
					description: None,
				},
				SettingOption {
					value:       "opt_b".to_string(),
					label:       "Option B".to_string(),
					description: None,
				},
			],
			min: Some(serde_json::Number::from(0)),
			max: Some(serde_json::Number::from(200)),
			global: false,
			advanced: false,
			hidden: false,
		});
	}
	map
}

/// Opens the shell on the General settings page at `width` by `height`, with
/// the float role's rise and fade taken out so a frame lands at once.
pub fn open_general_settings_session_sized(
	cx: &mut Headless,
	settings_view: SettingsView,
	routed: bool,
	width: u32,
	height: u32,
) -> HeadlessSession<'_, ShellView> {
	let mut tokens = load_bundled_tokens().expect("bundled tokens load");
	tokens.motion.float.rise_px = 0.0;
	tokens.motion.float.fade_duration_ms = 0;
	let theme = load_bundled_theme("dark").expect("bundled theme loads");

	let mut settings = SettingsState::new(SettingsPage::General);
	if routed {
		settings.route = Some(SurfaceRoute::Page(SettingsPage::General));
	}
	settings.settings = settings_view;

	let options = RenderOptions { width, height, scale_factor: 1.0, ..RenderOptions::default() };
	HeadlessSession::open(cx, &options, move |_window, app: &mut App| {
		let installed =
			install_tokens(app, &tokens, &theme, Path::new("surface")).expect("tokens install");
		let state = ShellState {
			connection: ConnectionPhase::Attached,
			overlay: Some(Overlay::Settings(Box::new(settings))),
			..ShellState::default()
		};
		app.new(|_| ShellView::new(installed, state))
	})
	.expect("settings session opens")
}

/// The same session at the ordinary 1180 by 800 viewport.
pub fn open_general_settings_session(
	cx: &mut Headless,
	settings_view: SettingsView,
	routed: bool,
) -> HeadlessSession<'_, ShellView> {
	open_general_settings_session_sized(cx, settings_view, routed, 1180, 800)
}
