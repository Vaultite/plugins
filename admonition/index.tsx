// Admonitions: a ```ad-<type> fence drawn as the app's callout of that type (the same Markdown, so the same look); its
// icon: line, a Lucide name or an emoji, in place of the type's.
import { useLayoutEffect, useRef, useState } from "react"
import { createPortal } from "react-dom"
import { definePlugin, Markdown, namedIcon, type BlockCtx } from "@vaultite"
import { toCallout, TYPES } from "./ad"

function Admonition({ type, ctx }: { type: string; ctx: BlockCtx }) {
  const { md, icon } = toCallout(type, ctx.text)
  const Icon = namedIcon(icon)
  const box = useRef<HTMLDivElement>(null), [slot, setSlot] = useState<Element | null>(null)
  // The callout's own icon is in the drawn HTML: its place takes this one. Its margin is the block's around it already.
  useLayoutEffect(() => {
    box.current?.querySelector<HTMLElement>(".callout")?.style.setProperty("margin-bottom", "0")
    const s = Icon ? box.current?.querySelector(".callout-icon") ?? null : null
    s?.replaceChildren()
    setSlot(s)
  }, [md, Icon])
  return (
    <div ref={box}>
      <Markdown text={md} store={ctx.store} from={ctx.path} full />
      {slot && Icon && createPortal(<Icon width={16} height={16} />, slot)}
    </div>
  )
}

export default definePlugin({
  fences: Object.fromEntries(TYPES.map((t) => [`ad-${t}`, (ctx: BlockCtx) => <Admonition type={t} ctx={ctx} />])),
})
