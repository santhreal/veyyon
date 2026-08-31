//! Selected-file details, diff preferences, navigation, and pending review
//! context.

use gpui::{
	AnyElement, App, InteractiveElement, IntoElement, ParentElement, ScrollHandle, Styled, div, px,
};
use veyyon_gui_core::{
	Store, UiCommand,
	model::{ChangedFileView, FileKind},
	navigation::{AttachmentKind, AttachmentState},
	text::diff::FileDiff,
};
use veyyon_gui_kit::{
	theme::{Elevation, Theme, diff, space, weight},
	ui::{Badge, Banner, Button, Empty, Fill, Group, Icon, Scrolls, Size, Tone, text},
};

use super::{
	logic,
	owners::{self, Chrome},
};
use crate::act;

pub fn render(store: &Store, cx: &mut App) -> AnyElement {
	let scroll = ScrollHandle::new();
	let Some(versioned) = store.replica.changes.readable() else {
		return Empty::new("No file selected")
			.icon(Icon::Changed)
			.note("Select a changed file to inspect it.")
			.filling()
			.into_any_element();
	};
	let snapshot = &versioned.value;
	let Some(index) = logic::selected_index(snapshot, store.frontend.selected_file.as_ref()) else {
		return Empty::new("No file selected")
			.icon(Icon::Changed)
			.note("Select a changed file to inspect it.")
			.filling()
			.into_any_element();
	};
	let Some(file) = snapshot.files.get(index) else {
		return gpui::Empty.into_any_element();
	};
	let parsed = logic::parsed_file(snapshot, index);
	let compact = store.frontend.panels.inspector_width <= diff::NARROW_INSPECTOR;
	let theme = Theme::get(cx);

	let mut page = div()
		.flex()
		.flex_col()
		.gap(px(space::X12))
		.size_full()
		.id("changes-inspector-scroll-1")
		.p(px(space::X12))
		.bg(theme.canvas)
		.child(file_heading(file, parsed, compact, &theme))
		.child(file_actions(file))
		.child(preferences(store))
		.child(hunk_navigation(store, file, parsed));

	if let Some(old_path) = &file.old_path {
		page =
			page.child(Banner::notice("Renamed file").detail(format!("{} → {}", old_path, file.path)));
	}
	if file.binary {
		page = page.child(
			Banner::notice("Binary file")
				.detail("Line review is unavailable, but the file actions remain available."),
		);
	}
	if snapshot.truncated || snapshot.malformed_hunks > 0 {
		let detail = match (snapshot.truncated, snapshot.malformed_hunks) {
			(true, 0) => "The host truncated the diff.".to_owned(),
			(false, count) => format!("{count} malformed hunks were preserved partially."),
			(true, count) => format!("The diff is truncated and contains {count} malformed hunks."),
		};
		page = page.child(Banner::waiting("Diff content is incomplete").detail(detail));
	}

	page
		.child(pending_comments(store, &theme))
		.scrolls_y(&scroll, Elevation::Chrome)
		.into_any_element()
}

fn file_heading(
	file: &ChangedFileView,
	parsed: Option<&FileDiff>,
	compact: bool,
	theme: &Theme,
) -> impl IntoElement {
	let status = logic::file_status(parsed, file);
	let mut stats = div()
		.flex()
		.items_center()
		.gap(px(space::X6))
		.child(Badge::new(status).tone(status_tone(status)));
	if file.additions > 0 {
		stats = stats.child(
			Badge::new(format!("+{}", file.additions))
				.tone(Tone::Ok)
				.bare(),
		);
	}
	if file.deletions > 0 {
		stats = stats.child(
			Badge::new(format!("−{}", file.deletions))
				.tone(Tone::Danger)
				.bare(),
		);
	}
	let heading = div()
		.flex()
		.flex_col()
		.gap(px(space::X4))
		.min_w(px(0.0))
		.child(
			text::mono(file.path.clone(), theme)
				.text_color(theme.text)
				.font_weight(weight::STRONG),
		)
		.child(text::meta(kind_name(&file.kind), theme).text_color(theme.text_faint));
	if compact {
		div()
			.flex()
			.flex_col()
			.gap(px(space::X8))
			.child(heading)
			.child(stats)
	} else {
		div()
			.flex()
			.items_start()
			.gap(px(space::X8))
			.child(heading.flex_1().min_w(px(0.0)))
			.child(stats)
	}
}

fn file_actions(file: &ChangedFileView) -> impl IntoElement {
	div()
		.flex()
		.flex_wrap()
		.gap(px(space::X4))
		.child(
			Button::labelled("changes-open-file", owners::chrome(Chrome::OpenFile), "Open")
				.icon(Icon::Read)
				.fill(Fill::Tinted)
				.size(Size::Small)
				.on_click(act::click(UiCommand::OpenExternal(file.path.clone()))),
		)
		.child(
			Button::labelled("changes-reveal-file", owners::chrome(Chrome::RevealFile), "Reveal")
				.icon(Icon::Checkout)
				.size(Size::Small)
				.on_click(act::click(UiCommand::RevealSelectedFile)),
		)
		.child(
			Button::labelled("changes-copy-path", owners::chrome(Chrome::CopyPath), "Copy path")
				.icon(Icon::Copy)
				.size(Size::Small)
				.on_click(act::click(UiCommand::CopyText(file.path.clone()))),
		)
}

