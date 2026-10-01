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
import { Shell as ShellSchema } from "@opencode/schema/shell"
import { ShellTool } from "@opencode/core/tool/plugin/shell"
import { Tool } from "@opencode/core/tool"
import { tmpdirScoped } from "./fixture/tmpdir"
import { tempGlobalLayer } from "./fixture/global"
import { offlineModels } from "./fixture/models"
import { testEffect } from "./lib/effect"
import { permissionLayer } from "./lib/permission"
import { toolIdentity, registerToolPlugin } from "./lib/tool"

setDefaultTimeout(600_000)

// Isolated shell-path benchmark. Skipped unless PERF_SHELL_BENCH=1.
// No src/productivo is modified: production shell runs through the real plugin and
// Service shell; sub-phases come from the public ephemeral shell events + monotonic
// performance.now. Native helper exes are compiled with gcc outside the repo.
const BENCH = path.join(process.env.TEMP ?? process.env.TMP ?? ".", "opencode", "shell-bench")
const EXE = path.join(BENCH, "ok.exe")
const IPC_EXE = path.join(BENCH, "echoipc.exe")
const REPO = path.join(BENCH, "repo")
const SAMPLE = path.join(BENCH, "sample.txt")
const COMSPEC = process.env.COMSPEC ?? "C:\\WINDOWS\\system32\\cmd.exe"
const GITBASH = ShellSelect.gitbash() ?? "C:\\Program Files\\Git\\bin\\bash.exe"

const sessionID = Session.ID.make("ses_perf_shell")
const sessionModel = Model.Ref.make({ id: Model.ID.make("test"), providerID: Provider.ID.make("test") })

