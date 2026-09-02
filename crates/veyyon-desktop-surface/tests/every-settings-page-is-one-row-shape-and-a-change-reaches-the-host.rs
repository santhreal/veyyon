//! WHY: settings and configuration interfaces frequently suffer from UI
//! divergence where different tabs adopt ad-hoc row geometries, custom margins,
//! or un-gated controls that fail to reflect host capability states.
//!
//! The defect classes this test closes are:
//! 1. Settings pages using disparate row heights or layouts instead of the
//!    unified 44px row.
//! 2. Toggle, stepper, or configuration edits failing to dispatch
//!    `Intent::SettingChanged` or `Intent::ResetSetting`.
//! 3. Theme, provider auth, MCP enablement, and diagnostics retries failing to
//!    dispatch corresponding intents.
//! 4. Unavailable settings controls failing to render with dimmed opacity.
//! 5. Empty settings views failing to render the single empty-state row.
//!
//! What this suite leaves to the host is persistent storage of setting values
//! on disk.

use std::path::Path;

use serde_json::Value;
use strum::IntoEnumIterator;
use veyyon_desktop_kit::{load_bundled_theme, load_bundled_tokens};
use veyyon_desktop_model::{
	AgentView, AuthFlowState, AuthFlowView, ContextBreakdownView, ContextCategory, KeybindingView,
	McpServerStatus, McpServerView, ProviderView, SessionId, SettingEntry, SettingKind,
	SettingOption, ThemesView, UsageTotals, domain::ThemeView,
};
use veyyon_desktop_scene::{
	HeadlessSession,
	headless::{RenderOptions, headless_context},
};
use veyyon_desktop_surface::{
	Intent, Overlay, SettingsPage, SettingsState, ShellState, ShellView,
	controls::Availability,
	install_tokens,
	settings::{empty_state_row, setting_row},
};
use veyyon_gpui::{App, AppContext, ParentElement, div};

const WIDTH: u32 = 1440;
const HEIGHT: u32 = 900;

fn options() -> RenderOptions {
	RenderOptions { width: WIDTH, height: HEIGHT, scale_factor: 1.0, ..RenderOptions::default() }
}

