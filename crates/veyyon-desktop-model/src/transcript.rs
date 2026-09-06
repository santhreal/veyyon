use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use crate::connection::EntryId;

/// Message participant role classification across twelve protocol variants.
#[derive(
	Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize, strum::EnumIter,
)]
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

impl MessageRole {
	/// Complete slice of all twelve message roles for runtime test sweeps.
	pub const ALL: [Self; 12] = [
		Self::User,
		Self::Developer,
		Self::Assistant,
		Self::ToolResult,
		Self::BashExecution,
		Self::PythonExecution,
		Self::Custom,
		Self::BranchSummary,
		Self::CompactionSummary,
		Self::FileMention,
		Self::Lifecycle,
		Self::Unknown,
	];
}

/// Rich content block payload representing an element within a transcript turn
/// across sixteen variants.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, strum::EnumDiscriminants)]
#[strum_discriminants(name(BlockKind), derive(Hash, PartialOrd, Ord, strum::EnumIter))]
#[strum_discriminants(
	doc = "Fieldless projection of `ContentBlock`, so a scene gate can sweep every block kind."
)]
pub enum ContentBlock {
	Text {
		text: String,
	},
	Image {
		media_type: String,
		data:       Vec<u8>,
		alt:        Option<String>,
	},
	/// A video clip the operator attached. The host sends its descriptor and
	/// never its payload: the desktop cannot play it inline and a clip runs to
	/// tens of megabytes.
	Video {
		media_type: String,
		bytes:      u64,
	},
	Thinking {
		text: String,
	},
	RedactedThinking {
		marker: String,
	},
	ToolCall {
		id:        String,
		name:      String,
		arguments: serde_json::Value,
	},
	ToolResult {
		tool:     String,
		content:  serde_json::Value,
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
		lines:              Option<u32>,
		bytes:              Option<u64>,
		unavailable_reason: Option<String>,
		image:              Option<Vec<u8>>,
	},
	Diff {
		raw: String,
	},
	ModelChange {
		provider: String,
		model:    String,
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
		value:    serde_json::Value,
	},
	Unknown {
		tag:   String,
		value: serde_json::Value,
	},
}

/// Token and financial accounting totals associated with a turn.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct UsageTotals {
	pub input_tokens:         u64,
	pub output_tokens:        u64,
	pub cache_read_tokens:    u64,
	pub cache_write_tokens:   u64,
	pub orchestration_tokens: u64,
	pub premium_requests:     u32,
	pub cost_microusd:        Option<u64>,
}

/// Metadata describing model generation, stop conditions, and resource usage.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct EntryMeta {
	pub provider:    Option<String>,
	pub model:       Option<String>,
	pub stop_reason: Option<String>,
	pub error:       Option<String>,
	pub usage:       Option<UsageTotals>,
}

/// Fully revisioned node within a session's transcript tree.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TranscriptEntry {
	pub id:                EntryId,
	pub parent:            Option<EntryId>,
	pub revision:          u64,
	pub timestamp_ms:      u64,
	pub role:              MessageRole,
	pub content:           Vec<ContentBlock>,
	pub meta:              Option<EntryMeta>,
	pub raw_discriminator: String,
	pub raw:               serde_json::Value,
}

/// Tree data structure managing hierarchically branching transcript entries.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct TranscriptTree {
	pub entries:      HashMap<EntryId, TranscriptEntry>,
	pub root_entries: Vec<EntryId>,
	pub children:     HashMap<EntryId, Vec<EntryId>>,
	pub active_leaf:  Option<EntryId>,
	pub revision:     u64,
}

impl TranscriptTree {
	/// Creates an empty transcript tree.
	#[must_use]
	pub fn new() -> Self {
		Self {
			entries:      HashMap::new(),
			root_entries: Vec::new(),
			children:     HashMap::new(),
			active_leaf:  None,
			revision:     0,
		}
	}

	/// Appends a new entry to the tree, updating child indexes and active leaf.
	pub fn append(&mut self, entry: TranscriptEntry) {
		let entry_id = entry.id.clone();
		let parent_id = entry.parent.clone();
		self.revision = self.revision.max(entry.revision);

		if let Some(parent) = parent_id {
			self
				.children
				.entry(parent)
				.or_default()
				.push(entry_id.clone());
		} else if !self.root_entries.contains(&entry_id) {
			self.root_entries.push(entry_id.clone());
		}

		self.entries.insert(entry_id.clone(), entry);
		self.active_leaf = Some(entry_id);
	}

	/// Updates an existing entry in place, refreshing revision and content
	/// without altering topology.
	pub fn update(&mut self, entry: TranscriptEntry) {
		let entry_id = entry.id.clone();
		self.revision = self.revision.max(entry.revision);
		self.entries.insert(entry_id, entry);
	}

	/// Retrieves a transcript entry by its identifier.
	#[must_use]
	pub fn get(&self, id: &EntryId) -> Option<&TranscriptEntry> {
		self.entries.get(id)
	}

	/// Returns the number of entries stored in the tree.
	#[must_use]
	pub fn len(&self) -> usize {
		self.entries.len()
	}

	/// Returns true if the tree contains no entries.
	#[must_use]
	pub fn is_empty(&self) -> bool {
		self.entries.is_empty()
	}
}
