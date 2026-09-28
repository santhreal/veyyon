//! The MCP page: every configured server with its status, tools and switch;
//! test, sign in again, clear the stored login and remove; the outcome of the
//! last test; what the connected servers offer besides tools; the form that
//! adds a server; and the Smithery registry.

use veyyon_desktop_model::{
	HostAction, McpServerStatus, McpServerView, SurfaceId,
	action::McpRequest,
	domain::{McpCatalogView, McpProbeOutcome, McpProbeView, McpServerCatalogView},
};
use veyyon_desktop_ui::{
	controls::{ButtonVariant, DotStatus, StatusDot},
	theme::{ActiveTheme, Palette, space},
};
use veyyon_gpui::{AnyElement, Context, IntoElement, SharedString, Window, div, prelude::*};

use super::{
	Ask, Page, SettingsView,
	widgets::{heading, local_button, note, row, send_button, switch, title},
};

/// The provider the registry sign-in runs under.
pub const REGISTRY: &str = "smithery";

/// Whether the sign-in for `provider` belongs to the MCP page: a server's
/// login runs as `mcp:<server>` and the registry's as `smithery`.
pub fn owns_flow(provider: &str) -> bool {
	provider.starts_with("mcp:") || provider == REGISTRY
}

/// The control a server-level MCP request is sent from.
fn surface(op: &str, server: &str) -> SurfaceId {
	SurfaceId::SettingsField(format!("mcp:{op}:{server}"))
}

impl SettingsView {
	pub(super) fn mcp(&mut self, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
		let palette = cx.theme().palette;
		let domains = &self.app.read(cx).store().domains;
		let mut servers = domains.mcp.clone();
		self.held.servers(&mut servers);
		let probe = domains.mcp_probe.clone();
		let catalog = domains.mcp_catalog.clone();
		let flow = domains
			.auth_flow
			.clone()
			.filter(|flow| owns_flow(&flow.provider));
		let actions = div()
			.flex()
			.gap(space::S2)
			.child(send_button(
				"mcp-refresh",
				"Refresh",
				ButtonVariant::Ghost,
				HostAction::RefreshMcp,
				SurfaceId::SettingsField("mcp:refresh".to_owned()),
				&self.app,
				cx,
			))
			.child(send_button(
				"mcp-reload",
				"Reload all",
				ButtonVariant::Ghost,
				HostAction::McpManage(McpRequest::ReloadMcp),
				SurfaceId::SettingsField("mcp:reload".to_owned()),
				&self.app,
				cx,
			));
		let mut page = div()
			.child(title(Page::Mcp.label(), Page::Mcp.description(), &palette))
			.child(actions);
		if let Some(flow) = flow {
			page = page.child(self.auth_flow(&flow, window, cx));
		}
		page = page.child(heading("Servers", &palette));
		if servers.is_empty() {
			page = page.child(note("No MCP servers configured", &palette));
		}
		for server in &servers {
			page = page.child(self.server(server, &palette, cx));
			if let Some(probe) = probe.as_ref().filter(|probe| probe.server == server.name) {
				page = page.child(note(probe_line(probe), &palette));
			}
		}
		if let Some(catalog) = catalog {
			page = page.children(catalog_rows(&catalog, &palette));
		}
		page = page
			.child(heading("Add a server", &palette))
			.child(self.mcp_add(&palette, window, cx));
		let registry = self.anchored("registry", heading("Smithery registry", &palette));
		page
			.child(registry)
			.child(self.mcp_registry(&palette, window, cx))
			.into_any_element()
	}

	fn server(&self, server: &McpServerView, palette: &Palette, cx: &Context<Self>) -> AnyElement {
		let name = server.name.as_str();
		let (status, state) = match &server.status {
			McpServerStatus::Connected => (DotStatus::Success, "Connected"),
			McpServerStatus::Connecting => (DotStatus::Running, "Connecting"),
			McpServerStatus::Disconnected => (DotStatus::Idle, "Disconnected"),
			McpServerStatus::Error { message } => (DotStatus::Error, message.as_str()),
		};
		let tools = match server.tools.len() {
			0 => "no tools".to_owned(),
			1 => "1 tool".to_owned(),
			count => format!("{count} tools"),
		};
		let detail = if server.tools.is_empty() {
			format!("{state} · {tools}")
		} else {
			format!("{state} · {tools}: {}", server.tools.join(", "))
		};
		let owned = name.to_owned();
		let toggle = switch(
			SharedString::from(format!("mcp-enabled-{name}")),
			server.enabled,
			false,
			move |enabled| {
				let action = HostAction::SetMcpEnabled { server: owned.clone(), enabled };
				(action, SurfaceId::McpEnableToggle(owned.clone()))
			},
			&self.app,
			cx,
		);
		let mut control = div()
			.flex()
			.items_center()
			.gap(space::S1)
			.child(StatusDot::new(status));
		for (op, label, request) in [
			("test", "Test", McpRequest::TestMcpServer { server: name.to_owned() }),
			("reauth", "Sign in again", McpRequest::ReauthMcpServer { server: name.to_owned() }),
		] {
			control = control.child(send_button(
				SharedString::from(format!("mcp-{op}-{name}")),
				label,
				ButtonVariant::Ghost,
				HostAction::McpManage(request),
				surface(op, name),
				&self.app,
				cx,
			));
		}
		let asks = [
			(
				"clear-auth",
				"Sign out",
				format!("Sign out of {name}?"),
				"The server's stored OAuth credential and the auth block that points at it are \
				 deleted.",
				McpRequest::ClearMcpServerAuth { server: name.to_owned() },
			),
			(
				"remove",
				"Remove",
				format!("Remove {name}?"),
				"The server is disconnected and deleted from the profile's MCP config.",
				McpRequest::RemoveMcpServer { server: name.to_owned() },
			),
		];
		for (op, label, question, body, request) in asks {
			let ask_surface = surface(op, name);
			control = control.child(local_button(
				SharedString::from(format!("mcp-{op}-{name}")),
				label,
				ButtonVariant::Ghost,
				cx.listener(move |this, _, window, cx| {
					let ask = Ask {
						title: question.clone(),
						body: body.to_owned(),
						label,
						action: HostAction::McpManage(request.clone()),
						surface: ask_surface.clone(),
					};
					this.confirm(ask, window, cx);
				}),
			));
		}
		row(
			SharedString::from(format!("mcp-{name}")),
			name.to_owned(),
			Some(detail.into()),
			control.child(toggle).into_any_element(),
			palette,
		)
	}
}

