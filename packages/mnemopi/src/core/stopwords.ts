// Canonical content-word stopword list for mnemopi.
//
// A content stopword is a high-frequency function word (or self-referential
// domain word like "memory"/"mnemopi") that carries no topical signal and must
// be dropped before content tokens are used for episodic co-occurrence edges
// (episodic-graph.ts) or cross-memory pattern detection (patterns.ts).
//
// Both consumers previously kept their OWN inline `CONTENT_STOPWORDS` set, and
// the two had silently diverged: episodic-graph curated short 3-4 letter
// function words while patterns curated 5+ letter words plus the domain-noise
// terms. Same name, different values, one package — a latent inconsistency
// where identical text produced different content tokens depending on which
// path scanned it. This module is the ONE owner; both import from here so the
// filter is identical everywhere. Extend the list here and nowhere else.
//
// The set is the union of the two former lists: it covers both length regimes,
// so episodic-graph now also drops the longer function words and domain noise,
// and patterns now also drops the shorter ones its 5+ letter regex happens to
// admit. Filtering strictly more noise is the intended behavior for both.
const CONTENT_STOPWORD_VALUES = [
	"about",
	"after",
	"and",
	"are",
	"before",
	"being",
	"could",
	"doing",
	"every",
	"for",
	"from",
	"had",
	"has",
	"have",
	"having",
	"he",
	"into",
	"is",
	"memories",
	"memory",
	"might",
	"mnemopi",
	"new",
	"onto",
	"other",
	"our",
	"she",
	"should",
	"that",
	"their",
	"them",
	"there",
	"these",
	"they",
	"this",
	"those",
	"through",
	"under",
	"was",
	"were",
	"where",
	"which",
	"while",
	"with",
	"would",
	"the",
] as const;

/** Single source of truth for content-word stopwords across mnemopi. */
export const CONTENT_STOPWORDS: ReadonlySet<string> = new Set(CONTENT_STOPWORD_VALUES);

// Canonical entity/mention stopword list for mnemopi.
//
// An entity stopword is a token that must NOT be treated as a meaningful named
// entity or stored as a mention: standard English function words/pronouns plus
// conversation- and domain-noise words ("assistant", "user", "agent", "task",
// "mnemopi", ...). Two consumers previously kept their OWN inline set and they
// had diverged: entities.ts (`ENTITY_EXTRACTION_STOP_WORDS`, entity extraction)
// carried the full function-word list plus the domain noise, while
// annotations.ts (`ENTITY_STOP_WORDS`, noisy-mention filtering) carried ONLY the
// domain-noise subset and was silently missing every function word — so
// `isNoisyMention("of the")` returned false and stored pure-function-word
// mentions as real. Same purpose, one package, divergent values: a latent
// recall/precision bug. This module is the ONE owner; both import from here.
//
// The set is the union of the two former lists (entities.ts's superset plus the
// one domain word annotations.ts uniquely had, "mnemopi"). Both paths now filter
// the same strictly-larger noise set, which is the intended behavior for each:
// extraction no longer emits "mnemopi" as an entity, and mention filtering now
// also rejects bare function-word mentions it previously let through.
const ENTITY_STOPWORD_VALUES = [
	// standard function words and pronouns
	"the", "a", "an", "and", "or", "but", "in", "on", "at", "to", "for", "of",
	"with", "by", "from", "as", "is", "was", "are", "were", "be", "been", "being",
	"have", "has", "had", "do", "does", "did", "will", "would", "could", "should",
	"may", "might", "can", "shall", "i", "you", "he", "she", "it", "we", "they",
	"me", "him", "her", "us", "them", "my", "your", "his", "its", "our", "their",
	"this", "that", "these", "those", "here", "there", "where", "when", "what",
	"which", "who", "whom", "whose", "how", "why",
	// conversation- and domain-noise words that appear as candidate entities but
	// are not meaningful named entities
	"assistant", "user", "skill", "review", "target", "class", "level", "signals",
	"phase", "api", "pi", "summary", "added", "active", "not", "whether", "all",
	"no", "replying", "ai", "memory", "conversation", "fact", "false", "true",
	"none", "null", "signal", "hermes", "agent", "model", "system", "note", "task",
	"project", "result", "output", "input", "data", "step", "process", "point",
	"way", "thing", "time", "work", "mnemopi",
] as const;

/** Single source of truth for entity/mention stopwords across mnemopi. */
export const ENTITY_STOPWORDS: ReadonlySet<string> = new Set(ENTITY_STOPWORD_VALUES);
