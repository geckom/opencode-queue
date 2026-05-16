import type { OpencodeClient } from "@opencode-ai/sdk"

export function safeToast(
  client: OpencodeClient,
  message: string,
  variant: "info" | "success" | "warning" | "error",
  duration?: number,
): void {
  void client.tui
    .showToast({
      body: {
        message,
        variant,
        duration,
      },
    })
    .catch(() => {})
}
