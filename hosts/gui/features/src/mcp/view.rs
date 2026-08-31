//! MCP server status, capability detail, and connection actions.

use gpui::{AnyElement, App, Entity, IntoElement, ParentElement, Styled, div, px};
use veyyon_gui_core::{
	Store, UiCommand,
	model::{McpConnectionPhase, McpServerView, McpState, McpTransport, Versioned},
};
use veyyon_gui_kit::{
	input::Editor,
	motion::{OwnerNamespace, RetainedKey},
	theme::{Theme, space},
	ui::{Badge, Banner, Card, Empty, Fill, Group, Icon, SearchField, Size, Tone, text},
};

use super::logic::{self, VirtualWindow};
use crate::{act, settings::remote};

const PAGE_ROWS: usize = 24;
const SEARCH_OWNER: RetainedKey = RetainedKey::semantic(OwnerNamespace::Settings, 7);

pub fn render(store: &Store, field: &Entity<Editor>, cx: &mut App) -> AnyElement {
	remote::render(
		&store.replica.mcp,
		remote::host_state(&store.connection),
		remote::Copy {
			loading:     "Loading MCP servers",
			empty:       "No MCP servers are configured",
			empty_note:  "Configured servers appear here with their connection and capability status.",
			detached:    "MCP servers are not loaded",
			unavailable: "MCP is unavailable",
		},
		UiCommand::RefreshMcp,
		|versioned: &Versioned<McpState>, mutable, cx| {
			page(&versioned.value, &store.frontend.mcp_query, field, mutable, cx)
		},
		cx,
	)
}

fn page(
	state: &McpState,
	query: &str,
	field: &Entity<Editor>,
	mutable: bool,
	cx: &mut App,
) -> AnyElement {
	let theme = Theme::get(cx);
	text::stack(space::LOOSE)
		.child(
			div()
				.flex()
				.items_center()
				.justify_between()
				.child(text::title("MCP", &theme))
				.child({
					let mut btn = crate::settings::controls::button("refresh-mcp", "Refresh servers")
						.icon(Icon::Running)
						.fill(Fill::Ghost);
					if !mutable {
						btn = btn.disabled("MCP servers are read-only");
					} else {
						btn = btn.on_click(act::click(UiCommand::RefreshMcp));
					}
					btn
				}),
		)
		.child(SearchField::new("mcp-filter", SEARCH_OWNER, field.clone()))
		.child(server_content(state, query, VirtualWindow { first: 0, rows: PAGE_ROWS }, mutable, cx))
		.into_any_element()
}

/// Searchable, bounded MCP server list for settings and focused pickers.
pub fn server_content(
	state: &McpState,
	query: &str,
	window: VirtualWindow,
	mutable: bool,
	cx: &mut App,
) -> AnyElement {
	remote::render(
		&state.servers,
		remote::mutation_state(mutable),
		remote::Copy {
			loading:     "Loading server status",
			empty:       "No MCP servers",
			empty_note:  "The engine has no configured MCP server.",
			detached:    "MCP servers disconnected",
			unavailable: "MCP server status is unavailable",
		},
		UiCommand::RefreshMcp,
		|_, content_mutable, cx| cards(state, query, window, content_mutable, cx),
		cx,
	)
}

fn cards(
	state: &McpState,
	query: &str,
	window: VirtualWindow,
	mutable: bool,
	cx: &mut App,
) -> AnyElement {
	let servers = logic::filtered(state, query, window);
	if servers.is_empty() {
		return Empty::new(if query.trim().is_empty() {
			"No MCP servers"
		} else {
			"No MCP servers match this search"
		})
		.icon(Icon::Search)
		.note("Try the server name, id, or configuration source.")
		.into_any_element();
	}
	let mut stack = text::stack(space::BASE);
	for server in servers {
		stack = stack.child(server_card(server, mutable, cx));
	}
	stack.into_any_element()
}

