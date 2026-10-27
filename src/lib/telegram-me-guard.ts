// Decides whether a Bash command must not run: `telegram-me send` for a draft the owner has not approved, or a read of the
// owner's Telegram session from the Keychain, which would let an agent write as the owner outside telegram-me. The CLI
// re-checks approval against Telegram on every send; this hook stops Claude before it tries and names the next step.

import { basename } from "node:path";

import { invokedProgram, shellScript, simpleCommands } from "./device-pool-guard";
import { KEYCHAIN_SERVICE, needsApproval, type Draft } from "./telegram-me";

const KEYCHAIN_READ =
  /find-generic-password|find-internet-password|dump-keychain|secrets\.get|SecItemCopyMatching/;

export function blockedTelegramCommand(
  command: string,
  readDraft: (id: string) => Draft | undefined,
): string | undefined {
  if (command.includes(KEYCHAIN_SERVICE) && KEYCHAIN_READ.test(command))
    return "The owner's Telegram session stays in the Keychain; use telegram-me commands instead of reading it.";

  for (const words of simpleCommands(command)) {
    const invocation = invokedProgram(words);
    const script = shellScript(invocation);
    const found =
      script !== undefined
        ? blockedTelegramCommand(script, readDraft)
        : basename(invocation.name) === "telegram-me" && invocation.args[0] === "send"
          ? unapprovedSend(
              invocation.args.find((arg, index) => index > 0 && !arg.startsWith("-")),
              readDraft,
            )
          : undefined;
    if (found) return found;
  }
  return undefined;
}

function unapprovedSend(
  id: string | undefined,
  readDraft: (id: string) => Draft | undefined,
): string | undefined {
  let draft: Draft | undefined;
  try {
    draft = id ? readDraft(id) : undefined;
  } catch {
    draft = undefined;
  }
  if (!draft)
    return `telegram-me send needs an existing draft id; create one with telegram-me draft.`;
  if (draft.sent) return `Draft ${draft.id} was already sent; never send it twice.`;
  if (needsApproval(draft) && !draft.approvedAt)
    return `Draft ${draft.id} is not approved. Show the owner its recipient and exact text, wait for their "yes" reply to its Telegram preview, then run telegram-me approve ${draft.id}.`;
  return undefined;
}