const executionNode = makeGlobalNode({
  service: SessionExecution.Service,
  layer: Layer.effect(
    SessionExecution.Service,
    Effect.gen(function* () {
      const store = yield* SessionStore.Service
      const complete = Effect.fn("PerfShell.complete")(function* (id: Session.ID) {
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
  name: "test/perf-shell-plugins",
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
const benchIt = process.env.PERF_SHELL_BENCH === "1" ? it.live : it.live.skip

type PhaseSample = { kind: "tool"; totalMs: number; handshakeMs: number; processMs: number; captureMs: number; exit?: number; text: string; ok: boolean }
type SpawnSample = { kind: "spawn"; totalMs: number; exit: number; stdout: string; stderr: string; ok: boolean }
type SpawnerSample = { kind: "spawner"; totalMs: number; handshakeMs: number; processMs: number; exit: number; ok: boolean }

const summarise = (values: number[]) => ({
  n: values.length,
  median: values.length ? [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] : NaN,
  min: values.length ? Math.min(...values) : NaN,
  max: values.length ? Math.max(...values) : NaN,
})

const withSession = <A, E, R>(directory: string, body: (s: { registry: Tool.Interface; bus: Bus.Interface; shellSelect: ShellSelect.Interface }) => Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const location = Location.Ref.make({ directory: AbsolutePath.make(directory) })
    yield* sessions.create({ id: sessionID, title: "perf shell", location, model: sessionModel })
    const locations = yield* LocationServiceMap.Service
    const locationLayer = locations.get(location)
    return yield* Effect.gen(function* () {
      const plugins = yield* Plugin.Service
      yield* plugins.awaitActivation
      const registry = yield* Tool.Service
      const bus = yield* Bus.Service
      const shellSelect = yield* ShellSelect.Service
      return yield* body({ registry, bus, shellSelect })
    }).pipe(Effect.provide(locationLayer), Effect.ensuring(locations.invalidate(location)))
  })

const runSpawn = async (cmd: string[], cwd: string): Promise<SpawnSample> => {
  const started = performance.now()
  const proc = Bun.spawn({ cmd, cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe" })
  const stdoutPromise = new Response(proc.stdout).text()
  const stderrPromise = new Response(proc.stderr).text()
  const exit = await proc.exited
  const stdout = await stdoutPromise
  const stderr = await stderrPromise
  return { kind: "spawn", totalMs: performance.now() - started, exit, stdout, stderr, ok: exit === 0 }
}

const runSpawner = (cmd: string[], cwd: string) =>
  Effect.gen(function* () {
    const environment = yield* Environment.Service
    const started = performance.now()
    return yield* Effect.scoped(
      Effect.gen(function* () {
        const handle = yield* environment.spawner.spawn(
          ChildProcess.make(cmd[0], cmd.slice(1), {
            cwd,
            env: { ...process.env } as Record<string, string>,
            stdin: "ignore",
            forceKillAfter: Duration.seconds(3),
          }),
        )
        const spawned = performance.now()
        const [, exit] = yield* Effect.all(
          [handle.all.pipe(Stream.runDrain, Effect.as(undefined)), handle.exitCode],
          { concurrency: "unbounded" },
        )
        const ended = performance.now()
        return {
          kind: "spawner",
          totalMs: ended - started,
          handshakeMs: spawned - started,
          processMs: ended - spawned,
          exit,
          ok: exit === 0,
        } satisfies SpawnerSample
      }),
    )
  })

describe("perf shell paths harness", () => {
  benchIt("measures shell paths and real commands", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      const exeAvailable = fs.existsSync(EXE)
      const ipcAvailable = fs.existsSync(IPC_EXE)
      const repoAvailable = fs.existsSync(path.join(REPO, ".git"))

      const results = yield* withSession(tmp.path, ({ registry, bus, shellSelect }) =>
        Effect.gen(function* () {
          const created: Array<{ t: number; id: string }> = []
          const exited: Array<{ t: number; id: string }> = []
          yield* bus.subscribe([ShellSchema.Event.Created, ShellSchema.Event.Exited]).pipe(
            Stream.runForEach((event) =>
              Effect.sync(() => {
                const t = performance.now()
                if (event.type === "shell.created") created.push({ t, id: event.data.info.id })
                else exited.push({ t, id: event.data.id })
              }),
            ),
            Effect.forkScoped({ startImmediately: true }),
          )

          let counter = 0
          const runTool = (command: string, opts: { shell?: string; workdir?: string } = {}) =>
            Effect.gen(function* () {
              if (opts.shell) yield* shellSelect.transform((editor) => editor.configure(opts.shell!))
              const snapshot = yield* registry.snapshot()
              const id = `perf-${++counter}`
              const input = { command, ...(opts.workdir ? { workdir: opts.workdir } : {}) }
              const createdBefore = created.length
              const exitedBefore = exited.length
              const started = performance.now()
              const exit = yield* snapshot
                .execute({ sessionID, ...toolIdentity, call: { type: "tool-call", id, name: "shell", input } })
                .pipe(Effect.exit)
              const totalMs = performance.now() - started
              if (exit._tag === "Failure") {
                return { kind: "tool", totalMs, handshakeMs: NaN, processMs: NaN, captureMs: NaN, text: `FAILURE:${exit.cause}`, ok: false } satisfies PhaseSample
              }
              const result = exit.value
              // Ephemeral events are delivered through the bus asynchronously; wait briefly for
              // this run's created/exited marks. Delivery is FIFO per subscriber, so the entries
              // at the recorded indices belong to this run once present.
              for (let i = 0; i < 100 && !(created.length > createdBefore && exited.length > exitedBefore); i++) {
                yield* Effect.sleep("1 millis")
              }
              const createdMark = created.length > createdBefore ? created[createdBefore] : undefined
              const exitedMark = exited.length > exitedBefore ? exited[exitedBefore] : undefined
              const validPhase = Boolean(createdMark && exitedMark && createdMark.t <= exitedMark.t)
              const handshakeMs = validPhase ? createdMark!.t - started : NaN
              const processMs = validPhase ? exitedMark!.t - createdMark!.t : NaN
              const captureMs = validPhase ? totalMs - (exitedMark!.t - started) : NaN
              const text = result.content.flatMap((item) => (item.type === "text" ? [item.text] : [])).join("\n")
              return {
                kind: "tool",
                totalMs,
                handshakeMs,
                processMs,
                captureMs,
                exit: (result.output as { exit?: number } | undefined)?.exit,
                text,
                ok: true,
              } satisfies PhaseSample
            })

          const warmups = 3
          const reps = 20

          const series: Array<{ name: string; run: () => Effect.Effect<any, any, any> }> = []
          const tool = (name: string, command: string, opts?: { shell?: string; workdir?: string }) =>
            series.push({ name, run: () => runTool(command, opts) })
          const bunspawn = (name: string, cmd: string[], cwd: string) =>
            series.push({ name, run: () => Effect.promise(() => runSpawn(cmd, cwd)) })
          const spawner = (name: string, cmd: string[], cwd: string) =>
            series.push({ name, run: () => runSpawner(cmd, cwd) })

          tool("tool.ps.write-output-ok", "Write-Output ok", { shell: "powershell" })
          tool("tool.cmd.echo-ok", "echo ok", { shell: COMSPEC })
          tool("tool.bash.echo-ok", "echo ok", { shell: GITBASH })
          if (exeAvailable) tool("tool.ps.exe-via-shell", `& '${EXE}'`, { shell: "powershell" })
          if (repoAvailable) {
            tool("tool.ps.git-status", "git status --porcelain", { shell: "powershell", workdir: REPO })
            tool("tool.cmd.git-status", "git status --porcelain", { shell: COMSPEC, workdir: REPO })
            tool("tool.bash.git-status", "git status --porcelain", { shell: GITBASH, workdir: REPO })
            tool("tool.ps.git-rev-parse", "git rev-parse --show-toplevel", { shell: "powershell", workdir: REPO })
            tool("tool.cmd.git-rev-parse", "git rev-parse --show-toplevel", { shell: COMSPEC, workdir: REPO })
            tool("tool.bash.git-rev-parse", "git rev-parse --show-toplevel", { shell: GITBASH, workdir: REPO })
          }
          tool("tool.ps.rg-needle", "rg needle sample.txt", { shell: "powershell", workdir: BENCH })
          tool("tool.cmd.rg-needle", "rg needle sample.txt", { shell: COMSPEC, workdir: BENCH })
          tool("tool.bash.rg-needle", "rg needle sample.txt", { shell: GITBASH, workdir: BENCH })
          tool("tool.ps.bun-version", "bun --version", { shell: "powershell", workdir: BENCH })
          tool("tool.cmd.bun-version", "bun --version", { shell: COMSPEC, workdir: BENCH })
          tool("tool.bash.bun-version", "bun --version", { shell: GITBASH, workdir: BENCH })

          if (exeAvailable) bunspawn("bunspawn.exe", [EXE], BENCH)
          bunspawn("bunspawn.cmd.echo-ok", ["cmd.exe", "/c", "echo ok"], BENCH)
          if (repoAvailable) {
            bunspawn("bunspawn.git-status", ["git", "status", "--porcelain"], REPO)
            bunspawn("bunspawn.git-rev-parse", ["git", "rev-parse", "--show-toplevel"], REPO)
          }
          bunspawn("bunspawn.rg-needle", ["rg", "needle", "sample.txt"], BENCH)
          bunspawn("bunspawn.bun-version", ["bun", "--version"], BENCH)

          // OpenCode low-level spawner (Environment.spawner, the one Shell.Service uses) with no shell wrapper.
          if (exeAvailable) spawner("spawner.exe", [EXE], BENCH)
          if (repoAvailable) {
            spawner("spawner.git-status", ["git", "status", "--porcelain"], REPO)
            spawner("spawner.git-rev-parse", ["git", "rev-parse", "--show-toplevel"], REPO)
          }
          spawner("spawner.rg-needle", ["rg", "needle", "sample.txt"], BENCH)
          spawner("spawner.bun-version", ["bun", "--version"], BENCH)

          const output: Record<string, unknown> = {}
          for (const entry of series) {
            for (let i = 0; i < warmups; i++) yield* entry.run().pipe(Effect.orDie)
            const samples: unknown[] = []
            for (let i = 0; i < reps; i++) samples.push(yield* entry.run().pipe(Effect.orDie))
            const phaseSamples = samples as PhaseSample[]
            const spawnSamples = samples as SpawnSample[]
            const spawnerSamples = samples as SpawnerSample[]
            const kind = (samples[0] as { kind?: string } | undefined)?.kind ?? "spawn"
            output[entry.name] =
              kind === "tool"
                ? {
                    kind: "tool",
                    total: summarise(phaseSamples.map((s) => s.totalMs)),
                    handshake: summarise(phaseSamples.map((s) => s.handshakeMs).filter((v) => !Number.isNaN(v))),
                    process: summarise(phaseSamples.map((s) => s.processMs).filter((v) => !Number.isNaN(v))),
                    capture: summarise(phaseSamples.map((s) => s.captureMs).filter((v) => !Number.isNaN(v))),
                    exits: [...new Set(phaseSamples.map((s) => s.exit))],
                    firstText: phaseSamples[0]?.text?.slice(0, 120),
                    allOk: phaseSamples.every((s) => s.ok),
                    samples: phaseSamples.map((s) => Number(s.totalMs.toFixed(3))),
                  }
                : kind === "spawner"
                  ? {
                      kind: "spawner",
                      total: summarise(spawnerSamples.map((s) => s.totalMs)),
                      handshake: summarise(spawnerSamples.map((s) => s.handshakeMs)),
                      process: summarise(spawnerSamples.map((s) => s.processMs)),
                      exits: [...new Set(spawnerSamples.map((s) => s.exit))],
                      allOk: spawnerSamples.every((s) => s.ok),
                      samples: spawnerSamples.map((s) => Number(s.totalMs.toFixed(3))),
                    }
                  : {
                      kind: "spawn",
                      total: summarise(spawnSamples.map((s) => s.totalMs)),
                      exits: [...new Set(spawnSamples.map((s) => s.exit))],
                      firstStdout: spawnSamples[0]?.stdout?.slice(0, 120),
                      firstStderr: spawnSamples[0]?.stderr?.slice(0, 120),
                      allOk: spawnSamples.every((s) => s.ok),
                      samples: spawnSamples.map((s) => Number(s.totalMs.toFixed(3))),
                    }
          }

          // Persistent IPC round-trip against the native helper.
          if (ipcAvailable) {
            const ipc = yield* Effect.promise(async () => {
              const proc = Bun.spawn({ cmd: [IPC_EXE], stdin: "pipe", stdout: "pipe", stderr: "pipe" })
              const writer = proc.stdin
              const reader = proc.stdout.getReader()
              const decoder = new TextDecoder()
              const roundtrip = async () => {
                const started = performance.now()
                writer.write("ping\n")
                await writer.flush()
                let buffer = ""
                while (!buffer.includes("\n")) {
                  const chunk = await reader.read()
                  if (chunk.done) break
                  buffer += decoder.decode(chunk.value, { stream: true })
                }
                return { ms: performance.now() - started, text: buffer }
              }
              for (let i = 0; i < 3; i++) await roundtrip()
              const samples: Array<{ ms: number; text: string }> = []
              for (let i = 0; i < 20; i++) samples.push(await roundtrip())
              proc.kill()
              return { samples, firstText: samples[0]?.text }
            })
            output["ipc.roundtrip"] = {
              kind: "ipc",
              total: summarise(ipc.samples.map((s) => s.ms)),
              firstText: ipc.firstText,
              allOk: ipc.samples.every((s) => s.text.includes("ok")),
              samples: ipc.samples.map((s) => Number(s.ms.toFixed(4))),
            }
          } else {
            output["ipc.roundtrip"] = { kind: "ipc", status: "N/D", reason: "echoipc.exe not found" }
          }

          return {
            generatedAt: new Date().toISOString(),
            platform: process.platform,
            runtimes: { bun: Bun.version },
            powerShell: "Windows PowerShell 5.1",
            repeats: reps,
            warmups,
            notes: [
              "Native helper compiled with gcc (MinGW UCRT) in the OS temp dir; not a Bun script.",
              "Every Tool.Snapshot.execute shell call always goes through a shell process: ShellSelect.args adds '/c' for cmd and '-NoLogo -NoProfile -NonInteractive -Command' for PowerShell 5.1. There is no 'direct exe' through the tool; the exe cell is shell->exe (PowerShell parses and invokes it).",
              "PowerShell runs with -NoProfile already, so its ~135-160ms is not profile overhead.",
              "tool.bash.* uses the Git Bash path (bash.exe -c) as the aligned default; compare against tool.ps.* (Windows PowerShell 5.1) and tool.cmd.* (cmd /c).",
              "Sub-phases in this harness (handshake/process/capture) are derived from the public ephemeral shell.created/shell.exited events (reception timestamps), correlated by FIFO index, and are approximate. perf-shell-phases.harness.test.ts measures the same paths with temporary real boundary marks and is the reliable source for boundary costs; two capture medians here were slightly negative from event reception lag.",
              "handshake = start..shell.created reception (bus reception, not the spawner API return); process = shell.created..shell.exited reception; capture/wrapper = tool return - shell.exited reception.",
              "Three low levels are separated: tool.* (OpenCode shell tool -> shell process), spawner.* (OpenCode Environment.spawner, the ChildProcessSpawner Shell.Service uses, no shell), bunspawn.* (Bun.spawn, OS-level, no shell).",
              "Tool cases merge stdout+stderr into one output; direct Bun.spawn captures stdout/stderr separately.",
              "bunspawn.cmd.echo-ok is Bun.spawn(['cmd.exe','/c',...]) i.e. still cmd, just without the OpenCode shell wrapper; it is not shell-free.",
            ],
            paths: { bench: BENCH, exe: EXE, ipc: IPC_EXE, repo: REPO, sample: SAMPLE, comspec: COMSPEC, sessionTemp: tmp.path },
            cases: {
              pty: {
                status: "N/D",
                reason:
                  "PersistentPty is a terminal multiplexer (attach/resize/scrollback, daemon + embedded native binary installed into the user's global bin), not an exec-equivalent one-shot command runner; its round-trip semantics are not comparable to the spawn/exec paths measured here. Marked N/D rather than measuring a non-equivalent operation.",
              },
              recon: { status: "N/D", reason: "recon.exe not found via Get-Command; no flags invented." },
              nativeHelper: { available: exeAvailable, compiler: "gcc (MinGW UCRT)", ipcAvailable },
            },
            output,
          }
        }),
      )

      yield* Effect.promise(() =>
        Bun.write(path.join(import.meta.dir, "perf-shell-paths.results.json"), JSON.stringify(results, null, 2)),
      )
      console.log("PERF_SHELL_PATHS_RESULTS " + JSON.stringify(results))
      expect(Object.keys(results.output).length).toBeGreaterThan(0)
    }),
  )
})
