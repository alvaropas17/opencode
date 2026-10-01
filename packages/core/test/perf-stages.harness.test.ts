import { describe, expect, setDefaultTimeout } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Effect, Layer, Schema } from "effect"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { makeGlobalNode, makeLocationNode } from "@opencode/util/effect/app-node"
import { filesystem } from "@opencode/util/effect/app-node-platform"
import { Database } from "@opencode/core/database/database"
import { Bus } from "@opencode/core/bus"
import { Config } from "@opencode/core/config"
import { Environment } from "@opencode/core/environment/index"
import { FSUtil } from "@opencode/util/fs-util"
import { Global } from "@opencode/util/global"
import { Location } from "@opencode/core/location"
import { FileAccess } from "@opencode/core/file-access"
import { LocationServiceMap } from "@opencode/core/location-service-map"
import { Model } from "@opencode/core/model"
import { Provider } from "@opencode/core/provider"
import { AbsolutePath } from "@opencode/core/schema"
import { Agent } from "@opencode/core/agent"
import { Image } from "@opencode/core/image"
import { Job } from "@opencode/core/job"
import { Session } from "@opencode/core/session"
import { SessionEvent } from "@opencode/core/session/event"
import { SessionExecution } from "@opencode/core/session/execution"
import { SessionMessage } from "@opencode/core/session/message"
import { SessionStore } from "@opencode/core/session/store"
import { SessionInstructions } from "@opencode/core/session/instructions"
import { SessionHistory } from "@opencode/core/session/history"
import { toLLMMessages } from "@opencode/core/session/runner/to-llm-message"
import { InstructionStateTable, SessionMessageTable, SessionTable } from "@opencode/core/session/sql"
import { Project } from "@opencode/core/project"
import { ProjectTable } from "@opencode/core/project/sql"
import { Permission } from "@opencode/core/permission"
import { PermissionSaved } from "@opencode/core/permission/saved"
import { Plugin } from "@opencode/core/plugin"
import { PluginSupervisor } from "@opencode/core/plugin/supervisor"
import { Shell } from "@opencode/core/shell"
import { ShellSelect } from "@opencode/core/shell/select"
import { ShellTool } from "@opencode/core/tool/plugin/shell"
import { ReadTool } from "@opencode/core/tool/plugin/read"
import { ReadToolFileSystem } from "@opencode/core/tool/read-filesystem"
import { ToolOutput } from "@opencode/core/tool-output"
import { Tool } from "@opencode/core/tool"
import { tmpdirScoped } from "./fixture/tmpdir"
import { tempGlobalLayer } from "./fixture/global"
import { offlineModels } from "./fixture/models"
import { testEffect } from "./lib/effect"
import { toolIdentity, registerToolPlugin } from "./lib/tool"
import { probe, probeDrain, probeReset } from "./lib/measure-probe"

// Stage-timing harness. It is skipped unless PERF_STAGES_HARNESS=1 so it does not
// run in the normal suite. Stage buckets only populate while the temporary probe
// calls are applied; without them it still measures wall-clock totals and the
// isolated truncate/history/conversion stages.
//
// Temporary instrumentation points used for the recorded run (all reverted after):
//   src/tool.ts               dispatch / hook.before / lookup / hook.after / images
//   src/tool/runtime.ts       validate / leaf / capture
//   src/tool-output.ts        truncate
//   src/permission.ts         permission (assert, nested inside leaf)
//   src/bus.ts                bus.persist (commitDurableEvent) / bus.emit (notify)
//   src/shell.ts              shell.spawn (spawn handshake -> ready)
//   src/session/history.ts    history.entries (entriesForRunner)
//   src/session/runner/to-llm-message.ts  tollm (toLLMMessages)


setDefaultTimeout(180_000)

const sessionID = Session.ID.make("ses_perf_stages")
const sessionModel = Model.Ref.make({ id: Model.ID.make("fake-model"), providerID: Provider.ID.make("fake") })
const agentID = Agent.ID.make("build")
const isWindows = process.platform === "win32"
const SHELL_COMMAND = "Write-Output ok"

