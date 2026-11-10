import { randomUUID } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { AuthOperationOptions, Credential, CredentialStore } from "@earendil-works/pi-ai";
import lockfile from "proper-lockfile";
import { Type, type Static } from "typebox";
import { Check } from "typebox/value";
import { writeAtomic } from "../state/atomicFile.js";

const selectionSchema = Type.Object({ providerId: Type.String(), modelId: Type.String() });
const settingsSchema = Type.Object({
  selection: Type.Optional(selectionSchema),
  deviceId: Type.Optional(Type.String()),
  credentials: Type.Record(
    Type.String(),
    Type.Union([
      Type.Object({
        type: Type.Literal("api_key"),
        key: Type.Optional(Type.String()),
        env: Type.Optional(Type.Record(Type.String(), Type.String())),
      }),
      Type.Object({
        type: Type.Literal("oauth"),
        access: Type.String(),
        refresh: Type.String(),
        expires: Type.Number(),
      }),
    ]),
  ),
});

type Settings = Static<typeof settingsSchema>;
export type ModelSelection = Static<typeof selectionSchema>;

function credentialFor(settings: Settings, providerId: string): Credential | undefined {
  return Object.hasOwn(settings.credentials, providerId)
    ? settings.credentials[providerId]
    : undefined;
}

export class FileCredentialStore implements CredentialStore {
  constructor(private readonly file: string) {}

  async selection(): Promise<ModelSelection | undefined> {
    return (await this.load()).selection;
  }

  async read(providerId: string, options?: AuthOperationOptions): Promise<Credential | undefined> {
    return credentialFor(await this.load(options?.signal), providerId);
  }

  async list(options?: AuthOperationOptions) {
    const settings = await this.load(options?.signal);
    return Object.entries(settings.credentials).map(([providerId, { type }]) => ({
      providerId,
      type,
    }));
  }

  async modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
    options?: AuthOperationOptions,
  ): Promise<Credential | undefined> {
    return this.withLock(options?.signal, async (settings, save) => {
      const current = credentialFor(settings, providerId);
      const next = await fn(current);
      if (next === undefined) return current;
      settings.credentials = { ...settings.credentials, [providerId]: next };
      await save();
      return next;
    });
  }

  async delete(providerId: string, options?: AuthOperationOptions): Promise<void> {
    await this.withLock(options?.signal, async (settings, save) => {
      if (!Object.hasOwn(settings.credentials, providerId)) return;
      delete settings.credentials[providerId];
      if (settings.selection?.providerId === providerId) delete settings.selection;
      await save();
    });
  }

  async saveLogin(selection: ModelSelection, credential: Credential, signal?: AbortSignal) {
    await this.withLock(signal, async (settings, save) => {
      settings.selection = selection;
      settings.credentials = { ...settings.credentials, [selection.providerId]: credential };
      await save();
    });
  }

  async getDeviceId(signal?: AbortSignal): Promise<string> {
    return this.withLock(signal, async (settings, save) => {
      if (settings.deviceId !== undefined) return settings.deviceId;
      settings.deviceId = randomUUID();
      await save();
      return settings.deviceId;
    });
  }

  private async load(signal?: AbortSignal): Promise<Settings> {
    signal?.throwIfAborted();
    let raw: string;
    try {
      raw = await readFile(this.file, { encoding: "utf8", signal });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { credentials: {} };
      throw error;
    }
    let data: unknown;
    try {
      data = JSON.parse(raw);
    } catch {
      // JSON parse errors can quote the credential file's contents.
    }
    if (!Check(settingsSchema, data)) throw new Error(`Invalid credential file at ${this.file}`);
    return data;
  }

  private async withLock<T>(
    signal: AbortSignal | undefined,
    update: (settings: Settings, save: () => Promise<void>) => Promise<T>,
  ): Promise<T> {
    signal?.throwIfAborted();
    await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
    const deadline = Date.now() + 35_000;
    let compromised: Error | undefined;
    let release: () => Promise<void>;
    for (;;) {
      signal?.throwIfAborted();
      try {
        release = await lockfile.lock(this.file, {
          realpath: false,
          stale: 30_000,
          onCompromised: (error) => {
            compromised = error;
          },
        });
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ELOCKED" || Date.now() >= deadline)
          throw error;
      }
      await delay(100, undefined, { signal });
    }

    try {
      const settings = await this.load(signal);
      signal?.throwIfAborted();
      // After the update starts, a refresh may have rotated the old OAuth token.
      // Finish publishing its replacement even if the caller stops waiting.
      return await update(settings, async () => {
        if (compromised) throw compromised;
        await writeAtomic(this.file, `${JSON.stringify(settings, null, 2)}\n`);
      });
    } finally {
      if (!compromised) await release();
    }
  }
}
