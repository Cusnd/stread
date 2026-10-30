import { ReaderSelect } from "./ReaderSelect.jsx";
import { lazy, startTransition, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { flushSync } from "react-dom";
import { AnimatePresence } from "motion/react";
import { MotionNotice } from "./Motion.jsx";
import { InlineError } from "./Feedback.jsx";
import { useReaderRuntime } from "./ReaderRuntime.jsx";
import { UI_SCALE_BASE } from "./ui-scale.js";
import { useMedia } from "./workspace/shared.jsx";
import { WORKSPACE_COMPACT_NAVIGATION_WIDTH } from "./workspace/workspace-layout.js";
import { commitPageMotion, stopPageMotion } from "./page-motion.js";
import { bundledDocumentInfo, documentPresentation } from "./bundled-document-info.js";
import { ArrowClockwise, BookOpen, MagnifyingGlass } from "./icons";
import { WorkspaceHeader } from "./workspace/WorkspaceHeader.jsx";
import { ArticleNotesHeader } from "./notes/ArticleNotesHeader.jsx";
import { WorkspaceLoadingShell, WorkspacePageBoundary, WorkspacePagePlaceholder } from "./WorkspaceLoading.jsx";
import { loadCollection, loadFlow, loadQueue, loadReader, loadArticleNotes, loadDocumentPreparation, loadImportDialog, loadRevisionReview, loadWorkspaceSettings, loadWithNavigation, preloadWorkspacePage } from "./workspace-loaders.js";
import { beginNavigationLoading } from "./navigation-loading.js";
import { createReadingActivityTracker } from "./reading-activity.js";
import { createVisiblePoller } from "./visible-poller.js";
import { createRefreshCoordinator } from "./refresh-coordinator.js";
import { createReadingCheckpointQueue } from "./reading-checkpoints.js";
import { createNavigationIntents } from "./navigation-intents.js";
import { isDesktopDevelopment, sameDevelopmentCheckpoint, snapshotDevelopmentState, verifyDevelopmentCheckpoint } from "./development-state.js";
import { canHandleWorkspaceSettings } from "./workspace-shortcuts.js";
import { WorkspaceDialog } from "./WorkspaceDialog.jsx";
import { ReaderInterfaceScale } from "./InterfaceScale.jsx";
import { matchesShortcut } from "./reading-shortcuts.js";
import { accessibleLegacySessions, executeCommand, parseRoute, readViewState, referenceDestination, requestJson, routeUrl, settlePendingCommands, writeViewState } from "./workspace-api.js";
import { getServerWorkspaceNavigationSnapshot, getWorkspaceNavigationSnapshot, migrateWorkspaceNavigation, subscribeWorkspaceNavigation, updateWorkspaceNavigation } from "./workspace-navigation.js";
import { readerReturnRoute, relatedTrail, readingStateForEntry, relatedDestinationState, pushRelatedTrail } from "./related-navigation.js";
import "./workspace-shell.css";

const CollectionPage = lazy(() => loadWithNavigation(loadCollection).then((module) => ({ default: module.CollectionPage })));
const FlowPage = lazy(() => loadWithNavigation(loadFlow).then((module) => ({ default: module.FlowPage })));
const QueuePage = lazy(() => loadWithNavigation(loadQueue).then((module) => ({ default: module.QueuePage })));
const LegacyApp = lazy(() => loadWithNavigation(loadReader).then((module) => ({ default: module.App })));
const ImportDialog = lazy(() => loadWithNavigation(loadImportDialog).then((module) => ({ default: module.ImportDialog })));
const RevisionReview = lazy(() => loadWithNavigation(loadRevisionReview).then((module) => ({ default: module.RevisionReview })));
const WorkspaceSettings = lazy(() => loadWithNavigation(loadWorkspaceSettings).then((module) => ({ default: module.WorkspaceSettings })));
const preloadArticleNotes = () => { void loadArticleNotes().catch(() => {}); };
const isDocumentPage = (page) => page === "reader" || page === "notes";
const isWorkspacePage = (page) => ["collection", "flow", "queue"].includes(page);

function DeferredDialog({ component: Dialog, open, ...props }) {
  const [opened, setOpened] = useState(open);
  useEffect(() => { if (open) setOpened(true); }, [open]);
  // Keep drafts, close animation and focus restoration after the first opening.
  return open || opened ? <WorkspacePageBoundary routeKey="dialog"><Suspense fallback={null}><Dialog {...props} open={open} /></Suspense></WorkspacePageBoundary> : null;
}

function ReferenceDialog({ open, onClose, onNavigate, workspace }) {
  const [value, setValue] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [ambiguousDocuments, setAmbiguousDocuments] = useState([]);
  const [documentId, setDocumentId] = useState("");
  async function resolve(event) {
    event.preventDefault();
    const destination = referenceDestination(value);
    if (!destination) { setError("请输入任务、问题、笔记或请求编号，或阅读器中的引用链接。"); return; }
    setBusy(true); setError("");
    try {
      if (destination.taskId || destination.reference?.startsWith("#T")) {
        const { task } = await requestJson("/api/queue/" + encodeURIComponent(destination.taskId || destination.reference));
        onNavigate({ page: "queue", taskId: task.id }, "", { revealTask: true });
        onClose();
        return;
      }
      const result = destination.reference ? await requestJson("/api/references/" + encodeURIComponent(destination.reference) + (documentId ? "?documentId=" + encodeURIComponent(documentId) : "")) : destination;
      onNavigate({ page: "reader", documentId: result.documentId, insightId: result.insight?.id || result.insightId || null, ...(destination.revision ? { revision: destination.revision } : {}) }, result.changeRequest?.source?.blockId ? "#" + encodeURIComponent(result.changeRequest.source.blockId) : destination.hash);
      onClose();
    } catch (failure) { setError(failure.message); setAmbiguousDocuments(failure.details?.documentIds || []); }
    finally { setBusy(false); }
  }
  return <WorkspaceDialog open={open} onClose={onClose} title="打开引用" busy={busy}><form onSubmit={resolve} className="workspace-form"><label>引用编号或链接<input autoFocus value={value} onChange={(event) => { setValue(event.target.value); setAmbiguousDocuments([]); setDocumentId(""); }} placeholder="#T00001、#Q00001、#N00001、#R00001 或文章链接" /></label>{ambiguousDocuments.length > 0 && <label>旧编号所属文章<ReaderSelect value={documentId} onChange={(event) => setDocumentId(event.target.value)}><option value="">选择文章</option>{ambiguousDocuments.map((id) => <option key={id} value={id}>{workspace.documents.find((item) => item.id === id)?.title || id}</option>)}</ReaderSelect></label>}<InlineError className="workspace-service-error" message={error} /><footer><button type="button" className="ui-button" data-ui-button="text" onClick={onClose}>取消</button><button className="workspace-primary ui-button" data-ui-button="entry" disabled={busy || !value.trim() || (ambiguousDocuments.length > 0 && !documentId)}><MagnifyingGlass size={15} />打开引用</button></footer></form></WorkspaceDialog>;
}

function ServiceGate({ error, retry }) {
  const [token, setToken] = useState("");
  const [failure, setFailure] = useState("");
  const [busy, setBusy] = useState(false);
  async function login(event) {
    event.preventDefault(); setBusy(true); setFailure("");
    try { await requestJson("/api/session", { method: "POST", body: { token } }); setToken(""); retry(); }
    catch (next) { setFailure(next.message); }
    finally { setBusy(false); }
  }
  return <main className="workspace-gate"><BookOpen size={27} /><h1>Stread</h1>{error?.status === 401 ? <form className="workspace-form" onSubmit={login}><p>输入工作台访问令牌以继续。</p><label>访问令牌<input type="password" value={token} onChange={(event) => setToken(event.target.value)} autoComplete="current-password" /></label><InlineError className="workspace-service-error" message={failure} /><button className="workspace-primary ui-button" data-ui-button="entry" disabled={busy || !token}>进入工作台</button></form> : <><p role={error ? "alert" : "status"}>{error ? "暂时无法连接工作台。" : "正在打开工作台…"}</p>{error && <><p className="workspace-muted">{error.message}</p><button className="ui-button" data-ui-button="entry" onClick={retry}><ArrowClockwise size={15} />重新连接</button></>}</>}</main>;
}

function activeFocusKey() { return document.activeElement?.closest("[data-focus-key]")?.dataset.focusKey || null; }
const activitySyncNotice = "阅读时间暂未写入资料库，已在本机保留记录，会自动重试。";
const activityNotices = {
  READING_ACTIVITY_BUFFER_FULL: "阅读时间待保存记录已满，计时暂时暂停；本地保存恢复后会继续。",
  READING_ACTIVITY_STORAGE: "浏览器存储不可用，尚未写入资料库的阅读时间可能在关闭页面后丢失。",
};

export function WorkspaceApp() {
  const [route, setRoute] = useState(() => parseRoute(location.search));
  const { navigationExpanded } = useSyncExternalStore(subscribeWorkspaceNavigation, getWorkspaceNavigationSnapshot, getServerWorkspaceNavigationSnapshot);
  const runtime = useReaderRuntime();
  const { percent } = useSyncExternalStore(runtime.uiScale.subscribe, runtime.uiScale.getSnapshot);
  const compactNavigation = useMedia(`(max-width: ${WORKSPACE_COMPACT_NAVIGATION_WIDTH * percent / UI_SCALE_BASE}px)`);
  const [temporaryNavigation, setTemporaryNavigation] = useState({ page: null, open: false });
  const effectiveNavigationExpanded = compactNavigation ? temporaryNavigation.page === route.page && temporaryNavigation.open : navigationExpanded;
  // A compact navigation dialog is transient, not a new desktop preference.
  useEffect(() => { setTemporaryNavigation({ page: null, open: false }); }, [compactNavigation, route.page]);
  const toggleNavigation = () => compactNavigation
    ? setTemporaryNavigation({ page: route.page, open: !effectiveNavigationExpanded })
    : updateWorkspaceNavigation(!getWorkspaceNavigationSnapshot().navigationExpanded);
  const [navigationEntry, setNavigationEntry] = useState(() => history.state || {});
  const [workspace, setWorkspace] = useState(null);
  const [envelope, setEnvelope] = useState(null);
  const envelopeRef = useRef(envelope);
  const visitedPages = useRef(new Set());
  const [ReaderComponent, setReaderComponent] = useState(null);
  const [NotesComponent, setNotesComponent] = useState(null);
  const [proposals, setProposals] = useState([]);
  const [views, setViews] = useState(() => readViewState(sessionStorage, route.page));
  const [overlay, setOverlay] = useState(null);
  const [importDraft, setImportDraft] = useState(null);
  const [reviewSelection, setReviewSelection] = useState(null);
  const settingsTrigger = useRef(null);
  const [startupError, setStartupError] = useState(null);
  const [documentError, setDocumentError] = useState(null);
  const [notice, setNotice] = useState("");
  const [busyCount, setBusyCount] = useState(0);
  const [attempt, setAttempt] = useState(0);
  const workspaceRef = useRef(null);
  const routeRef = useRef(route);
  const navigationEntryRef = useRef(navigationEntry);
  const readingPositions = useRef(new Map());
  const viewsRef = useRef(views);
  const refreshRef = useRef(null);
  if (!refreshRef.current) refreshRef.current = createRefreshCoordinator();
  const checkpointQueue = useRef(null);
  if (!checkpointQueue.current) checkpointQueue.current = createReadingCheckpointQueue({
    send: (input) => requestJson("/api/commands", { method: "POST", body: input, keepalive: true, signal: AbortSignal.timeout(10000) }),
  });
  const navigationIntents = useRef(null);
  if (!navigationIntents.current) navigationIntents.current = createNavigationIntents();
  const checkpointTimer = useRef(null);
  const loadDocumentSequence = useRef(0);
  const documentLoad = useRef(null);
  const startupRequest = useRef(null);
  const handledHash = useRef(null);
  const entryHash = useRef(location.hash);
  const preparedDocuments = useRef(new Map());
  const activityTracker = useRef(null);
  const activeCommands = useRef(new Set());
  const restoringHistory = useRef(false);
  routeRef.current = route; viewsRef.current = views; workspaceRef.current = workspace; envelopeRef.current = envelope;

  useEffect(() => { migrateWorkspaceNavigation(); }, []);
  useEffect(() => { writeViewState(sessionStorage, { ...views, navigationExpanded }); }, [views, navigationExpanded]);
  useEffect(() => {
    if (!import.meta.hot || !isDesktopDevelopment(window.continuousReaderDesktop)) return;
    const snapshot = (event) => {
      if (!event.detail?.development) return;
      const page = routeRef.current.page;
      const next = { ...viewsRef.current, navigationExpanded: getWorkspaceNavigationSnapshot().navigationExpanded };
      if (isWorkspacePage(page)) next[page] = {
        ...next[page], scrollY: window.scrollY, focusKey: activeFocusKey() || next[page]?.focusKey,
      };
      if (!writeViewState(sessionStorage, next)) event.detail.errors.push(new Error("开发刷新前的工作区视图未写入本地存储。"));
    };
    window.addEventListener("continuous-reader:flush", snapshot);
    return () => window.removeEventListener("continuous-reader:flush", snapshot);
  }, []);

  const updateView = useCallback((page, value) => {
    // Page components still receive their familiar view shape, but only the
    // shared preference owns navigation visibility and its persistence.
    if (typeof value.navigationExpanded === "boolean") {
      if (compactNavigation) setTemporaryNavigation((previous) => previous.page === page && previous.open === value.navigationExpanded ? previous : { page, open: value.navigationExpanded });
      else if (value.navigationExpanded !== navigationExpanded) updateWorkspaceNavigation(value.navigationExpanded);
    }
    const pageView = { ...value };
    delete pageView.navigationExpanded;
    setViews((previous) => {
      const next = { ...previous, [page]: pageView };
      viewsRef.current = next;
      return next;
    });
  }, [navigationExpanded, compactNavigation]);

  useEffect(() => {
    if (!["collection", "flow", "queue", "notes"].includes(route.page)) return;
    const onKey = (event) => {
      if (!canHandleWorkspaceSettings(event, overlay)) return;
      if (!matchesShortcut(event, "settings")) return;
      event.preventDefault();
      if (overlay !== "settings") settingsTrigger.current = document.activeElement;
      setOverlay((current) => current === "settings" ? null : "settings");
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [route.page, overlay]);

  useEffect(() => {
    const tracker = createReadingActivityTracker({
      sendCommand: async (input) => {
        const receipt = await requestJson("/api/commands", { method: "POST", body: input, keepalive: true, signal: AbortSignal.timeout(10000) });
        window.dispatchEvent(new CustomEvent("continuous-reader:activity-synced", { detail: { activityRevision: receipt.activityRevision } }));
        return receipt;
      },
      onError: (error) => setNotice(activityNotices[error?.code] || activitySyncNotice),
      onStatus: ({ error }) => { if (!error) setNotice((current) => current === activitySyncNotice || Object.values(activityNotices).includes(current) ? "" : current); },
    });
    activityTracker.current = tracker;
    return () => { tracker.dispose(); if (activityTracker.current === tracker) activityTracker.current = null; };
  }, []);

  useEffect(() => () => { navigationIntents.current.invalidate(); refreshRef.current.cancel(); stopPageMotion(); }, []);

  const hydrateDocument = useCallback(async (documentId, { foreground = false, signal } = {}) => {
    // Background revalidation waits for the user's foreground navigation; it
    // never takes ownership of that load just because the catalog changed.
    while (signal && documentLoad.current?.foreground) { await documentLoad.current.done; if (signal.aborted) return false; }
    if (signal?.aborted || routeRef.current.documentId !== documentId) return false;
    const previousLoad = documentLoad.current;
    foreground ||= Boolean(previousLoad?.foreground);
    const controller = new AbortController();
    const finish = foreground ? beginNavigationLoading() : () => {};
    // Start the replacement token before releasing its predecessor.
    previousLoad?.cancel();
    const load = { foreground, cancel: () => { controller.abort(); finish(); } };
    load.done = new Promise((resolve) => { load.resolve = resolve; });
    const abort = () => controller.abort(signal.reason);
    signal?.addEventListener("abort", abort, { once: true });
    documentLoad.current = load;
    const sequence = ++loadDocumentSequence.current;
    try {
      const revision = routeRef.current.revision;
      const page = routeRef.current.page;
      const endpoint = "/api/documents/" + encodeURIComponent(documentId);
      const [next, relations, pageModule, preparation] = await Promise.all([
        requestJson(endpoint + (revision ? "?revision=" + revision : ""), { signal: controller.signal }),
        page === "notes" ? null : requestJson(endpoint + "/relations" + (revision ? "?revision=" + revision : ""), { signal: controller.signal })
          .catch((error) => ({ documentId, outgoing: [], incoming: [], error: error.message })),
        page === "notes" ? loadArticleNotes() : loadReader(), page === "notes" ? null : loadDocumentPreparation(),
      ]);
      const key = JSON.stringify([next.document.id, next.document.revision]);
      let compiled = preparedDocuments.current.get(key) || (page === "notes" ? { document: next.document } : null);
      if (!compiled) {
        try { compiled = { document: await preparation.prepareReaderDocument(next.document) }; }
        catch (error) { compiled = { document: next.document, preparationError: error.message }; }
        preparedDocuments.current.set(key, compiled);
        if (preparedDocuments.current.size > 8) preparedDocuments.current.delete(preparedDocuments.current.keys().next().value);
      }
      if (controller.signal.aborted || sequence !== loadDocumentSequence.current || routeRef.current.documentId !== documentId || routeRef.current.page !== page) return false;
      // The Reader must be available in the same commit as the prepared paper:
      // entry-hash restoration and foreground activity start depend on its DOM.
      const commit = () => {
        if (controller.signal.aborted || sequence !== loadDocumentSequence.current || routeRef.current.documentId !== documentId || routeRef.current.page !== page) return;
        if (page === "notes") setNotesComponent(() => pageModule.ArticleNotesPage);
        else setReaderComponent(() => pageModule.Reader);
        setEnvelope({ ...next, ...compiled, relations, readerReady: page === "reader" || preparedDocuments.current.has(key) });
        setDocumentError(null);
      };
      // A new document can dissolve into its prepared, restored reading view.
      // Background refreshes keep the live article and selection untouched.
      if (!envelopeRef.current || envelopeRef.current.document.id !== documentId) commitPageMotion(() => flushSync(commit), { scope: "reader-page" });
      else commit();
      return true;
    } catch (error) {
      if (signal) throw error;
      if (!controller.signal.aborted && sequence === loadDocumentSequence.current) setDocumentError(error);
      return false;
    }
    finally { signal?.removeEventListener("abort", abort); finish(); load.resolve(); if (documentLoad.current === load) documentLoad.current = null; }
  }, []);

  const refresh = useCallback((options = {}) => refreshRef.current.run(async (signal) => {
      const [next, review] = await Promise.all([requestJson("/api/workspace?includeArchived=1", { conditional: true, signal }), requestJson("/api/proposals", { conditional: true, signal })]);
      signal.throwIfAborted();
      const changed = next.revision !== workspaceRef.current?.revision;
      if (changed && isDocumentPage(routeRef.current.page)) {
        const documentId = routeRef.current.documentId;
        const hydrated = await hydrateDocument(documentId, { signal });
        if (!hydrated && isDocumentPage(routeRef.current.page) && routeRef.current.documentId === documentId) throw new DOMException("Refresh was replaced", "AbortError");
      }
      signal.throwIfAborted();
      setWorkspace((previous) => previous?.revision === next.revision ? previous : next);
      workspaceRef.current = next;
      setProposals((previous) => JSON.stringify(previous) === JSON.stringify(review.proposals) ? previous : review.proposals);
      return next;
  }, options), [hydrateDocument]);

  useEffect(() => {
    if (route.page === "legacy") return;
    let cancelled = false;
    const finish = beginNavigationLoading();
    setStartupError(null);
    // Share the actual request across StrictMode's setup/cleanup replay.
    if (!startupRequest.current || startupRequest.current.attempt !== attempt) {
      const workspaceRequest = (async () => {
        const initial = await requestJson("/api/workspace?includeArchived=1");
        const sessions = accessibleLegacySessions(initial, sessionStorage);
        for (const session of sessions) await executeCommand({ kind: "legacy.import", ...session });
        return sessions.length ? requestJson("/api/workspace?includeArchived=1") : initial;
      })();
      startupRequest.current = { attempt, workspaceRequest, proposalsRequest: requestJson("/api/proposals") };
    }
    startupRequest.current.workspaceRequest.then((initial) => {
      if (!cancelled) { workspaceRef.current = initial; setWorkspace(initial); }
    }).catch((error) => { if (!cancelled) setStartupError(error); }).finally(finish);
    // Review metadata does not hold the whole workspace behind a loading gate.
    startupRequest.current.proposalsRequest.then((review) => { if (!cancelled) setProposals(review.proposals); }).catch(() => {});
    return () => { cancelled = true; finish(); };
  }, [attempt, route.page === "legacy"]);

  useEffect(() => {
    if (!workspace || route.page === "legacy") return;
    const poller = createVisiblePoller({
      // This checks the local service. Cloud polling has its own scheduler;
      // backing this off would hide an already received edit for 30 seconds.
      isVisible: () => document.visibilityState === "visible", intervalMs: 2000, maxIntervalMs: 2000,
      run: async (signal) => {
        const revision = workspaceRef.current?.revision;
        const state = await requestJson("/api/changes?after=" + (revision || 0), { signal });
        if (signal.aborted || state.revision === revision) return false;
        await refresh({ signal }); return true;
      },
    });
    poller.start({ immediate: false });
    window.addEventListener("focus", poller.wake);
    document.addEventListener("visibilitychange", poller.wake);
    return () => { poller.dispose(); window.removeEventListener("focus", poller.wake); document.removeEventListener("visibilitychange", poller.wake); };
  }, [Boolean(workspace), refresh, route.page === "legacy"]);

  useEffect(() => {
    if (!isDocumentPage(route.page) || !workspace) { setEnvelope(null); return; }
    setEnvelope((previous) => previous?.document.id === route.documentId ? previous : null);
    setDocumentError(null);
    hydrateDocument(route.documentId, { foreground: true });
    return () => { loadDocumentSequence.current++; documentLoad.current?.cancel(); };
  }, [route.documentId, route.revision, route.page, Boolean(workspace), hydrateDocument]);

  const command = useCallback((input, options) => {
    setBusyCount((count) => count + 1);
    const operation = (async () => {
      const result = await executeCommand(input, options);
      try { await refresh({ minimumRevision: result.revision }); } catch { setNotice("已保存。连接恢复后会更新页面。"); }
      return result;
    })();
    activeCommands.current.add(operation);
    return operation.finally(() => {
      activeCommands.current.delete(operation);
      setBusyCount((count) => Math.max(0, count - 1));
    });
  }, [refresh]);

  const flushCheckpoint = useCallback(async ({ documentId, throwOnError = false } = {}) => {
    clearTimeout(checkpointTimer.current);
    const status = await checkpointQueue.current.flush(documentId);
    if (status.pending || status.errors.length) {
      setNotice("阅读位置尚未保存，连接恢复后会重试。");
      if (throwOnError) throw status.errors[0] || new Error("阅读位置尚未保存，请稍后重试。");
    } else {
      setNotice((current) => current === "阅读位置尚未保存，连接恢复后会重试。" ? "" : current);
    }
    return status;
  }, []);

  const saveCheckpoint = useCallback((readingState, options = {}) => {
    if (!readingState) return;
    const documentId = readingState.documentId || routeRef.current.documentId;
    const development = import.meta.hot && isDesktopDevelopment(window.continuousReaderDesktop);
    const unchanged = development && sameDevelopmentCheckpoint(readingPositions.current.get(documentId), readingState);
    readingPositions.current.set(documentId, readingState);
    // A departing Reader may flush after history already points at another
    // entry. Persist its position, but do not overwrite the destination journey.
    const entryKey = navigationEntryRef.current.readerEntryKey || null;
    if (!restoringHistory.current && routeRef.current.page === "reader" && routeRef.current.documentId === documentId
      && (!Object.hasOwn(options, "entryKey") || options.entryKey === entryKey)
      && (history.state?.readerEntryKey || null) === entryKey) {
      activityTracker.current?.updatePosition(readingState);
      const next = { ...navigationEntryRef.current, readerPosition: readingState };
      navigationEntryRef.current = next;
      history.replaceState({ ...history.state, ...next }, "");
      // Keep the current entry in a ref: checkpoints must not rerender/remount
      // the reader while the user is selecting text or entering an annotation.
    }
    if (!unchanged) checkpointQueue.current.enqueue(documentId, readingState);
    if (development && options.enqueueOnly) {
      const pending = checkpointQueue.current.position(documentId);
      if (pending) verifyDevelopmentCheckpoint(sessionStorage, documentId, pending);
      return;
    }
    if (unchanged) return;
    clearTimeout(checkpointTimer.current);
    checkpointTimer.current = setTimeout(flushCheckpoint, 700);
  }, [flushCheckpoint]);

  const saveReaderCheckpoint = useCallback((readingState, options = {}) => saveCheckpoint(readingState,
    { ...options, entryKey: navigationEntry.readerEntryKey || null }), [saveCheckpoint, navigationEntry.readerEntryKey]);

  useEffect(() => {
    // The loopback workspace stays reachable without an internet connection.
    const retry = () => { if (checkpointQueue.current.hasPending()) void flushCheckpoint(); };
    const timer = setInterval(retry, 5000);
    window.addEventListener("focus", retry);
    return () => { clearInterval(timer); window.removeEventListener("focus", retry); };
  }, [flushCheckpoint]);

  useEffect(() => {
    const save = () => { void flushCheckpoint(); };
    window.addEventListener("pagehide", save);
    return () => { window.removeEventListener("pagehide", save); clearTimeout(checkpointTimer.current); };
  }, [flushCheckpoint]);

  const rememberPage = useCallback(() => {
    const page = routeRef.current.page;
    if (isWorkspacePage(page)) updateView(page, { ...viewsRef.current[page], scrollY: window.scrollY, focusKey: activeFocusKey() || viewsRef.current[page]?.focusKey });
  }, [updateView]);

  const navigate = useCallback((destination, hash = "", options = {}) => {
    navigationIntents.current.invalidate();
    const previousPage = routeRef.current.page;
    let next = typeof destination === "string" ? { page: destination } : destination;
    if (next.page === "flow" && !next.section) next = { ...next, section: viewsRef.current.flow.section || "overview" };
    rememberPage();
    if (next.page === "queue" && next.taskId && options.revealTask) updateView("queue", { ...viewsRef.current.queue, selectedId: next.taskId, type: "all", status: "all", query: "", scrollTop: 0, draft: null, ...(options.clearQueueDraft ? { savedDraft: null } : {}) });
    window.dispatchEvent(new Event("continuous-reader:flush"));
    flushCheckpoint();
    activityTracker.current?.end("navigation");
    const entry = { readerEntryKey: crypto.randomUUID(),
      readerTrail: options.trail || [], readerPosition: options.readingState || null, editInsightId: options.editInsightId || null,
      ...(isDocumentPage(next.page) ? { readerReturn: readerReturnRoute(navigationEntryRef.current, routeRef.current) } : {}),
      ...(options.notesReturn ? { notesReturn: options.notesReturn } : {}) };
    history.pushState(entry, "", routeUrl(next) + (hash || ""));
    navigationEntryRef.current = entry;
    handledHash.current = null;
    entryHash.current = hash;
    routeRef.current = next;
    const commit = () => {
      // Reset before mounting: Reader restores its anchor in a layout effect.
      // Resetting after flushSync would erase that restoration in reduced motion.
      if (isDocumentPage(next.page)) window.scrollTo({ top: 0, behavior: "instant" });
      setNavigationEntry(entry); setRoute(next); setOverlay(null);
    };
    if (isWorkspacePage(previousPage) && isWorkspacePage(next.page) && !visitedPages.current.has(next.page)) commitPageMotion(() => startTransition(commit), { enabled: false });
    else commitPageMotion(() => flushSync(commit), { scope: isDocumentPage(previousPage) || isDocumentPage(next.page) ? "reader-page" : "page" });
  }, [rememberPage, flushCheckpoint, updateView]);

  const readerReturn = readerReturnRoute(navigationEntry);
  const readerBackLabel = readerReturn.page === "queue" ? "返回 Queue" : readerReturn.page === "flow" ? "返回 Flow" : "返回资料库";
  const returnFromReader = useCallback(() => navigate(readerReturnRoute(navigationEntryRef.current)), [navigate]);

  useEffect(() => {
    const pop = () => {
      navigationIntents.current.invalidate();
      const previousPage = routeRef.current.page;
      const entry = history.state || {};
      rememberPage();
      restoringHistory.current = true;
      try { window.dispatchEvent(new Event("continuous-reader:flush")); }
      finally { restoringHistory.current = false; }
      flushCheckpoint();
      activityTracker.current?.end("history-navigation");
      navigationEntryRef.current = entry;
      handledHash.current = null;
      entryHash.current = location.hash;
      const next = parseRoute(location.search); routeRef.current = next;
      const commit = () => { setNavigationEntry(entry); setRoute(next); setOverlay(null); };
      if (isWorkspacePage(previousPage) && isWorkspacePage(next.page) && !visitedPages.current.has(next.page)) commitPageMotion(() => startTransition(commit), { enabled: false });
      else commitPageMotion(() => flushSync(commit), { scope: isDocumentPage(previousPage) || isDocumentPage(next.page) ? "reader-page" : "page" });
    };
    window.addEventListener("popstate", pop);
    return () => window.removeEventListener("popstate", pop);
  }, [rememberPage, flushCheckpoint]);

  useLayoutEffect(() => {
    if (!workspace || !isWorkspacePage(route.page)) return;
    document.title = ({ flow: "Flow", queue: "Queue", collection: "Collection" })[route.page] + " · Stread";
    const frame = requestAnimationFrame(() => {
      if (document.querySelector(route.page === "queue" ? ".queue-page" : route.page === "flow" ? ".flow-page" : ".workspace-collection")) visitedPages.current.add(route.page);
      const view = viewsRef.current[route.page] || {};
      window.scrollTo({ top: view.scrollY || 0, behavior: "instant" });
      if (view.focusKey) [...document.querySelectorAll("[data-focus-key]")].find((element) => element.dataset.focusKey === view.focusKey && element.getClientRects().length && !element.disabled && !element.closest("[inert]"))?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [route.page, Boolean(workspace)]);

  const openDocument = useCallback(async (id, options = {}) => {
    const intent = navigationIntents.current.begin(beginNavigationLoading());
    // Start the code download in parallel with the reading-open command.
    loadReader().catch(() => {});
    rememberPage();
    try {
      // Settle the previous position before an explicit restart can clear it.
      if (options.restart) await flushCheckpoint({ documentId: id, throwOnError: true });
      if (!intent.current()) return;
      await command({ kind: "reading.open", documentId: id, restart: Boolean(options.restart) });
      if (!intent.current()) return;
      if (options.restart) readingPositions.current.delete(id);
      navigate({ page: "reader", documentId: id, insightId: options.insightId || null, ...(options.revision ? { revision: options.revision } : {}) }, options.hash || "", {
        readingState: options.readingState || options.position || null, editInsightId: options.editInsightId,
      });
    } catch (error) { if (intent.current()) throw error; }
    finally { intent.finish(); }
  }, [command, navigate, rememberPage, flushCheckpoint]);

  const setFlowView = useCallback((value) => {
    const section = ["overview", "insights", "plan", "history"].includes(value.section) ? value.section : "overview";
    const sectionChanged = viewsRef.current.flow.section !== section;
    updateView("flow", { ...value, section });
    // A captured transition can leave the outgoing Flow briefly interactive.
    // An explicit section click there is a newer navigation intention; ordinary
    // scroll/view-state updates must not cancel the page the user is entering.
    if (sectionChanged && route.page === "flow" && routeRef.current.page !== "flow") {
      navigate({ page: "flow", section });
      return;
    }
    if (routeRef.current.page === "flow" && routeRef.current.section !== section) {
      navigationIntents.current.invalidate();
      stopPageMotion();
      const next = { page: "flow", section };
      history.replaceState(history.state, "", routeUrl(next));
      routeRef.current = next; setRoute(next);
    }
  }, [updateView, navigate, route.page]);

  const editFlowInsight = useCallback((insight) => openDocument(insight.documentId, { insightId: insight.id, editInsightId: insight.id }), [openDocument]);

  const setQueueView = useCallback((value) => {
    updateView("queue", value);
    if (routeRef.current.page !== "queue") return;
    const taskId = value.selectedId || undefined;
    if (routeRef.current.taskId === taskId) return;
    const next = { page: "queue", ...(taskId ? { taskId } : {}) };
    history.replaceState(history.state, "", routeUrl(next));
    routeRef.current = next; setRoute(next);
  }, [updateView]);

  const openImport = useCallback((draft = null) => { setImportDraft(draft); setOverlay("import"); }, []);
  const openQueueTaskDialog = useCallback(() => {
    const current = viewsRef.current.queue || {};
    setQueueView({ ...current, draft: current.savedDraft || { type: ["conversion", "correction", "translation", "question", "instruction"].includes(current.type) ? current.type : "conversion", body: "" } });
  }, [setQueueView]);
  const queuedImport = useCallback((task) => {
    navigate({ page: "queue", taskId: task.id }, "", { revealTask: true, clearQueueDraft: Boolean(importDraft) });
    setNotice(`${task.reference} 已加入队列`);
  }, [navigate, importDraft]);
  const reviewQueueTask = useCallback((task) => {
    setReviewSelection(task?.proposal?.id || task?.proposalId || task?.result?.proposalId || null);
    setOverlay("review");
  }, []);

  const openArticleNotes = useCallback(async (readingState) => {
    const origin = { ...routeRef.current };
    if (origin.page !== "reader") return;
    const originEntry = navigationEntryRef.current;
    const intent = navigationIntents.current.begin(beginNavigationLoading());
    try {
      const module = await loadArticleNotes();
      if (!intent.current()) return;
      window.dispatchEvent(new Event("continuous-reader:flush"));
      setNotesComponent(() => module.ArticleNotesPage);
      navigate({ page: "notes", documentId: origin.documentId }, "", {
        notesReturn: { route: origin, readingState: readingPositions.current.get(origin.documentId) || readingState, trail: relatedTrail(originEntry) },
      });
    } catch (error) { if (intent.current()) setNotice(error.message || "暂时无法打开文章笔记。"); }
    finally { intent.finish(); }
  }, [navigate]);

  const returnFromNotes = useCallback((note) => {
    const documentId = routeRef.current.documentId;
    const previous = navigationEntryRef.current.notesReturn;
    const origin = previous?.route?.page === "reader" && previous.route.documentId === documentId ? previous : null;
    const savedPosition = origin?.readingState || readingPositions.current.get(documentId)
      || checkpointQueue.current.position(documentId) || workspaceRef.current?.documents.find((item) => item.id === documentId)?.readingState;
    const source = note?.blockId ? note : note?.sources?.[0];
    const destination = source ? { page: "reader", documentId, insightId: note.id, revision: source.revision || note.revision }
      : { ...(origin?.route || { page: "reader", documentId }), insightId: null };
    navigate(destination, "", { trail: origin?.trail || [], readingState: source
      ? { ...relatedDestinationState(documentId, source, savedPosition), revision: source.revision || note.revision }
      : savedPosition });
  }, [navigate]);

  // Bind the document to the page's callback. A late auto-save must never target
  // a different article merely because navigation changed routeRef meanwhile.
  const saveArticleNote = useCallback(async (insight, options) => (await command({ kind: "insight.save", documentId: route.documentId, insight, ...(insight.version ? { expectedVersion: insight.version } : {}) }, options)).insight, [command, route.documentId]);
  const archiveArticleNote = useCallback(async (insight) => (await command({ kind: "insight.archive", documentId: route.documentId, insightId: insight.id, expectedVersion: insight.version })).insight, [command, route.documentId]);
  const restoreArticleNote = useCallback(async (insight) => (await command({ kind: "insight.restore", documentId: route.documentId, insightId: insight.id, expectedVersion: insight.version })).insight, [command, route.documentId]);

  const openRelatedDocument = useCallback(async ({ documentId, source, returnReadingState }) => {
    const intent = navigationIntents.current.begin(beginNavigationLoading());
    const origin = { ...routeRef.current };
    const originEntry = navigationEntryRef.current;
    if (returnReadingState) saveCheckpoint(returnReadingState);
    try {
      // Publish the exact origin before reading.open changes the current article.
      await flushCheckpoint();
      if (!intent.current()) return;
      const trail = pushRelatedTrail(originEntry, origin,
        workspaceRef.current?.documents.find((item) => item.id === origin.documentId)?.title || "文章",
        returnReadingState || readingPositions.current.get(origin.documentId));
      await command({ kind: "reading.open", documentId, restart: false });
      if (!intent.current()) return;
      const previous = readingPositions.current.get(documentId) || checkpointQueue.current.position(documentId)
        || workspaceRef.current?.documents.find((item) => item.id === documentId)?.readingState;
      navigate({ page: "reader", documentId }, "", {
        trail, readingState: relatedDestinationState(documentId, source, previous),
      });
    } catch (error) { if (intent.current()) throw error; }
    finally { intent.finish(); }
  }, [command, navigate, saveCheckpoint, flushCheckpoint]);

  const returnToRelatedDocument = useCallback(async () => {
    const trail = relatedTrail(navigationEntryRef.current), previous = trail.pop();
    if (!previous) return;
    const intent = navigationIntents.current.begin(beginNavigationLoading());
    try {
      await command({ kind: "reading.open", documentId: previous.route.documentId, restart: false });
      if (!intent.current()) return;
      navigate(previous.route, "", { trail, readingState: previous.readingState });
    } catch (error) { if (intent.current()) setNotice(error.message || "暂时无法返回来源文章。"); }
    finally { intent.finish(); }
  }, [command, navigate]);

  const saveInsight = useCallback(async (insight, options) => (await command({ kind: "insight.save", documentId: routeRef.current.documentId, insight, ...(insight.version ? { expectedVersion: insight.version } : {}) }, options)).insight, [command]);
  const saveChangeRequest = useCallback(async (changeRequest, expectedVersion, options) => (await command({ kind: "change_request.save", documentId: routeRef.current.documentId, changeRequest, ...(expectedVersion ? { expectedVersion } : {}) }, options)).changeRequest, [command]);
  const changeRequestStatus = useCallback(async (request, status) => (await command({ kind: status === "cancelled" ? "change_request.cancel" : "change_request.reopen", documentId: routeRef.current.documentId, changeRequestId: request.id, expectedVersion: request.version })).changeRequest, [command]);
  const archiveInsight = useCallback(async (insight) => (await command({ kind: "insight.archive", documentId: routeRef.current.documentId, insightId: insight.id, expectedVersion: insight.version })).insight, [command]);
  const restoreInsight = useCallback(async (insight) => (await command({ kind: "insight.restore", documentId: routeRef.current.documentId, insightId: insight.id, expectedVersion: insight.version })).insight, [command]);
  const reviewInsight = useCallback(async (insight) => (await command({ kind: insight.review?.pending ? "insight.review.remove" : "insight.review.add", documentId: routeRef.current.documentId, insightId: insight.id })).insight, [command]);
  const prepared = useMemo(() => {
    if (!envelope) return {};
    if (envelope.preparationError) return { error: envelope.preparationError };
    return { paper: { ...envelope.document, assetBase: envelope.assetBase, libraryTitle: envelope.record.title, sessionKey: envelope.document.id, downloads: [{ path: "../export?revision=" + envelope.document.revision, label: "结构化文档" }, ...(bundledDocumentInfo(envelope.document).downloads || [])], presentation: documentPresentation(envelope.document) } };
  }, [envelope?.document, envelope?.assetBase, envelope?.record.title, envelope?.preparationError]);
  const paper = prepared.paper;
  const initialReadingState = paper ? readingStateForEntry(navigationEntry, paper.id,
    readingPositions.current.get(paper.id) || checkpointQueue.current.position(paper.id) || envelope.readingState) : null;
  const desiredRevision = route.revision || workspace?.documents.find((item) => item.id === route.documentId)?.revision;
  const relatedReturn = relatedTrail(navigationEntry).at(-1);
  const pendingCount = proposals.filter((item) => item.status === "pending" || item.status === "proposed").length;

  useEffect(() => {
    if (route.page !== "reader" || !envelope?.readerReady || !ReaderComponent || !paper || paper.id !== route.documentId || (desiredRevision && paper.revision !== desiredRevision)) {
      activityTracker.current?.end("leave-reader");
      return;
    }
    const candidate = readingStateForEntry(navigationEntryRef.current, paper.id,
      readingPositions.current.get(paper.id) || checkpointQueue.current.position(paper.id) || envelope?.readingState);
    const position = candidate && (!candidate.documentId || candidate.documentId === paper.id)
      && (candidate.revision == null || candidate.revision === paper.revision)
      && (!candidate.blockId || paper.blocks.some((block) => block.id === candidate.blockId)) ? candidate : null;
    activityTracker.current?.start({ documentId: paper.id, documentRevision: paper.revision, position, mode: position?.mode || "bilingual" });
  }, [route.page, route.documentId, desiredRevision, paper?.id, paper?.revision, envelope?.readerReady, ReaderComponent, navigationEntry]);

  useEffect(() => {
    const desktop = window.continuousReaderDesktop;
    if (!desktop?.onBeforeClose) return;
    return desktop.onBeforeClose(async () => {
      navigationIntents.current.invalidate();
      const commandErrors = [];
      while (activeCommands.current.size) {
        const results = await Promise.allSettled([...activeCommands.current]);
        commandErrors.push(...results.filter((result) => result.status === "rejected").map((result) => result.reason));
      }
      const commands = await settlePendingCommands();
      commandErrors.push(...commands.errors);
      // The Reader publishes its current viewport/drafts synchronously, before
      // the host is allowed to close the window and stop the workspace service.
      if (import.meta.hot && isDesktopDevelopment(desktop)) {
        const snapshot = snapshotDevelopmentState(window, "before-close");
        if (!snapshot.ok) throw snapshot.errors[0];
      } else window.dispatchEvent(new Event("continuous-reader:flush"));
      const tracker = activityTracker.current;
      tracker?.end("window-close");
      const [checkpointStatus, activityStatus] = await Promise.all([
        flushCheckpoint(), tracker?.flush(),
      ]);
      if (commandErrors.length || checkpointStatus.pending || checkpointStatus.errors.length || activityStatus?.pending || activityStatus?.error) {
        // A failed close leaves the window usable, including a fresh foreground
        // reading session if the user is still looking at this document.
        if (routeRef.current.page === "reader" && paper?.id === routeRef.current.documentId) {
          const position = readingPositions.current.get(paper.id) || checkpointQueue.current.position(paper.id) || envelope?.readingState;
          tracker?.start({ documentId: paper.id, documentRevision: paper.revision, position, mode: position?.mode || "bilingual" });
        }
        throw commandErrors[0] || checkpointStatus.errors[0] || activityStatus?.error?.error || new Error("仍有阅读记录等待保存，请稍后重试关闭。");
      }
    });
  }, [flushCheckpoint, paper?.id, paper?.revision, envelope?.readingState]);

  useEffect(() => {
    if (!paper || paper.id !== route.documentId || !entryHash.current || readingStateForEntry(navigationEntry, paper.id)) return;
    const target = route.documentId + ":" + entryHash.current;
    if (handledHash.current === target) return;
    let blockId;
    try { blockId = decodeURIComponent(entryHash.current.slice(1)); } catch { return; }
    const block = document.getElementById(blockId);
    if (!block) return;
    handledHash.current = target;
    const frame = requestAnimationFrame(() => block.scrollIntoView({ block: "start", behavior: "instant" }));
    return () => cancelAnimationFrame(frame);
  }, [paper, route, navigationEntry]);

  if (route.page === "legacy") return <WorkspacePageBoundary routeKey="legacy"><Suspense fallback={<WorkspaceLoadingShell />}><LegacyApp /></Suspense></WorkspacePageBoundary>;
  if (isDocumentPage(route.page) && !workspace) return startupError ? <ServiceGate error={startupError} retry={() => setAttempt((value) => value + 1)} /> : <WorkspaceLoadingShell page={route.page} />;
  return <>
    {route.page !== "reader" && <ReaderInterfaceScale />}
    {route.page === "notes" ? <div className="workspace-app article-notes-workspace" inert={overlay === "settings"}>
      {envelope?.document.id === route.documentId && NotesComponent ? <WorkspacePageBoundary routeKey={"notes:" + route.documentId}><NotesComponent key={route.documentId} documentId={route.documentId} revision={envelope.document.revision} title={envelope.record.title} notes={envelope.insights} readOnly={Boolean(envelope.readOnly || envelope.record.archivedAt)} onSaveInsight={saveArticleNote} onArchiveInsight={archiveArticleNote} onRestoreInsight={restoreArticleNote} onBack={() => returnFromNotes()} onLocateSource={returnFromNotes} onSettings={(event) => { settingsTrigger.current = event.currentTarget; setOverlay("settings"); }} /></WorkspacePageBoundary> : <>
        <ArticleNotesHeader title={workspace?.documents.find((item) => item.id === route.documentId)?.title || ""} onBack={() => returnFromNotes()} />
        {documentError ? <main className="workspace-gate"><p role="alert">{documentError.message}</p><div className="workspace-actions"><button onClick={() => hydrateDocument(route.documentId, { foreground: true })}>重新加载</button><button onClick={() => returnFromNotes()}>返回阅读</button></div></main> : <main className="article-notes-layout" aria-busy="true" aria-label="正在加载笔记"><aside className="article-notes-sidebar" /><section className="article-notes-content" /></main>}
      </>}
    </div> : route.page === "reader" ? paper && paper.id === route.documentId && envelope.readerReady && (!desiredRevision || paper.revision === desiredRevision) && ReaderComponent ? <ReaderComponent key={paper.id + ":" + (navigationEntry.readerEntryKey || "initial")} paper={paper} insightItems={envelope.insights} changeRequestItems={envelope.changeRequests} onSaveChangeRequest={saveChangeRequest} onChangeRequestStatus={changeRequestStatus} initialReadingState={initialReadingState} onReadingStateChange={saveReaderCheckpoint} onSaveInsight={saveInsight} onDeleteInsight={archiveInsight} onRestoreInsight={restoreInsight} onReviewInsight={reviewInsight} editInsightId={navigationEntry.editInsightId} onBack={returnFromReader} backLabel={readerBackLabel} onOpenNotes={openArticleNotes} onPreloadNotes={preloadArticleNotes} openInsightId={route.insightId} sourceApiBase={"/api/documents/" + encodeURIComponent(paper.id)} glossaryApi="/api/glossary" readOnly={envelope.readOnly} relations={envelope.relations} onRelationCommand={command} onOpenRelatedDocument={openRelatedDocument} onReturnRelatedDocument={relatedReturn ? returnToRelatedDocument : undefined} relatedReturnTitle={relatedReturn?.title} /> : <div className="workspace-app">
      <WorkspaceHeader page="collection" onNavigate={navigate} onPreload={preloadWorkspacePage} />
      {documentError || prepared.error ? <main className="workspace-gate"><p role="alert">{documentError?.message || "当前阅读器无法呈现这份文档，原文件与已保存内容仍保留。"}</p><div className="workspace-actions">{documentError && <button onClick={() => hydrateDocument(route.documentId, { foreground: true })}>重新加载</button>}{prepared.error && <a href={"/api/documents/" + encodeURIComponent(route.documentId) + "/export"}>下载结构化文档</a>}<button onClick={returnFromReader}>{readerBackLabel}</button></div></main> : <WorkspacePagePlaceholder navigationExpanded={effectiveNavigationExpanded} />}
    </div> : <div className="workspace-app" inert={overlay === "settings"}>
      <WorkspaceHeader page={route.page} loading={!workspace} onNavigate={navigate} onPreload={preloadWorkspacePage} onImport={route.page === "collection" ? () => openImport() : undefined} onAddTask={route.page === "queue" ? openQueueTaskDialog : undefined} onReference={() => setOverlay("reference")} onReview={() => reviewQueueTask(null)} onSettings={(event) => { settingsTrigger.current = event.currentTarget; setOverlay("settings"); }} pendingCount={pendingCount} navigationExpanded={effectiveNavigationExpanded} onToggleNavigation={toggleNavigation} />
      {!workspace ? startupError ? <ServiceGate error={startupError} retry={() => setAttempt((value) => value + 1)} /> : <WorkspacePagePlaceholder page={route.page} navigationExpanded={effectiveNavigationExpanded} view={{ ...views[route.page], ...(route.page === "flow" ? { section: route.section || views.flow.section || "overview" } : {}) }} /> : <WorkspacePageBoundary routeKey={route.page}><Suspense fallback={<WorkspacePagePlaceholder page={route.page} navigationExpanded={effectiveNavigationExpanded} view={{ ...views[route.page], ...(route.page === "flow" ? { section: route.section || views.flow.section || "overview" } : {}) }} />}>
        {route.page === "queue" ? <QueuePage workspace={workspace} command={command} openDocument={openDocument} view={{ ...views.queue, navigationExpanded: effectiveNavigationExpanded, ...(route.taskId ? { selectedId: route.taskId } : {}) }} setView={setQueueView} busy={busyCount > 0} onImport={openImport} onReview={reviewQueueTask} /> : route.page === "flow" ? <FlowPage overlayActive={Boolean(overlay)} workspace={workspace} command={command} openDocument={openDocument} onEditInsight={editFlowInsight} view={{ ...views.flow, navigationExpanded: effectiveNavigationExpanded, section: route.section || views.flow.section || "overview" }} setView={setFlowView} busy={busyCount > 0} /> : <CollectionPage workspace={workspace} command={command} openDocument={openDocument} onImport={() => openImport()} view={{ ...views.collection, navigationExpanded: effectiveNavigationExpanded }} setView={(value) => updateView("collection", value)} busy={busyCount > 0} />}
      </Suspense></WorkspacePageBoundary>}
    </div>}
    <AnimatePresence initial={false}>{notice && <MotionNotice key="workspace-notice" className="workspace-toast" role="status"><span>{notice}</span><button onClick={() => setNotice("")}>关闭</button></MotionNotice>}</AnimatePresence>
    <DeferredDialog component={ImportDialog} open={overlay === "import"} onClose={() => setOverlay(null)} command={command} onQueued={queuedImport} initialDraft={importDraft} />
    {route.page !== "reader" && <DeferredDialog component={WorkspaceSettings} open={overlay === "settings"} returnFocusRef={settingsTrigger} onClose={() => setOverlay(null)} />}
    {workspace && <ReferenceDialog open={overlay === "reference"} onClose={() => setOverlay(null)} onNavigate={navigate} workspace={workspace} />}
    {workspace && <DeferredDialog component={RevisionReview} open={overlay === "review"} onClose={() => setOverlay(null)} proposals={proposals} workspace={workspace} command={command} refresh={refresh} initialProposalId={reviewSelection} />}
  </>;
}
