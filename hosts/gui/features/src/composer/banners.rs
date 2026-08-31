//! Required decisions and local failures adjacent to the composer action.

use gpui::{Div, ParentElement, Styled, div, px};
use veyyon_gui_core::{
	Store, UiCommand,
	model::{
		ApprovalDecision, CommandState, ConnectionState, InteractionKind, InteractionRequest,
		InteractionResponse, PlanState, TurnState,
	},
	navigation::Overlay,
};
use veyyon_gui_kit::{
	theme::space,
	ui::{Banner, Button, Fill, Icon, Tone},
};

use super::{logic, state::ComposerState};
use crate::act;

pub fn pending_context(store: &Store, state: &ComposerState) -> Div {
	let mut stack = div().flex().flex_col().gap(px(space::X4));
	if let Some(banner) = connection_banner(store, state) {
		stack = stack.child(banner);
	}
	if let Some(interaction) = active_interaction(store) {
		stack = stack.child(interaction_banner(interaction, state));
	} else if let Some(banner) = plan_banner(store, state) {
		stack = stack.child(banner);
	}
	if let Some((_, draft)) = logic::selected_draft(store)
		&& let CommandState::Failed { message, .. } = &draft.submission
	{
		stack = stack.child(
			Banner::failure("The message was not sent")
				.detail(format!("{message}. The draft and its context are retained.")),
		);
	}
	if let Some(runtime) = logic::active_runtime(store) {
		match &runtime.turn {
			TurnState::Retrying { attempt, max, delay_ms, error, .. } => {
				stack = stack.child(
					Banner::waiting(format!("Retrying provider request {attempt}/{max}"))
						.detail(format!("{error} · retry in {delay_ms} ms")),
				);
			},
			TurnState::Compacting { reason, action } => {
				stack = stack.child(
					Banner::waiting("Compacting conversation").detail(format!("{reason} · {action}")),
				);
			},
			TurnState::Idle | TurnState::Running { .. } | TurnState::Aborting => {},
		}
	}
	stack
}

fn connection_banner(store: &Store, state: &ComposerState) -> Option<Banner> {
	match &store.connection {
		ConnectionState::Detached => Some(
			Banner::notice("No host is attached")
				.detail("Drafts remain editable. Attach a host before sending."),
		),
		ConnectionState::Connecting { attempt } => {
			Some(Banner::waiting("Attaching host").detail(format!("Connection attempt {attempt}")))
		},
		ConnectionState::Syncing { received, expected } => {
			Some(Banner::waiting("Synchronizing session").detail(expected.map_or_else(
				|| format!("{received} entries received"),
				|expected| format!("{received} of {expected} entries received"),
			)))
		},
		ConnectionState::Connected { .. } => provider_banner(store),
		ConnectionState::Reconnecting { attempt, message, .. } => Some(
			Banner::waiting("Connection interrupted")
				.detail(format!("Attempt {attempt}: {message}. Drafts are retained."))
				.child(
					Button::labelled("composer-retry-connection", state.control_owner(21), "Retry now")
						.icon(Icon::Retry)
						.on_click(act::click(UiCommand::RetryConnection)),
				),
		),
		ConnectionState::Fatal { message } => Some(
			Banner::failure("Host is unavailable")
				.detail(message.clone())
				.child(
					Button::labelled("composer-retry-fatal", state.control_owner(22), "Retry")
						.icon(Icon::Retry)
						.on_click(act::click(UiCommand::RetryConnection)),
				),
		),
	}
}

fn provider_banner(store: &Store) -> Option<Banner> {
	let runtime = logic::active_runtime(store)?;
	let provider = runtime.provider.as_ref()?;
	let providers = store.replica.providers.readable()?;
	let provider = providers
		.value
		.iter()
		.find(|candidate| &candidate.id == provider)?;
	if let Some(error) = &provider.error {
		return Some(
			Banner::failure(format!("{} is unavailable", provider.name)).detail(error.clone()),
		);
	}
	if !provider.authenticated {
		return Some(
			Banner::waiting(format!("{} needs authentication", provider.name))
				.detail("Open Providers to authenticate before sending."),
		);
	}
	None
}

