// Measurement probe sink for the perf harnesses (lives in test/, never in src).
export type ProbeEvent = { stage: string; t: number }

export const probe = {
  on: false,
  buckets: new Map<string, number[]>(),
  events: [] as ProbeEvent[],
}

export const probeNow = () => performance.now()

export const probeRec = (stage: string, started: number) => {
  if (!probe.on) return
  const values = probe.buckets.get(stage)
  if (values) values.push(performance.now() - started)
  else probe.buckets.set(stage, [performance.now() - started])
}

export const probeMark = (stage: string) => {
  if (!probe.on) return
  probe.events.push({ stage, t: performance.now() })
}

export const probeReset = () => {
  probe.buckets.clear()
  probe.events.length = 0
}

export type ProbeDrain = Record<string, number[]>

export const probeDrain = (): ProbeDrain => {
  const out: ProbeDrain = {}
  for (const [stage, values] of probe.buckets) out[stage] = [...values]
  probe.buckets.clear()
  return out
}

export const probeDrainEvents = (): ProbeEvent[] => {
  const out = [...probe.events]
  probe.events.length = 0
  return out
}
