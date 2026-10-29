import { dlopen } from "bun:ffi";

// Opened on first lock so importing a caller works on hosts without libc, such as Windows.
let symbol: ((fd: number, operation: number) => number) | undefined;

export const flock = (fd: number, operation: number) =>
  (symbol ??= dlopen(process.platform === "darwin" ? "/usr/lib/libSystem.B.dylib" : "libc.so.6", {
    flock: { args: ["i32", "i32"], returns: "i32" },
  }).symbols.flock)(fd, operation);
