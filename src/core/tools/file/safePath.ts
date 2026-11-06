import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import { ToolExecutionError } from "../errors.js";

async function nearestExistingPath(targetPath: string): Promise<string> {
  let current = targetPath;

  while (true) {
    try {
      await stat(current);
      return current;
    } catch (e) {
      const error = e as NodeJS.ErrnoException;
      if (error.code !== "ENOENT") throw e;
    }

    const parent = path.dirname(current);
    if (parent === current) return current;
    current = parent;
  }
}

function isInsideWorkspace(workdir: string, target: string): boolean {
  const relativePath = path.relative(workdir, target);
  return relativePath === "" || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath));
}

export async function safePath(inputPath: string, workspaceRoot: string): Promise<string> {
  const workdir = await realpath(workspaceRoot);
  const resolvedPath = path.resolve(workdir, inputPath);
  const existingPath = await nearestExistingPath(resolvedPath);
  const realExistingPath = await realpath(existingPath);

  if (!isInsideWorkspace(workdir, realExistingPath)) {
    throw new ToolExecutionError("Path escapes workspace.");
  }

  if (!isInsideWorkspace(workdir, resolvedPath)) {
    throw new ToolExecutionError("Path escapes workspace.");
  }

  return resolvedPath;
}
