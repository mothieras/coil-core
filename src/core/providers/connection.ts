import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import type { AuthInteraction, AuthType } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { coilStatePath } from "../state/paths.js";
import { FileCredentialStore } from "./credentialStore.js";
import { createDefaultProvider, createPiAiProvider } from "./pi.js";
import type { Provider } from "./types.js";

export interface ModelConnection {
  readonly provider: Provider;
  readonly modelId: string | undefined;
  readonly setupMessage: string | undefined;
  login(providerId: string | undefined, interaction: AuthInteraction): Promise<string>;
}

type Choice<T extends string> = { id: T; label: string; description?: string };

async function choose<T extends string>(
  interaction: AuthInteraction,
  message: string,
  options: readonly Choice<T>[],
): Promise<T> {
  if (options.length === 1) return options[0]!.id;
  const id = await interaction.prompt({ type: "select", message, options });
  const selected = options.find((option) => option.id === id);
  if (!selected) throw new Error(`Invalid selection. ${message}`);
  return selected.id;
}

/** Model selection and credentials are local to a workspace, outside the project tree. */
export async function openModelConnection(
  workspaceRoot: string,
  authDirectory = coilStatePath(homedir(), "auth"),
): Promise<ModelConnection> {
  const workspaceId = createHash("sha256")
    .update(await realpath(workspaceRoot))
    .digest("hex");
  const credentials = new FileCredentialStore(path.join(authDirectory, `${workspaceId}.json`));
  const models = builtinModels({ credentials });
  const complete = models.complete.bind(models);
  const saved = await credentials.selection();
  let active: Provider | undefined;
  let setupMessage: string | undefined;
  if (saved) {
    const model = models.getModel(saved.providerId, saved.modelId);
    if (model) active = createPiAiProvider({ model, complete });
    else setupMessage = "The saved model is unavailable. Run /login to select a model.";
  } else {
    try {
      active = createDefaultProvider();
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      setupMessage = `${error.message}. Run /login to configure a provider and model.`;
    }
  }

  function configuredProvider(): Provider {
    if (!active) throw new Error(setupMessage);
    return active;
  }

  return {
    provider: {
      get model() {
        return configuredProvider().model;
      },
      get fallbackModel() {
        return configuredProvider().fallbackModel;
      },
      generate(model, request, options) {
        return configuredProvider().generate(model, request, options);
      },
    },
    get modelId() {
      return active?.model.id;
    },
    get setupMessage() {
      return setupMessage;
    },
    async login(providerId, interaction) {
      const providers = models
        .getProviders()
        .filter(
          (provider) =>
            (provider.auth.apiKey?.login || provider.auth.oauth) &&
            models.getModels(provider.id).length > 0,
        )
        .sort((a, b) => a.name.localeCompare(b.name));
      const id =
        providerId ??
        (await choose(
          interaction,
          "Choose a provider",
          providers.map(({ id, name }) => ({ id, label: name, description: id })),
        ));
      const provider = providers.find((item) => item.id === id);
      if (!provider)
        throw new Error("This provider is unavailable for login. Run /login to see the list.");

      const methods: Choice<AuthType>[] = [];
      if (provider.auth.oauth) {
        methods.push({
          id: "oauth",
          label: provider.auth.oauth.loginLabel ?? provider.auth.oauth.name,
        });
      }
      if (provider.auth.apiKey?.login) methods.push({ id: "api_key", label: "API key" });
      const method = await choose(interaction, "Choose how to sign in", methods);

      // Stage the login in memory until a model is selected. Cancelling any
      // prompt leaves the previously selected model and credential intact.
      const pending = createModels();
      pending.setProvider(provider);
      const signal = interaction.signal;
      const options = signal ? { signal } : undefined;
      const deviceId = method === "oauth" ? await credentials.getDeviceId(signal) : undefined;
      const loginOptions = deviceId
        ? { agentName: "Coil", getDeviceId: () => deviceId }
        : undefined;
      const credential = await pending
        .login(id, method, interaction, loginOptions)
        .catch((error: unknown) => {
          signal?.throwIfAborted();
          // OAuth exchange errors can contain the provider's token response.
          throw new Error(`${provider.name} sign-in failed. Run /login to try again.`, {
            cause: error,
          });
        });
      const available = await pending.getAvailable(id, options);
      if (available.length === 0)
        throw new Error("No chat models are available with these credentials.");
      const modelId = await choose(
        interaction,
        "Choose a model",
        available.map((model) => ({
          id: model.id,
          label: model.name,
          description: model.id,
        })),
      );
      const model = available.find((item) => item.id === modelId)!;
      const next = createPiAiProvider({ model, complete });
      await credentials.saveLogin({ providerId: id, modelId }, credential, signal);
      active = next;
      setupMessage = undefined;
      return modelId;
    },
  };
}
