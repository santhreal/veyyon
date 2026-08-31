//! Tool approval with explicit risk context and request-bound decisions.

use gpui::{AnyElement, App, IntoElement, ParentElement, Styled, div, px};
use veyyon_gui_core::{
	Store, UiCommand,
	model::{
		ApprovalDecision, InteractionId, InteractionKind, InteractionRequest, InteractionResponse,
	},
};
use veyyon_gui_kit::{
	motion::RetainedKey,
	theme::{Theme, space},
	ui::{Banner, Button, Card, Empty, Fill, Icon, Sheet, Spinner, Tone, text},
};

use super::{
	interaction::{self, RequestState},
	state::owner_of,
};
use crate::act;

pub fn render(store: &Store, id: &InteractionId, open: bool, cx: &mut App) -> AnyElement {
	let sheet_owner = owner_of(&format!("approval:{id}"));
	let body = match interaction::request(store, id) {
		RequestState::Loading => {
			let owner = owner_of(&format!("approval:{id}:loading"));
			Spinner::new(owner, Icon::Running).into_any_element()
		},
		RequestState::Missing => Empty::new("This approval request has ended")
			.icon(Icon::Notice)
			.into_any_element(),
		RequestState::Error { message, retryable } => {
			let mut banner = Banner::failure("Approval unavailable").detail(message.to_owned());
			if retryable {
				let owner = owner_of(&format!("approval:{id}:retry"));
				banner = banner.child(
					Button::labelled("approval-retry", owner, "Retry")
						.on_click(act::click(UiCommand::RetryConnection)),
				);
			}
			banner.into_any_element()
		},
		RequestState::Stale(request, reason) => form(store, request, Some(reason), cx),
		RequestState::Ready(request) => form(store, request, None, cx),
	};
	let theme = Theme::get(cx);
	Sheet::new("approval-dialog", sheet_owner, open)
		.centred()
		.on_dismiss(act::click(UiCommand::CancelInteraction {
			interaction: id.clone(),
			timed_out:   false,
		}))
		.child(text::heading("Approval required", &theme))
		.child(body)
		.into_any_element()
}

fn form(
	store: &Store,
	request: &InteractionRequest,
	stale: Option<String>,
	cx: &mut App,
) -> AnyElement {
	let theme = Theme::get(cx);
	let InteractionKind::Approval { tool, tool_name, tier, reason, risk, scope, arguments } =
		&request.kind
	else {
		return Banner::failure("Approval payload unavailable")
			.detail("The request changed type while it was open")
			.into_any_element();
	};
	let tool_name = if tool_name.is_empty() {
		store
			.replica
			.tools
			.readable()
			.and_then(|versioned| {
				versioned
					.value
					.iter()
					.find(|candidate| &candidate.id == tool)
			})
			.map(|tool| tool.name.clone())
			.unwrap_or_else(|| tool.to_string())
	} else {
		tool_name.clone()
	};
	let connected = store.connection.is_connected() && stale.is_none();
	let disabled_reason = if stale.is_some() {
		"Reconnect before answering"
	} else {
		"This approval cannot be sent while disconnected"
	};
	let mut content = div()
		.flex()
		.flex_col()
		.gap(px(space::BASE))
		.children(stale.map(|message| Banner::notice("Approval response paused").detail(message)))
		.child(fact("Tool", tool_name, &theme))
		.child(fact(
			"Agent",
			request
				.agent
				.as_ref()
				.map(ToString::to_string)
				.unwrap_or_else(|| "Not provided".to_owned()),
			&theme,
		))
		.child(fact("Tier", format!("{tier:?}"), &theme))
		.child(fact(
			"Risk",
			risk
				.clone()
				.unwrap_or_else(|| "No additional risk detail".to_owned()),
			&theme,
		))
		.child(fact(
			"Reason",
			reason
				.clone()
				.unwrap_or_else(|| "No reason was provided".to_owned()),
			&theme,
		))
		.child(fact(
			"Scope",
			scope
				.clone()
				.unwrap_or_else(|| "This request only".to_owned()),
			&theme,
		))
		.child(
			Card::new()
				.ground(theme.sunken)
				.pad(space::BASE)
				.child(text::body(arguments.clone(), &theme)),
		);
	let deny_owner = control_owner(request, "deny");
	let session_owner = control_owner(request, "session");
	let always_owner = control_owner(request, "always");
	let once_owner = control_owner(request, "once");
	content = content.child(
		div()
			.flex()
			.flex_wrap()
			.items_center()
			.justify_end()
			.gap(px(space::SNUG))
			.child(decision_button(
				"approval-deny",
				deny_owner,
				"Deny",
				Tone::Danger,
				ApprovalDecision::Deny { reason: None },
				connected,
				disabled_reason,
				request,
			))
			.child(decision_button(
				"approval-session",
				session_owner,
				"Allow for session",
				Tone::Plain,
				ApprovalDecision::AllowSession,
				connected,
				disabled_reason,
				request,
			))
			.child(decision_button(
				"approval-always",
				always_owner,
				"Always allow",
				Tone::Plain,
				ApprovalDecision::AllowAlways,
				connected,
				disabled_reason,
				request,
			))
			.child(decision_button(
				"approval-once",
				once_owner,
				"Allow once",
				Tone::Accent,
				ApprovalDecision::AllowOnce,
				connected,
				disabled_reason,
				request,
			)),
	);
	content.into_any_element()
}

fn control_owner(request: &InteractionRequest, control: &str) -> RetainedKey {
	owner_of(&format!("approval:{}:{control}", request.id))
}

// A decision button is described by eight independent facts, not a state bag.
#[allow(clippy::too_many_arguments)]
fn decision_button(
	id: &str,
	owner: RetainedKey,
	label: &str,
	tone: Tone,
	decision: ApprovalDecision,
	enabled: bool,
	disabled_reason: &str,
	request: &InteractionRequest,
) -> Button {
	let mut button = Button::labelled(id.to_owned(), owner, label.to_owned())
		.tone(tone)
		.fill(if tone == Tone::Danger {
			Fill::Tinted
		} else {
			Fill::Solid
		})
		.on_click(act::click(UiCommand::SubmitInteraction {
			interaction: request.id.clone(),
			response:    InteractionResponse::Approval(decision),
		}));
	if !enabled {
		button = button.disabled(disabled_reason.to_owned());
	}
	button
}

fn fact(label: &str, value: String, theme: &Theme) -> gpui::Div {
	div()
		.flex()
		.items_start()
		.gap(px(space::BASE))
		.child(text::meta(label.to_owned(), theme).flex_none())
		.child(text::body(value, theme).flex_1().min_w(px(0.0)))
}
