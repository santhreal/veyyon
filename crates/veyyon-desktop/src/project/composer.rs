//! Projects the store's streaming and interaction state onto the session's turn
//! phase (§5.4).

use veyyon_desktop_model::{Capability, CapabilityStatus, QueueMode, SessionId, Store};
use veyyon_desktop_surface::{
	ComposerState, ContextMeter, ModelChoice, ModelControl, ModelOption, ThinkingControl, TurnPhase,
};

/// Derives the active turn phase for a session from the store.
///
/// Operator decisions (approvals, questions, plans) take precedence. When an
/// execution is actively streaming without a blocking decision, the phase is
/// `Running` with the session's configured `QueueMode`. Otherwise, the session
/// is `Idle`.
#[must_use]
pub fn project_turn_phase(store: &Store, session: Option<&SessionId>) -> TurnPhase {
	let Some(session_id) = session else {
		return TurnPhase::Idle;
	};

	// 1. Attached decisions take precedence (§5.4, §5.5).
	if let Some(decisions) = store.interactions.get(session_id) {
		if !decisions.approvals.is_empty() {
			return TurnPhase::ApprovalPending;
		}
		if let Some(first_question) = decisions.questions.first() {
			return TurnPhase::QuestionPending { options: first_question.options.len() };
		}
		if !decisions.plans.is_empty() {
			return TurnPhase::PlanPending;
		}
	}

	// 2. Active generation or tool streaming (§5.4).
	if store.streaming.contains_key(session_id) {
		let queue_mode = store
			.composer_drafts
			.get(session_id)
			.map_or(QueueMode::Steer, |draft| draft.queue_mode);
		return TurnPhase::Running { queue_mode };
	}

	// 3. Neither decision pending nor running.
	TurnPhase::Idle
}

/// Projects the footer's controls from what the host reported (§5.4, §5.13).
///
/// Model, thinking level and context meter are the host's: a frame overwrites
/// them. The queue mode lives in the session's draft, which the host persists.
/// What the window owns — the text and the attachments — is left alone, so a
/// frame arriving mid-keystroke takes neither.
pub fn project_composer(store: &Store, session: Option<&SessionId>, composer: &mut ComposerState) {
	let models = store.domains.models.as_ref();
	composer.model = models.map(|view| ModelControl {
		current:    view
			.current
			.as_ref()
			.map(|reference| ModelChoice::new(reference.provider.clone(), reference.id.clone())),
		options:    view
			.models
			.iter()
			.map(|model| ModelOption {
				choice:    ModelChoice::new(model.provider.clone(), model.id.clone()),
				name:      model.name.clone(),
				reasoning: model.reasoning,
				input:     model.input.clone(),
			})
			.collect(),
		// The control becomes a label naming the active model when the host
		// never answered whether it accepts SelectModel (§5.13).
		selectable: matches!(store.capabilities.get(Capability::Models), CapabilityStatus::Available),
	});

	composer.thinking = models.and_then(|view| {
		let level = view.thinking_level.clone()?;
		Some(ThinkingControl { level, levels: view.thinking_levels.clone() })
	});

	composer.context = session
		.and_then(|id| store.domains.context.get(id))
		.map(|breakdown| ContextMeter {
			used_tokens:  breakdown.total_tokens,
			limit_tokens: breakdown.limit_tokens,
		});

	composer.queue_mode = session
		.and_then(|id| store.composer_drafts.get(id))
		.map_or(QueueMode::Steer, |draft| draft.queue_mode);
}
