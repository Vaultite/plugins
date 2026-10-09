// Now Playing for the plugin: macOS's MediaRemote (private) only answers Apple-signed processes since 15.4, so
// /usr/bin/perl loads this library (adapter.pl) and it speaks JSON lines: state out, commands in on stdin.
#import <AppKit/AppKit.h>
#import <AudioToolbox/AudioToolbox.h>
#import <CommonCrypto/CommonDigest.h>
#import <CoreAudio/CoreAudio.h>
#import <Foundation/Foundation.h>
#include <dlfcn.h>

typedef void (*GetInfo)(dispatch_queue_t, void (^)(NSDictionary *));
typedef void (*GetBool)(dispatch_queue_t, void (^)(Boolean));
typedef void (*GetClient)(dispatch_queue_t, void (^)(id));
typedef void (*Register)(dispatch_queue_t);
typedef Boolean (*SendCommand)(int, NSDictionary *);
typedef void (*SetElapsed)(double);
typedef NSString *(*ClientString)(id);

static GetInfo getInfo;
static GetBool isPlaying;
static GetClient getClient;
static SendCommand sendCommand;
static SetElapsed setElapsed;
static ClientString bundleOf, parentBundleOf, nameOf;
static dispatch_queue_t queue;
static NSString *lastArtwork;
static NSString *lastLine;

static id sym(void *lib, const char *name) {
  void *p = dlsym(lib, name);
  return p ? *(__unsafe_unretained id *)p : nil;
}

static void emit(NSDictionary *obj) {
  NSData *json = [NSJSONSerialization dataWithJSONObject:obj options:0 error:nil];
  if (!json) return;
  NSString *line = [[NSString alloc] initWithData:json encoding:NSUTF8StringEncoding];
  if ([line isEqualToString:lastLine]) return;
  lastLine = line;
  fprintf(stdout, "%s\n", line.UTF8String);
  fflush(stdout);
}

// The default output device's volume (0-1) and mute, through CoreAudio.
static AudioObjectID outputDevice(void) {
  AudioObjectID dev = kAudioObjectUnknown;
  UInt32 size = sizeof dev;
  AudioObjectPropertyAddress a = {kAudioHardwarePropertyDefaultOutputDevice, kAudioObjectPropertyScopeGlobal, kAudioObjectPropertyElementMain};
  AudioObjectGetPropertyData(kAudioObjectSystemObject, &a, 0, NULL, &size, &dev);
  return dev;
}
static AudioObjectPropertyAddress volumeAddress(void) {
  return (AudioObjectPropertyAddress){kAudioHardwareServiceDeviceProperty_VirtualMainVolume, kAudioDevicePropertyScopeOutput, kAudioObjectPropertyElementMain};
}
static AudioObjectPropertyAddress muteAddress(void) {
  return (AudioObjectPropertyAddress){kAudioDevicePropertyMute, kAudioDevicePropertyScopeOutput, kAudioObjectPropertyElementMain};
}
static id volume(void) {
  AudioObjectID dev = outputDevice();
  AudioObjectPropertyAddress a = volumeAddress();
  Float32 v = 0;
  UInt32 size = sizeof v;
  if (!AudioObjectHasProperty(dev, &a) || AudioObjectGetPropertyData(dev, &a, 0, NULL, &size, &v)) return [NSNull null];
  return @(round(v * 1000) / 1000);
}
static BOOL muted(void) {
  AudioObjectID dev = outputDevice();
  AudioObjectPropertyAddress a = muteAddress();
  UInt32 m = 0, size = sizeof m;
  if (!AudioObjectHasProperty(dev, &a)) return NO;
  AudioObjectGetPropertyData(dev, &a, 0, NULL, &size, &m);
  return m != 0;
}
static void setVolume(Float32 v) {
  AudioObjectID dev = outputDevice();
  AudioObjectPropertyAddress a = volumeAddress();
  v = fmaxf(0, fminf(1, v));
  AudioObjectSetPropertyData(dev, &a, 0, NULL, sizeof v, &v);
  AudioObjectPropertyAddress m = muteAddress();
  UInt32 off = v == 0;
  if (AudioObjectHasProperty(dev, &m)) AudioObjectSetPropertyData(dev, &m, 0, NULL, sizeof off, &off);
}

static NSString *str(NSDictionary *info, NSString *key) {
  id v = key ? info[key] : nil;
  return [v isKindOfClass:NSString.class] && [v length] ? v : nil;
}
static id num(NSDictionary *info, NSString *key) {
  id v = key ? info[key] : nil;
  return [v isKindOfClass:NSNumber.class] ? v : [NSNull null];
}

// Keys of the info dictionary, read from the framework so their strings never have to be guessed.
static NSString *kTitle, *kArtist, *kAlbum, *kDuration, *kElapsed, *kRate, *kTimestamp, *kArtwork, *kArtworkMime, *kShuffle, *kRepeat;

