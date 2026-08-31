//! Canonical transcript entry dispatch with revision-keyed parse and image
//! caches.

use std::{
	collections::{BTreeMap, BTreeSet},
	sync::Arc,
};

use gpui::{AnyElement, App, Div, Image, IntoElement, ParentElement, Styled, px};
use veyyon_gui_core::{
	model::{ContentBlock, EntryId, MessageRole, ToolCallView, ToolId, TranscriptEntry},
	text::{
		diff::FileDiff,
		markdown::{Md, Span},
	},
};
use veyyon_gui_kit::{
	theme::{Theme, space},
	ui::text,
};

use super::{
	assistant_text, custom, developer_text, diff, entry_meta, execution, fallback, file_mention,
	footer, image, lifecycle, model_change, summary, thinking, tool, unknown, user_text,
};

pub struct EntryCache {
	pub revision: u64,
	markdown:     Vec<Option<Vec<Md>>>,
	images:       Vec<Option<Arc<Image>>>,
	diffs:        Vec<Option<Vec<FileDiff>>>,
	links:        Vec<String>,
}

impl EntryCache {
	pub fn build(entry: &TranscriptEntry) -> Self {
		let mut markdown = Vec::with_capacity(entry.content.len());
		let mut images = Vec::with_capacity(entry.content.len());
		let mut diffs = Vec::with_capacity(entry.content.len());
		let mut links = Vec::new();
		for block in &entry.content {
			let source = match block {
				ContentBlock::Text { text }
				| ContentBlock::Thinking { text }
				| ContentBlock::Summary { text, .. } => Some(text.as_str()),
				_ => None,
			};
			let parsed = source.map(veyyon_gui_core::text::markdown::parse);
			if let Some(parsed) = &parsed {
				collect_links(parsed, &mut links);
			}
			markdown.push(parsed);

			let decoded = match block {
				ContentBlock::Image { media_type, data, .. } => image::decode(media_type, data),
				ContentBlock::FileMention { image: Some(data), .. } => {
					image::detect_media_type(data).and_then(|media_type| image::decode(media_type, data))
				},
				_ => None,
			};
			images.push(decoded);
			diffs.push(match block {
				ContentBlock::Diff { raw } => Some(veyyon_gui_core::text::diff::parse(raw)),
				_ => None,
			});
		}
		Self { revision: entry.revision, markdown, images, diffs, links }
	}

	fn markdown(&self, index: usize) -> &[Md] {
		self
			.markdown
			.get(index)
			.and_then(Option::as_deref)
			.unwrap_or_default()
	}

	fn image(&self, index: usize) -> Option<Arc<Image>> {
		self.images.get(index).and_then(Clone::clone)
	}

	fn diff(&self, index: usize) -> &[FileDiff] {
		self
			.diffs
			.get(index)
			.and_then(Option::as_deref)
			.unwrap_or_default()
	}
}

pub fn entry(
	value: &TranscriptEntry,
	cache: &EntryCache,
	tools: &BTreeMap<ToolId, ToolCallView>,
	open_tools: &BTreeSet<ToolId>,
	streaming: bool,
	stale: bool,
	cx: &mut App,
) -> Div {
	let theme = Theme::get(cx);
	let id = value.id.as_str();
	let mut column = text::stack(space::BASE).w_full().min_w(px(0.0));

	if matches!(value.role, MessageRole::Custom) {
		column = column.child(custom::custom(id, &value.raw_discriminator, &value.raw, cx));
	} else if matches!(value.role, MessageRole::Lifecycle) {
		if value.raw_discriminator.contains("model")
			|| value.raw_discriminator.contains("thinking-level")
		{
			column = column.child(model_change::change(id, &value.raw_discriminator, &value.raw, cx));
		} else {
			column = column.child(lifecycle::lifecycle(id, &value.raw_discriminator, &value.raw, cx));
		}
	}

	for (index, block) in value.content.iter().enumerate() {
		if let Some(element) =
			content(value, block, index, cache, tools, open_tools, streaming, stale, cx)
		{
			column = column.child(element);
		}
	}
	if matches!(value.role, MessageRole::Unknown) {
		column = column.child(unknown::unknown(id, &value.raw_discriminator, &value.raw, cx));
	}
	if let Some(meta) = &value.meta {
		column = column.child(footer::footer(meta, cx));
	}
	column.child(entry_meta::actions(&value.id, value.timestamp_ms, &cache.links, &theme))
}

