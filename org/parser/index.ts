// Org Mode's parser: text to a tree in Emacs org-element's shape (ast.ts).
export { parseDocument as parse } from "./driver.ts"
export { settingsOf, type Settings } from "./settings.ts"
export * from "./ast.ts"
