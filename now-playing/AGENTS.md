## Now playing
What the Mac the server runs on is playing, from macOS's own now playing (MediaRemote): any app that reports it
(Spotify, Music, a browser tab), with its cover, position and the output volume. Nothing is written to the vault.
`now-playing.get` says what's on; `now-playing.control <command>` plays, pauses, toggles, skips (`next`, `previous`),
toggles `shuffle`, seeks (`--value` seconds) or sets the `volume` (`--value` 0 to 1). Ask before changing what the
user is listening to. On a machine that isn't a Mac, or without Xcode's command line tools, it says it isn't available.
