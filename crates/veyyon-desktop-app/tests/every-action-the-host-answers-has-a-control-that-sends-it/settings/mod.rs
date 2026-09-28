//! Senders the settings sheet draws: each page's controls, and the load a
//! page sends as the operator opens it.
//!
//! A drive that presses a control first opens its page the operator way (the
//! settings chord and a nav entry, or a palette row) and drops what opening
//! it sent, so the load a page sends on the way is never taken for the
//! request of the control pressed after it. A drive whose kind is that load
//! keeps what the opening sent: the opening is its gesture.

mod extensions;
mod general;
mod mcp;
mod providers;

use veyyon_desktop_model::{HostActionKind as Kind, SnapshotSectionKind};

use crate::{
	Sender,
	harness::{Win, corpus},
};

pub const SENDERS: &[Sender] = &[
	Sender {
		kind:    Kind::LoadSettings,
		control: "the settings chord, which opens the General page",
		drive:   general::chord,
	},
	Sender {
		kind:    Kind::SetSetting,
		control: "the General page's switch of a boolean setting",
		drive:   general::flip_switch,
	},
	Sender {
		kind:    Kind::ResetSetting,
		control: "the General page's Reset of a setting off its default",
		drive:   general::reset,
	},
	Sender {
		kind:    Kind::LoadThemes,
		control: "the settings nav entry Appearance",
		drive:   general::appearance_entry,
	},
	Sender {
		kind:    Kind::LoadKeybindings,
		control: "the palette row Keybindings, reached as /hotkeys",
		drive:   general::hotkeys_row,
	},
	Sender {
		kind:    Kind::SetKeybinding,
		control: "the Keybindings page's Edit input, submitted with Enter",
		drive:   general::rebind,
	},
	Sender {
		kind:    Kind::RefreshProviders,
		control: "the palette row Sign out of an account…, reached as /logout",
		drive:   providers::logout_row,
	},
	Sender {
		kind:    Kind::StartProviderAuth,
		control: "the Providers page's Sign in button of a provider",
		drive:   providers::sign_in,
	},
	Sender {
		kind:    Kind::SubmitAuthSecret,
		control: "the sign-in card's code input, submitted with Enter",
		drive:   providers::paste_code,
	},
	Sender {
		kind:    Kind::OpenAuthUrl,
		control: "the sign-in card's Open sign-in page button",
		drive:   providers::open_sign_in_page,
	},
	Sender {
		kind:    Kind::CancelAuthFlow,
		control: "the sign-in card's Cancel button",
		drive:   providers::cancel,
	},
	Sender {
		kind:    Kind::RetryAuthFlow,
		control: "the failed sign-in card's Try again button",
		drive:   providers::retry,
	},
	Sender {
		kind:    Kind::SignOutAccount,
		control: "a stored account's Sign out, confirmed with Enter",
		drive:   providers::sign_out,
	},
	Sender {
		kind:    Kind::RefreshMcp,
		control: "the MCP page's Refresh button",
		drive:   mcp::refresh,
	},
	Sender {
		kind:    Kind::ReloadMcp,
		control: "the MCP page's Reload all button",
		drive:   mcp::reload,
	},
	Sender { kind: Kind::SetMcpEnabled, control: "an MCP server's switch", drive: mcp::switch },
	Sender {
		kind:    Kind::AddMcpServer,
		control: "the MCP page's Add server form",
		drive:   mcp::add,
	},
	Sender {
		kind:    Kind::TestMcpServer,
		control: "an MCP server's Test button",
		drive:   mcp::test,
	},
	Sender {
		kind:    Kind::ReauthMcpServer,
		control: "an MCP server's Sign in again button",
		drive:   mcp::reauth,
	},
	Sender {
		kind:    Kind::ClearMcpServerAuth,
		control: "an MCP server's Sign out, confirmed with Enter",
		drive:   mcp::clear_auth,
	},
	Sender {
		kind:    Kind::RemoveMcpServer,
		control: "an MCP server's Remove, confirmed with Enter",
		drive:   mcp::remove,
	},
	Sender {
		kind:    Kind::SearchMcpRegistry,
		control: "the Smithery registry's search input, submitted with Enter",
		drive:   mcp::search,
	},
	Sender {
		kind:    Kind::DeployMcpRegistryServer,
		control: "a registry result's Add server button",
		drive:   mcp::deploy,
	},
	Sender {
		kind:    Kind::LoginMcpRegistry,
		control: "the Smithery registry's Sign in button",
		drive:   mcp::login,
	},
	Sender {
		kind:    Kind::LogoutMcpRegistry,
		control: "the Smithery registry's Sign out, confirmed with Enter",
		drive:   mcp::logout,
	},
	Sender {
		kind:    Kind::RefreshExtensions,
		control: "the settings nav entry Extensions",
		drive:   extensions::entry,
	},
	Sender {
		kind:    Kind::SetExtensionEnabled,
		control: "an extension item's switch",
		drive:   extensions::item_switch,
	},
	Sender {
		kind:    Kind::SetExtensionSourceEnabled,
		control: "an extension source's switch",
		drive:   extensions::source_switch,
	},
];

/// Applies the corpus entry of each of `sections`, as the host sending them.
fn seed(w: &mut Win<'_>, sections: &[SnapshotSectionKind]) {
	w.apply(sections.iter().map(|kind| corpus(*kind)).collect());
}

/// Opens settings with their chord, clicks the nav entry of `page` and drops
/// what opening them sent.
fn open(w: &mut Win<'_>, page: &str) {
	w.keys("secondary-,");
	w.click(&format!("settings.page:{page}"));
	w.outbox();
}

/// Clicks the control `settings.control:<id>` of the page shown.
fn press(w: &mut Win<'_>, id: &str) {
	w.click(&format!("settings.control:{id}"));
}

/// Clicks the input `settings.field:<key>` of the page shown and types
/// `text` into it.
fn type_into(w: &mut Win<'_>, key: &str, text: &str) {
	w.click(&format!("settings.field:{key}"));
	w.typed(text);
}
