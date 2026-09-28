import { describe, expect } from "bun:test"
import path from "path"
import { Effect, Layer } from "effect"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { makeLocationNode } from "@opencode/util/effect/app-node"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Environment } from "@opencode/core/environment/index"
import { Location } from "@opencode/core/location"
import { FileAccess } from "@opencode/core/file-access"
import { Permission } from "@opencode/core/permission"
import { Ripgrep } from "@opencode/core/ripgrep"
import { AbsolutePath } from "@opencode/core/schema"
import { Session } from "@opencode/core/session"
import { GrepTool } from "@opencode/core/tool/plugin/grep"
import { Tool } from "@opencode/core/tool"
import { location } from "./fixture/location"
import { tmpdirScoped } from "./fixture/tmpdir"
import { it } from "./lib/effect"
import { permissionLayer } from "./lib/permission"
import { executeTool, registerToolPlugin, toolIdentity, type ToolExecution } from "./lib/tool"

const grepToolNode = makeLocationNode({
  name: "test/grep-output-budget-plugin",
  layer: Layer.effectDiscard(registerToolPlugin(GrepTool.Plugin)),
  deps: [Tool.node, Environment.node, Ripgrep.node, Location.node, FileAccess.node, Permission.node],
})

const sessionID = Session.ID.make("ses_grep_output_budget_test")

const withTools = <A, E, R>(directory: string, body: (registry: Tool.Interface) => Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const registry = yield* Tool.Service
    return yield* body(registry)
  }).pipe(
    Effect.provide(
      AppNodeBuilder.build(LayerNode.group([Tool.node, grepToolNode]), [
        Location.node.replace(
          Layer.succeed(Location.Service, Location.Service.of(location({ directory: AbsolutePath.make(directory) }))),
        ),
        Permission.node.replace(permissionLayer({ assert: () => Effect.void })),
      ]),
    ),
  )

const call = (input: unknown) => ({
  sessionID,
  ...toolIdentity,
  call: { type: "tool-call" as const, id: "call-grep-budget", name: "grep", input },
})

const ENV = GrepTool.OUTPUT_BUDGET_ENV
const withBudget = <A, E, R>(value: number | "invalid" | undefined, effect: Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      const previous = process.env[ENV]
      if (value === undefined) delete process.env[ENV]
      else process.env[ENV] = String(value)
      return previous
    }),
    () => effect,
    (previous) =>
      Effect.sync(() => {
        if (previous === undefined) delete process.env[ENV]
        else process.env[ENV] = previous
      }),
  )

const textOf = (result: ToolExecution) => (result.content?.[0]?.type === "text" ? result.content[0].text : "")
const bytes = (value: string) => Buffer.byteLength(value, "utf-8")
const longLine = (index: number, suffix = "") => "needle " + String(index).padStart(3, "0") + " " + suffix + "z".repeat(1990)

const writeShort = (path: string, count: number) =>
  Effect.promise(() =>
    Bun.write(path, Array.from({ length: count }, (_, index) => `needle short ${index}`).join("\n") + "\n"),
  )
const writeLong = (path: string, count: number) =>
  Effect.promise(() => Bun.write(path, Array.from({ length: count }, (_, index) => longLine(index)).join("\n") + "\n"))

