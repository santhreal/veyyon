//! WHY THIS SUITE EXISTS:
//! The capability map holds what the host declared while it was reachable, and
//! nothing in it changes when the socket drops. Every control in a `Fatal` or
//! `Reconnecting` window therefore read `Available` and answered a click that
//! reached nothing: the composer's send button was drawn in full accent under a
//! banner stating the host was unreachable. §8.12 disables every action control
//! in `Detached`, `Connecting`, `Syncing` and `Fatal`, and every mutation in
//! `Reconnecting`, where navigation over cached entries stays permitted.
//!
//! THE CLASS THIS CLOSES:
//! Any host action offered in a transport state that cannot carry it, and any
//! control the projection leaves offered there. The variant space is
//! `HostActionKind::iter()` crossed with `ConnectionStateKind::iter()`, both
//! derived from the model at run time, so a new action or a new connection
//! state fails this suite until its answer is recorded, and the whole
//! projected control map is swept rather than a list of ids, so a control
//! added to `project_controls` is covered by what it is.
//! `transport_reason` and `classify_action` are exhaustive matches, so neither
//! enum can grow past them without a compile error.
//!
//! WHAT IT DOES NOT CATCH:
//! It drives one keyboard path, the composer's primary chord, against the
//! projection it reads; a handler on another surface that raises an intent
//! without reading `ControlStates` is outside it, and nothing gates an intent
//! at the dispatch seam. It does not judge the classification itself — an
//! action filed as ephemeral that mutates state is `classify_action`'s
//! defect, and `egress_action_classification_is_exhaustive` is its suite. The
//! sweep reads the controls this fixture's store reaches: one live session
//! with a pending question and plan, so a control projected only from a
//! provider, MCP server, keybinding or terminal the store does not hold is
//! outside it.

use std::{
	collections::HashMap,
	path::PathBuf,
	sync::{Arc, Mutex},
};

use strum::IntoEnumIterator;
use veyyon_desktop::{
	ActionClassification, AssetPaths, SessionIndex, StartupBundle, classify_action,
	load_startup_bundle, project, project_controls, scene::seed::Seed, transport_gate,
};
use veyyon_desktop_model::{
	Capability, CapabilityStatus, ConnectionState, ConnectionStateKind, Gate, HostActionKind,
	InteractionId, PROTOCOL_VERSION, PendingDecisions, PlanInteraction, QuestionInteraction,
	QueuePartition, RequestId, SessionId, SurfaceId,
};
use veyyon_desktop_scene::{Appearance, RenderOptions, headless_context, render_view_captured};
use veyyon_desktop_surface::{
	Availability, ControlStates, Intent, ShellState, ShellView, install_tokens,
};
use veyyon_gpui::{App, AppContext, Window};

/// The clock the projection measures elapsed labels against, pinned so the
/// suite does not read the wall.
const CLOCK_MS: u64 = 1_700_000_000_000;

/// The reason a host that answered gives, so a narrowing can be told from a
/// refusal the transport did not author.
const HOST_REFUSAL: &str = "the host does not implement it";

/// The ids the seeded decisions carry, so their controls can be addressed.
const QUESTION_ID: &str = "interaction_question";
const PLAN_ID: &str = "interaction_plan";

/// One value of every connection state. The match is exhaustive over
/// `ConnectionStateKind`, so a new state fails to compile here.
fn state_of(kind: ConnectionStateKind) -> ConnectionState {
	match kind {
		ConnectionStateKind::Detached => ConnectionState::Detached,
		ConnectionStateKind::Connecting => ConnectionState::Connecting { attempt: 2 },
		ConnectionStateKind::Syncing => ConnectionState::Syncing { received: 3, expected: Some(10) },
		ConnectionStateKind::Connected => ConnectionState::Connected {
			endpoint: "127.0.0.1:47000".to_string(),
			protocol: PROTOCOL_VERSION,
		},
		ConnectionStateKind::Reconnecting => ConnectionState::Reconnecting {
			attempt:     1,
			retry_at_ms: 1_700_000_005_000,
			message:     "connection reset by peer".to_string(),
		},
		ConnectionStateKind::Fatal => {
			ConnectionState::Fatal { message: "protocol version mismatch".to_string() }
		},
	}
}

/// Whether the state carries traffic for every action.
const fn carries_everything(kind: ConnectionStateKind) -> bool {
	matches!(kind, ConnectionStateKind::Connected)
}

