import type { CliRenderer } from "@opentui/core"
import { win32FlushInputBuffer } from "../terminal-win32"

// Terminal modes the renderer's native core turns on: legacy + SGR mouse
// tracking, bracketed paste, and focus reporting. Its shutdown path can be
// skipped (hard exit, crash, destroy-during-render race), which leaves the
// shell prompt echoing raw mouse reports as text. Emit the disables ourselves
// so restoring the terminal never depends on the renderer's teardown.
const disableTerminalModes = "\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?1015l\x1b[?2004l\x1b[?1004l"

export function restoreTerminalModes() {
  process.stdout.write(disableTerminalModes)
  win32FlushInputBuffer()
}

export function destroyRenderer(renderer: Pick<CliRenderer, "isDestroyed" | "setTerminalTitle" | "useMouse" | "destroy">) {
  renderer.setTerminalTitle("")
  if (renderer.isDestroyed) return
  if (renderer.useMouse) renderer.useMouse = false
  renderer.destroy()
  restoreTerminalModes()
}