fn preferences(store: &Store) -> Group {
	let preferences = &store.frontend.preferences;
	Group::new("Diff view")
		.child(
			Button::labelled("changes-wrap", owners::chrome(Chrome::Wrap), "Wrap lines")
				.on(preferences.wrap_diff)
				.fill(Fill::Ghost)
				.size(Size::Small)
				.tip(if preferences.wrap_diff {
					"Disable line wrapping"
				} else {
					"Enable line wrapping"
				})
				.on_click(act::click(UiCommand::SetDiffWrap(!preferences.wrap_diff))),
		)
		.child(
			Button::labelled("changes-whitespace", owners::chrome(Chrome::Whitespace), "Whitespace")
				.on(preferences.show_whitespace)
				.fill(Fill::Ghost)
				.size(Size::Small)
				.tip(if preferences.show_whitespace {
					"Hide whitespace marks"
				} else {
					"Show whitespace marks"
				})
				.on_click(act::click(UiCommand::SetDiffWhitespace(!preferences.show_whitespace))),
		)
}

fn hunk_navigation(store: &Store, file: &ChangedFileView, parsed: Option<&FileDiff>) -> Group {
	let count = parsed.map_or(0, |parsed| parsed.hunks.len());
	let selected = store
		.frontend
		.selected_hunk
		.as_ref()
		.filter(|(selected_file, _)| selected_file == &file.id)
		.map(|(_, hunk)| *hunk)
		.unwrap_or(0);
	let previous = selected.checked_sub(1);
	let next = (selected + 1 < count).then_some(selected + 1);
	let mut group = Group::new("Hunks").child(text::line(if count == 0 {
		"No line hunks".to_owned()
	} else {
		format!("Hunk {} of {count}", selected.min(count - 1) + 1)
	}));
	let previous_button =
		Button::labelled("changes-previous-hunk", owners::chrome(Chrome::PreviousHunk), "Previous")
			.size(Size::Small)
			.tip(if previous.is_some() {
				"Previous hunk"
			} else {
				"Already at the first hunk"
			})
			.on_click(act::click(UiCommand::SelectHunk {
				file: file.id.clone(),
				hunk: previous.unwrap_or(0),
			}));
	group = group.child(if previous.is_some() {
		previous_button
	} else {
		previous_button.disabled("Already at the first hunk")
	});
	let next_button =
		Button::labelled("changes-next-hunk", owners::chrome(Chrome::NextHunk), "Next")
			.size(Size::Small)
			.tip(if next.is_some() {
				"Next hunk"
			} else {
				"Already at the last hunk"
			})
			.on_click(act::click(UiCommand::SelectHunk {
				file: file.id.clone(),
				hunk: next.unwrap_or(selected),
			}));
	group.child(if next.is_some() {
		next_button
	} else {
		next_button.disabled("Already at the last hunk")
	})
}

fn pending_comments(store: &Store, theme: &Theme) -> Group {
	let mut group = Group::new("Pending review comments");
	let Some(session) = store.frontend.selected_session.as_ref() else {
		return group.child(text::note_wrapping("Open a conversation to add review context.", theme));
	};
	let Some(draft) = store.frontend.drafts.get(session) else {
		return group.child(text::note_wrapping("No review comments are pending.", theme));
	};
	let comments: Vec<_> = draft
		.attachments
		.iter()
		.filter(|attachment| matches!(attachment.kind, AttachmentKind::ReviewComment { .. }))
		.collect();
	if comments.is_empty() {
		return group.child(text::note_wrapping("No review comments are pending.", theme));
	}
	for attachment in &comments {
		let AttachmentKind::ReviewComment { path, start_line, end_line, text: body } =
			&attachment.kind
		else {
			continue;
		};
		let state = match &attachment.state {
			AttachmentState::Selected => "selected",
			AttachmentState::Uploading { .. } => "adding",
			AttachmentState::Ready => "ready",
			AttachmentState::Failed { .. } => "failed",
			AttachmentState::NeedsReattach { .. } => "needs reattach",
			AttachmentState::Refused { .. } => "refused",
		};
		let remove_owner = owners::comment(&attachment.id);
		group = group.child(
			div()
				.flex()
				.flex_col()
				.gap(px(space::X4))
				.child(text::mono(format!("{path}:{start_line}-{end_line}"), theme))
				.child(text::note_wrapping(body.clone(), theme))
				.child(
					div()
						.flex()
						.items_center()
						.gap(px(space::X6))
						.child(Badge::new(state).tone(if state == "failed" {
							Tone::Danger
						} else {
							Tone::Muted
						}))
						.child(
							Button::labelled(
								format!("remove-review-{}", attachment.id),
								remove_owner,
								"Remove",
							)
							.size(Size::Small)
							.tone(Tone::Danger)
							.on_click(act::click(UiCommand::RemoveAttachment {
								session:    session.clone(),
								attachment: attachment.id.clone(),
							})),
						),
				),
		);
	}
	group
}

fn kind_name(kind: &FileKind) -> &'static str {
	match kind {
		FileKind::Directory => "folder",
		FileKind::Text => "text file",
		FileKind::Image => "image",
		FileKind::Binary => "binary file",
		FileKind::Symlink => "symbolic link",
		FileKind::Other => "file",
	}
}

fn status_tone(status: &str) -> Tone {
	match status {
		"added" => Tone::Ok,
		"deleted" => Tone::Danger,
		"binary" | "renamed" | "modified" => Tone::Muted,
		_ => Tone::Warn,
	}
}
