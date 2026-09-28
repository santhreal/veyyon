use serde::{Deserialize, Serialize};

/// Model provider account and authentication state.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
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

/// How a stored credential signs in, spelled as the credential store spells
/// it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
#[serde(rename_all = "snake_case")]
pub enum CredentialKind {
	/// A login the provider issued, which it refreshes.
	Oauth,
	/// A key stored for the provider.
	ApiKey,
}

/// One credential the host stores for a provider, which `SignOutAccount`
/// names to remove it.
///
/// Only stored credentials are listed: a key read from an environment
/// variable or a config file signs in without being stored, and signing out
/// does not remove it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
pub struct StoredAccountView {
	/// Provider the credential signs in to.
	pub provider:      String,
	/// Row the credential store keeps it under, unique within the host.
	pub credential_id: u64,
	/// The account's chosen name, else its email, organisation or account
	/// id, else the provider and row.
	pub label:         String,
	/// How the credential signs in.
	pub kind:          CredentialKind,
	/// Whether it is the account the provider is set to use on this machine.
	pub selected:      bool,
}

/// Interactive OAuth authentication flow phase.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
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
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
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
