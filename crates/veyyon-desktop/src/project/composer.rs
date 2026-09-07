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
/// `Running` carrying `mode`, the queue mode the window holds: no host frame
/// reports one, so a mode read from the store would revert the toggle on the
/// next frame the running turn produces.
#[must_use]
pub fn project_turn_phase(
	store: &Store,
	session: Option<&SessionId>,
	mode: QueueMode,
) -> TurnPhase {
	let Some(session_id) = session else {
		return TurnPhase::Idle;
	};

	// 1. Attached decisions take precedence (§5.4, §5.5). The phase names the
	// first card of its kind, which is the card the primary action answers.
	if let Some(decisions) = store.interactions.get(session_id) {
		if let Some(approval) = decisions.approvals.first() {
			return TurnPhase::ApprovalPending { interaction: approval.id.clone() };
		}
		if let Some(question) = decisions.questions.first() {
			return TurnPhase::QuestionPending {
				interaction: question.id.clone(),
				options:     question.options.len(),
			};
		}
		if let Some(plan) = decisions.plans.first() {
			return TurnPhase::PlanPending { interaction: plan.id.clone() };
		}
	}

	// 2. Active generation or tool streaming (§5.4).
	if store.streaming.contains_key(session_id) {
		return TurnPhase::Running { queue_mode: clamp_queue_mode(store, mode) };
	}

	// 3. Neither decision pending nor running.
	TurnPhase::Idle
}

/// A background submission the host does not accept leaves one mode: a prompt
/// sent while a turn runs steers it (§5.13).
const fn clamp_queue_mode(store: &Store, mode: QueueMode) -> QueueMode {
	if matches!(
		store.capabilities.get(Capability::BackgroundSubmission),
		CapabilityStatus::Unavailable { .. }
	) {
		QueueMode::Steer
	} else {
		mode
	}
}

/// Projects the footer's controls from what the host reported (§5.4, §5.13).
///
/// Model, thinking level and context meter are the host's: a frame overwrites
/// them. What the window owns — the text, the attachments and the queue mode —
/// is left alone, so a frame arriving mid-keystroke takes none of it. The mode
/// is still clamped to what the transport can carry.
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

	composer.queue_mode = clamp_queue_mode(store, composer.queue_mode);
}
