//! Probe states for floating overlays: the command palette and the settings
//! sheet.
//!
//! Both surfaces float over the window as overlays, reading their geometry from
//! `surface/palette.toml` and `surface/settings.toml`. The probe renders each
//! surface in the states that exercise its authored measures.

use std::path::Path;

use veyyon_desktop_model::{SettingEntry, SettingKind, SettingsView};
use veyyon_desktop_scene::{Headless, HeadlessSession, headless::render_view};
use veyyon_desktop_surface::{
	Intent, Overlay, PaletteItem, PaletteMode, PaletteState, SettingsPage, SettingsState, ShellView,
	fixture, install_tokens, palette::PaletteMeta,
};
use veyyon_desktop_tokens::{Tokens, load_bundled_theme};
use veyyon_gpui::{AppContext, point, px};

use crate::dead_token_probe::{Observation, frame_observation, shell};

/// Renders the floating overlay states that exercise the palette and settings
/// surface tokens.
pub fn observations(cx: &mut Headless, tokens: &Tokens) -> Vec<Observation> {
	let mut out = Vec::new();
	let theme = load_bundled_theme("dark").expect("a bundled theme must load");

	// 1. Centred palette with enough items across multiple groups to fill its
	// height, with note metadata and group headers.
	let mut centred_shell = fixture::populated();
	let mut centred_palette = PaletteState::new(PaletteMode::Commands);
	let mut centred_items = Vec::new();
	for i in 0..24 {
		let group = if i < 12 {
			"Workspace Commands"
		} else {
			"Session Actions"
		};
		let mut item =
			PaletteItem::command(i + 1, format!("Command {}", i + 1), Intent::CloseWindow, None);
		item.subtitle = Some(format!("Execute action for item {}", i + 1));
		item.group = Some(group.to_string());
		item.meta = Some(PaletteMeta::Note(format!("Cmd+{}\nHint", (i % 9) + 1)));
		centred_items.push(item);
	}
	centred_palette.set_items(centred_items);
	centred_shell.overlay = Some(Overlay::Palette(centred_palette));
	let centred_tokens = tokens.clone();
	let centred_theme = theme.clone();
	let centred_frame = render_view(cx, &shell::wide(), move |_window, app| {
		let installed = install_tokens(app, &centred_tokens, &centred_theme, Path::new("surface"))
			.expect("the bundled token set must install");
		app.new(|_cx| ShellView::new(installed, centred_shell))
	})
	.expect("the centred palette must render");
	out.push(frame_observation("palette_centred", &centred_frame));

	// 2. Anchored slash command popover, opened by typing '/' into composer.
	// Exercises anchored_width_px and the 8-row cap (§5.8).
	let slash_shell = fixture::populated();
	let slash_tokens = tokens.clone();
	let slash_theme = theme.clone();
	let slash_frame = render_view(cx, &shell::wide(), move |_window, app| {
		let installed = install_tokens(app, &slash_tokens, &slash_theme, Path::new("surface"))
			.expect("the bundled token set must install");
		app.new(|cx| {
			let mut view = ShellView::new(installed, slash_shell);
			view.set_composed("/", cx);
			view
		})
	})
	.expect("the slash popover must render");
	out.push(frame_observation("palette_slash_anchored", &slash_frame));

	// 3. Settings sheet with multiple groups, controls, descriptions, and a
	// hovered row opening the description tooltip tag.
	let mut settings_shell = fixture::populated();
	let mut settings = SettingsState::new(SettingsPage::General);
	let mut settings_view = SettingsView::new();
	settings_view.insert("appearance.theme".to_string(), SettingEntry {
		value:       serde_json::json!(true),
		default:     serde_json::json!(false),
		source:      "user".to_string(),
		kind:        SettingKind::Boolean,
		label:       Some("Dark Theme".to_string()),
		description: Some("Use high-contrast dark tones across surfaces".to_string()),
		tab:         Some("general".to_string()),
		group:       Some("Appearance".to_string()),
		values:      Vec::new(),
		options:     Vec::new(),
		min:         None,
		max:         None,
		global:      false,
		advanced:    false,
		hidden:      false,
	});
	settings_view.insert("editor.font_family".to_string(), SettingEntry {
		value:       serde_json::json!("JetBrains Mono"),
		default:     serde_json::json!("Fira Code"),
		source:      "user".to_string(),
		kind:        SettingKind::String,
		label:       Some("Font Family".to_string()),
		description: Some("Name of the primary typeface for editor buffers".to_string()),
		tab:         Some("general".to_string()),
		group:       Some("Editor".to_string()),
		values:      Vec::new(),
		options:     Vec::new(),
		min:         None,
		max:         None,
		global:      false,
		advanced:    false,
		hidden:      false,
	});
	settings_view.insert("editor.wrap".to_string(), SettingEntry {
		value:       serde_json::json!(true),
		default:     serde_json::json!(true),
		source:      "default".to_string(),
		kind:        SettingKind::Boolean,
		label:       Some("Word Wrap".to_string()),
		description: Some("Wrap text lines at window edge".to_string()),
		tab:         Some("general".to_string()),
		group:       Some("Editor".to_string()),
		values:      Vec::new(),
		options:     Vec::new(),
		min:         None,
		max:         None,
		global:      false,
		advanced:    false,
		hidden:      false,
	});
	settings.settings = settings_view;
	settings_shell.overlay = Some(Overlay::Settings(Box::new(settings)));

	let settings_tokens = tokens.clone();
	let settings_theme = theme;
	let options = shell::wide();
	let mut session = HeadlessSession::open(cx, &options, move |_window, app| {
		let installed = install_tokens(app, &settings_tokens, &settings_theme, Path::new("surface"))
			.expect("the bundled token set must install");
		app.new(|_cx| ShellView::new(installed, settings_shell))
	})
	.expect("the settings session must open");
	let _initial = session
		.frame()
		.expect("the initial settings frame must capture");
	session
		.hover(point(px(450.0), px(395.0)))
		.expect("hovering the setting row must render");
	let captured = session
		.frame()
		.expect("the hovered settings frame must capture");
	out.push(frame_observation("settings_sheet_hovered", &captured.frame));

	out
}