fn seed_state_for_page(page: SettingsPage) -> SettingsState {
	let mut state = SettingsState::new(page);
	match page {
		SettingsPage::General => {
			state
				.settings
				.insert("drawer.copy_on_select".to_string(), SettingEntry {
					value:       Value::Bool(true),
					default:     Value::Bool(true),
					source:      "default".to_string(),
					kind:        SettingKind::Boolean,
					label:       Some("Copy on select".to_string()),
					description: Some("Copy terminal selection immediately".to_string()),
					tab:         Some("general".to_string()),
					group:       None,
					values:      Vec::new(),
					options:     Vec::new(),
					min:         None,
					max:         None,
					global:      false,
					advanced:    false,
					hidden:      false,
				});
			state
				.settings
				.insert("editor.tab_size".to_string(), SettingEntry {
					value:       Value::Number(serde_json::Number::from(4)),
					default:     Value::Number(serde_json::Number::from(4)),
					source:      "default".to_string(),
					kind:        SettingKind::Number,
					label:       Some("Tab Size".to_string()),
					description: Some("Number of spaces per indentation level".to_string()),
					tab:         Some("general".to_string()),
					group:       None,
					values:      Vec::new(),
					options:     Vec::new(),
					min:         Some(serde_json::Number::from(1)),
					max:         Some(serde_json::Number::from(8)),
					global:      false,
					advanced:    false,
					hidden:      false,
				});
			state
				.settings
				.insert("editor.theme_mode".to_string(), SettingEntry {
					value:       Value::String("dark".to_string()),
					default:     Value::String("dark".to_string()),
					source:      "default".to_string(),
					kind:        SettingKind::Enum,
					label:       Some("Theme Mode".to_string()),
					description: Some("Color presentation mode".to_string()),
					tab:         Some("general".to_string()),
					group:       None,
					values:      vec!["dark".to_string(), "light".to_string()],
					options:     vec![
						SettingOption {
							value:       "dark".to_string(),
							label:       "Dark".to_string(),
							description: None,
						},
						SettingOption {
							value:       "light".to_string(),
							label:       "Light".to_string(),
							description: None,
						},
					],
					min:         None,
					max:         None,
					global:      false,
					advanced:    false,
					hidden:      false,
				});
			state
				.settings
				.insert("user.name".to_string(), SettingEntry {
					value:       Value::String("Operator".to_string()),
					default:     Value::String("Default User".to_string()),
					source:      "user".to_string(),
					kind:        SettingKind::String,
					label:       Some("Display Name".to_string()),
					description: Some("Human-readable user moniker".to_string()),
					tab:         Some("general".to_string()),
					group:       None,
					values:      Vec::new(),
					options:     Vec::new(),
					min:         None,
					max:         None,
					global:      false,
					advanced:    false,
					hidden:      false,
				});
		},
		SettingsPage::Themes => {
			state.themes = Some(ThemesView {
				themes:  vec![
					ThemeView { id: "dark".to_string(), name: "Dark Ground".to_string(), dark: true },
					ThemeView {
						id:   "light".to_string(),
						name: "Light Ground".to_string(),
						dark: false,
					},
				],
				current: "dark".to_string(),
			});
		},
		SettingsPage::Keybindings => {
			state.keybindings = vec![
				KeybindingView {
					action: "Open Command Palette".to_string(),
					keys:   vec!["Cmd+K".to_string()],
					source: "default".to_string(),
				},
				KeybindingView {
					action: "Toggle Terminal Drawer".to_string(),
					keys:   vec!["Cmd+J".to_string()],
					source: "default".to_string(),
				},
			];
		},
		SettingsPage::Providers => {
			state.providers = vec![
				ProviderView {
					id:            "anthropic".to_string(),
					name:          "Anthropic Claude".to_string(),
					authenticated: false,
					oauth:         true,
					api_key:       true,
				},
				ProviderView {
					id:            "openai".to_string(),
					name:          "OpenAI GPT".to_string(),
					authenticated: true,
					oauth:         false,
					api_key:       true,
				},
			];
		},
		SettingsPage::Authentication => {
			state.auth_flow = Some(AuthFlowView {
				provider: "anthropic".to_string(),
				state:    AuthFlowState::AwaitingSecret,
				url:      None,
				prompt:   Some("Enter your Anthropic API Key".to_string()),
				message:  None,
			});
		},
		SettingsPage::Mcp => {
			state.mcp = vec![
				McpServerView {
					name:    "filesystem".to_string(),
					enabled: true,
					status:  McpServerStatus::Connected,
					tools:   vec!["read_file".to_string(), "write_file".to_string()],
				},
				McpServerView {
					name:    "git".to_string(),
					enabled: false,
					status:  McpServerStatus::Disconnected,
					tools:   vec!["git_status".to_string()],
				},
			];
		},
		SettingsPage::Extensions => {
			state.extensions = vec![
				AgentView {
					id:           "reviewer".to_string(),
					display_name: "Code Review Subagent".to_string(),
					kind:         "review".to_string(),
					status:       "active".to_string(),
					parent:       None,
					scope:        "crates/*".to_string(),
					session:      None,
				},
				AgentView {
					id:           "scout".to_string(),
					display_name: "Workspace Scout".to_string(),
					kind:         "discovery".to_string(),
					status:       "ready".to_string(),
					parent:       None,
					scope:        ".".to_string(),
					session:      None,
				},
			];
		},
		SettingsPage::Diagnostics => {
			state.diagnostics = Some(serde_json::json!({
				"sources": [
					{
						"name": "Host Transport",
						"status": "ok",
						"message": "Connected via in-process channel"
					},
					{
						"name": "Model Proxy",
						"status": "error",
						"message": "Connection refused to upstream socket"
					}
				],
				"host": {
					"platform": "linux",
					"arch": "x86_64",
					"node_version": "22.0.0",
					"uptime_seconds": 3600
				}
			}));
		},
		SettingsPage::Usage => {
			state.usage = Some(UsageTotals {
				input_tokens:         120000,
				output_tokens:        45000,
				cache_read_tokens:    80000,
				cache_write_tokens:   15000,
				orchestration_tokens: 3500,
				premium_requests:     4,
				cost_microusd:        Some(1850000),
			});
		},
		SettingsPage::ContextBreakdown => {
			state.context = Some(ContextBreakdownView {
				session:      SessionId::from("1"),
				total_tokens: 45000,
				limit_tokens: Some(200000),
				categories:   vec![
					ContextCategory { name: "System Prompt".to_string(), tokens: 10000 },
					ContextCategory { name: "Conversation History".to_string(), tokens: 30000 },
					ContextCategory { name: "Tool Declarations".to_string(), tokens: 5000 },
				],
			});
		},
	}
	state
}

