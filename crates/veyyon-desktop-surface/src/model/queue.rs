//! What a queue row states and where it sits.
//!
//! The badge vocabulary, the sections the rail lists in order, and the row
//! itself. A section decides how its rows draw and a badge decides how a
//! section orders them, so both are properties of the vocabulary rather than
//! lists the rail keeps beside it.

use veyyon_desktop_kit::TintRole;

/// A status badge (§5.1). The vocabulary is fixed: a badge states what the
/// session needs from the operator, or what it is doing without them.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Badge {
	/// Running, no operator action required.
	Working,
	/// Running and reporting something the operator may want to see.
	Watching,
	/// Blocked on an approval.
	Approval,
	/// Blocked on an answer.
	Input,
	/// A plan is waiting to be read.
	Plan,
	/// A deferred session has come due.
	Due,
	/// Finished successfully.
	Done,
	/// Finished unsuccessfully.
	Failed,
}

impl Badge {
	/// The badge's label.
	pub const fn label(self) -> &'static str {
		match self {
			Self::Working => "Working",
			Self::Watching => "Watching",
			Self::Approval => "Approval",
			Self::Input => "Input",
			Self::Plan => "Plan",
			Self::Due => "Due",
			Self::Done => "Done",
			Self::Failed => "Failed",
		}
	}

	/// The tint the badge paints with.
	pub const fn tint(self) -> TintRole {
		match self {
			Self::Working => TintRole::Working,
			Self::Watching => TintRole::Attention,
			Self::Approval => TintRole::Approve,
			Self::Input => TintRole::Input,
			Self::Plan => TintRole::Plan,
			Self::Due => TintRole::Due,
			Self::Done => TintRole::Done,
			Self::Failed => TintRole::Error,
		}
	}

	/// Whether the badge is asking the operator for something. A section is
	/// ordered by this, so it is a property of the badge rather than a list the
	/// queue keeps separately.
	pub const fn blocks_on_operator(self) -> bool {
		matches!(self, Self::Approval | Self::Input | Self::Plan | Self::Due)
	}

	/// Urgency precedence rank (1 = highest urgency, §0).
	pub const fn precedence(self) -> u8 {
		match self {
			Self::Approval => 1,
			Self::Input => 2,
			Self::Plan => 3,
			Self::Failed => 4,
			Self::Due => 5,
			Self::Done => 6,
			Self::Working => 7,
			Self::Watching => 8,
		}
	}

	/// Resolves the highest precedence badge among candidates.
	#[must_use]
	pub fn resolve(candidates: &[Self]) -> Option<Self> {
		candidates.iter().copied().min_by_key(|b| b.precedence())
	}
}

/// A queue section (§5.1), in the order the queue lists them.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Section {
	/// Composed but not yet sent.
	Unsent,
	/// Held at the top by the operator.
	Pinned,
	/// Running or waiting on the operator.
	Live,
	/// Set aside until a time or an event.
	Deferred,
	/// Set aside indefinitely.
	Parked,
}

impl Section {
	/// Every section, in display order.
	pub const fn all() -> [Self; 5] {
		[Self::Unsent, Self::Pinned, Self::Live, Self::Deferred, Self::Parked]
	}

	/// The section's header label.
	pub const fn label(self) -> &'static str {
		match self {
			Self::Unsent => "Unsent",
			Self::Pinned => "Pinned",
			Self::Live => "Live",
			Self::Deferred => "Deferred",
			Self::Parked => "Parked",
		}
	}

	/// The name the section is written under in what the window remembers
	/// (§8.10).
	///
	/// Its own label, lowercased, so the file states which sections are
	/// collapsed in the words the rail draws.
	pub const fn slug(self) -> &'static str {
		match self {
			Self::Unsent => "unsent",
			Self::Pinned => "pinned",
			Self::Live => "live",
			Self::Deferred => "deferred",
			Self::Parked => "parked",
		}
	}

	/// The section a remembered name stands for, or `None` for a name this
	/// binary does not draw a section for.
	///
	/// Resolved over `all`, so a section added to the queue is readable back
	/// without an edit here.
	#[must_use]
	pub fn from_slug(slug: &str) -> Option<Self> {
		Self::all()
			.into_iter()
			.find(|section| section.slug() == slug)
	}

	/// Whether rows in this section draw as cards. A card carries a badge, a
	/// title and a subtitle; a line carries a title and nothing else. Sections
	/// the operator is not currently working in draw as lines, which is what
	/// keeps a long parked list from costing the same vertical space as the
	/// live one.
	pub const fn draws_cards(self) -> bool {
		matches!(self, Self::Unsent | Self::Pinned | Self::Live)
	}
}

/// A row in the queue.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Row {
	pub id:          u64,
	pub title:       String,
	pub subtitle:    String,
	pub badge:       Option<Badge>,
	pub meta:        Option<String>,
	pub placement:   Section,
	pub depth:       usize,
	pub is_parent:   bool,
	pub collapsed:   bool,
	pub path:        String,
	pub parent_path: Option<String>,
}

impl Row {
	#[must_use]
	pub const fn new(id: u64, title: String, subtitle: String, placement: Section) -> Self {
		Self {
			id,
			title,
			subtitle,
			badge: None,
			meta: None,
			placement,
			depth: 0,
			is_parent: false,
			collapsed: false,
			path: String::new(),
			parent_path: None,
		}
	}
}

impl Default for Row {
	fn default() -> Self {
		Self::new(0, String::new(), String::new(), Section::Live)
	}
}
