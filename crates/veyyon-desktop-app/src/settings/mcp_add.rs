//! The MCP page's form that adds a server by command or URL.

use veyyon_desktop_model::{
	HostAction, SurfaceId,
	action::{McpRequest, McpServerTarget},
};
use veyyon_desktop_ui::{
	controls::ButtonVariant,
	theme::{Palette, TypeStyled, radius, size, space, text},
};
use veyyon_gpui::{AnyElement, Context, IntoElement, SharedString, Window, div, prelude::*};

use super::{
	SettingsView,
	widgets::{input_box, local_button, note},
};

/// The field key of the new server's name.
const NAME: &str = "mcp-add-name";
/// The field key of the new server's command or URL.
const TARGET: &str = "mcp-add-target";
/// The error key of the form.
const FORM: &str = "mcp-add";

/// How a server added from the page is reached.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Transport {
	/// A local command, spoken to over stdio.
	Command,
	/// A URL over streamable HTTP.
	Http,
	/// A URL over server-sent events.
	Sse,
}

impl Transport {
	const ALL: [Self; 3] = [Self::Command, Self::Http, Self::Sse];

	const fn label(self) -> &'static str {
		match self {
			Self::Command => "Command",
			Self::Http => "HTTP",
			Self::Sse => "SSE",
		}
	}
}

impl SettingsView {
	pub(super) fn mcp_add(
		&mut self,
		palette: &Palette,
		window: &mut Window,
		cx: &mut Context<Self>,
	) -> AnyElement {
		let transport = self.mcp_transport;
		let placeholder = match transport {
			Transport::Command => "npx -y @modelcontextprotocol/server-memory",
			Transport::Http | Transport::Sse => "https://example.com/mcp",
		};
		let name = self.field(NAME, "", "Name", submit, window, cx);
		let target = self.field(TARGET, "", placeholder, submit, window, cx);
		let mut chips = div().flex().gap(space::S1);
		for option in Transport::ALL {
			let selected = option == transport;
			chips = chips.child(
				div()
					.id(SharedString::from(format!("mcp-transport-{}", option.label())))
					.px(space::S2)
					.h(size::CONTROL_SM)
					.flex()
					.items_center()
					.rounded(radius::MD)
					.type_style(text::SMALL)
					.when(selected, |el| el.bg(palette.bg.selected).text_color(palette.text.primary))
					.when(!selected, |el| {
						el.text_color(palette.text.muted)
							.hover(|el| el.bg(palette.bg.hover))
					})
					.on_click(cx.listener(move |this, _, _, cx| {
						this.mcp_transport = option;
						cx.notify();
					}))
					.child(option.label()),
			);
		}
		let error = self.errors.get(FORM).cloned();
		div()
			.flex()
			.flex_col()
			.gap(space::S2)
			.child(chips)
			.child(input_box(NAME, name, palette))
			.child(input_box(TARGET, target, palette))
			.child(local_button(
				"mcp-add",
				"Add server",
				ButtonVariant::Secondary,
				cx.listener(|this, _, window, cx| submit(this, FORM, String::new(), window, cx)),
			))
			.when_some(error, |el, error| el.child(note(error, palette)))
			.into_any_element()
	}
}

/// Adds the server the form describes, or states what is missing.
fn submit(
	view: &mut SettingsView,
	_: &str,
	_: String,
	_: &mut Window,
	cx: &mut Context<SettingsView>,
) {
	let name = view.field_text(NAME, cx);
	let target = view.field_text(TARGET, cx);
	match add_request(view.mcp_transport, &name, &target) {
		Ok(request) => {
			view.errors.remove(FORM);
			view.set_field(NAME, "", cx);
			view.set_field(TARGET, "", cx);
			view.send(
				HostAction::McpManage(request),
				SurfaceId::SettingsField("mcp:add".to_owned()),
				cx,
			);
		},
		Err(error) => {
			view.errors.insert(FORM.to_owned(), error.into());
		},
	}
	cx.notify();
}

/// The request that adds `name` reached through `target`: a command and its
/// arguments split on whitespace, or a URL.
pub fn add_request(
	transport: Transport,
	name: &str,
	target: &str,
) -> Result<McpRequest, &'static str> {
	let name = name.trim();
	if name.is_empty() {
		return Err("Name the server");
	}
	let mut words = target.split_whitespace();
	let Some(first) = words.next() else {
		return Err(match transport {
			Transport::Command => "Type the command that starts the server",
			Transport::Http | Transport::Sse => "Type the server's URL",
		});
	};
	let target = match transport {
		Transport::Command => McpServerTarget::Command {
			command: first.to_owned(),
			args:    words.map(str::to_owned).collect(),
		},
		Transport::Http | Transport::Sse if words.next().is_some() => {
			return Err("A URL holds no spaces");
		},
		Transport::Http => McpServerTarget::Http { url: first.to_owned(), token: None },
		Transport::Sse => McpServerTarget::Sse { url: first.to_owned(), token: None },
	};
	Ok(McpRequest::AddMcpServer { name: name.to_owned(), target })
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn a_command_splits_into_the_executable_and_its_arguments() {
		let request = add_request(Transport::Command, " memory ", "npx -y  server-memory");
		assert_eq!(
			request,
			Ok(McpRequest::AddMcpServer {
				name:   "memory".to_owned(),
				target: McpServerTarget::Command {
					command: "npx".to_owned(),
					args:    vec!["-y".to_owned(), "server-memory".to_owned()],
				},
			})
		);
	}

	#[test]
	fn a_url_is_sent_over_the_transport_chosen() {
		let sse = add_request(Transport::Sse, "docs", "https://example.com/sse");
		assert_eq!(
			sse,
			Ok(McpRequest::AddMcpServer {
				name:   "docs".to_owned(),
				target: McpServerTarget::Sse {
					url:   "https://example.com/sse".to_owned(),
					token: None,
				},
			})
		);
	}

	#[test]
	fn a_missing_name_or_target_is_stated_rather_than_sent() {
		assert_eq!(add_request(Transport::Http, "", "https://x"), Err("Name the server"));
		assert_eq!(add_request(Transport::Http, "x", "  "), Err("Type the server's URL"));
		assert_eq!(
			add_request(Transport::Command, "x", ""),
			Err("Type the command that starts the server")
		);
		assert_eq!(add_request(Transport::Http, "x", "https://a b"), Err("A URL holds no spaces"));
	}
}
