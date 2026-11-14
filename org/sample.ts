// A made-up Org file for the Plugins page's preview.
export const SAMPLE = `#+TITLE: Lighthouse launch
#+TODO: TODO NEXT | DONE
* NEXT [#A] Ship the beta [1/3] :launch:
DEADLINE: <${inDays(4)}>
- [X] Freeze the API
- [ ] Invite the first teams
- [ ] Turn on billing
* DONE Pick the pricing
CLOSED: [${inDays(-2)}]
Three tiers, /per seat/: see the [[https://example.com][brief]].
`

function inDays(n: number) {
  const d = new Date()
  d.setDate(d.getDate() + n)
  const p = (x: number) => String(x).padStart(2, "0")
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d.getDay()]}`
}
