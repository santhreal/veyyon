//! The MCP page's Smithery registry: whether a key is stored, with sign in
//! and sign out; the search; and each result with the form that adds it
//! under a name with the values its configuration asks for.

use veyyon_desktop_model::{
	HostAction, SurfaceId,
	action::{McpRegistryInputValue, McpRequest},
	domain::McpRegistryResultView,
};
use veyyon_desktop_ui::{
	controls::{ButtonVariant, Toggle},
	theme::{Palette, TypeStyled, space, text},
};
use veyyon_gpui::{AnyElement, Context, IntoElement, SharedString, Window, div, prelude::*};

use super::{
	Ask, SettingsView,
	widgets::{input_box, local_button, note, row, send_button},
};

/// The field key of the search input.
const SEARCH: &str = "mcp-registry-search";
/// The error key of the add form.
const DEPLOY: &str = "mcp-deploy";

/// The field key of the name a result is added under.
fn name_key(result: &str) -> String {
	format!("mcp-deploy:{result}:name")
}

/// The field key of one input of a result.
fn input_key(result: &str, input: &str) -> String {
	format!("mcp-deploy:{result}:input:{input}")
}

impl SettingsView {
	pub(super) fn mcp_registry(
		&mut self,
		palette: &Palette,
		window: &mut Window,
		cx: &mut Context<Self>,
	) -> AnyElement {
		let registry = self.app.read(cx).store().domains.mcp_registry.clone();
		let signed_in = registry.as_ref().is_some_and(|registry| registry.signed_in);
		// Signing in again replaces a stored key the registry rejects
		// (`MCP_REGISTRY_KEY_REJECTED`); signed out, it is the only control
		// (`MCP_REGISTRY_SIGNED_OUT`).
		let login = send_button(
			"mcp-registry-login",
			if signed_in {
				"Sign in again"
			} else {
				"Sign in"
			},
			ButtonVariant::Secondary,
			HostAction::McpManage(McpRequest::LoginMcpRegistry),
			SurfaceId::SettingsField("mcp:registry-login".to_owned()),
			&self.app,
			cx,
		);
		let mut account = div().flex().items_center().gap(space::S2).child(login);
		if signed_in {
			account = account.child(local_button(
				"mcp-registry-logout",
				"Sign out",
				ButtonVariant::Ghost,
				cx.listener(|this, _, window, cx| {
					let ask = Ask {
						title:   "Sign out of Smithery?".to_owned(),
						body:    "The stored Smithery API key is deleted.".to_owned(),
						label:   "Sign out",
						action:  HostAction::McpManage(McpRequest::LogoutMcpRegistry),
						surface: SurfaceId::SettingsField("mcp:registry-logout".to_owned()),
					};
					this.confirm(ask, window, cx);
				}),
			));
		}
		let state = if signed_in {
			"Signed in"
		} else {
			"Not signed in"
		};
		let query =
			self.field(SEARCH, "", "Search servers by name or purpose", submit_search, window, cx);
		let semantic = cx.listener(|this, on: &bool, _, cx| {
			this.mcp_semantic = *on;
			cx.notify();
		});
		let search = div()
			.flex()
			.items_center()
			.gap(space::S2)
			.child(div().flex_1().child(input_box(SEARCH, query, palette)))
			.child(local_button(
				"mcp-registry-search",
				"Search",
				ButtonVariant::Secondary,
				cx.listener(|this, _, window, cx| {
					submit_search(this, SEARCH, String::new(), window, cx);
				}),
			))
			.child(
				Toggle::new("mcp-registry-semantic", self.mcp_semantic)
					.on_change(move |on, window, cx| semantic(&on, window, cx)),
			)
			.child(
				div()
					.type_style(text::SMALL)
					.text_color(palette.text.muted)
					.child("By meaning"),
			);
		let mut section = div()
			.flex()
			.flex_col()
			.gap(space::S2)
			.child(row(
				"mcp-registry-account",
				"Smithery",
				Some(state.into()),
				account.into_any_element(),
				palette,
			))
			.child(search);
		let Some(registry) = registry else {
			return section.into_any_element();
		};
		if let Some(query) = &registry.query {
			section = section.child(note(
				match registry.results.len() {
					0 => format!("Nothing found for “{query}”"),
					1 => format!("1 server for “{query}”"),
					count => format!("{count} servers for “{query}”"),
				},
				palette,
			));
		}
		for result in &registry.results {
			section = section.child(self.result(result, palette, window, cx));
		}
		section.into_any_element()
	}

