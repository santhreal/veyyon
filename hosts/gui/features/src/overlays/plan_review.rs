//! Plan outline/diff review with explicit protocol capability limits.

use gpui::{AnyElement, App, IntoElement, ParentElement, Styled, div, px};
use veyyon_gui_core::{
	Store, UiCommand,
	model::{
		ApprovalDecision, Capability, CapabilityStatus, InteractionId, InteractionResponse,
		PlanState, RemoteData, RequestId,
	},
	navigation::PlanReviewTab,
};
use veyyon_gui_kit::{
	theme::{Theme, space},
	ui::{Banner, Button, Empty, Fill, Icon, Row, Sheet, Spinner, Tab, Tabs, Tone, text},
};

use super::{plan_logic, state::OverlayState};
use crate::{act, render};

pub fn render(
	store: &Store,
	request: Option<RequestId>,
	interaction: Option<InteractionId>,
	state: &mut OverlayState,
	open: bool,
	cx: &mut App,
) -> AnyElement {
	let Some(sheet_owner) = state.owner(format!("plan-review:{request:?}:{interaction:?}")) else {
		return Banner::failure("Plan review unavailable").into_any_element();
	};
	let theme = Theme::get(cx);
	let body = match &store.replica.plan {
		RemoteData::Unrequested | RemoteData::Loading { .. } => {
			let Some(owner) = state.owner("plan-review:loading") else {
				return Banner::failure("Plan review unavailable").into_any_element();
			};
			Spinner::new(owner, Icon::Running).into_any_element()
		},
		RemoteData::Empty => Empty::new("No plan is available")
			.icon(Icon::Notice)
			.into_any_element(),
		RemoteData::Error { message, stale: None, .. } => Banner::failure("Plan unavailable")
			.detail(message.clone())
			.into_any_element(),
		RemoteData::Ready(versioned)
		| RemoteData::Stale { value: versioned, .. }
		| RemoteData::Error { stale: Some(versioned), .. } => {
			plan(store, &versioned.value, request, interaction, state, cx)
		},
	};
	Sheet::new("plan-review", sheet_owner, open)
		.centred()
		.max_width(veyyon_gui_kit::theme::layout::reading())
		.on_dismiss(act::click(UiCommand::CloseTopOverlay))
		.child(text::heading("Review plan", &theme))
		.child(body)
		.into_any_element()
}

fn plan(
	store: &Store,
	plan: &PlanState,
	request: Option<RequestId>,
	interaction: Option<InteractionId>,
	state: &mut OverlayState,
	cx: &mut App,
) -> AnyElement {
	let PlanState::Active { content, approval, .. } = plan else {
		return Empty::new("Plan mode is not active")
			.icon(Icon::Notice)
			.into_any_element();
	};
	if request.is_some() && approval.as_ref().and_then(|approval| approval.request) != request {
		return Empty::new("This plan review request has ended")
			.note("No other request was selected")
			.icon(Icon::Notice)
			.into_any_element();
	}
	if interaction.is_some()
		&& approval
			.as_ref()
			.and_then(|approval| approval.interaction.as_ref())
			!= interaction.as_ref()
	{
		return Empty::new("This plan review request has ended")
			.note("No other request was selected")
			.icon(Icon::Notice)
			.into_any_element();
	}
	let effective_interaction =
		interaction.or_else(|| approval.as_ref().and_then(|a| a.interaction.clone()));
	match content {
		RemoteData::Unrequested | RemoteData::Loading { .. } => {
			let Some(owner) = state.owner("plan-review:content-loading") else {
				return Banner::failure("Plan content unavailable").into_any_element();
			};
			Spinner::new(owner, Icon::Running).into_any_element()
		},
		RemoteData::Empty => Empty::new("The plan has no content")
			.icon(Icon::Notice)
			.into_any_element(),
		RemoteData::Error { message, stale: None, .. } => Banner::failure("Plan content unavailable")
			.detail(message.clone())
			.into_any_element(),
		RemoteData::Ready(source) => {
			review_content(store, source, None, effective_interaction, state, cx)
		},
		RemoteData::Stale { value, reason } => {
			review_content(store, value, Some(format!("{reason:?}")), effective_interaction, state, cx)
		},
		RemoteData::Error { message, stale: Some(source), .. } => {
			review_content(store, source, Some(message.clone()), effective_interaction, state, cx)
		},
	}
}

