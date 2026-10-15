import type { CAC } from "cac";

export { agentOutput } from "../../content/skills/workflow/prs/scripts/agent-output";

export function parseCli(cli: CAC): void {
  cli.parse();
  if (cli.matchedCommand || cli.options.help) return;

  if (process.argv.length === 2) {
    cli.outputHelp();
    return;
  }

  console.error(`Unknown command or options. Run ${cli.name} --help.`);
  process.exitCode = 2;
}
