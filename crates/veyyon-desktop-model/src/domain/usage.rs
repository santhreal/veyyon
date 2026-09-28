use serde::{Deserialize, Serialize};

use crate::{connection::SessionId, transcript::UsageTotals};

/// Token usage category item in a context window breakdown.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
pub struct ContextCategory {
	/// Category name (e.g., "system", "messages", "tools").
	pub name:   String,
	/// Token count occupied by this category.
	pub tokens: u64,
}

/// Token breakdown of the active session context window.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
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
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
pub struct UsageView {
	/// Owning session identifier.
	pub session: SessionId,
	/// Aggregated token counts and costs.
	pub totals:  UsageTotals,
}

/// A document the host writes a session out as. The host takes no other.
#[derive(
	Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, ts_rs::TS, strum::EnumIter,
)]
#[serde(rename_all = "lowercase")]
pub enum ExportFormat {
	/// A standalone page the host writes to disk.
	Html,
	/// The session's entries, answered in memory.
	Json,
}

impl ExportFormat {
	/// The format as the wire spells it.
	pub const fn as_str(self) -> &'static str {
		match self {
			Self::Html => "html",
			Self::Json => "json",
		}
	}

	/// The format as a person reads it.
	pub const fn label(self) -> &'static str {
		match self {
			Self::Html => "HTML",
			Self::Json => "JSON",
		}
	}
}

impl std::fmt::Display for ExportFormat {
	fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
		f.write_str(self.label())
	}
}

/// Transcript export result or file path snapshot.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
pub struct ExportView {
	/// Exported session identifier.
	pub session: SessionId,
	/// The document the session was written out as.
	pub format:  ExportFormat,
	/// Path where the export file was written, if saved to disk.
	pub path:    Option<String>,
	/// Direct exported content string if returned in memory.
	pub content: Option<String>,
}
