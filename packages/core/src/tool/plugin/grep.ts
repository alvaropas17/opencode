export * as GrepTool from "./grep.js"

import type { Context } from "@opencode/plugin/effect/plugin"
import { ToolFailure } from "@opencode/ai"
import { Effect, Schema } from "effect"
import path from "path"
import { Environment } from "../../environment/index.js"
import { FileSystem } from "../../filesystem.js"
import { Location } from "../../location.js"
import { FileAccess } from "../../file-access.js"
import { Permission } from "../../permission.js"
import { Ripgrep } from "../../ripgrep.js"
import { Tool } from "../../tool.js"
import { RelativePath } from "../../schema.js"

export const name = "grep"

export const Input = Schema.Struct({
  pattern: FileSystem.GrepInput.fields.pattern
    .check(Schema.isMinLength(1, { message: "Pattern must not be empty" }))
    .annotate({
      description: "Regular expression or literal text to match in file contents.",
    }),
  path: Schema.optionalKey(RelativePath).annotate({
    description: "File or directory to search. Defaults to the current working directory.",
  }),
  include: FileSystem.GrepInput.fields.include.annotate({
    description: 'Glob pattern to filter files (for example, "*.js" or "*.{ts,tsx}")',
  }),
  literal: FileSystem.GrepInput.fields.literal.annotate({
    description: "Treat `pattern` as exact text instead of a regular expression (default: false).",
  }),
  caseSensitive: FileSystem.GrepInput.fields.caseSensitive.annotate({
    description: "Use case-sensitive matching (default: true).",
  }),
  limit: FileSystem.GrepInput.fields.limit.annotate({
    description: `Maximum number of matching lines to return (default: ${FileSystem.DEFAULT_SEARCH_LIMIT})`,
  }),
})

export const Output = Schema.Array(FileSystem.Match)
type EncodedOutput = typeof Output.Encoded

/** Experimental opt-in byte budget for grep's model content. Unset keeps the exact baseline output. */
export const OUTPUT_BUDGET_ENV = "OPENCODE_GREP_OUTPUT_MAX_BYTES"

export const outputBudgetBytes = () => {
  const raw = process.env[OUTPUT_BUDGET_ENV]
  if (raw === undefined || raw.trim() === "") return undefined
  const value = Number(raw)
  return Number.isSafeInteger(value) && value > 0 ? value : undefined
}

/** Format raw search matches into concise model content. */
export const toModelContent = (matches: EncodedOutput, truncated = false, total?: number) => {
  const partial = total !== undefined && total !== matches.length
  const lines = partial
    ? [`Found ${matches.length} of ${total} matches`]
    : matches.length === 0
      ? ["No matches found"]
      : [`Found ${matches.length} matches`]
  let current = ""
  for (const match of matches) {
    if (current !== match.entry.path) {
      if (current) lines.push("")
      current = match.entry.path
      lines.push(`${match.entry.path}:`)
    }
    lines.push(`  Line ${match.line}: ${match.text}`)
  }
  if (truncated)
    lines.push(
      "",
      partial
        ? `(Results are truncated: showing first ${matches.length} of ${total} results. Consider refining the pattern, path, or include filter.)`
        : `(Results are truncated: showing first ${matches.length} results. Consider using a more specific path or pattern.)`,
    )
  return lines.join("\n")
}

/**
 * Selects the longest prefix of complete matches whose rendered content fits the UTF-8 budget.
 * Lines are never cut and order is preserved. Without a budget (or when everything fits) the
 * baseline rendering is returned unchanged. A notice is always emitted when matches are omitted.
 * A positive budget smaller than the truthful minimal notice is treated as not enabled (baseline),
 * since no bounded rendering could stay within it without hiding the truncation.
 */
export const boundModelContent = (matches: EncodedOutput, truncated: boolean, budget: number | undefined) => {
  const baseline = toModelContent(matches, truncated)
  const minimum = Buffer.byteLength(toModelContent([], true, matches.length), "utf-8")
  if (budget === undefined || budget < minimum || Buffer.byteLength(baseline, "utf-8") <= budget)
    return { content: baseline, shown: matches.length, truncated }
  for (let shown = matches.length - 1; shown >= 0; shown--) {
    const content = toModelContent(matches.slice(0, shown), true, matches.length)
    if (Buffer.byteLength(content, "utf-8") <= budget) return { content, shown, truncated: true }
  }
  return { content: toModelContent([], true, matches.length), shown: 0, truncated: true }
}

