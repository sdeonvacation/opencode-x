import { expect, mock, test } from "bun:test"
import { replyPermissionRequest } from "../../../src/cli/cmd/tui/routes/session/permission"
import { rejectQuestionRequest, replyQuestionRequest } from "../../../src/cli/cmd/tui/routes/session/question"
import { restoreRenderableFocus } from "../../../src/cli/cmd/tui/ui/dialog"

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

test("restoreRenderableFocus rebinds focused renderables", () => {
  const target = {
    isDestroyed: false,
    focused: true,
    blur: mock(function () {
      target.focused = false
    }),
    focus: mock(function () {
      target.focused = true
    }),
  }

  restoreRenderableFocus(target)

  expect(target.blur).toHaveBeenCalledTimes(1)
  expect(target.focus).toHaveBeenCalledTimes(1)
  expect(target.focused).toBe(true)
})

test("restoreRenderableFocus ignores destroyed renderables", () => {
  const target = {
    isDestroyed: true,
    focused: true,
    blur: mock(() => {}),
    focus: mock(() => {}),
  }

  restoreRenderableFocus(target)

  expect(target.blur).not.toHaveBeenCalled()
  expect(target.focus).not.toHaveBeenCalled()
})

test("replyQuestionRequest waits for sync events to remove the request", async () => {
  const request = {
    id: "que_1",
    sessionID,
    questions: [],
  } as Parameters<typeof replyQuestionRequest>[0]["request"]
  const reply = mock(async () => ({}))

  await replyQuestionRequest({
    client: {
      question: {
        reply,
        reject: mock(async () => ({})),
      },
    },
    request,
    answers: [["Option 1"]],
  })

  expect(reply).toHaveBeenCalledTimes(1)
  expect(reply).toHaveBeenCalledWith({
    requestID: "que_1",
    answers: [["Option 1"]],
  })
})

test("rejectQuestionRequest waits for sync events to remove the request", async () => {
  const request = {
    id: "que_1",
    sessionID,
    questions: [],
  } as Parameters<typeof rejectQuestionRequest>[0]["request"]
  const reject = mock(async () => ({}))

  await rejectQuestionRequest({
    client: {
      question: {
        reply: mock(async () => ({})),
        reject,
      },
    },
    request,
  })

  expect(reject).toHaveBeenCalledTimes(1)
  expect(reject).toHaveBeenCalledWith({
    requestID: "que_1",
  })
})
