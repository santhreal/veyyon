//! WHY: a control surface is judged by what a click does, and the defect class
//! here is an intent that half-lands — the row highlights but the host is never
//! told to open the session, the card disappears but the approval is never
//! reported, the tab index is clamped to a tab the operator did not click. Each
//! of those renders a plausible frame and loses the operator's decision.
//!
//! The class this closes is "an intent's effect and its reporting disagree".
//! Every variant of `Intent` is swept through one table, and the sweep is an
//! exhaustive match: a variant added to the enum fails to compile here until
//! its two answers — what it changes, and whether a host must hear it — are
//! written down.
//!
//! It does not catch a control wired to the wrong intent, which is the render
//! side and is asserted against the frame's hit rects in
//! `every-control-the-operator-can-see-is-one-the-frame-will-answer.rs`, and it
//! does not catch a host that ignores what it drained.

use std::path::PathBuf;

use veyyon_desktop_model::{
	McpServerStatus, McpServerView, SettingEntry, SettingKind, SurfaceId, ThemesView,
	domain::ThemeView,
};
use veyyon_desktop_surface::{
	Attachment, Badge, Card, ConnectionPhase, ControlError, DiffFile, DiffRow, Intent, Overlay,
	PaletteMode, PaletteState, PanelContent, PanelTab, Row, ScrollBy, Section, SettingsState,
	ShellState, TreeContent, TreeRowItem,
	composer::{MediaType, ModelChoice, QueueMode, ThinkingLevel, TurnPhase, payload_for},
	drawer::{DrawerContent, DrawerTab, ProcessRow},
	intent::Intents,
	terminal::{Cell, CellStyle, Ink},
};

/// A one-signature PNG under a fixed name: enough for a reducer, which never
/// decodes it, and small enough that a sweep of every intent stays cheap.
fn attachment() -> Attachment {
	let bytes = b"\x89PNG\r\n\x1a\n".to_vec();
	Attachment::from_path(
		PathBuf::from("shot.png"),
		MediaType::Png,
		payload_for(MediaType::Png, bytes),
	)
}

/// A send carrying `text` and one image.
fn send(text: &str) -> Intent {
	Intent::Send { text: text.to_owned(), attachments: vec![attachment()] }
}

/// A state with two sections, three tabs, three cards and a closed drawer.
///
/// Built here rather than taken from `fixture` because these assertions name
/// exact positions and counts, and the fixture exists to be awkward to draw.
fn state() -> ShellState {
	ShellState {
		title: "first".to_owned(),
		sections: vec![
			(Section::Live, vec![
				Row {
					id:       7,
					title:    "first".to_owned(),
					subtitle: String::new(),
					badge:    Some(Badge::Working),
					meta:     None,
				},
				Row {
					id:       9,
					title:    "second".to_owned(),
					subtitle: String::new(),
					badge:    None,
					meta:     None,
				},
			]),
			(Section::Parked, vec![Row {
				id:       11,
				title:    "third".to_owned(),
				subtitle: String::new(),
				badge:    None,
				meta:     None,
			}]),
		],
		transcript: Vec::new(),
		turn: TurnPhase::Idle,
		run_status: None,
		panel: PanelContent {
			tabs:       vec![PanelTab::Diff, PanelTab::File, PanelTab::Tree],
			active_tab: PanelTab::Diff,
			diff:       vec![DiffFile {
				path:      "src/main.rs".to_string(),
				old_path:  None,
				status:    veyyon_desktop_model::ChangeStatus::Modified,
				additions: 1,
				deletions: 1,
				rows:      vec![DiffRow::Collapsed { hidden: 10, before_line: 0, after_line: 0 }],
			}],
			file:       None,
			tree:       TreeContent {
				rows:           vec![TreeRowItem {
					path:        "src".to_string(),
					name:        "src".to_string(),
					depth:       0,
					is_dir:      true,
					is_expanded: false,
					changed:     None,
				}],
				selected_path:  None,
				expanded_paths: std::collections::BTreeSet::new(),
			},
			diff_mode:  veyyon_desktop_model::DiffMode::Unified,
		},
		cards: vec![
			Card::Approval { tool: "bash".to_owned(), detail: vec!["rm -rf build".to_owned()] },
			Card::Question {
				prompt:  "Which target?".to_owned(),
				options: vec!["debug".to_owned(), "release".to_owned()],
			},
			Card::Plan { title: "Split the loaders".to_owned(), body: vec!["four files".to_owned()] },
		],
		drawer: DrawerContent {
			tabs:           vec![
				DrawerTab::Terminal { id: "t1".to_owned(), title: "Terminal 1".to_owned() },
				DrawerTab::Terminal { id: "t2".to_owned(), title: "Terminal 2".to_owned() },
			],
			active_tab:     0,
			grid_rows:      vec![vec![Cell {
				c:      'x',
				ink:    Ink::Default,
				bg_ink: Ink::Default,
				style:  CellStyle::new(),
				width:  1,
			}]],
			cursor_col:     0,
			cursor_row:     0,
			cursor_visible: true,
			title:          "term".to_owned(),
			scroll_offset:  1,
			processes:      vec![ProcessRow {
				name:          "build".to_owned(),
				pid:           Some(123),
				status:        "running".to_owned(),
				elapsed_label: "10s".to_owned(),
				terminated_by: None,
				exit_code:     None,
			}],
			selection:      None,
			search:         None,
		},
		drawer_open: false,
		current_id: 7,
		..ShellState::default()
	}
}

