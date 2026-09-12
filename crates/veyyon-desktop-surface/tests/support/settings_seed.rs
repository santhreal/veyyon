//! One seeded `SettingsState` per page, so a suite that opens every page draws
//! rows rather than the empty state.

use serde_json::Value;
use veyyon_desktop_model::{
	AgentView, AuthFlowState, AuthFlowView, ContextBreakdownView, ContextCategory, KeybindingView,
	McpServerStatus, McpServerView, ProviderView, SessionId, SettingEntry, SettingKind,
	SettingOption, ThemesView, UsageTotals, domain::ThemeView,
};
use veyyon_desktop_surface::{SettingsPage, SettingsState};

pub fn seed_state_for_page(page: SettingsPage) -> SettingsState {
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
