// Diagnostics are captured by the command entrypoint and shown with --verbose.
const verboseOutput =
  process.env.MY_SETUP_OUTPUT === "verbose" || process.argv.includes("--verbose");

function detail(message: string): void {
  if (verboseOutput) console.log(message);
}

export const print = {
  error: (message: string) => console.error(`ERROR: ${message}`),
  success: detail,
  info: detail,
  warning: (message: string) => console.log(message),
  dim: detail,
};
