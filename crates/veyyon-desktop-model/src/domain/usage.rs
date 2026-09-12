use serde::{Deserialize, Serialize};

use crate::{connection::SessionId, transcript::UsageTotals};

/// Token usage category item in a context window breakdown.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ContextCategory {
	/// Category name (e.g., "system", "messages", "tools").
	pub name:   String,
	/// Token count occupied by this category.
	pub tokens: u64,
}

/// Token breakdown of the active session context window.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ContextBreakdownView {
	/// Owning session identifier.
	pub session:      SessionId,
	/// Total tokens currently consumed.
	pub total_tokens: u64,
	/// Maximum context window token ceiling if known.
	pub limit_tokens: Option<u64>,
	/// Breakdown of tokens by category.
	pub categories:   Vec<ContextCategory>,
}

/// Session resource and financial cost accounting totals.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct UsageView {
	/// Owning session identifier.
	pub session: SessionId,
	/// Aggregated token counts and costs.
	pub totals:  UsageTotals,
}

/// Transcript export result or file path snapshot.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ExportView {
	/// Exported session identifier.
	pub session: SessionId,
	/// Export format (e.g., "html", "markdown", "json").
	pub format:  String,
	/// Path where the export file was written, if saved to disk.
	pub path:    Option<String>,
	/// Direct exported content string if returned in memory.
	pub content: Option<String>,
}
