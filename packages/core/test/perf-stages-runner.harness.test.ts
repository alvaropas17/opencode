import { afterAll, describe, expect, setDefaultTimeout } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { Effect, Layer, Schema } from "effect"
import { OpenAIChat } from "@opencode/ai/protocols/openai-chat"
import { LanguageModel } from "@opencode/ai"
import { TestLLM } from "@opencode/ai/testing"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { LayerNodePlatform } from "@opencode/core/effect/app-node-platform"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { makeLocationNode } from "@opencode/util/effect/app-node"
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
import { AbsolutePath } from "@opencode/core/schema"
import { Agent } from "@opencode/core/agent"
import { Form } from "@opencode/core/form"
import { Image } from "@opencode/core/image"
import { Job } from "@opencode/core/job"
import { Session } from "@opencode/core/session"
import { SessionExecution } from "@opencode/core/session/execution"
import { SessionRunCoordinator } from "@opencode/core/session/run-coordinator"
import { SessionStore } from "@opencode/core/session/store"
import { SessionInstructions } from "@opencode/core/session/instructions"
import { SessionCompaction } from "@opencode/core/session/compaction"
import { SessionProjector } from "@opencode/core/session/projector"
import { SessionInbox } from "@opencode/core/session/inbox"
import { SessionModelTransport } from "@opencode/core/session/model-transport"
import { SessionRunner } from "@opencode/core/session/runner/index"
import { SessionRunnerLLM } from "@opencode/core/session/runner/llm"
import { SessionRunnerModel } from "@opencode/core/session/runner/model"
import { SessionTable } from "@opencode/core/session/sql"
import { InstructionEntry } from "@opencode/core/session/instruction-entry"
import { Instructions } from "@opencode/core/instructions/index"
import { InstructionBuiltIns } from "@opencode/core/instructions/builtins"
import { InstructionDiscovery } from "@opencode/core/instruction-discovery"
import { SkillInstructions } from "@opencode/core/skill/instructions"
import { ReferenceInstructions } from "@opencode/core/reference/instructions"
import { McpInstructions } from "@opencode/core/mcp/instructions"
import { Snapshot } from "@opencode/core/snapshot"
import { Project } from "@opencode/core/project"
import { ProjectTable } from "@opencode/core/project/sql"
import { Permission } from "@opencode/core/permission"
import { Plugin } from "@opencode/core/plugin"
import { PluginSupervisor } from "@opencode/core/plugin/supervisor"
import { PluginHooks } from "@opencode/core/plugin/hooks"
import { OptimizePlugin } from "@opencode/core/plugin/optimize"
import { IdentityPlugin } from "@opencode/core/plugin/identity"
import { NativeCompactionPlugin } from "@opencode/core/plugin/compaction"
import { Shell } from "@opencode/core/shell"
import { ShellSelect } from "@opencode/core/shell/select"
import { ShellTool } from "@opencode/core/tool/plugin/shell"
import { ReadTool } from "@opencode/core/tool/plugin/read"
import { ReadToolFileSystem } from "@opencode/core/tool/read-filesystem"
import { Tool } from "@opencode/core/tool"
import { promptLocationNode } from "./fixture/prompt-location"
import { tempGlobalLayer } from "./fixture/global"
import { testEffect } from "./lib/effect"
import { permissionLayer } from "./lib/permission"
import { agentHost, modelHost, host, noProviders } from "./plugin/host"
import { registerToolPlugin } from "./lib/tool"
import { probe, probeDrain, probeReset } from "./lib/measure-probe"

setDefaultTimeout(180_000)

const projectDir = AbsolutePath.make(fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "oc-perf-runner-"))))
afterAll(() => fs.rmSync(projectDir, { recursive: true, force: true }))

const agentID = Agent.ID.make("build")
const READ_TARGET = "perf-probe.txt"
const SHELL_COMMAND = "Write-Output ok"

const testLLM = TestLLM.layer({ fallback: [] })

const defaultModelLimit = { context: 200_000, output: 32_000 }
const model = LanguageModel.make({ id: "fake-model", provider: "fake", route: OpenAIChat.route })

