//! File/severity grouped Problems presentation.

use gpui::{
	AnyElement, App, Entity, InteractiveElement, IntoElement, ParentElement, ScrollHandle, Styled,
	div, px,
};
use veyyon_gui_core::{
	Store, UiCommand,
	model::{DiagnosticLevel, DiagnosticView, DiagnosticsSnapshot, RemoteData, Versioned},
};
use veyyon_gui_kit::{
	input::Editor,
	motion::{OwnerNamespace, RetainedKey},
	theme::{Elevation, Theme, layout, size, space, weight},
	ui::{Badge, Banner, Empty, Fill, Icon, Row, Scrolls, SearchField, Size, Spinner, Tone, text},
};

use super::logic;
use crate::act;

const SEARCH_OWNER: RetainedKey = RetainedKey::semantic(OwnerNamespace::Terminal, 9);

/// Draw Problems from the diagnostics replica; no empty producer error is
/// interpreted as a healthy result.
pub fn render(
	store: &Store,
	field: &Entity<Editor>,
	scroll: &ScrollHandle,
	cx: &mut App,
) -> AnyElement {
	match &store.replica.diagnostics {
		RemoteData::Unrequested => unrequested(store, cx),
		RemoteData::Loading { .. } => loading(),
		RemoteData::Empty if store.connection.is_connected() => healthy_empty(),
		RemoteData::Empty => unrequested(store, cx),
		RemoteData::Ready(snapshot) => ready(store, field, snapshot, None, scroll, cx),
		RemoteData::Stale { value, reason } => {
			ready(store, field, value, Some(format!("Diagnostics are stale: {reason:?}")), scroll, cx)
		},
		RemoteData::Error { message, stale: Some(snapshot), .. } => {
			ready(store, field, snapshot, Some(message.clone()), scroll, cx)
		},
		RemoteData::Error { message, retryable, stale: None } => failed(message, *retryable, cx),
	}
}

fn unrequested(store: &Store, _cx: &mut App) -> AnyElement {
	if store.connection.is_connected() {
		let mut state = Empty::new("Problems have not been checked")
			.note("Run diagnostics for the attached workspace.")
			.icon(Icon::Failed)
			.filling();
		state.extend([crate::terminal::control::button("problems-load", "Check now")
			.fill(Fill::Solid)
			.tone(Tone::Accent)
			.on_click(act::click(UiCommand::RefreshDiagnostics))
			.into_any_element()]);
		state.into_any_element()
	} else {
		Empty::new("Problems are unavailable")
			.note("Attach a host to check workspace diagnostics.")
			.icon(Icon::Failed)
			.filling()
			.into_any_element()
	}
}

fn loading() -> AnyElement {
	div()
		.flex()
		.size_full()
		.items_center()
		.justify_center()
		.child(Spinner::new(crate::terminal::control::retained("problems-loading"), Icon::Running))
		.into_any_element()
}

fn healthy_empty() -> AnyElement {
	Empty::new("No problems found")
		.note("The diagnostics sources completed without findings.")
		.icon(Icon::Check)
		.filling()
		.into_any_element()
}

fn failed(message: &str, retryable: bool, _cx: &mut App) -> AnyElement {
	let mut banner = Banner::failure("Diagnostics failed").detail(message.to_owned());
	if retryable {
		banner.extend([crate::terminal::control::button("problems-retry", "Retry")
			.tone(Tone::Danger)
			.fill(Fill::Tinted)
			.on_click(act::click(UiCommand::RefreshDiagnostics))
			.into_any_element()]);
	}
	div()
		.flex()
		.size_full()
		.items_center()
		.justify_center()
		.p(px(space::WIDE))
		.child(banner)
		.into_any_element()
}

