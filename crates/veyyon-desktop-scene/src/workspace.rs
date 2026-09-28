//! The real desktop window, rendered headless over a seeded store.
//!
//! The scene is the binary's own composition: the six regions the binary
//! builds, under the [`Workspace`] root, over an [`AppState`] whose store was
//! fed a fixed list of host events. Two renders of one seed draw the same
//! bytes; a different seed names different threads and draws different ones.
//!
//! Every timestamp the seed carries lies in the year 2100. A relative label
//! reads the wall clock at render, and an age that saturates at zero reads
//! `now` on every run rather than a count that moves between two renders.

use veyyon_desktop_app::{AppState, regions, workspace::Workspace};
use veyyon_desktop_model::{
	ConnectionState, ContentBlock, EntryId, HostEvent, MessageRole, PROTOCOL_VERSION, PanelsStore,
	SessionHeaderView, SessionId, SessionStatus, SessionSummary, SnapshotSection, Store,
	TranscriptEntry, Versioned,
};
use veyyon_desktop_ui::theme::Theme;
use veyyon_gpui::AppContext as _;

use crate::headless::{Captured, RenderError, RenderOptions, headless_context, render_view};

/// 2100-01-01T00:00:00Z in milliseconds: later than any wall clock a render
/// reads, so every relative label is `now`.
const FUTURE_MS: u64 = 4_102_444_800_000;

/// Words a seed picks thread titles from.
const WORDS: [&str; 8] =
	["parser", "arena", "goal card", "drawer", "palette", "socket", "theme", "sidebar"];

/// The projects the seeded threads are grouped under.
const PROJECTS: [&str; 2] = ["/work/alpha", "/work/beta"];

/// How many threads a seed lists.
const THREADS: u64 = 5;

fn session_id(seed: u64, index: u64) -> SessionId {
	SessionId::from(format!("scene-{seed}-{index}"))
}

fn title(seed: u64, index: u64) -> String {
	let word = WORDS[usize::try_from(seed.wrapping_add(index) % WORDS.len() as u64).unwrap_or(0)];
	format!("Fix the {word} ({seed}.{index})")
}

fn project(index: u64) -> &'static str {
	PROJECTS[usize::try_from(index % PROJECTS.len() as u64).unwrap_or(0)]
}

fn summary(seed: u64, index: u64) -> SessionSummary {
	let id = session_id(seed, index);
	SessionSummary {
		path: format!("/sessions/{}.jsonl", id.0),
		id,
		workspace: "ws-default".to_owned(),
		cwd: project(index).to_owned(),
		title: Some(title(seed, index)),
		parent_path: None,
		created_at_ms: FUTURE_MS,
		modified_at_ms: FUTURE_MS - index * 60_000,
		message_count: 2,
		size_bytes: 1,
		first_message: None,
		searchable_messages: None,
		status: SessionStatus::Complete,
	}
}

fn entry(id: &str, parent: Option<&str>, role: MessageRole, text: String) -> TranscriptEntry {
	TranscriptEntry {
		id: EntryId::from(id),
		parent: parent.map(EntryId::from),
		revision: 1,
		timestamp_ms: FUTURE_MS,
		role,
		content: vec![ContentBlock::Text { text }],
		meta: None,
		raw_discriminator: String::new(),
		raw: serde_json::Value::Null,
	}
}

/// The host events a seed stands for: a connected host, `THREADS` threads
/// over two projects, and the first thread open with one exchange in it.
pub fn seeded_events(seed: u64) -> Vec<HostEvent> {
	let open = session_id(seed, 0);
	let header = SessionHeaderView {
		id:             open,
		schema_version: 1,
		title:          Some(title(seed, 0)),
		title_source:   None,
		parent:         None,
		created_at_ms:  FUTURE_MS,
		cwd:            project(0).to_owned(),
		mode:           None,
	};
	let prompt = format!("Seed {seed}: why does the {} test fail?", WORDS[0]);
	let reply = format!(
		"The failure is in `seed_{seed}`.\n\n- the fixture is read twice\n- the second read sees \
		 the first one's cursor\n\n```rust\nlet seed = {seed};\n```"
	);
	vec![
		HostEvent::ConnectionChanged(ConnectionState::Connected {
			endpoint: "scene".to_owned(),
			protocol: PROTOCOL_VERSION,
		}),
		HostEvent::Snapshot(SnapshotSection::Sessions(
			Versioned {
				revision: 1,
				value:    (0..THREADS).map(|index| summary(seed, index)).collect(),
			},
			Vec::new(),
		)),
		HostEvent::Snapshot(SnapshotSection::ActiveSession(Versioned {
			revision: 1,
			value:    header,
		})),
		HostEvent::Snapshot(SnapshotSection::Transcript(Versioned {
			revision: 1,
			value:    vec![
				entry("prompt", None, MessageRole::User, prompt),
				entry("reply", Some("prompt"), MessageRole::Assistant, reply),
			],
		})),
	]
}

/// Renders the desktop window over the store `seed` stands for, under
/// reduced motion so every region is drawn where it rests.
///
/// Takes the process-wide renderer permit for the duration of the render.
pub fn render_workspace(options: &RenderOptions, seed: u64) -> Result<Captured, RenderError> {
	let mut cx = headless_context()?;
	cx.update(|app| {
		Theme::install(options.appearance, app)
			.map_err(|error| RenderError::Theme { message: error.to_string() })?;
		app.set_reduce_motion(true);
		veyyon_desktop_app::init(app);
		Ok::<_, RenderError>(())
	})?;
	let state = cx.new(|_| AppState::new(Store::new()));
	state.update(&mut *cx, |state, cx| state.apply(seeded_events(seed), cx));
	render_view(&mut cx, options, |window, app| {
		let regions = regions::build(&state, window, app);
		app.new(|cx| Workspace::new(state.clone(), regions, PanelsStore::default(), window, cx))
	})
}