const pluginsNode = makeLocationNode({
  name: "test/perf-runner-plugins",
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

const makeLayer = () => {
  const modelTransport = Layer.succeed(
    SessionModelTransport.Service,
    SessionModelTransport.Service.of({
      bind: () => ({ execute: () => Effect.die("Unexpected WebSocket execution") }),
      close: () => Effect.void,
      closeAll: Effect.void,
    }),
  )
  const models = Layer.mock(SessionRunnerModel.Service)({
    resolve: (session) =>
      Effect.succeed(
        SessionRunnerModel.resolved(model, {
          capabilities: { tools: true, input: ["text", "image"], output: ["text"] },
          cost: [],
          limit: defaultModelLimit,
          variant: session.model?.variant,
          compaction: undefined,
        }),
      ),
  })
  const systemContext = Layer.mock(InstructionBuiltIns.Service, {
    load: () =>
      Effect.succeed(
        Instructions.make({
          key: Instructions.Key.make("test/context"),
          codec: Schema.toCodecJson(Schema.String),
          read: Effect.succeed("Initial context"),
          render: { initial: String, changed: (_previous, current) => current, removed: () => "removed" },
        }),
      ),
  })
  const instructionContext = Layer.mock(InstructionDiscovery.Service, {
    project: true,
    global: true,
    load: () => Effect.succeed(Instructions.empty),
  })
  const skillInstructions = Layer.mock(SkillInstructions.Service, { load: () => Effect.succeed(Instructions.empty) })
  const referenceInstructions = Layer.mock(ReferenceInstructions.Service, {
    load: () => Effect.succeed(Instructions.empty),
  })
  const mcpInstructions = Layer.mock(McpInstructions.Service, { load: () => Effect.succeed(Instructions.empty) })
  const config = Config.testLayer()
  const busLayer = Bus.configured({ persist: true })
  const busReplacement = Bus.node.replace(busLayer)
  const promptModels = Layer.mock(Model.Service, {
    get: () => Effect.undefined,
    all: () => Effect.succeed([]),
    available: () => Effect.succeed([]),
    default: () => Effect.undefined,
    small: () => Effect.undefined,
  })
  const replacements: LayerNode.Replacements = [
    Snapshot.node.replace(Snapshot.noopLayer),
    LayerNodePlatform.llmClient.replace(TestLLM.clientLayer.pipe(Layer.provide(testLLM))),
    SessionRunnerModel.node.replace(models),
    InstructionBuiltIns.node.replace(systemContext),
    InstructionDiscovery.node.replace(instructionContext),
    Location.node.replace(Location.boundNode({ directory: projectDir })),
    SkillInstructions.node.replace(skillInstructions),
    ReferenceInstructions.node.replace(referenceInstructions),
    McpInstructions.node.replace(mcpInstructions),
    Permission.node.replace(permissionLayer({ assert: () => Effect.void })),
    Config.node.replace(config),
    PluginSupervisor.node.replace(Layer.empty),
    Plugin.node.replace(Layer.mock(Plugin.Service, { awaitActivation: Effect.void })),
    SessionModelTransport.node.replace(modelTransport),
    Global.node.replace(tempGlobalLayer),
    busReplacement,
  ]
  const runnerLayer = AppNodeBuilder.build(SessionRunnerLLM.node, replacements)
  const execution = Layer.effect(
    SessionExecution.Service,
    Effect.gen(function* () {
      const sessionRunner = yield* SessionRunner.Service
      function drain(
        sessionID: Session.ID,
        force: boolean,
        continuation?: SessionRunner.Continuation,
      ): Effect.Effect<void, SessionRunner.RunError> {
        return sessionRunner
          .drain({ sessionID, force, continuation })
          .pipe(
            Effect.flatMap((result) =>
              result._tag === "Complete" ? Effect.void : drain(sessionID, false, result.continuation),
            ),
          )
      }
      const coordinator = yield* SessionRunCoordinator.make<Session.ID, SessionRunner.RunError>({
        drain: (sessionID, force) => drain(sessionID, force),
      })
      return SessionExecution.Service.of({
        active: coordinator.active,
        isActive: coordinator.isActive,
        resume: coordinator.run,
        wake: coordinator.wake,
        interrupt: (sessionID) => coordinator.interrupt(sessionID),
        awaitIdle: coordinator.awaitIdle,
      })
    }),
  ).pipe(Layer.provide(runnerLayer), Layer.orDie)
  return AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      Bus.node,
      Form.node,
      SessionProjector.node,
      SessionStore.node,
      SessionInbox.node,
      Agent.node,
      Model.node,
      Tool.node,
      PluginHooks.node,
      pluginsNode,
      SessionRunnerModel.node,
      InstructionBuiltIns.node,
      InstructionDiscovery.node,
      InstructionEntry.node,
      SkillInstructions.node,
      ReferenceInstructions.node,
      Config.node,
      Snapshot.node,
      SessionCompaction.node,
      LayerNodePlatform.llmClient,
      SessionRunnerLLM.node,
      SessionExecution.node,
      Session.node,
      Job.node,
      Shell.node,
      ShellSelect.node,
      Environment.node,
      FileAccess.node,
      ReadToolFileSystem.node,
      SessionInstructions.node,
      Image.node,
      FSUtil.node,
      LocationServiceMap.node,
      filesystem,
      Global.node,
    ]),
    [
      ...replacements,
      LocationServiceMap.node.replace(promptLocationNode),
      Model.node.replace(promptModels),
      SessionExecution.node.replace(execution),
    ],
  )
}

