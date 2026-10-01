/**
 * VS Code keymap for profiles with `vscodeKeymap`. The extension supplies PhpStorm's default Windows
 * keymap; the keybindings below add my PhpStorm customizations on top and replace the user's whole
 * `keybindings.json`. Keys are Windows keys.
 */

export const VSCODE_EXTENSIONS = ["k--kato.intellij-idea-keybindings"] as const;

// Merge these into user settings; preserve formatting, language, and project preferences.
export const VSCODE_SETTINGS = {
  "editor.minimap.enabled": false,
  "breadcrumbs.enabled": false,
  "workbench.activityBar.location": "hidden",
  "window.commandCenter": false,
  "workbench.layoutControl.enabled": false,
  "workbench.editor.showTabs": "none",
  "workbench.editor.editorActionsLocation": "hidden",
  "workbench.startupEditor": "none",
  "update.showReleaseNotes": false,
  "workbench.tips.enabled": false,
  "workbench.welcomePage.walkthroughs.openOnInstall": false,
  "editor.codeLens": false,
  "editor.stickyScroll.enabled": false,
  "workbench.editor.enablePreview": false,
  "workbench.editor.enablePreviewFromQuickOpen": false,
  "chat.disableAIFeatures": true,
  "chat.commandCenter.enabled": false,
  "editor.inlineSuggest.enabled": false,
  "terminal.integrated.suggest.enabled": false,
} as const;

export interface VscodeKeybinding {
  key: string;
  // A leading `-` removes an existing binding for that key.
  command: string;
  when?: string;
}

const RENAME_WHEN = "editorHasRenameProvider && editorTextFocus && !editorReadonly";

export const VSCODE_KEYBINDINGS: readonly VscodeKeybinding[] = [
  // Terminal: Alt+F12 and Alt+Z. Alt+Z otherwise toggles word wrap.
  { key: "alt+f12", command: "workbench.action.terminal.toggleTerminal" },
  { key: "alt+z", command: "-editor.action.toggleWordWrap" },
  { key: "alt+z", command: "workbench.action.terminal.toggleTerminal" },

  // Rename: Shift+F6 and Alt+C.
  { key: "shift+f6", command: "editor.action.rename", when: RENAME_WHEN },
  { key: "alt+c", command: "editor.action.rename", when: RENAME_WHEN },

  // Go to Line has no shortcut, which frees Ctrl+G.
  { key: "ctrl+g", command: "-workbench.action.gotoLine" },

  // Select next occurrence: Alt+J and Ctrl+G.
  { key: "alt+j", command: "editor.action.addSelectionToNextFindMatch", when: "editorFocus" },
  { key: "ctrl+g", command: "editor.action.addSelectionToNextFindMatch", when: "editorFocus" },

  // Select all occurrences: Ctrl+Shift+Alt+J and Ctrl+Shift+G. Outside the editor, Ctrl+Shift+G still opens Source Control.
  { key: "ctrl+shift+alt+j", command: "editor.action.selectHighlights", when: "editorFocus" },
  { key: "ctrl+shift+g", command: "editor.action.selectHighlights", when: "editorTextFocus" },
];
