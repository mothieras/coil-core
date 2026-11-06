#!/usr/bin/env tsx
/**
 * 无凭据示例：通过构建产物注册并调用自定义工具，验证结果与参数校验。
 * pnpm build && pnpm exec tsx examples/custom-tool.ts
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { builtinTool, createAppContext, type ToolDefinition } from "coil-core";

const echoDefinition: ToolDefinition = {
  name: "echo",
  description: "Echoes back the provided text.",
  parameters: {
    type: "object",
    properties: { text: { type: "string" } },
    required: ["text"],
  },
};

const workspace = await mkdtemp(path.join(tmpdir(), "coil-custom-tool-"));
const app = createAppContext(workspace);
try {
  let calls = 0;
  app.toolRuntime.registerTool(
    builtinTool(echoDefinition, (input) => {
      calls++;
      return { status: "completed", output: `echo: ${input.text as string}` };
    }),
  );
  const result = await app.toolRuntime.invokeTool("echo", { text: "hello" });
  assert.deepEqual(result, { status: "completed", output: "echo: hello" });
  console.log(result);
  const invalid = await app.toolRuntime.invokeTool("echo", { text: 42 });
  assert.equal(invalid.status, "invalid_input");
  assert.equal(calls, 1);
  console.log(invalid);
} finally {
  await app.closeToolProviders();
  await rm(workspace, { recursive: true, force: true });
}
