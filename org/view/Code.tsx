// Code and math as the app draws a note's: its code fence (highlighted, a copy button) and KaTeX, both filled in by the
// app's own hydration into elements React leaves alone.
import { useEffect, useRef, useState } from "react"
import { Check, Copy } from "lucide-react"
import { copyText, hydrateMarkdown, notifyError } from "@vaultite"

// Org's language names where the app's highlighter knows them by another.
const LANGS: Record<string, string> = { "emacs-lisp": "lisp", elisp: "lisp", sh: "shell", bash: "shell", zsh: "shell", ipython: "python",
  "jupyter-python": "python", js: "javascript", ts: "typescript", "c++": "cpp", cpp: "cpp", conf: "properties", dot: "", ditaa: "" }
const langOf = (l: string) => { const k = l.toLowerCase(); return k in LANGS ? LANGS[k] : k }

/** A src block, an example or fixed-width lines: `lang` highlights it and names it in its head. */
export function CodeBlock({ code, lang = "" }: { code: string; lang?: string }) {
  const pre = useRef<HTMLPreElement>(null)
  const [copied, setCopied] = useState(false)
  const hl = langOf(lang)
  useEffect(() => {
    const el = pre.current
    if (!el) return
    const c = document.createElement("code")
    if (hl) c.className = `language-${hl}`
    c.textContent = code
    el.replaceChildren(c)
    hydrateMarkdown(el.parentElement!)
  }, [code, hl])
  useEffect(() => { if (!copied) return; const t = setTimeout(() => setCopied(false), 1500); return () => clearTimeout(t) }, [copied])
  const copy = () => { copyText(code).then(() => setCopied(true), (e) => notifyError(e)) }
  return (
    <div className={lang ? "md-code" : "md-code md-code-bare"}>
      <div className="md-code-head">
        <span className="md-code-lang">{lang}</span>
        <button type="button" className={copied ? "md-copy is-copied" : "md-copy"} aria-label="Copy" data-tip="Copy" onClick={copy}>
          {copied ? <Check size={14} /> : <Copy size={14} />}
        </button>
      </div>
      <pre ref={pre} />
    </div>
  )
}

/** TeX drawn by KaTeX, inline or as a display. */
export function Math({ tex, display = false }: { tex: string; display?: boolean }) {
  const host = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    const el = host.current
    if (!el) return
    const m = document.createElement(display ? "div" : "span")
    m.className = display ? "math math-display" : "math math-inline"
    m.dataset.math = display ? "display" : "inline"
    m.textContent = tex
    el.replaceChildren(m)
    hydrateMarkdown(el)
  }, [tex, display])
  return display ? <div ref={host as unknown as React.RefObject<HTMLDivElement>} className="org-math" /> : <span ref={host} />
}
