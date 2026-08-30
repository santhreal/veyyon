//! One transcript block, drawn.
//!
//! [`block`] matches [`TranscriptBlock`] with no wildcard arm. A member added
//! to the contract stops this file compiling, which is the point: a message
//! kind that renders as nothing is a message the operator never sees.
//!
//! Every card is a [`veyyon_gui_kit::surface`] at [`Level::Raised`], with the
//! fill replaced when the block has a ground role of its own — a user turn, a
//! tool call's status. The edge and the radius stay with the level, so a card
//! added here cannot end up with a different corner from every other card.

use gpui::{AnyElement, App, Div, Hsla, IntoElement, ParentElement, SharedString, Styled};
use veyyon_gui_contract::session::transcript::{
	AssistantSegment, Attachment, AttachmentKind, Level as Weight, OmittedReason, ToolStatus,
	TranscriptBlock, TurnStopReason, TurnUsage,
};
use veyyon_gui_kit::{
	Level,
	chrome::{bytes, chip, clock, column, duration, row, rule, tokens, well},
	surface,
	text::{body, caption, label, title},
	theme::ActiveTheme,
	tokens::space,
};
use veyyon_gui_motion::enter;
use veyyon_gui_theme::Role;

/// A transcript block as an element, entering as it lands.
pub fn block(value: &TranscriptBlock, cx: &App) -> AnyElement {
	enter(SharedString::from(value.id().clone()), card(value, cx)).into_any_element()
}

/// The scrolling transcript.
///
/// One column of [`veyyon_gui_kit::tokens::layout::READING`], centred, with the
/// cards filling it: every card shares a left and right edge, so a short
/// message does not read as a narrower card than the one above it.
pub fn region(blocks: &[TranscriptBlock], cx: &App) -> gpui::Stateful<Div> {
	use gpui::{InteractiveElement, StatefulInteractiveElement, div};
	use veyyon_gui_kit::tokens::layout;

	let mut stack = column(space::LOOSE)
		.w(layout::READING)
		.children(blocks.iter().map(|value| block(value, cx)));
	if blocks.is_empty() {
		stack = stack.child(empty(cx));
	}

	div()
		.id("transcript")
		.flex_1()
		.min_h_0()
		.w_full()
		.overflow_y_scroll()
		.p(space::WIDE)
		.flex()
		.flex_col()
		.items_center()
		.child(stack)
}

/// The card itself, without the entrance. Split out so a rebuilt transcript can
/// draw a block that has already landed without replaying its entrance.
pub fn card(value: &TranscriptBlock, cx: &App) -> Div {
	let ground = ground_of(value, cx);
	let shell = surface(Level::Raised, cx)
		.w_full()
		.p(space::BASE)
		.flex()
		.flex_col()
		.gap(space::SNUG);
	let shell = match ground {
		None => shell,
		Some(fill) => shell.bg(fill),
	};
	shell.child(header(value, cx)).child(contents(value, cx))
}

/// The role a block replaces its card's fill with, or `None` to keep the
/// level's own.
///
/// Separate from [`ground_of`] so the table is readable without an `App`, which
/// is what lets the sweep in the tests check every variant against a real
/// palette instead of a second copy of this match.
pub fn ground_role(value: &TranscriptBlock) -> Option<Role> {
	let role = match value {
		TranscriptBlock::UserMessage { .. } => Role::MessageUserBg,
		TranscriptBlock::DeveloperMessage { .. } | TranscriptBlock::Hook { .. } => {
			Role::MessageCustomBg
		},
		TranscriptBlock::ToolExecution { status, .. } => match status {
			ToolStatus::Pending | ToolStatus::Running => Role::ToolPendingBg,
			ToolStatus::Succeeded => Role::ToolSuccessBg,
			ToolStatus::Failed | ToolStatus::Aborted | ToolStatus::Rejected => Role::ToolErrorBg,
		},
		TranscriptBlock::AssistantMessage { .. }
		| TranscriptBlock::BashExecution { .. }
		| TranscriptBlock::PythonExecution { .. }
		| TranscriptBlock::Custom { .. }
		| TranscriptBlock::BranchSummary { .. }
		| TranscriptBlock::CompactionSummary { .. }
		| TranscriptBlock::FileMention { .. }
		| TranscriptBlock::Error { .. } => return None,
	};
	Some(role)
}

