import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { CodeModeTool } from "@opencode/core/codemode/tool"
import { Tool } from "@opencode/core/tool"
import { execute } from "@opencode/core/tool/runtime"
import { Agent } from "@opencode/schema/agent"
import { Session } from "@opencode/schema/session"
import { SessionMessage } from "@opencode/schema/session-message"
import { Effect, Logger } from "effect"

const sessionID = Session.ID.make("ses_fetch_measurement")
const context = {
  sessionID,
  agent: Agent.ID.make("build"),
  messageID: SessionMessage.ID.make("msg_fetch_measurement"),
  id: Tool.CallID.make("call_fetch_measurement"),
  progress: () => Effect.void,
}

const codeMode = CodeModeTool.create({ tools: new Map() }, (_, tool, input, ctx) => execute(tool, input, ctx))

// Loopback only: the tests exercise the real fetch capability without touching the network.
let server: ReturnType<typeof Bun.serve>

beforeAll(() => {
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request) => new Response("body", { status: new URL(request.url).pathname === "/ok" ? 200 : 404 }),
  })
})

afterAll(() => {
  server.stop(true)
})

const origin = () => `http://127.0.0.1:${server.port}`

const run = async (code: string) => {
  const logs: Array<ReadonlyArray<unknown>> = []
  const logger = Logger.map(Logger.formatStructured, (entry) => {
    if (Array.isArray(entry.message)) logs.push(entry.message)
  })
  const result = await Effect.runPromise(
    codeMode.execute({ code }, context).pipe(Effect.provide(Logger.layer([logger]))),
  )
  return { result, logs }
}

const measurements = (logs: ReadonlyArray<ReadonlyArray<unknown>>) =>
  logs.filter((message) => message[0] === "fetch 404").map((message) => message[1])

describe("Code Mode fetch 404 measurement", () => {
  test("keeps a 200 result and appends no warning", async () => {
    const { result, logs } = await run(`const res = await fetch("${origin()}/ok"); return res.status`)

    expect(result.output.output).toBe("200")
    expect(logs).toEqual([])
  })

  test("does not block a 404 and appends one actionable warning without leaking the URL", async () => {
    const { result, logs } = await run(
      `const res = await fetch("${origin()}/missing?access_token=SUPERSECRET", { method: "POST" }); return res.status`,
    )

    // The fetch response crosses to the program unchanged.
    expect(result.output.output.startsWith("404")).toBe(true)
    expect(result.output.output).toContain("fetch 404 warning: 1 request returned HTTP 404")
    expect(result.output.output.endsWith("do not retry guessed URL variants.")).toBe(true)
    expect(result.output.output.split("fetch 404 warning:")).toHaveLength(2)
    expect(result.output.output).not.toContain("SUPERSECRET")
    expect(result.output.output).not.toContain("/missing")

    expect(measurements(logs)).toEqual([
      {
        session: sessionID,
        method: "POST",
        origin: origin(),
        status: 404,
        path: expect.stringMatching(/^[0-9a-f]{16}$/),
      },
    ])
    expect(JSON.stringify(logs)).not.toContain("SUPERSECRET")
    expect(JSON.stringify(logs)).not.toContain("access_token")
  })

  test("counts every 404 across the whole execution", async () => {
    const { result, logs } = await run(`
      const first = await fetch("${origin()}/one?token=SUPERSECRET")
      const second = await fetch("${origin()}/two")
      const third = await fetch("${origin()}/ok")
      return [first.status, second.status, third.status]
    `)

    expect(result.output.output.startsWith("[")).toBe(true)
    expect(result.output.output).toContain("[")
    expect(result.output.output).toContain("404")
    expect(result.output.output).toContain("fetch 404 warning: 2 requests returned HTTP 404")
    expect(result.output.output).not.toContain("SUPERSECRET")
    expect(measurements(logs)).toHaveLength(2)
    expect(JSON.stringify(logs)).not.toContain("SUPERSECRET")
  })
})
