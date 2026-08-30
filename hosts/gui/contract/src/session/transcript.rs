//! Transcript view-models: what a renderer draws.
//!
//! Mirrors `@veyyon/wire/presentation/transcript`. One block per message
//! variant the session can hold, carrying display-ready text and flags — never
//! provider payloads or tool argument objects.

use serde::{Deserialize, Serialize};

/// Stable identity of a block across updates. Assigned by the session, opaque
/// here.
pub type BlockId = String;

/// A file or image the operator attached to a message.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Attachment {
	pub kind:           AttachmentKind,
	/// Display name, already shortened for presentation.
	pub name:           String,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub byte_size:      Option<u64>,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub line_count:     Option<u64>,
	/// Why the content was not included. Absent when it was.
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub omitted_reason: Option<OmittedReason>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum AttachmentKind {
	File,
	Image,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum OmittedReason {
	TooLarge,
	Binary,
	NotReplicated,
}

/// One span of an assistant turn, in emission order.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum AssistantSegment {
	Text {
		text: String,
	},
	Thinking {
		text:     String,
		redacted: bool,
	},
	#[serde(rename_all = "camelCase")]
	ToolCall {
		tool_call_id: String,
		tool_name:    String,
		input:        String,
	},
	#[serde(rename_all = "camelCase")]
	Image {
		mime_type: String,
		alt_text:  String,
	},
}

/// Lifecycle of a tool call as the renderer sees it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ToolStatus {
	Pending,
	Running,
	Succeeded,
	Failed,
	Aborted,
	Rejected,
}

/// Why an assistant turn stopped, reduced to what a renderer displays.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum TurnStopReason {
	Complete,
	MaxTokens,
	ToolCall,
	Aborted,
	Error,
}

/// Token accounting for one assistant turn.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnUsage {
	pub input:       u64,
	pub output:      u64,
	pub cache_read:  u64,
	pub cache_write: u64,
	/// Reasoning tokens the provider billed separately, when it reported them.
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub reasoning:   Option<u64>,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub cost_usd:    Option<f64>,
}

/// Presentation weight a host asked for.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Level {
	Info,
	Warning,
	Error,
}

/// Every shape the transcript can hold.
///
/// Exhaustive over the TypeScript union. A renderer that matches on this
/// without a wildcard stops compiling when a member is added, which is the
/// point: a new message kind that silently renders as nothing is a message the
/// operator never sees.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum TranscriptBlock {
	#[serde(rename_all = "camelCase")]
	UserMessage {
		id:          BlockId,
		text:        String,
		attachments: Vec<Attachment>,
		timestamp:   i64,
	},
	/// A developer or system turn the operator can see: rules, injected
	/// instructions.
	#[serde(rename_all = "camelCase")]
	DeveloperMessage { id: BlockId, text: String, timestamp: i64 },
	#[serde(rename_all = "camelCase")]
	AssistantMessage {
		id:            BlockId,
		segments:      Vec<AssistantSegment>,
		/// Model identity as displayed.
		model:         String,
		stop_reason:   TurnStopReason,
		#[serde(default, skip_serializing_if = "Option::is_none")]
		usage:         Option<TurnUsage>,
		/// Set when the turn ended in a provider or transport failure.
		#[serde(default, skip_serializing_if = "Option::is_none")]
		error_message: Option<String>,
		/// True while the turn is still streaming.
		streaming:     bool,
		timestamp:     i64,
	},
	#[serde(rename_all = "camelCase")]
	ToolExecution {
		id:           BlockId,
		tool_call_id: String,
		tool_name:    String,
		status:       ToolStatus,
		/// Arguments rendered for display; secrets already redacted.
		input:        String,
		/// Result text rendered for display. Absent until the call finishes.
		#[serde(default, skip_serializing_if = "Option::is_none")]
		output:       Option<String>,
		#[serde(default, skip_serializing_if = "Option::is_none")]
		error:        Option<String>,
		#[serde(default, skip_serializing_if = "Option::is_none")]
		duration_ms:  Option<u64>,
		timestamp:    i64,
	},
	#[serde(rename_all = "camelCase")]
	BashExecution {
		id:        BlockId,
		command:   String,
		output:    String,
		/// `None` when the process was signalled rather than exiting.
		exit_code: Option<i32>,
		#[serde(default, skip_serializing_if = "Option::is_none")]
		signal:    Option<String>,
		cancelled: bool,
		timestamp: i64,
	},
	#[serde(rename_all = "camelCase")]
	PythonExecution {
		id:        BlockId,
		code:      String,
		output:    String,
		exit_code: Option<i32>,
		cancelled: bool,
		timestamp: i64,
	},
	/// A host-defined message with no meaning here beyond its text.
	#[serde(rename_all = "camelCase")]
	Custom {
		id:          BlockId,
		/// Discriminator the host assigned.
		custom_kind: String,
		text:        String,
		level:       Level,
		timestamp:   i64,
	},
	#[serde(rename_all = "camelCase")]
	Hook { id: BlockId, hook_name: String, text: String, timestamp: i64 },
	#[serde(rename_all = "camelCase")]
	BranchSummary {
		id:             BlockId,
		summary:        String,
		/// Messages the branch replaced.
		replaced_count: u64,
		timestamp:      i64,
	},
	#[serde(rename_all = "camelCase")]
	CompactionSummary {
		id:               BlockId,
		summary:          String,
		/// Messages compaction folded into the summary.
		replaced_count:   u64,
		/// Tokens the compaction reclaimed, when measured.
		#[serde(default, skip_serializing_if = "Option::is_none")]
		reclaimed_tokens: Option<u64>,
		timestamp:        i64,
	},
	#[serde(rename_all = "camelCase")]
	FileMention { id: BlockId, files: Vec<Attachment>, timestamp: i64 },
	/// A failure with no message of its own: a transport reset, a rejected
	/// request.
	#[serde(rename_all = "camelCase")]
	Error {
		id:          BlockId,
		message:     String,
		/// True when the session can continue; false when the turn is dead.
		recoverable: bool,
		timestamp:   i64,
	},
}

