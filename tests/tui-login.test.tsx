import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import React from "react";
import { render } from "ink-testing-library";
import { openModelConnection } from "../src/core/providers/index.js";
import { SessionController } from "../src/core/session/controller.js";
import { SessionStore } from "../src/core/session/store/sessionStore.js";
import { App } from "../src/tui/components/App.js";
import { createPermissionBridge } from "../src/tui/permissionBridge.js";
import { useSession } from "../src/tui/useSession.js";
import { userMessage } from "./helpers/pi.js";

test(
  "/login configures an unconfigured TUI, masks input, and restores a saved API key",
  { timeout: 15_000 },
  async (t) => {
    const root = await mkdtemp(path.join(tmpdir(), "coil-tui-login-"));
    const authDirectory = path.join(root, "auth");
    t.after(() => rm(root, { recursive: true, force: true }));
    const env = {
      MODEL_ID: undefined,
      ANTHROPIC_MODEL: undefined,
      ANTHROPIC_API_KEY: "env-fixture-key",
      ANTHROPIC_BASE_URL: "https://gateway.example.invalid/anthropic",
    };
    for (const [name, value] of Object.entries(env)) {
      const original = process.env[name];
      t.after(() => {
        if (original === undefined) delete process.env[name];
        else process.env[name] = original;
      });
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }

    const modelId = "claude-sonnet-4-6";
    const requests: unknown[] = [];
    const server = createServer(async (req, res) => {
      let body = "";
      for await (const chunk of req) body += String(chunk);
      requests.push({ model: JSON.parse(body).model, key: req.headers["x-api-key"] });
      const events = [
        {
          type: "message_start",
          message: {
            id: "message_fixture",
            type: "message",
            role: "assistant",
            model: modelId,
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 1, output_tokens: 0 },
          },
        },
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "Fixture reply" },
        },
        { type: "content_block_stop", index: 0 },
        {
          type: "message_delta",
          delta: { stop_reason: "end_turn", stop_sequence: null },
          usage: { output_tokens: 1 },
        },
        { type: "message_stop" },
      ];
      res.setHeader("content-type", "text/event-stream");
      res.end(
        events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""),
      );
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    t.after(() => {
      server.closeAllConnections();
      return new Promise<void>((resolve) => server.close(() => resolve()));
    });
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const fetch = globalThis.fetch;
    t.mock.method(globalThis, "fetch", (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : input);
      assert.equal(url.origin, "https://api.anthropic.com");
      return fetch(`http://127.0.0.1:${address.port}${url.pathname}${url.search}`, init);
    });

    const connection = await openModelConnection(root, authDirectory);
    assert.equal(connection.modelId, undefined);
    const store = new SessionStore(root);
    const bridge = createPermissionBridge();
    const checkPermission = async () => ({ allowed: true });
    const controller = await SessionController.createNew({
      workspaceRoot: root,
      title: "Login fixture",
      store,
      provider: connection.provider,
    });
    function Root() {
      return (
        <App
          session={useSession({
            workspaceRoot: root,
            store,
            bridge,
            checkPermission,
            initialController: controller,
            loadProviders: async () => [],
            modelConnection: connection,
          })}
        />
      );
    }
    const app = render(<Root />);
    try {
      async function waitForFrame(pattern: RegExp) {
        const deadline = Date.now() + 3000;
        while (!pattern.test(app.lastFrame() ?? "") && Date.now() < deadline) await delay(20);
        assert.match(app.lastFrame() ?? "", pattern);
      }
      async function type(value: string) {
        app.stdin.write(value);
        await delay(60);
      }
      async function submit(value: string) {
        await type(value);
        await type("\r");
      }

      await waitForFrame(/Run \/login/);
      await submit("/login");
      await waitForFrame(/Choose a provider/);
      await submit("anthropic");
      await waitForFrame(/Choose how to sign in/);
      await submit("API key");
      await waitForFrame(/Enter Anthropic API key/);
      await type("saved-fixture-key");
      assert.match(app.lastFrame() ?? "", /\*{8}/);
      await type("\r");
      await waitForFrame(/Choose a model/);
      await submit(modelId);
      await waitForFrame(/Login saved/);

      const [file] = await readdir(authDirectory);
      assert.ok(file);
      const authPath = path.join(authDirectory, file);
      const saved = await readFile(authPath, "utf8");
      if (process.platform !== "win32") assert.equal((await stat(authPath)).mode & 0o777, 0o600);

      await submit("/login anthropic");
      await waitForFrame(/Choose how to sign in/);
      await submit("API key");
      await waitForFrame(/Enter Anthropic API key/);
      await submit("cancelled-fixture-key");
      await waitForFrame(/Choose a model/);
      await type("\x1b");
      await waitForFrame(/Ask anything/);
      assert.equal(await readFile(authPath, "utf8"), saved);

      await submit("/ping");
      await waitForFrame(/Ping OK/);
      await submit("hello");
      await waitForFrame(/Fixture reply/);
      assert.doesNotMatch(app.frames.join("\n"), /(?:saved|cancelled)-fixture-key/);
      assert.deepEqual(
        controller.getSnapshot().conversationMessages.map((message) => message.content),
        ["hello", "Fixture reply"],
      );

      const reopened = await openModelConnection(root, authDirectory);
      assert.equal(reopened.modelId, modelId);
      const reply = await reopened.provider.generate(reopened.provider.model, {
        messages: [userMessage("ping again")],
        tools: [],
      });
      assert.equal(reply.stopReason, "stop");
      assert.deepEqual(
        requests,
        Array.from({ length: 3 }, () => ({ model: modelId, key: "saved-fixture-key" })),
      );
    } finally {
      app.unmount();
      await controller.close();
    }
  },
);
