import { describe, expect, test } from "bun:test"
import { Effect, Schema } from "effect"
import { CodeMode, Tool } from "../src/index.js"

// Constructs a model reaches for out of habit. Each diagnostic should name the missing capability or the
// replacement, so the next attempt self-corrects instead of re-reading the support matrix.
const tools = {
  echo: Tool.make({
    description: "Echo",
    input: Schema.Struct({}),
    output: Schema.Struct({}),
    execute: () => Effect.succeed({}),
  }),
}
const error = async (code: string) => {
  const result = await Effect.runPromise(CodeMode.execute({ code, tools }))
  if (result.ok) throw new Error(`expected failure, got value ${JSON.stringify(result.value)}`)
  return result.error
}

describe("unsupported syntax diagnostics", () => {
  test("dynamic import names the missing modules and filesystem", async () => {
    const failure = await error(`const fs = await import("node:fs"); return fs`)
    expect(failure.kind).toBe("UnsupportedSyntax")
    expect(failure.message).toStartWith("SyntaxError: Syntax 'ImportExpression' is not supported.")
    expect(failure.message).toContain("There are no modules and no filesystem here")
  })

  test("classes point at plain functions and objects", async () => {
    const failure = await error(`class A {}; return new A()`)
    expect(failure.kind).toBe("UnsupportedSyntax")
    expect(failure.message).toStartWith("SyntaxError: Syntax 'ClassDeclaration' is not supported. Use plain functions")
  })

  test("a class expression gets the same guidance", async () => {
    const failure = await error(`return class {}`)
    expect(failure.kind).toBe("UnsupportedSyntax")
    expect(failure.message).toContain("Use plain functions")
  })

  test("object accessors name getters and setters", async () => {
    const getter = await error(`const o = { get x() { return 1 } }; return o.x`)
    expect(getter.message).toStartWith(
      "TypeError: Getters are not supported; use a plain data property or a function property instead.",
    )
    const setter = await error(`const o = { set x(v) {} }`)
    expect(setter.message).toContain("Setters are not supported")
  })

  test("node module globals name the missing module system", async () => {
    const requireFailure = await error(`return require("node:fs")`)
    expect(requireFailure.message).toContain("'require' is not available: there are no modules here")
    const exportsFailure = await error(`return module.exports`)
    expect(exportsFailure.message).toContain("'module' is not available: there are no modules here")
  })

  test("a plain unknown identifier points at the tool path", async () => {
    const failure = await error(`return consle.log("x")`)
    expect(failure.message).toContain("Unknown identifier 'consle'")
    expect(failure.message).toContain("'tools.<namespace>.<tool>'")
  })
})