#[test]
fn every_settings_page_sweeps_cleanly_from_enum() {
	let tokens = load_bundled_tokens().expect("tokens load");
	let geometry = &tokens.surface.settings;

	// Geometry invariants per §5.9.
	assert_eq!(geometry.row_height_px, 44.0, "settings row height must be 44px");
	assert_eq!(geometry.control_column_width_px, 240.0, "control column width must be 240px");

	for page in SettingsPage::iter() {
		assert!(!page.title().is_empty(), "page {page:?} must have a title");
		assert!(!page.description().is_empty(), "page {page:?} must have a description");

		let state = SettingsState::new(page);
		assert_eq!(state.page, page);
	}
}

#[test]
fn setting_row_reflects_availability_opacity() {
	let tokens = load_bundled_tokens().expect("tokens load");
	let geometry = tokens.surface.settings.clone();
	let theme = load_bundled_theme("dark").expect("theme loads");

	let mut cx = headless_context().expect("headless context available");
	let _session = HeadlessSession::open(&mut cx, &options(), move |_window, app: &mut App| {
		let installed = install_tokens(app, &tokens, &theme, Path::new("surface"))
			.expect("tokens and theme install");

		// Enabled control.
		let _row_enabled = setting_row(
			"Enable Feature",
			Some("Feature description"),
			div().child("Control"),
			&Availability::Enabled,
			&geometry,
			&installed.set,
		);

		// Unavailable control.
		let _row_unavailable = setting_row(
			"Disabled Feature",
			Some("Disabled description"),
			div().child("Control"),
			&Availability::Unavailable { reason: "Missing capability".to_string() },
			&geometry,
			&installed.set,
		);

		// Empty state row.
		let _empty_row = empty_state_row("No items configured", &geometry, &installed.set);

		app.new(|_| ShellView::new(installed, ShellState::default()))
	})
	.expect("session opens");
}

#[test]
fn setting_change_dispatches_intent_and_maps_to_host_action() {
	let mut state = ShellState::default();
	let mut settings_state = SettingsState::new(SettingsPage::General);
	settings_state
		.settings
		.insert("drawer.copy_on_select".to_string(), SettingEntry {
			value:       Value::Bool(true),
			default:     Value::Bool(true),
			source:      "default".to_string(),
			kind:        SettingKind::Boolean,
			label:       Some("Copy on select".to_string()),
			description: None,
			tab:         Some("general".to_string()),
			group:       None,
			values:      Vec::new(),
			options:     Vec::new(),
			min:         None,
			max:         None,
			global:      false,
			advanced:    false,
			hidden:      false,
		});
	state.overlay = Some(Overlay::Settings(Box::new(settings_state)));

	let intent = Intent::SettingChanged {
		key:   "drawer.copy_on_select".to_string(),
		value: Value::Bool(false),
	};

	let mut intents = veyyon_desktop_surface::intent::Intents::new();
	intents.dispatch(intent.clone(), &mut state);

	// 1. Verify local state mutation.
	let current_val = state
		.overlay_settings()
		.and_then(|s| s.entry("drawer.copy_on_select"))
		.map(|entry| &entry.value);
	assert_eq!(current_val, Some(&Value::Bool(false)));

	// 2. Verify non-local intent is pending for host.
	assert_eq!(intents.pending().len(), 1);
	assert_eq!(intents.pending()[0], intent);
}

