/**
 * Whether a dialog (command palette, confirmation, profile picker…) is open. Programmatic focus moves — a
 * terminal mounting after a project switch, a panel becoming active — must not steal focus from it.
 */
export function isDialogOpen(doc: Document = document): boolean {
  return doc.querySelector('[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"]') !== null;
}
