//! Seeds the settings sheet page one capability is reached on (§1.2, §9.5).
//!
//! A sheet page is one overlay and one domain the host fills, and ten of the
//! capabilities land on one. They live here rather than beside the surfaces
//! that compose their own state, so neither file carries the other's bulk.

use veyyon_desktop_model::{
	AgentView, Capability, ContextBreakdownView, ContextCategory, KeybindingView, McpServerStatus,
	McpServerView, ProviderView, SessionId, SettingEntry, SettingKind, SettingsView, ThemeView,
	ThemesView, UsageTotals,
};
use veyyon_desktop_scene::FixtureText;
use veyyon_desktop_surface::{SettingsPage, navigation::SurfaceRoute};

use crate::scene::seed::Seed;

/// Seeds the sheet page a capability is reached on.
///
/// A capability the caller routes elsewhere seeds nothing: the match in
/// `seed_capability_surface` decides which ones arrive here, and this one
/// states only what a sheet page needs.
pub fn seed_sheet_page(seed: &mut Seed, session: &SessionId, capability: Capability) {
	match capability {
		Capability::Settings => {
			seed.state.overlay = Some(SurfaceRoute::Page(SettingsPage::General).overlay());
			let mut s = SettingsView::new();
			s.insert("ui.compact".to_string(), SettingEntry {
				value:       serde_json::Value::Bool(true),
				default:     serde_json::Value::Bool(true),
				source:      "default".to_string(),
				kind:        SettingKind::Boolean,
				label:       Some("Compact".to_string()),
				description: Some(FixtureText::MESSAGE_TYPICAL.to_string()),
				tab:         Some("General".to_string()),
				group:       None,
				values:      Vec::new(),
				options:     Vec::new(),
				min:         None,
				max:         None,
				global:      false,
				advanced:    false,
				hidden:      false,
			});
			seed.store.domains.settings = Some(s);
		},
		Capability::Themes => {
			seed.state.overlay = Some(SurfaceRoute::Page(SettingsPage::Themes).overlay());
			seed.store.domains.themes = Some(ThemesView {
				dark:   "dark".to_string(),
				light:  "light".to_string(),
				themes: vec![ThemeView {
					id:   "dark".to_string(),
					name: "Dark".to_string(),
					dark: true,
				}],
			});
		},
		Capability::Keybindings => {
			seed.state.overlay = Some(SurfaceRoute::Page(SettingsPage::Keybindings).overlay());
			seed.store.domains.keybindings = vec![KeybindingView {
				action: "NewSession".to_string(),
				keys:   vec!["Cmd+N".to_string()],
				source: "default".to_string(),
			}];
		},
		Capability::Diagnostics => {
			seed.state.overlay = Some(SurfaceRoute::Page(SettingsPage::Diagnostics).overlay());
			seed.store.domains.diagnostics =
				Some(serde_json::json!({ "sources": [{ "name": "lsp", "status": "ok" }] }));
		},
		Capability::Usage => {
			seed.state.overlay = Some(SurfaceRoute::Page(SettingsPage::Usage).overlay());
			seed
				.store
				.domains
				.usage
				.insert(session.clone(), UsageTotals {
					input_tokens:         15_000,
					output_tokens:        2_500,
					cache_read_tokens:    0,
					cache_write_tokens:   0,
					orchestration_tokens: 0,
					premium_requests:     0,
					cost_microusd:        Some(15_000),
				});
		},
		Capability::ContextBreakdown => {
			seed.state.overlay = Some(SurfaceRoute::Page(SettingsPage::ContextBreakdown).overlay());
			seed
				.store
				.domains
				.context
				.insert(session.clone(), ContextBreakdownView {
					session:      session.clone(),
					total_tokens: 82_400,
					limit_tokens: Some(200_000),
					categories:   vec![ContextCategory { name: "Msgs".to_string(), tokens: 82_400 }],
				});
		},
		Capability::Mcp => {
			seed.state.overlay = Some(SurfaceRoute::Page(SettingsPage::Mcp).overlay());
			seed.store.domains.mcp = vec![McpServerView {
				name:    "filesystem".to_string(),
				enabled: true,
				status:  McpServerStatus::Connected,
				tools:   vec!["read".to_string()],
			}];
		},
		Capability::Providers | Capability::Authentication => {
			seed.state.overlay = Some(SurfaceRoute::Page(SettingsPage::Providers).overlay());
			seed.store.domains.providers = vec![ProviderView {
				id:            "anthropic".to_string(),
				name:          "Anthropic".to_string(),
				authenticated: false,
				oauth:         false,
				api_key:       true,
			}];
		},
		Capability::Extensions => {
			seed.state.overlay = Some(SurfaceRoute::Page(SettingsPage::Extensions).overlay());
			seed.store.domains.agents = vec![AgentView {
				id:           "cr".to_string(),
				call_sign:    "Kestrel".to_string(),
				display_name: "CR".to_string(),
				kind:         "sub".to_string(),
				// Idle: a row that draws no control of its own reads the page's
				// own availability, which is what this capability gates.
				status:       "idle".to_string(),
				parent:       None,
				scope:        "ws".to_string(),
				session:      None,
				activity:     None,
				model:        None,
			}];
		},
		_ => {},
	}
}
