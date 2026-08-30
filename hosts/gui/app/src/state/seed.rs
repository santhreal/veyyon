//! The store the window opens on.
//!
//! The other seam the engine replaces. It is a starting position, not a
//! screenshot: every session here is a value the moves in `super::moves` then
//! change, and nothing in the app reads this module after startup.
//!
//! One session of every activity, because the sidebar's ordering is only worth
//! anything when the states it orders are all present at once.

use super::{
	agent,
	model::{
		Activity, Block, Message, Overlay, Project, ProjectId, Role, Route, Run, Session, SessionId,
		Settings, Store, TERMINAL_DEFAULT, Terminal, TerminalTab, ToolState,
	},
};

/// Build the opening store.
pub fn store() -> Store {
	let veyyon = ProjectId::new("veyyon");
	let site = ProjectId::new("site");
	let projects = vec![
		Project::new("veyyon", "veyyon", "~/src/veyyon"),
		Project::new("site", "veyyon.dev", "~/src/veyyon.dev"),
	];

	let mut sessions = vec![
		waiting(&veyyon),
		failed(&veyyon),
		working(&veyyon),
		idle(&veyyon),
		settled(&site),
		site_idle(&site),
	];
	sessions.sort_by_key(|session| session.status.rank());

	Store {
		projects,
		sessions,
		selected: Some(SessionId::new("frame")),
		terminal: terminal(),
		settings: Settings::default(),
		route: Route::Chat,
		overlay: Overlay::None,
		now_ms: 0,
		models: vec![
			"claude-sonnet-4-6".to_owned(),
			"claude-opus-4-2".to_owned(),
			"gpt-5.2-codex".to_owned(),
			"gemini-3-pro".to_owned(),
			"grok-code-fast-2".to_owned(),
		],
		themes: vec![
			"graphite".to_owned(),
			"veyyon dark".to_owned(),
			"veyyon light".to_owned(),
			"gruvbox".to_owned(),
			"nord".to_owned(),
			"rose pine".to_owned(),
		],
		notice: None,
		notice_until: None,
	}
}

/// The session the window opens on: a real conversation, mid-thread.
fn working(project: &ProjectId) -> Session {
	let mut session = Session::new("frame", project, "Draw the window frame");
	session.branch = Some("feat/gui".to_owned());
	session.status = Activity::Working;
	session.updated_ms = 0;
	session.model = "claude-sonnet-4-6".to_owned();
	session.messages = vec![
		Message::user(1, 0, "read app/src/state/model.rs and tell me what owns the draft"),
		Message {
			id:     2,
			role:   Role::Assistant,
			blocks: vec![
				Block::Text(
					"The session owns it. `Session::draft` is the text and `Session::caret` is where \
					 the cursor sits, so switching sessions and coming back finds what was typed."
						.to_owned(),
				),
				Block::tool("read", "app/src/state/model.rs", "418 lines", ToolState::Ok),
				Block::Code {
					lang: "rust".to_owned(),
					body: "pub struct Session {\n\tpub draft: String,\n\t/// Where the caret sits in \
					       `draft`, as a byte offset.\n\tpub caret: usize,\n}"
						.to_owned(),
				},
				Block::Text(
					"The text element keeps its own buffer for editing and writes both back through \
					 `moves::set_draft`, so the store stays the single copy."
						.to_owned(),
				),
			],
			at_ms:  0,
		},
		Message::user(3, 0, "good. now do the same for the terminal panel height"),
		Message {
			id:     4,
			role:   Role::Assistant,
			blocks: vec![Block::Text(TAIL[..TAIL_SHOWN].to_owned())],
			at_ms:  0,
		},
	];
	// The window opens on a reply that is still arriving: the prose continues
	// from where it was cut, a diff lands behind it, and the session settles.
	// A session marked Working with nothing left to do would report an activity
	// it can never leave.
	session.run = Some(Run {
		message:  4,
		pending:  vec![Block::Text(TAIL.to_owned()), Block::Diff {
			path:  "app/src/terminal.rs".to_owned(),
			lines: vec![
				(' ', "let height = shell.motion.drive(key, motion::RESIZE, target, now);".to_owned()),
				('-', "\tlet target = store.terminal.height;".to_owned()),
				('+', "\tlet target = store.terminal.height.max(TERMINAL_MIN);".to_owned()),
			],
		}],
		revealed: TAIL_SHOWN,
		next_ms:  agent::FIRST_TOKEN_MS,
		ends_as:  Activity::Done,
	});
	session
}

