## Git
The vault's folder as a git repository, run with the user's git on the server's machine. Nothing of it is in the vault
but `.gitignore` (written once by `git.init`: `.vaultite/cache/`, `.vaultite/generated/`, `.trash/` and the OS's files);
the repository is the folder's own `.git`.

- **Commit your own work**: when you've finished something, `git.commit` with `files` (the ones you changed, vault paths)
  and a `message` saying what you did, in a line ("Added reading notes for Lighthouse"). Only those files go in; the
  user's other edits stay pending. Without `files` it commits what's staged, or every change. A commit made by an agent
  says so in a trailer (`Vaultite-Agent: <who>`).
- **Sync**: `git.sync` commits every change, pulls (a merge, never a rebase) and pushes. A merge conflict stops it with
  nothing overwritten: the files are listed (and in the user's Inbox). Don't resolve one unasked: it's the user's choice
  of words. If asked, keep what they want between `<<<<<<<` and `>>>>>>>` (removing the markers), then `git.commit`; or
  `git.abort` to go back to before the pull.
- **History**: `git.log <file>` lists its commits (following renames), `git.show <file> <commit>` its text then,
  `git.restore <file> <commit>` writes it back as an ordinary edit (File history keeps what it replaced).
- **Automatic**: the settings `autoInterval` (minutes) and `autoIdle` (minutes after the last edit) commit and sync on
  one machine (Machines' first, or `machine`), with the message template (`{{date}}`, `{{numFiles}}`, `{{hostname}}`,
  `{{files}}`). `vau schedule list` shows the job (`git/auto`, which checks every minute).
- Pushing and pulling use the server machine's credentials (SSH keys, the keychain), or a token for HTTPS remotes kept
  in its config (the settings sheet; never the vault). A vault in iCloud Drive (or Dropbox...) and git can fight over
  `.git`: `git.status` says so; use one of them.
