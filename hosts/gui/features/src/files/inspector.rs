//! File context, details, and outline inspector bodies.

use gpui::{AnyElement, App, IntoElement, ParentElement, Styled, div, px};
use veyyon_gui_core::{
	Store, UiCommand,
	model::{FileKind, FileNode, FileReadView, LineRange},
	navigation::{AttachmentKind, InspectorTab},
};
use veyyon_gui_kit::{
	theme::{Theme, size, space, weight},
	ui::{AnchoredPopover, Button, Empty, Fill, Icon, Row, Side, Tone, card, text},
};

use super::{
	logic,
	owners::{self, Chrome},
	preview::CachedBody,
};
use crate::act;

pub fn render(
	store: &Store,
	read: Option<&FileReadView>,
	cache: Option<&CachedBody>,
	cx: &mut App,
) -> AnyElement {
	match store.frontend.inspector_tab {
		InspectorTab::Context => context(store, read, cache, cx).into_any_element(),
		InspectorTab::Details => details(store, read, cx).into_any_element(),
		InspectorTab::Outline => outline(read, cache, cx).into_any_element(),
	}
}

fn context(
	store: &Store,
	read: Option<&FileReadView>,
	cache: Option<&CachedBody>,
	cx: &mut App,
) -> gpui::Div {
	let Some(read) = read else {
		return pane_empty(
			"No file context",
			"Choose a file to attach it to the active conversation.",
		);
	};
	let Some(session) = store.frontend.selected_session.clone() else {
		return pane_empty(
			"No active conversation",
			"Open a conversation before adding file context.",
		);
	};

	let mut column = section("Composer context", cx).child(
		Button::labelled(
			"mention-selected-file",
			owners::chrome(Chrome::MentionFile),
			"Add file mention",
		)
		.icon(Icon::Mention)
		.fill(Fill::Tinted)
		.tone(Tone::Accent)
		.on_click(act::click(UiCommand::AddAttachment {
			session: session.clone(),
			kind:    AttachmentKind::File { path: read.path.clone() },
		})),
	);

	let range = store.frontend.file_range;
	if let (Some(range), Some(text)) = (range, cache.and_then(|cache| selected_text(cache, range))) {
		column = column.child(
			Button::labelled(
				"attach-selected-file-lines",
				owners::chrome(Chrome::AttachLines),
				range_label(range),
			)
			.icon(Icon::Attachment)
			.fill(Fill::Ghost)
			.tone(Tone::Plain)
			.on_click(act::click(UiCommand::AddAttachment {
				session,
				kind: AttachmentKind::TextRange {
					path: read.path.clone(),
					start_line: range.start,
					end_line: range.end,
					text,
				},
			})),
		);
	} else {
		column = column.child(
			Button::labelled(
				"attach-selected-file-lines",
				owners::chrome(Chrome::AttachLines),
				"Add selected lines",
			)
			.icon(Icon::Attachment)
			.fill(Fill::Ghost)
			.tone(Tone::Muted)
			.disabled("Select a text range in this file first"),
		);
	}

	column.child(
		div()
			.pt(px(space::TIGHT))
			.text_size(px(size::meta()))
			.text_color(Theme::get(cx).text_faint)
			.child("Attachments are explicit context. This preview never edits the file."),
	)
}

fn selected_text(cache: &CachedBody, range: Option<LineRange>) -> Option<String> {
	let range = range?;
	let CachedBody::Text { source, lines, .. } = cache else {
		return None;
	};
	let normalized = logic::normalized_range(range, u32::try_from(lines.len()).unwrap_or(u32::MAX))?;
	let start = usize::try_from(normalized.start - 1).ok()?;
	let end = usize::try_from(normalized.end - 1).ok()?;
	let byte_start = lines.get(start)?.start;
	let byte_end = lines.get(end)?.end;
	Some(source[byte_start..byte_end].to_owned())
}

fn range_label(range: LineRange) -> String {
	if range.start == range.end {
		format!("Add line {}", range.start)
	} else {
		format!("Add lines {}–{}", range.start, range.end)
	}
}

fn details(store: &Store, read: Option<&FileReadView>, cx: &mut App) -> gpui::Div {
	let Some(read) = read else {
		return pane_empty("No file details", "Choose a file to inspect its metadata.");
	};
	let node = store
		.replica
		.files
		.readable()
		.and_then(|versioned| versioned.value.nodes.iter().find(|node| node.id == read.id));
	let mut column = section("File", cx)
		.child(path_detail(&read.path, read, node, cx))
		.child(detail("Reader", reader_name(read), cx));
	if let Some(node) = node {
		column = column.child(detail("Kind", kind_name(&node.kind), cx));
		if let Some(size) = node.size_bytes {
			column = column.child(detail("Size", &logic::byte_count(size), cx));
		}
		if let Some(modified) = node.modified_at_ms {
			column = column.child(detail("Modified", &format!("{modified} ms"), cx));
		}
		column = metadata_rows(column, node, cx);
	}
	column
}

