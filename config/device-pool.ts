import type { PoolMember } from "../src/lib/device-queue";

/**
 * The fixed set of simulators and emulators agents lease through `device-queue acquire <project> <platform>`. The queue
 * creates a missing iOS member on first lease and never creates any other device. A member's `name` is its simulator
 * name, or its AVD name for an emulator; a newly created simulator gets the member's `locale`, such as `ar_SA`.
 */
export interface PoolDevice extends PoolMember {
  /** CoreSimulator device type used to create a missing simulator. */
  deviceType?: string;
}

const IPHONE = "com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro";
const SMALL_IPHONE = "com.apple.CoreSimulator.SimDeviceType.iPhone-SE-3rd-generation";

/**
 * Each project has as many simulators as iOS slots, so five concurrent leases never run out. Extra devices repeat a kind
 * rather than adding per-task ones; the queue creates each on its first lease.
 */
export const DEVICE_POOL: PoolDevice[] = [
  { project: "harium", platform: "ios", kind: "main", name: "Harium Main", deviceType: IPHONE },
  { project: "harium", platform: "ios", kind: "main", name: "Harium Main 2", deviceType: IPHONE },
  { project: "harium", platform: "ios", kind: "main", name: "Harium Main 3", deviceType: IPHONE },
  { project: "harium", platform: "ios", kind: "small", name: "Harium Small", deviceType: SMALL_IPHONE },
  {
    project: "harium",
    platform: "ios",
    kind: "rtl",
    name: "Harium RTL",
    deviceType: IPHONE,
    locale: "ar_SA",
  },
  { project: "harium", platform: "android", kind: "main", name: "Harium_Main" },
  { project: "awraq", platform: "ios", kind: "main", name: "Awraq Main", deviceType: IPHONE },
  { project: "awraq", platform: "ios", kind: "main", name: "Awraq Main 2", deviceType: IPHONE },
  { project: "awraq", platform: "ios", kind: "main", name: "Awraq Main 3", deviceType: IPHONE },
  { project: "awraq", platform: "ios", kind: "small", name: "Awraq Small", deviceType: SMALL_IPHONE },
  { project: "awraq", platform: "ios", kind: "small", name: "Awraq Small 2", deviceType: SMALL_IPHONE },
  { project: "awraq", platform: "android", kind: "main", name: "Awraq_Main" },
];

/**
 * Android emulator slots per Mac, keyed by host name, for Macs with fewer AVDs than the default; a host-local
 * `DEVICE_QUEUE_ANDROID_SLOTS` still overrides it. big-mac runs only Awraq_Main.
 */
export const HOST_ANDROID_SLOTS: Record<string, number> = { "big-mac": 1 };

/** Flags from the mobile-app-infra device-slimming reference; they keep sign-in, purchases, pickers, and links working. */
export const SLIM_FLAGS = {
  ios: ["--except", "icloud,store,web,pim,photos,connectivity"],
  android: [
    "--skip=location,bglimit",
    "--keep=com.android.contacts",
    "--keep=com.google.android.contacts",
    "--keep=com.android.calendar",
    "--keep=com.google.android.calendar",
    "--keep=com.android.camera2",
  ],
};
