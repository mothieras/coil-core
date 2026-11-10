import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";

export async function writeAtomic(file: string, data: string | Buffer): Promise<void> {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, data, { flag: "wx", mode: 0o600, flush: true });
    await fs.rename(temporary, file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      await fs.rm(temporary, { force: true }).catch(() => undefined);
    }
    throw error;
  }
}
