#!/usr/bin/perl
# Loads adapter.dylib into Apple's perl (a platform binary MediaRemote still answers) and runs it: JSON lines out,
# commands in on stdin. Usage: adapter.pl <adapter.dylib>
use strict;
use warnings;
use DynaLoader;

my $lib = shift or die "usage: adapter.pl <adapter.dylib>\n";
my $handle = DynaLoader::dl_load_file($lib, 0) or die "can't load $lib: " . DynaLoader::dl_error() . "\n";
my $entry = DynaLoader::dl_find_symbol($handle, "vaultite_now_playing") or die "no entry point: " . DynaLoader::dl_error() . "\n";
DynaLoader::dl_install_xsub("main::run", $entry);
run();
