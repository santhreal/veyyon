//! WHY: a toggle that flips on screen and never reaches the host is a setting
//! the operator believes changed. This suite is the dispatch half of the
//! settings overlay: a change, a reset, a theme pick, a provider auth step, an
//! MCP toggle, a diagnostics retry and a usage refresh each mutate the overlay
//! state the operator sees and each leave one intent pending for the host.
//!
//! CLASS CLOSED: a settings intent that lands locally and is never reported,
//! or is reported and never lands. The row geometry and the headless render of
//! every page are in
//! `every-settings-page-is-one-row-shape-and-a-change-reaches-the-host.rs`.
//!
//! NOT CAUGHT: whether the host persists the value; that is the host's suite.

use serde_json::Value;
use veyyon_desktop_model::{
	McpServerStatus, McpServerView, SettingEntry, SettingKind, ThemesView, domain::ThemeView,
};
use veyyon_desktop_surface::{
	Intent, Overlay, SettingsPage, SettingsState, ShellState, intent::Intents,
};

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

	let mut intents = Intents::new();
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
	let mut intents = Intents::new();
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
	let mut intents = Intents::new();
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
	let mut intents = Intents::new();
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
	let mut intents = Intents::new();
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
	let mut intents = Intents::new();
	intents.dispatch(
		Intent::SubmitAuthSecret {
			provider: "anthropic".to_string(),
			secret:   "sk-ant-test".to_string(),
		},
		&mut state,
	);
	assert_eq!(intents.pending().len(), 1);

	let mut intents = Intents::new();
	intents.dispatch(Intent::OpenAuthUrl("https://auth.provider.com".to_string()), &mut state);
	assert_eq!(intents.pending().len(), 1);

	let mut intents = Intents::new();
	intents.dispatch(Intent::RetryAuthFlow, &mut state);
	assert_eq!(intents.pending().len(), 1);

	let mut intents = Intents::new();
	intents.dispatch(Intent::CancelAuthFlow, &mut state);
	assert_eq!(intents.pending().len(), 1);

	// 5. Diagnostics page: RefreshDiagnostics & RetryDiagnosticSource
	let mut intents = Intents::new();
	intents.dispatch(Intent::RefreshDiagnostics, &mut state);
	assert_eq!(intents.pending().len(), 1);

	let mut intents = Intents::new();
	intents.dispatch(Intent::RetryDiagnosticSource("proxy".to_string()), &mut state);
	assert_eq!(intents.pending().len(), 1);

	// 6. Usage page: RefreshUsage
	let mut intents = Intents::new();
	intents.dispatch(Intent::RefreshUsage, &mut state);
	assert_eq!(intents.pending().len(), 1);
}
