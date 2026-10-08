## Remote save
Syncs or backs up the vault's folder with storage the user owns: an S3-compatible bucket (AWS S3, Cloudflare R2,
Backblaze B2, MinIO) or a WebDAV folder (Nextcloud and friends). It writes no files of its own in the vault.

- **Run it**: `vau remote-save sync [remote] [--dry-run] [--deletions]`; how the last sync went: `vau remote-save status`.
  A sync runs on the machine whose settings hold the remote's connection (address, keys, passphrase: in that machine's
  data/config.json, never the vault); elsewhere it says where.
- **Directions**: two-way; push only (a backup: the vault's changes and deletions go up, nothing comes down); pull only
  (the vault follows the remote, its own changes stay here).
- **Never loses a version**: a file changed on both sides since the last sync is kept twice, the other version as
  `Name (conflict YYYY-MM-DD).md` beside it, and the inbox says so. A deletion follows only a file synced before (a
  first sync never deletes), and goes to the trash here. More than 20 deletions at once (and over a quarter of the
  files), or a whole top folder gone from here (iCloud), wait for `--deletions`.
- **Left out**: `.vaultite/cache/` and `.trash/` unless the remote's "Leave out" patterns say otherwise (gitignore-like:
  `*.mp4`, `Archive/`), and always `.DS_Store`, `.git/`, iCloud's placeholders.
- **On the remote**: unencrypted, each file at its own path under the folder (the layout Obsidian's Remotely Save uses
  without a password, so both can share a folder). Encrypted: AES-256-GCM with a key from the passphrase (scrypt),
  names hashed, and `.vaultite-remote-save.json` there holds the salt; only this plugin reads it.
- The remotes are `remotes` in `.vaultite/plugins/remote-save/data.json` (name, type, direction, every, skip,
  encrypt); add or change one in its settings sheet, which keeps the connection on that machine. Don't write
  addresses or keys into the vault.