fn active_interaction(store: &Store) -> Option<&InteractionRequest> {
	store.replica.interactions.readable()?.value.first()
}

fn interaction_banner(interaction: &InteractionRequest, state: &ComposerState) -> Banner {
	match &interaction.kind {
		InteractionKind::Approval { reason, risk, arguments, .. } => {
			let detail = [reason.as_deref(), risk.as_deref(), Some(arguments.as_str())]
				.into_iter()
				.flatten()
				.collect::<Vec<_>>()
				.join(" · ");
			Banner::waiting("Approval required")
				.detail(detail)
				.child(
					Button::labelled("deny-approval", state.control_owner(30), "Deny")
						.tone(Tone::Danger)
						.on_click(act::click(UiCommand::SubmitInteraction {
							interaction: interaction.id.clone(),
							response:    InteractionResponse::Approval(ApprovalDecision::Deny {
								reason: None,
							}),
						})),
				)
				.child(
					Button::labelled("approve-request", state.control_owner(31), "Approve")
						.fill(Fill::Solid)
						.tone(Tone::Accent)
						.on_click(act::click(UiCommand::SubmitInteraction {
							interaction: interaction.id.clone(),
							response:    InteractionResponse::Approval(ApprovalDecision::AllowOnce),
						})),
				)
		},
		InteractionKind::OpenUrl { title, url } => {
			Banner::waiting(title.clone()).detail(url.clone()).child(
				Button::labelled("open-request-url", state.control_owner(32), "Open")
					.icon(Icon::Export)
					.on_click(act::click(UiCommand::OpenExternal(url.clone()))),
			)
		},
		kind => {
			let (title, detail) = interaction_copy(kind);
			Banner::waiting(title).detail(detail).child(
				Button::labelled("answer-request", state.control_owner(33), "Answer")
					.icon(Icon::Question)
					.fill(Fill::Solid)
					.tone(Tone::Accent)
					.on_click(act::click(UiCommand::OpenOverlay(Overlay::Question {
						interaction: interaction.id.clone(),
					}))),
			)
		},
	}
}

fn interaction_copy(kind: &InteractionKind) -> (String, String) {
	match kind {
		InteractionKind::Ask { question, header, .. } => (
			header
				.clone()
				.unwrap_or_else(|| "Question requires an answer".to_owned()),
			question.clone(),
		),
		InteractionKind::Select { title, .. }
		| InteractionKind::Input { title, .. }
		| InteractionKind::Editor { title, .. } => {
			(title.clone(), "Complete this request before sending another message".to_owned())
		},
		InteractionKind::Confirm { title, message } => (title.clone(), message.clone()),
		InteractionKind::Approval { .. } => {
			("Approval required".to_owned(), "Review the tool request".to_owned())
		},
		InteractionKind::OpenUrl { title, url } => (title.clone(), url.clone()),
	}
}

fn plan_banner(store: &Store, state: &ComposerState) -> Option<Banner> {
	let plan = &store.replica.plan.readable()?.value;
	let PlanState::Active { approval: Some(approval), .. } = plan else {
		return None;
	};
	Some(
		Banner::waiting(
			approval
				.title
				.clone()
				.unwrap_or_else(|| "Plan review required".to_owned()),
		)
		.detail(
			approval
				.summary
				.clone()
				.unwrap_or_else(|| "Review the plan before the agent continues".to_owned()),
		)
		.child(
			Button::labelled("review-plan", state.control_owner(34), "Review plan")
				.icon(Icon::Plan)
				.fill(Fill::Solid)
				.tone(Tone::Accent)
				.on_click(act::click(UiCommand::OpenOverlay(Overlay::PlanReview {
					request:     approval.request,
					interaction: approval.interaction.clone(),
				}))),
		),
	)
}
