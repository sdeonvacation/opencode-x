import { expect, mock, test } from "bun:test"
import { replyPermissionRequest } from "../../../src/cli/cmd/tui/routes/session/permission"

const sessionID = "ses_1"
const requestID = "per_1"

function setup() {
  const request = {
    id: requestID,
    sessionID,
    permission: "bash",
    patterns: ["*"] as string[],
    metadata: {},
    always: ["*"],
  } as Parameters<typeof replyPermissionRequest>[0]["request"]

  const reply = mock(async () => ({}))
  const set = mock(() => {})

  const sync = {
    data: {
      permission: {
        [sessionID]: [
          request,
          {
            ...request,
            id: "per_2",
          },
        ],
      },
    },
    set,
  } as Parameters<typeof replyPermissionRequest>[0]["sync"]

  const client = {
    permission: {
      reply,
    },
  } as Parameters<typeof replyPermissionRequest>[0]["client"]

  return { request, sync, client, reply, set }
}

for (const action of ["once", "always", "reject"] as const) {
  test(`replyPermissionRequest removes request from sync after ${action}`, async () => {
    const { request, sync, client, reply, set } = setup()

    const message = action === "reject" ? "Use safer command" : undefined
    await replyPermissionRequest({
      client,
      sync,
      request,
      reply: {
        reply: action,
        message,
      },
    })

    expect(reply).toHaveBeenCalledTimes(1)
    expect(reply).toHaveBeenCalledWith({
      requestID,
      reply: action,
      message,
    })

    expect(set).toHaveBeenCalledTimes(1)
    expect(set).toHaveBeenCalledWith("permission", sessionID, [expect.objectContaining({ id: "per_2" })])
  })
}