impl TranscriptBlock {
	/// The block's id, whichever variant it is. Every variant carries one, and
	/// the session addresses updates by it.
	pub fn id(&self) -> &BlockId {
		match self {
			TranscriptBlock::UserMessage { id, .. }
			| TranscriptBlock::DeveloperMessage { id, .. }
			| TranscriptBlock::AssistantMessage { id, .. }
			| TranscriptBlock::ToolExecution { id, .. }
			| TranscriptBlock::BashExecution { id, .. }
			| TranscriptBlock::PythonExecution { id, .. }
			| TranscriptBlock::Custom { id, .. }
			| TranscriptBlock::Hook { id, .. }
			| TranscriptBlock::BranchSummary { id, .. }
			| TranscriptBlock::CompactionSummary { id, .. }
			| TranscriptBlock::FileMention { id, .. }
			| TranscriptBlock::Error { id, .. } => id,
		}
	}

	/// When the block was produced, in milliseconds since the epoch.
	pub fn timestamp(&self) -> i64 {
		match self {
			TranscriptBlock::UserMessage { timestamp, .. }
			| TranscriptBlock::DeveloperMessage { timestamp, .. }
			| TranscriptBlock::AssistantMessage { timestamp, .. }
			| TranscriptBlock::ToolExecution { timestamp, .. }
			| TranscriptBlock::BashExecution { timestamp, .. }
			| TranscriptBlock::PythonExecution { timestamp, .. }
			| TranscriptBlock::Custom { timestamp, .. }
			| TranscriptBlock::Hook { timestamp, .. }
			| TranscriptBlock::BranchSummary { timestamp, .. }
			| TranscriptBlock::CompactionSummary { timestamp, .. }
			| TranscriptBlock::FileMention { timestamp, .. }
			| TranscriptBlock::Error { timestamp, .. } => *timestamp,
		}
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	/// A block arrives as the session sends it: camelCase fields, kebab-case
	/// tag, absent optionals. This is the exact byte shape the TypeScript
	/// builder emits.
	#[test]
	fn a_block_deserializes_from_the_wire_shape() {
		let json = r#"{
			"kind": "tool-execution",
			"id": "b7",
			"toolCallId": "call_1",
			"toolName": "read",
			"status": "succeeded",
			"input": "{\"path\":\"src/main.rs\"}",
			"output": "fn main() {}",
			"durationMs": 12,
			"timestamp": 1730000000000
		}"#;
		let block: TranscriptBlock = serde_json::from_str(json).expect("deserializes");
		let TranscriptBlock::ToolExecution { tool_name, status, duration_ms, error, .. } = &block
		else {
			panic!("wrong variant: {block:?}");
		};
		assert_eq!(tool_name, "read");
		assert_eq!(*status, ToolStatus::Succeeded);
		assert_eq!(*duration_ms, Some(12));
		assert_eq!(*error, None);
		assert_eq!(block.id(), "b7");
		assert_eq!(block.timestamp(), 1_730_000_000_000);
	}

