# Notes for `now-playing/`

- macOS 15.4+ answers MediaRemote's now playing only for Apple-signed processes, so `native/adapter.m` (our own, MIT)
  is built with clang into `plugin.localDir()` (by its source's hash) and loaded into `/usr/bin/perl` by
  `native/adapter.pl`: JSON lines out (`state`, `artwork` once per cover), commands in on stdin. Started on the first
  request, ended two minutes after the last one (stdin closed).
- Spotify doesn't report shuffle to MediaRemote: shuffle for Spotify and Music goes through AppleScript (macOS asks
  once to let Vaultite control them). Volume is CoreAudio's default output device.
