import { Transform, type TransformCallback } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import type { ReactNode } from "react";
import { render, type Instance, type RenderOptions } from "ink";

// Bracketed paste prevents pasted control sequences from becoming mouse input.
const ENABLE_MOUSE = "\x1b[?1000h\x1b[?1002h\x1b[?1006h\x1b[?2004h";
const DISABLE_MOUSE = "\x1b[?2004l\x1b[?1006l\x1b[?1002l\x1b[?1000l";
const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";
const MOUSE_START = "\x1b[<";

export type TerminalMouseEvent = {
  kind: "wheel" | "press" | "move" | "release";
  x: number;
  y: number;
  button: number;
  remaining: number;
  fallback: boolean;
  primaryVisited: boolean;
};

/** Demultiplex mouse reports before Ink can interpret them as editor input. */
export class TerminalInput extends Transform {
  private pending = "";
  private paste = false;
  private mouseEnabled = false;
  private rawEnabled = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly decoder = new StringDecoder("utf8");

  constructor(
    private readonly source: NodeJS.ReadStream,
    private readonly output: NodeJS.WriteStream,
  ) {
    super();
    source.pipe(this);
    process.once("exit", this.dispose);
  }

  get isTTY(): boolean {
    return Boolean(this.source.isTTY);
  }
  setRawMode(enabled: boolean): this {
    this.source.setRawMode(enabled);
    this.rawEnabled = enabled;
    if (this.output.isTTY && enabled !== this.mouseEnabled) {
      this.output.write(enabled ? ENABLE_MOUSE : DISABLE_MOUSE);
      this.mouseEnabled = enabled;
    }
    return this;
  }
  ref(): this {
    this.source.ref();
    return this;
  }
  unref(): this {
    this.source.unref();
    return this;
  }

  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    if (this.timer) clearTimeout(this.timer);
    this.pending += this.decoder.write(chunk);
    this.drain();
    if (this.pending && !this.paste && !this.pending.startsWith(MOUSE_START)) {
      // Let split reports arrive, while keeping a standalone Escape responsive.
      this.timer = setTimeout(() => {
        this.push(this.pending);
        this.pending = "";
      }, 50);
      this.timer.unref();
    }
    callback();
  }

  private drain(): void {
    while (this.pending) {
      if (this.paste) {
        const end = this.pending.indexOf(PASTE_END);
        if (end < 0) {
          let suffix = Math.min(this.pending.length, PASTE_END.length - 1);
          while (suffix > 0 && !PASTE_END.startsWith(this.pending.slice(-suffix))) suffix -= 1;
          const count = this.pending.length - suffix;
          if (count) this.push(this.pending.slice(0, count));
          this.pending = this.pending.slice(count);
          return;
        }
        this.push(this.pending.slice(0, end + PASTE_END.length));
        this.pending = this.pending.slice(end + PASTE_END.length);
        this.paste = false;
        continue;
      }
      const escape = this.pending.indexOf("\x1b");
      if (escape !== 0) {
        const count = escape < 0 ? this.pending.length : escape;
        this.push(this.pending.slice(0, count));
        this.pending = this.pending.slice(count);
        continue;
      }
      if (this.pending.startsWith(PASTE_START)) {
        this.push(PASTE_START);
        this.pending = this.pending.slice(PASTE_START.length);
        this.paste = true;
        continue;
      }
      if (this.pending.startsWith(MOUSE_START)) {
        const match = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])/.exec(this.pending);
        if (match) {
          this.pending = this.pending.slice(match[0].length);
          this.dispatchMouse(
            Number(match[1]),
            Number(match[2]) - 1,
            Number(match[3]) - 1,
            match[4] === "m",
          );
          continue;
        }
        if (/^\x1b\[<[\d;]*$/.test(this.pending) && this.pending.length < 64) return;
        // Malformed mouse reports are terminal controls, never prompt text.
        this.pending = this.pending.replace(/^\x1b\[<[^A-Za-z]*[A-Za-z]?/, "");
        continue;
      }
      if (PASTE_START.startsWith(this.pending) || MOUSE_START.startsWith(this.pending)) return;
      this.push(this.pending[0]);
      this.pending = this.pending.slice(1);
    }
  }

  private dispatchMouse(code: number, x: number, y: number, release: boolean): void {
    if (![code, x, y].every(Number.isSafeInteger) || x < 0 || y < 0) return;
    const wheel = (code & 64) !== 0;
    // Horizontal wheel reports and wheel releases do not move the vertical view.
    if (wheel && ((code & 3) > 1 || release)) return;
    const event: TerminalMouseEvent = {
      kind: wheel ? "wheel" : release ? "release" : (code & 32) !== 0 ? "move" : "press",
      x,
      y,
      button: code & 3,
      remaining: wheel ? ((code & 1) === 0 ? -1 : 1) * ((code & 8) !== 0 ? 5 : 1) : 0,
      fallback: false,
      primaryVisited: false,
    };
    this.emit("coil:mouse", event);
    // Like pi, unused wheel movement over a secondary area reaches the transcript.
    if (event.kind === "wheel" && event.remaining !== 0 && !event.primaryVisited) {
      event.fallback = true;
      this.emit("coil:mouse", event);
    }
  }

  dispose = (): void => {
    if (this.timer) clearTimeout(this.timer);
    if (this.rawEnabled) this.setRawMode(false);
    if (this.mouseEnabled) {
      this.output.write(DISABLE_MOUSE);
      this.mouseEnabled = false;
    }
    this.source.unpipe(this);
    this.pending = "";
    process.off("exit", this.dispose);
    this.destroy();
  };
}

export function renderTerminal(node: ReactNode, options: RenderOptions = {}): Instance {
  const input = new TerminalInput(options.stdin ?? process.stdin, options.stdout ?? process.stdout);
  let instance: Instance;
  try {
    instance = render(node, {
      alternateScreen: true,
      exitOnCtrlC: false,
      kittyKeyboard: { mode: "disabled" },
      ...options,
      stdin: input as unknown as NodeJS.ReadStream,
    });
  } catch (error) {
    input.dispose();
    throw error;
  }
  return {
    ...instance,
    unmount() {
      instance.unmount();
      input.dispose();
    },
    cleanup() {
      instance.cleanup();
      input.dispose();
    },
    async waitUntilExit() {
      try {
        return await instance.waitUntilExit();
      } finally {
        input.dispose();
      }
    },
  };
}
