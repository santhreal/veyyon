//! The MCP server requests beyond listing and toggling: adding, removing and
//! testing a server, its OAuth login, a forced rediscovery, and the Smithery
//! registry a server can be deployed from.

use serde::{Deserialize, Serialize};

/// How a server added from the window is reached.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
pub enum McpServerTarget {
	/// A local process the host spawns and speaks to over stdio.
	Command {
		/// The executable.
		command: String,
		/// Its arguments, in order.
		args:    Vec<String>,
	},
	/// A remote server over streamable HTTP.
	Http {
		/// The endpoint. A URL without a scheme is read as `https://`.
		url:   String,
		/// A bearer token sent as the `Authorization` header. Without one the
		/// host detects whether the server wants OAuth and runs the login.
		token: Option<String>,
	},
	/// A remote server over server-sent events.
	Sse {
		/// The endpoint. A URL without a scheme is read as `https://`.
		url:   String,
		/// A bearer token sent as the `Authorization` header.
		token: Option<String>,
	},
}

/// One value the operator supplied for a registry server's configuration.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
pub struct McpRegistryInputValue {
	/// The input's key, as the registry result states it.
	pub key:   String,
	/// The value.
	pub value: String,
}

/// The MCP management requests, each tagged as the wire names it.
///
/// A family of its own rather than ten more variants of `HostAction`: the
/// variant that holds this is `untagged`, so a window still sends
/// `{"RemoveMcpServer": {…}}` and the host still reads one flat action.
///
/// Every server the requests name is read from the profile's own MCP config
/// file or from the servers the host discovered; a repository's `mcp.json` is
/// never read, written or connected to.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
pub enum McpRequest {
	/// Write a server into the profile's MCP config, connect it and activate
	/// its tools. A name already configured is refused rather than replaced.
	AddMcpServer {
		/// The server's name, which prefixes its tools.
		name:   String,
		/// How it is reached.
		target: McpServerTarget,
	},
	/// Disconnect a server and delete it from the profile's MCP config.
	RemoveMcpServer {
		/// The server's name.
		server: String,
	},
	/// Connect to a server once, list its tools and disconnect, leaving the
	/// running connection as it was. The outcome arrives as `McpProbe`.
	TestMcpServer {
		/// The server's name.
		server: String,
	},
	/// Run the server's OAuth login again. The login is drawn through
	/// `AuthFlow` under the provider `mcp:<server>`, and cancelled with
	/// `CancelAuthFlow` naming that provider.
	ReauthMcpServer {
		/// The server's name.
		server: String,
	},
	/// Delete the server's stored OAuth credential and the `auth` block that
	/// points at it.
	ClearMcpServerAuth {
		/// The server's name.
		server: String,
	},
	/// Disconnect every server, re-read every MCP config and connect again,
	/// re-running any credential command a config names.
	ReloadMcp,
	/// Search the Smithery registry. Results arrive as `McpRegistry`.
	SearchMcpRegistry {
		/// The words to search for.
		query:    String,
		/// How many results to return, 1 to 100; the host's default when
		/// absent.
		limit:    Option<u16>,
		/// Rank by meaning rather than by name and use count.
		semantic: bool,
	},
	/// Add a server from the last registry search under a name.
	DeployMcpRegistryServer {
		/// The result's id, as `McpRegistry` states it.
		result: String,
		/// The name to add it under. A name already configured is refused.
		server: String,
		/// Values for the result's inputs. A required input left out is
		/// refused.
		inputs: Vec<McpRegistryInputValue>,
	},
	/// Sign in to Smithery in the browser, drawn through `AuthFlow` under the
	/// provider `smithery`. An API key submitted with `SubmitAuthSecret` for
	/// that provider is validated and stored instead.
	LoginMcpRegistry,
	/// Delete the stored Smithery API key.
	LogoutMcpRegistry,
}
