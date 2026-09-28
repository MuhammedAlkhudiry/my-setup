# Device Slimming

Slim every simulator and emulator that agents use, so several can run in parallel. Slim a shared device only after its owner releases it,
because slimming reboots it.

Never slim a device used for performance profiling; the disabled services change the measurements.

## iOS simulators

Use `simslim`. Keep the categories apps commonly need: sign-in, purchases, push notifications, universal links, contacts and calendar pickers,
the photo picker, and share sheets.

```sh
simslim on <udid> --except icloud,store,web,pim,photos,connectivity --preserve-boot-state
simslim status <udid> --dropped
```

Undo with `simslim off <udid>`.

## Android emulators

Use `avdslim`. Its package list and defaults would break common app features, so always pass the flags below:

- **Never pass `--aggressive`.** It disables the Play Store, which in-app purchases need, and Chrome, which web sign-in and links need.
- **Keep location on** with `--skip=location`. Without it, slimming turns device location off.
- **Keep the contacts, calendar, and camera apps.** Contact pickers, calendar event screens, and camera capture open these apps.
- **Keep host camera and audio.** `tune-avd` turns both off.
- **Use 2048 MB RAM** for Google Play images. The 1536 MB default is too tight for Play services plus a development build.

`avdslim` does not follow a symlinked `~/.android/avd`; if it finds no AVDs, set `ANDROID_AVD_HOME` to the real AVD directory.

An emulator started with `-read-only` discards everything written since boot. That includes apps installed after boot and the `avdslim on`
changes. Before restarting it, check for app installs newer than its boot and have the owner confirm they can reinstall. After each boot, run
`avdslim on` again.

1. Record the emulator's launch flags, then stop it.
2. Tune the AVD once:

   ```sh
   avdslim tune-avd <avd> --ram=2048
   avdslim enable camera <avd>
   avdslim enable audio <avd>
   ```

   `tune-avd` deletes the AVD's saved snapshots, so the next boot is a cold boot. Installed apps and data stay. `enable camera` sets both
   cameras to `emulated`; restore a back camera that was `virtualscene` in the AVD's `config.ini`.

3. Cold-boot it with its recorded flags, but without `-memory`, which would override the tuned RAM.
4. Slim it after boot:

   ```sh
   avdslim on emulator-<port> --skip=location \
     --keep=com.android.contacts --keep=com.google.android.contacts \
     --keep=com.android.calendar --keep=com.google.android.calendar \
     --keep=com.android.camera2
   ```

5. Verify that `adb -s emulator-<port> shell pm list packages` still lists the app and `com.android.vending`.

Undo with `avdslim off emulator-<port>`. If a slimmed emulator hangs on a black screen, run `avdslim repair`. It needs `adb root`, which Google
Play images refuse, so use `avdslim off` there instead.