/// One intent of every kind, with the two answers the suite checks.
///
/// The match is exhaustive on purpose: adding a variant to `Intent` breaks this
/// function, which is the only place that decides whether a new interaction is
/// the shell's to finish or a host's to answer.
fn every_intent() -> Vec<Intent> {
	let sample = vec![
		Intent::SelectSession(9),
		Intent::SelectTab(1),
		Intent::SetDrawer { open: true },
		Intent::SetDrawer { open: false },
		Intent::Approval { card: 0, approved: true, standing: false },
		Intent::Answer { card: 1, option: 1 },
		Intent::Reply { card: 1, text: "ship it".to_owned() },
		Intent::Plan { card: 2, accepted: false },
		send("ship it"),
		Intent::Steer("steer text".to_owned()),
		Intent::Queue("queue text".to_owned()),
		Intent::AbortTurn,
		Intent::SetQueueMode(QueueMode::Queue),
		Intent::SelectModel(ModelChoice::new("anthropic", "claude-sonnet-4-6")),
		Intent::SetThinking(ThinkingLevel::new("medium")),
		Intent::RemoveAttachment(0),
		Intent::Attach(attachment()),
		Intent::RetryConnection,
		Intent::StartProviderAuth("anthropic".to_owned()),
		Intent::SubmitAuthSecret {
			provider: "anthropic".to_owned(),
			secret:   "sk-ant-...".to_owned(),
		},
		Intent::OpenAuthUrl("https://auth.provider.com/oauth".to_owned()),
		Intent::CancelAuthFlow,
		Intent::RetryAuthFlow,
		Intent::RetryControl(SurfaceId::ConnectionRetryButton),
		Intent::DismissError(SurfaceId::ConnectionRetryButton),
		Intent::OpenOverlay(Box::new(Overlay::Palette(PaletteState::default()))),
		Intent::CloseOverlay,
		Intent::PaletteQuery("find".to_owned()),
		Intent::PaletteMove(1),
		Intent::PaletteRun,
		Intent::PaletteAscend,
		Intent::SettingChanged { key: "font_size".to_owned(), value: serde_json::json!(14) },
		Intent::SelectTheme("light".to_owned()),
		Intent::ResetSetting("font_size".to_owned()),
		Intent::ReloadSettings,
		Intent::SetMcpEnabled { server: "fs".to_owned(), enabled: true },
		Intent::RefreshDiagnostics,
		Intent::RetryDiagnosticSource("github".to_owned()),
		Intent::RefreshUsage,
		Intent::PinSession(7),
		Intent::DeferSession(7),
		Intent::ParkSession(7),
		Intent::FilterQueue("test".to_owned()),
		Intent::NewSession,
		Intent::CloseTabOrPark,
		Intent::MoveQueueSelection(1),
		Intent::ScrollTranscript(ScrollBy::PageDown),
		Intent::FindInTranscript,
		Intent::StepTurn(1),
		Intent::ToggleBlock,
		Intent::ToggleQueue,
		Intent::TogglePanel,
		Intent::SelectDrawerTab(1),
		Intent::TerminalInput(vec![b'a']),
		Intent::ResizeTerminal { cols: 80, rows: 24 },
		Intent::ClearTerminal,
		Intent::RestartTerminal,
		Intent::ProcessStop("build".to_owned()),
		Intent::ProcessRestart("build".to_owned()),
		Intent::ProcessSignal("build".to_owned()),
		Intent::SetDiffMode(veyyon_desktop_model::DiffMode::Split),
		Intent::OpenFile("src/lib.rs".to_owned()),
		Intent::ToggleTreeNode("src".to_owned()),
		Intent::ExpandContext { file: 0, row: 0 },
		Intent::SelectChangeScope(veyyon_desktop_model::ChangeScope::Staged),
	];

	// The exhaustive match is the gate. Every variant is named, so a new one
	// turns this red rather than slipping through the sweep untested.
	for intent in &sample {
		match intent {
			Intent::SelectSession(_)
			| Intent::SelectTab(_)
			| Intent::SetDrawer { .. }
			| Intent::Approval { .. }
			| Intent::Answer { .. }
			| Intent::Reply { .. }
			| Intent::Plan { .. }
			| Intent::Send { .. }
			| Intent::Steer(_)
			| Intent::Queue(_)
			| Intent::AbortTurn
			| Intent::SetQueueMode(_)
			| Intent::SelectModel(_)
			| Intent::SetThinking(_)
			| Intent::RemoveAttachment(_)
			| Intent::Attach(_)
			| Intent::RetryConnection
			| Intent::StartProviderAuth(_)
			| Intent::SubmitAuthSecret { .. }
			| Intent::OpenAuthUrl(_)
			| Intent::CancelAuthFlow
			| Intent::RetryAuthFlow
			| Intent::RetryControl(_)
			| Intent::DismissError(_)
			| Intent::OpenOverlay(_)
			| Intent::CloseOverlay
			| Intent::PaletteQuery(_)
			| Intent::PaletteMove(_)
			| Intent::PaletteRun
			| Intent::PaletteAscend
			| Intent::SettingChanged { .. }
			| Intent::SelectTheme(_)
			| Intent::ResetSetting(_)
			| Intent::ReloadSettings
			| Intent::SetMcpEnabled { .. }
			| Intent::RefreshDiagnostics
			| Intent::RetryDiagnosticSource(_)
			| Intent::RefreshUsage
			| Intent::PinSession(_)
			| Intent::DeferSession(_)
			| Intent::ParkSession(_)
			| Intent::FilterQueue(_)
			| Intent::NewSession
			| Intent::CloseTabOrPark
			| Intent::MoveQueueSelection(_)
			| Intent::ScrollTranscript(_)
			| Intent::FindInTranscript
			| Intent::StepTurn(_)
			| Intent::ToggleBlock
			| Intent::ToggleQueue
			| Intent::TogglePanel
			| Intent::SelectDrawerTab(_)
			| Intent::TerminalInput(_)
			| Intent::ResizeTerminal { .. }
			| Intent::RestartTerminal
			| Intent::ClearTerminal
			| Intent::ProcessStop(_)
			| Intent::ProcessRestart(_)
			| Intent::ProcessSignal(_)
			| Intent::SetDiffMode(_)
			| Intent::OpenFile(_)
			| Intent::ToggleTreeNode(_)
			| Intent::ExpandContext { .. }
			| Intent::SelectChangeScope(_) => {},
		}
	}

	sample
}

