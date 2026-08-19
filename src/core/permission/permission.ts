import path from "node:path";
import type { AskUserFn, CheckPermissionFn } from "./types.js";

// ── Gate 1: Hard deny list ──
//
// This is a best-effort safety guardrail, NOT a security boundary.
// Shell syntax has too many equivalent forms for string-matching to be a real
// defense. File operations are protected by builtin/file/safePath.ts; bash commands are
// ultimately limited by the user's OS permissions and shell configuration.
//
// Treat this list as a "don't shoot yourself in the foot" reminder, not a
// sandbox. If you need real security, run the agent in a container or VM.

const DENY_LIST = ["rm -rf /", "sudo", "shutdown", "reboot", "mkfs", "dd if=", "> /dev/sda"];

function checkDenyList(command: string): string | null {
  const normalized = command.replace(/\s+/g, " ").trim();
  for (const pattern of DENY_LIST) {
    if (normalized.includes(pattern)) {
      return `Blocked: '${pattern}' is on the deny list`;
    }
  }
  return null;
}

// ── Gate 2: Rule matching ──

type Rule = {
  tools: string[];
  check: (input: Record<string, unknown>, workspace: string) => boolean;
  message: string;
};

const RULES: Rule[] = [
  {
    tools: ["write_file", "edit_file"],
    check: (input, workspace) => {
      const target = input.path as string;
      if (!target) return false;
      try {
        const resolved = path.resolve(workspace, target);
        const root = path.resolve(workspace) + path.sep;
        return !(resolved + path.sep).startsWith(root);
      } catch {
        return true; // suspicious path → ask
      }
    },
    message: "Writing outside workspace",
  },
  {
    tools: ["bash"],
    check: (input) => {
      const cmd = (input.command as string) ?? "";
      const keywords = ["rm ", "> /etc/", "chmod 777", "pkill", "kill -9"];
      return keywords.some((kw) => cmd.includes(kw));
    },
    message: "Potentially destructive command",
  },
];

function checkRules(
  toolName: string,
  input: Record<string, unknown>,
  workspace: string,
): string | null {
  for (const rule of RULES) {
    if (rule.tools.includes(toolName) && rule.check(input, workspace)) {
      return rule.message;
    }
  }
  return null;
}

// ── Pipeline ──

export function createPermissionChecker(workspace: string, askUser: AskUserFn): CheckPermissionFn {
  return async (context) => {
    const { toolName, input } = context;
    // Gate 1: hard deny
    if (toolName === "bash") {
      const denyReason = checkDenyList((input.command as string) ?? "");
      if (denyReason) {
        return { allowed: false, reason: denyReason };
      }
    }

    // Gate 2 + 3: rule match → user approval
    const ruleReason = checkRules(toolName, input, workspace);
    if (ruleReason) {
      context.emitPermissionRequested?.(ruleReason);
      const allowed = await askUser(toolName, input, ruleReason);
      if (!allowed) {
        return { allowed: false, requested: true, reason: `User denied: ${ruleReason}` };
      }
      return { allowed: true, requested: true, reason: ruleReason };
    }

    return { allowed: true };
  };
}
