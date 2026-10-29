import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { ReadingSettings } from "./ReadingSettings.jsx";
import { useReaderRuntime } from "./ReaderRuntime.jsx";

/** The workspace opens the same settings surface as the Reader, without a paper. */
export function WorkspaceSettings({ open, onClose, returnFocusRef }) {
  const runtime = useReaderRuntime();
  const { fontSize, readingWidthPercent } = useSyncExternalStore(runtime.reading.subscribe, runtime.reading.getSnapshot);
  const [view, setView] = useState(() => runtime.view.read());
  const viewRef = useRef(view);

  const refreshView = useCallback(() => {
    const next = runtime.view.read();
    viewRef.current = next;
    setView(next);
  }, [runtime]);

  useLayoutEffect(() => {
    if (open) refreshView();
  }, [open, refreshView]);

  useEffect(() => runtime.view.subscribe(refreshView), [runtime, refreshView]);

  const updateView = useCallback((patch) => {
    // Do not write defaults on mount. Merge actual changes into the current
    // in-memory view, so a blocked storage write does not erase earlier choices.
    const next = { ...viewRef.current, ...patch };
    viewRef.current = next;
    runtime.view.save(next);
    setView(next);
  }, [runtime]);

  return <ReadingSettings
    open={open}
    onClose={onClose}
    returnFocusRef={returnFocusRef}
    title="设置"
    fontSize={fontSize}
    onFontSizeChange={(value) => runtime.reading.update({ fontSize: value })}
    readingWidthPercent={readingWidthPercent}
    onReadingWidthChange={(value) => runtime.reading.update({ readingWidthPercent: value })}
    showMargins={view.showMargins}
    onMarginsChange={(value) => updateView({ showMargins: value })}
    openMode={view.insightOpenMode}
    onOpenModeChange={(value) => updateView({ insightOpenMode: value })}
    tocMode={view.tocMode}
    onTocModeChange={(value) => updateView({ tocMode: value })}
    translationFirst={view.translationFirst}
    onTranslationFirstChange={(value) => updateView({ translationFirst: value })}
    pdfAvailable={true}
    pdfFollow={view.pdfFollow}
    onPdfFollowChange={(value) => updateView({ pdfFollow: value })}
  />;
}
