export const TUI_COLORS = {
  primary: "cyan",
  info: "blue",
  success: "green",
  warning: "yellow",
  danger: "red",
  muted: "gray",
} as const;

export type TuiSymbols = {
  user: string;
  assistant: string;
  system: string;
  success: string;
  warning: string;
  error: string;
  running: string;
  branch: string;
  subagent: string;
  background: string;
  task: string;
  compact: string;
  report: string;
  mcp: string;
  info: string;
};

const UNICODE_SYMBOLS: TuiSymbols = {
  user: "›",
  assistant: "●",
  system: "!",
  success: "✓",
  warning: "!",
  error: "×",
  running: "●",
  branch: "└",
  subagent: "◇",
  background: "↳",
  task: "□",
  compact: "↻",
  report: "◆",
  mcp: "○",
  info: "·",
};

const ASCII_SYMBOLS: TuiSymbols = {
  user: ">",
  assistant: "*",
  system: "!",
  success: "+",
  warning: "!",
  error: "x",
  running: "*",
  branch: "`",
  subagent: "@",
  background: ">",
  task: "[ ]",
  compact: "~",
  report: "#",
  mcp: "o",
  info: ".",
};

export function usesAsciiTerminal(
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  return env["TERM"] === "dumb" || env["COIL_ASCII"] === "1";
}

export function symbolsFor(
  env: Readonly<Record<string, string | undefined>> = process.env,
): TuiSymbols {
  return usesAsciiTerminal(env) ? ASCII_SYMBOLS : UNICODE_SYMBOLS;
}

export function borderStyleFor(
  env: Readonly<Record<string, string | undefined>> = process.env,
): "classic" | "round" {
  return usesAsciiTerminal(env) ? "classic" : "round";
}

export function shouldAnimateActivity(
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  return env["COIL_REDUCED_MOTION"] !== "1" && !usesAsciiTerminal(env);
}

export const TUI_ASCII = usesAsciiTerminal();
export const TUI_BORDER_STYLE = borderStyleFor();
export const TUI_SYMBOLS = symbolsFor();
