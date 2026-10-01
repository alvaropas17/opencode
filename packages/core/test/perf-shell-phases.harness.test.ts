import { describe, expect, setDefaultTimeout } from "bun:test"
import fs from "fs"
import path from "path"
import { Duration, Effect, Layer, Stream } from "effect"
import { ChildProcess } from "effect/unstable/process"
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
import { Job } from "@opencode/core/job"
import { Session } from "@opencode/core/session"
import { SessionExecution } from "@opencode/core/session/execution"
import { SessionStore } from "@opencode/core/session/store"
import { Permission } from "@opencode/core/permission"
import { Plugin } from "@opencode/core/plugin"
import { PluginSupervisor } from "@opencode/core/plugin/supervisor"
import { Shell } from "@opencode/core/shell"
import { ShellSelect } from "@opencode/core/shell/select"
import { ShellTool } from "@opencode/core/tool/plugin/shell"
import { Tool } from "@opencode/core/tool"
import { tmpdirScoped } from "./fixture/tmpdir"
import { tempGlobalLayer } from "./fixture/global"
import { offlineModels } from "./fixture/models"
import { testEffect } from "./lib/effect"
import { permissionLayer } from "./lib/permission"
import { toolIdentity, registerToolPlugin } from "./lib/tool"
import { probe, probeDrainEvents, probeReset, type ProbeEvent } from "./lib/measure-probe"

setDefaultTimeout(600_000)

// Focused shell phase bench. Skipped unless PERF_SHELL_PHASES=1.
// Reliability boundary: tool sub-phases come from temporary probe marks injected into
// src/shell.ts + tool/plugin/shell.ts at real boundaries (before spawner.spawn, returned
// handle, ready/API-return, child-exit callback, output drain, capture, tool result).
// Direct Bun.spawn and Environment.spawner marks are taken exactly in the harness.
const BENCH = path.join(process.env.TEMP ?? process.env.TMP ?? ".", "opencode", "shell-bench")
const EXE = path.join(BENCH, "ok.exe")
const REPO = path.join(BENCH, "repo")
const COMSPEC = process.env.COMSPEC ?? "C:\\WINDOWS\\system32\\cmd.exe"
const GITBASH = ShellSelect.gitbash() ?? "C:\\Program Files\\Git\\bin\\bash.exe"
const sessionID = Session.ID.make("ses_perf_shell_phases")
const sessionModel = Model.Ref.make({ id: Model.ID.make("test"), providerID: Provider.ID.make("test") })