fn server_card(server: &McpServerView, mutable: bool, cx: &mut App) -> Card {
	let theme = Theme::get(cx);
	let counts = logic::capability_counts(server);
	let tone = match server.phase {
		McpConnectionPhase::Connected => Tone::Ok,
		McpConnectionPhase::Connecting | McpConnectionPhase::AuthenticationRequired => Tone::Warn,
		McpConnectionPhase::Failed => Tone::Danger,
		McpConnectionPhase::Disabled | McpConnectionPhase::Disconnected => Tone::Muted,
	};
	let mut card = Card::new().full_width().child(
		div()
			.flex()
			.flex_wrap()
			.items_center()
			.gap(px(space::BASE))
			.child(
				text::stack(space::PAIR)
					.flex_1()
					.min_w(px(0.0))
					.child(text::label(server.name.clone(), &theme))
					.child(text::meta(
						format!("{} · {}", server.source, transport(&server.transport)),
						&theme,
					)),
			)
			.child(Badge::new(logic::status_label(&server.phase)).tone(tone)),
	);
	let mut enabled =
		crate::settings::controls::switch(format!("mcp-enabled-{}", server.id), server.enabled);
	if mutable {
		enabled = enabled.on_click(act::click(UiCommand::SetMcpEnabled {
			server:  server.id.clone(),
			enabled: !server.enabled,
		}));
	} else {
		enabled = enabled.disabled("MCP configuration is read-only");
	}
	card = card.child(
		div()
			.flex()
			.items_center()
			.justify_between()
			.child(text::label("Enabled", &theme))
			.child(enabled),
	);

	if let Some(reason) = server.auth_required.as_deref() {
		card =
			card.child(Banner::waiting("Server authentication is required").detail(reason.to_owned()));
	}
	if let Some(error) = server.error.as_deref() {
		card = card.child(Banner::failure("Server connection failed").detail(error.to_owned()));
	}

	card = match server.phase {
		McpConnectionPhase::Connected | McpConnectionPhase::Connecting => {
			let mut btn = crate::settings::controls::button(
				format!("disconnect-mcp-{}", server.id),
				"Disconnect",
			)
			.icon(Icon::Stop)
			.fill(Fill::Ghost)
			.size(Size::Small);
			if !mutable {
				btn = btn.disabled("MCP controls are read-only");
			} else {
				btn = btn.on_click(act::click(UiCommand::DisconnectMcp(server.id.clone())));
			}
			card.child(btn)
		},
		McpConnectionPhase::Disconnected
		| McpConnectionPhase::AuthenticationRequired
		| McpConnectionPhase::Failed => {
			let mut btn =
				crate::settings::controls::button(format!("connect-mcp-{}", server.id), "Connect")
					.icon(Icon::Running)
					.fill(Fill::Tinted)
					.tone(Tone::Accent)
					.size(Size::Small);
			if !mutable {
				btn = btn.disabled("MCP controls are read-only");
			} else {
				btn = btn.on_click(act::click(UiCommand::ConnectMcp(server.id.clone())));
			}
			card.child(btn)
		},
		McpConnectionPhase::Disabled => card,
	};

	card
		.child(
			div()
				.flex()
				.flex_wrap()
				.gap(px(space::SNUG))
				.child(Badge::new(format!("{} tools", counts.tools)).exact())
				.child(Badge::new(format!("{} resources", counts.resources)).exact())
				.child(Badge::new(format!("{} prompts", counts.prompts)).exact()),
		)
		.child(server_detail(server, cx))
}

/// Capability detail shared with focused MCP inspectors.
pub fn server_detail(server: &McpServerView, _cx: &mut App) -> AnyElement {
	let mut detail = text::stack(space::BASE);
	if !server.tools.is_empty() {
		let mut group = Group::new("Tools");
		for tool in &server.tools {
			let mut row = crate::settings::controls::row(
				format!("mcp-tool-{}-{}", server.id, tool.name),
				tool.name.clone(),
			);
			if let Some(description) = &tool.description {
				row = row.note(description.clone());
			}
			group = group.child(row);
		}
		detail = detail.child(group);
	}
	if !server.resources.is_empty() {
		let mut group = Group::new("Resources");
		for resource in &server.resources {
			group = group.child(
				crate::settings::controls::row(
					format!("mcp-resource-{}-{}", server.id, resource.uri),
					resource.name.clone(),
				)
				.note(resource.uri.clone()),
			);
		}
		detail = detail.child(group);
	}
	if !server.prompts.is_empty() {
		let mut group = Group::new("Prompts");
		for prompt in &server.prompts {
			let mut row = crate::settings::controls::row(
				format!("mcp-prompt-{}-{}", server.id, prompt.name),
				prompt.name.clone(),
			);
			if let Some(description) = &prompt.description {
				row = row.note(description.clone());
			}
			group = group.child(row);
		}
		detail = detail.child(group);
	}
	if server.tools.is_empty() && server.resources.is_empty() && server.prompts.is_empty() {
		detail = detail.child(
			Empty::new("This server exposes no capabilities")
				.note("No tools, resources, or prompts were reported."),
		);
	}
	detail.into_any_element()
}

fn transport(transport: &McpTransport) -> &str {
	match transport {
		McpTransport::Stdio => "stdio",
		McpTransport::Http => "HTTP",
		McpTransport::Sse => "SSE",
		McpTransport::Unknown(name) => name,
	}
}