#[test]
fn every_intent_either_changes_the_state_or_is_reported_and_never_neither() {
	for intent in every_intent() {
		// The composer is seeded because a send whose composer is already empty
		// changes nothing, and the sweep would then read a working send as a
		// dead one.
		let mut before = state();
		if let Intent::AbortTurn | Intent::SetQueueMode(QueueMode::Queue) = &intent {
			before.turn = TurnPhase::Running { queue_mode: QueueMode::Steer };
		}
		if let Intent::RemoveAttachment(_) = &intent {
			before.composer.attachments = vec![attachment()];
		}
		// The drawer is seeded opposite to the intent for the same reason: a
		// close on a closed drawer is not the close being swept.
		if let Intent::SetDrawer { open } = &intent {
			before.drawer_open = !open;
		}
		if let Intent::DismissError(id) | Intent::RetryControl(id) = &intent {
			before
				.controls
				.set_error(id.clone(), ControlError::new("network error", true));
		}
		if matches!(&intent, Intent::CancelAuthFlow) {
			before.connection = ConnectionPhase::NeedsSecret { provider: "anthropic".to_owned() };
		}
		if let Intent::RetryConnection | Intent::RetryAuthFlow = &intent {
			before.connection = ConnectionPhase::Fatal { message: "disconnected".to_owned() };
		}
		if matches!(&intent, Intent::CloseOverlay) {
			before.overlay = Some(Overlay::Palette(PaletteState::default()));
		}
		if matches!(&intent, Intent::ClearTerminal) {
			before.drawer.grid_rows = vec![vec![Cell {
				c:      'x',
				ink:    Ink::Default,
				bg_ink: Ink::Default,
				style:  CellStyle::new(),
				width:  1,
			}]];
		}
		if let Intent::TerminalInput(_) = &intent {
			before.drawer.scroll_offset = 1;
		}
		if let Intent::PaletteQuery(_) | Intent::PaletteMove(_) | Intent::PaletteRun = &intent {
			before.overlay = Some(Overlay::Palette(PaletteState::commands()));
		}
		if matches!(&intent, Intent::PaletteAscend) {
			let mut p = PaletteState::new(PaletteMode::Browse);
			p.browse_path = vec!["crates".to_owned(), "src".to_owned()];
			before.overlay = Some(Overlay::Palette(p));
		}
		if let Intent::SettingChanged { key, .. } = &intent {
			let mut s = SettingsState::default();
			s.settings.insert(key.clone(), SettingEntry {
				value:       serde_json::json!(12),
				default:     serde_json::json!(12),
				source:      "default".to_string(),
				kind:        SettingKind::Number,
				label:       None,
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
			before.overlay = Some(Overlay::Settings(Box::new(s)));
		}
		if let Intent::ResetSetting(key) = &intent {
			let mut s = SettingsState::default();
			s.settings.insert(key.clone(), SettingEntry {
				value:       serde_json::json!(99),
				default:     serde_json::json!(12),
				source:      "user".to_string(),
				kind:        SettingKind::Number,
				label:       None,
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
			before.overlay = Some(Overlay::Settings(Box::new(s)));
		}
		if let Intent::SelectTheme(_) = &intent {
			before.overlay = Some(Overlay::Settings(Box::new(SettingsState {
				themes: Some(ThemesView {
					themes:  vec![
						ThemeView { id: "dark".to_string(), name: "Dark".to_string(), dark: true },
						ThemeView { id: "light".to_string(), name: "Light".to_string(), dark: false },
					],
					current: "dark".to_string(),
				}),
				..SettingsState::default()
			})));
		}
		if let Intent::SetMcpEnabled { server, .. } = &intent {
			before.overlay = Some(Overlay::Settings(Box::new(SettingsState {
				mcp: vec![McpServerView {
					name:    server.clone(),
					enabled: false,
					status:  McpServerStatus::Disconnected,
					tools:   Vec::new(),
				}],
				..SettingsState::default()
			})));
		}
		if let Intent::ReloadSettings
		| Intent::RefreshDiagnostics
		| Intent::RetryDiagnosticSource(_)
		| Intent::RefreshUsage = &intent
		{
			before.overlay = Some(Overlay::Settings(Box::default()));
		}
		let mut after = before.clone();

		let mut intents = Intents::new();
		intents.dispatch(intent.clone(), &mut after);

		let changed = format!("{after:?}") != format!("{before:?}");
		let reported = !intents.pending().is_empty();

		assert!(
			changed || reported,
			"{intent:?} left the state untouched and was not reported, so nothing an operator can \
			 see happened"
		);
		assert_eq!(
			reported,
			!intent.is_local(),
			"{intent:?} disagrees with its own locality: reported={reported}"
		);
	}
}

#[test]
fn opening_a_session_moves_the_highlight_the_title_and_tells_the_host() {
	let mut state = state();
	let mut intents = Intents::new();

	intents.dispatch(Intent::SelectSession(11), &mut state);

	assert_eq!(state.current_id, 11, "the queue still draws the previous row as open");
	assert_eq!(state.title, "third", "the titlebar still names the previous session");
	assert_eq!(
		intents.pending(),
		[Intent::SelectSession(11)],
		"the host was never asked for the opened session's transcript"
	);
}

#[test]
fn opening_a_session_that_is_not_in_the_queue_keeps_the_title_it_had() {
	let mut state = state();
	let mut intents = Intents::new();

	intents.dispatch(Intent::SelectSession(404), &mut state);

	assert_eq!(state.current_id, 404, "the selection was refused rather than recorded");
	assert_eq!(
		state.title, "first",
		"a session with no row invented a title instead of keeping the last one"
	);
}

#[test]
fn a_tab_out_of_range_is_dropped_rather_than_clamped_to_a_neighbour() {
	let mut state = state();
	let mut intents = Intents::new();

	intents.dispatch(Intent::SelectTab(2), &mut state);
	assert_eq!(
		state.panel.active_tab,
		PanelTab::Tree,
		"the tab that was clicked did not become active"
	);

	// The active tab is moved off the last one first. A clamp and a drop are
	// indistinguishable while the active tab already is the clamp's target,
	// which is the shape a suite passes for the wrong reason in.
	intents.dispatch(Intent::SelectTab(1), &mut state);
	assert_eq!(
		state.panel.active_tab,
		PanelTab::File,
		"the tab that was clicked did not become active"
	);

	for past_the_end in [3, 9, usize::MAX] {
		intents.dispatch(Intent::SelectTab(past_the_end), &mut state);
		assert_eq!(
			state.panel.active_tab,
			PanelTab::File,
			"tab {past_the_end} past the last one moved the panel to a tab nobody clicked"
		);
	}

	assert!(
		intents.pending().is_empty(),
		"switching a tab is the window's own business and was reported to a host"
	);
}

#[test]
fn the_drawer_opens_through_the_host_and_closes_alone_keeping_the_output_it_had() {
	let mut state = state();
	let mut intents = Intents::new();

	intents.dispatch(Intent::SetDrawer { open: true }, &mut state);
	assert!(state.drawer_open, "the drawer did not open");
	assert_eq!(
		intents.drain(),
		[Intent::SetDrawer { open: true }],
		"the pane is the host's terminal, so opening it is the host's to answer"
	);

	intents.dispatch(Intent::SetDrawer { open: false }, &mut state);
	assert!(!state.drawer_open, "the drawer did not close again");
	assert!(intents.pending().is_empty(), "closing the drawer is the window's own business");
	assert!(
		!state.drawer.grid_rows.is_empty(),
		"closing the drawer discarded the output, so reopening it shows an empty pane"
	);
}

#[test]
fn answering_a_card_removes_that_card_and_leaves_the_rest_in_place() {
	let mut state = state();
	let mut intents = Intents::new();
	let answered = Intent::Answer { card: 1, option: 0 };

	intents.dispatch(answered.clone(), &mut state);

	assert_eq!(state.cards.len(), 2, "the answered card was not taken off the stack");
	assert!(
		matches!(state.cards.first(), Some(Card::Approval { .. })),
		"answering the middle card removed the wrong one"
	);
	assert!(
		matches!(state.cards.get(1), Some(Card::Plan { .. })),
		"answering the middle card removed the wrong one"
	);
	assert_eq!(intents.pending(), [answered], "the answer never reached the host");
}

#[test]
fn answering_a_card_position_that_no_longer_exists_removes_nothing() {
	let mut state = state();
	let mut intents = Intents::new();

	intents.dispatch(Intent::Approval { card: 9, approved: true, standing: false }, &mut state);

	assert_eq!(
		state.cards.len(),
		3,
		"a stale card position removed a card the operator did not answer"
	);
}

#[test]
fn an_empty_send_changes_nothing_and_is_never_reported() {
	let mut intents = Intents::new();

	for text in ["", "   ", "\t\n"] {
		let mut state = state();
		state.turn = TurnPhase::Idle;

		intents.dispatch(send(text), &mut state);

		assert_eq!(state.turn, TurnPhase::Idle, "an empty send modified turn phase anyway");
		assert!(
			intents.pending().is_empty(),
			"an empty send was handed to a host, which has no answer for it"
		);
	}
}

#[test]
fn a_send_transitions_turn_phase_and_is_drained_in_the_order_it_happened() {
	let mut state = state();
	state.turn = TurnPhase::Idle;
	let mut intents = Intents::new();

	intents.dispatch(send("ship it"), &mut state);
	intents.dispatch(Intent::SelectSession(9), &mut state);

	assert_eq!(
		state.turn,
		TurnPhase::Running { queue_mode: QueueMode::Steer },
		"send did not transition to running turn phase"
	);

	let drained = intents.drain();
	assert_eq!(
		drained,
		[send("ship it"), Intent::SelectSession(9)],
		"the host received the operator's decisions out of order"
	);
	assert!(
		intents.pending().is_empty(),
		"a drained intent is still pending, so the host will be told twice"
	);
}
