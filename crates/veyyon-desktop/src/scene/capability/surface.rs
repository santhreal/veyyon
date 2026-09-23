//! Surface seeding per capability (§1.2, §4.3, §9.5).

use veyyon_desktop_model::{
	AgentView, ApprovalInteraction, Capability, ChangeScope, ChangesView, CommandSource,
	CommandView, EntryId, FileTreeView, InputModality, InteractionId, MessageRole, ModelRef,
	ModelView, ModelsView, PendingDecisions, PlanInteraction, ProcessView, QuestionInteraction,
	QueueMode, QueuePartition, SessionId, ShareView, StreamingMessageState, TerminalStatus,
	TerminalView, TranscriptEntry,
};
use veyyon_desktop_surface::{
	Overlay, PaletteState, PanelTab, SettingsPage, navigation::SurfaceRoute, share::ShareState,
};

use super::sheet::seed_sheet_page;
use crate::scene::seed::{SCENE_CLOCK_MS, Seed};

/// Seeds the reachable desktop surface for one capability.
pub fn seed_capability_surface(seed: &mut Seed, session: &SessionId, capability: Capability) {
	match capability {
		Capability::Lifecycle => seed.exchange(session, Seed::prose()),
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
			// Queue mode and the follow-up submission are reached from the
			// command surface (§5.4), so that is the frame where a host
			// declining background submission is visible: the two commands are
			// not listed. The query is on them, because the list is clipped to
			// its own height and a row dropped past the fold changes no pixel.
			let mut palette = PaletteState::commands();
			palette.set_query("queue");
			seed.state.overlay = Some(Overlay::Palette(palette));
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
			seed.store.domains.changes.set(ChangesView {
				revision:       1,
				repository:     Some("/repo".to_string()),
				scope:          ChangeScope::WorkingTree,
				files:          Vec::new(),
				diff:           String::new(),
				diff_truncated: false,
				files_withheld: 0,
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
		Capability::Settings
		| Capability::Themes
		| Capability::Keybindings
		| Capability::Diagnostics
		| Capability::Usage
		| Capability::ContextBreakdown
		| Capability::Mcp
		| Capability::Providers
		| Capability::Authentication
		| Capability::Extensions
		| Capability::Profiles => seed_sheet_page(seed, session, capability),
		Capability::Agents => {
			seed.state.overlay = Some(SurfaceRoute::Page(SettingsPage::Extensions).overlay());
			seed.store.domains.agents = vec![AgentView {
				id:           "cr".to_string(),
				call_sign:    "Kestrel".to_string(),
				display_name: "CR".to_string(),
				kind:         "sub".to_string(),
				// Parked is the one state a revive works on: its session is
				// disposed and its transcript is still on disk.
				status:       "parked".to_string(),
				parent:       None,
				scope:        "ws".to_string(),
				session:      None,
				activity:     None,
				model:        None,
			}];
		},
		Capability::Tasks => {
			seed.state.overlay = Some(SurfaceRoute::Page(SettingsPage::Extensions).overlay());
			seed.store.domains.agents = vec![AgentView {
				id:           "runner".to_string(),
				call_sign:    "Otter".to_string(),
				display_name: "Runner".to_string(),
				kind:         "sub".to_string(),
				status:       "running".to_string(),
				parent:       None,
				scope:        "ws".to_string(),
				session:      None,
				activity:     None,
				model:        None,
			}];
		},
		// The list the window opens on is its own commands, which fill the
		// surface before a host row is reached, so the scene stands on the
		// query that names one: what this capability draws is the row for a
		// command the workspace installed.
		Capability::AgentCommands => {
			seed.store.domains.commands = vec![CommandView {
				name:        "review".to_string(),
				aliases:     Vec::new(),
				description: Some("Review the working tree".to_string()),
				input_hint:  Some("[staged]".to_string()),
				source:      CommandSource::Custom,
				subcommands: Vec::new(),
			}];
			let mut overlay = SurfaceRoute::Commands.overlay();
			if let Overlay::Palette(palette) = &mut overlay {
				palette.set_query("review");
			}
			seed.state.overlay = Some(overlay);
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
		Capability::Goals => {
			seed.exchange(session, Seed::prose());
			seed
				.store
				.goals
				.insert(session.clone(), veyyon_desktop_model::GoalView {
					status:            veyyon_desktop_model::GoalStatus::Active,
					objective:         "Ship goal mode".to_string(),
					driving:           true,
					token_budget:      Some(100_000),
					tokens_used:       10_000,
					turns_completed:   2,
					time_used_seconds: 60,
					created_at_ms:     SCENE_CLOCK_MS - 60_000,
					updated_at_ms:     SCENE_CLOCK_MS,
					stood_down:        None,
				});
		},
		Capability::Share => {
			// The capability's reachable surface is the share card, not the
			// command row that opens it: a frame of the palette proves the
			// command is listed and nothing about the controls the capability
			// gates. The card is seeded unshared, with a relay configured,
			// because that is the phase the start controls are drawn in and a
			// start is what this capability answers for: a hosting card draws
			// Stop and Refresh, and a gate on the start control would change
			// no pixel of it.
			//
			// The view goes on the store rather than on the card: the card is
			// filled from `store.domains.share` at every projection, so a view
			// written straight onto the overlay is replaced by the domain
			// before the first frame.
			seed.store.domains.share = Some(ShareView {
				state:         "off".to_owned(),
				relay_url:     Some("wss://relay.example.com".to_owned()),
				link:          None,
				web_link:      None,
				view_link:     None,
				web_view_link: None,
				participants:  Vec::new(),
				error:         None,
			});
			seed.state.overlay = Some(Overlay::Share(Box::new(ShareState::new())));
		},
	}
}