fn ready(
	store: &Store,
	field: &Entity<Editor>,
	snapshot: &Versioned<DiagnosticsSnapshot>,
	warning: Option<String>,
	scroll: &ScrollHandle,
	cx: &mut App,
) -> AnyElement {
	let has_warning = warning.is_some();
	let levels: Vec<_> = store.frontend.problem_levels.iter().copied().collect();
	let groups = logic::groups(&snapshot.value, &store.frontend.problem_filter, &levels);
	let count = logic::visible_count(&groups)
		+ snapshot.value.notices.len()
		+ snapshot.value.startup_health.len();
	if count == 0
		&& snapshot.value.source_errors.is_empty()
		&& snapshot.value.session_resume_warning.is_none()
		&& store.connection.is_connected()
	{
		return healthy_empty();
	}
	let theme = Theme::get(cx);
	let mut column = div()
		.id("problems-scroll")
		.flex()
		.flex_col()
		.flex_1()
		.min_h(px(0.0))
		.p(px(space::SNUG))
		.gap(px(space::SNUG));
	if let Some(message) = warning {
		column = column.child(Banner::waiting("Showing stale diagnostics").detail(message));
	}
	if !has_warning && !store.connection.is_connected() {
		let detail = match &store.connection {
			veyyon_gui_core::model::ConnectionState::Reconnecting { message, .. }
			| veyyon_gui_core::model::ConnectionState::Fatal { message } => message.as_str(),
			_ => "Retained diagnostics remain readable; refresh is disabled.",
		};
		column =
			column.child(Banner::waiting("Diagnostics are disconnected").detail(detail.to_owned()));
	}
	if let veyyon_gui_core::model::CommandState::Failed { message, .. } =
		store.command_state(&veyyon_gui_core::store::CommandTarget::Diagnostics)
	{
		column = column.child(Banner::failure("Diagnostics command failed").detail(message));
	}
	if let Some(message) = &snapshot.value.session_resume_warning {
		column =
			column.child(Banner::waiting("Session resumed with a warning").detail(message.clone()));
	}
	for source_error in &snapshot.value.source_errors {
		let mut banner = Banner::failure(format!("{} diagnostics failed", source_error.source))
			.detail(source_error.message.clone());
		if source_error.retryable && store.connection.is_connected() {
			banner.extend([crate::terminal::control::button(
				format!("retry-diagnostic-{}", source_error.source),
				"Retry",
			)
			.size(Size::Small)
			.tone(Tone::Danger)
			.fill(Fill::Tinted)
			.on_click(act::click(UiCommand::RetryDiagnosticSource(source_error.source.clone())))
			.into_any_element()]);
		}
		column = column.child(banner);
	}
	for diagnostic in snapshot
		.value
		.startup_health
		.iter()
		.chain(snapshot.value.notices.iter())
	{
		column = column.child(notice_row(diagnostic, store.frontend.selected_diagnostic.as_ref()));
	}
	for group in groups {
		column = column.child(file_group(group, &theme, store.frontend.selected_diagnostic.as_ref()));
	}
	div()
		.flex()
		.flex_col()
		.size_full()
		.min_h(px(0.0))
		.child(toolbar(count, store, field, &theme))
		.child(column.scrolls_y(scroll, Elevation::Chrome))
		.into_any_element()
}

fn toolbar(count: usize, store: &Store, field: &Entity<Editor>, theme: &Theme) -> impl IntoElement {
	let all_levels = store.frontend.problem_levels.is_empty();
	let scroll = ScrollHandle::new();
	let mut bar = div()
		.flex()
		.items_center()
		.id("problems-view-scroll-1")
		.gap(px(space::SNUG))
		.h(px(layout::toolbar()))
		.px(px(space::SNUG))
		.border_b_1()
		.border_color(theme.stroke)
		.bg(theme.chrome)
		.child(
			div()
				.text_size(px(size::body()))
				.font_weight(weight::MEDIUM)
				.text_color(theme.text)
				.child("Problems"),
		)
		.child(Badge::new(count.to_string()).exact());
	for (level, label, tone) in [
		(DiagnosticLevel::Error, "Errors", Tone::Danger),
		(DiagnosticLevel::Warning, "Warnings", Tone::Warn),
		(DiagnosticLevel::Information, "Info", Tone::Muted),
	] {
		bar = bar.child(
			crate::terminal::control::button(format!("problem-level-{label}"), label)
				.size(Size::Small)
				.tone(tone)
				.on(all_levels || store.frontend.problem_levels.contains(&level))
				.on_click(act::click(UiCommand::ToggleProblemLevel(level))),
		);
	}
	bar = bar.child(SearchField::new("problem-filter", SEARCH_OWNER, field.clone()));
	bar.child(text::spacer())
		.child(
			crate::terminal::control::enabled(
				crate::terminal::control::button("problems-previous", "Previous").size(Size::Small),
				count > 0,
				"Action unavailable in the current state",
			)
			.on_click(act::click(UiCommand::NextDiagnostic { forward: false })),
		)
		.child(
			crate::terminal::control::enabled(
				crate::terminal::control::button("problems-next", "Next").size(Size::Small),
				count > 0,
				"Action unavailable in the current state",
			)
			.on_click(act::click(UiCommand::NextDiagnostic { forward: true })),
		)
		.child(
			crate::terminal::control::enabled(
				crate::terminal::control::button("problems-refresh", "Refresh").size(Size::Small),
				store.connection.is_connected(),
				"Action unavailable in the current state",
			)
			.on_click(act::click(UiCommand::RefreshDiagnostics)),
		)
		.scrolls_x(&scroll, Elevation::Chrome)
}