/// The reply that is mid-flight when the window opens, and how much of it has
/// already landed.
const TAIL: &str = "Height is window state, not session state, so it sits on `Terminal` beside \
                    the tabs. A drag clamps against `TERMINAL_MIN`, so the panel cannot be \
                    dragged shut by accident, and the chevron in the strip is what closes it.";
const TAIL_SHOWN: usize = 104;

/// Stopped, and wants an answer. Deliberately older than everything that is
/// still moving, so the ordering has something to prove.
fn waiting(project: &ProjectId) -> Session {
	let mut session = Session::new("modifier", project, "Which modifier opens the panel?");
	session.status = Activity::Waiting;
	session.unread = true;
	session.updated_ms = 0;
	session.model = "claude-sonnet-4-6".to_owned();
	session.messages = vec![Message::user(1, 0, "bind the terminal panel to something"), Message {
		id:     2,
		role:   Role::Assistant,
		blocks: vec![Block::Text(
			"Two candidates, and they collide with different things.\n\n`ctrl-\\`` is what the \
			 editors use, and it is free here. `cmd-j` is what the operator's muscle memory says, \
			 and it is taken by the jump list.\n\nWhich one?"
				.to_owned(),
		)],
		at_ms:  0,
	}];
	session
}

/// Broke, and says why.
fn failed(project: &ProjectId) -> Session {
	let mut session = Session::new("grep", project, "Port the grep kernel");
	session.branch = Some("perf/grep".to_owned());
	session.status = Activity::Failed;
	session.unread = true;
	session.updated_ms = 0;
	session.model = "gpt-5.2-codex".to_owned();
	session.messages = vec![Message::user(1, 0, "port the matcher and run the gate"), Message {
		id:     2,
		role:   Role::Assistant,
		blocks: vec![
			Block::Text("Ported, then ran it.".to_owned()),
			Block::tool(
				"bash",
				"cargo test -p veyyon-grep-kernel",
				"error[E0308]: mismatched types\n  --> src/matcher.rs:88:21",
				ToolState::Failed,
			),
			Block::Text(
				"The compiled matcher takes the pattern by value now, and one call site still passes \
				 a reference. Stopping here rather than committing red."
					.to_owned(),
			),
		],
		at_ms:  0,
	}];
	session
}

fn idle(project: &ProjectId) -> Session {
	let mut session = Session::new("themes", project, "Reuse the terminal theme files");
	session.status = Activity::Idle;
	session.updated_ms = 0;
	session.model = "claude-sonnet-4-6".to_owned();
	session.messages = vec![Message::user(1, 0, "where do the bundled themes come from?")];
	session
}

fn settled(project: &ProjectId) -> Session {
	let mut session = Session::new("og", project, "Open graph images for the changelog");
	session.status = Activity::Done;
	session.updated_ms = 0;
	session.model = "gemini-3-pro".to_owned();
	session.messages = vec![Message::user(1, 0, "generate the cards")];
	session
}

fn site_idle(project: &ProjectId) -> Session {
	let mut session = Session::new("install", project, "Installer copy for the arm64 note");
	session.status = Activity::Idle;
	session.updated_ms = 0;
	session.model = "claude-sonnet-4-6".to_owned();
	session.messages = Vec::new();
	session
}

/// The panel starts closed with one finished command and one that failed, so
/// the strip has something to report before anything is run.
fn terminal() -> Terminal {
	let mut exits = std::collections::BTreeMap::new();
	exits.insert(1, Some(0));
	exits.insert(2, Some(101));
	Terminal {
		tabs: vec![
			TerminalTab {
				id:      1,
				title:   "bun test".to_owned(),
				cwd:     "~/src/veyyon".to_owned(),
				lines:   vec![
					"bun test v1.3.0".to_owned(),
					String::new(),
					" 412 pass".to_owned(),
					" 0 fail".to_owned(),
				],
				exit:    Some(0),
				pending: Vec::new(),
				next_ms: 0,
			},
			TerminalTab {
				id:      2,
				title:   "gate.sh".to_owned(),
				cwd:     "~/src/veyyon/hosts/gui".to_owned(),
				lines:   vec![
					"+ cargo fmt --all --check".to_owned(),
					"+ cargo clippy --workspace --all-targets -- -D warnings".to_owned(),
					"error: unused variable: `cx`".to_owned(),
					"  --> app/src/shell.rs:214:9".to_owned(),
				],
				exit:    Some(101),
				pending: Vec::new(),
				next_ms: 0,
			},
		],
		active: 1,
		open: false,
		height: TERMINAL_DEFAULT,
		exits,
	}
}
