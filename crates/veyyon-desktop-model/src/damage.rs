use std::{
	cmp::Ordering,
	collections::{BTreeSet, HashMap},
	hash::{Hash, Hasher},
	ops::Range,
};

use serde::{Deserialize, Serialize};

use crate::{
	connection::{EntryId, InteractionId, SessionId},
	session::QueuePartition,
};

/// Precise visual invalidation region identifying a laid-out box or surface.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum Damage {
	/// Connection state indicator line under the titlebar.
	ConnectionLine,
	/// Titlebar action buttons or connection status label.
	Titlebar,
	/// Specific session card or line row in the queue.
	QueueRow(SessionId),
	/// Entire queue partition header and list.
	QueuePartition(QueuePartition),
	/// Entire queue surface.
	QueueAll,
	/// One laid-out transcript message block.
	TranscriptEntry(SessionId, EntryId),
	/// Contiguous slice of transcript entries.
	TranscriptSpan(SessionId, Range<usize>),
	/// Entire transcript scroll view for a session.
	TranscriptFull(SessionId),
	/// Composer input box, action button, or split selector.
	Composer(SessionId),
	/// Approval, question, or plan decision card above composer.
	PendingDecision(SessionId, InteractionId),
	/// Run bar underneath composer.
	RunBar(SessionId),
	/// Right panel header or tab strip.
	RightPanelChrome(SessionId),
	/// Active content body of a right panel tab.
	RightPanelTab(SessionId, String),
	/// Terminal drawer header or tab strip.
	TerminalDrawerChrome(SessionId),
	/// Terminal output grid or scrollback area.
	TerminalOutput(SessionId, String),
	/// Supervised process list in the drawer.
	ProcessList(SessionId),
	/// Command palette overlay.
	Palette,
	/// Full window relayout and repaint.
	FullWindow,
}

impl Damage {
	const fn discriminant_index(&self) -> u8 {
		match self {
			Self::ConnectionLine => 0,
			Self::Titlebar => 1,
			Self::QueueRow(_) => 2,
			Self::QueuePartition(_) => 3,
			Self::QueueAll => 4,
			Self::TranscriptEntry(..) => 5,
			Self::TranscriptSpan(..) => 6,
			Self::TranscriptFull(_) => 7,
			Self::Composer(_) => 8,
			Self::PendingDecision(..) => 9,
			Self::RunBar(_) => 10,
			Self::RightPanelChrome(_) => 11,
			Self::RightPanelTab(..) => 12,
			Self::TerminalDrawerChrome(_) => 13,
			Self::TerminalOutput(..) => 14,
			Self::ProcessList(_) => 15,
			Self::Palette => 16,
			Self::FullWindow => 17,
		}
	}
}

impl PartialOrd for Damage {
	fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
		Some(self.cmp(other))
	}
}

impl Ord for Damage {
	fn cmp(&self, other: &Self) -> Ordering {
		match (self, other) {
			(Self::ConnectionLine, Self::ConnectionLine)
			| (Self::Titlebar, Self::Titlebar)
			| (Self::QueueAll, Self::QueueAll)
			| (Self::Palette, Self::Palette)
			| (Self::FullWindow, Self::FullWindow) => Ordering::Equal,
			(Self::QueueRow(a), Self::QueueRow(b))
			| (Self::TranscriptFull(a), Self::TranscriptFull(b))
			| (Self::Composer(a), Self::Composer(b))
			| (Self::RunBar(a), Self::RunBar(b))
			| (Self::RightPanelChrome(a), Self::RightPanelChrome(b))
			| (Self::TerminalDrawerChrome(a), Self::TerminalDrawerChrome(b))
			| (Self::ProcessList(a), Self::ProcessList(b)) => a.cmp(b),
			(Self::QueuePartition(a), Self::QueuePartition(b)) => a.cmp(b),
			(Self::TranscriptEntry(s1, e1), Self::TranscriptEntry(s2, e2)) => {
				s1.cmp(s2).then_with(|| e1.cmp(e2))
			},
			(Self::TranscriptSpan(s1, r1), Self::TranscriptSpan(s2, r2)) => s1
				.cmp(s2)
				.then_with(|| r1.start.cmp(&r2.start))
				.then_with(|| r1.end.cmp(&r2.end)),
			(Self::PendingDecision(s1, i1), Self::PendingDecision(s2, i2)) => {
				s1.cmp(s2).then_with(|| i1.cmp(i2))
			},
			(Self::RightPanelTab(s1, t1), Self::RightPanelTab(s2, t2))
			| (Self::TerminalOutput(s1, t1), Self::TerminalOutput(s2, t2)) => {
				s1.cmp(s2).then_with(|| t1.cmp(t2))
			},
			_ => self.discriminant_index().cmp(&other.discriminant_index()),
		}
	}
}