static void report(void) {
  getClient(queue, ^(id client) {
    NSString *bundle = client && parentBundleOf ? parentBundleOf(client) : nil;
    if (!bundle.length && client && bundleOf) bundle = bundleOf(client);
    NSString *appName = client && nameOf ? nameOf(client) : nil;
    isPlaying(queue, ^(Boolean playing) {
      getInfo(queue, ^(NSDictionary *info) {
        NSMutableDictionary *out = [NSMutableDictionary dictionary];
        out[@"type"] = @"state";
        out[@"volume"] = volume();
        out[@"muted"] = @(muted());
        if (!info.count || !str(info, kTitle)) {
          out[@"track"] = [NSNull null];
          emit(out);
          return;
        }
        NSString *name = appName;
        if (bundle.length && !name.length) {
          NSURL *url = [NSWorkspace.sharedWorkspace URLForApplicationWithBundleIdentifier:bundle];
          if (url) name = [NSFileManager.defaultManager displayNameAtPath:url.path].stringByDeletingPathExtension;
        }
        NSDate *at = [info[kTimestamp] isKindOfClass:NSDate.class] ? info[kTimestamp] : nil;
        NSData *art = [info[kArtwork] isKindOfClass:NSData.class] ? info[kArtwork] : nil;
        NSString *artId = nil;
        if (art.length) {
          unsigned char d[CC_SHA256_DIGEST_LENGTH];
          CC_SHA256(art.bytes, (CC_LONG)art.length, d);
          artId = [NSString stringWithFormat:@"%02x%02x%02x%02x%02x%02x%02x%02x", d[0], d[1], d[2], d[3], d[4], d[5], d[6], d[7]];
          if (![artId isEqualToString:lastArtwork]) {
            lastArtwork = artId;
            NSString *mime = str(info, kArtworkMime) ?: @"image/jpeg";
            emit(@{@"type": @"artwork", @"id": artId, @"mime": mime, @"data": [art base64EncodedStringWithOptions:0]});
          }
        }
        out[@"track"] = @{
          @"title": str(info, kTitle) ?: @"",
          @"artist": str(info, kArtist) ?: [NSNull null],
          @"album": str(info, kAlbum) ?: [NSNull null],
          @"duration": num(info, kDuration),
          @"elapsed": num(info, kElapsed),
          @"rate": num(info, kRate),
          @"at": at ? @((long long)(at.timeIntervalSince1970 * 1000)) : [NSNull null],
          @"artwork": artId ?: [NSNull null],
          @"shuffle": num(info, kShuffle),
          @"repeat": num(info, kRepeat),
        };
        out[@"playing"] = @(playing ? YES : NO);
        out[@"app"] = bundle.length ? @{@"bundle": bundle, @"name": name ?: bundle} : [NSNull null];
        emit(out);
      });
    });
  });
}

// MediaRemote's commands (MRMediaRemoteCommand).
static int commandFor(NSString *name) {
  NSDictionary *c = @{@"play": @0, @"pause": @1, @"toggle": @2, @"next": @4, @"previous": @5, @"shuffle": @6, @"repeat": @7};
  NSNumber *n = c[name];
  return n ? n.intValue : -1;
}

static void handle(NSString *line) {
  NSArray *parts = [line componentsSeparatedByString:@" "];
  NSString *cmd = parts.firstObject;
  if ([cmd isEqualToString:@"seek"] && parts.count > 1) setElapsed([parts[1] doubleValue]);
  else if ([cmd isEqualToString:@"volume"] && parts.count > 1) setVolume([parts[1] floatValue]);
  else if ([cmd isEqualToString:@"refresh"]) lastLine = nil;
  else {
    int n = commandFor(cmd);
    if (n >= 0) sendCommand(n, nil);
  }
  dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 150 * NSEC_PER_MSEC), queue, ^{ report(); });
}

static OSStatus audioChanged(AudioObjectID o, UInt32 n, const AudioObjectPropertyAddress *a, void *ctx) {
  dispatch_async(queue, ^{ report(); });
  return 0;
}
static void watchAudio(void) {
  static AudioObjectID watched = kAudioObjectUnknown;
  AudioObjectID dev = outputDevice();
  if (dev == watched) return;
  AudioObjectPropertyAddress v = volumeAddress(), m = muteAddress();
  if (watched != kAudioObjectUnknown) {
    AudioObjectRemovePropertyListener(watched, &v, audioChanged, NULL);
    AudioObjectRemovePropertyListener(watched, &m, audioChanged, NULL);
  }
  watched = dev;
  AudioObjectAddPropertyListener(dev, &v, audioChanged, NULL);
  AudioObjectAddPropertyListener(dev, &m, audioChanged, NULL);
}
static OSStatus deviceChanged(AudioObjectID o, UInt32 n, const AudioObjectPropertyAddress *a, void *ctx) {
  dispatch_async(queue, ^{ watchAudio(); report(); });
  return 0;
}

