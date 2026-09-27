import { expect, test } from "bun:test"
import { destroyRenderer } from "../../src/util/renderer"

function quiet(run: () => void) {
  const original = process.stdout.write
  process.stdout.write = (() => true) as typeof process.stdout.write
  try {
    run()
  } finally {
    process.stdout.write = original
  }
}

test("clears the terminal title before destroying the renderer", () => {
  const calls: string[] = []
  quiet(() =>
    destroyRenderer({
      isDestroyed: false,
      useMouse: false,
      setTerminalTitle(title) {
        calls.push(`title:${title}`)
      },
      destroy() {
        calls.push("destroy")
      },
    }),
  )
  expect(calls).toEqual(["title:", "destroy"])
})

test("still clears the title after renderer destruction", () => {
  const calls: string[] = []
  quiet(() =>
    destroyRenderer({
      isDestroyed: true,
      useMouse: false,
      setTerminalTitle(title) {
        calls.push(`title:${title}`)
      },
      destroy() {
        calls.push("destroy")
      },
    }),
  )
  expect(calls).toEqual(["title:"])
})

test("disables mouse tracking before destroying an active renderer", () => {
  const calls: string[] = []
  let mouse = true
  quiet(() =>
    destroyRenderer({
      isDestroyed: false,
      get useMouse() {
        return mouse
      },
      set useMouse(value) {
        mouse = value
        calls.push("disableMouse")
      },
      setTerminalTitle(title) {
        calls.push(`title:${title}`)
      },
      destroy() {
        calls.push("destroy")
      },
    }),
  )
  expect(calls).toEqual(["title:", "disableMouse", "destroy"])
})
