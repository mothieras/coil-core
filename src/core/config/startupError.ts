const ENV_ERROR_PATTERN =
  /ANTHROPIC_API_KEY|MODEL_ID|No API key for provider|Provider is not configured/;

/**
 * Turns provider configuration errors into a friendly setup guide. Returns
 * null for anything else so the caller re-throws/prints the original error.
 */
export function formatStartupError(error: unknown): string | null {
  if (!(error instanceof Error)) return null;
  if (!ENV_ERROR_PATTERN.test(error.message)) return null;
  return [
    "Coil 需要先配置模型环境变量:",
    "",
    `  ${error.message}`,
    "",
    "  1. 在当前目录创建 .env(可参考 coil 仓库的 .env.example)",
    "  2. 填入 provider 凭据(如 ANTHROPIC_API_KEY)和 MODEL_ID(可选 ANTHROPIC_BASE_URL 指向兼容网关)",
    "  3. 重新运行 coil(源码目录用 pnpm dev)",
  ].join("\n");
}