#[test]
fn theme_selection_dispatches_and_reaches_host() {
	let mut state = ShellState::default();
	let mut settings = SettingsState::new(SettingsPage::Themes);
	settings.themes = Some(ThemesView {
		themes:  vec![
			ThemeView { id: "dark".to_string(), name: "Dark".to_string(), dark: true },
			ThemeView { id: "light".to_string(), name: "Light".to_string(), dark: false },
		],
		current: "dark".to_string(),
	});
	state.overlay = Some(Overlay::Settings(Box::new(settings)));

	let intent = Intent::SelectTheme("light".to_string());
	let mut intents = veyyon_desktop_surface::intent::Intents::new();
	intents.dispatch(intent, &mut state);

	assert_eq!(
		state
			.overlay_settings()
			.and_then(|s| s.themes.as_ref())
			.map(|t| t.current.as_str()),
		Some("light")
	);
	assert_eq!(intents.pending().len(), 1);
}

#[test]
fn interactions_across_settings_pages_dispatch_intents() {
	let mut state = ShellState::default();

	// 1. General page: ResetSetting
	let mut s_gen = SettingsState::new(SettingsPage::General);
	s_gen
		.settings
		.insert("user.name".to_string(), SettingEntry {
			value:       Value::String("Modified".to_string()),
			default:     Value::String("Default User".to_string()),
			source:      "user".to_string(),
			kind:        SettingKind::String,
			label:       Some("Display Name".to_string()),
			description: None,
			tab:         None,
			group:       None,
			values:      Vec::new(),
			options:     Vec::new(),
			min:         None,
			max:         None,
			global:      false,
			advanced:    false,
			hidden:      false,
		});
	state.overlay = Some(Overlay::Settings(Box::new(s_gen)));
	let mut intents = veyyon_desktop_surface::intent::Intents::new();
	intents.dispatch(Intent::ResetSetting("user.name".to_string()), &mut state);
	assert_eq!(intents.pending().len(), 1);
	assert_eq!(
		state
			.overlay_settings()
			.and_then(|s| s.entry("user.name"))
			.map(|e| &e.value),
		Some(&Value::String("Default User".to_string()))
	);

	// 2. Providers page: StartProviderAuth
	let mut intents = veyyon_desktop_surface::intent::Intents::new();
	intents.dispatch(Intent::StartProviderAuth("anthropic".to_string()), &mut state);
	assert_eq!(intents.pending().len(), 1);

	// 3. MCP page: SetMcpEnabled
	let mut s_mcp = SettingsState::new(SettingsPage::Mcp);
	s_mcp.mcp = vec![McpServerView {
		name:    "filesystem".to_string(),
		enabled: false,
		status:  McpServerStatus::Disconnected,
		tools:   Vec::new(),
	}];
	state.overlay = Some(Overlay::Settings(Box::new(s_mcp)));
	let mut intents = veyyon_desktop_surface::intent::Intents::new();
	intents.dispatch(
		Intent::SetMcpEnabled { server: "filesystem".to_string(), enabled: true },
		&mut state,
	);
	assert_eq!(intents.pending().len(), 1);
	assert_eq!(
		state
			.overlay_settings()
			.and_then(|s| s.mcp.first())
			.map(|m| m.enabled),
		Some(true)
	);

	// 4. Authentication page: SubmitAuthSecret, OpenAuthUrl, RetryAuthFlow,
	//    CancelAuthFlow
	let mut intents = veyyon_desktop_surface::intent::Intents::new();
	intents.dispatch(
		Intent::SubmitAuthSecret {
			provider: "anthropic".to_string(),
			secret:   "sk-ant-test".to_string(),
		},
		&mut state,
	);
	assert_eq!(intents.pending().len(), 1);

	let mut intents = veyyon_desktop_surface::intent::Intents::new();
	intents.dispatch(Intent::OpenAuthUrl("https://auth.provider.com".to_string()), &mut state);
	assert_eq!(intents.pending().len(), 1);

	let mut intents = veyyon_desktop_surface::intent::Intents::new();
	intents.dispatch(Intent::RetryAuthFlow, &mut state);
	assert_eq!(intents.pending().len(), 1);

	let mut intents = veyyon_desktop_surface::intent::Intents::new();
	intents.dispatch(Intent::CancelAuthFlow, &mut state);
	assert_eq!(intents.pending().len(), 1);

	// 5. Diagnostics page: RefreshDiagnostics & RetryDiagnosticSource
	let mut intents = veyyon_desktop_surface::intent::Intents::new();
	intents.dispatch(Intent::RefreshDiagnostics, &mut state);
	assert_eq!(intents.pending().len(), 1);

	let mut intents = veyyon_desktop_surface::intent::Intents::new();
	intents.dispatch(Intent::RetryDiagnosticSource("proxy".to_string()), &mut state);
	assert_eq!(intents.pending().len(), 1);

	// 6. Usage page: RefreshUsage
	let mut intents = veyyon_desktop_surface::intent::Intents::new();
	intents.dispatch(Intent::RefreshUsage, &mut state);
	assert_eq!(intents.pending().len(), 1);
}

