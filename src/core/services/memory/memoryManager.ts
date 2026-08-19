import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { MemoryEntry, MemoryType } from "./types.js";

export class MemoryManager {
  private readonly dir: string;

  constructor(memoryDir: string) {
    this.dir = memoryDir;
    if (!existsSync(this.dir)) {
      mkdirSync(this.dir, { recursive: true });
    }
  }

  buildIndex(): string {
    const entries = this.list();
    if (entries.length === 0) return "";
    return entries
      .map((e) => `- [${e.name}](${e.filename})[${e.type}] — ${e.description}`)
      .join("\n");
  }

  list(): MemoryEntry[] {
    if (!existsSync(this.dir)) return [];

    const result: MemoryEntry[] = [];
    for (const f of readdirSync(this.dir)) {
      if (!f.endsWith(".md")) continue;
      const raw = readFileSync(path.join(this.dir, f), "utf8");
      const { meta, body } = this.#parseFrontmatter(raw);
      result.push({
        filename: f,
        name: meta.name ?? f.replace(".md", ""),
        description: meta.description ?? "",
        type: (meta.type as MemoryType) ?? "user",
        body,
      });
    }
    return result;
  }

  write(name: string, type: MemoryType, description: string, body: string): string {
    const slug = name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
    let filename = `${slug}.md`;
    if (existsSync(path.join(this.dir, filename))) {
      filename = `${slug}-${Date.now()}.md`;
    }
    // prettier-ignore
    const content = [
      `---`,
      `name: ${name}`,
      `description: ${description}`,
      `type: ${type}`,
      `---`,
      ``,
      body,
      ``,
    ].join("\n");
    writeFileSync(path.join(this.dir, filename), content, "utf8");
    return filename;
  }

  #parseFrontmatter(text: string): {
    meta: Record<string, string>;
    body: string;
  } {
    if (!text.startsWith("---")) return { meta: {}, body: text };

    const parts = text.split("---", 3);
    if (parts.length < 3) return { meta: {}, body: text };

    const meta: Record<string, string> = {};
    for (const line of parts[1]!.trim().split("\n")) {
      const colonIdx = line.indexOf(":");
      if (colonIdx > 0) {
        const key = line.slice(0, colonIdx).trim();
        const value = line
          .slice(colonIdx + 1)
          .trim()
          .replace(/^["']|["']$/g, "");
        meta[key] = value;
      }
    }
    return { meta, body: parts[2]!.trim() };
  }
}
