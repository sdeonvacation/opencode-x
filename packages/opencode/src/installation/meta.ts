declare global {
  const OPENCODE_X_VERSION: string
  const OPENCODE_X_CHANNEL: string
}

export const VERSION = typeof OPENCODE_X_VERSION === "string" ? OPENCODE_X_VERSION : "local"
export const CHANNEL = typeof OPENCODE_X_CHANNEL === "string" ? OPENCODE_X_CHANNEL : "local"
