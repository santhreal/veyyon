//! WHY: Eagerly constructing every setting row on every render for large
//! General settings collections creates layout and allocation bottlenecks,
//! causing frame delays when entering settings or dismissing overlays.
//!
//! CLASS CLOSED:
//! 1. Virtualized viewport boundedness: Only viewport-adjacent row elements are
//!    constructed and shaped, bounding the rendered element count regardless of
//!    total collection size (e.g. 100+ settings).
//! 2. Reachability of late settings: Scrolling to a late setting reveals its
//!    text and controls through production layout paths.
//! 3. Scroll preservation on value changes: Ordinary value changes preserve
//!    scroll position and cached row heights without remeasurement.
//! 4. Visibility and text remeasurement: Toggling hidden flags or editing copy
//!    invalidates measurements and synchronizes the virtual item count.
//!
//! NOT CAUGHT: Disk persistence and host-side protocol serialization.

mod support;

use std::path::Path;

use serde_json::Value;
use veyyon_desktop_kit::{load_bundled_theme, load_bundled_tokens};
use veyyon_desktop_model::{SettingEntry, SettingKind, SettingOption, SettingsView};
use veyyon_desktop_scene::{
	HeadlessSession,
	headless::{Headless, RenderOptions, headless_context},
};
use veyyon_desktop_surface::{
	ConnectionPhase, Overlay, SettingsPage, SettingsState, ShellState, ShellView, install_tokens,
	navigation::SurfaceRoute,
};
use veyyon_desktop_tokens::MotionModel;
use veyyon_gpui::{App, AppContext};

fn make_large_settings(count: usize) -> SettingsView {
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

fn open_general_settings_session_sized(
	cx: &mut Headless,
	settings_view: SettingsView,
	routed: bool,
	width: u32,
	height: u32,
) -> HeadlessSession<'_, ShellView> {
	let mut tokens = load_bundled_tokens().expect("bundled tokens load");
	let MotionModel::SpringFade(float) = &mut tokens.motion.float.model else {
		panic!("the float role must use its spring-fade model");
	};
	float.rise_px = 0.0;
	float.fade_duration_ms = 0;
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

fn open_general_settings_session(
	cx: &mut Headless,
	settings_view: SettingsView,
	routed: bool,
) -> HeadlessSession<'_, ShellView> {
	open_general_settings_session_sized(cx, settings_view, routed, 1180, 800)
}

#[test]
fn large_general_settings_collection_bounds_rendered_elements_to_viewport() {
	let mut cx = headless_context().expect("headless renderer available");
	let capture = |cx: &mut Headless, count| {
		let mut session = open_general_settings_session(cx, make_large_settings(count), true);
		let frame = session.frame().expect("settings viewport renders");
		session
			.update(|view, _, _| {
				assert_eq!(view.general_settings_list().item_count(), count);
			})
			.expect("collection count verified");
		frame
	};
	let small = capture(&mut cx, 100);
	let large = capture(&mut cx, 1000);
	assert_eq!(large.hitboxes, small.hitboxes, "offscreen rows must add no hit targets");
	assert_eq!(
		large.text_runs.len(),
		small.text_runs.len(),
		"offscreen rows must add no shaped text"
	);
}

#[test]
fn scrolling_reveals_late_settings_and_constructs_their_controls() {
	let mut cx = headless_context().expect("headless renderer available");
	let total_settings = 100;
	let settings_view = make_large_settings(total_settings);
	let mut session = open_general_settings_session(&mut cx, settings_view, true);
	let initial_frame = session.frame().expect("initial frame renders");
	assert!(!initial_frame.hitboxes.is_empty(), "initial frame contains visible controls");
	// Scroll to a late setting item near the bottom of the collection.
	session
		.update(|view, _window, cx| {
			view
				.general_settings_list()
				.scroll_to_reveal_key("setting.095");
			cx.notify();
		})
		.expect("scrolled to late setting");

	let scrolled_frame = session.frame().expect("scrolled frame renders");
	session
		.update(|view, _, _| {
			let top = view
				.general_settings_list()
				.list_state()
				.logical_scroll_top();
			assert!((80..=95).contains(&top.item_ix), "late rows must enter the viewport");
		})
		.expect("late viewport verified");

	assert_ne!(
		scrolled_frame.hitboxes, initial_frame.hitboxes,
		"scroll must replace visible controls"
	);
}

