//! One of every wire shape, for drawing without a session behind it.
//!
//! The GPU front end draws the same components whether a live session or this
//! module supplies the data, so a layout, a theme or a motion token is checked
//! against every variant before any transport exists. That is also what the
//! drift test enumerates against: a variant with no fixture here has never been
//! rendered.

use crate::{
	capabilities::PresentationCapabilities,
	composer::{CompletionCandidate, CompletionState, ComposerMode, ComposerState},
	events::UiEvent,
	overlay::{DialogResult, DialogViewModel, OverlayAnchor, OverlayViewModel, SelectOption},
	status::{ContextGauge, SessionActivity, SessionCost, StatusLineState, StatusNotice},
	transcript::{
		AssistantSegment, Attachment, AttachmentKind, Level, OmittedReason, ToolStatus,
		TranscriptBlock, TurnStopReason, TurnUsage,
	},
};

/// The instant the fixture session started, in milliseconds since the epoch.
///
/// A wire timestamp is epoch milliseconds, and a renderer formats it as a clock
/// time. Small ordinals would all format as the same second, so the fixtures
/// carry real instants and a front end drawn from them shows the column it will
/// show in a session. Deliberately not midnight: a clock stuck at `00:00:0N`
/// looks like a formatter that lost its input.
const START: i64 = 1_777_300_331_000;

/// A fixture instant, `seconds` after [`START`].
const fn at(seconds: i64) -> i64 {
	START + seconds * 1_000
}

/// One of every [`TranscriptBlock`] variant, and of every sub-variant a block
/// carries.
///
/// The drift test forces the top level to stay complete, by comparing this
/// against the variant space serde reports for the enum. The sub-variants —
/// every [`AssistantSegment`] kind, every [`ToolStatus`], every [`Level`], a
/// signalled process, an omitted attachment — are here because the shell has a
/// branch for each, and a branch that is never drawn is only as correct as the
/// moment it was typed.
pub fn transcript_blocks() -> Vec<TranscriptBlock> {
	let attachment = Attachment {
		kind:           AttachmentKind::File,
		name:           "src/main.rs".into(),
		byte_size:      Some(120),
		line_count:     Some(9),
		omitted_reason: None,
	};
	let omitted = Attachment {
		kind:           AttachmentKind::Image,
		name:           "screenshot.png".into(),
		byte_size:      Some(4_200_000),
		line_count:     None,
		omitted_reason: Some(OmittedReason::TooLarge),
	};
	let mut blocks = vec![
		TranscriptBlock::UserMessage {
			id:          "1".into(),
			text:        "read src/main.rs and tell me what it does".into(),
			attachments: vec![attachment.clone(), omitted.clone()],
			timestamp:   at(1),
		},
		TranscriptBlock::DeveloperMessage {
			id:        "2".into(),
			text:      "Prefer the portable spelling on the lines you already touch.".into(),
			timestamp: at(2),
		},
		TranscriptBlock::AssistantMessage {
			id:            "3".into(),
			segments:      vec![
				AssistantSegment::Text { text: "It parses the arguments and opens a window.".into() },
				AssistantSegment::Thinking {
					text:     "The entry point is short, so read the shell module next.".into(),
					redacted: false,
				},
				AssistantSegment::Thinking { text: String::new(), redacted: true },
				AssistantSegment::ToolCall {
					tool_call_id: "c1".into(),
					tool_name:    "read".into(),
					input:        "{\n  \"path\": \"src/main.rs\"\n}".into(),
				},
				AssistantSegment::Image {
					mime_type: "image/png".into(),
					alt_text:  "the window, drawn from fixtures".into(),
				},
			],
			model:         "anthropic/claude-sonnet-4".into(),
			stop_reason:   TurnStopReason::Complete,
			usage:         Some(TurnUsage {
				input:       10,
				output:      20,
				cache_read:  0,
				cache_write: 0,
				reasoning:   Some(5),
				cost_usd:    Some(0.001),
			}),
			error_message: None,
			streaming:     false,
			timestamp:     at(3),
		},
		TranscriptBlock::AssistantMessage {
			id:            "4".into(),
			segments:      vec![AssistantSegment::Text { text: "Reading the shell".into() }],
			model:         "anthropic/claude-sonnet-4".into(),
			stop_reason:   TurnStopReason::MaxTokens,
			usage:         None,
			error_message: Some("the provider closed the stream".into()),
			streaming:     true,
			timestamp:     at(4),
		},
	];

	blocks.extend(tool_executions());

	blocks.push(TranscriptBlock::BashExecution {
		id:        "20".into(),
		command:   "cargo test -p veyyon-ui".into(),
		output:    "running 14 tests\ntest result: ok. 14 passed".into(),
		exit_code: Some(0),
		signal:    None,
		cancelled: false,
		timestamp: at(20),
	});
	blocks.push(TranscriptBlock::BashExecution {
		id:        "21".into(),
		command:   "sleep 600".into(),
		output:    String::new(),
		exit_code: None,
		signal:    Some("SIGTERM".into()),
		cancelled: true,
		timestamp: at(21),
	});
	blocks.push(TranscriptBlock::PythonExecution {
		id:        "22".into(),
		code:      "sum(range(10))".into(),
		output:    "45".into(),
		exit_code: Some(0),
		cancelled: false,
		timestamp: at(22),
	});

	for (id, level, timestamp) in
		[("30", Level::Info, at(30)), ("31", Level::Warning, at(31)), ("32", Level::Error, at(32))]
	{
		blocks.push(TranscriptBlock::Custom {
			id: id.into(),
			custom_kind: "notice".into(),
			text: format!("a host notice at {level:?} weight"),
			level,
			timestamp,
		});
	}

	blocks.push(TranscriptBlock::Hook {
		id:        "40".into(),
		hook_name: "pre-commit".into(),
		text:      "formatted 3 files".into(),
		timestamp: at(40),
	});
	blocks.push(TranscriptBlock::BranchSummary {
		id:             "41".into(),
		summary:        "forked to try the blade backend".into(),
		replaced_count: 3,
		timestamp:      at(41),
	});
	blocks.push(TranscriptBlock::CompactionSummary {
		id:               "42".into(),
		summary:          "folded the search transcript into one paragraph".into(),
		replaced_count:   40,
		reclaimed_tokens: Some(12_000),
		timestamp:        at(42),
	});
	blocks.push(TranscriptBlock::FileMention {
		id:        "43".into(),
		files:     vec![attachment, omitted],
		timestamp: at(43),
	});
	blocks.push(TranscriptBlock::Error {
		id:          "44".into(),
		message:     "transport reset".into(),
		recoverable: true,
		timestamp:   at(44),
	});
	blocks.push(TranscriptBlock::Error {
		id:          "45".into(),
		message:     "the session cannot continue".into(),
		recoverable: false,
		timestamp:   at(45),
	});

	blocks
}