/// [`ground_role`] resolved against the active palette.
fn ground_of(value: &TranscriptBlock, cx: &App) -> Option<Hsla> {
	ground_role(value).map(|role| cx.color(role))
}

/// The card's top line: what the block is, then its clock time.
fn header(value: &TranscriptBlock, cx: &App) -> Div {
	row(space::SNUG)
		.w_full()
		.justify_between()
		.child(row(space::TIGHT).children(marks(value, cx)))
		.child(caption(clock(value.timestamp()), cx))
}

/// The chips that name the block: its kind, then whatever qualifies it.
fn marks(value: &TranscriptBlock, cx: &App) -> Vec<Div> {
	match value {
		TranscriptBlock::UserMessage { attachments, .. } => {
			let mut marks = vec![chip("you", Role::MessageUserText, cx)];
			if !attachments.is_empty() {
				marks.push(chip(format!("{} attached", attachments.len()), Role::TextMuted, cx));
			}
			marks
		},
		TranscriptBlock::DeveloperMessage { .. } => {
			vec![chip("developer", Role::MessageCustomLabel, cx)]
		},
		TranscriptBlock::AssistantMessage {
			model, stop_reason, streaming, error_message, ..
		} => {
			let mut marks = vec![chip(model.clone(), Role::TextAccent, cx)];
			if *streaming {
				marks.push(chip("streaming", Role::StateInfo, cx));
			}
			marks.push(chip(stop_label(*stop_reason), stop_role(*stop_reason), cx));
			if error_message.is_some() {
				marks.push(chip("failed", Role::StateError, cx));
			}
			marks
		},
		TranscriptBlock::ToolExecution { tool_name, status, duration_ms, .. } => {
			let mut marks = vec![
				chip(tool_name.clone(), Role::ToolName, cx),
				chip(status_label(*status), status_role(*status), cx),
			];
			if let Some(ms) = duration_ms {
				marks.push(chip(duration(*ms), Role::TextMuted, cx));
			}
			marks
		},
		TranscriptBlock::BashExecution { exit_code, signal, cancelled, .. } => {
			let mut marks = vec![chip("bash", Role::ModeBash, cx)];
			marks.extend(exit_marks(*exit_code, signal.as_deref(), *cancelled, cx));
			marks
		},
		TranscriptBlock::PythonExecution { exit_code, cancelled, .. } => {
			let mut marks = vec![chip("python", Role::ModePython, cx)];
			marks.extend(exit_marks(*exit_code, None, *cancelled, cx));
			marks
		},
		TranscriptBlock::Custom { custom_kind, level, .. } => {
			vec![chip(custom_kind.clone(), weight_role(*level), cx)]
		},
		TranscriptBlock::Hook { hook_name, .. } => {
			vec![chip(hook_name.clone(), Role::MessageCustomLabel, cx)]
		},
		TranscriptBlock::BranchSummary { replaced_count, .. } => vec![
			chip("branch", Role::TextSecondary, cx),
			chip(format!("{replaced_count} replaced"), Role::TextMuted, cx),
		],
		TranscriptBlock::CompactionSummary { replaced_count, reclaimed_tokens, .. } => {
			let mut marks = vec![
				chip("compacted", Role::TextSecondary, cx),
				chip(format!("{replaced_count} folded"), Role::TextMuted, cx),
			];
			if let Some(reclaimed) = reclaimed_tokens {
				marks.push(chip(format!("{} reclaimed", tokens(*reclaimed)), Role::StateSuccess, cx));
			}
			marks
		},
		TranscriptBlock::FileMention { files, .. } => {
			vec![chip(format!("{} files", files.len()), Role::TextSecondary, cx)]
		},
		TranscriptBlock::Error { recoverable, .. } => {
			vec![chip(if *recoverable { "error" } else { "fatal" }, Role::StateError, cx)]
		},
	}
}