fn review_content(
	store: &Store,
	source: &str,
	stale: Option<String>,
	interaction: Option<InteractionId>,
	state: &mut OverlayState,
	cx: &mut App,
) -> AnyElement {
	let Some(outline_owner) = state.owner("plan-review:tab:outline") else {
		return Banner::failure("Plan tabs unavailable").into_any_element();
	};
	let Some(diff_owner) = state.owner("plan-review:tab:diff") else {
		return Banner::failure("Plan tabs unavailable").into_any_element();
	};
	let tab = store.frontend.plan_review_tab;
	let tabs = Tabs::new("plan-review-tabs")
		.stretch()
		.tab(
			Tab::new(outline_owner, "Outline", tab == PlanReviewTab::Outline)
				.on_click(act::click(UiCommand::SetPlanReviewTab(PlanReviewTab::Outline))),
		)
		.tab(
			Tab::new(diff_owner, "Diff", tab == PlanReviewTab::Diff)
				.on_click(act::click(UiCommand::SetPlanReviewTab(PlanReviewTab::Diff))),
		);
	let body = match tab {
		PlanReviewTab::Outline => outline(source, state, cx),
		PlanReviewTab::Diff => diff(source, cx),
	};
	div()
		.flex()
		.flex_col()
		.gap(px(space::BASE))
		.children(stale.map(|reason| Banner::notice("Showing cached plan").detail(reason)))
		.child(tabs)
		.child(body)
		.child(actions(store, interaction, state))
		.into_any_element()
}

fn outline(source: &str, state: &mut OverlayState, _cx: &mut App) -> AnyElement {
	let items = plan_logic::outline(source);
	if items.is_empty() {
		return Empty::new("The plan has no outline headings")
			.icon(Icon::Notice)
			.into_any_element();
	}
	let mut list = div().flex().flex_col().gap(px(space::ROWS));
	for (index, item) in items.into_iter().enumerate() {
		let Some(owner) = state.owner(format!("plan-review:outline:{index}:{}", item.label)) else {
			return Banner::failure("Plan outline unavailable").into_any_element();
		};
		list = list.child(
			Row::new(format!("plan-outline-{index}"), owner, item.label)
				.gutter(true)
				.depth(item.level.saturating_sub(1)),
		);
	}
	list.into_any_element()
}

fn diff(source: &str, cx: &mut App) -> AnyElement {
	let files = plan_logic::diffs(source);
	if files.is_empty() {
		return Empty::new("The plan has no proposed diff")
			.icon(Icon::Notice)
			.into_any_element();
	}
	div()
		.flex()
		.flex_col()
		.gap(px(space::BASE))
		.children(render::diff::patch(&files, cx))
		.into_any_element()
}

fn actions(
	store: &Store,
	interaction: Option<InteractionId>,
	state: &mut OverlayState,
) -> AnyElement {
	let connected = store.connection.is_connected();
	let mut row = div().flex().flex_wrap().justify_end().gap(px(space::SNUG));
	if let Some(interaction_id) = interaction {
		let disabled_reason = if !connected {
			Some("Reconnect before responding".to_owned())
		} else {
			None
		};
		if let Some(owner) = state.owner(format!("plan-review:{interaction_id}:cancel")) {
			let mut button = Button::labelled("plan-review-cancel", owner, "Cancel")
				.fill(Fill::Solid)
				.tone(Tone::Danger)
				.on_click(act::click(UiCommand::CancelInteraction {
					interaction: interaction_id.clone(),
					timed_out:   false,
				}));
			if let Some(reason) = &disabled_reason {
				button = button.disabled(reason.clone());
			}
			row = row.child(button);
		}
		if let Some(owner) = state.owner(format!("plan-review:{interaction_id}:approve")) {
			let mut button = Button::labelled("plan-review-approve", owner, "Approve")
				.fill(Fill::Solid)
				.tone(Tone::Accent)
				.on_click(act::click(UiCommand::SubmitInteraction {
					interaction: interaction_id,
					response:    InteractionResponse::Approval(ApprovalDecision::AllowOnce),
				}));
			if let Some(reason) = &disabled_reason {
				button = button.disabled(reason.clone());
			}
			row = row.child(button);
		}
	} else {
		let unavailable = match store.replica.capabilities.get(&Capability::Plans) {
			Some(CapabilityStatus::Unavailable { reason }) => reason.clone(),
			Some(CapabilityStatus::UnknownUntilAttached) | None => {
				"The host has not advertised plan approval commands".to_owned()
			},
			Some(CapabilityStatus::Available) => {
				"This host exposes plan data but no typed approval response contract".to_owned()
			},
		};
		for (id, label, tone) in [
			("cancel", "Cancel", Tone::Danger),
			("revise", "Request revision", Tone::Plain),
			("approve", "Approve", Tone::Accent),
		] {
			if let Some(owner) = state.owner(format!("plan-review:{id}")) {
				row = row.child(
					Button::labelled(format!("plan-review-{id}"), owner, label)
						.fill(if tone == Tone::Plain {
							Fill::Ghost
						} else {
							Fill::Solid
						})
						.tone(tone)
						.disabled(unavailable.clone()),
				);
			}
		}
	}
	row.into_any_element()
}