const executionNode = makeGlobalNode({
  service: SessionExecution.Service,
  layer: Layer.effect(
    SessionExecution.Service,
    Effect.gen(function* () {
      const store = yield* SessionStore.Service
      const complete = Effect.fn("PerfShellPhases.complete")(function* (id: Session.ID) {
        const session = yield* store.get(id)
        if (!session) return
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
  deps: [SessionStore.node],
})

const shellPluginSupervisor = makeLocationNode({
  name: "test/perf-shell-phases-plugins",
  layer: Layer.effectDiscard(registerToolPlugin(ShellTool.Plugin)),
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
])

const layer = AppNodeBuilder.build(nodes, [
  SessionExecution.node.replace(executionNode),
  Permission.node.replace(permissionLayer({ assert: () => Effect.void })),
  Global.node.replace(tempGlobalLayer),
  PluginSupervisor.node.replace(shellPluginSupervisor),
  offlineModels,
])

const it = testEffect(layer)
const phasesIt = process.env.PERF_SHELL_PHASES === "1" ? it.live : it.live.skip

const summarise = (values: number[]) => ({
  n: values.length,
  median: values.length ? [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] : NaN,
  min: values.length ? Math.min(...values) : NaN,
  max: values.length ? Math.max(...values) : NaN,
})

const order = ["sh.tool.begin", "sh.beforeSpawn", "sh.handle", "sh.ready", "sh.exit", "sh.drain", "sh.capture.begin", "sh.capture.end", "sh.tool.result"] as const
type Stage = (typeof order)[number]

const mark = (events: ProbeEvent[], stage: Stage) => events.find((event) => event.stage === stage)?.t

const buildTimeline = (events: ProbeEvent[], t0: number, tEnd: number) => {
  const values: Partial<Record<Stage, number>> = {}
  for (const stage of order) values[stage] = mark(events, stage)
  if (order.some((stage) => values[stage] === undefined)) return { valid: false as const, events }
  const at = (stage: Stage) => values[stage] as number
  return {
    valid: true as const,
    offsets: {
      toolBegin: at("sh.tool.begin") - t0,
      beforeSpawn: at("sh.beforeSpawn") - t0,
      handle: at("sh.handle") - t0,
      ready: at("sh.ready") - t0,
      exit: at("sh.exit") - t0,
      drain: at("sh.drain") - t0,
      captureBegin: at("sh.capture.begin") - t0,
      captureEnd: at("sh.capture.end") - t0,
      toolResult: at("sh.tool.result") - t0,
      end: tEnd - t0,
    },
    exclusive: {
      toolEntry: at("sh.tool.begin") - t0,
      createCall: at("sh.beforeSpawn") - at("sh.tool.begin"),
      // Handshake is the spawner API return, not process start.
      spawnerApiReturn: at("sh.handle") - at("sh.beforeSpawn"),
      createToReady: at("sh.ready") - at("sh.handle"),
      processExitCallback: at("sh.exit") - at("sh.ready"),
      outputDrain: at("sh.drain") - at("sh.exit"),
      capture: at("sh.capture.end") - at("sh.capture.begin"),
      resultToReturn: at("sh.tool.result") - at("sh.capture.end"),
      tail: tEnd - at("sh.tool.result"),
      total: tEnd - t0,
    },
  }
}

describe("perf shell phases harness", () => {
  phasesIt("measures real shell boundaries and low-level spawns", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      const exeAvailable = fs.existsSync(EXE)
      const repoAvailable = fs.existsSync(path.join(REPO, ".git"))

      const runAsync = <A>(body: () => Promise<A>) => Effect.promise(body)

      const results = yield* Effect.gen(function* () {
        const sessions = yield* Session.Service
        const location = Location.Ref.make({ directory: AbsolutePath.make(tmp.path) })
        yield* sessions.create({ id: sessionID, title: "perf shell phases", location, model: sessionModel })
        const locations = yield* LocationServiceMap.Service
        const locationLayer = locations.get(location)
        return yield* Effect.gen(function* () {
          const plugins = yield* Plugin.Service
          yield* plugins.awaitActivation
          const registry = yield* Tool.Service
          const shellSelect = yield* ShellSelect.Service
          const environment = yield* Environment.Service

          let counter = 0
          const runTool = (command: string, shell: string, workdir?: string) =>
            Effect.gen(function* () {
              yield* shellSelect.transform((editor) => editor.configure(shell))
              const snapshot = yield* registry.snapshot()
              const id = `perf-phase-${++counter}`
              probeReset()
              probe.on = true
              const t0 = performance.now()
              const exit = yield* snapshot
                .execute({
                  sessionID,
                  ...toolIdentity,
                  call: { type: "tool-call", id, name: "shell", input: { command, ...(workdir ? { workdir } : {}) } },
                })
                .pipe(Effect.exit)
              const tEnd = performance.now()
              probe.on = false
              const events = probeDrainEvents()
              if (exit._tag === "Failure") return { valid: false as const, events, total: tEnd - t0, ok: false }
              const result = exit.value
              const text = result.content.flatMap((item) => (item.type === "text" ? [item.text] : [])).join("\n")
              return { ...buildTimeline(events, t0, tEnd), total: tEnd - t0, text, ok: true }
            })

          const bunSpawn = (cmd: string[], cwd: string) =>
            runAsync(async () => {
              const t0 = performance.now()
              const proc = Bun.spawn({ cmd, cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe" })
              const tReturn = performance.now()
              const out = new Response(proc.stdout).text()
              const err = new Response(proc.stderr).text()
              const exit = await proc.exited
              const tExit = performance.now()
              await Promise.all([out, err])
              const tReaders = performance.now()
              return {
                kind: "bunspawn" as const,
                syncReturn: tReturn - t0,
                exitResolved: tExit - t0,
                readersResolved: tReaders - t0,
                total: tReaders - t0,
                exit,
                ok: exit === 0,
              }
            })

          const spawner = (cmd: string[], cwd: string) =>
            Effect.gen(function* () {
              const t0 = performance.now()
              let tHandle = 0
              let tExit = 0
              let tDrain = 0
              const exit = yield* Effect.scoped(
                Effect.gen(function* () {
                  const handle = yield* environment.spawner.spawn(
                    ChildProcess.make(cmd[0], cmd.slice(1), {
                      cwd,
                      env: { ...process.env } as Record<string, string>,
                      stdin: "ignore",
                      forceKillAfter: Duration.seconds(3),
                    }),
                  )
                  tHandle = performance.now()
                  const exitEffect = handle.exitCode.pipe(
                    Effect.map((value) => {
                      tExit = performance.now()
                      return value
                    }),
                  )
                  const drainEffect = handle.all.pipe(
                    Stream.runDrain,
                    Effect.map(() => {
                      tDrain = performance.now()
                    }),
                    Effect.as(undefined),
                  )
                  const values = yield* Effect.all([exitEffect, drainEffect], { concurrency: "unbounded" })
                  return values[0]
                }),
              )
              const total = performance.now() - t0
              return {
                kind: "spawner" as const,
                handleReturn: tHandle - t0,
                exitResolved: tExit - t0,
                drainResolved: tDrain - t0,
                total,
                exit,
                ok: exit === 0,
              }
            })

          const toolSeries: Array<{ name: string; run: () => Effect.Effect<any, any, any> }> = []
          toolSeries.push({ name: "tool.ps.write-output-ok", run: () => runTool("Write-Output ok", "powershell") })
          toolSeries.push({ name: "tool.cmd.echo-ok", run: () => runTool("echo ok", COMSPEC) })
          toolSeries.push({ name: "tool.bash.echo-ok", run: () => runTool("echo ok", GITBASH) })
          if (exeAvailable) toolSeries.push({ name: "tool.ps.exe-via-shell", run: () => runTool(`& '${EXE}'`, "powershell") })
          if (repoAvailable) {
            toolSeries.push({ name: "tool.ps.git-status", run: () => runTool("git status --porcelain", "powershell", REPO) })
            toolSeries.push({ name: "tool.cmd.git-status", run: () => runTool("git status --porcelain", COMSPEC, REPO) })
            toolSeries.push({ name: "tool.bash.git-status", run: () => runTool("git status --porcelain", GITBASH, REPO) })
          }
          toolSeries.push({ name: "tool.ps.rg-needle", run: () => runTool("rg needle sample.txt", "powershell", BENCH) })
          toolSeries.push({ name: "tool.cmd.rg-needle", run: () => runTool("rg needle sample.txt", COMSPEC, BENCH) })
          toolSeries.push({ name: "tool.bash.rg-needle", run: () => runTool("rg needle sample.txt", GITBASH, BENCH) })

          const directSeries: Array<{ name: string; run: () => Effect.Effect<any, any, any> }> = []
          if (exeAvailable) directSeries.push({ name: "bunspawn.exe", run: () => bunSpawn([EXE], BENCH) })
          directSeries.push({ name: "bunspawn.cmd.echo-ok", run: () => bunSpawn(["cmd.exe", "/c", "echo ok"], BENCH) })
          if (repoAvailable) directSeries.push({ name: "bunspawn.git-status", run: () => bunSpawn(["git", "status", "--porcelain"], REPO) })
          directSeries.push({ name: "bunspawn.rg-needle", run: () => bunSpawn(["rg", "needle", "sample.txt"], BENCH) })

          const spawnerSeries: Array<{ name: string; run: () => Effect.Effect<any, any, any> }> = []
          if (exeAvailable) spawnerSeries.push({ name: "spawner.exe", run: () => spawner([EXE], BENCH) })
          if (repoAvailable) spawnerSeries.push({ name: "spawner.git-status", run: () => spawner(["git", "status", "--porcelain"], REPO) })
          spawnerSeries.push({ name: "spawner.rg-needle", run: () => spawner(["rg", "needle", "sample.txt"], BENCH) })

          const warmups = 3
          const reps = 20
          const output: Record<string, unknown> = {}

          for (const entry of toolSeries) {
            for (let i = 0; i < warmups; i++) yield* entry.run().pipe(Effect.orDie)
            const samples: any[] = []
            for (let i = 0; i < reps; i++) samples.push(yield* entry.run().pipe(Effect.orDie))
            const valid = samples.filter((s) => s.valid)
            const offsets = Object.fromEntries(
              Object.keys(valid[0]?.offsets ?? {}).map((key) => [key, summarise(valid.map((s) => s.offsets[key]))]),
            )
            const exclusive = Object.fromEntries(
              Object.keys(valid[0]?.exclusive ?? {}).map((key) => [
                key,
                summarise(valid.map((s) => s.exclusive[key]).filter((v) => Number.isFinite(v) && v >= 0)),
              ]),
            )
            output[entry.name] = {
              kind: "tool",
              validSamples: valid.length,
              invalidSamples: samples.length - valid.length,
              offsetsFromStart: offsets,
              exclusiveComponents: exclusive,
              total: summarise(samples.map((s) => s.total)),
              firstText: samples[0]?.text?.slice(0, 80),
              allOk: samples.every((s) => s.ok),
              rawOffsets: valid.slice(0, 5).map((s) => s.offsets),
              samples: samples.map((s) => Number(s.total.toFixed(3))),
            }
          }

          for (const entry of directSeries) {
            for (let i = 0; i < warmups; i++) yield* entry.run().pipe(Effect.orDie)
            const samples: any[] = []
            for (let i = 0; i < reps; i++) samples.push(yield* entry.run().pipe(Effect.orDie))
            output[entry.name] = {
              kind: "bunspawn",
              syncReturn: summarise(samples.map((s) => s.syncReturn)),
              exitResolved: summarise(samples.map((s) => s.exitResolved)),
              readersResolved: summarise(samples.map((s) => s.readersResolved)),
              total: summarise(samples.map((s) => s.total)),
              exits: [...new Set(samples.map((s) => s.exit))],
              allOk: samples.every((s) => s.ok),
              samples: samples.map((s) => Number(s.total.toFixed(3))),
              raw: samples.slice(0, 5).map((s) => ({
                syncReturn: Number(s.syncReturn.toFixed(3)),
                exitResolved: Number(s.exitResolved.toFixed(3)),
                readersResolved: Number(s.readersResolved.toFixed(3)),
              })),
            }
          }

          for (const entry of spawnerSeries) {
            for (let i = 0; i < warmups; i++) yield* entry.run().pipe(Effect.orDie)
            const samples: any[] = []
            for (let i = 0; i < reps; i++) samples.push(yield* entry.run().pipe(Effect.orDie))
            output[entry.name] = {
              kind: "spawner",
              handleReturn: summarise(samples.map((s) => s.handleReturn)),
              exitResolved: summarise(samples.map((s) => s.exitResolved)),
              drainResolved: summarise(samples.map((s) => s.drainResolved)),
              total: summarise(samples.map((s) => s.total)),
              exits: [...new Set(samples.map((s) => s.exit))],
              allOk: samples.every((s) => s.ok),
              samples: samples.map((s) => Number(s.total.toFixed(3))),
              raw: samples.slice(0, 5).map((s) => ({
                handleReturn: Number(s.handleReturn.toFixed(3)),
                exitResolved: Number(s.exitResolved.toFixed(3)),
                drainResolved: Number(s.drainResolved.toFixed(3)),
              })),
            }
          }

          return {
            generatedAt: new Date().toISOString(),
            platform: process.platform,
            runtimes: { bun: Bun.version },
            powerShell: "Windows PowerShell 5.1",
            repeats: reps,
            warmups,
            notes: [
              "Tool sub-phases use temporary probe marks in src/shell.ts and tool/plugin/shell.ts, reverted after the run; they are real boundary marks, not bus-event reception.",
              "'spawnerApiReturn' is the Environment.spawner.spawn API return (handle), NOT process start; 'processExitCallback' is when the child exit callback runs; 'outputDrain' is when the output stream ends; 'capture' is shell.result reading the output file. Some of these can overlap (exit vs drain) and must not be summed blindly.",
              "Bun.spawn and Environment.spawner marks are taken exactly in the harness (sync return, exitCode, stdout/stderr readers / stream drain).",
              "Tool.Snapshot.execute shell always uses a shell interpreter (ShellSelect.args: '/c' or '-NoLogo -NoProfile -NonInteractive -Command'); there is no tool-level direct exec. 'shell->exe' is PowerShell invoking the exe.",
              "tool.bash.* uses the Git Bash path (bash.exe -c) as the aligned default; compare against tool.ps.* (Windows PowerShell 5.1) and tool.cmd.* (cmd /c).",
            ],
            output,
          }
        }).pipe(Effect.provide(locationLayer), Effect.ensuring(locations.invalidate(location)))
      })

      yield* Effect.promise(() =>
        Bun.write(path.join(import.meta.dir, "perf-shell-phases.results.json"), JSON.stringify(results, null, 2)),
      )
      console.log("PERF_SHELL_PHASES_RESULTS " + JSON.stringify(results))
      expect(Object.keys(results.output).length).toBeGreaterThan(0)
    }),
  )
})