describe("grep output byte budget", () => {
  it.live("preserves the exact baseline when results fit the budget", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      yield* writeShort(path.join(tmp.path, "short.txt"), 100)
      yield* withTools(tmp.path, (registry) =>
        Effect.gen(function* () {
          const baseline = yield* withBudget(undefined, executeTool(registry, call({ pattern: "needle" })))
          const bounded = yield* withBudget(51_200, executeTool(registry, call({ pattern: "needle" })))
          expect(textOf(bounded)).toBe(textOf(baseline))
          expect(bounded.metadata).toEqual(baseline.metadata)
          expect(bounded.metadata).toEqual({ matches: 100, truncated: false })
          expect(bytes(textOf(bounded))).toBeLessThan(51_200)
        }),
      )
    }),
  )

  it.live("bounds long matches to the byte budget without cutting lines or reordering", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      yield* writeLong(path.join(tmp.path, "long.txt"), 100)
      yield* withTools(tmp.path, (registry) =>
        Effect.gen(function* () {
          const baseline = yield* withBudget(undefined, executeTool(registry, call({ pattern: "needle" })))
          const bounded = yield* withBudget(51_200, executeTool(registry, call({ pattern: "needle" })))
          expect(baseline.metadata).toEqual({ matches: 100, truncated: false })
          expect(bytes(textOf(baseline))).toBeGreaterThan(51_200)
          expect(bounded.metadata).toEqual({ matches: bounded.metadata?.matches, truncated: true })
          expect(bounded.metadata?.matches).toBeLessThan(100)
          const text = textOf(bounded)
          expect(bytes(text)).toBeLessThanOrEqual(51_200)
          expect(text).toContain(`Found ${bounded.metadata?.matches} of 100 matches`)
          expect(text).toContain("Consider refining the pattern, path, or include filter.")
          expect(text).not.toContain("offset")
          expect(text).toContain("Line 1:")
          expect(text).not.toContain("Line 100:")
          expect(bounded.output).toEqual(baseline.output?.slice(0, bounded.metadata?.matches))
        }),
      )
    }),
  )

  it.live("keeps an early marker visible while dropping the tail", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      const lines = [longLine(0, "ANSWER_MARKER_EARLY "), ...Array.from({ length: 99 }, (_, index) => longLine(index + 1))]
      yield* Effect.promise(() => Bun.write(path.join(tmp.path, "early.txt"), lines.join("\n") + "\n"))
      yield* withTools(tmp.path, (registry) =>
        Effect.gen(function* () {
          const bounded = yield* withBudget(51_200, executeTool(registry, call({ pattern: "needle" })))
          expect(bounded.metadata?.truncated).toBe(true)
          const text = textOf(bounded)
          expect(bytes(text)).toBeLessThanOrEqual(51_200)
          expect(text).toContain("ANSWER_MARKER_EARLY")
          expect(text).not.toContain("Line 100:")
        }),
      )
    }),
  )

  it.live("recovers a marker dropped by the budget with a refined search", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      const lines = [...Array.from({ length: 99 }, (_, index) => longLine(index)), longLine(99, "ANSWER_MARKER_LATE ")]
      yield* Effect.promise(() => Bun.write(path.join(tmp.path, "late.txt"), lines.join("\n") + "\n"))
      yield* withTools(tmp.path, (registry) =>
        Effect.gen(function* () {
          const bounded = yield* withBudget(51_200, executeTool(registry, call({ pattern: "needle" })))
          expect(bounded.metadata?.truncated).toBe(true)
          expect(textOf(bounded)).not.toContain("ANSWER_MARKER_LATE")
          const refined = yield* withBudget(51_200, executeTool(registry, call({ pattern: "ANSWER_MARKER_LATE" })))
          expect(refined.metadata).toEqual({ matches: 1, truncated: false })
          expect(textOf(refined)).toContain("ANSWER_MARKER_LATE")
        }),
      )
    }),
  )

  it.live("bounds many files preserving result order", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      yield* Effect.promise(() =>
        Promise.all(
          Array.from({ length: 20 }, (_, file) =>
            Bun.write(
              path.join(tmp.path, `f${String(file).padStart(2, "0")}.txt`),
              Array.from({ length: 5 }, (_, index) => longLine(file * 5 + index)).join("\n") + "\n",
            ),
          ),
        ),
      )
      yield* withTools(tmp.path, (registry) =>
        Effect.gen(function* () {
          const bounded = yield* withBudget(51_200, executeTool(registry, call({ pattern: "needle" })))
          expect(bounded.metadata?.truncated).toBe(true)
          expect(bounded.metadata?.matches).toBeGreaterThan(0)
          const text = textOf(bounded)
          expect(bytes(text)).toBeLessThanOrEqual(51_200)
          const lines = text.split("\n")
          const pairs: Array<{ path: string; line: number }> = []
          let currentPath = ""
          for (const line of text.split("\n")) {
            if (line.startsWith("  Line ")) {
              pairs.push({ path: currentPath, line: Number(line.slice("  Line ".length).split(":")[0]) })
              continue
            }
            if (line.endsWith(":") && !line.startsWith("(")) currentPath = line.slice(0, -1)
          }
          const expected = (bounded.output ?? []).map((match: { entry: { path: string }; line: number }) => ({
            path: path.resolve(tmp.path, match.entry.path),
            line: match.line,
          }))
          expect(pairs).toEqual(expected)
          expect(pairs.length).toBe(bounded.metadata?.matches)
        }),
      )
    }),
  )

  it.live("never exceeds the budget even when a single match does not fit", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      yield* Effect.promise(() => Bun.write(path.join(tmp.path, "huge.txt"), "needle " + "x".repeat(5_000) + "\n"))
      yield* withTools(tmp.path, (registry) =>
        Effect.gen(function* () {
          const bounded = yield* withBudget(300, executeTool(registry, call({ pattern: "needle" })))
          expect(bounded.metadata).toEqual({ matches: 0, truncated: true })
          const text = textOf(bounded)
          expect(bytes(text)).toBeLessThanOrEqual(300)
          expect(text).toContain("Found 0 of 1 matches")
          expect(text).not.toContain("No matches found")
          expect(text).toContain("of 1 results")
          expect(text).toContain("Consider refining the pattern, path, or include filter.")
        }),
      )
    }),
  )

  it.live("enables the budget exactly at the truthful minimum notice and stays within it", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      yield* Effect.promise(() => Bun.write(path.join(tmp.path, "huge.txt"), "needle " + "x".repeat(5_000) + "\n"))
      const minimum = bytes(GrepTool.toModelContent([], true, 1))
      yield* withTools(tmp.path, (registry) =>
        Effect.gen(function* () {
          const below = yield* withBudget(minimum - 1, executeTool(registry, call({ pattern: "needle" })))
          expect(below.metadata).toEqual({ matches: 1, truncated: false })
          expect(textOf(below)).toContain("needle")
          const atMinimum = yield* withBudget(minimum, executeTool(registry, call({ pattern: "needle" })))
          expect(atMinimum.metadata).toEqual({ matches: 0, truncated: true })
          expect(bytes(textOf(atMinimum))).toBeLessThanOrEqual(minimum)
          expect(textOf(atMinimum)).toContain("Found 0 of 1 matches")
        }),
      )
    }),
  )

  it.live("never splits multibyte matches", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      yield* Effect.promise(() =>
        Bun.write(
          path.join(tmp.path, "unicode.txt"),
          Array.from({ length: 100 }, (_, index) => `needle ${index} ${"\u00e9".repeat(1000)}`).join("\n") + "\n",
        ),
      )
      yield* withTools(tmp.path, (registry) =>
        Effect.gen(function* () {
          const bounded = yield* withBudget(51_200, executeTool(registry, call({ pattern: "needle" })))
          const text = textOf(bounded)
          expect(bounded.metadata?.truncated).toBe(true)
          expect(bytes(text)).toBeLessThanOrEqual(51_200)
          expect(text).not.toContain("\uFFFD")
          expect(Buffer.from(text, "utf-8").toString("utf-8")).toBe(text)
        }),
      )
    }),
  )

  it.live("preserves the limit-based baseline when the byte budget is not binding", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      yield* writeShort(path.join(tmp.path, "many.txt"), 150)
      yield* withTools(tmp.path, (registry) =>
        Effect.gen(function* () {
          const baseline = yield* withBudget(undefined, executeTool(registry, call({ pattern: "needle" })))
          const bounded = yield* withBudget(51_200, executeTool(registry, call({ pattern: "needle" })))
          expect(baseline.metadata).toEqual({ matches: 100, truncated: true })
          expect(textOf(bounded)).toBe(textOf(baseline))
          expect(bounded.metadata).toEqual(baseline.metadata)
          expect(textOf(bounded)).toContain("Consider using a more specific path or pattern.")
          const tiny = yield* withBudget(1, executeTool(registry, call({ pattern: "needle" })))
          expect(textOf(tiny)).toBe(textOf(baseline))
          expect(tiny.metadata).toEqual(baseline.metadata)
          expect(textOf(tiny)).toContain("Consider using a more specific path or pattern.")
        }),
      )
    }),
  )

  it.live("treats invalid budget values as unset", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      yield* writeLong(path.join(tmp.path, "long.txt"), 100)
      yield* withTools(tmp.path, (registry) =>
        Effect.gen(function* () {
          const baseline = yield* withBudget(undefined, executeTool(registry, call({ pattern: "needle" })))
          for (const invalid of ["0", "1", "not-a-number", "-5"] as const) {
            const result = yield* withBudget(invalid === "not-a-number" ? "invalid" : Number(invalid), executeTool(registry, call({ pattern: "needle" })))
            expect(result.metadata).toEqual({ matches: 100, truncated: false })
            expect(textOf(result)).toBe(textOf(baseline))
          }
        }),
      )
    }),
  )
})
