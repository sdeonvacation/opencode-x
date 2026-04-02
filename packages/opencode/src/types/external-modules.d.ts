declare module "@npmcli/arborist" {
  export class Arborist {
    constructor(options?: Record<string, unknown>)
    loadVirtual(): Promise<{
      edgesOut: Map<string, { to?: { name: string; path: string } }>
    }>
    reify(options?: Record<string, unknown>): Promise<{
      edgesOut: Map<string, { to?: { name: string; path: string } }>
    }>
  }
}

declare module "venice-ai-sdk-provider" {
  export function createVenice(options?: Record<string, unknown>): {
    languageModel(modelId: string): any
  }
}
