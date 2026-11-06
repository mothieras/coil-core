import type { Agent } from "./agent.js";

// Shared by managed runs and direct agentLoop consumers, not a second run record.
const active = new WeakSet<Agent>();

export function assertAgentIdle(agent: Agent): void {
  if (active.has(agent)) throw new Error("Agent already has an active run");
}

export function claimAgent(agent: Agent): void {
  assertAgentIdle(agent);
  active.add(agent);
}

export function releaseAgent(agent: Agent): void {
  active.delete(agent);
}
