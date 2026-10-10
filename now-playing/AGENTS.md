## Now playing
What the Mac the server runs on is playing, from macOS's own now playing (MediaRemote): every app that reports it
(Spotify, Music, a browser tab) as a player, the main one first, each with its track, cover and position, and the output
volume. Nothing is written to the vault. `now-playing.get` lists them; `now-playing.control <command>` plays, pauses,
toggles, skips (`next`, `previous`), toggles `shuffle`, seeks (`--value` seconds) or sets the `volume` (`--value` 0 to
1); `--player <bundle id>` picks the app (else the main one). macOS takes commands only for its current app, and Spotify
and Music through their scripting: a player that can't be controlled says so. Ask before changing what the user is
listening to. On a machine that isn't a Mac, or without Xcode's command line tools, it says it isn't available.
