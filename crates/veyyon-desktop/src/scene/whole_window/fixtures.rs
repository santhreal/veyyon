//! The content the whole-window states are assembled from (§9.2, pass X1).
//!
//! Eleven states share three fixtures: the populated seed every state but rest
//! and first-run starts from, the changes and file tree the right panel draws,
//! and the terminal, scrollback and supervised process the drawer draws. They
//! are one definition here so a state differs from its neighbour only in the
//! surfaces it opens.

use veyyon_desktop_model::{
	BadgeKind, Capability, CapabilityStatus, ChangeScope, ChangeStatus, ChangedFile, ChangesView,
	ContentBlock, ContextBreakdownView, FileKind, FileNode, FileTreeView, InputModality,
	MessageRole, ModelRef, ModelView, ModelsView, ProcessView, QueuePartition, TerminalScrollback,
	TerminalStatus, TerminalView, UsageTotals,
};

use crate::scene::seed::{SCENE_CLOCK_MS, Seed};

/// The five sessions, transcript, model, context and usage every populated
/// whole-window state starts from, with the active session's id.
pub fn base_populated_seed() -> (Seed, veyyon_desktop_model::SessionId) {
	let mut seed = Seed::attached();
	let active_id = seed.session(QueuePartition::Live);
	if let Some(s) = seed.store.sessions.get_mut(&active_id) {
		s.title = "File tree row retention".to_string();
	}
	let working_id = seed.badged_session(QueuePartition::Live, BadgeKind::Working);
	if let Some(s) = seed.store.sessions.get_mut(&working_id) {
		s.title = "Run clippy and cargo check".to_string();
	}
	let approval_id = seed.badged_session(QueuePartition::Live, BadgeKind::Approval);
	if let Some(s) = seed.store.sessions.get_mut(&approval_id) {
		s.title = "Deploy staging cluster".to_string();
	}
	let due_id = seed.badged_session(QueuePartition::Pinned, BadgeKind::Due);
	if let Some(s) = seed.store.sessions.get_mut(&due_id) {
		s.title = "Review PR #142: GPUI renderer".to_string();
	}
	let done_id = seed.badged_session(QueuePartition::Parked, BadgeKind::Done);
	if let Some(s) = seed.store.sessions.get_mut(&done_id) {
		s.title = "Add surface token tests".to_string();
	}

	seed.entry(&active_id, MessageRole::User, vec![ContentBlock::Text {
		text: "Keep the file tree's expanded rows across a panel resize, and line the gutter \
		       numbers up with the code beside them at every width."
			.to_string(),
	}]);
	seed.entry(&active_id, MessageRole::Assistant, vec![ContentBlock::Text {
		text: "The tree holds its expanded rows now, and the gutter shares the line height of the \
		       code:\n\n```rust\npub fn gutter(rows: RowWalk<'_>, geom: &PanelsSurfaceTokens) -> \
		       impl IntoElement \
		       {\n\tdiv().w(px(geom.gutter_width_px)).children(rows.numbers())\n}\n```\n\nThe \
		       numbers stay pinned while the pane scrolls sideways."
			.to_string(),
	}]);

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

	seed
		.store
		.domains
		.context
		.insert(active_id.clone(), ContextBreakdownView {
			session:      active_id.clone(),
			total_tokens: 38_420,
			limit_tokens: Some(200_000),
			categories:   Vec::new(),
		});

	seed
		.store
		.domains
		.usage
		.insert(active_id.clone(), UsageTotals {
			input_tokens:         48_210,
			output_tokens:        12_940,
			cache_read_tokens:    1_402_887,
			cache_write_tokens:   96_004,
			orchestration_tokens: 3_118,
			premium_requests:     42,
			cost_microusd:        Some(3_940_000),
		});

	seed.state.title = "veyyon · File tree row retention".to_string();
	(seed, active_id)
}

/// The changed files, diff and file tree the right panel's tabs draw.
pub fn add_right_panel_content(seed: &mut Seed) {
	seed.store.domains.changes.set(ChangesView {
		revision:       1,
		repository:     Some("/repo/veyyon".to_string()),
		scope:          ChangeScope::WorkingTree,
		files:          vec![
			ChangedFile {
				path:          "crates/veyyon-desktop-surface/src/layout.rs".to_string(),
				previous_path: None,
				status:        ChangeStatus::Modified,
				additions:     8,
				deletions:     1,
			},
			ChangedFile {
				path:          "crates/veyyon-desktop-surface/src/titlebar.rs".to_string(),
				previous_path: None,
				status:        ChangeStatus::Modified,
				additions:     14,
				deletions:     3,
			},
		],
		diff:           "@@ -50,6 +50,8 @@\n-use super::layout::column_widths;\n+use \
		                 super::layout::{column_widths, gutter_width};\n+pub fn render_shell() {}\n"
			.to_string(),
		diff_truncated: false,
		files_withheld: 0,
	});

	seed.store.domains.file_tree = Some(FileTreeView {
		root:      "/repo/veyyon".to_string(),
		entries:   vec![
			FileNode {
				path:  "crates".to_string(),
				name:  "crates".to_string(),
				kind:  FileKind::Directory,
				depth: 0,
			},
			FileNode {
				path:  "crates/veyyon-desktop".to_string(),
				name:  "veyyon-desktop".to_string(),
				kind:  FileKind::Directory,
				depth: 1,
			},
			FileNode {
				path:  "crates/veyyon-desktop-surface".to_string(),
				name:  "veyyon-desktop-surface".to_string(),
				kind:  FileKind::Directory,
				depth: 1,
			},
			FileNode {
				path:  "Cargo.toml".to_string(),
				name:  "Cargo.toml".to_string(),
				kind:  FileKind::File,
				depth: 0,
			},
		],
		truncated: false,
	});
}

/// The terminal, its scrollback and the supervised process the drawer draws.
pub fn add_drawer_content(seed: &mut Seed) {
	seed
		.store
		.capabilities
		.set(Capability::Terminals, CapabilityStatus::Available);
	seed
		.store
		.capabilities
		.set(Capability::ProcessSupervisor, CapabilityStatus::Available);
	seed.store.domains.terminals.push(TerminalView {
		id:     "term_001".to_string(),
		cwd:    "/repo/veyyon".to_string(),
		shell:  "bash".to_string(),
		cols:   80,
		rows:   24,
		status: TerminalStatus::Running,
	});
	// The whole-window states are assembly proofs, so the drawer carries the
	// output a terminal has: an empty grid under the chrome shows the drawer's
	// frame and none of what it frames.
	let mut scrollback = TerminalScrollback::new();
	scrollback.data =
		b"$ cargo check -p veyyon-desktop\r\n    Checking veyyon-desktop v1.0.0 (/repo/veyyon)\r\n    Finished dev [unoptimized + debuginfo] in 2.14s\r\n$ "
			.to_vec();
	seed
		.store
		.domains
		.terminal_output
		.insert("term_001".to_string(), scrollback);
	seed.store.domains.processes.push(ProcessView {
		name:          "cargo-check".to_string(),
		pid:           Some(4201),
		status:        "running".to_string(),
		application:   "cargo".to_string(),
		args:          vec!["check".to_string(), "-p".to_string(), "veyyon-desktop".to_string()],
		cwd:           "/repo/veyyon".to_string(),
		lifetime:      "last-client-exit".to_string(),
		started_at_ms: SCENE_CLOCK_MS - 12_000,
		exit_code:     None,
		terminated_by: None,
	});
}