// The entry point perl installs as an XSUB; it never returns.
void vaultite_now_playing(void *perl, void *cv) {
  @autoreleasepool {
    void *lib = dlopen("/System/Library/PrivateFrameworks/MediaRemote.framework/MediaRemote", RTLD_NOW);
    if (!lib) { fprintf(stdout, "{\"type\":\"error\",\"error\":\"no MediaRemote\"}\n"); fflush(stdout); exit(1); }
    getInfo = (GetInfo)dlsym(lib, "MRMediaRemoteGetNowPlayingInfo");
    isPlaying = (GetBool)dlsym(lib, "MRMediaRemoteGetNowPlayingApplicationIsPlaying");
    getClient = (GetClient)dlsym(lib, "MRMediaRemoteGetNowPlayingClient");
    sendCommand = (SendCommand)dlsym(lib, "MRMediaRemoteSendCommand");
    setElapsed = (SetElapsed)dlsym(lib, "MRMediaRemoteSetElapsedTime");
    bundleOf = (ClientString)dlsym(lib, "MRNowPlayingClientGetBundleIdentifier");
    parentBundleOf = (ClientString)dlsym(lib, "MRNowPlayingClientGetParentAppBundleIdentifier");
    nameOf = (ClientString)dlsym(lib, "MRNowPlayingClientGetDisplayName");
    Register reg = (Register)dlsym(lib, "MRMediaRemoteRegisterForNowPlayingNotifications");
    if (!getInfo || !isPlaying || !getClient || !sendCommand || !setElapsed || !reg) {
      fprintf(stdout, "{\"type\":\"error\",\"error\":\"MediaRemote is missing functions\"}\n"); fflush(stdout); exit(1);
    }
    kTitle = sym(lib, "kMRMediaRemoteNowPlayingInfoTitle");
    kArtist = sym(lib, "kMRMediaRemoteNowPlayingInfoArtist");
    kAlbum = sym(lib, "kMRMediaRemoteNowPlayingInfoAlbum");
    kDuration = sym(lib, "kMRMediaRemoteNowPlayingInfoDuration");
    kElapsed = sym(lib, "kMRMediaRemoteNowPlayingInfoElapsedTime");
    kRate = sym(lib, "kMRMediaRemoteNowPlayingInfoPlaybackRate");
    kTimestamp = sym(lib, "kMRMediaRemoteNowPlayingInfoTimestamp");
    kArtwork = sym(lib, "kMRMediaRemoteNowPlayingInfoArtworkData");
    kArtworkMime = sym(lib, "kMRMediaRemoteNowPlayingInfoArtworkMIMEType");
    kShuffle = sym(lib, "kMRMediaRemoteNowPlayingInfoShuffleMode");
    kRepeat = sym(lib, "kMRMediaRemoteNowPlayingInfoRepeatMode");

    queue = dispatch_queue_create("vaultite.now-playing", DISPATCH_QUEUE_SERIAL);
    reg(queue);
    for (NSString *name in @[@"kMRMediaRemoteNowPlayingInfoDidChangeNotification",
                             @"kMRMediaRemoteNowPlayingApplicationIsPlayingDidChangeNotification",
                             @"kMRMediaRemoteNowPlayingApplicationDidChangeNotification"]) {
      [NSNotificationCenter.defaultCenter addObserverForName:name object:nil queue:nil usingBlock:^(NSNotification *n) {
        dispatch_async(queue, ^{ report(); });
      }];
    }
    AudioObjectPropertyAddress d = {kAudioHardwarePropertyDefaultOutputDevice, kAudioObjectPropertyScopeGlobal, kAudioObjectPropertyElementMain};
    AudioObjectAddPropertyListener(kAudioObjectSystemObject, &d, deviceChanged, NULL);
    dispatch_async(queue, ^{ watchAudio(); report(); });

    // Commands, one per line; stdin closing (the server went away) ends the process.
    dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
      char buf[256];
      while (fgets(buf, sizeof buf, stdin)) {
        NSString *line = [[NSString stringWithUTF8String:buf] stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet];
        if (line.length) dispatch_async(queue, ^{ handle(line); });
      }
      exit(0);
    });
    // Elapsed time moves without notifications; a slow heartbeat catches apps that don't post them.
    dispatch_source_t t = dispatch_source_create(DISPATCH_SOURCE_TYPE_TIMER, 0, 0, queue);
    dispatch_source_set_timer(t, dispatch_time(DISPATCH_TIME_NOW, 0), 5 * NSEC_PER_SEC, NSEC_PER_SEC);
    dispatch_source_set_event_handler(t, ^{ report(); });
    dispatch_resume(t);
  }
  CFRunLoopRun();
  exit(0);
}