fn file_group(
	group: logic::ProblemGroup<'_>,
	theme: &Theme,
	selected: Option<&veyyon_gui_core::model::NoticeId>,
) -> impl IntoElement {
	let mut section = div().flex().flex_col().min_w(px(0.0));
	section = section.child(
		div()
			.flex()
			.items_center()
			.gap(px(space::BASE))
			.h(px(layout::control_height()))
			.px(px(space::BASE))
			.bg(theme.raised)
			.child(
				text::line(group.path.to_owned())
					.font_family(theme.font_mono)
					.text_size(px(size::meta()))
					.font_weight(weight::MEDIUM)
					.text_color(theme.text),
			),
	);
	for severity in group.severities {
		let (label, tone) = severity_presentation(severity.level);
		section = section.child(
			div()
				.flex()
				.items_center()
				.gap(px(space::BASE))
				.px(px(space::BASE))
				.py(px(space::TIGHT))
				.child(Badge::new(label).tone(tone))
				.child(
					Badge::new(severity.diagnostics.len().to_string())
						.exact()
						.bare(),
				),
		);
		for diagnostic in severity.diagnostics {
			section = section.child(problem_row(group.file, diagnostic, tone, selected));
		}
	}
	section
}

fn notice_row(
	diagnostic: &DiagnosticView,
	selected: Option<&veyyon_gui_core::model::NoticeId>,
) -> Row {
	let (_, tone) = severity_presentation(diagnostic.level);
	crate::terminal::control::row(
		format!("diagnostic-notice-{}", diagnostic.id),
		diagnostic.message.clone(),
	)
	.note(diagnostic.source.clone())
	.tone(tone)
	.selected(selected == Some(&diagnostic.id))
	.on_click(act::click(UiCommand::SelectDiagnostic(diagnostic.id.clone())))
	.hover_actions(
		veyyon_gui_kit::theme::control::two_action_slots(),
		crate::terminal::control::icon_button(
			format!("copy-diagnostic-notice-{}", diagnostic.id),
			Icon::Copy,
		)
		.tip("Copy diagnostic")
		.size(Size::Small)
		.on_click(act::click(UiCommand::CopyDiagnostic(diagnostic.id.clone()))),
	)
	.hover_actions(
		veyyon_gui_kit::theme::control::two_action_slots(),
		crate::terminal::control::icon_button(
			format!("dismiss-diagnostic-notice-{}", diagnostic.id),
			Icon::Close,
		)
		.tip("Dismiss notice")
		.size(Size::Small)
		.on_click(act::click(UiCommand::DismissNotice(diagnostic.id.clone()))),
	)
}

fn problem_row(
	_file: &veyyon_gui_core::model::FileId,
	diagnostic: &DiagnosticView,
	tone: Tone,
	selected: Option<&veyyon_gui_core::model::NoticeId>,
) -> Row {
	let location = match (diagnostic.line, diagnostic.column) {
		(Some(line), Some(column)) => format!("{} · {line}:{column}", diagnostic.source),
		(Some(line), None) => format!("{} · line {line}", diagnostic.source),
		(None, _) => diagnostic.source.clone(),
	};
	crate::terminal::control::row(format!("problem-{}", diagnostic.id), diagnostic.message.clone())
		.note(location)
		.tone(tone)
		.selected(selected == Some(&diagnostic.id))
		.on_click(act::click(UiCommand::OpenDiagnostic(diagnostic.id.clone())))
		.hover_actions(
			veyyon_gui_kit::theme::control::action_slot(),
			crate::terminal::control::icon_button(
				format!("copy-problem-{}", diagnostic.id),
				Icon::Copy,
			)
			.tip("Copy diagnostic")
			.size(Size::Small)
			.on_click(act::click(UiCommand::CopyDiagnostic(diagnostic.id.clone()))),
		)
}

fn severity_presentation(level: DiagnosticLevel) -> (&'static str, Tone) {
	match level {
		DiagnosticLevel::Error => ("Errors", Tone::Danger),
		DiagnosticLevel::Warning => ("Warnings", Tone::Warn),
		DiagnosticLevel::Information => ("Information", Tone::Muted),
	}
}
