//! What a conversation and a checkout are called, and where a checkout is.

/// A session's identity.
///
/// A string because an engine's ids are strings, so attaching one does not
/// rewrite every signature.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct SessionId(pub String);

impl SessionId {
	pub fn new(id: impl Into<String>) -> SessionId {
		SessionId(id.into())
	}

	pub fn as_str(&self) -> &str {
		&self.0
	}
}

/// A checkout the sessions belong to.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct ProjectId(pub String);

impl ProjectId {
	pub fn new(id: impl Into<String>) -> ProjectId {
		ProjectId(id.into())
	}

	pub fn as_str(&self) -> &str {
		&self.0
	}
}

/// A checkout: what it is called, where it is, and whether its group is folded.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Project {
	pub id:        ProjectId,
	pub name:      String,
	pub path:      String,
	pub collapsed: bool,
}

impl Project {
	pub fn new(id: &str, name: &str, path: &str) -> Project {
		Project {
			id:        ProjectId::new(id),
			name:      name.to_owned(),
			path:      path.to_owned(),
			collapsed: false,
		}
	}
}
