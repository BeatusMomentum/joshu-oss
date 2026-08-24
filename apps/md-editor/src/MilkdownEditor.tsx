/**
 * Milkdown Crepe host — Typora-style WYSIWYG with an imperative API for LLM guiActions.
 *
 * Architecture notes (Milkdown):
 * - Crepe is the batteries-included editor (features = plugins: Toolbar, BlockEdit,
 *   CodeMirror, Table, …). Features are toggled via `Crepe.Feature.*`.
 * - Programmatic edits go through the underlying Editor: `crepe.editor.action(insert|replaceAll)`.
 * - `getMarkdown()` / `markdownUpdated` keep Joshu's snapshot + dirty tracking in sync.
 */

import React, { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import { Crepe } from "@milkdown/crepe";
import { insert, replaceAll } from "@milkdown/kit/utils";

import "@milkdown/crepe/theme/common/style.css";
import "@milkdown/crepe/theme/classic.css";

export type MilkdownEditorHandle = {
  getMarkdown: () => string;
  replaceAll: (markdown: string) => void;
  insert: (markdown: string, inline?: boolean) => void;
  append: (markdown: string) => void;
  focus: () => void;
  ready: () => boolean;
};

export type MilkdownEditorProps = {
  /** Initial markdown when the editor mounts (or when `documentKey` changes). */
  defaultValue: string;
  /** Remount key — change when opening a different file. */
  documentKey: string;
  onMarkdownUpdated?: (markdown: string) => void;
  onReady?: () => void;
};

export const MilkdownEditor = forwardRef<MilkdownEditorHandle, MilkdownEditorProps>(
  function MilkdownEditor({ defaultValue, documentKey, onMarkdownUpdated, onReady }, ref) {
    const hostRef = useRef<HTMLDivElement | null>(null);
    const crepeRef = useRef<Crepe | null>(null);
    const readyRef = useRef(false);
    const onMarkdownUpdatedRef = useRef(onMarkdownUpdated);
    const onReadyRef = useRef(onReady);
    onMarkdownUpdatedRef.current = onMarkdownUpdated;
    onReadyRef.current = onReady;

    useImperativeHandle(
      ref,
      () => ({
        getMarkdown: () => crepeRef.current?.getMarkdown() ?? "",
        replaceAll: (markdown: string) => {
          const crepe = crepeRef.current;
          if (!crepe?.editor) return;
          crepe.editor.action(replaceAll(markdown ?? ""));
        },
        insert: (markdown: string, inline = false) => {
          const crepe = crepeRef.current;
          if (!crepe?.editor) return;
          crepe.editor.action(insert(markdown ?? "", inline));
        },
        append: (markdown: string) => {
          const crepe = crepeRef.current;
          if (!crepe?.editor) return;
          const current = crepe.getMarkdown();
          const sep = current && !current.endsWith("\n") ? "\n\n" : current ? "\n" : "";
          crepe.editor.action(replaceAll(`${current}${sep}${markdown ?? ""}`));
        },
        focus: () => {
          crepeRef.current?.editor?.action((ctx) => {
            // Milkdown focuses via ProseMirror view when available.
            void ctx;
            const root = hostRef.current?.querySelector(".ProseMirror") as HTMLElement | null;
            root?.focus();
          });
        },
        ready: () => readyRef.current,
      }),
      [],
    );

    useEffect(() => {
      const host = hostRef.current;
      if (!host) return;

      let cancelled = false;
      readyRef.current = false;
      host.innerHTML = "";

      const crepe = new Crepe({
        root: host,
        defaultValue: defaultValue || "",
        features: {
          // Keep WYSIWYG rich; skip optional AI provider chrome (Joshu owns agent chat).
          [Crepe.Feature.AI]: false,
          [Crepe.Feature.TopBar]: false,
          [Crepe.Feature.Toolbar]: true,
          [Crepe.Feature.BlockEdit]: true,
          [Crepe.Feature.Placeholder]: true,
          [Crepe.Feature.Cursor]: true,
          [Crepe.Feature.ListItem]: true,
          [Crepe.Feature.LinkTooltip]: true,
          [Crepe.Feature.ImageBlock]: true,
          [Crepe.Feature.CodeMirror]: true,
          [Crepe.Feature.Table]: true,
          [Crepe.Feature.Latex]: false,
        },
        featureConfigs: {
          [Crepe.Feature.Placeholder]: {
            text: "Start writing…",
            mode: "block",
          },
        },
      });

      crepe.on((listener) => {
        listener.markdownUpdated((_ctx, markdown) => {
          onMarkdownUpdatedRef.current?.(markdown);
        });
      });

      void crepe.create().then(() => {
        if (cancelled) {
          void crepe.destroy();
          return;
        }
        crepeRef.current = crepe;
        readyRef.current = true;
        onReadyRef.current?.();
      });

      return () => {
        cancelled = true;
        readyRef.current = false;
        crepeRef.current = null;
        void crepe.destroy();
      };
      // Remount when opening a different document.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [documentKey]);

    return <div className="milkdown-host" ref={hostRef} data-document-key={documentKey} />;
  },
);
