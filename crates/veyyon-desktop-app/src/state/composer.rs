//! What the composer and the interaction dock read from and write to the
//! state: whether a turn runs, the persisted draft, the prompt a dequeue
//! handed back or a branch cut off, the decision the dock shows and the
//! answer to it.

use serde_json::{Value, json};
use veyyon_desktop_model::{
	ApprovalInteraction, AutoswarmConsoleView, Capability, CapabilityStatus, ComposerEditView,
	ComposerStore, ContentBlock, DialogInteraction, Gate, GoalView, HostAction, HostActionKind,
	InteractionId, MessageRole, PendingDecisions, PlanInteraction, QuestionInteraction, QueueMode,
	QueuedPromptsView, RequestId, SessionId, SurfaceId, gate_link,
};
use veyyon_gpui::Context;

use super::{AppState, StoreEvent};

/// One decision a session waits on, of any kind.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Decision<'a> {
	/// A tool call waiting for approval.
	Approval(&'a ApprovalInteraction),
	/// A question with options or a free-text answer.
	Question(&'a QuestionInteraction),
	/// A plan waiting to be accepted or refined.
	Plan(&'a PlanInteraction),
	/// A dialog of several questions.
	Dialog(&'a DialogInteraction),
}

impl Decision<'_> {
	/// The interaction the decision answers.
	#[must_use]
	pub const fn id(&self) -> &InteractionId {
		match self {
			Self::Approval(approval) => &approval.id,
			Self::Question(question) => &question.id,
			Self::Plan(plan) => &plan.id,
			Self::Dialog(dialog) => &dialog.id,
		}
	}

	/// When the host raised the decision.
	#[must_use]
	pub const fn requested_at_ms(&self) -> u64 {
		match self {
			Self::Approval(approval) => approval.requested_at_ms,
			Self::Question(question) => question.requested_at_ms,
			Self::Plan(plan) => plan.requested_at_ms,
			Self::Dialog(dialog) => dialog.requested_at_ms,
		}
	}
}

/// Every decision `pending` holds, oldest first; decisions raised at the same
/// instant keep the order approvals, questions, plans, dialogs.
#[must_use]
pub fn decisions(pending: &PendingDecisions) -> Vec<Decision<'_>> {
	// Destructured without `..`, so a decision kind added to the model fails
	// to compile here instead of never reaching the dock.
	let PendingDecisions { approvals, questions, plans, dialogs } = pending;
	let mut all: Vec<Decision<'_>> = approvals
		.iter()
		.map(Decision::Approval)
		.chain(questions.iter().map(Decision::Question))
		.chain(plans.iter().map(Decision::Plan))
		.chain(dialogs.iter().map(Decision::Dialog))
		.collect();
	all.sort_by_key(Decision::requested_at_ms);
	all
}

/// One answer to a question of a dialog.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct DialogAnswer {
	/// The question answered.
	pub id:           String,
	/// The indices of the picked options.
	pub selected:     Vec<u32>,
	/// Text written in place of or beside the options.
	pub custom_input: Option<String>,
	/// A remark on the picked option or the written answer.
	pub note:         Option<String>,
}

/// An answer to a decision, in the shape the host reads for its kind.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Answer {
	/// Approves or declines a tool call, once or for the rest of the session.
	Approval {
		/// Whether the call may run.
		approved:    bool,
		/// Whether the answer stands for the rest of the session.
		for_session: bool,
	},
	/// Picks option `index` of a question, whose text is `text`.
	Option {
		/// The picked option's position.
		index: usize,
		/// The picked option's text.
		text:  String,
	},
	/// Answers a question with free text.
	Reply {
		/// The answer.
		text: String,
	},
	/// Accepts a plan, or sends it back with `feedback`.
	Plan {
		/// Whether the plan is accepted.
		accepted: bool,
		/// What to change, empty on an acceptance.
		feedback: String,
	},
	/// Submits one answer per question of a dialog.
	Dialog(Vec<DialogAnswer>),
	/// Discusses the dialog's questions in the conversation instead.
	Chat,
}