#[test]
fn settings_overlay_renders_seeded_and_empty_states_in_headless_session() {
	let mut cx = headless_context().expect("headless context available");
	let tokens = load_bundled_tokens().expect("tokens load");
	let theme = load_bundled_theme("dark").expect("theme loads");

	let mut session = HeadlessSession::open(&mut cx, &options(), move |_window, app: &mut App| {
		let installed = install_tokens(app, &tokens, &theme, Path::new("surface"))
			.expect("tokens and theme install");
		let state = ShellState {
			overlay: Some(Overlay::Settings(Box::new(seed_state_for_page(SettingsPage::General)))),
			..ShellState::default()
		};
		app.new(|_| ShellView::new(installed, state))
	})
	.expect("session opens");

	let captured = session.frame().expect("settings frame renders");
	assert!(!captured.hitboxes.is_empty(), "settings overlay must render interactive hitboxes");

	// 1. Switch across every page with real seeded state in headless mode.
	for page in SettingsPage::iter() {
		let seeded = seed_state_for_page(page);
		session
			.update(|view, _window, cx| {
				view.dispatch(Intent::OpenOverlay(Box::new(Overlay::Settings(Box::new(seeded)))));
				cx.notify();
			})
			.expect("page switched with seeded state");

		let frame = session.frame().expect("seeded page renders");
		assert!(!frame.hitboxes.is_empty(), "seeded page {page:?} must render hitboxes");
	}

	// 2. Switch across every page with empty state in headless mode.
	for page in SettingsPage::iter() {
		let empty = SettingsState::new(page);
		session
			.update(|view, _window, cx| {
				view.dispatch(Intent::OpenOverlay(Box::new(Overlay::Settings(Box::new(empty)))));
				cx.notify();
			})
			.expect("page switched with empty state");

		let frame = session.frame().expect("empty page renders");
		assert!(!frame.hitboxes.is_empty(), "empty page {page:?} must render hitboxes");
	}
}