#[allow(clippy::too_many_arguments)]
fn content(
	entry: &TranscriptEntry,
	block: &ContentBlock,
	index: usize,
	cache: &EntryCache,
	tools: &BTreeMap<ToolId, ToolCallView>,
	open_tools: &BTreeSet<ToolId>,
	streaming: bool,
	stale: bool,
	cx: &mut App,
) -> Option<AnyElement> {
	let id = format!("{}-{index}", entry.id);
	match block {
		ContentBlock::Text { .. } => Some(match entry.role {
			MessageRole::User => user_text::text(&id, cache.markdown(index), cx).into_any_element(),
			MessageRole::Developer => {
				developer_text::text(&id, cache.markdown(index), cx).into_any_element()
			},
			_ => assistant_text::text(&id, cache.markdown(index), streaming, stale, cx)
				.into_any_element(),
		}),
		ContentBlock::Image { media_type, data, alt } => Some(
			image::image(
				&entry.id,
				index,
				media_type,
				data.len(),
				alt.as_deref(),
				cache.image(index),
				cx,
			)
			.into_any_element(),
		),
		ContentBlock::Thinking { .. } => {
			Some(thinking::thinking(&id, cache.markdown(index), cx).into_any_element())
		},
		ContentBlock::RedactedThinking { marker } => {
			Some(thinking::redacted(marker, cx).into_any_element())
		},
		ContentBlock::ToolCall { id: tool_id, name, arguments } => Some(
			tool::call(tool_id, name, arguments, tools.get(tool_id), open_tools.contains(tool_id), cx)
				.into_any_element(),
		),
		ContentBlock::ToolResult { tool: tool_id, content, is_error } => {
			Some(tool::result(&id, tool_id, content, *is_error, cx).into_any_element())
		},
		ContentBlock::Execution { language, command, output, exit_code } => Some(
			execution::execution(&id, language, command.as_deref(), output, *exit_code, cx)
				.into_any_element(),
		),
		ContentBlock::FileMention {
			path,
			has_content,
			lines,
			bytes,
			unavailable_reason,
			image: bytes_image,
		} => Some(
			file_mention::mention(
				file_mention::FileMention {
					entry: &entry.id,
					index,
					path,
					has_content: *has_content,
					lines: *lines,
					bytes: *bytes,
					unavailable_reason: unavailable_reason.as_deref(),
					image_bytes: bytes_image.as_deref(),
					decoded_image: cache.image(index),
				},
				cx,
			)
			.into_any_element(),
		),
		ContentBlock::Diff { .. } => Some(
			text::stack(space::TIGHT)
				.w_full()
				.min_w(px(0.0))
				.children(diff::patch(cache.diff(index), cx))
				.into_any_element(),
		),
		ContentBlock::ModelChange { provider, model } => {
			Some(model_change::model(provider, model).into_any_element())
		},
		ContentBlock::ThinkingChange { level } => {
			Some(model_change::thinking_level(level).into_any_element())
		},
		ContentBlock::Lifecycle { phase, reason } => {
			Some(lifecycle::phase(phase, reason.as_deref()).into_any_element())
		},
		ContentBlock::Summary { kind, .. } => {
			Some(summary::summary(&id, kind, cache.markdown(index), cx).into_any_element())
		},
		ContentBlock::Fallback { producer, value } => fallback::suppressed(producer, value),
		ContentBlock::Unknown { tag, value } => {
			Some(unknown::unknown(&id, tag, value, cx).into_any_element())
		},
	}
}

fn collect_links(blocks: &[Md], links: &mut Vec<String>) {
	for block in blocks {
		match block {
			Md::Heading { spans, .. } | Md::Paragraph(spans) => links_from_spans(spans, links),
			Md::List(items) => {
				for item in items {
					links_from_spans(&item.spans, links);
				}
			},
			Md::Quote(inner) => collect_links(inner, links),
			Md::Table { head, rows } => {
				for cell in head {
					links_from_spans(cell, links);
				}
				for row in rows {
					for cell in row {
						links_from_spans(cell, links);
					}
				}
			},
			Md::Code { .. } | Md::Rule => {},
		}
	}
}

