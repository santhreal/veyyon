//! What a settings page with nothing on it draws: the condition, and the step
//! that fills it (§5.9).
//!
//! One definition per page, in one match over `SettingsPage`, so a page added
//! to the enum does not compile until it states what an operator is looking at
//! and what to do about it. A page body reads its own pair from here rather
//! than holding the sentences beside its rows, which is how two of them came to
//! state a condition and no step.

pub use crate::empty::EmptyCopy;
use crate::settings::SettingsPage;

/// The host reported no settings schema at all.
pub const GENERAL_NO_SCHEMA: EmptyCopy = EmptyCopy {
	condition: "No settings reported by host",
	action:    "Verify the host connection: the Settings capability reported no schema",
};

/// A schema arrived and every setting in it is hidden or unmet.
pub const GENERAL_ALL_HIDDEN: EmptyCopy = EmptyCopy {
	condition: "No configurable settings available",
	action:    "Configure settings in ~/.veyyon/config.yml: every reported setting is hidden or \
	            has an unmet condition",
};

/// The step out of a query that narrowed the page to nothing. The condition is
/// the query itself, so the page states that and takes the step from here.
pub const GENERAL_QUERY_ACTION: &str = "Clear or edit the search query";

/// The host reported an empty theme catalogue.
pub const THEMES: EmptyCopy = EmptyCopy {
	condition: "No themes reported by host",
	action:    "Install a theme, or verify host theme discovery: the Themes capability reported an \
	            empty catalog",
};

/// The host reported no providers.
pub const PROVIDERS: EmptyCopy = EmptyCopy {
	condition: "No model providers configured",
	action:    "Set a provider API key in the environment, or declare one in ~/.veyyon/config.yml",
};

/// No sign-in is part-way through.
pub const AUTHENTICATION: EmptyCopy = EmptyCopy {
	condition: "No active authentication flow",
	action:    "Select Sign in on a provider under Settings ▸ Providers to begin authentication",
};

/// No MCP server is declared.
pub const MCP: EmptyCopy = EmptyCopy {
	condition: "No MCP servers configured",
	action:    "Declare a server in .veyyon/mcp.json in the project, or in the profile's \
	            agent/mcp.json",
};

/// No extension and no subagent is registered.
pub const EXTENSIONS: EmptyCopy = EmptyCopy {
	condition: "No extensions or subagents registered",
	action:    "Start a task using the field above, or declare an extension in ~/.veyyon/config.yml",
};

/// The host sent no telemetry.
pub const DIAGNOSTICS: EmptyCopy = EmptyCopy {
	condition: "No diagnostic information available",
	action:    "Verify the host connection, or inspect service health: the Diagnostics capability \
	            reported no telemetry",
};

/// Nothing has been spent in this session yet.
pub const USAGE: EmptyCopy = EmptyCopy {
	condition: "No usage data recorded for active session",
	action:    "Submit a prompt in the composer to begin session accounting",
};

/// The host reported no breakdown of the context window.
pub const CONTEXT_BREAKDOWN: EmptyCopy = EmptyCopy {
	condition: "No context window breakdown available",
	action:    "Submit a prompt in the composer to calculate allocation: the ContextBreakdown \
	            capability reported no data",
};

/// The host listed no profile at all, which the profile it runs under rules
/// out unless the listing never arrived.
pub const PROFILES: EmptyCopy = EmptyCopy {
	condition: "No profiles reported by host",
	action:    "Open this page again to ask the host: the Profiles capability reported no profile, \
	            not even the one this host runs under",
};

/// What `page` draws when it has nothing, or `None` for a page that draws rows
/// instead of an empty state.
///
/// Keybindings is the one page that draws rows: a host that reports no
/// bindings leaves the shipped defaults, which are read-only and are what the
/// presses actually match, so stating that nothing is bound would be false
/// (§5.13).
#[must_use]
pub const fn empty_copy(page: SettingsPage) -> Option<EmptyCopy> {
	Some(match page {
		SettingsPage::General => GENERAL_NO_SCHEMA,
		SettingsPage::Themes => THEMES,
		SettingsPage::Keybindings => return None,
		SettingsPage::Providers => PROVIDERS,
		SettingsPage::Authentication => AUTHENTICATION,
		SettingsPage::Mcp => MCP,
		SettingsPage::Extensions => EXTENSIONS,
		SettingsPage::Diagnostics => DIAGNOSTICS,
		SettingsPage::Usage => USAGE,
		SettingsPage::ContextBreakdown => CONTEXT_BREAKDOWN,
		SettingsPage::Profiles => PROFILES,
	})
}