/// The line under a server stating what its last test found.
pub fn probe_line(probe: &McpProbeView) -> String {
	match &probe.outcome {
		McpProbeOutcome::Connected { name, version, tools } if tools.is_empty() => {
			format!("Test: connected to {name} {version}, no tools")
		},
		McpProbeOutcome::Connected { name, version, tools } => {
			format!("Test: connected to {name} {version}, {} tools: {}", tools.len(), tools.join(", "))
		},
		McpProbeOutcome::Failed { message } => format!("Test failed: {message}"),
	}
}

/// What the connected servers offer besides tools: one group per server with
/// its prompts, resources and resource templates, and the notifications it
/// sends.
fn catalog_rows(catalog: &McpCatalogView, palette: &Palette) -> Vec<AnyElement> {
	let mut rows = vec![heading("Prompts and resources", palette)];
	rows.push(note(
		if catalog.notifications {
			"Server notifications are on (mcp.notifications)"
		} else {
			"Server notifications are off (mcp.notifications)"
		},
		palette,
	));
	if catalog.servers.is_empty() {
		rows.push(note("No connected server offers prompts or resources", palette));
	}
	for server in &catalog.servers {
		rows.push(row(
			SharedString::from(format!("mcp-catalog-{}", server.server)),
			server.server.clone(),
			Some(offers(server).into()),
			div().into_any_element(),
			palette,
		));
		for prompt in &server.prompts {
			let arguments = prompt
				.arguments
				.iter()
				.map(|argument| {
					if argument.required {
						format!("<{}>", argument.name)
					} else {
						format!("[{}]", argument.name)
					}
				})
				.collect::<Vec<_>>()
				.join(" ");
			let usage = [prompt.command.as_str(), arguments.as_str()].join(" ");
			rows.push(note(join_described(usage.trim(), prompt.description.as_deref()), palette));
		}
		for resource in &server.resources {
			let subscribed = server.subscriptions.contains(&resource.uri);
			let mime = resource
				.mime_type
				.as_deref()
				.map(|mime| format!(" ({mime})"))
				.unwrap_or_default();
			let line = format!(
				"{} {}{mime}{}",
				resource.name,
				resource.uri,
				if subscribed { " (subscribed)" } else { "" }
			);
			rows.push(note(join_described(&line, resource.description.as_deref()), palette));
		}
		for template in &server.templates {
			let line = format!("{} {}", template.name, template.uri_template);
			rows.push(note(join_described(&line, template.description.as_deref()), palette));
		}
	}
	rows
}

/// How many prompts, resources and templates a server lists, and which
/// changes it announces.
pub fn offers(server: &McpServerCatalogView) -> String {
	let counted = |count: usize, one: &str, many: &str| match count {
		1 => format!("1 {one}"),
		count => format!("{count} {many}"),
	};
	let mut parts = vec![
		counted(server.prompts.len(), "prompt", "prompts"),
		counted(server.resources.len(), "resource", "resources"),
		counted(server.templates.len(), "template", "templates"),
	];
	let notifies = server.notifies;
	let announced: Vec<&str> = [
		(notifies.tools_changed, "tools"),
		(notifies.prompts_changed, "prompts"),
		(notifies.resources_changed, "resources"),
	]
	.into_iter()
	.filter_map(|(on, what)| on.then_some(what))
	.collect();
	if !announced.is_empty() {
		parts.push(format!("announces changed {}", announced.join(", ")));
	}
	if notifies.subscribe {
		parts.push("accepts subscriptions".to_owned());
	}
	parts.join(" · ")
}

fn join_described(line: &str, description: Option<&str>) -> String {
	match description.filter(|text| !text.is_empty()) {
		Some(description) => format!("{line} · {description}"),
		None => line.to_owned(),
	}
}