const layer = makeLayer().pipe(Layer.provideMerge(testLLM))
const it = testEffect(layer)
const harnessIt = process.env.PERF_STAGES_HARNESS === "1" ? it.live : it.live.skip

// Runner-path stage harness (skipped unless PERF_STAGES_HARNESS=1).
// Scope: real SessionRunner + TestLLM fake + real read/shell tools in a tmpdir, so it
// measures the model tool-call path, the durable Tool.Success publication/projector,
// and the reload/conversion of the next request (after the tool result).
// Temporary production probes used for the recorded run (all reverted afterwards):
//   src/tool.ts, src/tool/runtime.ts, src/tool-output.ts, src/permission.ts,
//   src/bus.ts, src/shell.ts, src/session/history.ts,
//   src/session/runner/to-llm-message.ts, src/session/runner/step.ts,
//   src/session/runner/publish-llm-event.ts, src/session/model-request.ts
// The kept harness imports ./lib/measure-probe; re-running with populated stages
// requires re-injecting those probes against the same probe sink.
// Limitations: Permission is mocked (allow) in this scenario, so the permission stage
// is N/D here; each step also issues a near-empty extra baseTranscript conversion, so
// request-level conversion is taken as the max of each step's half of the spans.

const insertSession = (id: Session.ID) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* db
      .insert(SessionTable)
      .values({
        id,
        project_id: Project.ID.global,
        slug: id,
        directory: projectDir,
        title: "perf runner",
        version: "test",
      })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
  })

const setup = Effect.gen(function* () {
  const { db } = yield* Database.Service
  const agents = yield* Agent.Service
  const models = yield* Model.Service
  const hooks = yield* PluginHooks.Service
  const pluginHost = host({
    agent: agentHost(agents),
    model: modelHost(models),
    provider: noProviders,
    session: { hook: (name, callback) => hooks.register("session", name, callback) },
  })
  yield* Effect.forEach(OptimizePlugin.Plugins, (plugin) => plugin.effect(pluginHost), { discard: true })
  yield* IdentityPlugin.Plugin.effect(pluginHost)
  yield* NativeCompactionPlugin.Plugin.effect(pluginHost)
  yield* agents.transform((editor) => {
    editor.update(agentID, (agent) => {
      agent.mode = "primary"
    })
  })
  yield* db
    .insert(ProjectTable)
    .values({ id: Project.ID.global, worktree: projectDir, sandboxes: [] })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
  yield* Effect.promise(() =>
    Bun.write(path.join(projectDir, READ_TARGET), Array.from({ length: 60 }, (_, i) => `line ${i}`).join("\n")),
  )
  const session = yield* Session.Service
  const llm = yield* TestLLM.Service
  return { session, llm }
})

type Fixture = Effect.Success<typeof setup>

type StageAgg = Record<string, { sum: number; count: number }>
type RepSample = { stages: StageAgg; historySpans: number[]; tollmBaseSpans: number[]; toolCalls: number }

const summarise = (values: number[]) => ({
  n: values.length,
  median: values.length ? [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] : NaN,
  min: values.length ? Math.min(...values) : NaN,
  max: values.length ? Math.max(...values) : NaN,
})

const runRep = (fixture: Fixture, id: Session.ID, target: "read" | "shell") =>
  Effect.gen(function* () {
    yield* insertSession(id)
    fixture.llm.requests.length = 0
    yield* fixture.llm.push(
      target === "read"
        ? TestLLM.tool(`call-${id}-read`, "read", { path: READ_TARGET })
        : TestLLM.tool(`call-${id}-shell`, "shell", { command: SHELL_COMMAND }),
      TestLLM.text("done", `text-${id}`),
    )
    yield* fixture.session.prompt({ sessionID: id, text: `please run ${target}`, resume: false })
    probeReset()
    probe.on = true
    yield* fixture.session.resume(id)
    probe.on = false
    const drained = probeDrain()
    const stages: StageAgg = {}
    for (const [stage, values] of Object.entries(drained))
      stages[stage] = { sum: values.reduce((a, b) => a + b, 0), count: values.length }
    return {
      stages,
      historySpans: drained["history.entries"] ?? [],
      tollmBaseSpans: drained["tollm.base"] ?? [],
      toolCalls: drained["runner.tool.total"]?.length ?? 0,
    } satisfies RepSample
  })