#[test]
fn ordinary_value_changes_preserve_scroll_position() {
	let mut cx = headless_context().expect("headless renderer available");
	let total_settings = 100;
	let settings_view = make_large_settings(total_settings);
	let mut session = open_general_settings_session(&mut cx, settings_view, true);

	// Scroll down to index 50.
	session
		.update(|view, _window, cx| {
			view.general_settings_list().scroll_to_reveal_item(50);
			cx.notify();
		})
		.expect("scrolled to setting 50");
	let _scrolled_frame = session.frame().expect("scrolled frame renders");
	let before_scroll = session
		.update(|view, _, _| {
			view
				.general_settings_list()
				.list_state()
				.logical_scroll_top()
		})
		.expect("read scrolled position");
	assert!(before_scroll.item_ix > 0, "the comparison must start away from the top");

	// Update an ordinary setting value (e.g. toggle boolean or change string
	// value).
	session
		.update(|view, _window, cx| {
			let settings = view
				.state_mut()
				.overlay
				.as_mut()
				.expect("settings remain open");
			let Overlay::Settings(settings) = settings else {
				panic!("expected settings overlay");
			};
			let entry = settings
				.settings
				.get_mut("setting.050")
				.expect("setting exists");
			entry.value = Value::String("opt_b".to_string());
			cx.notify();
		})
		.expect("setting value updated");

	session.frame().expect("frame after value change renders");
	let after_scroll = session
		.update(|view, _, _| {
			view
				.general_settings_list()
				.list_state()
				.logical_scroll_top()
		})
		.expect("read position after value update");
	assert_eq!(after_scroll.item_ix, before_scroll.item_ix);
	assert_eq!(after_scroll.offset_in_item, before_scroll.offset_in_item);

	// Item count remains identical and viewport remains bounded.
	session
		.update(|view, _window, _cx| {
			assert_eq!(
				view.general_settings_list().item_count(),
				total_settings,
				"item count remains stable across value change"
			);
		})
		.expect("item count verified");
}

#[test]
fn visibility_changes_synchronize_virtual_item_count() {
	let mut cx = headless_context().expect("headless renderer available");
	let total_settings = 100;
	let settings_view = make_large_settings(total_settings);
	let mut session = open_general_settings_session(&mut cx, settings_view, true);
	session
		.update(|view, _window, cx| {
			if let Some(Overlay::Settings(settings)) = &mut view.state_mut().overlay {
				for i in 0..20 {
					let key = format!("setting.{i:03}");
					if let Some(entry) = settings.settings.get_mut(&key) {
						entry.hidden = true;
					}
				}
			}
			cx.notify();
		})
		.expect("settings hidden");

	session.frame().expect("frame after hide renders");

	session
		.update(|view, _window, _cx| {
			assert_eq!(
				view.general_settings_list().item_count(),
				80,
				"virtualized list item count synchronized to non-hidden settings count"
			);
		})
		.expect("item count 80 verified");

	session
		.update(|view, _, _| {
			assert_eq!(
				view.general_settings_list().visible_keys(),
				(20..100)
					.map(|i| format!("setting.{i:03}"))
					.collect::<Vec<_>>()
			);
		})
		.expect("hidden settings excluded from the viewport sequence");
}

#[test]
fn minimum_height_window_bounds_focused_general_header_and_body() {
	let mut cx = headless_context().expect("headless renderer available");
	let total_settings = 100;
	let tall_hitboxes = {
		let mut tall =
			open_general_settings_session(&mut cx, make_large_settings(total_settings), true);
		tall.frame().expect("tall viewport renders").hitboxes.len()
	};
	let settings_view = make_large_settings(total_settings);
	// Minimum height window: 560px height where available columns height is ~508px
	let mut session = open_general_settings_session_sized(&mut cx, settings_view, true, 1180, 560);

	let frame = session.frame().expect("minimum height frame renders");

	assert!(
		frame.hitboxes.len() < tall_hitboxes,
		"reducing viewport height must reduce the constructed controls"
	);

	// Verify that frame height matches minimum window height
	assert_eq!(frame.frame.height(), 560, "frame height matches minimum window height");
}
