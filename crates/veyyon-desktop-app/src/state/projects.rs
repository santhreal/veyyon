//! The sidebar listing: sessions grouped into projects by working directory.

use std::collections::{HashMap, HashSet};

use veyyon_desktop_model::{Session, SessionId, SessionStatus, Store};

/// Every session that runs in one working directory.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Project {
	/// The last component of [`path`](Self::path).
	pub name:             String,
	/// The working directory as the host reports it.
	pub path:             String,
	/// The newest `modified_at_ms` of any session in the project.
	pub last_activity_ms: u64,
	/// The sessions, newest first, each followed by its branches.
	pub sessions:         Vec<SessionRow>,
}

/// One session row of a [`Project`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionRow {
	/// The session.
	pub id:             SessionId,
	/// The title the host reports, or `new session`.
	pub title:          String,
	/// The status of the session's file.
	pub status:         SessionStatus,
	/// The last write to the session's file.
	pub modified_at_ms: u64,
	/// The `modified_at_ms` the session had when it was last open.
	pub read_mark_ms:   Option<u64>,
	/// 0 for a session, 1 for a branch of it, 2 for a branch of that branch.
	pub depth:          usize,
}

/// Groups the sessions of `store` by working directory.
///
/// `cwds` maps a session to the directory the host reported for it; a
/// session missing from it is grouped under its workspace name. Projects are
/// ordered by their newest session, sessions by `modified_at_ms` descending,
/// and a session whose `parent_path` is another session of the same project
/// is listed under that session.
pub fn build_projects(store: &Store, cwds: &HashMap<SessionId, String>) -> Vec<Project> {
	let sessions = &store.sessions.items;
	let by_path: HashMap<&str, &SessionId> = sessions
		.values()
		.filter(|session| !session.path.is_empty())
		.map(|session| (session.path.as_str(), &session.id))
		.collect();
	let mut groups: HashMap<&str, Vec<&Session>> = HashMap::new();
	for session in sessions.values() {
		let cwd = directory_key(
			cwds
				.get(&session.id)
				.map_or(session.project_name.as_str(), String::as_str),
		);
		groups.entry(cwd).or_default().push(session);
	}
	let mut projects: Vec<Project> = groups
		.into_iter()
		.map(|(cwd, members)| project(cwd, members, &by_path))
		.collect();
	projects.sort_by(|a, b| {
		b.last_activity_ms
			.cmp(&a.last_activity_ms)
			.then_with(|| a.path.cmp(&b.path))
	});
	projects
}

fn project(cwd: &str, mut members: Vec<&Session>, by_path: &HashMap<&str, &SessionId>) -> Project {
	members.sort_by(|a, b| {
		b.modified_at_ms
			.cmp(&a.modified_at_ms)
			.then_with(|| a.id.cmp(&b.id))
	});
	let local: HashSet<&SessionId> = members.iter().map(|session| &session.id).collect();
	let mut roots = Vec::new();
	let mut branches: HashMap<&SessionId, Vec<&Session>> = HashMap::new();
	for &session in &members {
		let parent = session
			.parent_path
			.as_deref()
			.and_then(|path| by_path.get(path).copied())
			.filter(|parent| *parent != &session.id && local.contains(parent));
		match parent {
			Some(parent) => branches.entry(parent).or_default().push(session),
			None => roots.push(session),
		}
	}
	let mut rows = Vec::with_capacity(members.len());
	let mut listed = HashSet::with_capacity(members.len());
	let mut stack = Vec::new();
	// Sessions whose parent chain closes a loop have no root; they are
	// listed after the rooted ones rather than dropped.
	for &root in roots.iter().chain(&members) {
		stack.push((root, 0));
		while let Some((session, depth)) = stack.pop() {
			if !listed.insert(&session.id) {
				continue;
			}
			rows.push(SessionRow {
				id: session.id.clone(),
				title: session.title.clone(),
				status: session.status,
				modified_at_ms: session.modified_at_ms,
				read_mark_ms: session.read_mark_ms,
				depth,
			});
			if let Some(children) = branches.get(&session.id) {
				stack.extend(children.iter().rev().map(|&child| (child, depth + 1)));
			}
		}
	}
	Project {
		name:             directory_name(cwd).to_owned(),
		path:             cwd.to_owned(),
		last_activity_ms: members.first().map_or(0, |session| session.modified_at_ms),
		sessions:         rows,
	}
}

/// `path` without trailing separators, so `/w/app/` and `/w/app` are one
/// project. A root stays whole.
fn directory_key(path: &str) -> &str {
	let trimmed = path.trim_end_matches(['/', '\\']);
	if trimmed.is_empty() { path } else { trimmed }
}

/// The last component of a POSIX or Windows path, or the whole path when it
/// has none.
fn directory_name(path: &str) -> &str {
	path
		.rsplit(['/', '\\'])
		.next()
		.filter(|name| !name.is_empty())
		.unwrap_or(path)
}
