//! Settings pages enumeration and metadata (§5.9).
//!
//! Exposes the ten protocol-driven settings and diagnostic categories.

use serde::{Deserialize, Serialize};
use strum::EnumIter;

/// Categorical settings pages (§5.9).
#[derive(
	Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, EnumIter, Serialize, Deserialize,
)]
pub enum SettingsPage {
	/// General host configuration (JSON key-value table).
	General,
	/// Color themes and appearance.
	Themes,
	/// Keyboard shortcuts and action bindings.
	Keybindings,
	/// AI model providers and accounts.
	Providers,
	/// Interactive OAuth authentication flows.
	Authentication,
	/// Model Context Protocol servers and exposed tools.
	Mcp,
	/// Background subagents and system extensions.
	Extensions,
	/// System health diagnostics and service statuses.
	Diagnostics,
	/// Token consumption metrics and financial costs.
	Usage,
	/// Active session context window token allocation.
	ContextBreakdown,
}

impl SettingsPage {
	/// Display title for the settings category.
	#[must_use]
	pub const fn title(self) -> &'static str {
		match self {
			Self::General => "General",
			Self::Themes => "Themes",
			Self::Keybindings => "Keybindings",
			Self::Providers => "Providers",
			Self::Authentication => "Authentication",
			Self::Mcp => "MCP Servers",
			Self::Extensions => "Extensions",
			Self::Diagnostics => "Diagnostics",
			Self::Usage => "Usage & Costs",
			Self::ContextBreakdown => "Context Breakdown",
		}
	}

	/// Explanatory summary describing what this settings page configures.
	#[must_use]
	pub const fn description(self) -> &'static str {
		match self {
			Self::General => "Host runtime flags, file paths, and general behavior preferences.",
			Self::Themes => "Color themes, editor palettes, and visual ground tints.",
			Self::Keybindings => "Configured keyboard shortcuts and key combinations.",
			Self::Providers => "Configured model provider endpoints and credential status.",
			Self::Authentication => "Active OAuth authorization and browser consent workflows.",
			Self::Mcp => "Model Context Protocol servers providing external tool capabilities.",
			Self::Extensions => "Active background subagents and task execution engines.",
			Self::Diagnostics => "System health checks, connection status, and error telemetry.",
			Self::Usage => "Aggregated input, output, cache tokens, and session expenditures.",
			Self::ContextBreakdown => "Token allocation by category within the model context window.",
		}
	}
}
