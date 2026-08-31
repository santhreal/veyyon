//! Rich previews for palette rows based on authoritative store replicas.
//!
//! A preview reads only existing store data (session first messages, model
//! capabilities, file metadata and head reads) and never fabricates or invents
//! unbacked fields.

use gpui::{App, Div, ParentElement, Styled, div, px};
use veyyon_gui_core::{
	Store,
	model::{ContentBlock, FileBody, FileNode, ModelOption, SessionSummary},
	navigation::PaletteMode,
	palette::Item,
};
use veyyon_gui_kit::{
	theme::{Theme, layout, size, space},
	ui::{Badge, Card, Icon, PickerPreview, Tone, text},
};

/// Builds an optional preview for the item currently under the palette cursor.
pub fn render_preview(
	store: &Store,
	mode: PaletteMode,
	selected_item: Option<&Item>,
	cx: &mut App,
) -> Option<PickerPreview> {
	let item = selected_item?;
	let theme = Theme::get(cx);
	let element = match mode {
		PaletteMode::Sessions => session_preview(store, &item.id, &theme)?,
		PaletteMode::Models => model_preview(store, &item.id, &theme)?,
		PaletteMode::Files => file_preview(store, &item.id, &theme)?,
		PaletteMode::Providers => provider_preview(store, &item.id, &theme)?,
		PaletteMode::Agents => agent_preview(store, &item.id, &theme)?,
		PaletteMode::QuickOpen => {
			if item.id.starts_with("session:") {
				session_preview(store, &item.id, &theme)?
			} else if item.id.starts_with("file:") {
				file_preview(store, &item.id, &theme)?
			} else if item.id.starts_with("message:") {
				message_preview(store, &item.id, &theme)?
			} else {
				generic_preview(item, &theme)
			}
		},
		PaletteMode::Messages => message_preview(store, &item.id, &theme)?,
		PaletteMode::Commands | PaletteMode::Settings => generic_preview(item, &theme),
	};

	Some(PickerPreview::new(element).width(layout::INSPECTOR_MIN))
}

fn session_preview(store: &Store, item_id: &str, theme: &Theme) -> Option<Div> {
	let raw_id = item_id.strip_prefix("session:").unwrap_or(item_id);
	let replica = store.replica.sessions.sessions.readable()?;
	let session: &SessionSummary = replica.value.iter().find(|s| s.id.as_str() == raw_id)?;

	let title_text = session.title.as_deref().unwrap_or(&session.path);
	let mut stack = text::stack(space::BASE)
		.child(text::title(title_text, theme))
		.child(
			div()
				.flex()
				.flex_wrap()
				.items_center()
				.gap(px(space::SNUG))
				.child(Badge::new(format!("{:?}", session.status)).tone(Tone::Accent))
				.child(text::meta(format!("{} msgs", session.message_count), theme)),
		)
		.child(detail_row("Path", &session.path, theme))
		.child(detail_row("CWD", &session.cwd, theme));

	if let Some(first_msg) = &session.first_message
		&& !first_msg.trim().is_empty()
	{
		let snippet: String = first_msg.lines().take(6).collect::<Vec<_>>().join("\n");
		stack = stack.child(
			div()
				.flex()
				.flex_col()
				.gap(px(space::TIGHT))
				.pt(px(space::SNUG))
				.child(text::overline("First message", theme).text_color(theme.text_muted))
				.child(
					Card::new().ground(theme.raised).pad(space::SNUG).child(
						text::body(snippet, theme)
							.text_size(px(size::meta()))
							.text_color(theme.text_muted),
					),
				),
		);
	}

	Some(stack)
}

fn model_preview(store: &Store, item_id: &str, theme: &Theme) -> Option<Div> {
	let catalog = store.replica.models.readable()?;
	let models = catalog.value.models.readable()?;
	let model: &ModelOption = if let Some(stripped) = item_id.strip_prefix("model:") {
		models.iter().find(|m| {
			let key = format!("{}:{}", m.provider, m.id);
			key == stripped
		})?
	} else {
		models.iter().find(|m| m.id.as_str() == item_id)?
	};

	let mut stack = text::stack(space::BASE)
		.child(text::title(&model.name, theme))
		.child(
			div()
				.flex()
				.items_center()
				.gap(px(space::SNUG))
				.child(Badge::new(model.provider.as_str()).tone(Tone::Plain))
				.child(Badge::new(model.id.as_str()).tone(Tone::Muted)),
		);

	if let Some(ctx) = model.context_window {
		stack = stack.child(detail_row("Context window", &format!("{ctx} tokens"), theme));
	}
	stack = stack.child(detail_row(
		"Reasoning",
		if model.reasoning {
			"Supported"
		} else {
			"Standard"
		},
		theme,
	));
	if let Some(tools) = model.tool_support {
		stack = stack.child(detail_row(
			"Tool calling",
			if tools { "Supported" } else { "Unsupported" },
			theme,
		));
	}
	if !model.input_modalities.is_empty() {
		stack = stack.child(detail_row("Modalities", &model.input_modalities.join(", "), theme));
	}
	if let Some(thinking) = &model.thinking_mode {
		stack = stack.child(detail_row("Thinking mode", thinking, theme));
	}

	Some(stack)
}

