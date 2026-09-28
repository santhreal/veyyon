//! The MCP page: its page-wide buttons, each server's row, the form that adds
//! a server and the Smithery registry.

use veyyon_desktop_model::SnapshotSectionKind;

use super::{open, press, seed, type_into};
use crate::harness::Win;

/// The MCP page over the corpus servers, `filesystem` among them.
fn servers(w: &mut Win<'_>) {
	seed(w, &[SnapshotSectionKind::Mcp]);
	open(w, "mcp");
}

/// The MCP page's registry section, signed in, with the corpus search that
/// found `acme/search`, reached from its palette row and scrolled to; what
/// opening it sent is dropped.
fn registry(w: &mut Win<'_>) {
	seed(w, &[SnapshotSectionKind::Mcp, SnapshotSectionKind::McpRegistry]);
	w.palette("smithery");
	w.outbox();
}

pub fn refresh(w: &mut Win<'_>) {
	servers(w);
	press(w, "mcp-refresh");
}

pub fn reload(w: &mut Win<'_>) {
	servers(w);
	press(w, "mcp-reload");
}

pub fn switch(w: &mut Win<'_>) {
	servers(w);
	press(w, "mcp-enabled-filesystem");
}

/// A name and a command typed into the add form, then Add server.
pub fn add(w: &mut Win<'_>) {
	servers(w);
	type_into(w, "mcp-add-name", "memory");
	type_into(w, "mcp-add-target", "npx -y server-memory");
	press(w, "mcp-add");
}

pub fn test(w: &mut Win<'_>) {
	servers(w);
	press(w, "mcp-test-filesystem");
}

pub fn reauth(w: &mut Win<'_>) {
	servers(w);
	press(w, "mcp-reauth-filesystem");
}

pub fn clear_auth(w: &mut Win<'_>) {
	servers(w);
	press(w, "mcp-clear-auth-filesystem");
	w.keys("enter");
}

pub fn remove(w: &mut Win<'_>) {
	servers(w);
	press(w, "mcp-remove-filesystem");
	w.keys("enter");
}

pub fn search(w: &mut Win<'_>) {
	registry(w);
	type_into(w, "mcp-registry-search", "memory");
	w.keys("enter");
}

/// Add… on the result unfolds its form, which names the server by default;
/// the key it requires is typed, then Add server.
pub fn deploy(w: &mut Win<'_>) {
	registry(w);
	press(w, "mcp-result-acme/search");
	type_into(w, "mcp-deploy:acme/search:input:apiKey", "sk-typed-1234");
	press(w, "mcp-deploy-acme/search");
}

pub fn login(w: &mut Win<'_>) {
	registry(w);
	press(w, "mcp-registry-login");
}

pub fn logout(w: &mut Win<'_>) {
	registry(w);
	press(w, "mcp-registry-logout");
	w.keys("enter");
}
