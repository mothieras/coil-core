import { writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

const marker = process.argv[2]!;
let held: number | undefined;
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
  } else if (request.params?.name === "wait") {
    held = request.id;
    writeFileSync(marker, String(process.pid));
  } else if (request.params?.name === "release") {
    if (held !== undefined) send(held, "late remote result");
    send(request.id, "released");
  } else send(request.id, "echo complete");
});