/// Whether the state leaves this action answerable at all.
fn permits(kind: ConnectionStateKind, action: HostActionKind) -> bool {
	carries_everything(kind)
		|| matches!(action, HostActionKind::RetryConnection)
		|| (matches!(kind, ConnectionStateKind::Reconnecting)
			&& classify_action(action) == ActionClassification::Ephemeral)
}

/// The decisions a session holds while the socket drops, seeded so the
/// answer controls are gated at all.
fn decisions() -> PendingDecisions {
	PendingDecisions {
		approvals: Vec::new(),
		questions: vec![QuestionInteraction {
			id:              InteractionId::from(QUESTION_ID),
			prompt:          "which endpoint".to_string(),
			options:         vec!["one".to_string(), "two".to_string()],
			requested_at_ms: CLOCK_MS,
		}],
		plans:     vec![PlanInteraction {
			id:              InteractionId::from(PLAN_ID),
			markdown_plan:   "# plan".to_string(),
			requested_at_ms: CLOCK_MS,
		}],
	}
}

/// The shell one connection state projects, paired with the row id every
/// session-scoped control is gated under. Every capability is set available,
/// as the host declared them while it was reachable, so what withholds a
/// control here is the transport and nothing else. `pending` seeds the
/// question and plan the session is waiting on.
fn window(state: ConnectionState, pending: bool) -> (ShellState, SessionId) {
	let mut seed = Seed::connection(state);
	for capability in Capability::ALL {
		seed
			.store
			.capabilities
			.set(capability, CapabilityStatus::Available);
	}
	let session = seed.session(QueuePartition::Live);
	if pending {
		seed.store.interactions.insert(session.clone(), decisions());
	}
	let mut index = SessionIndex::new();
	let mut shell = ShellState::default();
	project(&seed.store, &mut index, &HashMap::new(), CLOCK_MS, &mut shell);
	project_controls(&seed.store, &seed.registry, &index, &mut shell);
	let row = index
		.row_id(&session)
		.expect("the session listed holds a row id");
	shell.current_id = row;
	(shell, SessionId::from(row.to_string()))
}

/// The control states of that window.
fn projected(state: ConnectionState, pending: bool) -> (ControlStates, SessionId) {
	let (shell, row) = window(state, pending);
	(shell.controls, row)
}

#[test]
fn every_action_is_withheld_in_a_state_that_cannot_carry_it() {
	for kind in ConnectionStateKind::iter() {
		let state = state_of(kind);
		for action in HostActionKind::iter() {
			let gate = transport_gate(action, &state, Gate::Enabled);
			if permits(kind, action) {
				assert_eq!(gate, Gate::Enabled, "{action:?} is answerable in {kind:?}");
				continue;
			}
			match gate {
				Gate::Unavailable { reason } => assert!(
					!reason.is_empty(),
					"{action:?} withheld in {kind:?} states why it is withheld"
				),
				other => panic!("{action:?} is offered in {kind:?} as {other:?}"),
			}
		}
	}
}

#[test]
fn the_transport_narrows_a_gate_and_never_widens_one() {
	let refused = Gate::Unavailable { reason: HOST_REFUSAL.to_string() };
	for kind in ConnectionStateKind::iter() {
		let state = state_of(kind);
		for action in HostActionKind::iter() {
			let Gate::Unavailable { reason } = transport_gate(action, &state, refused.clone()) else {
				panic!("{action:?} in {kind:?} widened a refusal into an offer");
			};
			if permits(kind, action) {
				assert_eq!(reason, HOST_REFUSAL, "{action:?} in {kind:?} keeps the host's reason");
			}
		}
		let pending = Gate::Pending { request: RequestId(7) };
		assert_eq!(
			transport_gate(HostActionKind::RetryConnection, &state, pending.clone()),
			pending,
			"the action that ends {kind:?} keeps its in-flight mark"
		);
	}
}

#[test]
fn a_dead_socket_withholds_the_send_button_and_offers_the_way_back() {
	for kind in [ConnectionStateKind::Fatal, ConnectionStateKind::Detached] {
		let (controls, row) = projected(state_of(kind), false);
		assert!(
			matches!(
				controls.availability(&SurfaceId::ComposerSendButton(row)),
				Availability::Unavailable { .. }
			),
			"{kind:?} withholds the composer's send button"
		);
		assert!(
			!matches!(
				controls.availability(&SurfaceId::ConnectionRetryButton),
				Availability::Unavailable { .. }
			),
			"{kind:?} keeps the control that ends it"
		);
	}
}

