import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";

export async function writeAtomic(file: string, data: string | Buffer): Promise<void> {
  const temporary = `${file}.${randomUUID()}.tmp`;
  await fs.writeFile(temporary, data, { flag: "wx", mode: 0o600, flush: true });
  await fs.rename(temporary, file);
}
