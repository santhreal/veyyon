use serde::{Deserialize, Serialize};

/// Model provider account and authentication state.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProviderView {
	/// Unique provider identifier.
	pub id:            String,
	/// Human-readable provider name.
	pub name:          String,
	/// Flag indicating whether valid credentials exist.
	pub authenticated: bool,
	/// Flag indicating whether OAuth flow is supported.
	pub oauth:         bool,
	/// Flag indicating whether API key authentication is supported.
	pub api_key:       bool,
}

/// Interactive OAuth authentication flow phase.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum AuthFlowState {
	/// Awaiting browser authorization from the user.
	AwaitingBrowser,
	/// Awaiting secret or authorization code input.
	AwaitingSecret,
	/// Authentication completed successfully.
	Completed,
	/// Authentication failed with an error.
	Failed,
	/// Authentication was cancelled.
	Cancelled,
}

/// Active OAuth authentication flow progress.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AuthFlowView {
	/// Provider identifier undergoing authentication.
	pub provider: String,
	/// Current state of the flow.
	pub state:    AuthFlowState,
	/// Authorization URL for browser navigation.
	pub url:      Option<String>,
	/// Prompt text instructing the user on required input.
	pub prompt:   Option<String>,
	/// Status or error message.
	pub message:  Option<String>,
}
