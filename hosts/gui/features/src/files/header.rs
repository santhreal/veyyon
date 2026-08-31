//! Selected file header, breadcrumb navigation, and external/copy actions.

use std::sync::Arc;

use gpui::{App, ParentElement, Styled, div, px};
use veyyon_gui_core::{Store, UiCommand, model::FileReadView};
use veyyon_gui_kit::{
	motion::RetainedKey,
	theme::{Theme, layout, size, space, weight},
	ui::{Button, Fill, Icon, Size, Tone},
};

use super::{
	FilesHandles, logic,
	owners::{self, Chrome},
	preview,
};
use crate::act;

pub fn file_header(
	store: &Store,
	path: &str,
	read: Option<&FileReadView>,
	handles: &FilesHandles,
	stale: bool,
	cx: &mut App,
) -> gpui::Div {
	let theme = Theme::get(cx);
	let mut crumbs = div().flex().items_center().min_w(px(0.0)).overflow_hidden();
	for (index, crumb) in logic::breadcrumbs(path).enumerate() {
		if index > 0 {
			crumbs = crumbs.child(
				div()
					.px(px(space::TIGHT))
					.text_color(theme.text_faint)
					.child("/"),
			);
		}
		crumbs = crumbs.child(
			div()
				.max_w(px(layout::measure()))
				.overflow_hidden()
				.whitespace_nowrap()
				.text_ellipsis()
				.text_size(px(size::meta()))
				.font_weight(if crumb.end == path.len() {
					weight::MEDIUM
				} else {
					weight::REGULAR
				})
				.text_color(if crumb.end == path.len() {
					theme.text
				} else {
					theme.text_muted
				})
				.child(crumb.label.to_owned()),
		);
	}
	let connected = store.connection.is_connected();
	let mut refresh = action_button(
		"refresh-selected-file",
		owners::chrome(Chrome::RefreshSelected),
		Icon::Running,
		"Refresh file",
		(!connected).then_some("Reconnect before refreshing"),
	);
	if let Some(file) = store.frontend.selected_file.clone().filter(|_| connected) {
		refresh = refresh.on_click(act::click(UiCommand::ReadFile { file, range: None }));
	}
	let reveal = action_button(
		"reveal-selected-file",
		owners::chrome(Chrome::RevealSelected),
		Icon::Checkout,
		"Reveal in file tree",
		None,
	)
	.on_click(act::click(UiCommand::RevealSelectedFile));
	let copy_path = action_button(
		"copy-selected-path",
		owners::chrome(Chrome::CopyPath),
		Icon::Copy,
		"Copy path",
		None,
	)
	.on_click(act::click(UiCommand::CopyText(path.to_owned())));
	let open_disabled = if !connected {
		Some("Reconnect before opening externally")
	} else if stale {
		Some("File is stale")
	} else {
		None
	};
	let mut open = action_button(
		"open-selected-external",
		owners::chrome(Chrome::OpenExternal),
		Icon::Read,
		"Open externally",
		open_disabled,
	);
	if connected && !stale {
		open = open.on_click(act::click(UiCommand::OpenExternal(path.to_owned())));
	}
	let contents = read.and_then(|read| copyable_text(read, handles));
	let mut copy_contents = action_button(
		"copy-selected-contents",
		owners::chrome(Chrome::CopyContents),
		Icon::Copy,
		"Copy file contents",
		contents
			.is_none()
			.then_some("This reader has no text to copy"),
	);
	if let Some(contents) = contents {
		copy_contents = copy_contents.on_click(move |_, window, cx| {
			act::run(UiCommand::CopyText(contents.to_string()), window, cx);
		});
	}
	div()
		.flex()
		.items_center()
		.h(px(layout::toolbar()))
		.gap(px(space::TIGHT))
		.px(px(space::BASE))
		.border_b_1()
		.border_color(theme.stroke)
		.child(crumbs.flex_1().min_w(px(0.0)))
		.child(refresh)
		.child(reveal)
		.child(copy_path)
		.child(copy_contents)
		.child(open)
}

fn copyable_text(read: &FileReadView, handles: &FilesHandles) -> Option<Arc<str>> {
	match handles.cached_body(&read.id)? {
		preview::CachedBody::Text { source, .. } | preview::CachedBody::Markdown { source, .. } => {
			Some(source)
		},
		preview::CachedBody::Image(_)
		| preview::CachedBody::Binary { .. }
		| preview::CachedBody::TooLarge { .. }
		| preview::CachedBody::Unavailable(_) => None,
	}
}

fn action_button(
	id: &'static str,
	owner: RetainedKey,
	icon: Icon,
	tip: &'static str,
	disabled_reason: Option<&'static str>,
) -> Button {
	let mut button = Button::new(id, owner, icon)
		.fill(Fill::Ghost)
		.tone(Tone::Muted)
		.size(Size::Small)
		.tip(tip);
	if let Some(reason) = disabled_reason {
		button = button.disabled(reason);
	}
	button
}