// A location-scoped mock of SessionExecution so Session.resume completes without a model.
const executionNode = makeGlobalNode({
  service: SessionExecution.Service,
  layer: Layer.effect(
    SessionExecution.Service,
    Effect.gen(function* () {
      const bus = yield* Bus.Service
      const store = yield* SessionStore.Service
      const complete = Effect.fn("PerfHarness.complete")(function* (id: Session.ID) {
        const session = yield* store.get(id)
        if (!session) return
        const assistantMessageID = SessionMessage.ID.create()
        yield* bus.publish(SessionEvent.Step.Started, {
          sessionID: id,
          assistantMessageID,
          agent: session.agent ?? Agent.ID.make("code"),
          model: sessionModel,
          started: 0,
        })
        yield* bus.publish(SessionEvent.Text.Started, { sessionID: id, assistantMessageID, ordinal: 0 })
        yield* bus.publish(SessionEvent.Text.Ended, {
          sessionID: id,
          assistantMessageID,
          ordinal: 0,
          text: "ok",
        })
        yield* bus.publish(SessionEvent.Step.Ended, {
          sessionID: id,
          assistantMessageID,
          finish: "stop",
          cost: 0 as never,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          snapshot: undefined,
          files: [],
        } as never)
      })
      return SessionExecution.Service.of({
        active: Effect.succeed(new Set()),
        isActive: () => Effect.succeed(false),
        resume: complete,
        wake: () => Effect.void,
        interrupt: () => Effect.succeed(false),
        awaitIdle: (id) => complete(id).pipe(Effect.exit, Effect.asVoid),
      })
    }),
  ),
  deps: [Bus.node, SessionStore.node],
})

const pluginsNode = makeLocationNode({
  name: "test/perf-plugins",
  layer: Layer.effectDiscard(
    Effect.gen(function* () {
      yield* registerToolPlugin(ReadTool.Plugin)
      yield* registerToolPlugin(ShellTool.Plugin)
    }),
  ),
  deps: [
    Config.node,
    Environment.node,
    FileAccess.node,
    Permission.node,
    Session.node,
    Job.node,
    Shell.node,
    ShellSelect.node,
    Tool.node,
    ReadToolFileSystem.node,
    SessionInstructions.node,
    Image.node,
    FSUtil.node,
    Location.node,
  ],
})

const nodes = LayerNode.group([
  Database.node,
  Bus.node,
  Job.node,
  Session.node,
  SessionExecution.node,
  LocationServiceMap.node,
  filesystem,
  FSUtil.node,
  Global.node,
  PermissionSaved.node,
])

const replacements = [
  SessionExecution.node.replace(executionNode),
  Global.node.replace(tempGlobalLayer),
  PluginSupervisor.node.replace(pluginsNode),
  Bus.node.replace(Bus.configured({ persist: true })),
  offlineModels,
]

const it = testEffect(AppNodeBuilder.build(nodes, replacements))

const harnessIt = process.env.PERF_STAGES_HARNESS === "1" ? it.live : it.live.skip

type StageAgg = Record<string, { sum: number; count: number }>
type Sample = { snapshotMs: number; totalMs: number; stages: StageAgg; ok: boolean }
type Target = "read" | "shell"

const callFor = (target: Target, n: number) => ({
  sessionID,
  ...toolIdentity,
  call: {
    type: "tool-call" as const,
    id: `call-perf-${target}-${n}`,
    name: target,
    input: target === "read" ? { path: "perf-probe.txt" } : { command: SHELL_COMMAND },
  },
})

const aggregate = (drained: Record<string, number[]>): StageAgg => {
  const out: StageAgg = {}
  for (const [stage, values] of Object.entries(drained)) out[stage] = { sum: values.reduce((a, b) => a + b, 0), count: values.length }
  return out
}

const percentile = (values: number[], p: number) => {
  if (values.length === 0) return NaN
  const sorted = [...values].sort((a, b) => a - b)
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))
  return sorted[idx]
}
const median = (values: number[]) => percentile(values, 50)

const summarise = (values: number[]) => ({
  n: values.length,
  median: median(values),
  min: Math.min(...values),
  max: Math.max(...values),
})

