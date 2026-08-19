// Minimal scripted MCP-over-stdio server for tests. Answers `initialize`
// immediately, then waits for two `tools/call` requests and replies to them
// OUT OF ORDER (the second one first) so the client must demultiplex by id.
let buffer = "";
const calls = [];

function send(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

process.stdin.on("data", (chunk) => {
  buffer += chunk.toString("utf8");
  let nl = buffer.indexOf("\n");
  while (nl !== -1) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    nl = buffer.indexOf("\n");
    if (line === "") continue;
    const msg = JSON.parse(line);
    if (msg.method === "initialize") {
      send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2024-11-05" } });
    } else if (msg.method === "tools/call") {
      calls.push(msg);
      if (calls.length === 2) {
        const [first, second] = calls;
        send({ jsonrpc: "2.0", id: second.id, result: { echo: second.params.arguments } });
        setTimeout(() => {
          send({ jsonrpc: "2.0", id: first.id, result: { echo: first.params.arguments } });
        }, 10);
      }
    }
  }
});