fn links_from_spans(spans: &[Span], links: &mut Vec<String>) {
	for span in spans {
		if let Span::Link { href, .. } = span
			&& !links.iter().any(|existing| existing == href)
		{
			links.push(href.clone());
		}
	}
}

pub fn cache_is_current(cache: &EntryCache, entry: &TranscriptEntry) -> bool {
	cache.revision == entry.revision
}

pub fn cache_key(entry: &TranscriptEntry) -> EntryId {
	entry.id.clone()
}

/// Collect all plain-text selectable runs from an entry in document order.
pub fn collect_elements(
	entry: &TranscriptEntry,
	cache: &EntryCache,
	out: &mut Vec<(String, String)>,
) {
	for (index, block) in entry.content.iter().enumerate() {
		let id = format!("{}-{index}", entry.id);
		match block {
			ContentBlock::Text { .. }
			| ContentBlock::Thinking { .. }
			| ContentBlock::Summary { .. } => {
				collect_md_elements(cache.markdown(index), &id, out);
			},
			ContentBlock::Execution { command, output, .. } => {
				let mut text = String::new();
				if let Some(cmd) = command {
					text.push_str(cmd);
					text.push('\n');
				}
				text.push_str(output);
				out.push((format!("{id}-exec"), text));
			},
			ContentBlock::Diff { raw } => {
				out.push((format!("{id}-diff"), raw.clone()));
			},
			ContentBlock::ToolCall { name, arguments, .. } => {
				out.push((format!("{id}-tool-call"), format!("{name}({arguments:?})")));
			},
			ContentBlock::ToolResult { content, .. } => {
				out.push((format!("{id}-tool-result"), format!("{content:?}")));
			},
			ContentBlock::FileMention { path, .. } => {
				out.push((format!("{id}-file"), path.clone()));
			},
			ContentBlock::Image { alt: Some(alt), .. } => {
				out.push((format!("{id}-img"), alt.clone()));
			},
			_ => {},
		}
	}
}

/// Collect document-ordered text elements from markdown blocks.
pub fn collect_md_elements(blocks: &[Md], id: &str, out: &mut Vec<(String, String)>) {
	let dummy_theme = Theme::of(veyyon_gui_kit::theme::Appearance::Dark);
	for (index, block) in blocks.iter().enumerate() {
		let block_id = format!("{id}-{index}");
		match block {
			Md::Heading { spans, .. } => {
				let (text, _) = super::markdown::styled(spans, &dummy_theme);
				out.push((format!("{block_id}-h"), text));
			},
			Md::Paragraph(spans) => {
				let (text, _) = super::markdown::styled(spans, &dummy_theme);
				out.push((format!("{block_id}-p"), text));
			},
			Md::List(items) => {
				for (item_idx, item) in items.iter().enumerate() {
					let (item_text, _) = super::markdown::styled(&item.spans, &dummy_theme);
					let marker = match item.kind {
						veyyon_gui_core::text::markdown::ListKind::Bullet => "• ",
						veyyon_gui_core::text::markdown::ListKind::Ordered(n) => {
							let s = format!("{n}. ");
							let (t, _) = super::markdown::styled(&item.spans, &dummy_theme);
							out.push((format!("{block_id}-item-{item_idx}"), format!("{s}{t}")));
							continue;
						},
					};
					out.push((format!("{block_id}-item-{item_idx}"), format!("{marker}{item_text}")));
				}
			},
			Md::Quote(inner) => {
				collect_md_elements(inner, &block_id, out);
			},
			Md::Code { body, .. } => {
				out.push((format!("{block_id}-code"), body.clone()));
			},
			Md::Table { head, rows } => {
				for (col_idx, cell) in head.iter().enumerate() {
					let (cell_text, _) = super::markdown::styled(cell, &dummy_theme);
					out.push((format!("{block_id}-head-{col_idx}"), cell_text));
				}
				for (row_idx, row) in rows.iter().enumerate() {
					for (col_idx, cell) in row.iter().enumerate() {
						let (cell_text, _) = super::markdown::styled(cell, &dummy_theme);
						out.push((format!("{block_id}-row-{row_idx}-{col_idx}"), cell_text));
					}
				}
			},
			Md::Rule => {},
		}
	}
}
