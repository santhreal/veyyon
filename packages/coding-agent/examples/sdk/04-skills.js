import { createAgentSession, discoverSkills, SessionManager } from "@veyyon/coding-agent";
const { skills: allSkills } = await discoverSkills();
console.log("Discovered skills:", allSkills.map(s => s.name));
const filteredSkills = allSkills.filter(s => s.name.includes("browser") || s.name.includes("search"));
const customSkill = {
    name: "my-skill",
    description: "Custom project instructions",
    filePath: "/virtual/SKILL.md",
    baseDir: "/virtual",
    source: "custom",
};
await createAgentSession({
    skills: [...filteredSkills, customSkill],
    sessionManager: SessionManager.inMemory(),
});
console.log(`Session created with ${filteredSkills.length + 1} skills`);
