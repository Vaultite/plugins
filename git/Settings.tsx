// Git's settings sheet, above its declared settings: the repository it found, and a token for HTTPS remotes, kept in
// the server machine's config (never the vault), never shown again once saved.
import { useEffect, useState } from "react"
import { KeyRound } from "lucide-react"
import { get, Group, notify, notifyError, post, SettingRow } from "@vaultite"
import { useGit } from "./client"

export function GitSettings() {
  const { snap: s } = useGit()
  const [token, setToken] = useState<{ set: boolean; user: string } | null>(null)
  const [value, setValue] = useState("")
  const [user, setUser] = useState("")
  useEffect(() => { get<{ set: boolean; user: string }>("git/token").then((t) => { setToken(t); setUser(t.user) }, () => {}) }, [])
  const save = async (clear = false) => {
    try {
      const t = await post<{ set: boolean; user: string }>("git/token", clear ? { token: "" } : { token: value.trim(), user: user.trim() })
      setToken(t); setValue("")
      notify(clear ? "Removed the token" : "Saved the token on the server's machine")
    } catch (e) { notifyError(e, "Couldn't keep the token") }
  }
  const field = "h-8 w-full min-w-0 rounded-[8px] border-[0.5px] border-border bg-background/60 px-2.5 text-[15px] outline-none focus:border-ring md:h-7 md:rounded-[6px] md:text-[13px]"
  return (
    <div className="flex flex-col gap-1.5" data-git-settings>
      <Group>
        <SettingRow label="Repository" sub={!s ? "Asking git…" : !s.git ? "git isn't installed on the server's machine" : s.repo ? s.repo.top : "The vault isn't a git repository yet (Source control makes one)"}
          value={s?.repo ? [s.branch, s.upstream].filter(Boolean).join(" → ") : undefined} />
        <SettingRow label="Access token for HTTPS remotes" stack data-setting="token"
          sub={token?.set ? "Kept on the server's machine, not in the vault. Saving another replaces it." : "For a remote that asks for a password (a GitHub or GitLab token). SSH keys and the Mac's keychain need none."}>
          <form className="mt-2 flex flex-col gap-1.5" onSubmit={(e) => { e.preventDefault(); if (value.trim()) void save() }}>
            <input value={user} onChange={(e) => setUser(e.target.value)} placeholder="User name (optional)" aria-label="User name" className={field} autoComplete="off" spellCheck={false} />
            <div className="flex gap-1.5">
              <input type="password" value={value} onChange={(e) => setValue(e.target.value)} placeholder={token?.set ? "A token is saved" : "Token"} aria-label="Token" className={field} autoComplete="off" />
              <button type="submit" disabled={!value.trim()} className="flex h-8 shrink-0 cursor-pointer items-center gap-1.5 rounded-[8px] bg-foreground/[0.07] px-3 text-[15px] font-medium hover:bg-foreground/[0.11] disabled:opacity-40 md:h-7 md:rounded-[6px] md:text-[13px]">
                <KeyRound className="size-3.5" strokeWidth={2.25} />Save
              </button>
              {token?.set && <button type="button" onClick={() => void save(true)} className="h-8 shrink-0 cursor-pointer rounded-[8px] px-3 text-[15px] font-medium text-[var(--red)] hover:bg-foreground/[0.06] md:h-7 md:rounded-[6px] md:text-[13px]">Remove</button>}
            </div>
          </form>
        </SettingRow>
      </Group>
      {s?.cloud && <p className="px-1 text-[13px] leading-[18px] text-muted-foreground">{s.cloud.warning}</p>}
    </div>
  )
}
