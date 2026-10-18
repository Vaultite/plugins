# Notes for `now-playing/`

- macOS 15.4+ answers MediaRemote's now playing only for Apple-signed processes, so `native/adapter.m` (our own, MIT)
  is built with clang into `plugin.localDir()` (by its source's hash) and loaded into `/usr/bin/perl` by
  `native/adapter.pl`: JSON lines out (`state` with every player, `artwork` once per cover), commands in on stdin.
  Started on the first request, ended two minutes after the last one (stdin closed).
- Players are read per client (`...GetNowPlayingInfoForPlayer` on a player path), but commands can't pick one:
  mediaremoted sends ours (any path, any item id option) to its current player, and making another current is
  "Operation not permitted". So a player that isn't current takes commands only through AppleScript (Spotify, Music);
  others are `control: false`.
- Spotify doesn't report shuffle to MediaRemote and ignores its seek: both go through AppleScript for Spotify and
  Music (macOS asks once to let Vaultite control them). Volume is CoreAudio's default output device.
