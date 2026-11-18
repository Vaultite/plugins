// Logseq's date formats (date-fns tokens: yyyy, MMM, do, EEEE...), read and written: journal file names and titles.
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"]
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]
const TOKENS = ["yyyy", "yy", "MMMM", "MMM", "MM", "M", "do", "dd", "d", "EEEE", "EEE", "EE", "E"]

type Part = { tok: string } | { lit: string }

function parts(format: string): Part[] {
  const out: Part[] = []
  for (let i = 0; i < format.length;) {
    if (format[i] === "'") {
      const end = format.indexOf("'", i + 1)
      const lit = format.slice(i + 1, end < 0 ? format.length : end)
      out.push({ lit: lit || "'" })
      i = end < 0 ? format.length : end + 1
      continue
    }
    const tok = TOKENS.find((t) => format.startsWith(t, i))
    if (tok) { out.push({ tok }); i += tok.length } else { out.push({ lit: format[i] }); i++ }
  }
  return out
}

const ordinal = (n: number) => {
  const s = n % 100 >= 11 && n % 100 <= 13 ? "th" : ["th", "st", "nd", "rd"][n % 10] ?? "th"
  return `${n}${s}`
}
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
const pad = (n: number, w = 2) => String(n).padStart(w, "0")

const RX: Record<string, string> = {
  yyyy: "(\\d{4})", yy: "(\\d{2})", MMMM: `(${MONTHS.join("|")})`, MMM: `(${MONTHS.map((m) => m.slice(0, 3)).join("|")})`,
  MM: "(\\d{2})", M: "(\\d{1,2})", do: "(\\d{1,2})(?:st|nd|rd|th)", dd: "(\\d{2})", d: "(\\d{1,2})",
  EEEE: `(?:${DAYS.join("|")})`, EEE: `(?:${DAYS.map((d) => d.slice(0, 3)).join("|")})`, EE: `(?:${DAYS.map((d) => d.slice(0, 3)).join("|")})`, E: `(?:${DAYS.map((d) => d.slice(0, 3)).join("|")})`,
}

const readers = new Map<string, (s: string) => string | null>()

/** A YYYY-MM-DD for `text` written in `format` (any case), or null. */
export function readDate(text: string, format: string): string | null {
  let read = readers.get(format)
  if (!read) {
    const ps = parts(format), order: string[] = []
    const src = ps.map((p) => {
      if ("lit" in p) return esc(p.lit)
      if (!RX[p.tok].startsWith("(?:")) order.push(p.tok)
      return RX[p.tok]
    }).join("")
    const rx = new RegExp(`^${src}$`, "i")
    read = (s: string) => {
      const m = rx.exec(s.trim())
      if (!m) return null
      let y = 0, mo = 0, d = 0
      order.forEach((tok, k) => {
        const v = m[k + 1]
        if (tok === "yyyy") y = Number(v)
        else if (tok === "yy") y = 2000 + Number(v)
        else if (tok === "MMMM" || tok === "MMM") mo = MONTHS.findIndex((x) => x.toLowerCase().startsWith(v.toLowerCase().slice(0, 3))) + 1
        else if (tok === "MM" || tok === "M") mo = Number(v)
        else d = Number(v)
      })
      if (!y || mo < 1 || mo > 12 || d < 1 || d > 31) return null
      const dt = new Date(Date.UTC(y, mo - 1, d))
      return dt.getUTCMonth() === mo - 1 ? `${y}-${pad(mo)}-${pad(d)}` : null
    }
    readers.set(format, read)
  }
  return read(text)
}

/** YYYY-MM-DD written in `format`. */
export function writeDate(iso: string, format: string): string {
  const [y, m, d] = iso.split("-").map(Number)
  const day = new Date(Date.UTC(y, m - 1, d)).getUTCDay()
  return parts(format).map((p) => {
    if ("lit" in p) return p.lit
    switch (p.tok) {
      case "yyyy": return String(y)
      case "yy": return pad(y % 100)
      case "MMMM": return MONTHS[m - 1]
      case "MMM": return MONTHS[m - 1].slice(0, 3)
      case "MM": return pad(m)
      case "M": return String(m)
      case "do": return ordinal(d)
      case "dd": return pad(d)
      case "d": return String(d)
      case "EEEE": return DAYS[day]
      default: return DAYS[day].slice(0, 3)
    }
  }).join("")
}

/** "2024-01-05" -> "Fri": the day Logseq writes in <2024-01-05 Fri>. */
export const dayName = (iso: string) => writeDate(iso, "EEE")
