import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { type AgentRegistryRecord, opencodeSourceManifestSchema } from "../utils/json-schemas.js";
import { PACKAGE_ROOT } from "../utils/paths.js";

export type AgentTier = AgentRegistryRecord["tier"];

export interface AgentRegistry {
  agents: AgentRegistryRecord[];
}

const manifestPath = resolve(PACKAGE_ROOT, "opencode", "arcs", "manifest.json");

export function validateAgentRegistry(registry: AgentRegistry): AgentRegistry {
  const byId = new Map<string, AgentRegistryRecord>();
  const sources = new Set<string>();
  const destinations = new Set<string>();
  for (const agent of registry.agents) {
    if (byId.has(agent.id)) throw new Error(`Duplicate ARCS agent id: ${agent.id}`);
    if (sources.has(agent.source)) throw new Error(`Duplicate ARCS agent source: ${agent.source}`);
    if (destinations.has(agent.destination)) {
      throw new Error(`Duplicate ARCS agent destination: ${agent.destination}`);
    }
    byId.set(agent.id, agent);
    sources.add(agent.source);
    destinations.add(agent.destination);
  }

  for (const agent of registry.agents) {
    if (agent.status !== "retired") continue;
    const replacement = agent.replacementId ? byId.get(agent.replacementId) : undefined;
    if (
      !replacement ||
      replacement.status !== "active" ||
      replacement.kind !== agent.kind ||
      agent.modes.some((mode) => !replacement.modes.includes(mode))
    ) {
      throw new Error(
        `Retired agent ${agent.id} must name an active compatible replacement covering kind and modes`,
      );
    }
  }

  return registry;
}

export function readAgentRegistry(): AgentRegistry {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(manifestPath, "utf-8"));
  } catch (error) {
    throw new Error(
      `Unable to read ARCS agent registry at ${manifestPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const result = opencodeSourceManifestSchema.safeParse(raw);
  if (!result.success) {
    throw new Error(`Invalid ARCS agent registry at ${manifestPath}: ${result.error.message}`);
  }

  return validateAgentRegistry({ agents: result.data.agents });
}

export function getActiveAgents(registry = readAgentRegistry()): AgentRegistryRecord[] {
  return registry.agents.filter((agent) => agent.status === "active");
}

export function getActiveAgent(id: string, registry = readAgentRegistry()): AgentRegistryRecord {
  const agent = getActiveAgents(registry).find((candidate) => candidate.id === id);
  if (!agent) throw new Error(`Active ARCS agent is not registered: ${id}`);
  return agent;
}

export function getAgentTierMap(registry = readAgentRegistry()): Record<string, AgentTier> {
  return Object.fromEntries(getActiveAgents(registry).map((agent) => [agent.id, agent.tier]));
}

export function getAgentsByTier(
  registry = readAgentRegistry(),
): Record<AgentTier, AgentRegistryRecord[]> {
  const result: Record<AgentTier, AgentRegistryRecord[]> = { heavy: [], standard: [], light: [] };
  for (const agent of getActiveAgents(registry)) result[agent.tier].push(agent);
  return result;
}