fn path_detail(
	path: &str,
	read: &FileReadView,
	node: Option<&FileNode>,
	cx: &mut App,
) -> gpui::Div {
	let theme = Theme::get(cx);
	let mut popover = AnchoredPopover::new(format!("path-popover-{}", read.id), true)
		.side(Side::Bottom)
		.has_controls(true);
	popover = popover.child(
		text::stack(space::SNUG)
			.child(text::title("File metadata", &theme))
			.child(detail_row("Full path", path, &theme))
			.child(detail_row("File id", read.id.as_str(), &theme))
			.child(detail_row("Reader", reader_name(read), &theme))
			.children(node.map(|n| detail_row("Kind", kind_name(&n.kind), &theme)))
			.children(
				node
					.and_then(|n| n.size_bytes)
					.map(|s| detail_row("Exact bytes", &format!("{s} bytes"), &theme)),
			)
			.children(
				node
					.and_then(|n| n.modified_at_ms)
					.map(|m| detail_row("Modified timestamp", &format!("{m} ms"), &theme)),
			)
			.children((!read.outline.is_empty()).then(|| {
				detail_row("Outline symbols", &format!("{} items", read.outline.len()), &theme)
			})),
	);

	card::well(&theme).w_full().p(px(space::BASE)).child(
		text::stack(space::TIGHT)
			.child(
				div()
					.flex()
					.items_center()
					.justify_between()
					.child(text::meta("Path", &theme))
					.child(
						Button::labelled(
							format!("copy-path-{}", read.id),
							owners::chrome(Chrome::CopyPath),
							"Full details",
						)
						.icon(Icon::Read)
						.fill(Fill::Ghost)
						.tone(Tone::Plain)
						.on_click(act::click(UiCommand::RevealFile(read.id.clone()))),
					),
			)
			.child(
				div()
					.text_size(px(size::body()))
					.text_color(theme.text)
					.child(path.to_owned()),
			)
			.child(popover),
	)
}

fn detail_row(label: &str, value: &str, theme: &Theme) -> gpui::Div {
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

fn metadata_rows(mut column: gpui::Div, node: &FileNode, cx: &mut App) -> gpui::Div {
	if node.ignored {
		column = column.child(detail("Indexing", "Ignored", cx));
	}
	if let Some(target) = &node.symlink_target {
		column = column.child(detail("Link target", target, cx));
	}
	column
}

fn kind_name(kind: &FileKind) -> &'static str {
	match kind {
		FileKind::Directory => "Directory",
		FileKind::Text => "Text",
		FileKind::Image => "Image",
		FileKind::Binary => "Binary",
		FileKind::Symlink => "Symbolic link",
		FileKind::Other => "Other",
	}
}

fn reader_name(read: &FileReadView) -> &'static str {
	match &read.body {
		veyyon_gui_core::model::FileBody::Text { language: Some(_), .. } => "Syntax",
		veyyon_gui_core::model::FileBody::Text { language: None, .. } => "Plain text",
		veyyon_gui_core::model::FileBody::Markdown { .. } => "Markdown",
		veyyon_gui_core::model::FileBody::Image { .. } => "Image",
		veyyon_gui_core::model::FileBody::Binary { .. } => "Binary metadata",
		veyyon_gui_core::model::FileBody::TooLarge { .. } => "Too large",
		veyyon_gui_core::model::FileBody::Unavailable { .. } => "Unavailable",
	}
}

fn outline(read: Option<&FileReadView>, _cache: Option<&CachedBody>, cx: &mut App) -> gpui::Div {
	let Some(read) = read else {
		return pane_empty("No outline", "Choose a text or Markdown file to inspect its structure.");
	};
	if read.outline.is_empty() {
		return pane_empty("No symbols found", "The host returned no outline entries for this file.");
	}
	let mut column = section("Outline", cx);
	column = outline_rows(column, read, &read.outline, 0);
	column
}

fn outline_rows(
	mut column: gpui::Div,
	read: &FileReadView,
	items: &[veyyon_gui_core::model::OutlineItem],
	depth: u8,
) -> gpui::Div {
	for item in items {
		let owner = owners::outline(&read.id, item.range.start, item.range.end);
		column = column.child(
			Row::new(
				format!("outline-{}-{}-{}", read.id, item.range.start, item.range.end),
				owner,
				item.label.clone(),
			)
			.icon(if item.kind.eq_ignore_ascii_case("heading") {
				Icon::Read
			} else {
				Icon::Tool
			})
			.depth(depth.min(6))
			.note(if item.range.start == item.range.end {
				format!("Line {}", item.range.start)
			} else {
				format!("Lines {}–{}", item.range.start, item.range.end)
			})
			.on_click(act::click(UiCommand::ReadFile {
				file:  read.id.clone(),
				range: Some(item.range),
			})),
		);
		column = outline_rows(column, read, &item.children, depth.saturating_add(1));
	}
	column
}

fn section(title: &str, cx: &mut App) -> gpui::Div {
	text::stack(space::BASE).w_full().p(px(space::WIDE)).child(
		div()
			.text_size(px(size::overline()))
			.font_weight(weight::STRONG)
			.text_color(Theme::get(cx).text_faint)
			.child(title.to_uppercase()),
	)
}

fn detail(label: &str, value: &str, cx: &mut App) -> gpui::Div {
	let theme = Theme::get(cx);
	card::well(&theme).w_full().p(px(space::BASE)).child(
		text::stack(space::TIGHT)
			.child(text::meta(label.to_owned(), &theme))
			.child(
				div()
					.text_size(px(size::body()))
					.text_color(theme.text)
					.child(value.to_owned()),
			),
	)
}

fn pane_empty(title: &str, note: &str) -> gpui::Div {
	div().size_full().child(
		Empty::new(title.to_owned())
			.icon(Icon::Read)
			.note(note.to_owned())
			.filling(),
	)
}
