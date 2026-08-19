import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

type SkillEntry = {
  name: string;
  description: string;
  body: string;
  path: string;
};

const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/;

/**
 * Two-layer skill injection:
 *   Layer 1 — getDescriptions(): name + file path + description list injected
 *   into the system prompt
 *   Layer 2 — the agent reads the listed SKILL.md with read_file on demand
 *
 * Directory convention: <skillsDir>/<name>/SKILL.md
 */
export class SkillLoader {
  private readonly skills = new Map<string, SkillEntry>();

  constructor(private readonly skillsDir: string) {
    this.scan();
  }

  private scan(): void {
    let entries: string[];
    try {
      entries = readdirSync(this.skillsDir);
    } catch {
      return;
    }

    for (const name of entries.sort()) {
      const dir = path.join(this.skillsDir, name);
      if (!statSync(dir).isDirectory()) continue;

      const file = path.join(dir, "SKILL.md");
      const text = this.tryRead(file);
      if (text === null) continue;

      const { description, body } = this.parse(text, file);
      this.skills.set(name, { name, description, body, path: file });
    }
  }

  private tryRead(file: string): string | null {
    try {
      return readFileSync(file, "utf8");
    } catch {
      return null;
    }
  }

  /**
   * Minimal `key: value` frontmatter parse. Returns explicit error strings
   * as descriptions so the LLM can locate and self-repair broken skills.
   */
  private parse(text: string, file: string): { description: string; body: string } {
    const match = text.match(FRONTMATTER_RE);
    if (!match) {
      return {
        description: `(missing frontmatter at ${file})`,
        body: text.trim(),
      };
    }

    const frontmatter = match[1] ?? "";
    const body = match[2] ?? "";
    const desc = frontmatter.match(/^description:\s*(.*)$/m)?.[1]?.trim();
    return {
      description: desc && desc !== "" ? desc : `(no description in ${file})`,
      body: body.trim(),
    };
  }

  /** Layer 1: concise list for the system prompt; paths feed read_file. */
  getDescriptions(): string {
    if (this.skills.size === 0) return "(no skills available)";
    return [...this.skills.values()]
      .map((s) => `  - ${s.name} (${s.path}): ${s.description}`)
      .join("\n");
  }
}
