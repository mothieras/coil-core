import { writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

const marker = process.argv[2]!;
const held = new Map<string, number>();
const send = (id: number, text: string) =>
  process.stdout.write(
    `${JSON.stringify({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text }] } })}\n`,
  );
createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line) as { id?: number; method: string; params?: { name?: string } };
  if (request.id === undefined) return;
  if (request.method === "initialize") {
    process.stdout.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { protocolVersion: "2024-11-05" } })}\n`,
    );
  } else if (request.params?.name?.startsWith("wait")) {
    const suffix = request.params.name.slice(4);
    held.set(suffix, request.id);
    writeFileSync(`${marker}${suffix}`, String(process.pid));
  } else if (request.params?.name?.startsWith("release")) {
    const suffix = request.params.name.slice(7);
    const id = held.get(suffix);
    if (id !== undefined) send(id, "late remote result");
    held.delete(suffix);
    send(request.id, "released");
  } else send(request.id, "echo complete");
});
