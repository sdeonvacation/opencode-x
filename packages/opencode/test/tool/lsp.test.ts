import { expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import path from "path"
import { AppFileSystem } from "../../src/filesystem"
import { LSP } from "../../src/lsp"
import { SessionID, MessageID } from "../../src/session/schema"
import { LspTool } from "../../src/tool/lsp"
import { provideInstance, tmpdir } from "../fixture/fixture"

const ctx = {
  sessionID: SessionID.make("ses_test"),
  messageID: MessageID.make("message"),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => {},
  ask: async () => {},
}

const init = (queries: string[]) =>
  Effect.runPromise(
    Effect.flatMap(
      Effect.provide(
        LspTool,
        Layer.mergeAll(
          AppFileSystem.defaultLayer,
          Layer.succeed(
            LSP.Service,
            LSP.Service.of({
              init: () => Effect.void,
              status: () => Effect.succeed([]),
              hasClients: () => Effect.succeed(true),
              touchFile: () => Effect.void,
              diagnostics: () => Effect.succeed({}),
              hover: () => Effect.succeed([]),
              definition: () => Effect.succeed([]),
              references: () => Effect.succeed([]),
              implementation: () => Effect.succeed([]),
              documentSymbol: () => Effect.succeed([]),
              workspaceSymbol: (query) =>
                Effect.sync(() => {
                  queries.push(query)
                  return []
                }),
              prepareCallHierarchy: () => Effect.succeed([]),
              incomingCalls: () => Effect.succeed([]),
              outgoingCalls: () => Effect.succeed([]),
            }),
          ),
        ),
      ),
      (info) => Effect.promise(() => info.init()),
    ),
  )

test("tool.lsp passes workspaceSymbol query to LSP", async () => {
  const queries: string[] = []
  const tool = await init(queries)
  await using tmp = await tmpdir()
  const file = path.join(tmp.path, "test.ts")
  await Bun.write(file, "export const value = 1\n")

  await Effect.runPromise(
    provideInstance(tmp.path)(
      Effect.gen(function* () {
        yield* Effect.promise(() =>
          tool.execute(
            { operation: "workspaceSymbol", filePath: file, line: 1, character: 1, query: "TestSymbol" },
            ctx,
          ),
        )
        yield* Effect.promise(() =>
          tool.execute({ operation: "workspaceSymbol", filePath: file, line: 1, character: 1 }, ctx),
        )
      }),
    ),
  )

  expect(queries).toEqual(["TestSymbol", ""])
})