impl Hash for Damage {
	fn hash<H: Hasher>(&self, state: &mut H) {
		self.discriminant_index().hash(state);
		match self {
			Self::ConnectionLine
			| Self::Titlebar
			| Self::QueueAll
			| Self::Palette
			| Self::FullWindow => {},
			Self::QueueRow(s)
			| Self::TranscriptFull(s)
			| Self::Composer(s)
			| Self::RunBar(s)
			| Self::RightPanelChrome(s)
			| Self::TerminalDrawerChrome(s)
			| Self::ProcessList(s) => s.hash(state),
			Self::QueuePartition(p) => p.hash(state),
			Self::TranscriptEntry(s, e) => {
				s.hash(state);
				e.hash(state);
			},
			Self::TranscriptSpan(s, r) => {
				s.hash(state);
				r.start.hash(state);
				r.end.hash(state);
			},
			Self::PendingDecision(s, i) => {
				s.hash(state);
				i.hash(state);
			},
			Self::RightPanelTab(s, t) | Self::TerminalOutput(s, t) => {
				s.hash(state);
				t.hash(state);
			},
		}
	}
}

/// Ordered, deduplicated set of damage items with automatic coarsening.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct DamageSet {
	items: BTreeSet<Damage>,
}

impl DamageSet {
	/// Creates an empty damage set.
	#[must_use]
	pub const fn new() -> Self {
		Self { items: BTreeSet::new() }
	}

	/// Inserts a damage item, triggering coarsening evaluation.
	pub fn insert(&mut self, damage: Damage) {
		self.items.insert(damage);
		self.coarsen();
	}

	/// Merges another damage set into this one, triggering coarsening
	/// evaluation.
	pub fn extend(&mut self, other: Self) {
		self.items.extend(other.items);
		self.coarsen();
	}

	/// Returns true if no damage items are present.
	#[must_use]
	pub fn is_empty(&self) -> bool {
		self.items.is_empty()
	}

	/// Returns the number of damage items in the set.
	#[must_use]
	pub fn len(&self) -> usize {
		self.items.len()
	}

	/// Returns true if the set contains the specified damage item.
	#[must_use]
	pub fn contains(&self, damage: &Damage) -> bool {
		self.items.contains(damage)
	}

	/// Iterates over references to the damage items in sorted order.
	pub fn iter(&self) -> impl Iterator<Item = &Damage> {
		self.items.iter()
	}

	/// Coarsens fine-grained damage items into aggregate boundaries when
	/// thresholds are met.
	pub fn coarsen(&mut self) {
		if self.items.contains(&Damage::FullWindow) {
			self.items.clear();
			self.items.insert(Damage::FullWindow);
			return;
		}

		// Coarsen queue rows to QueueAll if threshold is exceeded.
		let queue_row_count = self
			.items
			.iter()
			.filter(|d| matches!(d, Damage::QueueRow(_)))
			.count();
		if queue_row_count > 16 || self.items.contains(&Damage::QueueAll) {
			self
				.items
				.retain(|d| !matches!(d, Damage::QueueRow(_) | Damage::QueuePartition(_)));
			self.items.insert(Damage::QueueAll);
		}

		// Coarsen transcript entries per session.
		let mut session_entries: HashMap<SessionId, usize> = HashMap::new();
		for item in &self.items {
			if let Damage::TranscriptEntry(session_id, _) = item {
				*session_entries.entry(session_id.clone()).or_default() += 1;
			}
		}
		for (session_id, count) in session_entries {
			if count > 32
				|| self
					.items
					.contains(&Damage::TranscriptFull(session_id.clone()))
			{
				self.items.retain(|d| {
					!matches!(d, Damage::TranscriptEntry(s, _) | Damage::TranscriptSpan(s, _) if s == &session_id)
				});
				self.items.insert(Damage::TranscriptFull(session_id));
			}
		}

		// Coarsen to FullWindow if aggregate item count exceeds bound.
		if self.items.len() > 64 {
			self.items.clear();
			self.items.insert(Damage::FullWindow);
		}
	}
}

impl IntoIterator for DamageSet {
	type IntoIter = std::collections::btree_set::IntoIter<Damage>;
	type Item = Damage;

	fn into_iter(self) -> Self::IntoIter {
		self.items.into_iter()
	}
}
