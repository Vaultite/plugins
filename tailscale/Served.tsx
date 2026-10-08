// What a machine serves on the tailnet (GET /api/tailscale/services; another's through Machines: `machine:`), and the
// tailnet's devices, each with what it serves.
import { ArrowUpRight, Laptop, Network, Server, Smartphone, Tablet } from "lucide-react"
import { type BlockCtx, Empty, fmtAgo, List, Loading, machinePath, Panel, Row, useLive, useMachines, type Machine } from "@vaultite"

export type Service = { url: string; port: number; backend: string; up: boolean | null; title: string; label: string; note: string }
export type Device = { name: string; dns: string; os: string; online: boolean; self: boolean; lastSeen: string | null
  ips: string[]; tags: string[]; exitNode: boolean; owner: string }

function ServiceRows({ rows }: { rows: Service[] }) {
  return (
    <List>
      {rows.map((r) => (
        <Row key={r.url} href={r.url} data-service={r.port} title={<span className="font-semibold">{r.label || r.backend}</span>}
          lead={<span className="size-2 shrink-0 rounded-full" style={{ background: r.up ? "var(--green)" : r.up === false ? "var(--red)" : "var(--gray)" }}
            data-tip={r.up ? "Up" : "Not responding"} />}
          meta={[r.note, `:${r.port}`, r.up === false && "not responding"].filter(Boolean).join(" · ")}
          right={<ArrowUpRight className="size-4 text-primary" />} />
      ))}
    </List>
  )
}

/** ```block-tailscale: what this machine serves (`machine: <id>`: another one's). */
export function Served({ options = {} }: Partial<BlockCtx>) {
  const machine = typeof options.machine === "string" ? options.machine : ""
  const list = useMachines()
  const m = machine ? list?.find((x) => x.id === machine) : null
  const { data, error } = useLive<Service[]>(machinePath(m && !m.self ? machine : "", "tailscale/services"))
  const rows = error ? [] : data
  return (
    <Panel title={m && !m.self ? `On the tailnet, from ${m.label}` : "On the tailnet"} icon={Network} tint="var(--indigo)">
      {!rows ? <Loading /> : !rows.length
        ? <Empty>{error && machine ? `${m?.label ?? machine} isn't answering.` : "Nothing is served right now."}</Empty> : <ServiceRows rows={rows} />}
    </Panel>
  )
}

const iconOf = (d: Device) => (d.os === "iOS" ? Smartphone : d.os === "android" ? Tablet : d.os === "linux" ? Server : Laptop)
const host = (u: string) => { try { return new URL(u).hostname.toLowerCase() } catch { return "" } }

/** A machine's services, under its device. */
function MachineServices({ m }: { m: Machine }) {
  const { data } = useLive<Service[]>(m.online && (m.self || m.plugins?.includes("tailscale")) ? machinePath(m.self ? "" : m.id, "tailscale/services") : null)
  if (!data?.length) return null
  return <div className="ml-7 border-l border-border pl-3"><ServiceRows rows={data} /></div>
}

/** ```block-tailnet: every device on the tailnet; the ones that are machines (Machines plugin) with what they serve. */
export function Tailnet() {
  const { data, error } = useLive<Device[]>("tailscale/devices")
  const machines = useMachines() ?? []
  const machineOf = (d: Device) => machines.find((m) => host(m.url) === d.dns.toLowerCase()) ?? (d.self ? machines.find((m) => m.self) : undefined)
  return (
    <Panel title="Tailnet" icon={Network} tint="var(--indigo)"
      action={data && <span className="text-[13px] text-muted-foreground">{data.filter((d) => d.online).length} of {data.length} online</span>}>
      {!data ? <Loading error={error && "Couldn't ask Tailscale."} /> : !data.length ? <Empty>No devices.</Empty> : (
        <List>
          {data.map((d) => {
            const Icon = iconOf(d), m = machineOf(d)
            return (
              <div key={d.dns || d.name} data-device={d.name}>
                <Row lead={<Icon className="size-4 shrink-0" style={{ color: d.online ? "var(--green)" : "var(--gray)" }} strokeWidth={2} />}
                  title={<><span className="font-semibold">{m?.label ?? d.name}</span>{d.self && <span className="ml-1.5 text-[13px] text-muted-foreground">this one</span>}</>}
                  meta={[d.os, d.online ? "online" : d.lastSeen ? `seen ${fmtAgo(d.lastSeen)}` : "offline", m && d.name !== m.label && d.name, ...d.tags].filter(Boolean).join(" · ")} />
                {m && <MachineServices m={m} />}
              </div>
            )
          })}
        </List>
      )}
    </Panel>
  )
}