impl Answer {
	/// The response body `RespondToInteraction` carries.
	#[must_use]
	pub fn to_json(&self) -> Value {
		match self {
			Self::Approval { approved, for_session } => {
				let scope = if *for_session { "session" } else { "once" };
				json!({ "approved": approved, "scope": scope })
			},
			Self::Option { index, text } => json!({ "option": index, "text": text }),
			Self::Reply { text } => json!({ "text": text }),
			Self::Plan { accepted, feedback } => json!({ "accepted": accepted, "feedback": feedback }),
			Self::Dialog(answers) => {
				let answers: Vec<Value> = answers
					.iter()
					.map(|answer| {
						let mut body = json!({ "id": answer.id, "selected": answer.selected });
						if let Some(map) = body.as_object_mut() {
							if let Some(text) = &answer.custom_input {
								map.insert("custom_input".to_owned(), Value::String(text.clone()));
							}
							if let Some(note) = &answer.note {
								map.insert("note".to_owned(), Value::String(note.clone()));
							}
						}
						body
					})
					.collect();
				json!({ "kind": "submit", "answers": answers })
			},
			Self::Chat => json!({ "kind": "chat" }),
		}
	}
}

impl AppState {
	/// Whether a turn is running in `session`: the host is streaming a reply
	/// or a tool into it.
	pub fn is_turn_running(&self, session: &SessionId) -> bool {
		self.store.streaming.contains_key(session)
	}

	/// Whether `kind` may be sent now, and why not when it may not: the
	/// host's capability for it, narrowed by what the link carries.
	pub fn gate(&self, kind: HostActionKind) -> Gate {
		gate_link(kind, &self.store.connection, &self.store.capabilities, &self.registry)
	}

	/// Why the host takes no `kind` now, or `None` while it does.
	pub fn refusal(&self, kind: HostActionKind) -> Option<String> {
		match self.gate(kind) {
			Gate::Unavailable { reason, .. } => Some(reason),
			_ => None,
		}
	}

	/// The goal `session` runs.
	pub fn goal(&self, session: &SessionId) -> Option<&GoalView> {
		self.store.goals.get(session)
	}

	/// The autoswarm console `session` has open.
	pub fn autoswarm_console(&self, session: &SessionId) -> Option<&AutoswarmConsoleView> {
		self.store.domains.autoswarm.get(session)
	}

	/// The queue mode a prompt sent during a turn uses: `mode`, unless the
	/// host carries no background submission, which leaves steering.
	pub const fn effective_queue_mode(&self, mode: QueueMode) -> QueueMode {
		match self
			.store
			.capabilities
			.get(Capability::BackgroundSubmission)
		{
			CapabilityStatus::Unavailable { .. } => QueueMode::Steer,
			CapabilityStatus::Available | CapabilityStatus::UnknownUntilAttached => mode,
		}
	}

	/// The draft the composer left in `session`.
	pub fn draft(&self, session: &SessionId) -> Option<&ComposerStore> {
		self.store.persisted.composer.get(session)
	}

	/// Records the draft the composer leaves in `session`, which the window
	/// writes with the rest of its state. An empty draft in the default queue
	/// mode removes the record.
	pub fn save_draft(&mut self, session: SessionId, draft: ComposerStore, cx: &mut Context<Self>) {
		let empty = draft.draft_text.is_empty()
			&& draft.attachments.is_empty()
			&& draft.queue_mode == QueueMode::default();
		self.remember(cx, |persisted| {
			if empty {
				persisted.composer.remove(&session);
			} else {
				persisted.composer.insert(session, draft);
			}
		});
	}

	/// Holds the prompt a `DequeueQueuedPrompt` answer handed back until the
	/// session's composer takes it.
	pub(super) fn note_restored(&mut self, view: &QueuedPromptsView) {
		if let Some(text) = &view.restored {
			self.restored.insert(view.session.clone(), text.clone());
		}
	}

	/// Takes the prompt the host handed back to `session`'s draft.
	pub fn take_restored_prompt(&mut self, session: &SessionId) -> Option<String> {
		self.restored.remove(session)
	}

	/// Names the entry a `BranchSession` forks at and holds the prompt the
	/// fork cuts off until the host answers `request`. The host forks only
	/// at a prompt and hands its words back to no window, so a request that
	/// names no entry is pointed at the last prompt of the branch the window
	/// holds, and the prompt read here is the one the fork removes.
	pub(super) fn name_fork_point(&mut self, action: &mut HostAction, request: RequestId) {
		let HostAction::BranchSession { session, entry } = action else {
			return;
		};
		let Some(tree) = self.store.transcripts.get(session) else {
			return;
		};
		let prompt = match entry {
			Some(id) => tree.get(id).filter(|held| held.role == MessageRole::User),
			None => self.transcripts.get(session).and_then(|cached| {
				cached
					.order
					.ids()
					.iter()
					.rev()
					.filter_map(|id| tree.get(id))
					.find(|held| held.role == MessageRole::User)
			}),
		};
		let Some(prompt) = prompt else {
			return;
		};
		*entry = Some(prompt.id.clone());
		let words = prompt
			.content
			.iter()
			.filter_map(|block| match block {
				ContentBlock::Text { text } => Some(text.as_str()),
				_ => None,
			})
			.collect();
		self.branching.insert(request, words);
	}