	fn result(
		&mut self,
		result: &McpRegistryResultView,
		palette: &Palette,
		window: &mut Window,
		cx: &mut Context<Self>,
	) -> AnyElement {
		let open = self.mcp_deploying.as_deref() == Some(result.id.as_str());
		let id = result.id.clone();
		let toggle = local_button(
			SharedString::from(format!("mcp-result-{}", result.id)),
			if open { "Close" } else { "Add…" },
			ButtonVariant::Ghost,
			cx.listener(move |this, _, _, cx| {
				let open = this.mcp_deploying.as_deref() == Some(id.as_str());
				this.mcp_deploying = (!open).then(|| id.clone());
				this.errors.remove(DEPLOY);
				cx.notify();
			}),
		);
		let label = if result.verified {
			format!("{} ✓", result.name)
		} else {
			result.name.clone()
		};
		let mut card = div().child(row(
			SharedString::from(format!("mcp-result-row-{}", result.id)),
			label,
			Some(result_detail(result).into()),
			toggle,
			palette,
		));
		for warning in &result.warnings {
			card = card.child(note(format!("Warning: {warning}"), palette));
		}
		if !open {
			return card.into_any_element();
		}
		let mut form = div().flex().flex_col().gap(space::S2).py(space::S2);
		let name_field = name_key(&result.id);
		let name =
			self.field(&name_field, &result.server, "Name to add it under", submit_deploy, window, cx);
		form = form
			.child(note("Name", palette))
			.child(input_box(&name_field, name, palette));
		for input in &result.inputs {
			let placeholder = match (&input.default, input.choices.is_empty()) {
				(_, false) => format!("One of: {}", input.choices.join(", ")),
				(Some(default), true) => format!("Default: {default}"),
				(None, true) => String::new(),
			};
			let key = input_key(&result.id, &input.key);
			let field = if input.sensitive {
				self.secret_field(&key, &placeholder, submit_deploy, window, cx)
			} else {
				self.field(&key, "", &placeholder, submit_deploy, window, cx)
			};
			let label = if input.required {
				format!("{} (required)", input.label)
			} else {
				input.label.clone()
			};
			form = form
				.child(note(label, palette))
				.child(input_box(&key, field, palette));
			if let Some(description) = &input.description {
				form = form.child(note(description.clone(), palette));
			}
		}
		let error = self.errors.get(DEPLOY).cloned();
		form = form
			.child(local_button(
				SharedString::from(format!("mcp-deploy-{}", result.id)),
				"Add server",
				ButtonVariant::Primary,
				cx.listener(|this, _, window, cx| {
					submit_deploy(this, DEPLOY, String::new(), window, cx);
				}),
			))
			.when_some(error, |el, error| el.child(note(error, palette)));
		card.child(form).into_any_element()
	}
}

/// What the row under a result's name states.
pub fn result_detail(result: &McpRegistryResultView) -> String {
	let uses = match result.use_count {
		1 => "used once".to_owned(),
		count => format!("used {count} times"),
	};
	[result.description.as_str(), result.transport.as_str(), uses.as_str()]
		.into_iter()
		.filter(|part| !part.is_empty())
		.collect::<Vec<_>>()
		.join(" · ")
}

/// The request that adds `result` under `server`, with the value `value`
/// reads for each input. An input left empty takes its default; a required
/// input with neither, or a value outside the input's choices, is stated
/// rather than sent.
pub fn deploy_request(
	result: &McpRegistryResultView,
	server: &str,
	value: impl Fn(&str) -> String,
) -> Result<McpRequest, String> {
	let server = server.trim();
	if server.is_empty() {
		return Err("Name the server".to_owned());
	}
	let mut inputs = Vec::new();
	for input in &result.inputs {
		let typed = value(&input.key);
		let typed = typed.trim();
		if typed.is_empty() {
			if input.required && input.default.is_none() {
				return Err(format!("{} is required", input.label));
			}
			continue;
		}
		if !input.choices.is_empty() && !input.choices.iter().any(|choice| choice == typed) {
			return Err(format!("{} is one of: {}", input.label, input.choices.join(", ")));
		}
		inputs.push(McpRegistryInputValue { key: input.key.clone(), value: typed.to_owned() });
	}
	Ok(McpRequest::DeployMcpRegistryServer {
		result: result.id.clone(),
		server: server.to_owned(),
		inputs,
	})
}

/// Adds the unfolded result, or states what is missing.
fn submit_deploy(
	view: &mut SettingsView,
	_: &str,
	_: String,
	_: &mut Window,
	cx: &mut Context<SettingsView>,
) {
	let Some(id) = view.mcp_deploying.clone() else {
		return;
	};
	let registry = view.app.read(cx).store().domains.mcp_registry.clone();
	let Some(result) =
		registry.and_then(|registry| registry.results.into_iter().find(|result| result.id == id))
	else {
		return;
	};
	let server = view.field_text(&name_key(&id), cx);
	match deploy_request(&result, &server, |key| view.field_text(&input_key(&id, key), cx)) {
		Ok(request) => {
			view.errors.remove(DEPLOY);
			view.mcp_deploying = None;
			view.send(
				HostAction::McpManage(request),
				SurfaceId::SettingsField("mcp:deploy".to_owned()),
				cx,
			);
		},
		Err(error) => {
			view.errors.insert(DEPLOY.to_owned(), error.into());
		},
	}
	cx.notify();
}

/// Searches the registry for the words typed.
fn submit_search(
	view: &mut SettingsView,
	_: &str,
	_: String,
	_: &mut Window,
	cx: &mut Context<SettingsView>,
) {
	let query = view.field_text(SEARCH, cx);
	if query.is_empty() {
		return;
	}
	let request = McpRequest::SearchMcpRegistry { query, limit: None, semantic: view.mcp_semantic };
	view.send(
		HostAction::McpManage(request),
		SurfaceId::SettingsField("mcp:registry-search".to_owned()),
		cx,
	);
}