#[test]
fn reconnecting_withholds_a_mutation_and_keeps_navigation() {
	let (controls, row) = projected(state_of(ConnectionStateKind::Reconnecting), false);
	assert!(
		matches!(
			controls.availability(&SurfaceId::ComposerSendButton(row.clone())),
			Availability::Unavailable { .. }
		),
		"a prompt submitted while reconnecting reaches nothing"
	);
	assert!(
		!matches!(
			controls.availability(&SurfaceId::QueueSessionRow(row)),
			Availability::Unavailable { .. }
		),
		"a queue row still opens what the client cached"
	);
	assert!(
		!matches!(
			controls.availability(&SurfaceId::SettingsField("extensions".to_string())),
			Availability::Unavailable { .. }
		),
		"a settings page over cached state is still readable while reconnecting"
	);
}

#[test]
fn an_answer_to_a_decision_is_withheld_while_the_socket_is_down() {
	for kind in [ConnectionStateKind::Fatal, ConnectionStateKind::Reconnecting] {
		let (controls, row) = projected(state_of(kind), true);
		let question = InteractionId::from(QUESTION_ID);
		let plan = InteractionId::from(PLAN_ID);
		for surface in [
			SurfaceId::QuestionSubmitButton(row.clone(), question),
			SurfaceId::PlanAcceptButton(row.clone(), plan.clone()),
			SurfaceId::PlanRefineButton(row.clone(), plan),
		] {
			assert!(
				matches!(controls.availability(&surface), Availability::Unavailable { .. }),
				"{kind:?} withholds {surface:?}, which would answer a host that is not there"
			);
		}
	}
}

#[test]
fn no_control_the_projection_sets_is_left_offered_while_the_host_is_unreachable() {
	let (controls, _) = projected(state_of(ConnectionStateKind::Fatal), true);
	let mut swept = 0_usize;
	let offered: Vec<String> = controls
		.projected()
		.inspect(|_| swept += 1)
		.filter(|(id, availability)| {
			!matches!(id, SurfaceId::ConnectionRetryButton)
				&& !matches!(availability, Availability::Unavailable { .. })
		})
		.map(|(id, availability)| format!("{id:?} reads {availability:?}"))
		.collect();
	assert!(
		offered.is_empty(),
		"every control but the way back is withheld while the host is unreachable, and these are \
		 not: {offered:?}"
	);
	assert!(swept > 20, "the sweep read the whole projection, not a handful: {swept} controls");
}

/// The bundled tokens and themes a rendered shell installs.
fn startup_assets() -> StartupBundle {
	let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../veyyon-desktop-tokens");
	load_startup_bundle(AssetPaths {
		tokens_dir: root.join("tokens"),
		themes_dir: root.join("themes"),
	})
	.expect("bundled tokens and themes load")
}

/// Types a draft into a shell whose controls carry one connection state's
/// gates, presses the composer's primary chord, and reports what it sent.
fn chorded_send(state: ConnectionState) -> Vec<Intent> {
	let (shell, _) = window(state, false);
	let mut cx = headless_context().expect("a headless renderer is required to build the shell");
	let bundle = startup_assets();
	let options = RenderOptions {
		width: 1200,
		height: 800,
		appearance: Appearance::Dark,
		scale_factor: 1.0,
		..RenderOptions::default()
	};
	let sink: Arc<Mutex<Vec<Intent>>> = Arc::new(Mutex::new(Vec::new()));
	let observed = Arc::clone(&sink);
	render_view_captured(&mut cx, &options, move |_window: &mut Window, app: &mut App| {
		let installed = install_tokens(app, &bundle.tokens, &bundle.theme, &bundle.surface_path)
			.expect("tokens install");
		let view = app.new(move |_cx| ShellView::new(installed, shell));
		view.update(app, |view, cx| {
			view.set_composed("ship it", cx);
			view.submit_primary_turn_action(cx);
			*observed.lock().expect("intent sink") = view.drain_intents();
		});
		view
	})
	.expect("the shell builds and renders");
	sink.lock().expect("intent sink").clone()
}

#[test]
fn the_composer_chord_sends_nothing_its_own_button_is_withholding() {
	let attached = chorded_send(state_of(ConnectionStateKind::Connected));
	assert!(
		attached
			.iter()
			.any(|intent| matches!(intent, Intent::Send { .. })),
		"the chord submits the draft while the host is there: {attached:?}"
	);
	for kind in
		[ConnectionStateKind::Fatal, ConnectionStateKind::Reconnecting, ConnectionStateKind::Detached]
	{
		let raised = chorded_send(state_of(kind));
		assert!(
			raised.is_empty(),
			"the chord raises nothing in {kind:?}, where the send button is withheld: {raised:?}"
		);
	}
}
