//! Host model selection, reasoning levels and context usage project without
//! overwriting window-local attachments. Live provider discovery is tested
//! separately.

mod support;

use std::collections::HashMap;

use support::{NOW_MS, session};
use veyyon_desktop::{SessionIndex, project};
use veyyon_desktop_model::{
	Capability, CapabilityStatus, ContextBreakdownView, InputModality, ModelRef,
	ModelView, ModelsView, QueueMode, QueuePartition, SessionId, Store,
};
use veyyon_desktop_surface::{Attachment, MediaType, ShellState, composer::payload_for};

#[test]
fn the_footer_shows_the_model_thinking_and_context_the_host_reported() {
	let mut store = Store::new();
	let session_id = SessionId::from("s");
	store.sessions.insert(session("s", QueuePartition::Live));
	store.persisted.shell.active_session = Some(session_id.clone());
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
	project(&store, &mut SessionIndex::new(), &HashMap::new(), NOW_MS, &mut state);

	let model = state
		.composer
		.model
		.as_ref()
		.expect("the models view projects");
	assert!(model.selectable, "the host accepts SelectModel");
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

	// A host that never answered the Models capability gets a label naming the
	// active model and no picker (§5.13).
	store
		.capabilities
		.set(Capability::Models, CapabilityStatus::UnknownUntilAttached);
	project(&store, &mut SessionIndex::new(), &HashMap::new(), NOW_MS, &mut state);
	assert!(
		!state
			.composer
			.model
			.as_ref()
			.expect("the models view still projects")
			.selectable,
		"an unknown capability is not permission to send SelectModel"
	);
}
