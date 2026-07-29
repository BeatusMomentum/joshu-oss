import type { CwmWorkspaceController } from "./useCwmWorkspace";

export function CwmPanels({ cwm }: { readonly cwm: CwmWorkspaceController }) {
  const ready = cwm.status.kind === "ready";

  return (
    <aside className="cwm-sidebar" aria-label="Whiteboard session">
      <section className="cwm-panel cwm-status-panel">
        <div className="cwm-panel-heading">
          <h2>Curatorial workspace</h2>
          <span className={`cwm-status cwm-status-${cwm.status.kind}`}>{cwm.status.kind}</span>
        </div>
        <p>{cwm.status.message}</p>
        {cwm.eligiblePath && <code>{cwm.eligiblePath}</code>}
        {ready && (
          <p className="cwm-help">
            Scene autosaves to the board file via the CWM sidecar (not an agent action). Action
            notes appear under stickies on the canvas.
          </p>
        )}
      </section>

      {ready && cwm.workspace?.openingBrief && (
        <section className="cwm-panel">
          <h3>Opening brief</h3>
          <p>{cwm.workspace.openingBrief.summary}</p>
        </section>
      )}
    </aside>
  );
}
