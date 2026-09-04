/**
 * The shape a tool domain publishes about itself.
 *
 * A domain is a directory of tools that share a subject — the filesystem, search, the shell, the
 * network, the agent's own bookkeeping — and a manifest is the only thing a host reads to learn
 * which tools that directory contributes. Nothing here names a tool, a session type or a host: the
 * factory type is a parameter, so the terminal builds `ToolFactory` from its own `ToolSession` and a
 * browser client builds whatever its transport hands a tool, and neither has to agree with the other
 * to enumerate the same domains.
 *
 * WHY A MANIFEST RATHER THAN A REGISTRY CALL. A registry the domains push into runs their modules to
 * find out what they contribute, which puts every tool's imports on the boot path of whoever asks
 * the question. A manifest is data: the keys are readable without constructing anything, and each
 * factory pulls its implementation in on first use.
 *
 * The renderer table stays out of this type deliberately. A renderer draws a terminal component, so
 * a domain declares one in a separate module that only a terminal host imports; a headless or
 * browser host reads the manifest and never loads it.
 */
export interface ToolDomainManifest<TFactory> {
	/** The domain's directory name, which is also how a host reports where a tool came from. */
	readonly domain: string;
	/**
	 * Tools the model sees, keyed by the name it calls. A factory returning `null` is a tool that
	 * this session cannot have, which is how a domain declines without the host testing for it.
	 */
	readonly tools: Readonly<Record<string, TFactory>>;
	/**
	 * Tools the host constructs but never advertises in the tool list — a yield, a resolve, a
	 * finding report. Absent when a domain contributes none.
	 */
	readonly hidden?: Readonly<Record<string, TFactory>>;
}