/// One [`TranscriptBlock::ToolExecution`] per [`ToolStatus`], each carrying the
/// fields that status would have.
fn tool_executions() -> Vec<TranscriptBlock> {
	[
		("10", ToolStatus::Pending, at(10)),
		("11", ToolStatus::Running, at(11)),
		("12", ToolStatus::Succeeded, at(12)),
		("13", ToolStatus::Failed, at(13)),
		("14", ToolStatus::Aborted, at(14)),
		("15", ToolStatus::Rejected, at(15)),
	]
	.into_iter()
	.map(|(id, status, timestamp)| {
		let finished = !matches!(status, ToolStatus::Pending | ToolStatus::Running);
		let failed = matches!(status, ToolStatus::Failed);
		TranscriptBlock::ToolExecution {
			id: id.into(),
			tool_call_id: format!("c{id}"),
			tool_name: "read".into(),
			status,
			input: "{\n  \"path\": \"src/main.rs\"\n}".into(),
			output: finished.then(|| "1: fn main() {\n2: \tshell::run();\n3: }".to_owned()),
			error: failed.then(|| "no such file".to_owned()),
			duration_ms: finished.then_some(42),
			timestamp,
		}
	})
	.collect()
}

/// One of every [`DialogViewModel`] variant.
pub fn dialogs() -> Vec<DialogViewModel> {
	vec![
		DialogViewModel::Confirm {
			id:            "d1".into(),
			title:         "Discard changes?".into(),
			body:          "Three files have unsaved edits.".into(),
			confirm_label: "Discard".into(),
			cancel_label:  "Keep".into(),
			destructive:   true,
		},
		DialogViewModel::Select {
			id:             "d2".into(),
			title:          "Theme".into(),
			options:        vec![
				SelectOption {
					value:       "dark-gruvbox".into(),
					label:       "Gruvbox Dark".into(),
					description: Some("warm, low contrast".into()),
					disabled:    None,
				},
				SelectOption {
					value:       "light-github".into(),
					label:       "GitHub Light".into(),
					description: None,
					disabled:    Some(true),
				},
			],
			selected_index: 0,
			multi:          false,
			filterable:     true,
		},
		DialogViewModel::Prompt {
			id:            "d3".into(),
			title:         "API key".into(),
			placeholder:   "sk-...".into(),
			initial_value: String::new(),
			masked:        true,
		},
		DialogViewModel::ToolApproval {
			id:           "d4".into(),
			tool_call_id: "c9".into(),
			tool_name:    "bash".into(),
			input:        "cargo test --workspace".into(),
			impact:       Some("runs the test suite".into()),
		},
	]
}