/** Grep leaf that defaults its filesystem root to the active Location. */
export const Plugin = {
  id: "opencode.tool.grep",
  effect: Effect.fn("GrepTool.Plugin")(function* (ctx: Context) {
    const environment = yield* Environment.Service
    const ripgrep = yield* Ripgrep.Service
    const location = yield* Location.Service
    const access = yield* FileAccess.Service
    const permission = yield* Permission.Service

    const search = (input: typeof Input.Type, context: Tool.Context) =>
      Effect.gen(function* () {
        const source = { type: "tool" as const, messageID: context.messageID, id: context.id }
        const target = yield* access.resolve({ path: input.path ?? "." })
        yield* access.authorizeExternal([target], context)
        yield* permission.assert({
          action: name,
          resources: [input.pattern],
          save: ["*"],
          metadata: {
            root: ".",
            path: input.path,
            include: input.include,
            literal: input.literal,
            caseSensitive: input.caseSensitive,
            limit: input.limit,
          },
          sessionID: context.sessionID,
          agent: context.agent,
          source,
        })
        const root = target.absolute
        const type = yield* Environment.typeFollowing(environment.files, root).pipe(
          Effect.catchTag("Environment.NotFound", () =>
            Effect.fail(new ToolFailure({ message: `Search path does not exist: ${input.path ?? "."}` })),
          ),
        )
        const cwd = type === "directory" ? root : path.dirname(root)
        const limit = input.limit ?? FileSystem.DEFAULT_SEARCH_LIMIT
        const matches = yield* ripgrep
          .grep({
            cwd,
            pattern: input.pattern,
            file: type === "file" ? path.basename(root) : undefined,
            include: input.include,
            literal: input.literal,
            caseSensitive: input.caseSensitive,
            limit: limit + 1,
          })
          .pipe(
            Effect.timeoutOrElse({
              duration: FileSystem.DEFAULT_SEARCH_TIMEOUT_MS,
              orElse: () =>
                Effect.fail(
                  new ToolFailure({
                    message: `Search timed out after ${FileSystem.DEFAULT_SEARCH_TIMEOUT_MS / 1_000} seconds. Consider using a more specific path or pattern.`,
                  }),
                ),
            }),
            Effect.map((result) =>
              result.map((match) =>
                FileSystem.Match.make({
                  ...match,
                  entry: FileSystem.Entry.make({
                    ...match.entry,
                    path: RelativePath.make(path.relative(location.directory, path.resolve(cwd, match.entry.path))),
                  }),
                }),
              ),
            ),
          )
        return { matches: matches.slice(0, limit), truncated: matches.length > limit }
      }).pipe(
        Effect.mapError((error) =>
          error instanceof ToolFailure
            ? error
            : error instanceof Ripgrep.InvalidPatternError
              ? new ToolFailure({ message: `Invalid regex pattern: ${error.message}` })
              : new ToolFailure({ message: `Unable to grep for ${input.pattern}`, error }),
        ),
      )

    yield* ctx.tool
      .transform((editor) => {
        editor.add({
          name,
          options: { codemode: false },
          description:
            "Search file contents using ripgrep's regular expression syntax or literal text matching. Use it to locate specific code, symbols, or text patterns, and narrow searches with `path` or `include`. Returns matching file paths, line numbers, and line previews.",
          input: Input,
          output: Output,
          execute: (input, context) =>
            search(input, context).pipe(
              Effect.map((result) => {
                const bounded = boundModelContent(
                  result.matches.map((match) => ({
                    ...match,
                    entry: { ...match.entry, path: path.resolve(location.directory, match.entry.path) },
                  })),
                  result.truncated,
                  outputBudgetBytes(),
                )
                return {
                  output:
                    bounded.shown === result.matches.length ? result.matches : result.matches.slice(0, bounded.shown),
                  content: bounded.content,
                  metadata: { matches: bounded.shown, truncated: bounded.truncated },
                }
              }),
            ),
        })
        editor.add({
          name: "fs_search",
          options: { namespace: "opencode", codemode: true, permission: "grep" },
          description:
            "Search file contents as compact JSON inside execute. Filter matches in the program and return only the relevant summary.",
          input: Schema.Struct({
            ...Input.fields,
            limit: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 50 }))),
            maxChars: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 20, maximum: 1000 }))),
          }),
          output: Schema.Struct({
            matches: Schema.Array(
              Schema.Struct({ path: Schema.String, line: Schema.Int, text: Schema.String, truncated: Schema.Boolean }),
            ),
            count: Schema.Int,
            truncated: Schema.Boolean,
          }),
          execute: (input, context) =>
            search({ ...input, limit: input.limit ?? 10 }, context).pipe(
              Effect.map((result) => {
                const matches = result.matches.map((match) => {
                  const chars = Array.from(match.text)
                  return {
                    path: match.entry.path,
                    line: match.line,
                    text: chars.slice(0, input.maxChars ?? 200).join(""),
                    truncated: chars.length > (input.maxChars ?? 200),
                  }
                })
                return { output: { matches, count: matches.length, truncated: result.truncated } }
              }),
            ),
        })
      })
      .pipe(Effect.orDie)
  }),
}
