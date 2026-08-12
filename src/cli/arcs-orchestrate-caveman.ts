import { ORCHESTRATE_PROMPT_TEXT } from "./arcs-orchestrate.js";

/** Narration overlay only; the canonical prompt remains workflow authority. */
export const CAVEMAN_PREAMBLE = `# Caveman Narration Overlay

This is a narration-only overlay with no workflow or mutation authority. Keep chat terse: short sentences, exact technical terms, no filler. Never compress safety warnings, confirmations, code, commands, paths, errors, or evidence the user needs.

---

`;

export const ORCHESTRATE_CAVEMAN_PROMPT_TEXT = CAVEMAN_PREAMBLE + ORCHESTRATE_PROMPT_TEXT;
