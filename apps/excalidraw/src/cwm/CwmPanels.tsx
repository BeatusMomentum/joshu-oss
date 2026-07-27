import {
  CWM_LAYERS,
  CWM_OBJECT_KINDS,
  CWM_STATUSES,
  type CwmLayer,
  type CwmObjectKind,
  type CwmStatus,
} from "@joshu/whiteboard-cwm";
import { useState } from "react";

import { summarizeCwmOperation } from "./sceneMaterializer";
import type { CwmWorkspaceController } from "./useCwmWorkspace";

export function CwmPanels({ cwm }: { readonly cwm: CwmWorkspaceController }) {
  const [kind, setKind] = useState<CwmObjectKind>("Comment");
  const [layer, setLayer] = useState<CwmLayer>("EVIDENCE");
  const [objectStatus, setObjectStatus] = useState<CwmStatus>("CAPTURED");
  const [regionTitle, setRegionTitle] = useState("");
  const ready = cwm.status.kind === "ready";

  return (
    <aside className="cwm-sidebar" aria-label="Curatorial Whiteboard controls">
      <section className="cwm-panel cwm-status-panel">
        <div className="cwm-panel-heading">
          <h2>Curatorial workspace</h2>
          <span className={`cwm-status cwm-status-${cwm.status.kind}`}>{cwm.status.kind}</span>
        </div>
        <p>{cwm.status.message}</p>
        {cwm.eligiblePath && <code>{cwm.eligiblePath}</code>}
      </section>

      {ready && cwm.workspace && (
        <>
          <section className="cwm-panel">
            <h3>Type selected elements</h3>
            <p className="cwm-help">
              Promote ordinary shapes into semantic objects with human provenance.
            </p>
            <label>
              Object kind
              <select value={kind} onChange={(event) => setKind(event.target.value as CwmObjectKind)}>
                {CWM_OBJECT_KINDS.map((value) => (
                  <option key={value}>{value}</option>
                ))}
              </select>
            </label>
            <div className="cwm-field-row">
              <label>
                Layer
                <select value={layer} onChange={(event) => setLayer(event.target.value as CwmLayer)}>
                  {CWM_LAYERS.map((value) => (
                    <option key={value}>{value}</option>
                  ))}
                </select>
              </label>
              <label>
                Status
                <select
                  value={objectStatus}
                  onChange={(event) => setObjectStatus(event.target.value as CwmStatus)}
                >
                  {CWM_STATUSES.map((value) => (
                    <option key={value}>{value}</option>
                  ))}
                </select>
              </label>
            </div>
            <button
              type="button"
              disabled={!cwm.selectedElements.length || cwm.mutationBusy}
              onClick={() => {
                void cwm
                  .promoteSelection({ kind, layer, status: objectStatus })
                  .catch(() => undefined);
              }}
            >
              Propose typing {cwm.selectedElements.length ? `(${cwm.selectedElements.length})` : ""}
            </button>
          </section>

          <section className="cwm-panel">
            <h3>Selection inspector</h3>
            {!cwm.selectedObjects.length && <p className="cwm-empty">No typed objects selected.</p>}
            {cwm.selectedObjects.map((object) => (
              <article className="cwm-inspector-object" key={object.id}>
                <strong>{object.title || object.kind}</strong>
                <dl>
                  <div><dt>Kind</dt><dd>{object.kind}</dd></div>
                  <div><dt>Layer</dt><dd>{object.layer}</dd></div>
                  <div><dt>Status</dt><dd>{object.status}</dd></div>
                  <div><dt>Created by</dt><dd>{object.createdBy}</dd></div>
                </dl>
                <details>
                  <summary>Provenance ({object.provenance.length})</summary>
                  {object.provenance.map((provenance) => (
                    <p key={provenance.id}>
                      <b>{provenance.kind}</b> · {provenance.capturedBy}
                      {provenance.excerpt ? ` — ${provenance.excerpt}` : ""}
                    </p>
                  ))}
                </details>
              </article>
            ))}
            {cwm.selectedObjects.length > 0 && (
              <div className="cwm-promotion-actions" aria-label="Promote selected typed objects">
                <button
                  type="button"
                  disabled={cwm.mutationBusy}
                  onClick={() => void cwm.promoteSelectedObjects("ENDORSE").catch(() => undefined)}
                >
                  Endorse
                </button>
                <button
                  type="button"
                  className="cwm-secondary-button"
                  disabled={cwm.mutationBusy}
                  onClick={() => void cwm.promoteSelectedObjects("DISPUTE").catch(() => undefined)}
                >
                  Mark disputed
                </button>
                <button
                  type="button"
                  disabled={cwm.mutationBusy}
                  onClick={() => void cwm.promoteSelectedObjects("COMMIT").catch(() => undefined)}
                >
                  Commit/Decide
                </button>
                <small>Each action enters the review tray before changing accepted semantics.</small>
              </div>
            )}
          </section>

          <section className="cwm-panel">
            <h3>Soft regions</h3>
            <div className="cwm-inline-form">
              <input
                value={regionTitle}
                onChange={(event) => setRegionTitle(event.target.value)}
                placeholder="Region title"
                aria-label="Region title"
              />
              <button
                type="button"
                disabled={!regionTitle.trim() || !cwm.selectedElements.length || cwm.mutationBusy}
                onClick={() => {
                  const title = regionTitle;
                  setRegionTitle("");
                  void cwm.createRegion(title).catch(() => setRegionTitle(title));
                }}
              >
                Create
              </button>
            </div>
            <div className="cwm-region-list">
              {Object.values(cwm.workspace.regions).map((region) => (
                <button
                  type="button"
                  className={
                    cwm.focus?.regionIds.includes(region.id)
                      ? "cwm-region-button is-focused"
                      : "cwm-region-button"
                  }
                  key={region.id}
                  onClick={() => void cwm.focusRegion(region).catch(() => undefined)}
                >
                  <span>{region.title}</span>
                  <small>{region.objectIds.length} objects · {region.status}</small>
                </button>
              ))}
              {!Object.keys(cwm.workspace.regions).length && (
                <p className="cwm-empty">Select elements to define a soft region.</p>
              )}
            </div>
          </section>

          <section className="cwm-panel">
            <h3>Opening brief</h3>
            {cwm.workspace.openingBrief ? (
              <>
                <p>{cwm.workspace.openingBrief.summary}</p>
                <small>
                  {cwm.workspace.openingBrief.sourceObjectIds.length} sources · prepared by{" "}
                  {cwm.workspace.openingBrief.preparedBy}
                </small>
              </>
            ) : (
              <p className="cwm-empty">No opening brief has been prepared.</p>
            )}
          </section>

          <section className="cwm-panel">
            <h3>Session handoff</h3>
            <p className="cwm-help">
              Atomically checkpoint the accepted scene, then write a bounded, indexable handoff.
              Pending proposals are excluded from accepted decisions.
            </p>
            <button
              type="button"
              className="cwm-secondary-button"
              disabled={cwm.consolidationBusy || cwm.mutationBusy || cwm.busyProposalId !== null}
              onClick={() => void cwm.checkpointScene().catch(() => undefined)}
            >
              {cwm.consolidationBusy ? "Saving…" : "Checkpoint Board"}
            </button>
            <button
              type="button"
              disabled={cwm.consolidationBusy || cwm.mutationBusy || cwm.busyProposalId !== null}
              onClick={() => void cwm.consolidateSession().catch(() => undefined)}
            >
              {cwm.consolidationBusy ? "Consolidating…" : "Consolidate Session"}
            </button>
            {cwm.handoffPath && (
              <p className="cwm-handoff-path">
                Handoff: <code>{cwm.handoffPath}</code>
              </p>
            )}
          </section>
        </>
      )}

      <section className="cwm-panel cwm-review-tray">
        <div className="cwm-panel-heading">
          <h3>Review tray</h3>
          <span className="cwm-count">{cwm.pendingProposals.length}</span>
        </div>
        {!cwm.pendingProposals.length && <p className="cwm-empty">No pending proposals.</p>}
        {cwm.pendingProposals.map((proposal) => {
          const busy = cwm.busyProposalId === proposal.id;
          return (
            <article className="cwm-proposal" key={proposal.id}>
              <div className="cwm-proposal-meta">
                <strong>{proposal.rationale || "Semantic workspace change"}</strong>
                <span>{proposal.actionClass}</span>
              </div>
              <ul>
                {proposal.operations.map((operation, index) => (
                  <li key={`${proposal.id}-${index}`}>{summarizeCwmOperation(operation)}</li>
                ))}
              </ul>
              <div className="cwm-review-actions">
                <button
                  type="button"
                  disabled={busy || cwm.busyProposalId !== null}
                  onClick={() => void cwm.acceptProposal(proposal)}
                >
                  {busy ? "Working…" : "Accept"}
                </button>
                <button
                  type="button"
                  className="cwm-secondary-button"
                  disabled={busy || cwm.busyProposalId !== null}
                  onClick={() => void cwm.rejectProposal(proposal)}
                >
                  Reject
                </button>
              </div>
            </article>
          );
        })}
      </section>
    </aside>
  );
}