	/// An absent optional stays absent on the way back out. A renderer that
	/// re-emits a block must not turn `output?: string` into `output: null`,
	/// which the TypeScript side reads as a present empty result.
	#[test]
	fn an_absent_optional_is_not_serialized_as_null() {
		let block = TranscriptBlock::ToolExecution {
			id:           "b1".into(),
			tool_call_id: "c1".into(),
			tool_name:    "read".into(),
			status:       ToolStatus::Running,
			input:        "{}".into(),
			output:       None,
			error:        None,
			duration_ms:  None,
			timestamp:    0,
		};
		let json = serde_json::to_string(&block).expect("serializes");
		assert!(!json.contains("null"), "{json}");
		assert!(!json.contains("output"), "{json}");
		assert!(json.contains(r#""kind":"tool-execution""#), "{json}");
	}

	/// A signalled process has no exit code, and that null has to survive: it is
	/// the difference between "killed" and "exited 0".
	#[test]
	fn a_null_exit_code_survives_both_directions() {
		let json = r#"{
			"kind": "bash-execution",
			"id": "b2",
			"command": "sleep 1",
			"output": "",
			"exitCode": null,
			"signal": "SIGTERM",
			"cancelled": true,
			"timestamp": 0
		}"#;
		let block: TranscriptBlock = serde_json::from_str(json).expect("deserializes");
		let TranscriptBlock::BashExecution { exit_code, signal, .. } = &block else {
			panic!("wrong variant");
		};
		assert_eq!(*exit_code, None);
		assert_eq!(signal.as_deref(), Some("SIGTERM"));

		let out = serde_json::to_string(&block).expect("serializes");
		assert!(out.contains(r#""exitCode":null"#), "{out}");
	}

	/// Segments are tagged the same way blocks are, and their order is the
	/// emission order the model produced.
	#[test]
	fn assistant_segments_keep_their_order_and_tags() {
		let json = r#"{
			"kind": "assistant-message",
			"id": "a1",
			"segments": [
				{ "kind": "thinking", "text": "hm", "redacted": false },
				{ "kind": "text", "text": "here" },
				{ "kind": "tool-call", "toolCallId": "c1", "toolName": "read", "input": "{}" },
				{ "kind": "image", "mimeType": "image/png", "altText": "a chart" }
			],
			"model": "anthropic/claude-sonnet-4",
			"stopReason": "tool-call",
			"streaming": true,
			"timestamp": 0
		}"#;
		let block: TranscriptBlock = serde_json::from_str(json).expect("deserializes");
		let TranscriptBlock::AssistantMessage { segments, stop_reason, streaming, usage, .. } =
			&block
		else {
			panic!("wrong variant");
		};
		assert_eq!(segments.len(), 4);
		assert!(matches!(segments[0], AssistantSegment::Thinking { redacted: false, .. }));
		assert!(matches!(segments[1], AssistantSegment::Text { .. }));
		assert!(matches!(segments[2], AssistantSegment::ToolCall { .. }));
		assert!(matches!(segments[3], AssistantSegment::Image { .. }));
		assert_eq!(*stop_reason, TurnStopReason::ToolCall);
		assert!(*streaming);
		assert_eq!(*usage, None);
	}

	/// Every block variant round-trips through the wire shape unchanged. A
	/// variant whose field names or tag do not survive is one the GUI silently
	/// drops.
	#[test]
	fn every_block_variant_round_trips() {
		for block in crate::fixtures::transcript_blocks() {
			let json = serde_json::to_string(&block).expect("serializes");
			let back: TranscriptBlock =
				serde_json::from_str(&json).unwrap_or_else(|error| panic!("{json}: {error}"));
			assert_eq!(back, block, "{json}");
		}
	}
}
