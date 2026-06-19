export namespace WorkflowBuiltin {
  export type Script = { name: string; source: string; description: string }

  // builtins will be added here as bundled workflow scripts
  const scripts: Script[] = []

  export function list(): Script[] {
    return [...scripts]
  }

  export function get(name: string): Script | undefined {
    return scripts.find((s) => s.name === name)
  }
}