/// The card's body.
fn contents(value: &TranscriptBlock, cx: &App) -> Div {
	match value {
		TranscriptBlock::UserMessage { text, attachments, .. } => column(space::SNUG)
			.child(body(text.clone(), cx).text_color(cx.color(Role::MessageUserText)))
			.children(attachments.iter().map(|file| attachment(file, cx))),
		TranscriptBlock::DeveloperMessage { text, .. } => column(space::SNUG)
			.child(body(text.clone(), cx).text_color(cx.color(Role::MessageCustomText))),
		TranscriptBlock::AssistantMessage { segments, usage, error_message, .. } => {
			let mut stack =
				column(space::SNUG).children(segments.iter().map(|part| segment(part, cx)));
			if let Some(message) = error_message {
				stack = stack.child(body(message.clone(), cx).text_color(cx.color(Role::StateError)));
			}
			match usage {
				None => stack,
				Some(counted) => stack
					.child(rule(Role::StrokeSubtle, cx))
					.child(accounting(*counted, cx)),
			}
		},
		TranscriptBlock::ToolExecution { input, output, error, .. } => {
			let mut stack = column(space::SNUG).child(well(input.clone(), Role::TextSecondary, cx));
			if let Some(text) = output {
				stack = stack.child(well(text.clone(), Role::ToolOutput, cx));
			}
			match error {
				None => stack,
				Some(text) => stack.child(well(text.clone(), Role::StateError, cx)),
			}
		},
		TranscriptBlock::BashExecution { command, output, .. } => {
			execution(format!("$ {command}"), output, cx)
		},
		TranscriptBlock::PythonExecution { code, output, .. } => {
			execution(format!(">>> {code}"), output, cx)
		},
		TranscriptBlock::Custom { text, level, .. } => {
			column(space::SNUG).child(body(text.clone(), cx).text_color(cx.color(weight_role(*level))))
		},
		TranscriptBlock::Hook { text, .. } => column(space::SNUG)
			.child(body(text.clone(), cx).text_color(cx.color(Role::MessageCustomText))),
		TranscriptBlock::BranchSummary { summary, .. }
		| TranscriptBlock::CompactionSummary { summary, .. } => column(space::SNUG)
			.child(body(summary.clone(), cx).text_color(cx.color(Role::TextSecondary))),
		TranscriptBlock::FileMention { files, .. } => {
			column(space::TIGHT).children(files.iter().map(|file| attachment(file, cx)))
		},
		TranscriptBlock::Error { message, .. } => {
			column(space::SNUG).child(body(message.clone(), cx).text_color(cx.color(Role::StateError)))
		},
	}
}

/// A command or a snippet, then whatever it printed.
fn execution(invocation: String, output: &str, cx: &App) -> Div {
	let stack = column(space::SNUG).child(well(invocation, Role::TextPrimary, cx));
	if output.is_empty() {
		return stack.child(caption("no output", cx));
	}
	stack.child(well(output.to_owned(), Role::ToolOutput, cx))
}

/// One span of an assistant turn.
fn segment(value: &AssistantSegment, cx: &App) -> Div {
	match value {
		AssistantSegment::Text { text } => body(text.clone(), cx),
		AssistantSegment::Thinking { text, redacted } => {
			let content = if *redacted {
				"reasoning withheld by the provider".to_owned()
			} else {
				text.clone()
			};
			body(content, cx)
				.italic()
				.text_color(cx.color(Role::MessageThinkingText))
		},
		AssistantSegment::ToolCall { tool_name, input, .. } => column(space::TIGHT)
			.child(chip(tool_name.clone(), Role::ToolName, cx))
			.child(well(input.clone(), Role::TextSecondary, cx)),
		AssistantSegment::Image { mime_type, alt_text } => column(space::TIGHT)
			.child(chip(mime_type.clone(), Role::TextMuted, cx))
			.child(caption(alt_text.clone(), cx)),
	}
}

/// A file or image a message carried.
fn attachment(value: &Attachment, cx: &App) -> Div {
	let kind = match value.kind {
		AttachmentKind::File => "file",
		AttachmentKind::Image => "image",
	};
	let mut line = row(space::TIGHT)
		.child(chip(kind, Role::TextMuted, cx))
		.child(label(value.name.clone(), cx));
	if let Some(size) = value.byte_size {
		line = line.child(caption(bytes(size), cx));
	}
	if let Some(lines) = value.line_count {
		line = line.child(caption(format!("{lines} lines"), cx));
	}
	match value.omitted_reason {
		None => line,
		Some(reason) => line.child(chip(omitted_label(reason), Role::StateWarning, cx)),
	}
}

/// What one turn cost.
fn accounting(value: TurnUsage, cx: &App) -> Div {
	let mut line = row(space::SNUG)
		.child(caption(format!("in {}", tokens(value.input)), cx))
		.child(caption(format!("out {}", tokens(value.output)), cx));
	if value.cache_read > 0 || value.cache_write > 0 {
		line = line.child(caption(
			format!("cache {} / {}", tokens(value.cache_read), tokens(value.cache_write)),
			cx,
		));
	}
	if let Some(reasoning) = value.reasoning {
		line = line.child(caption(format!("reasoning {}", tokens(reasoning)), cx));
	}
	match value.cost_usd {
		None => line,
		Some(cost) => line.child(caption(format!("${cost:.4}"), cx)),
	}
}