/// One of every [`DialogResult`] variant, including both forms of the optional
/// rejection reason.
pub fn dialog_results() -> Vec<DialogResult> {
	vec![
		DialogResult::Cancelled,
		DialogResult::Confirmed,
		DialogResult::Selected { values: vec!["dark-gruvbox".into()] },
		DialogResult::Entered { value: "sk-fake".into() },
		DialogResult::Approved { remember: true },
		DialogResult::Rejected { reason: None },
		DialogResult::Rejected { reason: Some("not this time".into()) },
	]
}

/// One of every [`UiEvent`] variant.
pub fn ui_events() -> Vec<UiEvent> {
	vec![
		UiEvent::Submit { text: "read src/main.rs".into(), attachments: Vec::new() },
		UiEvent::Interrupt,
		UiEvent::Scroll { delta: -12 },
		UiEvent::ScrollToLive,
		UiEvent::SelectToolApproval {
			tool_call_id: "c9".into(),
			approved:     true,
			remember:     false,
		},
		UiEvent::DialogResult { dialog_id: "d1".into(), result: DialogResult::Confirmed },
		UiEvent::Command { command: "theme".into(), args: "dark-gruvbox".into() },
		UiEvent::Resize { width: 1440, height: 900 },
		UiEvent::ComposerChange { text: "read".into(), cursor_offset: 4 },
		UiEvent::Exit { save: true },
	]
}

/// One of every [`OverlayAnchor`], each on an overlay that would plausibly use
/// it.
pub fn overlays() -> Vec<OverlayViewModel> {
	[
		(OverlayAnchor::Center, "Session", true),
		(OverlayAnchor::Top, "Notice", false),
		(OverlayAnchor::Bottom, "Queued", false),
		(OverlayAnchor::Fullscreen, "Themes", true),
	]
	.into_iter()
	.enumerate()
	.map(|(index, (anchor, title, interactive))| OverlayViewModel {
		id: format!("o{index}"),
		anchor,
		title: Some(title.to_owned()),
		rows: vec!["first row".into(), "second row".into()],
		interactive,
		dismissable: true,
	})
	.collect()
}

/// One of every [`ComposerMode`], each with the state that mode would carry.
pub fn composer_states() -> Vec<ComposerState> {
	[
		ComposerMode::Input,
		ComposerMode::Disabled,
		ComposerMode::AwaitingApproval,
		ComposerMode::Shell,
		ComposerMode::Search,
	]
	.into_iter()
	.map(|mode| ComposerState {
		mode,
		text: "read src/".into(),
		cursor_offset: 10,
		placeholder: "Ask anything".into(),
		attachments: Vec::new(),
		completion: (mode == ComposerMode::Input).then(|| CompletionState {
			prefix:         "src/".into(),
			candidates:     vec![
				CompletionCandidate {
					value:  "src/main.rs".into(),
					label:  None,
					detail: Some("120 B".into()),
				},
				CompletionCandidate { value: "src/lib.rs".into(), label: None, detail: None },
			],
			selected_index: 0,
		}),
		queue_on_submit: mode == ComposerMode::AwaitingApproval,
		hint: (mode == ComposerMode::Shell).then(|| "esc to leave shell mode".to_owned()),
	})
	.collect()
}

/// One of every [`SessionActivity`], each on a status line that would carry it.
pub fn status_lines() -> Vec<StatusLineState> {
	[
		SessionActivity::Idle,
		SessionActivity::Thinking,
		SessionActivity::Streaming,
		SessionActivity::ToolRunning,
		SessionActivity::Compacting,
		SessionActivity::WaitingApproval,
	]
	.into_iter()
	.map(|activity| StatusLineState {
		activity,
		model: "anthropic/claude-sonnet-4".into(),
		thinking_level: Some("high".into()),
		context: ContextGauge {
			used:              42_000,
			total:             200_000,
			provider_reported: true,
		},
		cost: SessionCost {
			input_tokens:       41_000,
			output_tokens:      1_000,
			cache_read_tokens:  30_000,
			cache_write_tokens: 5_000,
			total_usd:          0.42,
		},
		working_directory: "~/veyyon".into(),
		git_branch: Some("main".into()),
		elapsed_ms: if activity.is_busy() { 3_200 } else { 0 },
		queued_messages: u32::from(activity == SessionActivity::WaitingApproval),
		notice: (activity == SessionActivity::Compacting)
			.then(|| StatusNotice { level: Level::Info, text: "compacting history".into() }),
	})
	.collect()
}

/// What the GPU surface reports it can do.
pub fn capabilities() -> PresentationCapabilities {
	PresentationCapabilities::GPU
}