describe("perf stages runner harness", () => {
  harnessIt("measures runner tool-call persistence and next-request reload", () =>
    Effect.gen(function* () {
      const fixture = yield* setup

      const reps = 15
      const warmups = 2
      for (let i = 0; i < warmups; i++) {
        yield* runRep(fixture, Session.ID.make(`ses_perf_runner_warm_${i}`), i % 2 === 0 ? "read" : "shell")
      }

      const readSamples: RepSample[] = []
      const shellSamples: RepSample[] = []
      for (let i = 0; i < reps; i++) {
        const first: "read" | "shell" = i % 2 === 0 ? "read" : "shell"
        const second: "read" | "shell" = first === "read" ? "shell" : "read"
        const a = yield* runRep(fixture, Session.ID.make(`ses_perf_runner_${i}_a`), first)
        const b = yield* runRep(fixture, Session.ID.make(`ses_perf_runner_${i}_b`), second)
        if (first === "read") readSamples.push(a)
        else shellSamples.push(a)
        if (second === "read") readSamples.push(b)
        else shellSamples.push(b)
      }

      const collect = (samples: RepSample[]) => {
        const stages = new Set<string>()
        for (const sample of samples) for (const stage of Object.keys(sample.stages)) stages.add(stage)
        const out: Record<string, unknown> = {}
        for (const stage of stages) {
          const per = samples.map((s) => s.stages[stage])
          out[stage] = {
            ...summarise(per.map((x) => x?.sum ?? 0)),
            present: per.filter(Boolean).length,
            spans: per.reduce((total, x) => total + (x?.count ?? 0), 0),
          }
        }
        const history1 = samples.map((s) => s.historySpans[0]).filter((v): v is number => v !== undefined)
        const history2 = samples.map((s) => s.historySpans[1]).filter((v): v is number => v !== undefined)
        // Each step triggers two baseTranscript conversions (one near-empty, one full of
        // messages). The first half belongs to request1 and the second to request2; take the
        // full conversion of each half, which is the max within it.
        const tollmOf = (spans: number[], half: "first" | "second") => {
          if (spans.length < 2) return half === "first" ? spans[0] : undefined
          const mid = Math.ceil(spans.length / 2)
          const values = half === "first" ? spans.slice(0, mid) : spans.slice(mid)
          return values.length === 0 ? undefined : Math.max(...values)
        }
        const tollm1 = samples.map((s) => tollmOf(s.tollmBaseSpans, "first")).filter((v): v is number => v !== undefined)
        const tollm2 = samples.map((s) => tollmOf(s.tollmBaseSpans, "second")).filter((v): v is number => v !== undefined)
        return {
          toolCalls: samples.reduce((total, s) => total + s.toolCalls, 0),
          stages: out,
          request1: { history: summarise(history1), tollm: summarise(tollm1) },
          request2: { history: summarise(history2), tollm: summarise(tollm2) },
          historySpanCounts: samples.map((s) => s.historySpans.length),
          tollmBaseSpanCounts: samples.map((s) => s.tollmBaseSpans.length),
          rawSpans: samples.slice(0, 3).map((s) => ({ history: s.historySpans, tollmBase: s.tollmBaseSpans })),
        }
      }

      const results = {
        generatedAt: new Date().toISOString(),
        platform: process.platform,
        runtimes: { bun: Bun.version },
        repetitions: reps,
        warmups,
        note:
          "SessionRunner real + TestLLM fake + read/shell reales (tmpdir). Permission mockeado (allow) en este escenario. request1 = step antes del tool-result; request2 = step siguiente que recarga y convierte el historial con el tool-result.",
        limitations: [
          "Permission stage N/D here (mock allow); measured in the isolated microbench harness instead.",
          "toLLMMessages is invoked twice per step (one near-empty, one full); request conversion is the max of each step's half of the spans.",
          "bus.persist is the sum over all durable session events in a tool rep (14 spans/rep), not only the tool events.",
          "Projection time is included inside bus.persist and cannot be separated from the transaction with this instrumentation.",
          "Windows/PowerShell process startup dominates the shell leaf; not a property of the runner.",
        ],
        read: collect(readSamples),
        shell: collect(shellSamples),
      }
      yield* Effect.promise(() =>
        Bun.write(path.join(import.meta.dir, "perf-stages-runner.results.json"), JSON.stringify(results, null, 2)),
      )
      console.log("PERF_STAGES_RUNNER_RESULTS " + JSON.stringify(results))
      expect(readSamples.length).toBe(reps)
      expect(shellSamples.length).toBe(reps)
      expect(readSamples.every((s) => s.toolCalls >= 1)).toBe(true)
      expect(shellSamples.every((s) => s.toolCalls >= 1)).toBe(true)
    }),
  )
})
