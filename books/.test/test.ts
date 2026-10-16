// Books on a throwaway server: a new book's created stamp, progress through book.progress, its blocks as text.
//   node books/.test/test.ts
import { check, done, serve } from "../../testkit.ts"

const s = await serve(["books"])
try {
  const [c, b] = await s.api("POST", "books", { title: "Op book", author: "Alice Park", total_pages: 300, status: "want" })
  // (where the vault's books are: the sample's are in Notes/Books)
  const FILE = `${b.id}.md`, book = () => s.read(FILE)
  check("a new book is a file where books are, with `created`", c === 201 && b.id.endsWith("Books/Op book") && /\ncreated: '\d{4}-\d\d-\d\d \d\d:\d\d:\d\d'\n/.test(book()), [c, b])
  check("...with its block on top", book().includes("```block-book"), book())
  const out = s.vau("book.progress", "op book", "120")
  check("book.progress: the page, reading from now", out.trim() === "Op book: reading, page 120 of 300." && book().includes("current_page: 120") &&
    /\nstarted: \d{4}-\d\d-\d\d\n/.test(book()), [out, book()])
  s.vau("book.progress", "Op book", "--status", "done", "--rating", "5")
  check("book.progress: done, with the day and a rating", /\nstatus: done\n/.test(book()) && /\nfinished: \d{4}-/.test(book()) &&
    book().includes("rating: 5"), book())
  const [nc, no] = await s.api("POST", "ops/book.progress", { book: "Nowhere", page: 3 })
  check("book.progress: a book that isn't there says so", nc === 404 && no.error.includes("no book 'Nowhere'"), [nc, no])
  await s.api("POST", "books", { title: "Shelved book", author: "Bob Lee", status: "reading" })
  await s.api("PUT", "books/Shelved book", { archived: true })
  await s.api("POST", "books", { title: "Next one", author: "Bob Lee", status: "want" })
  s.write("Shelf.md", "```block-books\n```\n")
  const [, shelf] = await s.api("GET", "render?path=Shelf.md")
  check("books block: up next and finished, archived ones left out", shelf.includes("Up next:") && shelf.includes("Next one by Bob Lee") && shelf.includes("Op book by Alice Park") &&
    !shelf.includes("Shelved book"), shelf)
  const [, one] = await s.api("GET", `render?path=${encodeURIComponent(FILE)}`)
  check("book block: its fields as text", one.includes("Status: done") && one.includes("Rating: 5 of 5"), one)
  s.vau("plugin", "off", "books")
  const [oc] = await s.api("POST", "ops/book.progress", { book: "Op book", page: 1 })
  check("off, its operations aren't there", oc === 404, oc)
} finally {
  s.stop()
}
done()
