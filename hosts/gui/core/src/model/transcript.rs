//! Lossless transcript/content replicas and render projections.
//!
//! Unknown entries and content remain present as [`Value`]. Markdown, diff,
//! and syntax parsing stays in `crate::text`; projections cache those parser
//! results without narrowing the engine replica.

use super::{EntryId, ModelId, ProviderId, ToolId, Value};
use crate::text::{
	diff::FileDiff,
	markdown::{Md, Span},
};

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub enum MessageRole {
	User,
	Developer,
	Assistant,
	ToolResult,
	BashExecution,
	PythonExecution,
	Custom,
	BranchSummary,
	CompactionSummary,
	FileMention,
	Lifecycle,
	Unknown,
}

#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub enum ContentBlock {
	Text {
		text: String,
	},
	Image {
		media_type: String,
		data:       Vec<u8>,
		alt:        Option<String>,
	},
	Thinking {
		text: String,
	},
	RedactedThinking {
		marker: String,
	},
	ToolCall {
		id:        ToolId,
		name:      String,
		arguments: Value,
	},
	ToolResult {
		tool:     ToolId,
		content:  Value,
		is_error: bool,
	},
	Execution {
		language:  String,
		command:   Option<String>,
		output:    String,
		exit_code: Option<i32>,
	},
	FileMention {
		path:               String,
		has_content:        bool,
		lines:              Option<u64>,
		bytes:              Option<u64>,
		unavailable_reason: Option<String>,
		image:              Option<Vec<u8>>,
	},
	Diff {
		raw: String,
	},
	ModelChange {
		provider: ProviderId,
		model:    ModelId,
	},
	ThinkingChange {
		level: String,
	},
	Lifecycle {
		phase:  String,
		reason: Option<String>,
	},
	Summary {
		kind: String,
		text: String,
	},
	Fallback {
		producer: String,
		value:    Value,
	},
	Unknown {
		tag:   String,
		value: Value,
	},
}

#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct EntryMeta {
	pub provider:    Option<ProviderId>,
	pub model:       Option<ModelId>,
	pub stop_reason: Option<String>,
	pub error:       Option<String>,
	pub usage:       Option<super::UsageTotals>,
}

#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct TranscriptEntry {
	pub id:                EntryId,
	pub parent:            Option<EntryId>,
	pub revision:          u64,
	pub timestamp_ms:      u64,
	pub role:              MessageRole,
	pub content:           Vec<ContentBlock>,
	pub meta:              Option<EntryMeta>,
	pub raw_discriminator: String,
	pub raw:               Value,
}

#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct StreamingMessageState {
	pub entry:        EntryId,
	pub tool:         Option<ToolId>,
	pub accumulating: TranscriptEntry,
	pub revision:     u64,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct TranscriptPagingState {
	pub has_earlier: bool,
	pub before:      Option<EntryId>,
	pub load:        super::CommandState,
}

#[derive(Debug, Clone, PartialEq)]
pub enum RenderProjection {
	Markdown { source_revision: u64, blocks: Vec<Md> },
	Diff { source_revision: u64, files: Vec<FileDiff> },
	Syntax { source_revision: u64, spans: Vec<Span> },
	Unknown { source_revision: u64, value: Value },
}
