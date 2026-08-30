//! Status-line view-model: the session state a renderer keeps visible.
//!
//! Mirrors `@veyyon/wire/presentation/status`. Every field is already reduced
//! to what is displayed — no model objects, no provider handles, no timers.

use serde::{Deserialize, Serialize};

/// What the session is doing right now.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum SessionActivity {
	Idle,
	Thinking,
	Streaming,
	ToolRunning,
	Compacting,
	WaitingApproval,
}

impl SessionActivity {
	/// True when the session is working and the surface should show motion.
	///
	/// The one place that decides it, so a spinner, a pulsing border and a
	/// status glyph cannot disagree about whether the session is busy.
	pub const fn is_busy(self) -> bool {
		!matches!(self, SessionActivity::Idle)
	}
}

/// Context-window occupancy, as measured for this session.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextGauge {
	/// Tokens currently in the window.
	pub used:              u64,
	/// Window size the session is measured against.
	pub total:             u64,
	/// True when `total` came from the provider rather than the catalog.
	pub provider_reported: bool,
}

impl ContextGauge {
	/// Occupancy in 0..=1, or `None` when the window size is unknown.
	///
	/// `total` of zero reaches here from a provider that reported no window, and
	/// dividing by it would produce a bar of NaN width, which lays out as
	/// nothing and looks like an empty context.
	pub fn fraction(self) -> Option<f32> {
		if self.total == 0 {
			return None;
		}
		#[expect(
			clippy::cast_precision_loss,
			reason = "token counts are far below f32's exact range"
		)]
		Some((self.used as f32 / self.total as f32).clamp(0.0, 1.0))
	}
}

/// Cumulative spend for the session.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionCost {
	pub input_tokens:       u64,
	pub output_tokens:      u64,
	pub cache_read_tokens:  u64,
	pub cache_write_tokens: u64,
	pub total_usd:          f64,
}

/// One transient notice pinned to the status line.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StatusNotice {
	pub level: crate::session::transcript::Level,
	pub text:  String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StatusLineState {
	pub activity:          SessionActivity,
	/// Model identity as displayed.
	pub model:             String,
	/// Reasoning effort as displayed, absent when the model has none.
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub thinking_level:    Option<String>,
	pub context:           ContextGauge,
	pub cost:              SessionCost,
	/// Working directory, already shortened for presentation.
	pub working_directory: String,
	/// Branch name when the working directory is a git checkout.
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub git_branch:        Option<String>,
	/// Elapsed wall-clock milliseconds of the current activity; 0 while idle.
	pub elapsed_ms:        u64,
	/// Queued messages waiting for the current turn to finish.
	pub queued_messages:   u32,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub notice:            Option<StatusNotice>,
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn the_status_line_deserializes_from_the_wire_shape() {
		let json = r#"{
			"activity": "tool-running",
			"model": "anthropic/claude-sonnet-4",
			"thinkingLevel": "high",
			"context": { "used": 42000, "total": 200000, "providerReported": true },
			"cost": {
				"inputTokens": 41000,
				"outputTokens": 1000,
				"cacheReadTokens": 30000,
				"cacheWriteTokens": 5000,
				"totalUsd": 0.42
			},
			"workingDirectory": "~/veyyon",
			"gitBranch": "main",
			"elapsedMs": 3200,
			"queuedMessages": 1
		}"#;
		let state: StatusLineState = serde_json::from_str(json).expect("deserializes");
		assert_eq!(state.activity, SessionActivity::ToolRunning);
		assert!(state.activity.is_busy());
		assert_eq!(state.thinking_level.as_deref(), Some("high"));
		assert_eq!(state.git_branch.as_deref(), Some("main"));
		assert_eq!(state.notice, None);
		assert_eq!(state.context.fraction(), Some(0.21));
	}

	/// Only `idle` is not busy. Every other activity drives motion, and a new
	/// activity that defaults to "not busy" would silently freeze the spinner.
	#[test]
	fn only_idle_is_not_busy() {
		let busy = [
			SessionActivity::Thinking,
			SessionActivity::Streaming,
			SessionActivity::ToolRunning,
			SessionActivity::Compacting,
			SessionActivity::WaitingApproval,
		];
		assert!(!SessionActivity::Idle.is_busy());
		for activity in busy {
			assert!(activity.is_busy(), "{activity:?} reads as idle");
		}
	}

	/// A window size of zero produces no fraction rather than NaN. A NaN width
	/// lays out as nothing, which looks like an empty context window.
	#[test]
	fn an_unknown_window_size_produces_no_fraction() {
		let gauge =
			ContextGauge { used: 100, total: 0, provider_reported: false };
		assert_eq!(gauge.fraction(), None);
	}

	/// Occupancy is bounded even when the session overran the window it was
	/// measured against, which happens when the provider reports a smaller
	/// window than the catalog did.
	#[test]
	fn occupancy_is_bounded_at_both_ends() {
		let over =
			ContextGauge { used: 300, total: 100, provider_reported: true };
		assert_eq!(over.fraction(), Some(1.0));
		let empty =
			ContextGauge { used: 0, total: 100, provider_reported: true };
		assert_eq!(empty.fraction(), Some(0.0));
	}
}
