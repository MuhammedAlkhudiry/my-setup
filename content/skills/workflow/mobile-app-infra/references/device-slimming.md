# Device Slimming

`device-queue` slims every pool device before handing it out, with the flags below. Use this
reference to set up a device outside the pool or to repair one. Slimming reboots a device; never slim performance-profiling devices, since
disabled services change measurements.

## iOS simulators

Preserve sign-in, purchases, push, universal links, contacts/calendar/photo pickers, and share sheets:

```sh
simslim on <udid> --except icloud,store,web,pim,photos,connectivity --preserve-boot-state
simslim status <udid> --dropped
```

Undo with `simslim off <udid>`.

## Android emulators

Override `avdslim` defaults to preserve app features:

- Never pass `--aggressive`: purchases need Play Store; web sign-in and links need Chrome.
- Use `--skip=location,bglimit` to keep location and avoid the four-process cap, which can kill the app behind a picker or browser sign-in.
- Keep contacts, calendar, and camera apps for pickers/capture, plus host camera and audio, which `tune-avd` disables.
- Use 2048 MB RAM for Google Play images; the 1536 MB default is too tight for Play services and a development build.

If a symlinked `~/.android/avd` hides AVDs from `avdslim`, set `ANDROID_AVD_HOME` to the real directory.

Disabled packages live on the data partition, so slimming survives cold boots. The queue cold-boots pool emulators with hardware graphics
and no snapshots (`-no-snapshot -gpu host`) in about 15 seconds: restoring a quick-boot snapshot with host graphics can hang the emulator, and
one saved under other graphics settings fails to load. Never `avdslim bake` a pool emulator. `-read-only` emulators lose post-boot installs
and slimming on restart; reapply `avdslim on` after each boot.

1. Record the emulator's launch flags, then stop it.
2. Tune the AVD once:

   ```sh
   avdslim tune-avd <avd> --ram=2048
   avdslim enable camera <avd>
   avdslim enable audio <avd>
   ```

   `tune-avd` deletes saved snapshots, preserving installed apps/data. `enable camera` sets both cameras to `emulated`; restore a previously
   `virtualscene` back camera in `config.ini`.

3. Cold-boot with the recorded flags, omitting `-memory` so it cannot override the tuned RAM.
4. Slim it after boot:

   ```sh
   avdslim on emulator-<port> --skip=location,bglimit \
     --keep=com.android.contacts --keep=com.google.android.contacts \
     --keep=com.android.calendar --keep=com.google.android.calendar \
     --keep=com.android.camera2
   ```

5. Verify the app and `com.android.vending` remain installed.

`avdslim on` has no dry run. Undo with `avdslim off emulator-<port>`. For a black screen, use `avdslim repair`; it needs root, so use `off` on
Google Play images.
