import "@opentui/core"

declare module "@opentui/core" {
  interface TextareaRenderable {
    traits?: {
      capture?: string[]
      suspend?: boolean
      status?: string
    }
  }

  interface InputRenderable {
    traits?: {
      capture?: string[]
      suspend?: boolean
      status?: string
    }
  }
}
