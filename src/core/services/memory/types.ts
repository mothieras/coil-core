export type MemoryType = "user" | "feedback" | "project" | "reference";

export interface MemoryEntry {
  filename: string;
  name: string;
  description: string;
  type: MemoryType;
  body: string;
}