/// The chips a finished process gets: how it ended, and whether it was
/// interrupted.
fn exit_marks(exit_code: Option<i32>, signal: Option<&str>, cancelled: bool, cx: &App) -> Vec<Div> {
	let mut marks = Vec::new();
	match (exit_code, signal) {
		(Some(0), _) => marks.push(chip("exit 0", Role::StateSuccess, cx)),
		(Some(code), _) => marks.push(chip(format!("exit {code}"), Role::StateError, cx)),
		(None, Some(name)) => marks.push(chip(name.to_owned(), Role::StateWarning, cx)),
		(None, None) => marks.push(chip("no exit status", Role::StateWarning, cx)),
	}
	if cancelled {
		marks.push(chip("cancelled", Role::TextMuted, cx));
	}
	marks
}

fn status_label(value: ToolStatus) -> &'static str {
	match value {
		ToolStatus::Pending => "pending",
		ToolStatus::Running => "running",
		ToolStatus::Succeeded => "ok",
		ToolStatus::Failed => "failed",
		ToolStatus::Aborted => "aborted",
		ToolStatus::Rejected => "rejected",
	}
}

fn status_role(value: ToolStatus) -> Role {
	match value {
		ToolStatus::Pending => Role::TextMuted,
		ToolStatus::Running => Role::StateInfo,
		ToolStatus::Succeeded => Role::StateSuccess,
		ToolStatus::Failed => Role::StateError,
		ToolStatus::Aborted | ToolStatus::Rejected => Role::StateWarning,
	}
}

fn stop_label(value: TurnStopReason) -> &'static str {
	match value {
		TurnStopReason::Complete => "complete",
		TurnStopReason::MaxTokens => "hit the token ceiling",
		TurnStopReason::ToolCall => "calling a tool",
		TurnStopReason::Aborted => "aborted",
		TurnStopReason::Error => "error",
	}
}

fn stop_role(value: TurnStopReason) -> Role {
	match value {
		TurnStopReason::Complete => Role::TextMuted,
		TurnStopReason::ToolCall => Role::StateInfo,
		TurnStopReason::MaxTokens | TurnStopReason::Aborted => Role::StateWarning,
		TurnStopReason::Error => Role::StateError,
	}
}

fn weight_role(value: Weight) -> Role {
	match value {
		Weight::Info => Role::StateInfo,
		Weight::Warning => Role::StateWarning,
		Weight::Error => Role::StateError,
	}
}

fn omitted_label(value: OmittedReason) -> &'static str {
	match value {
		OmittedReason::TooLarge => "too large to send",
		OmittedReason::Binary => "binary",
		OmittedReason::NotReplicated => "not replicated",
	}
}

/// An empty transcript.
pub fn empty(cx: &App) -> Div {
	column(space::SNUG)
		.items_center()
		.child(title("Nothing yet", cx))
		.child(caption("The session has produced no blocks.", cx))
}

#[cfg(test)]
mod tests {
	//! WHY THIS SUITE EXISTS.
	//!
	//! The renderer maps a wire variant to a role and a label through match arms
	//! with no wildcard. The compiler covers a missing arm; it does not cover an
	//! arm that maps two different states to the same appearance, which is the
	//! failure here — a failed tool call that looks like a successful one, a
	//! fatal error that looks recoverable.
	//!
	//! WHAT IT DOES NOT CATCH. Anything that needs a window: layout, wrapping,
	//! which element ends up on top. The app's capture covers those.

	use veyyon_gui_contract::fixtures;

	use super::*;

	/// Every tool status has a distinguishable label, and the roles group them
	/// the way an operator reads them: one success, one info, one failure, and
	/// the two "stopped without running" cases together.
	#[test]
	fn tool_statuses_do_not_collide() {
		let all = [
			ToolStatus::Pending,
			ToolStatus::Running,
			ToolStatus::Succeeded,
			ToolStatus::Failed,
			ToolStatus::Aborted,
			ToolStatus::Rejected,
		];
		let mut labels: Vec<&str> = all.iter().copied().map(status_label).collect();
		labels.sort_unstable();
		let count = labels.len();
		labels.dedup();
		assert_eq!(labels.len(), count, "two statuses share a label");

		assert_eq!(status_role(ToolStatus::Succeeded), Role::StateSuccess);
		assert_eq!(status_role(ToolStatus::Failed), Role::StateError);
		assert_ne!(status_role(ToolStatus::Running), status_role(ToolStatus::Pending));
	}