describe("perf stages harness", () => {
  harnessIt("measures read/shell stages, truncation, history and conversion", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      const probeFile = path.join(tmp.path, "perf-probe.txt")
      yield* Effect.promise(() =>
        Bun.write(probeFile, Array.from({ length: 60 }, (_, i) => `line ${i}`).join("\n")),
      )

      const sessions = yield* Session.Service
      const location = Location.Ref.make({ directory: AbsolutePath.make(tmp.path) })
      yield* sessions.create({ id: sessionID, title: "perf", location, model: sessionModel })

      const locations = yield* LocationServiceMap.Service
      const locationLayer = locations.get(location)

      const output = yield* Effect.gen(function* () {
        const plugins = yield* Plugin.Service
        yield* plugins.awaitActivation
        const agents = yield* Agent.Service
        yield* agents.transform((editor) =>
          editor.update(agentID, (agent) => {
            agent.permissions = [
              { action: "read", resource: "*", effect: "allow" },
              { action: "shell", resource: "*", effect: "allow" },
              { action: "external_directory", resource: "*", effect: "allow" },
            ] as never
          }),
        )
        const db = (yield* Database.Service).db
        yield* db
          .insert(ProjectTable)
          .values({ id: Project.ID.global, worktree: AbsolutePath.make(tmp.path), sandboxes: [] })
          .onConflictDoNothing()
          .run()
          .pipe(Effect.orDie)

        const registry = yield* Tool.Service
        const toolOutput = yield* ToolOutput.Service

        const executeSample = (target: Target, n: number) =>
          Effect.gen(function* () {
            const call = callFor(target, n)
            const snapStart = performance.now()
            const snapshot = yield* registry.snapshot()
            const snapshotMs = performance.now() - snapStart
            probeReset()
            probe.on = true
            const started = performance.now()
            const result = yield* snapshot.execute(call).pipe(
              Effect.exit,
            )
            const totalMs = performance.now() - started
            probe.on = false
            const stages = aggregate(probeDrain())
            return { snapshotMs, totalMs, stages, ok: result._tag === "Success" } satisfies Sample
          })

        const warmups = 2
        const reps = 15
        for (let i = 0; i < warmups; i++) {
          yield* executeSample("read", i).pipe(Effect.orDie)
          yield* executeSample("shell", i).pipe(Effect.orDie)
        }

        const readSamples: Sample[] = []
        const shellSamples: Sample[] = []
        for (let i = 0; i < reps; i++) {
          const first: Target = i % 2 === 0 ? "read" : "shell"
          const second: Target = first === "read" ? "shell" : "read"
          const firstSample = yield* executeSample(first, i).pipe(Effect.orDie)
          const secondSample = yield* executeSample(second, i).pipe(Effect.orDie)
          if (first === "read") readSamples.push(firstSample)
          else shellSamples.push(firstSample)
          if (second === "read") readSamples.push(secondSample)
          else shellSamples.push(secondSample)
        }

        // Diagnostic: fixed execution order to separate tool identity from call position.
        const diagOrder: Array<{ target: Target; totalMs: number }> = []
        for (const target of ["read", "shell", "read", "shell", "read", "shell", "read", "shell"] as Target[]) {
          const sample = yield* executeSample(target, 500 + diagOrder.length).pipe(Effect.orDie)
          diagOrder.push({ target, totalMs: Number(sample.totalMs.toFixed(3)) })
        }
        const diagGrouped: Array<{ target: Target; totalMs: number }> = []
        for (const target of ["read", "read", "read", "shell", "shell", "shell"] as Target[]) {
          const sample = yield* executeSample(target, 700 + diagGrouped.length).pipe(Effect.orDie)
          diagGrouped.push({ target, totalMs: Number(sample.totalMs.toFixed(3)) })
        }

        // Isolated truncation stage.
        const bigText = Array.from({ length: 3000 }, (_, i) => `line ${i}`).join("\n")
        const truncateSamples: number[] = []
        for (let i = 0; i < warmups; i++) {
          yield* toolOutput.truncate({ content: [{ type: "text" as const, text: bigText }], metadata: {} } as never)
        }
        for (let i = 0; i < reps; i++) {
          probeReset()
          probe.on = true
          const t = performance.now()
          yield* toolOutput.truncate({ content: [{ type: "text" as const, text: bigText }], metadata: {} } as never)
          probe.on = false
          const drained = probeDrain()
          truncateSamples.push(drained["truncate"]?.[0] ?? performance.now() - t)
        }

        // History rows + instruction state for entriesForRunner. Rows store encoded JSON;
        // validate them once through the same schema history decodes with.
        const rawMessages: Array<{ id: SessionMessage.ID; type: string; data: Record<string, unknown> }> = []
        for (let i = 0; i < 20; i++) {
          const user = {
            id: SessionMessage.ID.create(),
            type: "user",
            text: `Question ${i}`,
            time: { created: i },
          }
          const assistant = {
            id: SessionMessage.ID.create(),
            type: "assistant",
            agent: agentID,
            model: { id: "fake-model", providerID: "fake" },
            content: [{ type: "text", text: `Answer ${i}` }],
            time: { created: i },
            finish: "stop",
          }
          Schema.decodeUnknownSync(SessionMessage.Info)(user)
          Schema.decodeUnknownSync(SessionMessage.Info)(assistant)
          const { id: userId, type: userType, ...userData } = user
          const { id: assistantId, type: assistantType, ...assistantData } = assistant
          rawMessages.push({ id: userId, type: userType, data: userData })
          rawMessages.push({ id: assistantId, type: assistantType, data: assistantData })
        }
        yield* db
          .insert(SessionTable)
          .values({
            id: sessionID,
            project_id: Project.ID.global,
            slug: "perf",
            directory: tmp.path,
            title: "perf",
            version: "test",
          })
          .onConflictDoNothing()
          .run()
          .pipe(Effect.orDie)
        yield* db
          .insert(InstructionStateTable)
          .values({
            session_id: sessionID,
            epoch_start: 0,
            through_seq: 0,
            initial_values: {},
            current_values: {},
          })
          .onConflictDoNothing()
          .run()
          .pipe(Effect.orDie)
        yield* db
          .insert(SessionMessageTable)
          .values(
            rawMessages.map((message, index) => ({
              id: message.id,
              session_id: sessionID,
              type: message.type as never,
              seq: index,
              data: message.data as never,
            })),
          )
          .run()
          .pipe(Effect.orDie)

        const historySamples: number[] = []
        const tollmSamples: number[] = []
        const loaded = yield* SessionHistory.load(db, sessionID, "latest")
        for (let i = 0; i < warmups; i++) {
          yield* SessionHistory.entriesForRunner(db, sessionID, [], "latest")
          toLLMMessages(loaded, sessionModel, "fake")
        }
        for (let i = 0; i < reps; i++) {
          probeReset()
          probe.on = true
          const t = performance.now()
          yield* SessionHistory.entriesForRunner(db, sessionID, [], "latest")
          probe.on = false
          const drained = probeDrain()
          historySamples.push(drained["history.entries"]?.[0] ?? performance.now() - t)
        }
        for (let i = 0; i < reps; i++) {
          probeReset()
          probe.on = true
          const t = performance.now()
          toLLMMessages(loaded, sessionModel, "fake")
          probe.on = false
          const drained = probeDrain()
          tollmSamples.push(drained["tollm"]?.[0] ?? performance.now() - t)
        }

        const collect = (samples: Sample[]) => {
          const allStages = new Set<string>()
          for (const sample of samples) for (const stage of Object.keys(sample.stages)) allStages.add(stage)
          const stages: Record<string, unknown> = {}
          for (const stage of allStages) {
            const perSample = samples.map((s) => s.stages[stage])
            stages[stage] = {
              ...summarise(perSample.map((x) => x?.sum ?? 0)),
              present: perSample.filter((x) => x !== undefined).length,
              spans: perSample.reduce((total, x) => total + (x?.count ?? 0), 0),
            }
          }
          return {
            total: summarise(samples.map((s) => s.totalMs)),
            snapshot: summarise(samples.map((s) => s.snapshotMs)),
            stages,
            okCount: samples.filter((s) => s.ok).length,
            totals: samples.map((s) => Number(s.totalMs.toFixed(3))),
          }
        }

        // Isolated durable publication + projection, using a real session event with a projector.
        const bus = yield* Bus.Service
        const durableSamples: number[] = []
        const durableEmitSamples: number[] = []
        for (let i = 0; i < warmups; i++) yield* bus.publish(SessionEvent.Viewed, { sessionID, idle: -i - 1 })
        for (let i = 0; i < reps; i++) {
          probeReset()
          probe.on = true
          const t = performance.now()
          yield* bus.publish(SessionEvent.Viewed, { sessionID, idle: i })
          probe.on = false
          const drained = probeDrain()
          durableSamples.push(drained["bus.persist"]?.[0] ?? performance.now() - t)
          durableEmitSamples.push(drained["bus.emit"]?.[0] ?? performance.now() - t)
        }

        return {
          read: collect(readSamples),
          shell: collect(shellSamples),
          truncate: summarise(truncateSamples),
          history: summarise(historySamples),
          tollm: summarise(tollmSamples),
          durablePublish: { persist: summarise(durableSamples), emit: summarise(durableEmitSamples) },
          diagOrder,
          diagGrouped,
          messageCount: loaded.length,
        }
      }).pipe(Effect.provide(locationLayer), Effect.ensuring(locations.invalidate(location)))

      const results = {
        generatedAt: new Date().toISOString(),
        platform: process.platform,
        runtimes: { bun: Bun.version },
        repetitions: 15,
        warmups: 2,
        scope:
          "isolated microbench: Tool.Snapshot.execute for read/shell plus isolated truncate/history/conversion. NOT the SessionRunner tool-call path; see perf-stages-runner.harness.test.ts for that.",
        limitations: [
          "No SessionRunner involvement: this does not measure durable Tool.Success publication/projection per tool call nor next-request reload.",
          "bus.persist here is the isolated publish of SessionEvent.Viewed; shell tool events are ephemeral, so no durable tool event is captured inline.",
          "permission for read/shell uses the real Permission service with allow rules; the runner harness mocks it.",
          "history.entries/conversion use a seeded 40-message text-only history with empty instructions; lower bound for rich histories.",
        ],
        target: { read: "perf-probe.txt (60 lines)", shell: SHELL_COMMAND },
        output,
      }
      yield* Effect.promise(() =>
        Bun.write(path.join(import.meta.dir, "perf-stages.results.json"), JSON.stringify(results, null, 2)),
      )
      console.log("PERF_STAGES_RESULTS " + JSON.stringify(results))
      expect(output.read.total.n).toBe(15)
      expect(output.shell.total.n).toBe(15)
    }),
  )
})
