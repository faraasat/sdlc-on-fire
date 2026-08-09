---
'@sdlc-on-fire/agent-manager': minor
'sdlc-on-fire': minor
---

Add the stage-skill prompt template, the Claude Code compiler, `agents doctor`,
and the CLI skeleton.

`renderPrompt()` assembles a skill into its prompt in the fixed section order
that *is* the cache-boundary decision — stable sections first, so a repeat
invocation reuses the cached prefix. Unresolved `{{slot}}` variables throw rather
than reaching a model, where a literal `{{task_id}}` reads as "invent one".

`ClaudeCodeAdapter` compiles a canonical skill to `.claude/skills/<name>/SKILL.md`
deterministically — same input, byte-identical output, no model call. `runDoctor()`
enforces capability-table totality, so a field like `allowed_tools` cannot be
silently dropped by a target.

The `sdlc` CLI ships `init`, `status`, `new`, and `config`, each with a `--json`
twin that serializes the *same* value the human path prints. `init` never
overwrites an existing file and is safe to run twice.