	/// Hands the prompt a settled `BranchSession` cut off to the session the
	/// window shows, which the host made the fork before answering, and
	/// drops it when the host refused the branch.
	pub(super) fn settle_branch(&mut self, request: RequestId, ok: bool) {
		let Some(words) = self.branching.remove(&request) else {
			return;
		};
		if ok
			&& !words.is_empty()
			&& let Some(session) = self.displayed.clone()
		{
			self.restored.insert(session, words);
		}
	}

	/// Takes the edits extensions queued for `session`'s draft, oldest first.
	pub fn take_composer_edits(&mut self, session: &SessionId) -> Vec<ComposerEditView> {
		self.store.domains.take_composer_edits(session)
	}

	/// The decisions `session` waits on, oldest first.
	pub fn decisions(&self, session: &SessionId) -> Vec<Decision<'_>> {
		self
			.store
			.interactions
			.get(session)
			.map_or_else(Vec::new, decisions)
	}

	/// Whether `session` waits on any decision.
	pub fn has_decision(&self, session: &SessionId) -> bool {
		self
			.store
			.interactions
			.get(session)
			.is_some_and(|pending| !pending.is_empty())
	}

	/// Sends again the request the host refused on `surface`. Returns `None`
	/// when the control holds no refused request or the host called its
	/// refusal final, and takes the refusal off the control either way.
	pub fn retry_refused(
		&mut self,
		surface: &SurfaceId,
		cx: &mut Context<Self>,
	) -> Option<RequestId> {
		let action = self.store.retries.take(surface)?;
		Some(self.dispatch(action, surface.clone(), cx))
	}

	/// Forgets the request the host refused on `surface`, for a refusal the
	/// operator dismissed.
	pub fn forget_refused(&mut self, surface: &SurfaceId) {
		self.store.retries.take(surface);
	}

	/// Sends `answer` to the decision `interaction` of `session` on behalf of
	/// `surface`, and takes the decision off the pending set so the next one
	/// shows before the host confirms this one. A refused answer puts the
	/// decision back.
	pub fn respond_to_interaction(
		&mut self,
		session: SessionId,
		interaction: &InteractionId,
		answer: &Answer,
		surface: SurfaceId,
		cx: &mut Context<Self>,
	) -> RequestId {
		let action = HostAction::RespondToInteraction {
			session:        session.clone(),
			interaction_id: interaction.0.clone(),
			response:       answer.to_json(),
		};
		let request = self.dispatch(action, surface, cx);
		if let Some(pending) = self.store.interactions.get_mut(&session) {
			let PendingDecisions { approvals, questions, plans, dialogs } = pending;
			let taken = PendingDecisions {
				approvals: take(approvals, |approval| &approval.id == interaction),
				questions: take(questions, |question| &question.id == interaction),
				plans:     take(plans, |plan| &plan.id == interaction),
				dialogs:   take(dialogs, |dialog| &dialog.id == interaction),
			};
			if !taken.is_empty() {
				self.answering.insert(request, (session.clone(), taken));
			}
			cx.emit(StoreEvent::InteractionsChanged { session });
		}
		request
	}

	/// Ends the answer `request` carried: a refused one puts its decision
	/// back and returns the session whose decisions changed.
	pub(super) fn settle_answer(&mut self, request: RequestId, ok: bool) -> Option<SessionId> {
		let (session, taken) = self.answering.remove(&request)?;
		if ok {
			return None;
		}
		let pending = self.store.interactions.entry(session.clone()).or_default();
		let PendingDecisions { approvals, questions, plans, dialogs } = taken;
		pending.approvals.extend(approvals);
		pending.questions.extend(questions);
		pending.plans.extend(plans);
		pending.dialogs.extend(dialogs);
		Some(session)
	}

	/// Forgets the answers in flight for `session`, whose pending set the
	/// host just stated whole.
	pub(super) fn forget_answers(&mut self, session: &SessionId) {
		self.answering.retain(|_, (held, _)| held != session);
	}
}

/// Removes the items of `items` that `matches` and returns them.
fn take<T>(items: &mut Vec<T>, matches: impl Fn(&T) -> bool) -> Vec<T> {
	let (taken, kept) = std::mem::take(items)
		.into_iter()
		.partition(|item| matches(item));
	*items = kept;
	taken
}
