//! Diagnostics, notices, usage, and context accounting replicas.

use super::{AgentId, FileId, NoticeId, ProviderId};

#[derive(
	Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, serde::Serialize, serde::Deserialize,
)]
pub enum DiagnosticLevel {
	Information,
	Warning,
	Error,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct DiagnosticView {
	pub id:             NoticeId,
	pub source:         String,
	pub level:          DiagnosticLevel,
	pub message:        String,
	pub path:           Option<String>,
	pub line:           Option<u32>,
	pub column:         Option<u32>,
	pub occurred_at_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct DiagnosticSourceError {
	pub source:    String,
	pub message:   String,
	pub retryable: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct DiagnosticsSnapshot {
	pub notices:                Vec<DiagnosticView>,
	pub files:                  Vec<(FileId, Vec<DiagnosticView>)>,
	pub source_errors:          Vec<DiagnosticSourceError>,
	pub startup_health:         Vec<DiagnosticView>,
	pub session_resume_warning: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct UsageTotals {
	pub input_tokens:         u64,
	pub output_tokens:        u64,
	pub cache_read_tokens:    u64,
	pub cache_write_tokens:   u64,
	pub orchestration_tokens: u64,
	pub premium_requests:     u64,
	pub cost_microusd:        Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct ContextUsage {
	pub tokens:         u64,
	pub context_window: Option<u64>,
	pub percent_milli:  Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct ContextCategory {
	pub id:     String,
	pub label:  String,
	pub tokens: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct ContextSnapshot {
	pub current:    ContextUsage,
	pub categories: Vec<ContextCategory>,
	pub estimated:  bool,
	pub error:      Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct UsageSnapshot {
	pub session:       UsageTotals,
	pub current_turn:  Option<UsageTotals>,
	pub context:       ContextUsage,
	pub agents:        Vec<(AgentId, UsageTotals)>,
	pub provider:      Option<ProviderId>,
	pub pricing_known: bool,
}
