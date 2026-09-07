//! Surface seeding per capability (§1.2, §4.3, §9.5).

use veyyon_desktop_model::{
	AgentView, ApprovalInteraction, Capability, ChangeScope, ChangesView, ComposerDraft,
	ContextBreakdownView, ContextCategory, EntryId, FileTreeView, InputModality, InteractionId,
	KeybindingView, McpServerStatus, McpServerView, MessageRole, ModelRef, ModelView, ModelsView,
	PendingDecisions, PlanInteraction, ProcessView, ProviderView, QuestionInteraction, QueueMode,
	QueuePartition, SessionId, SettingEntry, SettingKind, StreamingMessageState, TerminalStatus,
	TerminalView, ThemeView, ThemesView, TranscriptEntry, UsageTotals,
};
use veyyon_desktop_scene::FixtureText;
use veyyon_desktop_surface::{PanelTab, SettingsPage, navigation::SurfaceRoute};

use crate::scene::seed::{SCENE_CLOCK_MS, Seed};

/// Seeds the reachable desktop surface for one capability.
pub fn seed_capability_surface(seed: &mut Seed, session: &SessionId, capability: Capability) {
	match capability {
		Capability::Lifecycle => {
			seed.exchange(session, Seed::prose());
		},
		Capability::Sessions | Capability::Transcript => {
			seed.exchange(session, Seed::prose());
			seed.state.keymap.queue_collapsed = false;
			let s2 = seed.session(QueuePartition::Live);
			seed.exchange(&s2, Seed::prose());
		},
		Capability::SessionDeletion | Capability::SessionTreeNavigation => {
			seed.exchange(session, Seed::prose());
			seed.state.keymap.queue_collapsed = false;
			let s2 = seed.session(QueuePartition::Live);
			seed.exchange(&s2, Seed::prose());
			seed.row_menu = Some(veyyon_desktop_surface::queue::RowMenu {
				id:     2,
				origin: veyyon_gpui::Point { x: veyyon_gpui::px(60.0), y: veyyon_gpui::px(180.0) },
				kind:   veyyon_desktop_surface::queue::RowMenuKind::Card,
			});
		},
		Capability::TurnControl => {
			seed.exchange(session, Seed::prose());
			seed.state.composer.queue_mode = QueueMode::Steer;
		},
		Capability::BackgroundSubmission => {
			seed.exchange(session, Seed::prose());
			seed.state.composer.queue_mode = QueueMode::Queue;
			seed
				.store
				.composer_drafts
				.insert(session.clone(), ComposerDraft {
					text:           FixtureText::MESSAGE_TYPICAL.to_string(),
					attachments:    Vec::new(),
					queue_mode:     QueueMode::Queue,
					selected_model: None,
					thinking_level: None,
				});
			seed
				.store
				.streaming
				.insert(session.clone(), StreamingMessageState {
					entry:        EntryId::from("e_stream_1"),
					tool:         None,
					accumulating: TranscriptEntry {
						id:                EntryId::from("e_stream_1"),
						parent:            None,
						revision:          1,
						timestamp_ms:      SCENE_CLOCK_MS - 2000,
						role:              MessageRole::Assistant,
						content:           Vec::new(),
						meta:              None,
						raw_discriminator: String::new(),
						raw:               serde_json::Value::Null,
					},
					revision:     1,
				});
		},
		Capability::Models => {
			seed.store.domains.models = Some(ModelsView {
				models:          vec![ModelView {
					provider:       "anthropic".to_string(),
					id:             "claude-sonnet-4.5".to_string(),
					name:           "Claude Sonnet 4.5".to_string(),
					reasoning:      true,
					context_window: 200_000,
					max_output:     64_000,
					input:          vec![InputModality::Text, InputModality::Image],
				}],
				current:         Some(ModelRef {
					provider: "anthropic".to_string(),
					id:       "claude-sonnet-4.5".to_string(),
				}),
				thinking_level:  Some("high".to_string()),
				thinking_levels: ["off", "low", "medium", "high"].map(str::to_owned).to_vec(),
			});
		},
		Capability::Changes | Capability::PendingEdits => {
			seed.exchange(session, Seed::prose());
			seed.state.keymap.panel_collapsed = false;
			seed.store.domains.changes = Some(ChangesView {
				revision:   1,
				repository: Some("/repo".to_string()),
				scope:      ChangeScope::WorkingTree,
				files:      Vec::new(),
				diff:       String::new(),
			});
		},
		Capability::Files => {
			seed.exchange(session, Seed::prose());
			seed.state.keymap.panel_collapsed = false;
			seed.state.panel.active_tab = PanelTab::Tree;
			seed.store.domains.file_tree = Some(FileTreeView {
				root:      "/repo".to_string(),
				entries:   Vec::new(),
				truncated: false,
			});
		},
		Capability::Approvals => {
			seed.exchange(session, Seed::prose());
			seed
				.store
				.interactions
				.insert(session.clone(), PendingDecisions {
					approvals: vec![ApprovalInteraction {
						id:              InteractionId::from("approval_0001"),
						tool_name:       "bash".to_string(),
						detail:          "rm -rf build".to_string(),
						requested_at_ms: SCENE_CLOCK_MS - 4000,
					}],
					..PendingDecisions::new()
				});
		},
		Capability::Questions => {
			seed.exchange(session, Seed::prose());
			seed
				.store
				.interactions
				.insert(session.clone(), PendingDecisions {
					questions: vec![QuestionInteraction {
						id:              InteractionId::from("question_0001"),
						prompt:          "Deploy?".to_string(),
						options:         vec!["Staging".to_string(), "Prod".to_string()],
						requested_at_ms: SCENE_CLOCK_MS - 4000,
					}],
					..PendingDecisions::new()
				});
		},
		Capability::Plans => {
			seed.exchange(session, Seed::prose());
			seed
				.store
				.interactions
				.insert(session.clone(), PendingDecisions {
					plans: vec![PlanInteraction {
						id:              InteractionId::from("plan_0001"),
						markdown_plan:   "# Plan\n- step 1".to_string(),
						requested_at_ms: SCENE_CLOCK_MS - 4000,
					}],
					..PendingDecisions::new()
				});
		},
		Capability::Tools => {
			seed.exchange(session, Seed::prose());
			seed.state.composer.queue_mode = QueueMode::Steer;
			seed
				.store
				.streaming
				.insert(session.clone(), StreamingMessageState {
					entry:        EntryId::from("e_tool_1"),
					tool:         Some("bash".to_string()),
					accumulating: TranscriptEntry {
						id:                EntryId::from("e_tool_1"),
						parent:            None,
						revision:          1,
						timestamp_ms:      SCENE_CLOCK_MS - 2000,
						role:              MessageRole::Assistant,
						content:           Vec::new(),
						meta:              None,
						raw_discriminator: String::new(),
						raw:               serde_json::Value::Null,
					},
					revision:     1,
				});
		},
		Capability::Settings => {
			seed.state.overlay = Some(SurfaceRoute::Page(SettingsPage::General).overlay());
			let mut s = veyyon_desktop_model::SettingsView::new();
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
				current: "dark".to_string(),
				themes:  vec![ThemeView {
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
				display_name: "CR".to_string(),
				kind:         "subagent".to_string(),
				status:       "active".to_string(),
				parent:       None,
				scope:        "ws".to_string(),
				session:      None,
			}];
		},
		Capability::Agents => {
			seed.state.overlay = Some(SurfaceRoute::Page(SettingsPage::Extensions).overlay());
			seed.store.domains.agents = vec![AgentView {
				id:           "cr".to_string(),
				display_name: "CR".to_string(),
				kind:         "subagent".to_string(),
				status:       "failed".to_string(),
				parent:       None,
				scope:        "ws".to_string(),
				session:      None,
			}];
		},
		Capability::Tasks => {
			seed.state.overlay = Some(SurfaceRoute::Page(SettingsPage::Extensions).overlay());
			seed.store.domains.agents = vec![AgentView {
				id:           "runner".to_string(),
				display_name: "Runner".to_string(),
				kind:         "task".to_string(),
				status:       "running".to_string(),
				parent:       None,
				scope:        "ws".to_string(),
				session:      None,
			}];
		},
		Capability::AgentCommands => {
			seed.state.overlay = Some(SurfaceRoute::Commands.overlay());
		},
		Capability::Terminals => {
			seed.exchange(session, Seed::prose());
			seed.state.drawer_open = true;
			seed.store.domains.terminals = vec![TerminalView {
				id:     "term_1".to_string(),
				cwd:    "/repo".to_string(),
				shell:  "bash".to_string(),
				cols:   80,
				rows:   24,
				status: TerminalStatus::Running,
			}];
		},
		Capability::ProcessSupervisor => {
			seed.exchange(session, Seed::prose());
			seed.state.drawer_open = true;
			seed.state.drawer.active_tab = 1;
			seed.store.domains.processes = vec![ProcessView {
				name:          "build-server".to_string(),
				pid:           Some(4210),
				status:        "running".to_string(),
				application:   "cargo".to_string(),
				args:          vec!["watch".to_string()],
				cwd:           "/repo".to_string(),
				lifetime:      "session".to_string(),
				started_at_ms: SCENE_CLOCK_MS - 30_000,
				exit_code:     None,
				terminated_by: None,
			}];
		},
	}
}
