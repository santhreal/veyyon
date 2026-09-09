//! Host model selection, reasoning levels and context usage project without
//! overwriting window-local attachments. Live provider discovery is tested
//! separately.

mod support;

use std::collections::HashMap;

use support::{NOW_MS, session};
use veyyon_desktop::{SessionIndex, project, project::project_controls};
use veyyon_desktop_model::{
	Capability, CapabilityStatus, ConnectionState, ContextBreakdownView, InputModality, ModelRef,
	ModelView, ModelsView, QueueMode, QueuePartition, RequestRegistry, SessionId, Store, SurfaceId,
};
use veyyon_desktop_surface::{
	Attachment, Availability, MediaType, ShellState, composer::payload_for,
};

#[test]
fn the_footer_shows_the_model_thinking_and_context_the_host_reported() {
	let mut store = Store::new();
	let session_id = SessionId::from("s");
	store.sessions.insert(session("s", QueuePartition::Live));
	store.persisted.shell.active_session = Some(session_id.clone());
	// The capability map states what the host declared; the transport gate then
	// narrows it, so a detached socket would mute every control regardless.
	store.connection = ConnectionState::Connected { endpoint: "socket".to_string(), protocol: 1 };
	store
		.capabilities
		.set(Capability::Models, CapabilityStatus::Available);
	store.domains.models = Some(ModelsView {
		models:          vec![ModelView {
			provider:       "anthropic".into(),
			id:             "claude-sonnet-4.5".into(),
			name:           "Claude Sonnet 4.5".into(),
			reasoning:      true,
			context_window: 200_000,
			max_output:     64_000,
			input:          vec![InputModality::Text, InputModality::Image],
		}],
		current:         Some(ModelRef {
			provider: "anthropic".into(),
			id:       "claude-sonnet-4.5".into(),
		}),
		thinking_level:  Some("high".into()),
		thinking_levels: ["off", "low", "medium", "high"].map(str::to_owned).to_vec(),
	});
	store
		.domains
		.context
		.insert(session_id.clone(), ContextBreakdownView {
			session:      session_id.clone(),
			total_tokens: 82_400,
			limit_tokens: Some(200_000),
			categories:   Vec::new(),
		});

	// What the window owns is not the host's to overwrite: the attachment the
	// operator added and the queue mode chosen survive the frame that reports a
	// new model.
	let mut state = ShellState::default();
	state.composer.queue_mode = QueueMode::Queue;
	state.composer.attachments.push(Attachment::from_clipboard(
		1,
		MediaType::Png,
		payload_for(MediaType::Png, vec![0x89, b'P', b'N', b'G']),
	));
	// One index across the projections: the row ids every session-scoped
	// control is gated under come out of it, so a throwaway index would leave
	// the assertions below reading a control no projection owns.
	let mut index = SessionIndex::new();
	let registry = RequestRegistry::new();
	project(&store, &mut index, &HashMap::new(), NOW_MS, &mut state);
	project_controls(&store, &registry, &index, &mut state);

	let model = state
		.composer
		.model
		.as_ref()
		.expect("the models view projects");
	assert_eq!(model.label(), Some("Claude Sonnet 4.5"));
	assert_eq!(
		model.accepts(InputModality::Video),
		Some(false),
		"the catalog lists the model without video, so a clip flags unsupported"
	);
	let thinking = state
		.composer
		.thinking
		.as_ref()
		.expect("the levels project");
	assert_eq!(thinking.level, "high");
	assert_eq!(thinking.next(), Some("off"), "cycling wraps to the first level");
	assert_eq!(
		state.composer.context.and_then(|meter| meter.percent()),
		Some(41),
		"82.4k of 200k is 41% context"
	);
	assert_eq!(state.composer.queue_mode, QueueMode::Queue, "the frame left the window's mode");
	assert_eq!(state.composer.attachments.len(), 1, "the frame left the window's attachments");

	// Whether the picker is offered is not the model control's to state: the
	// footer reads the gate `project_controls` resolved for the selector, and
	// that is the one place the decision is made (§5.13). A capability the host
	// refused mutes the control with the host's own reason; one it has not
	// answered yet leaves it at rest, because a control disabled before attach
	// states something false.
	let row = index
		.row_id(&session_id)
		.expect("the session listed holds a row id");
	let selector = SurfaceId::ComposerModelSelector(SessionId::from(row.to_string()));
	assert_eq!(
		state.controls.availability(&selector),
		Availability::Enabled,
		"the host declared Models over a live transport and the picker is still withheld"
	);

	store
		.capabilities
		.set(Capability::Models, CapabilityStatus::UnknownUntilAttached);
	project(&store, &mut index, &HashMap::new(), NOW_MS, &mut state);
	project_controls(&store, &registry, &index, &mut state);
	assert_eq!(
		state.controls.availability(&selector),
		Availability::Unknown,
		"a capability the host has not answered drew the picker as refused"
	);

	store
		.capabilities
		.set(Capability::Models, CapabilityStatus::Unavailable {
			reason: "no provider is configured".to_string(),
		});
	project(&store, &mut index, &HashMap::new(), NOW_MS, &mut state);
	project_controls(&store, &registry, &index, &mut state);
	assert_eq!(
		state.controls.availability(&selector),
		Availability::Unavailable { reason: "no provider is configured".to_string() },
		"a refused capability lost the host's own reason at the control"
	);
}
