//! Bottom-trailing floating notification stack.
//!
//! Arranges the most recent notifications nearest the bottom-trailing screen
//! edge, provides a "+N more" badge when the bounded count is exceeded, and
//! halts automatic expiration while pointer hover is active.

use gpui::{
	AnyElement, App, ElementId, InteractiveElement, IntoElement, ParentElement, Styled, div, px,
};
use veyyon_gui_core::{
	Store,
	model::{Notification, NotificationTone},
};
use veyyon_gui_kit::{
	theme::{Theme, radius, size, space, weight},
	ui::{Button, Fill, Size, Toast, Tone, text},
};

use super::owners::{StackChrome, stack_control, toast_owner};
use crate::act;

/// Maximum number of toasts drawn on screen simultaneously.
pub const MAX_VISIBLE_TOASTS: usize = 4;

/// Map a core notification tone to the corresponding design token tone.
pub fn tone_of(tone: NotificationTone) -> Tone {
	match tone {
		NotificationTone::Ok => Tone::Ok,
		NotificationTone::Warn => Tone::Warn,
		NotificationTone::Error => Tone::Danger,
		NotificationTone::Info => Tone::Plain,
	}
}

/// Render the bottom-trailing notification stack if any notifications exist.
pub fn render(store: &Store, cx: &mut App) -> Option<AnyElement> {
	let entries = store.replica.notifications.entries();
	if entries.is_empty() {
		return None;
	}
	let total = entries.len();
	let visible_count = total.min(MAX_VISIBLE_TOASTS);
	let overflow = total.saturating_sub(MAX_VISIBLE_TOASTS);

	// Slice the most recent notifications. Newest nearest the bottom edge.
	let visible_entries = &entries[total - visible_count..];

	let theme = Theme::get(cx);
	let mut stack = div()
		.id(ElementId::from("notification-stack"))
		.absolute()
		.bottom(px(space::WIDE))
		.right(px(space::WIDE))
		.flex()
		.flex_col()
		.items_end()
		.gap(px(space::SNUG));

	if overflow > 0 {
		let _more_owner = stack_control(StackChrome::More);
		let dismiss_all_owner = stack_control(StackChrome::DismissAll);
		let overflow_bar = div()
			.flex()
			.items_center()
			.gap(px(space::SNUG))
			.px(px(space::BASE))
			.py(px(space::TIGHT))
			.rounded(px(radius::CARD))
			.bg(theme.overlay)
			.border_1()
			.border_color(theme.stroke)
			.shadow(theme.shadow_menu())
			.child(
				text::line(format!("+{overflow} more"))
					.text_size(px(size::meta()))
					.font_weight(weight::MEDIUM)
					.text_color(theme.text_muted),
			)
			.child(
				Button::labelled("notification-dismiss-all", dismiss_all_owner, "Dismiss all")
					.size(Size::Small)
					.fill(Fill::Ghost)
					.tone(Tone::Muted),
			);
		stack = stack.child(overflow_bar);
	}

	for notification in visible_entries {
		let toast_element = render_toast(notification);
		stack = stack.child(toast_element);
	}

	Some(stack.into_any_element())
}

fn render_toast(notification: &Notification) -> Toast {
	let owner = toast_owner(&notification.id);
	let tone = tone_of(notification.tone);
	let mut toast =
		Toast::new(notification.id.as_str().to_owned(), owner, notification.title.clone())
			.tone(tone)
			.count(notification.count);

	if let Some(detail) = &notification.detail {
		toast = toast.detail(detail.clone());
	}

	if let Some((label, command)) = &notification.action {
		let cmd = command.clone();
		toast = toast.action(label.clone(), act::click(cmd));
	}
	toast
}