	/// A stop reason that ended the turn early never reads as completion.
	#[test]
	fn an_early_stop_never_reads_as_complete() {
		for reason in [TurnStopReason::MaxTokens, TurnStopReason::Aborted, TurnStopReason::Error] {
			assert_ne!(
				stop_role(reason),
				stop_role(TurnStopReason::Complete),
				"{reason:?} reads as complete"
			);
			assert_ne!(stop_label(reason), stop_label(TurnStopReason::Complete));
		}
	}

	/// The three presentation weights map to three different roles. Collapsing
	/// two of them makes a warning indistinguishable from an error.
	#[test]
	fn the_three_weights_map_to_three_roles() {
		let roles = [Weight::Info, Weight::Warning, Weight::Error].map(weight_role);
		assert_eq!(roles, [Role::StateInfo, Role::StateWarning, Role::StateError]);
	}

	/// Every omitted reason says something different, because the operator's
	/// next action differs: shrink the file, convert it, or check the host.
	#[test]
	fn omitted_reasons_do_not_collide() {
		let labels = [OmittedReason::TooLarge, OmittedReason::Binary, OmittedReason::NotReplicated]
			.map(omitted_label);
		assert_eq!(labels.len(), 3);
		assert_ne!(labels[0], labels[1]);
		assert_ne!(labels[1], labels[2]);
		assert_ne!(labels[0], labels[2]);
	}

	/// Exactly the block kinds that carry a ground of their own replace the
	/// card's fill, and every other kind keeps it.
	///
	/// The list is pinned by exact equality and swept from the fixtures, so
	/// adding a block kind turns this red until someone decides whether it has a
	/// ground. That is the intended failure: a kind that silently keeps the card
	/// fill is a kind nobody chose an appearance for.
	#[test]
	fn exactly_the_kinds_with_their_own_ground_replace_the_card_fill() {
		let mut grounded: Vec<String> = Vec::new();
		let mut plain: Vec<String> = Vec::new();
		for value in fixtures::transcript_blocks() {
			let kind = kind_of(&value);
			let bucket = if ground_role(&value).is_some() {
				&mut grounded
			} else {
				&mut plain
			};
			if !bucket.contains(&kind) {
				bucket.push(kind);
			}
		}
		grounded.sort();
		plain.sort();

		assert_eq!(grounded, ["developer-message", "hook", "tool-execution", "user-message"]);
		assert_eq!(plain, [
			"assistant-message",
			"bash-execution",
			"branch-summary",
			"compaction-summary",
			"custom",
			"error",
			"file-mention",
			"python-execution",
		]);
	}

	/// A tool call's ground follows its status, and the three statuses that
	/// cannot be told apart from the ground alone are the ones whose chip
	/// carries the difference.
	#[test]
	fn a_tool_calls_ground_follows_its_status() {
		let ground = |status| {
			let block = TranscriptBlock::ToolExecution {
				id: "t".into(),
				tool_call_id: "c".into(),
				tool_name: "read".into(),
				status,
				input: String::new(),
				output: None,
				error: None,
				duration_ms: None,
				timestamp: 0,
			};
			ground_role(&block).expect("a tool call carries its own ground")
		};

		assert_eq!(ground(ToolStatus::Pending), Role::ToolPendingBg);
		assert_eq!(ground(ToolStatus::Running), Role::ToolPendingBg);
		assert_eq!(ground(ToolStatus::Succeeded), Role::ToolSuccessBg);
		for status in [ToolStatus::Failed, ToolStatus::Aborted, ToolStatus::Rejected] {
			assert_eq!(ground(status), Role::ToolErrorBg, "{status:?} does not ground as a failure");
		}
	}

	/// The wire tag of a block, read out of its own serialization rather than a
	/// name written here. A tag renamed in the contract renames here too.
	fn kind_of(value: &TranscriptBlock) -> String {
		let json = serde_json::to_value(value).expect("a block serializes");
		json
			.get("kind")
			.and_then(serde_json::Value::as_str)
			.expect("a block carries its tag")
			.to_owned()
	}
}