fn file_preview(store: &Store, item_id: &str, theme: &Theme) -> Option<Div> {
	let raw_id = item_id.strip_prefix("file:").unwrap_or(item_id);
	let replica = store.replica.files.readable()?;
	let node: &FileNode = replica
		.value
		.nodes
		.iter()
		.find(|n| n.id.as_str() == raw_id)?;

	let mut stack = text::stack(space::BASE)
		.child(text::title(&node.name, theme))
		.child(
			div()
				.flex()
				.items_center()
				.gap(px(space::SNUG))
				.child(Badge::new(format!("{:?}", node.kind)).tone(Tone::Plain)),
		)
		.child(detail_row("Path", &node.path, theme));

	if let Some(bytes) = node.size_bytes {
		let formatted = format_bytes(bytes);
		stack = stack.child(detail_row("Size", &formatted, theme));
	}

	if let Some(files_versioned) = store.replica.files.readable()
		&& let Some(read_versioned) = files_versioned.value.selected_read.readable()
		&& read_versioned.value.id.as_str() == raw_id
		&& let FileBody::Text { text: body_text, .. } = &read_versioned.value.body
	{
		let preview_snippet: String = body_text.lines().take(8).collect::<Vec<_>>().join("\n");
		stack = stack.child(
			div()
				.flex()
				.flex_col()
				.gap(px(space::TIGHT))
				.pt(px(space::SNUG))
				.child(text::overline("Preview", theme).text_color(theme.text_muted))
				.child(
					Card::new().ground(theme.raised).pad(space::SNUG).child(
						text::mono(preview_snippet, theme)
							.text_size(px(size::meta()))
							.text_color(theme.text_muted),
					),
				),
		);
	}

	Some(stack)
}

fn provider_preview(store: &Store, item_id: &str, theme: &Theme) -> Option<Div> {
	let raw_id = item_id.strip_prefix("provider:").unwrap_or(item_id);
	let replica = store.replica.providers.readable()?;
	let provider = replica.value.iter().find(|p| p.id.as_str() == raw_id)?;

	let mut stack = text::stack(space::BASE)
		.child(text::title(&provider.name, theme))
		.child(
			div().flex().items_center().gap(px(space::SNUG)).child(
				Badge::new(if provider.authenticated {
					"Authenticated"
				} else {
					"Not signed in"
				})
				.tone(if provider.authenticated {
					Tone::Accent
				} else {
					Tone::Warn
				}),
			),
		)
		.child(detail_row("Provider ID", provider.id.as_str(), theme));

	if let Some(status) = &provider.status {
		stack = stack.child(detail_row("Status", status, theme));
	}
	if let Some(error) = &provider.error {
		stack = stack.child(
			div()
				.pt(px(space::SNUG))
				.child(text::meta(format!("Error: {error}"), theme).text_color(theme.danger)),
		);
	}

	Some(stack)
}

fn agent_preview(store: &Store, item_id: &str, theme: &Theme) -> Option<Div> {
	let raw_id = item_id.strip_prefix("agent:").unwrap_or(item_id);
	let replica = store.replica.agents.readable()?;
	let agent = replica
		.value
		.agents
		.readable()?
		.iter()
		.find(|a| a.id.as_str() == raw_id)?;

	let mut stack = text::stack(space::BASE)
		.child(text::title(&agent.display_name, theme))
		.child(
			div()
				.flex()
				.items_center()
				.gap(px(space::SNUG))
				.child(Badge::new(format!("{:?}", agent.status)).tone(Tone::Plain)),
		)
		.child(detail_row("Agent ID", agent.id.as_str(), theme));

	if let Some(activity) = &agent.activity {
		stack = stack.child(detail_row("Activity", activity, theme));
	}

	Some(stack)
}

fn message_preview(store: &Store, item_id: &str, theme: &Theme) -> Option<Div> {
	let raw_id = item_id.strip_prefix("message:").unwrap_or(item_id);
	let replica = store.replica.transcript.readable()?;
	let entry = replica.value.iter().find(|e| e.id.as_str() == raw_id)?;

	let text = entry.content.iter().find_map(|block| match block {
		ContentBlock::Text { text } => Some(text.as_str()),
		_ => None,
	})?;

	let snippet: String = text.lines().take(8).collect::<Vec<_>>().join("\n");
	let stack = text::stack(space::BASE)
		.child(text::title("Message", theme))
		.child(
			div()
				.flex()
				.items_center()
				.gap(px(space::SNUG))
				.child(Badge::new(format!("{:?}", entry.role)).tone(Tone::Plain)),
		)
		.child(
			Card::new().ground(theme.raised).pad(space::SNUG).child(
				text::body(snippet, theme)
					.text_size(px(size::meta()))
					.text_color(theme.text_muted),
			),
		);

	Some(stack)
}

fn generic_preview(item: &Item, theme: &Theme) -> Div {
	let mut stack = text::stack(space::BASE).child(text::title(&item.title, theme));
	if let Some(detail) = &item.detail {
		stack = stack.child(text::body(detail.clone(), theme));
	}
	if let Some(reason) = &item.disabled_reason {
		stack = stack.child(
			Badge::new(format!("Unavailable: {reason}"))
				.icon(Icon::Notice)
				.tone(Tone::Warn),
		);
	}
	stack
}

fn detail_row(label: &str, value: &str, theme: &Theme) -> Div {
	div()
		.flex()
		.items_center()
		.justify_between()
		.gap(px(space::BASE))
		.child(text::meta(label.to_owned(), theme))
		.child(
			text::mono(value.to_owned(), theme)
				.text_size(px(size::meta()))
				.text_color(theme.text),
		)
}

fn format_bytes(bytes: u64) -> String {
	if bytes < 1024 {
		format!("{bytes} B")
	} else if bytes < 1024 * 1024 {
		format!("{:.1} KB", bytes as f64 / 1024.0)
	} else {
		format!("{:.1} MB", bytes as f64 / (1024.0 * 1024.0))
	}
}
