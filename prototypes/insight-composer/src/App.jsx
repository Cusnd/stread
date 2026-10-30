import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { flushSync } from "react-dom";
import { AnimatePresence, motion } from "motion/react";
import { MotionItem, MotionNotice } from "./Motion.jsx";
import { useContextMenu } from "./ContextMenu.jsx";
import { captureArticleSelection, restoreArticleSelection, selectionContextHit } from "./reader-context-selection.js";
import { MOTION_FADE, motionTransition } from "./motion-system.js";
import { useReducedMotionPreference } from "./useReducedMotionPreference.js";
import { useMotionPresence } from "./useMotionPresence.js";
import { useImmediateReducedMotion } from "./useImmediateReducedMotion.js";
import { useCommittedActions } from "./useCommittedActions.js";
import { animateReaderContent, stopPageMotion, stopReaderContentMotion } from "./page-motion.js";
import { developmentReadingState, isDesktopDevelopment } from "./development-state.js";
import { documentPresentation } from "./bundled-document-info.js";
import { ArrowUpRight, BookmarkSimple, Check, ChatText, Copy, Crosshair, Highlighter, NotePencil, PencilSimpleLine, Plus, Question, Translate, Trash, WarningCircle, X } from "./icons";
import katex from "katex";
import "katex/dist/katex.min.css";
import { ComposerActions, ComposerSurface, ComposerTextarea, ComposerTitleField, COMPOSER_TITLE_HEIGHT, MAX_COMPOSER_HEIGHT } from "./ComposerSurface";
import { QuestionDetail } from "./QuestionDetail";
import { MarginGroup } from "./MarginGroup.jsx";
import { MarginGroupDetail } from "./MarginGroupDetail.jsx";
import { buildMarginGroups, layoutMarginGroups, measureMarginSources } from "./margin-groups.js";
import { InsightQuote } from "./InsightQuote";
import { InsightTypePicker } from "./InsightTypePicker";
import { InsightColorPicker } from "./InsightColorPicker";
import { InsightActions } from "./InsightActions";
import { forgetRestored, readInsightHistory, reconcileInsightHistory, rememberDeleted, rememberReferences } from "./insight-history";
import { ReadingSettings } from "./ReadingSettings";
import { ReaderLayoutMotion } from "./ReaderLayoutMotion";
import { GlossaryPanel } from "./GlossaryPanel";
import { ReaderInterfaceScale } from "./InterfaceScale";
import { colorFor, getEnabledColors } from "./highlight-colors";
import { exampleAnswer } from "./question-example";
import { assignReference, assignReferences, hasCurrentReference } from "./references";
import { PaperArticle, PaperToc } from "./PaperArticle";
import { ImageLightbox } from "./ImageLightbox";
import { imagePreviewFromClick } from "./image-preview.js";
import { ReferencePreview, CitationBacklinks } from "./ReferencePreview";
import { useCitationPreview } from "./useCitationPreview.js";
import { ReaderTopbar } from "./ReaderTopbar";
import { attentionNotes } from "./attention-example";
import { normalizeHtmlSource, normalizeMathSource, readTextRange, sourceDescriptor, sourceElement, sourceText } from "./document-content";
import { prepareReaderDocument } from "./html-content";
import { ObjectSizingProvider } from "./ObjectFrame";
import { canSaveInsight, insightFailureMessage, isHighlightOnly } from "./insight-content";
import { ReaderRuntimeProvider, useReaderRuntime } from "./ReaderRuntime";
import { defaultReaderRuntime } from "./reader-runtime.js";
import { ensureDraftIntent } from "./command-intents.js";
import { createDraftAcknowledgements } from "./draft-acknowledgements.js";
import { acknowledgeDraftCommand } from "./workspace-api.js";
import { PdfPanel } from "./PdfPanel";
import { selectedArticleTargets } from "./pdf-selection";
import { usePdfPanelResize } from "./usePdfPanelResize";
import { captureReadingPosition, restoreReadingPosition, readingPositionTop, readingLine, createScrollOwnership, sourceNavigationAnchor, sourceRegions, regionForBlock } from "./reading-position";
import { animateReaderNavigation } from "./reader-navigation-motion.js";
import { readerNavigation } from "./reader-navigation.js";
import { documentAssetUrl } from "./document-resource";
import { acquirePageScrollLock } from "./page-scroll-lock.js";
import { insightWrite, mergeSavedInsights, reconcileInsight, sourceCitation, upsertInsight } from "./reader-state";
import { documentLanguages, languageLabel } from "./reading-language";
import { formatShortcut, matchesShortcut as matchesConfiguredShortcut } from "./reading-shortcuts";
import { canSaveChangeRequest, changeRequestWrite, isChangeRequest } from "./change-requests";
import "./change-requests.css";
import "./object-view.css";
import "./reader-integration.css";

const TYPES = [
  { id: "annotation", label: "批注", Icon: ChatText, placeholder: "写下批注…" },
  { id: "question", label: "问题", Icon: Question, placeholder: "写下问题…" },
  { id: "note", label: "笔记", Icon: NotePencil, placeholder: "记下想法…" },
];
const CHANGE_TYPES = [
  { id: "correction", label: "内容纠错", Icon: WarningCircle, placeholder: "说明哪里出错了…" },
  { id: "translation", label: "译文修改", Icon: Translate, placeholder: "说明译文的问题或修改要求…" },
  { id: "instruction", label: "通用请求", Icon: PencilSimpleLine, placeholder: "希望 AI 做什么？" },
];
const requestEntry = (item) => ({ ...item.source, ...item, intent: "change-request", type: item.category, color: "blue" });
const withoutRequestSource = (draft) => {
  const { source, blockId, variant, field, nodeId, itemId, row, column, start, end, quote, prefix, suffix, sourceType, equationNumber, referenceStatus, ...rest } = draft;
  return { ...rest, quote: "" };
};
const TEXTS = {
  goal: "我们的目标是从人类偏好中学习，同时让新的策略不过分偏离参考模型。关键在于，把奖励函数与最优策略之间的关系写清楚。",
  policy: "在带有 KL 约束的奖励最大化问题中，最优策略可以写成下面的形式。其中，β 控制偏离参考策略的程度，Z(x) 用于归一化。",
  reward: "对上式取对数并整理，可以把奖励写成最优策略与参考策略的对数概率比，加上一个只依赖提示 x 的项。",
  cancel: "当我们比较同一提示下的两个回答时，配分函数会在奖励之差中消去。这使得偏好概率可以直接用策略的概率比表示。",
  preference: "有了上述关系，我们可以进一步得到基于两个回答的偏好概率形式。给定同一提示，模型生成受偏好回答的概率，可以通过两个回答的相对概率变化来表达。",
  reference: "参考模型给出了一个稳定的比较起点。我们关心的不只是一个回答有多大概率出现，还包括它相对于参考模型发生了怎样的变化。",
  objective: "最终的训练目标直接作用在偏好数据上：提高被偏好回答的相对概率，同时降低另一个回答的相对概率。理解这里的“相对”，比记住公式本身更有帮助。",
  boundary: "阅读推导时，可以暂时把目标函数放在一边，先核对三个条件：两个回答使用同一提示、参考策略保持固定，以及我们比较的是同一对回答。",
};
const EQUATIONS = {
  "policy-equation": { number: "4", tex: "\\pi^*(y\\mid x)=\\frac{1}{Z(x)}\\,\\pi_{\\mathrm{ref}}(y\\mid x)\\exp\\!\\left(\\frac{r(x,y)}{\\beta}\\right)" },
  "reward-equation": { number: "5", tex: "r(x,y)=\\beta\\log\\frac{\\pi^*(y\\mid x)}{\\pi_{\\mathrm{ref}}(y\\mid x)}+\\beta\\log Z(x)" },
};
function makeNote(id, blockId, quote, body, type, color) {
  const start = TEXTS[blockId].indexOf(quote);
  return { id, blockId, start, end: start + quote.length, quote, body, type, color };
}
function seedLegacyNotes() {
  return assignReferences([
    makeNote("example-1", "goal", "不过分偏离参考模型", "先记住这层约束：学习偏好，同时保留一个稳定的参照。", "annotation", "blue"),
    { ...makeNote("question-1", "policy", "Z(x) 用于归一化", "为什么比较两个回答时，Z(x) 会消掉？", "question", "amber"), answer: exampleAnswer },
    makeNote("example-2", "reference", "相对于参考模型发生了怎样的变化", "这里的比较对象是参考模型，不能只看回答本身的概率。", "note", "green"),
    makeNote("question-2", "objective", "理解这里的“相对”", "这里的“相对概率”，应该怎样直观地理解？", "question", "rose"),
  ]);
}
const typeFor = (id) => TYPES.find((type) => type.id === id) || TYPES[0];

function HighlightedText({ text, items, draft }) {
  const ranges = [...items, ...(draft ? [draft] : [])];
  const boundaries = [...new Set([0, text.length, ...ranges.flatMap((item) => [item.start, item.end])])].sort((a, b) => a - b);
  return boundaries.slice(0, -1).map((start, index) => {
    const end = boundaries[index + 1];
    const match = ranges.findLast((item) => item.start < end && item.end > start);
    return match
      ? <mark key={start} data-insight-id={draft === match ? undefined : match.id} title={draft === match ? undefined : "查看洞见 " + match.reference} data-color={match.color} style={{ background: colorFor(match.color).value }} className={draft === match ? "draft-highlight" : ""}>{text.slice(start, end)}</mark>
      : <span key={start}>{text.slice(start, end)}</span>;
  });
}
function Equation({ id, tex, number, highlight, isDraft, active, variant = "source" }) {
  // Keep the same innerHTML object when UI state changes, so React does not
  // replace KaTeX's nodes and collapse the user's live selection.
  const markup = useMemo(() => ({ __html: katex.renderToString(tex, { displayMode: true, throwOnError: false, trust: false }) }), [tex]);
  return <div data-block-id={id} data-block-type="math" data-variant={variant} data-field="tex" className={"equation" + (active ? " active-paragraph" : "")} role="group" aria-label={number ? "公式（" + number + "）" : "无编号公式"}>
    <div className={"equation-content" + (isDraft ? " draft-highlight" : "")} data-insight-id={isDraft ? undefined : highlight?.id} title={!isDraft && highlight ? "查看洞见 " + highlight.reference : undefined} data-color={highlight?.color} style={{ "--equation-highlight": highlight ? colorFor(highlight.color).value : undefined }} dangerouslySetInnerHTML={markup} />
    {number && <span className="equation-number">({number})</span>}
  </div>;
}

export function App() {
  const legacy = new URLSearchParams(window.location.search).get("example") === "dpo";
  const htmlSample = new URLSearchParams(window.location.search).get("example") === "attention-html";
  const requestedPaper = new URLSearchParams(window.location.search).get("paper");
  const paperKey = requestedPaper && /^[a-z0-9-]{1,64}$/.test(requestedPaper) ? requestedPaper : null;
  const assetBase = "/articles/" + (paperKey || "attention-is-all-you-need") + "/";
  const [paper, setPaper] = useState(null);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (legacy) return;
    const controller = new AbortController();
    setError("");
    fetch(assetBase + (!paperKey && htmlSample ? "document.html-sample.json" : "document.json"), { signal: controller.signal })
      .then((response) => { if (!response.ok) throw new Error("HTTP " + response.status); return response.json(); })
      .then(prepareReaderDocument)
      .then((document) => {
        if (controller.signal.aborted) return;
        setPaper({ ...document, assetBase, sessionKey: document.id + (!paperKey && htmlSample ? ":html-table3" : ""),
          sampleNotes: paperKey ? [] : attentionNotes(document),
          presentation: documentPresentation(document),
          downloads: paperKey ? [{ path: "document.json", label: "结构化文档" }] : [{ path: "article.bilingual.md", label: "双语 Markdown" }, { path: "article-package.zip", label: "下载完整文章包" }],
        });
      })
      .catch((failure) => { if (failure.name !== "AbortError") setError("文章暂时无法加载，请重试。"); });
    return () => controller.abort();
  }, [legacy, htmlSample, paperKey, assetBase, attempt]);
  if (!legacy && !paper) return <main className="paper-loading" aria-live="polite"><p>{error || "正在打开文档…"}</p>{error && <button onClick={() => setAttempt((value) => value + 1)}>重新加载</button>}</main>;
  return <Reader key={paper?.id || "legacy"} paper={paper} />;
}

function readSession(documentId, storage) {
  try { return JSON.parse(storage?.getItem("reader-session:" + documentId)) || {}; } catch { return {}; }
}

export function Reader({ runtime = defaultReaderRuntime, ...props }) {
  return <ReaderRuntimeProvider value={runtime}><ReaderContent {...props} /></ReaderRuntimeProvider>;
}

function ReaderContent({ paper, insightItems, onSaveInsight, onDeleteInsight, onRestoreInsight, onReviewInsight, changeRequestItems, onSaveChangeRequest, onChangeRequestStatus, initialReadingState, onReadingStateChange, onBack, backLabel, onOpenNotes, onPreloadNotes, openInsightId, editInsightId, sourceApiBase, readOnly = false, glossaryApi, relations, onOpenRelatedDocument, onRelationCommand, onReturnRelatedDocument, relatedReturnTitle }) {
  const runtime = useReaderRuntime();
  const reducedMotion = useReducedMotionPreference();
  const managed = Array.isArray(insightItems);
  const readerReadOnly = readOnly || !runtime.capabilities.insightWrites || Boolean(paper?.unsupportedSchema);
  const preview = runtime.mode === "preview";
  const sessionStorage = runtime.sessionStorage;
  const matchesShortcut = (event, action) => matchesConfiguredShortcut(event, action, runtime.shortcuts.getSnapshot());
  const documentId = paper?.id || "direct-preference-optimization";
  const sessionKey = paper?.sessionKey || documentId;
  const entryReadingState = import.meta.hot && !preview && managed && isDesktopDevelopment(window.continuousReaderDesktop)
    ? developmentReadingState(history.state, documentId, paper?.revision, initialReadingState) : initialReadingState;
  const session = () => { const saved = readSession(sessionKey, sessionStorage); return saved.notes ? saved : !preview && sessionKey !== documentId ? readSession(documentId, sessionStorage) : saved; };
  const documentTitle = paper?.libraryTitle || paper?.meta.title || "直接偏好优化";
  const sourceIsPdf = paper?.source?.media_type === "application/pdf" || /\.pdf$/i.test(paper?.source?.path || "");
  const equations = useMemo(() => paper ? Object.fromEntries(paper.blocks.filter((block) => block.type === "math").map((block) => [block.id, { tex: block.tex, number: block.tag }])) : EQUATIONS, [paper]);
  const normalizeSource = (source) => managed || (paper && source.revision && source.revision !== paper.revision)
    ? reconcileInsight(paper, source) : normalizeMathSource(normalizeHtmlSource(paper, source), equations);
  const seedNotes = () => paper ? assignReferences(paper.sampleNotes || []) : seedLegacyNotes();
  const [notes, setNotes] = useState(() => (managed ? insightItems : session().notes || seedNotes()).filter((item) => !item.archivedAt && !item.deletedAt).map(normalizeSource));
  const [changeRequests, setChangeRequests] = useState(() => managed ? changeRequestItems || [] : session().changeRequests || []);
  const [selectingRequestSource, setSelectingRequestSource] = useState(false);
  const selectingRequestRef = useRef(false);
  selectingRequestRef.current = selectingRequestSource;
  const shortcuts = useSyncExternalStore(runtime.shortcuts.subscribe, runtime.shortcuts.getSnapshot);
  const [candidate, setCandidate] = useState(null);
  const [draft, setDraft] = useState(() => {
    let saved = session().draft;
    if (managed) try { const local = sessionStorage?.getItem("reader-draft:" + sessionKey); if (local != null) saved = JSON.parse(local); } catch {}
    return saved ? ensureDraftIntent(normalizeSource(saved)) : null;
  });
  const [titleOpened, setTitleOpened] = useState(false);
  // Article highlights depend on the source address and color, never on the
  // text being typed into the floating composer. Keep the article subtree
  // stable while preserving every exact text/list/cell/HTML source address.
  const highlightDraft = useMemo(() => draft ? {
    id: draft.id, blockId: draft.blockId, variant: draft.variant, field: draft.field,
    itemId: draft.itemId, nodeId: draft.nodeId, row: draft.row, column: draft.column,
    start: draft.start, end: draft.end, color: draft.color, referenceStatus: draft.referenceStatus,
  } : null, [Boolean(draft), draft?.id, draft?.blockId, draft?.variant, draft?.field,
    draft?.itemId, draft?.nodeId, draft?.row, draft?.column, draft?.start, draft?.end,
    draft?.color, draft?.referenceStatus]);
  const [composerClosing, setComposerClosing] = useState(false);
  const composerClose = useRef(null);
  const titleExpanded = Boolean(draft && !isChangeRequest(draft) && (titleOpened || draft.title));
  const [readingMode, setReadingMode] = useState(() => entryReadingState?.mode || session().readingMode || "bilingual");
  const [viewPreferences] = useState(runtime.view.read);
  const languages = useMemo(() => documentLanguages(paper), [paper]);
  const [targetLanguage, setTargetLanguage] = useState(() => entryReadingState?.targetLanguage || (languages.includes(viewPreferences.targetLanguage) ? viewPreferences.targetLanguage : languages[0]) || "zh-CN");
  // Bilingual order is a shared preference; old document checkpoints must not
  // replace a newer choice made in Collection, Flow or another Reader window.
  const [translationFirst, setTranslationFirst] = useState(() => viewPreferences.translationFirst);
  const readingAnchor = useRef(null);
  const [typeMenu, setTypeMenu] = useState(false);
  const [colorMenu, setColorMenu] = useState(false);
  const [showMargins, setShowMargins] = useState(() => viewPreferences.showMargins);
  const [tocMode, setTocMode] = useState(() => viewPreferences.tocMode);
  const [wideViewport, setWideViewport] = useState(() => window.innerWidth > 850);
  const [tocTemporary, setTocTemporary] = useState(false);
  const tocRef = useRef(null);
  const tocPreviewTimer = useRef(null);
  const navigation = useMemo(() => readerNavigation(paper), [paper]);
  const hasNavigation = !paper || navigation.items.length > 0;
  const tocPinned = tocMode === "pinned";
  const tocDocked = hasNavigation && tocPinned && wideViewport;
  const showToc = hasNavigation && (tocDocked || tocTemporary);
  useEffect(() => {
    if (!hasNavigation) { clearTocPreviewTimer(); setTocTemporary(false); }
  }, [hasNavigation]);
  const [insights, setInsights] = useState(null);
  const insightsModalPresence = useMotionPresence(insights === "modal", { kind: "surface" });
  const insightsBackdropRef = useImmediateReducedMotion(reducedMotion);
  const [settings, setSettings] = useState(false);
  const [filter, setFilter] = useState("all");
  const { fontSize, readingWidthPercent } = useSyncExternalStore(runtime.reading.subscribe, runtime.reading.getSnapshot);
  const [openMode, setOpenMode] = useState(() => viewPreferences.insightOpenMode);
  const [pdfFollow, setPdfFollow] = useState(() => viewPreferences.pdfFollow);
  const currentView = useRef(null);
  currentView.current = { tocMode, showMargins, insightOpenMode: openMode, pdfFollow, targetLanguage, translationFirst };
  const [pdfTarget, setPdfTarget] = useState(null);
  const [saving, setSaving] = useState(false);
  const contextMenu = useContextMenu({ disabled: saving, contextKey: `${documentId}:${paper?.revision || 1}:${readingMode}:${targetLanguage}` });
  const pendingContextSelection = useRef(null);
  const [saveError, setSaveError] = useState("");
  const [insightHistory, setInsightHistory] = useState(() => readInsightHistory(sessionStorage, sessionKey));
  const [undoHidden, setUndoHidden] = useState(false);
  const removed = insightHistory.deleted.at(-1);
  const [returnHistory, setReturnHistory] = useState([]);
  const [detailId, setDetailId] = useState(null);
  const [notice, setNotice] = useState("");
  const marginGroups = useMemo(() => buildMarginGroups(notes, paper), [notes, paper]);
  const [marginLayouts, setMarginLayouts] = useState({});
  const [marginDetail, setMarginDetail] = useState(null);
  const retainedMarginDetail = useRef(null);
  const marginReturnFocus = useRef(null);
  const marginOpenRef = useRef(false);
  marginOpenRef.current = Boolean(marginDetail);
  const [composerPosition, setComposerPosition] = useState({ left: 0, top: 0, width: 640 });
  const [activeNote, setActiveNote] = useState(null);
  const [questionId, setQuestionId] = useState(null);
  const retainedQuestion = useRef(null);
  const [occludedNotes, setOccludedNotes] = useState({});
  const questionOpenRef = useRef(false);
  const questionReturnFocus = useRef(null);
  questionOpenRef.current = Boolean(questionId);
  const articleRef = useRef(null);
  useLayoutEffect(() => {
    const article = articleRef.current;
    if (reducedMotion) stopReaderContentMotion(article);
    return () => stopReaderContentMotion(article);
  }, [reducedMotion]);
  const [imagePreview, setImagePreview] = useState(null);
  useEffect(() => setImagePreview(null), [paper]);
  const [topbarHeight, setTopbarHeight] = useState(null);
  const railRef = useRef(null);
  const inputRef = useRef(null);
  const titleRef = useRef(null);
  const composerRef = useRef(null);
  const typeTriggerRef = useRef(null);
  const colorTriggerRef = useRef(null);
  const draftRef = useRef(null);
  const draftAcknowledgements = useRef(null);
  if (!draftAcknowledgements.current) draftAcknowledgements.current = createDraftAcknowledgements({ acknowledge: acknowledgeDraftCommand });
  const preferences = useRef({ type: "annotation", color: "amber" });
  const selectionTimer = useRef(null);
  const noticeTimer = useRef(null);
  const savingRef = useRef(false);
  const selectionReader = useRef(null);
  const initialPosition = useRef(entryReadingState);
  const checkpointCallback = useRef(onReadingStateChange);
  const checkpointTimer = useRef(null);
  const checkpointState = useRef(null);
  const layoutAnchor = useRef(null);
  const layoutEpoch = useRef(0);
  const cancelNavigation = useRef(null);
  useEffect(() => () => cancelNavigation.current?.(), []);
  const previousRevision = useRef(paper?.revision);
  const scrollOwnership = useRef(createScrollOwnership());
  const readerPosition = useRef(null);
  const openInsightHandled = useRef(null);
  const editInsightHandled = useRef(null);
  const sourceTrigger = useRef(null);
  const insightTrigger = useRef(null);
  const editOrigin = useRef(null);
  const pdfResize = usePdfPanelResize({ open: insights === "pdf", articleRef, pinnedToc: tocDocked, ownership: scrollOwnership.current });
  checkpointCallback.current = onReadingStateChange;
  draftRef.current = draft;
  const citationPreview = useCitationPreview({ articleRef, relations,
    renderKey: `${paper?.revision}:${readingMode}:${targetLanguage}:${translationFirst}`,
    disabled: preview || !managed || Boolean(draft || selectingRequestSource || imagePreview || settings || questionId || marginDetail || insights === "modal"),
    isCloseShortcut: (event) => matchesShortcut(event, "close") });
  const findSource = (source) => sourceElement(articleRef.current, source);
  useEffect(() => {
    if (managed) {
      try {
        void draftAcknowledgements.current.persist({ draft, storage: sessionStorage, key: "reader-draft:" + sessionKey, desktop: window.continuousReaderDesktop }).catch(() => {});
        window.continuousReaderDesktop?.persistSession();
      } catch { /* Retain confirmed command records until draft persistence succeeds. */ }
      return;
    }
    // Preserve current-page content across prototype reference/source upgrades.
    try { sessionStorage?.setItem("reader-session:" + sessionKey, JSON.stringify({ notes, draft, readingMode, changeRequests })); } catch { /* Storage is optional. */ }
    const upgraded = notes.map(normalizeSource);
    if (notes.some((note, index) => note !== upgraded[index] || !hasCurrentReference(note))) setNotes(assignReferences(upgraded));
  }, [notes, draft, readingMode, changeRequests, documentId, sessionKey, managed, sessionStorage]);
  useEffect(() => {
    if (managed) setNotes((current) => mergeSavedInsights(current, insightItems).map((note) => reconcileInsight(paper, note)));
    if (managed) setInsightHistory((current) => reconcileInsightHistory(current, insightItems));
  }, [insightItems, managed, paper]);
  useEffect(() => {
    setInsightHistory((current) => rememberReferences(current, notes));
  }, [notes]);
  useEffect(() => {
    try { sessionStorage?.setItem("reader-insight-history:" + sessionKey, JSON.stringify(insightHistory)); } catch {}
  }, [insightHistory, sessionKey, sessionStorage]);
  useEffect(() => {
    if (managed && changeRequestItems) setChangeRequests((current) => changeRequestItems.map((item) => current.find((old) => old.id === item.id && old.version > item.version) || item));
  }, [managed, changeRequestItems]);
  useEffect(() => {
    if (!readerReadOnly) return;
    setCandidate(null); setTypeMenu(false); setColorMenu(false);
  }, [readerReadOnly]);
  useEffect(() => {
    runtime.view.save({ tocMode, showMargins, insightOpenMode: openMode, pdfFollow, targetLanguage, translationFirst });
  }, [tocMode, showMargins, openMode, pdfFollow, targetLanguage, translationFirst, runtime]);
  useEffect(() => {
    const changed = () => {
      const next = runtime.view.read();
      if (Object.keys(next).every((key) => next[key] === currentView.current[key])) return;
      preserveLayout(); clearTocPreviewTimer(); setTocTemporary(false); setTocMode(next.tocMode); setShowMargins(next.showMargins);
      setOpenMode(next.insightOpenMode); setPdfFollow(next.pdfFollow); setTargetLanguage(next.targetLanguage); setTranslationFirst(next.translationFirst);
    };
    return runtime.view.subscribe(changed);
  }, [runtime]);
  useEffect(() => {
    clearTocPreviewTimer();
    setTocTemporary(false);
    return clearTocPreviewTimer;
  }, [wideViewport]);
  useEffect(() => { document.title = documentTitle + " · Stread"; }, [documentTitle]);
  function changeReadingMode(mode) {
    if (mode === readingMode) return;
    cancelNavigation.current?.();
    stopPageMotion();
    if (!articleRef.current) return;
    const blocks = [...articleRef.current.querySelectorAll("[data-article-block]")].filter((element) => element.getClientRects().length);
    const anchor = (draftRef.current && document.getElementById(draftRef.current.blockId)) || blocks.find((element) => element.getBoundingClientRect().bottom > 110);
    if (anchor) readingAnchor.current = { id: anchor.id, top: anchor.getBoundingClientRect().top };
    window.getSelection()?.removeAllRanges();
    flushSync(() => { setCandidate(null); setReadingMode(mode); });
    animateReaderContent(articleRef.current, { reduced: reducedMotion });
  }
  function preserveLayout(anchor) { cancelNavigation.current?.(); layoutEpoch.current++; layoutAnchor.current = anchor || captureReadingPosition(articleRef.current); }
  function navigateReader(resolveTop, { missing, owner = "reader" } = {}) {
    stopPageMotion();
    // A deliberate jump owns the scroll while panels reflow. The animation
    // measures its destination each frame instead of fighting layout repair.
    layoutEpoch.current++;
    layoutAnchor.current = null;
    readingAnchor.current = null;
    scrollOwnership.current.user(owner);
    cancelNavigation.current = animateReaderNavigation(resolveTop, { onMissing: () => { if (missing) flash(missing); } });
  }
  function navigateAnchor(anchor, options = {}) {
    navigateReader(() => readingPositionTop(articleRef.current, anchor, { exactTop: true }), options);
  }
  function navigateArticleLink(event, link) {
    if (!link || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return false;
    if (link.hasAttribute("download") || link.target && link.target !== "_self") return false;
    let id;
    try { id = decodeURIComponent(link.hash.slice(1)); } catch { return false; }
    const target = document.getElementById(id);
    if (!target || !articleRef.current?.contains(target)) return false;
    event.preventDefault();
    rememberPosition();
    // Native hash navigation drops history.state and can remount the reader.
    if (location.hash !== link.hash) history.pushState(history.state, "", link.hash);
    navigateReader(() => {
      const element = document.getElementById(id);
      if (!element || !articleRef.current?.contains(element)) return null;
      for (let details = element.closest("details"); details; details = details.parentElement?.closest("details")) details.open = true;
      return window.scrollY + element.getBoundingClientRect().top - readingLine();
    });
    return true;
  }
  function setTool(tool, anchor) {
    if (tool !== insights) preserveLayout(anchor);
    else { layoutEpoch.current++; layoutAnchor.current = null; }
    setInsights(tool); setCandidate(null);
  }
  function closeInsights() {
    setTool(null);
    requestAnimationFrame(() => insightTrigger.current?.focus({ preventScroll: true }));
  }
  function toggleToc() {
    if (!hasNavigation) return;
    preserveLayout();
    clearTocPreviewTimer();
    setTocMode(tocPinned ? "collapsed" : "pinned");
    setTocTemporary(!tocPinned && !wideViewport);
  }
  function clearTocPreviewTimer() {
    window.clearTimeout(tocPreviewTimer.current);
    tocPreviewTimer.current = null;
  }
  function previewToc(event) {
    if (!hasNavigation || event.pointerType === "touch") return;
    clearTocPreviewTimer();
    if (!tocDocked) tocPreviewTimer.current = window.setTimeout(() => setTocTemporary(true), 120);
  }
  function leaveTocPreview(event) {
    if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return;
    clearTocPreviewTimer();
    tocPreviewTimer.current = window.setTimeout(() => {
      if (!tocRef.current?.contains(document.activeElement)) setTocTemporary(false);
    }, 180);
  }
  function closeTemporaryToc() {
    clearTocPreviewTimer();
    setTocTemporary(false);
    requestAnimationFrame(() => document.querySelector(".toc-toggle")?.focus({ preventScroll: true }));
  }
  function navigateToc(event) {
    if (!navigateArticleLink(event, event.currentTarget)) return;
    if (!tocDocked) {
      clearTocPreviewTimer();
      setTocTemporary(false);
      requestAnimationFrame(() => articleRef.current?.focus({ preventScroll: true }));
    }
  }
  function captureCheckpoint() {
    const anchor = captureReadingPosition(articleRef.current);
    if (!anchor) return null;
    readerPosition.current = anchor;
    return { documentId, revision: paper?.revision || 1, blockId: anchor.blockId, offsetRatio: anchor.offsetRatio, mode: readingMode, targetLanguage, translationFirst };
  }
  function publishCheckpoint() {
    clearTimeout(checkpointTimer.current);
    const state = checkpointState.current;
    if (state) void Promise.resolve(checkpointCallback.current?.(state)).catch(() => {});
  }
  useEffect(() => {
    const update = () => {
      checkpointState.current = captureCheckpoint();
      clearTimeout(checkpointTimer.current);
      checkpointTimer.current = setTimeout(publishCheckpoint, 500);
    };
    const userInput = (event) => {
      if (event.target instanceof Element && event.target.closest(".pdf-panel, .settings, .insights-panel, .insights-modal, .glossary-panel, .toc, .composer")) return;
      if (event.type === "keydown" && !["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(event.key)) return;
      layoutEpoch.current++;
      scrollOwnership.current.user("reader");
    };
    window.addEventListener("scroll", update, { passive: true });
    document.addEventListener("wheel", userInput, { passive: true });
    document.addEventListener("touchstart", userInput, { passive: true });
    document.addEventListener("pointerdown", userInput, { passive: true });
    document.addEventListener("keydown", userInput);
    const hidden = () => { if (document.visibilityState === "hidden") publishCheckpoint(); };
    const flush = (event) => {
      checkpointState.current = captureCheckpoint();
      if (import.meta.hot && !preview && managed && isDesktopDevelopment(window.continuousReaderDesktop) && event.detail?.development) {
        try { sessionStorage.setItem("reader-draft:" + sessionKey, JSON.stringify(draftRef.current)); }
        catch (error) { event.detail.errors.push(error); }
        try {
          if (checkpointState.current) checkpointCallback.current?.(checkpointState.current, { enqueueOnly: true });
        } catch (error) { event.detail.errors.push(error); }
        return;
      }
      publishCheckpoint();
    };
    window.addEventListener("continuous-reader:flush", flush);
    document.addEventListener("visibilitychange", hidden);
    update();
    return () => {
      publishCheckpoint(); window.removeEventListener("scroll", update);
      document.removeEventListener("wheel", userInput); document.removeEventListener("touchstart", userInput);
      document.removeEventListener("pointerdown", userInput); document.removeEventListener("keydown", userInput);
      document.removeEventListener("visibilitychange", hidden);
      window.removeEventListener("continuous-reader:flush", flush);
    };
  }, [documentId, paper?.revision, readingMode, targetLanguage, translationFirst, managed, preview, sessionKey, sessionStorage]);
  useLayoutEffect(() => {
    if (initialPosition.current) {
      restoreReadingPosition(articleRef.current, initialPosition.current, { exactTop: Number.isFinite(initialPosition.current.viewportOffset) });
      initialPosition.current = null;
    }
    if (previousRevision.current !== paper?.revision) {
      previousRevision.current = paper?.revision;
      const anchor = readerPosition.current;
      if (anchor && !restoreReadingPosition(articleRef.current, anchor)) flash("正文已更新，原阅读段落已变更；已有摘录和草稿仍保留。");
      setNotes((current) => current.map((note) => reconcileInsight(paper, note)));
      setDraft((current) => current ? reconcileInsight(paper, current) : current);
    }
  }, [paper]);
  useLayoutEffect(() => {
    const anchor = layoutAnchor.current;
    if (!anchor) return;
    layoutAnchor.current = null;
    const epoch = layoutEpoch.current;
    let initialFrames = 2;
    let frame;
    const settle = () => {
      if (epoch !== layoutEpoch.current) return;
      scrollOwnership.current.programmatic();
      restoreReadingPosition(articleRef.current, anchor, { exactTop: true });
      if (initialFrames-- > 0 || articleRef.current?.closest(".reader-app")?.dataset.layoutMoving === "true") frame = requestAnimationFrame(settle);
    };
    settle();
    return () => cancelAnimationFrame(frame);
  }, [tocDocked, showMargins, insights, fontSize, readingWidthPercent, targetLanguage, translationFirst]);
  useLayoutEffect(() => {
    const anchor = readingAnchor.current;
    if (!anchor) return;
    readingAnchor.current = null;
    const element = document.getElementById(anchor.id);
    if (element) window.scrollBy({ top: element.getBoundingClientRect().top - anchor.top, behavior: "instant" });
  }, [readingMode]);
  function flash(text) {
    setNotice(text);
    clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => setNotice(""), 3200);
  }
  async function copyReference(note) {
    try {
      await navigator.clipboard.writeText(note.reference);
      flash("已复制 " + note.reference);
      return true;
    } catch {
      flash("复制失败，可手动选择编号");
      return false;
    }
  }
  function readSelection({ snapshot = null, passive = false } = {}) {
    if (readerReadOnly && !passive) { setCandidate(null); return; }
    const requestSelection = isChangeRequest(draftRef.current) && selectingRequestRef.current && !savingRef.current;
    if (draftRef.current && !requestSelection && !passive || !articleRef.current) return;
    const selection = window.getSelection();
    if (!snapshot && (!selection || selection.isCollapsed || !selection.rangeCount)) { if (!passive) setCandidate(null); return; }
    const range = snapshot?.range || selection.getRangeAt(0);
    const elementOf = (node) => node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
    const startBlock = elementOf(range.startContainer)?.closest("[data-block-id]");
    const endBlock = elementOf(range.endContainer)?.closest("[data-block-id]");
    if (!startBlock || !articleRef.current.contains(startBlock) || startBlock !== endBlock) { if (!passive) setCandidate(null); return; }
    if (!range.toString().trim()) { if (!passive) setCandidate(null); return; }
    const blockId = startBlock.dataset.blockId;
    const formula = equations[blockId];
    let source;
    if (formula) {
      const descriptor = sourceDescriptor(startBlock);
      source = { ...descriptor, blockId, documentId, revision: paper?.revision, sourceType: "math", field: "tex",
        quote: paper ? sourceText(paper, descriptor) : formula.tex, equationNumber: formula.number };
    } else if (paper) {
      const descriptor = sourceDescriptor(startBlock);
      const stored = sourceText(paper, descriptor);
      const selected = readTextRange(range, startBlock, stored);
      source = { ...descriptor, documentId, revision: paper.revision, ...selected,
        prefix: stored.slice(Math.max(0, selected.start - 32), selected.start), suffix: stored.slice(selected.end, selected.end + 32) };
      if (!source.quote.trim()) { if (!passive) setCandidate(null); return; }
    } else {
      const before = range.cloneRange();
      before.selectNodeContents(startBlock);
      before.setEnd(range.startContainer, range.startOffset);
      const quote = range.toString();
      source = { blockId, start: before.toString().length, end: before.toString().length + quote.length, quote };
    }
    const rects = [...range.getClientRects()].filter((rect) => rect.width && rect.height);
    const last = formula ? startBlock.querySelector(".equation-content")?.getBoundingClientRect() || range.getBoundingClientRect() : rects.at(-1) || range.getBoundingClientRect();
    const next = {
      ...source,
      left: Math.min(Math.max(16, last.right - 104), window.innerWidth - 120),
      top: Math.min(last.bottom + 9, window.innerHeight - 48),
    };
    if (!passive) {
      if (requestSelection) attachRequestSource(source);
      else setCandidate(next);
    }
    return next;
  }
  function captureContextSelection(event) {
    pendingContextSelection.current = null;
    if (event.button !== 2 || event.target.closest("input, textarea, select, [contenteditable='true']")) return;
    const snapshot = captureArticleSelection(articleRef.current, window.getSelection());
    if (!selectionContextHit(snapshot, event.target, event)) return;
    const source = readSelection({ snapshot, passive: true });
    if (source) pendingContextSelection.current = { ...snapshot, source, capturedAt: performance.now() };
  }
  function openSelectionContext(event) {
    if (event.defaultPrevented || event.target.closest("input, textarea, select, [contenteditable='true']")) return false;
    const keyboard = event.type === "keydown";
    const target = keyboard && (event.target === document.body || event.target === document.documentElement) ? articleRef.current : event.target;
    const pending = pendingContextSelection.current;
    pendingContextSelection.current = null;
    let snapshot = !keyboard && pending && performance.now() - pending.capturedAt < 2000 && selectionContextHit(pending, event.target, event) ? pending : null;
    if (!snapshot) {
      const current = captureArticleSelection(articleRef.current, window.getSelection());
      if (!selectionContextHit(current, target, { keyboard, clientX: event.clientX, clientY: event.clientY })) return false;
      const source = readSelection({ snapshot: current, passive: true });
      if (!source) return false;
      snapshot = { ...current, source };
    }
    const source = snapshot.source;
    restoreArticleSelection(snapshot, window.getSelection());
    const items = [
      { id: "copy", label: "复制", icon: Copy, onSelect: async () => {
        try { await navigator.clipboard.writeText(source.quote); flash("已复制所选内容"); }
        catch { flash("复制失败，请使用系统复制快捷键。"); }
      } },
      { id: "add-insight", label: draftRef.current ? "继续当前草稿" : "添加洞见", icon: NotePencil, disabled: readerReadOnly, separatorBefore: true, onSelect: () => {
        if (draftRef.current) { resumeDraft(); flash("当前草稿已保留，请先保存或取消。"); }
        else begin(source);
      } },
      ...(!draftRef.current ? [requestContextItem(source)] : []),
    ];
    if (sourceApiBase && sourceIsPdf && paper?.source?.path && regionForBlock(sourceRegions(paper), source.blockId, undefined, source.itemId)) items.push({ id: "locate-source", label: "在原页定位", icon: Crosshair, onSelect: () => {
      setPdfTarget({ ...source, nonce: crypto.randomUUID() }); setTool("pdf");
    } });
    contextMenu.open(event, { id: "selection:" + JSON.stringify([source.blockId, source.variant, source.field, source.itemId, source.nodeId, source.start, source.end]), trigger: articleRef.current, ...(keyboard ? { anchorRect: snapshot.anchorRect } : {}), items,
      onClose: ({ reason }) => {
        if (!["replace", "disabled", "unmount"].includes(reason)) restoreArticleSelection(snapshot, window.getSelection());
      } });
    return true;
  }
  useEffect(() => { pendingContextSelection.current = null; }, [documentId, paper?.revision, readingMode, targetLanguage]);
  function isContextKey(event) {
    return !event.isComposing && !event.defaultPrevented && (event.key === "ContextMenu" || event.key === "F10" && event.shiftKey);
  }
  function openNoteContext(event, note) {
    if (event.defaultPrevented || event.target.closest("input, textarea, select, [contenteditable='true']")) return;
    const trigger = event.target.closest("button, [tabindex]") || event.currentTarget;
    contextMenu.open(event, { id: "insight:" + note.id, trigger, items: [
      { id: "view", label: "查看完整内容", icon: ArrowUpRight, onSelect: () => {
        if (note.type === "question") openQuestion(note);
        else { setDetailId(note.id); setFilter("all"); setTool("modal"); }
      } },
      ...(note.blockId ? [{ id: "locate", label: "定位原文", icon: Crosshair, disabled: note.referenceStatus === "unresolved", onSelect: () => locate(note) }] : []),
      { id: "edit", label: draftRef.current?.id === note.id ? "继续编辑" : isHighlightOnly(note) ? "补充批注" : "编辑洞见", icon: NotePencil, separatorBefore: true, disabled: readerReadOnly, onSelect: () => editNote(note, trigger) },
      { id: "copy", label: "复制编号", icon: Copy, onSelect: () => copyReference(note) },
      ...(onReviewInsight ? [{ id: "review", label: note.review?.pending ? "移出待回顾" : "加入待回顾", icon: BookmarkSimple, disabled: readerReadOnly, onSelect: () => toggleInsightReview(note) }] : []),
      { id: "delete", label: note.answer ? "删除问题与回答" : "删除洞见", icon: Trash, separatorBefore: true, danger: true, disabled: readerReadOnly || draftRef.current?.id === note.id || managed && !onDeleteInsight, onSelect: () => archiveNote(note) },
    ] });
  }
  function openArticleContext(event) {
    if (openSelectionContext(event)) return;
    if (event.defaultPrevented || event.target.closest("a, button, input, textarea, select, summary, [contenteditable='true'], [role='slider'], [role='separator']")) return;
    const mark = event.target.closest("[data-insight-id]");
    const note = mark && notes.find((item) => item.id === mark.dataset.insightId);
    if (note) { openNoteContext(event, note); return; }
    const element = event.target.closest("[data-block-id]");
    if (!element || !articleRef.current?.contains(element) || element.closest(".reader-object") || !element.matches('p, [data-block-type="math"]')) return;
    const descriptor = sourceDescriptor(element);
    const quote = paper ? sourceText(paper, descriptor) : TEXTS[descriptor.blockId];
    if (!quote?.trim()) return;
    const formula = descriptor.field === "tex";
    const source = { ...descriptor, documentId, revision: paper?.revision || 1, quote, ...(formula ? { sourceType: "math", equationNumber: equations[descriptor.blockId]?.number } : { start: 0, end: quote.length, prefix: "", suffix: "" }) };
    const id = (formula ? "math:" : "paragraph:") + JSON.stringify([source.blockId, source.variant, source.nodeId, source.itemId]);
    const items = [{ id: "add-insight", label: draftRef.current ? "继续当前草稿" : "添加洞见", icon: NotePencil, disabled: readerReadOnly, onSelect: () => {
      if (draftRef.current) { resumeDraft(); flash("当前草稿已保留，请先保存或取消。"); }
      else begin(source);
    } }, ...(!draftRef.current ? [requestContextItem(source)] : [])];
    if (sourceApiBase && sourceIsPdf && paper?.source?.path && regionForBlock(sourceRegions(paper), source.blockId, undefined, source.itemId)) items.push({ id: "locate-source", label: "在原页定位", icon: Crosshair, onSelect: () => {
      setPdfTarget({ ...source, nonce: crypto.randomUUID() }); setTool("pdf");
    } });
    const opened = contextMenu.open(event, { id, trigger: articleRef.current, anchorRect: element.getBoundingClientRect(), preserveSelection: false, items, onClose: () => {
      if (element.getAttribute("data-context-active") === id) element.removeAttribute("data-context-active");
    } });
    if (opened) element.setAttribute("data-context-active", id);
  }
  function attachRequestSource(source) {
    setDraft((current) => isChangeRequest(current) ? { ...withoutRequestSource(current), ...source, documentId, revision: paper?.revision || 1 } : current);
    setSelectingRequestSource(false); setCandidate(null); setSaveError("");
    window.getSelection()?.removeAllRanges();
    requestAnimationFrame(() => inputRef.current?.focus({ preventScroll: true }));
  }
  function pickRequestBlock(event) {
    if (!selectingRequestRef.current || !isChangeRequest(draftRef.current) || savingRef.current || readerReadOnly) return;
    if (!window.getSelection()?.isCollapsed) { readSelection(); return; }
    if (event.target.closest("button, input, textarea, select, summary, [role='separator']")) return;
    let element = event.target.closest("[data-block-id]");
    if (!element) element = event.target.closest("[data-article-block]")?.querySelector("[data-block-id]");
    if (!element || !articleRef.current.contains(element)) return;
    event.preventDefault();
    const descriptor = sourceDescriptor(element);
    const quote = paper ? sourceText(paper, descriptor) : equations[descriptor.blockId]?.tex || TEXTS[descriptor.blockId] || "";
    attachRequestSource({ ...descriptor, quote, ...(descriptor.field === "tex" ? { sourceType: "math", equationNumber: equations[descriptor.blockId]?.number } : { start: 0, end: quote.length }) });
  }
  selectionReader.current = readSelection;
  useEffect(() => {
    const onSelection = () => { clearTimeout(selectionTimer.current); selectionTimer.current = setTimeout(() => selectionReader.current?.(), 100); };
    const onScroll = (event) => {
      // Following a source selection only scrolls the PDF; the native article
      // selection and its insight actions still occupy the same screen area.
      if (event.target instanceof Element && event.target.closest(".pdf-drawer")) return;
      if (!draftRef.current) setCandidate(null);
    };
    const screen = window.matchMedia("(min-width: 851px)");
    const changeScreen = (event) => { preserveLayout(); setWideViewport(event.matches); setTocTemporary(false); };
    document.addEventListener("selectionchange", onSelection);
    window.addEventListener("scroll", onScroll, true);
    screen.addEventListener("change", changeScreen);
    return () => {
      document.removeEventListener("selectionchange", onSelection);
      window.removeEventListener("scroll", onScroll, true);
      screen.removeEventListener("change", changeScreen);
      clearTimeout(selectionTimer.current); clearTimeout(noticeTimer.current);
    };
  }, []);
  useEffect(() => {
    function onKey(event) {
      if (questionOpenRef.current || marginOpenRef.current || imagePreview || citationPreview.open?.pinned) return;
      if (event.defaultPrevented || event.isComposing || event.keyCode === 229 || event.repeat || event.target.closest?.('[data-shortcut-recorder]')) return;
      const editing = event.target instanceof HTMLElement && (event.target.matches("input, textarea, select") || event.target.isContentEditable);
      if (!editing && !settings && insights !== "modal" && isContextKey(event) && openSelectionContext(event)) return;
      if (matchesShortcut(event, "settings")) { event.preventDefault(); setSettings((value) => !value); return; }
      if (matchesShortcut(event, "close")) {
        event.preventDefault();
        if (settings) setSettings(false);
        else if (insights === "modal") closeInsights();
        else if (typeMenu) setTypeMenu(false);
        else if (colorMenu) setColorMenu(false);
        else if (insights && !composerRef.current?.contains(event.target)) { if (insights === "sidebar") closeInsights(); else setTool(null); }
        else if (draftRef.current) { if (!savingRef.current) closeComposer(); }
        else if (tocTemporary) closeTemporaryToc();
        else if (insights) setTool(null);
        else { setCandidate(null); window.getSelection()?.removeAllRanges(); }
        return;
      }
      if (settings || insights === "modal" || editing || event.target.closest?.('[role="dialog"], dialog, [role="menu"]')) return;
      if (matchesShortcut(event, "requestChange")) { event.preventDefault(); beginChangeRequest(); return; }
      if (matchesShortcut(event, "addInsight")) { event.preventDefault(); const selection = readSelection(); if (selection) begin(selection); else if (draftRef.current) inputRef.current?.focus(); else flash("请先选中要添加洞见的文字或公式。"); return; }
      if (matchesShortcut(event, "margins")) { event.preventDefault(); preserveLayout(); setShowMargins((value) => !value); }
      if (matchesShortcut(event, "insightSidebar") || matchesShortcut(event, "insightModal")) { event.preventDefault(); const form = matchesShortcut(event, "insightModal") ? "modal" : "sidebar"; setTool(insights === form ? null : form); }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [typeMenu, colorMenu, settings, insights, tocTemporary, shortcuts, readerReadOnly, paper, readingMode, targetLanguage, sourceApiBase, contextMenu.open, imagePreview, citationPreview.open?.pinned]);
  useEffect(() => {
    const selector = !settings && insightsModalPresence.present ? ".insights-modal" : null;
    if (!selector) return;
    const panel = document.querySelector(selector);
    if (!panel) return;
    const previous = document.activeElement;
    const releaseScrollLock = acquirePageScrollLock();
    const focusables = () => [...panel.querySelectorAll("button:not(:disabled), input:not(:disabled), select, textarea, summary, [tabindex='0']")].filter((item) => item.getClientRects().length && !item.closest("[inert]"));
    if (insights === "modal" && !panel.contains(document.activeElement)) focusables()[0]?.focus({ preventScroll: true });
    const trap = (event) => {
      if (questionOpenRef.current || marginOpenRef.current) return;
      if (event.key !== "Tab") return;
      const items = focusables();
      if (event.shiftKey && document.activeElement === items[0]) { event.preventDefault(); items.at(-1)?.focus(); }
      else if (!event.shiftKey && document.activeElement === items.at(-1)) { event.preventDefault(); items[0]?.focus(); }
    };
    document.addEventListener("keydown", trap);
    return () => {
      document.removeEventListener("keydown", trap);
      releaseScrollLock();
      const active = document.activeElement;
      if (previous?.isConnected && (panel.contains(active) || active === document.body || active === document.documentElement) && !previous.closest('[inert], [aria-hidden="true"]')) previous.focus({ preventScroll: true });
    };
  }, [settings, insightsModalPresence.present]);
  useLayoutEffect(() => {
    function measure() {
      if (railRef.current) {
        const railBox = railRef.current.getBoundingClientRect();
        const railTop = railBox.top;
        const surfaces = [...articleRef.current.querySelectorAll(".reader-object")].map((element) => {
          const box = element.getBoundingClientRect();
          return { top: box.top, bottom: box.bottom, right: box.left + Math.max(box.width, Number(element.dataset.objectTargetWidth) || 0) };
        });
        const next = {}, hidden = {};
        const layouts = layoutMarginGroups(marginGroups, marginGroups.length ? measureMarginSources(articleRef.current, paper) : [], {
          railTop, maxHeight: Math.min(380, window.innerHeight * .47),
        });
        for (const layout of layouts) {
          const { key, top, height, previewCount, compact, sourceOverlap, laneIndex, laneCount } = layout;
          next[key] = { top: Math.round(top * 100) / 100, height: Math.floor(height), previewCount, compact, sourceOverlap, laneIndex, laneCount, noteIds: layout.notes.map((note) => note.id) };
          if (surfaces.some((box) => box.right > railBox.left - 16 && box.top < railTop + top + height + 12 && box.bottom > railTop + top - 12)) hidden[key] = true;
        }
        setMarginLayouts((previous) => JSON.stringify(previous) === JSON.stringify(next) ? previous : next);
        setOccludedNotes((previous) => JSON.stringify(previous) === JSON.stringify(hidden) ? previous : hidden);
      }
      if (draftRef.current) {
        if (!draftRef.current.blockId || draftRef.current.referenceStatus === "unresolved") {
          const width = Math.min(560, window.innerWidth - 32);
          const next = { width, left: Math.max(16, (window.innerWidth - width) / 2), top: Math.min(160, Math.max(90, window.innerHeight / 3)) };
          setComposerPosition((old) => JSON.stringify(old) === JSON.stringify(next) ? old : next);
          return;
        }
        const block = findSource(draftRef.current);
        if (!block) return;
        const rect = block.getBoundingClientRect();
        const width = Math.min(560, Math.max(rect.width, Math.min(360, articleRef.current.clientWidth)), window.innerWidth - 32);
        const below = rect.bottom + 8;
        const surface = composerRef.current;
        // Reserve the approved type strip (42px + 8px) below the fixed header.
        const headerHeight = document.querySelector(".topbar")?.getBoundingClientRect().bottom || 56;
        const maximumHeight = MAX_COMPOSER_HEIGHT + (isChangeRequest(draftRef.current) ? 0 : COMPOSER_TITLE_HEIGHT) + (isChangeRequest(draftRef.current) || draftRef.current.id ? 32 : 0);
        const minimumTop = Math.min(headerHeight + 62, Math.max(headerHeight + 12, window.innerHeight - maximumHeight - 16));
        // Choose the side once per opening, reserving room for five full lines.
        // Anchoring the bottom edge above a paragraph lets growth move smoothly
        // upward without ever flipping across the paragraph during typing.
        const anchor = surface?.dataset.anchor || (below + maximumHeight <= window.innerHeight - 16 || rect.top - minimumTop - 8 < maximumHeight ? "below" : "above");
        if (surface) surface.dataset.anchor = anchor;
        const left = Math.max(16, Math.min(rect.left, window.innerWidth - width - 16));
        const next = { left, width, ...(anchor === "below"
          ? { top: Math.max(minimumTop, Math.min(below, window.innerHeight - 16 - maximumHeight)) }
          : { bottom: Math.max(16, Math.min(window.innerHeight - rect.top + 8, window.innerHeight - minimumTop - maximumHeight)) }) };
        setComposerPosition((old) => JSON.stringify(old) === JSON.stringify(next) ? old : next);
      }
    }
    measure();
    let measureFrame = null;
    const scheduleMeasure = (event) => {
      // Textarea caret scrolling and independent tool/outline scrolling do
      // not move article sources. They must not scan the whole document.
      const target = event?.target, article = articleRef.current;
      if (event?.type === "scroll" && target instanceof Element && article
        && !target.contains(article) && !article.contains(target)) return;
      if (measureFrame == null) measureFrame = requestAnimationFrame(() => { measureFrame = null; measure(); });
    };
    const observer = new ResizeObserver(scheduleMeasure);
    if (articleRef.current) observer.observe(articleRef.current);
    articleRef.current?.querySelectorAll(".reader-object").forEach((element) => observer.observe(element));
    articleRef.current?.querySelectorAll("[data-block-id]").forEach((element) => observer.observe(element));
    window.addEventListener("resize", scheduleMeasure);
    window.addEventListener("reader-ui-scale-change", scheduleMeasure);
    window.addEventListener("reader-object-size", scheduleMeasure);
    window.addEventListener("scroll", scheduleMeasure, true);
    return () => { observer.disconnect(); if (measureFrame != null) cancelAnimationFrame(measureFrame); window.removeEventListener("resize", scheduleMeasure); window.removeEventListener("reader-ui-scale-change", scheduleMeasure); window.removeEventListener("reader-object-size", scheduleMeasure); window.removeEventListener("scroll", scheduleMeasure, true); };
  }, [marginGroups, paper, Boolean(draft), draft?.id, draft?.intent, draft?.blockId, draft?.itemId, draft?.nodeId, draft?.field, draft?.row, draft?.column, draft?.variant, draft?.referenceStatus, tocDocked, showMargins, insights, fontSize, readingWidthPercent, readingMode, targetLanguage, translationFirst]);
  useEffect(() => { if (draft) inputRef.current?.focus({ preventScroll: true }); }, [draft?.id, draft?.blockId]);
  useEffect(() => {
    if (typeMenu) document.querySelector('.type-menu [aria-checked="true"]')?.focus({ preventScroll: true });
  }, [typeMenu]);
  useEffect(() => {
    if (colorMenu) document.querySelector('.color-menu [aria-checked="true"]')?.focus();
  }, [colorMenu]);
  useEffect(() => {
    if (!typeMenu && !colorMenu) return;
    const dismiss = (event) => {
      if (!event.target.closest(".composer-type, .type-picker-positioner")) setTypeMenu(false);
      if (!event.target.closest(".color-picker")) setColorMenu(false);
    };
    document.addEventListener("pointerdown", dismiss);
    return () => document.removeEventListener("pointerdown", dismiss);
  }, [typeMenu, colorMenu]);
  useEffect(() => {
    const field = inputRef.current;
    if (field && !draft?.body) field.scrollTop = 0;
  }, [draft?.body]);
  function begin(source = candidate) {
    if (readerReadOnly || !source || draftRef.current) return;
    const enabledColors = getEnabledColors();
    const color = enabledColors.some((item) => item.id === preferences.current.color) ? preferences.current.color : enabledColors[0].id;
    setDraft(ensureDraftIntent({ ...normalizeSource(source), ...preferences.current, color, id: null, body: "" }));
    setCandidate(null); window.getSelection()?.removeAllRanges(); setTypeMenu(false); setColorMenu(false);
  }
  function persistDraftBeforeSave(value) {
    if (!managed) return;
    if (!sessionStorage) throw new Error("本机草稿暂时无法保存，请保留当前页面并重试。");
    sessionStorage.setItem("reader-draft:" + sessionKey, JSON.stringify(value));
    window.continuousReaderDesktop?.persistSession();
  }
  function finishComposerClose() {
    const operation = composerClose.current;
    if (!operation) return;
    composerClose.current = null;
    setComposerClosing(false);
    // A revision refresh or a resumed draft owns its new state. An old exit
    // completion must never clear a different draft or edits made since close.
    if (draftRef.current !== operation.draft) return;
    const saved = operation.saved;
    setDraft(null); setTitleOpened(false); setTypeMenu(false); setColorMenu(false); setCandidate(null); setSaveError("");
    const origin = editOrigin.current;
    editOrigin.current = null;
    if (origin?.tool) setTool(origin.tool);
    if (origin?.questionId && (!saved?.id || saved.type === "question")) setQuestionId(origin.questionId);
    if (origin?.marginGroup) setMarginDetail(origin.marginGroup);
    requestAnimationFrame(() => {
      if (origin?.trigger?.isConnected && !origin.trigger.closest('[inert], [aria-hidden="true"]')) origin.trigger.focus({ preventScroll: true });
      else articleRef.current?.focus({ preventScroll: true });
    });
  }
  function closeComposer(saved) {
    if (composerClose.current) return;
    setSelectingRequestSource(false);
    setTypeMenu(false);
    setColorMenu(false);
    composerClose.current = { draft: draftRef.current, saved };
    // The same mounted surface now reverses its spring from the current value.
    // No timer is allowed to discard the draft while another target is active.
    if (!composerRef.current) finishComposerClose();
    else setComposerClosing(true);
  }
  async function save() {
    const currentDraft = draftRef.current;
    if (isChangeRequest(currentDraft)) { await saveRequest(currentDraft); return; }
    if (readerReadOnly || !canSaveInsight(currentDraft) || composerRef.current?.dataset.closing || savingRef.current) return;
    const next = insightWrite(normalizeSource(currentDraft), documentId, paper?.revision || 1);
    savingRef.current = true; setSaving(true); setSaveError("");
    try {
      persistDraftBeforeSave(currentDraft);
      const saved = managed ? await onSaveInsight(next, { intentId: currentDraft.clientIntentId }) : assignReference({ ...next, id: next.id || "insight-" + crypto.randomUUID() }, [...notes, ...insightHistory.references.map((reference) => ({ reference }))]);
      if (!saved?.id) throw new Error("保存未完成，请重试。");
      if (managed) draftAcknowledgements.current.markSaved(currentDraft.clientIntentId, saved);
      setNotes((current) => upsertInsight(current, saved));
      preferences.current = { type: next.type, color: next.color }; setActiveNote(saved.id);
      flash(currentDraft.id ? "洞见已更新" : isHighlightOnly(saved) ? "高亮已保存，可在洞见中补充批注" : "洞见已保存");
      if (draftRef.current === currentDraft) closeComposer(saved);
      else setDraft((current) => current ? { ...current, id: saved.id, version: saved.version, reference: saved.reference, references: saved.references } : current);
    } catch (failure) { setSaveError(insightFailureMessage(failure)); }
    finally { savingRef.current = false; setSaving(false); }
  }
  function requestContextItem(source) {
    return { id: "ai-request", label: draftRef.current ? "继续当前草稿" : "AI 请求", icon: PencilSimpleLine,
      disabled: readerReadOnly || saving, onSelect: () => beginChangeRequest(source) };
  }
  function objectRequestItem(element) {
    const descriptor = sourceDescriptor(element);
    const quote = sourceText(paper, descriptor);
    return requestContextItem({ ...descriptor, quote });
  }
  function beginChangeRequest(source = null) {
    if (readerReadOnly) { flash("当前文档为只读，无法新建 AI 请求。"); return; }
    if (savingRef.current) return;
    if (draftRef.current) { resumeDraft(); flash("当前草稿已保留，请先保存或取消。"); return; }
    setDraft(ensureDraftIntent({ ...source, intent: "change-request", id: null, type: "instruction", color: "blue", body: "", documentId, revision: paper?.revision || 1 }));
    setSelectingRequestSource(false); setCandidate(null); setTypeMenu(false); setColorMenu(false); setSaveError(""); setTool(null);
    window.getSelection()?.removeAllRanges();
  }
  async function saveRequest(currentDraft) {
    if (readerReadOnly || !canSaveChangeRequest(currentDraft) || savingRef.current || composerRef.current?.dataset.closing) return;
    const next = changeRequestWrite(currentDraft, documentId, paper?.revision || 1);
    savingRef.current = true; setSaving(true); setSaveError("");
    try {
      persistDraftBeforeSave(currentDraft);
      const saved = managed ? await onSaveChangeRequest(next, currentDraft.version, { intentId: currentDraft.clientIntentId }) : {
        ...next, id: next.id || "change-" + crypto.randomUUID(), version: (currentDraft.version || 0) + 1, status: "pending",
        reference: currentDraft.reference || "#R" + String(Math.max(0, ...changeRequests.map((item) => Number(item.reference?.slice(2)) || 0)) + 1).padStart(5, "0"),
      };
      if (!saved?.id) throw new Error("保存未完成，请重试。");
      if (managed) draftAcknowledgements.current.markSaved(currentDraft.clientIntentId, saved);
      setChangeRequests((current) => upsertInsight(current, saved));
      flash("AI 请求 " + saved.reference + " 已保存，可在洞见中查看并复制给 AI。");
      if (draftRef.current === currentDraft) closeComposer();
      else setDraft((current) => current ? { ...current, id: saved.id, version: saved.version, reference: saved.reference } : current);
    } catch (failure) { setSaveError(failure.message || "暂时无法保存，草稿已保留。"); }
    finally { savingRef.current = false; setSaving(false); }
  }
  async function setRequestStatus(item, status) {
    if (readerReadOnly || savingRef.current) return;
    savingRef.current = true; setSaving(true); setSaveError("");
    try {
      const saved = managed ? await onChangeRequestStatus(item, status) : { ...item, status, version: item.version + 1 };
      setChangeRequests((current) => upsertInsight(current, saved));
      flash(status === "cancelled" ? "AI 请求已撤回。" : "AI 请求已恢复。");
    } catch (failure) { setSaveError(failure.message); }
    finally { savingRef.current = false; setSaving(false); }
  }
  async function archiveNote(note) {
    if (readerReadOnly || savingRef.current || managed && !onDeleteInsight) return;
    if (draftRef.current?.id === note.id) { resumeDraft(); flash("请先保存或取消这条洞见的编辑。"); return; }
    savingRef.current = true; setSaving(true); setSaveError("");
    try {
      const archived = managed ? await onDeleteInsight(note) : { ...note, archivedAt: new Date().toISOString() };
      if (!archived?.id) throw new Error("删除未完成，请重试。");
      setNotes((current) => current.filter((item) => item.id !== note.id));
      setInsightHistory((current) => rememberDeleted(rememberReferences(current, [note]), archived)); setUndoHidden(false);
      if (activeNote === note.id) setActiveNote(null);
      if (questionId === note.id) setQuestionId(null);
      // The open paragraph dialog owns its neighbouring-row focus after a
      // removal. Focusing the article here would fight the native modal.
      if (marginOpenRef.current) return true;
      requestAnimationFrame(() => {
        const container = insights === "sidebar" ? document.querySelector(".insights-panel") : insights === "modal" ? document.querySelector(".insights-modal") : null;
        const index = filtered.findIndex((item) => item.id === note.id);
        const adjacent = filtered[index + 1] || filtered[index - 1];
        const target = adjacent && container?.querySelector('[data-insight-id="' + CSS.escape(adjacent.id) + '"] .insight-more');
        (target || container?.querySelector('[aria-label="关闭洞见"]') || articleRef.current)?.focus({ preventScroll: true });
      });
      return true;
    } catch (failure) { setSaveError(insightFailureMessage(failure, "删除")); return false; }
    finally { savingRef.current = false; setSaving(false); }
  }
  async function toggleInsightReview(note) {
    if (readerReadOnly || savingRef.current || !onReviewInsight) return;
    savingRef.current = true; setSaving(true); setSaveError("");
    try {
      const saved = await onReviewInsight(note);
      if (saved?.id) setNotes((current) => upsertInsight(current, saved));
      flash(note.review?.pending ? "已移出待回顾" : "已加入待回顾");
    } catch (failure) { setSaveError(failure.message || "回顾状态尚未保存，请重试。"); }
    finally { savingRef.current = false; setSaving(false); }
  }
  async function restoreNote() {
    if (readerReadOnly || !removed || savingRef.current || managed && !onRestoreInsight) return;
    savingRef.current = true; setSaving(true); setSaveError("");
    try {
      const saved = managed ? await onRestoreInsight(removed) : { ...removed, archivedAt: null };
      if (!saved?.id) throw new Error("恢复未完成，请重试。");
      setNotes((current) => upsertInsight(current, saved));
      setInsightHistory((current) => forgetRestored(current, saved.id)); setUndoHidden(false); setActiveNote(saved.id);
      flash(saved.reference + " 已恢复");
    } catch (failure) { setSaveError(insightFailureMessage(failure, "恢复")); }
    finally { savingRef.current = false; setSaving(false); }
  }
  function beginDocumentInsight(type) {
    if (readerReadOnly) return;
    if (draftRef.current) { inputRef.current?.focus(); flash("当前草稿已保留，请先保存或取消。"); return; }
    const color = getEnabledColors()[0].id;
    setDraft(ensureDraftIntent({ id: null, type, body: "", color, documentId, revision: paper?.revision || 1, quote: "" }));
    setCandidate(null); setSaveError(""); setTool(null);
  }
  function resumeDraft() {
    composerClose.current = null; setComposerClosing(false);
    setQuestionId(null); setMarginDetail(null); setTool(null);
    requestAnimationFrame(() => inputRef.current?.focus({ preventScroll: true }));
  }
  function openTitle() {
    setTitleOpened(true); setTypeMenu(false); setColorMenu(false);
    requestAnimationFrame(() => titleRef.current?.focus({ preventScroll: true }));
  }
  function editNote(note, trigger, questionOrigin = null, marginOrigin = null) {
    if (readerReadOnly) return;
    if (draftRef.current) { resumeDraft(); if (draftRef.current.id !== note.id) flash("当前草稿已保留，请先保存或取消。"); return; }
    editOrigin.current = { trigger: trigger || document.activeElement, tool: insights, questionId: questionOrigin, marginGroup: marginOrigin };
    const anchor = sourceNavigationAnchor(note);
    setTool(null, anchor); setActiveNote(note.id); setSaveError("");
    revealVariant(note);
    requestAnimationFrame(() => restoreReadingPosition(articleRef.current, anchor, { exactTop: true }));
    setDraft(ensureDraftIntent({ ...note })); setCandidate(null); setTypeMenu(false); setColorMenu(false);
  }
  function menuKeys(event, close, triggerRef, horizontal = false) {
    const options = [...event.currentTarget.querySelectorAll('[role="menuitemradio"]')];
    const index = options.indexOf(document.activeElement);
    const nextKey = horizontal ? "ArrowRight" : "ArrowDown";
    const previousKey = horizontal ? "ArrowLeft" : "ArrowUp";
    if ([nextKey, previousKey, "Home", "End"].includes(event.key)) {
      event.preventDefault();
      const next = event.key === "Home" ? 0 : event.key === "End" ? options.length - 1 : (index + (event.key === nextKey ? 1 : -1) + options.length) % options.length;
      options[next]?.focus({ preventScroll: true });
    } else if (matchesShortcut(event.nativeEvent, "close")) {
      event.preventDefault(); event.stopPropagation(); close(false); triggerRef.current?.focus({ preventScroll: true });
    } else if (event.key === "Tab") {
      event.preventDefault(); close(false); (event.shiftKey ? triggerRef : inputRef).current?.focus({ preventScroll: true });
    }
  }
  function locate(note) {
    if (!note.blockId) { flash("这条洞见关联整篇文档。"); return; }
    if (note.referenceStatus === "unresolved") { flash("这条引用暂时无法精确定位，原摘录已保留。"); return; }
    const anchor = sourceNavigationAnchor(note);
    rememberPosition();
    setActiveNote(note.id);
    setTool(null, anchor);
    revealVariant(note);
    navigateAnchor(anchor, { missing: "这条引用暂时无法精确定位，原摘录已保留。" });
  }
  function revealVariant(note) {
    if (!paper) return;
    if (note.variant && note.variant !== "source") setTargetLanguage(note.variant);
    if (readingMode === "source" && note.variant && note.variant !== "source") setReadingMode("translation");
    if (readingMode === "translation" && (note.variant || "source") === "source") setReadingMode("source");
  }
  function openMarginGroup(groupKey, selectedNoteId = null, trigger = document.activeElement) {
    const group = marginGroups.find((item) => item.key === groupKey);
    if (!group) return;
    setCandidate(null); setSaveError("");
    if (selectedNoteId) setActiveNote(selectedNoteId);
    marginReturnFocus.current = trigger?.isConnected ? trigger : railRef.current?.querySelector("[data-margin-group]") || articleRef.current;
    setMarginDetail({ key: groupKey, selectedNoteId });
  }
  function openQuestion(note, trigger) {
    setCandidate(null); setSaveError("");
    questionReturnFocus.current = trigger || document.activeElement;
    setQuestionId(note.id);
  }
  function returnToQuestionSource(note) {
    setQuestionId(null);
    requestAnimationFrame(() => {
      locate(note);
      articleRef.current?.focus({ preventScroll: true });
    });
  }
  function rememberPosition() {
    const anchor = captureReadingPosition(articleRef.current);
    if (anchor) setReturnHistory((current) => [...current.slice(-19), { ...anchor, mode: readingMode, targetLanguage, translationFirst }]);
  }
  function returnToReading() {
    const anchor = returnHistory.at(-1);
    if (!anchor) { if (onReturnRelatedDocument) { checkpointState.current = captureCheckpoint(); publishCheckpoint(); onReturnRelatedDocument(); } return; }
    setReturnHistory((current) => current.slice(0, -1));
    setReadingMode(anchor.mode); setTargetLanguage(anchor.targetLanguage); setTool(null, anchor);
    navigateAnchor(anchor, { missing: "原阅读位置已变更，当前正文位置保持不变。" });
    articleRef.current?.focus({ preventScroll: true });
  }
  function openRelatedDocument(target) {
    if (!onOpenRelatedDocument) return;
    const returnReadingState = { ...captureCheckpoint(), ...captureReadingPosition(articleRef.current) };
    checkpointState.current = returnReadingState; publishCheckpoint();
    return Promise.resolve(onOpenRelatedDocument({ ...target, returnReadingState }));
  }
  function locateCitation(source) {
    if (!source?.blockId) return;
    rememberPosition();
    const address = { ...source, variant: readingMode === "translation" ? targetLanguage : "source" };
    navigateReader(() => readingPositionTop(articleRef.current, { blockId: source.blockId, source: address })
      ?? readingPositionTop(articleRef.current, { blockId: source.blockId, itemId: source.itemId }));
    articleRef.current?.focus({ preventScroll: true });
  }
  function locatePdf(blockId) {
    const anchor = captureReadingPosition(articleRef.current);
    const source = blockId ? { blockId } : selectedArticleTargets(articleRef.current)[0] || anchor;
    setPdfTarget({ ...source, nonce: crypto.randomUUID() }); setTool("pdf");
  }
  function fromPdf(blockId, explicit = false, itemId) {
    if (explicit) rememberPosition();
    layoutEpoch.current++;
    const anchor = { blockId, ...(itemId ? { itemId } : {}), offsetRatio: 0 };
    if (window.innerWidth <= 850 && explicit) setTool(null, anchor);
    navigateAnchor(anchor, { owner: "pdf" });
    requestAnimationFrame(() => {
      setActiveNote(null);
      const element = document.getElementById(itemId || blockId);
      if (explicit && element) { element.classList.add("source-location-flash"); setTimeout(() => element.classList.remove("source-location-flash"), 1500); articleRef.current?.focus({ preventScroll: true }); }
    });
  }
  async function copySource() {
    if (!paper) return;
    const anchor = captureReadingPosition(articleRef.current);
    try { await navigator.clipboard.writeText(sourceCitation(paper, candidate || anchor)); flash("已复制原文引用"); }
    catch { setSaveError("复制失败，请通过文档详情获取引用。"); }
  }
  useEffect(() => {
    if (!openInsightId || editInsightId === openInsightId || openInsightHandled.current === openInsightId) return;
    const note = notes.find((item) => item.id === openInsightId);
    if (!note) return;
    openInsightHandled.current = openInsightId;
    if (note.type === "question") openQuestion(note); else locate(note);
  }, [openInsightId, editInsightId, notes]);
  useEffect(() => {
    if (!editInsightId || readerReadOnly || editInsightHandled.current === editInsightId) return;
    const note = notes.find((item) => item.id === editInsightId);
    if (!note) return;
    editInsightHandled.current = editInsightId;
    editNote(note);
  }, [editInsightId, notes, readerReadOnly]);
  function paragraph(id) {
    return <p data-block-id={id} id={"p-" + id} className={activeNote && notes.find((note) => note.id === activeNote)?.blockId === id ? "active-paragraph" : ""}><HighlightedText text={TEXTS[id]} items={notes.filter((note) => note.blockId === id && note.id !== draft?.id)} draft={draft?.blockId === id ? draft : null} /></p>;
  }
  const equation = useCallback((id, variant = "source") => {
    const matches = (note) => note?.blockId === id && (note.variant || "source") === variant && note.referenceStatus !== "unresolved";
    const currentDraft = matches(highlightDraft) ? highlightDraft : null;
    const highlight = currentDraft || notes.findLast((note) => matches(note) && note.id !== highlightDraft?.id);
    const tex = paper ? sourceText(paper, { blockId: id, variant, field: "tex" }) : equations[id].tex;
    return <Equation id={id} {...equations[id]} tex={tex} variant={variant} highlight={highlight} isDraft={!!currentDraft} active={matches(notes.find((note) => note.id === activeNote))} />;
  }, [highlightDraft, notes, paper, equations, activeNote]);
  // Object actions execute against the latest committed Reader state without
  // invalidating every object/context consumer on each composer keystroke.
  const articleActions = useRef(null);
  useLayoutEffect(() => {
    articleActions.current = { objectRequestItem, locatePdf, openImage(image) {
      const imagePreview = imagePreviewFromClick({ target: image, currentTarget: articleRef.current, button: 0, preventDefault() {} });
      if (imagePreview) { setCandidate(null); setImagePreview(imagePreview); }
    } };
  });
  const objectActions = useMemo(() => ({
    requestMenuItem: (...args) => articleActions.current.objectRequestItem(...args),
    onLocateSource: (...args) => articleActions.current.locatePdf(...args),
    onOpenImage: (...args) => articleActions.current.openImage(...args),
  }), []);
  const canLocatePdf = Boolean(sourceApiBase && sourceIsPdf && paper?.source?.path);
  const paperContent = useMemo(() => paper && <ObjectSizingProvider sessionKey={sessionKey} documentId={documentId} documentRevision={paper.revision}
    requestMenuItem={objectActions.requestMenuItem} onLocateSource={canLocatePdf ? objectActions.onLocateSource : undefined} onOpenImage={objectActions.onOpenImage}>
    <PaperArticle paper={paper} mode={readingMode} targetLanguage={targetLanguage} translationFirst={translationFirst} notes={notes} draft={highlightDraft} activeNote={activeNote} equation={equation} />
  </ObjectSizingProvider>, [paper, sessionKey, documentId, objectActions, canLocatePdf, readingMode, targetLanguage, translationFirst, notes, highlightDraft, activeNote, equation]);
  const filtered = useMemo(() => filter === "all" ? notes : notes.filter((note) => note.type === filter), [notes, filter]);
  const requestDraft = isChangeRequest(draft);
  const CurrentType = requestDraft ? CHANGE_TYPES.find((type) => type.id === draft.type) : typeFor(draft?.type);
  const marginVisible = showMargins && !insights;
  const selectedQuestion = notes.find((note) => note.id === questionId && note.type === "question");
  if (selectedQuestion) retainedQuestion.current = selectedQuestion;
  if (marginDetail) retainedMarginDetail.current = { ...marginDetail, notes: marginGroups.find((group) => group.key === marginDetail.key)?.notes || [] };
  const selectedDetail = filtered.find((note) => note.id === detailId) || filtered[0];
  const hasPanel = ["sidebar", "glossary", "pdf"].includes(insights);
  const actions = useCommittedActions({
    closeInsights, beginDocumentInsight, copyReference, editNote, archiveNote, toggleInsightReview,
    restoreNote, openNoteContext, openQuestion, locate, setRequestStatus, openMarginGroup, navigateToc,
    toggleToc, previewToc, leaveTocPreview, changeReadingMode, copySource, returnToReading,
    back() { checkpointState.current = captureCheckpoint(); publishCheckpoint(); onBack(); },
    openNotes() { checkpointState.current = captureCheckpoint(); publishCheckpoint(); onOpenNotes(checkpointState.current); },
    source() { insights === "pdf" ? setTool(null) : locatePdf(); },
    insights() { setTool(insights === "sidebar" || insights === "modal" ? null : openMode); },
    glossary() { setTool(insights === "glossary" ? null : "glossary"); },
    margins(value) { preserveLayout(); setShowMargins(value); },
    settings() { setSettings(true); setCandidate(null); },
  });
  const noteLabel = (note) => isHighlightOnly(note) ? "高亮" : typeFor(note.type).label;
  const referenceText = (note) => <span className="reference-number">{note.reference}</span>;
  const referenceButton = (note) => <button className="insight-reference" aria-label={"复制" + noteLabel(note) + "编号 " + note.reference} title="复制编号" onClick={() => actions.copyReference(note)}>{referenceText(note)}</button>;
  const insightIdentity = useCallback((note) => <span className="insight-identity"><span>{noteLabel(note)}</span>{note.type === "question" ? referenceText(note) : referenceButton(note)}</span>, [actions]);
  const insightActions = useCallback((note) => <InsightActions note={note} onEdit={actions.editNote} onDelete={actions.archiveNote} onCopy={actions.copyReference} onReview={onReviewInsight ? actions.toggleInsightReview : undefined} readOnly={readerReadOnly} busy={saving} editing={draft?.id === note.id} deleteUnavailable={managed && !onDeleteInsight} />, [actions, Boolean(onReviewInsight), readerReadOnly, saving, draft?.id, managed, Boolean(onDeleteInsight)]);
  const undoContent = useMemo(() => <><span>已删除 {removed?.reference}{insightHistory.deleted.length > 1 ? " · 共 " + insightHistory.deleted.length + " 条" : ""}</span><button disabled={readerReadOnly || saving || managed && !onRestoreInsight} onClick={actions.restoreNote}>撤销删除</button></>, [removed?.reference, insightHistory.deleted.length, readerReadOnly, saving, managed, Boolean(onRestoreInsight), actions]);
  function insightList(modal = false) {
    return <>
      <div className="insights-heading"><div><h2>洞见</h2><p>{documentTitle} <span>· {notes.length} 条</span></p></div><button className="icon-button" aria-label="关闭洞见" onClick={actions.closeInsights}><X size={20} /></button></div>
      <div className="insight-create-actions"><button disabled={readerReadOnly} onClick={() => actions.beginDocumentInsight("note")}><Plus size={14} />文档笔记</button><button disabled={readerReadOnly} onClick={() => actions.beginDocumentInsight("question")}><Question size={14} />文章问题</button></div>
      <AnimatePresence>{removed && <MotionItem as="div" key="undo" className="insight-undo-inline" role="status">{undoContent}</MotionItem>}</AnimatePresence>
      <div className="insight-tabs" role="tablist" aria-label="洞见分类">{[{ id: "all", label: "全部" }, ...TYPES].map((type) => <button key={type.id} role="tab" aria-selected={filter === type.id} onClick={() => setFilter(type.id)}>{type.label}<small>{type.id === "all" ? notes.length : notes.filter((note) => note.type === type.id).length}</small></button>)}</div>
      <div className={modal ? "insight-master-detail" : undefined}><div className="insight-list">
        <AnimatePresence initial={false} mode="popLayout">
        {!filtered.length && !(filter === "all" && changeRequests.length) && <MotionItem as="div" key="empty" className="empty-state"><ChatText size={30} /><p>暂无{filter === "all" ? "洞见" : typeFor(filter).label}</p><span>选中文字或公式后，右键添加洞见。</span></MotionItem>}
        {filtered.map((note) => {
          const Kind = typeFor(note.type);
          const HighlightIcon = isHighlightOnly(note) ? Highlighter : Kind.Icon;
          return <MotionItem as="section" key={note.id} className={"insight-entry" + (modal && selectedDetail?.id === note.id ? " is-selected" : "")} data-insight-id={note.id} data-context-active={contextMenu.targetId === "insight:" + note.id || undefined} tabIndex={-1} onContextMenu={(event) => actions.openNoteContext(event, note)} onKeyDown={(event) => { if (isContextKey(event)) actions.openNoteContext(event, note); }}>
            <div className="insight-entry-header"><div className="entry-type"><HighlightIcon size={17} />{insightIdentity(note)}{note.type === "question" ? <span className="question-state">{note.answer ? "已解决" : "待回答"}</span> : <span className="entry-color" style={{ background: colorFor(note.color).value }} />}</div>{insightActions(note)}</div>
            {note.type === "question" ? <button className="question-entry" aria-haspopup="dialog" onClick={() => { setDetailId(note.id); actions.openQuestion(note); }}>{note.title && <span className="insight-entry-title">{note.title}</span>}<span className="question-entry-body">{note.body}</span></button> : <>{note.title && <button className="insight-title-button" onClick={() => modal ? setDetailId(note.id) : actions.locate(note)}>{note.title}</button>}<InsightQuote note={note} sourceLanguage={paper?.meta.language} />{(note.body || "").trim() && <button className="insight-body-button" onClick={() => modal ? setDetailId(note.id) : actions.locate(note)}>{note.body}</button>}</>}
            <div className="entry-actions">{note.blockId && <button onClick={() => actions.locate(note)}>回到原文 <ArrowUpRight size={13} /></button>}{modal && <button onClick={() => setDetailId(note.id)}>详情</button>}{isHighlightOnly(note) && <button disabled={readerReadOnly || saving} onClick={() => actions.editNote(note)}>补充批注</button>}</div>
          </MotionItem>;
        })}
        </AnimatePresence>
        {filter === "all" && changeRequests.length > 0 && <section className="change-request-list" aria-label="已保存的 AI 请求"><h3>AI 请求 <span>{changeRequests.length}</span></h3>{changeRequests.map((item) => {
          const note = normalizeSource(requestEntry(item));
          const Kind = CHANGE_TYPES.find((type) => type.id === item.category) || CHANGE_TYPES[2];
          return <section className="insight-entry" data-change-request-id={item.id} key={item.id}><div className="entry-type"><Kind.Icon size={17} /><span className="insight-identity"><span>{Kind.label}</span><button className="insight-reference" aria-label={"复制 AI 请求编号 " + item.reference} title="复制编号给 AI" onClick={() => actions.copyReference(item)}>{referenceText(item)}</button></span><span className="question-state">{item.status === "completed" ? "已处理" : item.status === "cancelled" ? "已撤回" : "待处理"}</span></div><InsightQuote note={note} sourceLanguage={paper?.meta.language} /><p className="change-request-body">{item.body}</p><div className="entry-actions">{note.blockId && <button onClick={() => actions.locate(note)}>回到原文 <ArrowUpRight size={13} /></button>}{item.status === "pending" && <button disabled={readerReadOnly || saving} onClick={() => { actions.editNote(note); setSelectingRequestSource(false); }}>编辑</button>}{item.status !== "completed" && <button disabled={readerReadOnly || saving || draft?.id === item.id} onClick={() => actions.setRequestStatus(item, item.status === "cancelled" ? "pending" : "cancelled")}>{item.status === "cancelled" ? "恢复请求" : "撤回请求"}</button>}</div></section>;
        })}</section>}
      </div><AnimatePresence initial={false} mode="popLayout">{modal && selectedDetail && <MotionItem as="section" key={selectedDetail.id} layout={false} className="insight-detail" aria-label="所选洞见详情"><div className="insight-entry-header"><div className="entry-type">{insightIdentity(selectedDetail)}</div>{insightActions(selectedDetail)}</div>{selectedDetail.title && <h3 className="insight-detail-title">{selectedDetail.title}</h3>}<InsightQuote note={selectedDetail} sourceLanguage={paper?.meta.language} /><p>{selectedDetail.body}</p>{selectedDetail.type === "question" && <button onClick={() => actions.openQuestion(selectedDetail)}>查看完整问题与回答</button>}</MotionItem>}</AnimatePresence></div>
    </>;
  }
  // Stable saved-content subtrees also avoid Motion's layout snapshots on
  // unrelated keystrokes. They remain mounted through closing/reopening.
  const [sidebarContent, modalContent] = useMemo(() => [insightList(), insightList(true)], [documentTitle, notes, undoContent, removed, filter, filtered, selectedDetail,
    actions, insightIdentity, insightActions, readerReadOnly, saving, paper, equations, managed,
    draft?.id, changeRequests, contextMenu.targetId]);
  const outlineContent = useMemo(() => paper && <PaperToc paper={paper} mode={readingMode} targetLanguage={targetLanguage} onNavigate={actions.navigateToc} />, [paper, readingMode, targetLanguage, actions]);
  const marginContent = useMemo(() => <AnimatePresence initial={false}>
    {marginGroups.filter((group) => marginLayouts[group.key]).map((group) => <MarginGroup key={group.key} group={group} layout={marginLayouts[group.key]}
      activeNote={activeNote} occluded={occludedNotes[group.key]} onOpen={actions.openMarginGroup} onOpenQuestion={actions.openQuestion}
      onContextMenu={actions.openNoteContext} isContextKey={isContextKey} contextTargetId={contextMenu.targetId} renderIdentity={insightIdentity} renderActions={insightActions} />)}
  </AnimatePresence>, [marginGroups, marginLayouts, activeNote, occludedNotes, actions, contextMenu.targetId, insightIdentity, insightActions]);
  const topbarContent = useMemo(() => <ReaderTopbar onHeightChange={setTopbarHeight} title={documentTitle} preview={preview}
      onBack={onBack ? actions.back : undefined} backLabel={backLabel}
      onOpenNotes={onOpenNotes && !preview ? actions.openNotes : undefined} onPreloadNotes={onPreloadNotes}
      hasToc={hasNavigation} tocTitle={navigation.title} showToc={showToc} tocPinned={tocPinned} onToggleToc={actions.toggleToc} onPreviewToc={actions.previewToc} onLeaveToc={actions.leaveTocPreview} paper={paper} mode={readingMode} targetLanguage={targetLanguage} onModeChange={actions.changeReadingMode}
      sourceTrigger={sourceTrigger} sourceHref={paper?.source?.path ? documentAssetUrl(paper, paper.source.path) : null}
      sourceActive={insights === "pdf"} onSource={canLocatePdf ? actions.source : undefined}
      insightTrigger={insightTrigger} insightCount={notes.length} insightsActive={insights === "sidebar" || insights === "modal"} onInsights={actions.insights}
      glossaryActive={insights === "glossary"} onGlossary={runtime.capabilities.glossary ? actions.glossary : undefined}
      showMargins={showMargins} onMargins={actions.margins} onCopySource={actions.copySource}
      onSettings={actions.settings} canReturn={!!returnHistory.length || Boolean(onReturnRelatedDocument)} onReturn={actions.returnToReading} returnLabel={!returnHistory.length && relatedReturnTitle ? `返回《${relatedReturnTitle}》` : undefined}
      shortcutLabels={{ insights: shortcuts.insightSidebar ? " · " + formatShortcut(shortcuts.insightSidebar) : "", settings: shortcuts.settings ? " · " + formatShortcut(shortcuts.settings) : "", margins: shortcuts.margins ? formatShortcut(shortcuts.margins) : "" }} />, [documentTitle, preview, Boolean(onBack), backLabel, Boolean(onOpenNotes), onPreloadNotes,
    hasNavigation, navigation.title, showToc, tocPinned, paper, readingMode, targetLanguage, canLocatePdf, insights, notes.length,
    runtime.capabilities.glossary, showMargins, returnHistory.length, Boolean(onReturnRelatedDocument), relatedReturnTitle, shortcuts, actions]);
  return <div className={"reader-app" + (paper ? " paper-reader" : "") + (!showToc ? " toc-hidden" : "") + (!tocDocked ? " toc-temporary" : "") + (managed ? " managed-reader" : "") + (insights === "pdf" ? " pdf-open" : "")} data-reader-runtime={runtime.mode} data-reader-mode={readingMode} data-reader-font-size={fontSize} data-reader-width-percent={readingWidthPercent} data-pdf-resizing={pdfResize.resizing || undefined} style={{ "--reading-size": fontSize + "px", "--reading-width-ratio": readingWidthPercent / 100, "--pdf-panel-width": pdfResize.width + "px", "--top-height": topbarHeight ? topbarHeight + "px" : undefined }}>
    {topbarContent}
    {/* Fixed outline coordinates exclude page scrolling; ReaderToc owns its inner scroll offset. */}
    <AnimatePresence>{showToc && !tocDocked && <MotionItem as={wideViewport ? "div" : "button"} key="toc-backdrop" className="toc-backdrop" layout={false} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} aria-hidden={wideViewport || undefined} aria-label={wideViewport ? undefined : "收起临时目录"} onClick={wideViewport ? undefined : closeTemporaryToc} />}</AnimatePresence>
    <AnimatePresence initial={false}>{hasNavigation && <MotionItem as="nav" key="reader-toc" layoutRoot layoutScroll layout={false} initial={false} animate={{ x: showToc ? 0 : "-100%", opacity: showToc ? 1 : 0 }} exit={{ x: "-100%", opacity: 0 }} transition={motionTransition("panel", reducedMotion)} style={{ visibility: "visible" }} data-motion-surface="toc" ref={tocRef} id="reader-toc" className="toc polished-toc" aria-label={navigation.kind === "auxiliary" ? "阅读导航" : "文章目录"} data-navigation-kind={paper ? navigation.kind : "headings"} data-state={showToc ? "open" : "closed"} onPointerEnter={clearTocPreviewTimer} onPointerLeave={leaveTocPreview} onFocusCapture={clearTocPreviewTimer} onBlurCapture={leaveTocPreview} inert={!showToc} aria-hidden={!showToc || undefined}><div className="toc-title"><a href="#section-main" title="回到文章开头" onClick={navigateToc}>{navigation.title}</a></div>{paper ? outlineContent : <><div className="toc-book">Direct Preference<br />Optimization</div><a className="toc-section active" aria-current="page" href="#section-main" onClick={navigateToc}><span>4</span>直接偏好优化</a><div className="toc-sub"><a href="#section-policy" onClick={navigateToc}>最优策略</a><a href="#section-preference" onClick={navigateToc}>奖励与偏好</a><a href="#section-objective" onClick={navigateToc}>DPO 目标</a></div></>}</MotionItem>}</AnimatePresence>
    <main className={"reader-main" + (hasPanel ? " has-panel" : "")} inert={insights === "pdf" && !wideViewport} aria-hidden={insights === "pdf" && !wideViewport || undefined}><div className={"reading-layout" + (!marginVisible ? " margins-hidden" : "")}>
      <article ref={articleRef} tabIndex={-1} className="article" aria-label="文章正文" data-selecting-request={selectingRequestSource} {...citationPreview.articleEvents} onPointerDownCapture={captureContextSelection} onContextMenu={openArticleContext} onKeyDown={(event) => { if (isContextKey(event)) openArticleContext(event); else citationPreview.articleEvents.onKeyDown?.(event); }} onClick={(event) => { pickRequestBlock(event); if (selectingRequestRef.current) { event.preventDefault(); return; } const image = imagePreviewFromClick(event); if (image) { setCandidate(null); setImagePreview(image); return; } if (citationPreview.interceptClick(event)) { setCandidate(null); return; } if (navigateArticleLink(event, event.target.closest("a[href^='#']"))) return;
        const mark = event.target.closest("[data-insight-id]");
        if (mark && !event.target.closest("a") && window.getSelection()?.isCollapsed && !draftRef.current) {
          const note = notes.find((item) => item.id === mark.dataset.insightId);
          if (note) {
            setCandidate(null); setActiveNote(note.id); setDetailId(note.id); setFilter("all");
            const group = marginGroups.find((item) => item.notes.some((entry) => entry.id === note.id));
            if (note.type === "question") openQuestion(note);
            else if (group) openMarginGroup(group.key, note.id, articleRef.current);
            else { setTool("sidebar"); requestAnimationFrame(() => document.querySelector('.insights-panel [data-insight-id="' + CSS.escape(note.id) + '"] .insight-more')?.focus({ preventScroll: false })); }
          }
        } }}>{readerReadOnly && !preview && <p className="reader-document-status" role="status">{paper?.unsupportedSchema ? "此文档包含暂不支持的格式，正文以只读方式展示；原始内容保留。" : "此文档以只读方式展示，已有洞见与草稿保留。"}</p>}{paper ? paperContent : <><h1 id="section-main">4 <span>直接偏好优化</span></h1>
        {paragraph("goal")}<h2 id="section-policy">从最优策略出发</h2>{paragraph("policy")}
        {equation("policy-equation")}
        {paragraph("reward")}{equation("reward-equation")}{paragraph("cancel")}
        <h2 id="section-preference">4.1　从奖励到偏好概率</h2>{paragraph("preference")}{paragraph("reference")}<h2 id="section-objective">4.2　理解训练目标</h2>{paragraph("objective")}{paragraph("boundary")}</>}
        {!preview && <CitationBacklinks relations={relations} onOpenDocument={openRelatedDocument} />}
        {!preview && <footer className="article-footer"><span>{managed ? "洞见保存于工作台，未完成的草稿保留在此标签页" : "洞见与草稿保留在当前标签页会话"}</span>{paper?.downloads?.map((item) => <a key={item.path} href={documentAssetUrl(paper, item.path)} download>{item.label}</a>)}{!managed && <button disabled={readerReadOnly} onClick={() => { setNotes(seedNotes()); closeComposer(); setActiveNote(null); setQuestionId(null); flash("示例内容已重置"); }}>重置示例</button>}</footer>}
      </article>
      <aside ref={railRef} className="margin-rail" aria-label="与原文对齐的洞见" data-state={marginVisible ? "open" : "closed"} inert={!marginVisible} aria-hidden={!marginVisible || undefined}>
        {marginContent}
      </aside>
    </div></main>
    {draft && <ComposerSurface draft={draft} closing={composerClosing} onExitComplete={finishComposerClose} position={composerPosition} composerRef={composerRef} inputRef={inputRef} titleExpanded={titleExpanded} typeMenu={typeMenu} colorMenu={colorMenu} onSave={save} context={requestDraft ? <div className="request-context"><span className="request-context-label">AI 请求</span><span className="request-context-source" title={draft.quote || "整篇文章"}>{selectingRequestSource ? "选择文字或点击内容以限定范围" : draft.blockId ? (draft.variant && draft.variant !== "source" ? "译文 · " : "原文 · ") + (draft.quote || "所选内容") : "整篇文章"}</span>{draft.blockId && <button disabled={saving || readerReadOnly} title="改为整篇文章" aria-label="清除请求范围，改为整篇文章" onClick={() => { setDraft((current) => withoutRequestSource(current)); setSelectingRequestSource(false); inputRef.current?.focus(); }}><X size={12} /></button>}</div> : draft.id ? <div className="insight-edit-context"><span>编辑{noteLabel(draft)}</span><span className="reference-number">{draft.reference}</span>{draft.answer && <small>已有回答会保留</small>}</div> : null}>
      <InsightTypePicker types={requestDraft ? CHANGE_TYPES : TYPES} label={requestDraft ? "请求类型" : "洞见类型"} type={draft.type} open={typeMenu && !readerReadOnly} disabled={readerReadOnly} composerRef={composerRef} triggerRef={typeTriggerRef} inputRef={inputRef} onOpenChange={(open) => { setTypeMenu(open); if (open) setColorMenu(false); }} onTypeChange={(type) => setDraft((current) => ({ ...current, type }))} />
      {titleExpanded && <ComposerTitleField title={draft.title} titleRef={titleRef} inputRef={inputRef} readOnly={readerReadOnly} onChange={(title) => { setTitleOpened(true); setDraft((current) => ({ ...current, title })); }} />}
      <div className="composer-input">
        <ComposerTextarea ref={inputRef} rows={1} aria-label={requestDraft ? "请求内容" : "洞见内容"} maxLength={requestDraft ? 20000 : undefined} readOnly={readerReadOnly} placeholder={draft.type === "annotation" ? "写下批注，或直接保存高亮…" : CurrentType.placeholder} value={draft.body} onChange={(event) => setDraft({ ...draft, body: event.target.value })} />
        <ComposerActions requestDraft={requestDraft}>
          {!requestDraft && <button className="composer-title-trigger" aria-label={titleExpanded ? "编辑标题" : "添加标题"} aria-expanded={titleExpanded} disabled={readerReadOnly || saving} onClick={openTitle}>{titleExpanded ? "标题" : "添加标题"}</button>}
          {requestDraft ? <button className="request-location-trigger color-trigger" aria-label="选择请求范围" title="选择请求范围" aria-pressed={selectingRequestSource} disabled={readerReadOnly || saving} onClick={() => { setSelectingRequestSource(!selectingRequestSource); setTypeMenu(false); if (!selectingRequestSource) articleRef.current?.focus({ preventScroll: true }); }}><Crosshair size={16} /></button> : <InsightColorPicker color={draft.color} open={colorMenu && !readerReadOnly} disabled={readerReadOnly} onOpenChange={(open) => { setColorMenu(open); setTypeMenu(false); }} onColorChange={(color) => setDraft({ ...draft, color })} triggerRef={colorTriggerRef} inputRef={inputRef} onMenuKeys={(event) => menuKeys(event, setColorMenu, colorTriggerRef, true)} />}
          <button className="save-button" aria-label={saving ? "保存中" : requestDraft ? "保存 AI 请求" : isHighlightOnly(draft) ? "保存高亮" : draft.id ? "保存修改" : "保存洞见"} title={"保存" + (shortcuts.save ? " · " + formatShortcut(shortcuts.save) : "")} disabled={readerReadOnly || saving || !(requestDraft ? canSaveChangeRequest(draft) : canSaveInsight(draft))} onClick={save}><Check size={16} weight="bold" /></button>
          <button className="cancel-button" aria-label="取消" title={"取消" + (shortcuts.close ? " · " + formatShortcut(shortcuts.close) : "")} disabled={saving} onClick={closeComposer}><X size={15} /></button>
        </ComposerActions>
      </div>
    </ComposerSurface>}
    <div className="insights-drawer" style={{ visibility: "visible" }} data-state={insights === "sidebar" ? "open" : "closed"} inert={insights !== "sidebar"} aria-hidden={insights !== "sidebar" || undefined}><motion.aside initial={false} animate={{ x: insights === "sidebar" ? 0 : "100%", opacity: insights === "sidebar" ? 1 : 0 }} transition={motionTransition("panel", reducedMotion)} data-motion-surface="insights" className="insights-panel" aria-label="洞见边栏" onKeyDown={(event) => { if (!event.defaultPrevented && matchesShortcut(event.nativeEvent, "close", shortcuts)) { event.preventDefault(); event.stopPropagation(); closeInsights(); } }}>{sidebarContent}</motion.aside></div>
    <motion.div ref={insightsBackdropRef} initial={false} animate={{ backgroundColor: insights === "modal" ? "#24282d30" : "#24282d00" }} transition={{ ...MOTION_FADE, duration: reducedMotion ? 0 : MOTION_FADE.duration }} className="overlay insights-overlay" data-motion-surface="insights-overlay" style={{ visibility: insightsModalPresence.present ? "visible" : "hidden" }} data-state={insights === "modal" ? "open" : "closed"} inert={insights !== "modal" || settings} aria-hidden={insights !== "modal" || settings || undefined} onClick={(event) => { if (event.target === event.currentTarget) setTool(null); }}><motion.section {...insightsModalPresence.motionProps} data-motion-surface="insights-modal" className="insights-modal" role="dialog" aria-modal="true" aria-label="洞见面板">{modalContent}</motion.section></motion.div>
    {runtime.capabilities.glossary && <GlossaryPanel open={insights === "glossary"} onClose={() => setTool(null)} documentId={documentId} documentTitle={documentTitle} apiBase={glossaryApi || (managed ? "/api/glossary" : undefined)} />}
    {sourceApiBase && <PdfPanel open={insights === "pdf"} onClose={() => { setTool(null); requestAnimationFrame(() => sourceTrigger.current?.focus({ preventScroll: true })); }} paper={paper} apiBase={sourceApiBase} follow={pdfFollow} onFollowChange={setPdfFollow} target={pdfTarget} articleRef={articleRef} ownership={scrollOwnership.current} onLocate={fromPdf} onLocateCurrent={() => locatePdf()} panelWidth={pdfResize.width} separatorProps={pdfResize.separatorProps} />}
    {imagePreview && <ImageLightbox image={imagePreview} shortcuts={shortcuts} onClose={() => setImagePreview(null)} />}
    <ReferencePreview preview={citationPreview} documentId={documentId} onOpenDocument={openRelatedDocument} onLocate={locateCitation} onCommand={onRelationCommand} readOnly={readerReadOnly || relations?.readOnly} />
    <ReaderInterfaceScale />
    <ReaderLayoutMotion tocDocked={tocDocked} marginVisible={marginVisible} tool={insights} readingWidthPercent={readingWidthPercent} resizing={pdfResize.resizing} panelWidth={pdfResize.width} />
    <ReadingSettings open={settings} onClose={() => setSettings(false)} fontSize={fontSize} onFontSizeChange={(fontSize) => { preserveLayout(); runtime.reading.update({ fontSize }); }} readingWidthPercent={readingWidthPercent} onReadingWidthChange={(readingWidthPercent) => { preserveLayout(); runtime.reading.update({ readingWidthPercent }); }} showMargins={showMargins} onMarginsChange={(value) => { preserveLayout(); setShowMargins(value); }} openMode={openMode} onOpenModeChange={setOpenMode} tocMode={tocMode} onTocModeChange={(value) => { preserveLayout(); clearTocPreviewTimer(); setTocMode(value); setTocTemporary(false); }} mode={readingMode} onModeChange={changeReadingMode} targetLanguage={targetLanguage} languages={languages} onTargetLanguageChange={(value) => { preserveLayout(); setTargetLanguage(value); }} translationFirst={translationFirst} onTranslationFirstChange={(value) => { preserveLayout(); setTranslationFirst(value); }} pdfAvailable={Boolean(sourceApiBase && sourceIsPdf)} pdfFollow={pdfFollow} onPdfFollowChange={setPdfFollow} />
    {retainedQuestion.current && <QuestionDetail open={Boolean(selectedQuestion)} question={retainedQuestion.current} returnFocus={questionReturnFocus.current} sourceLanguage={paper?.meta.language} onClose={() => setQuestionId(null)} onLocate={returnToQuestionSource} onEdit={(note, trigger) => { setQuestionId(null); requestAnimationFrame(() => editNote(note, trigger, note.id)); }} onDelete={archiveNote} onReview={onReviewInsight ? toggleInsightReview : undefined} readOnly={readerReadOnly} busy={saving} editing={draft?.id === retainedQuestion.current.id} deleteUnavailable={managed && !onDeleteInsight} error={saveError} />}
    {retainedMarginDetail.current && <MarginGroupDetail open={Boolean(marginDetail)} groupId={retainedMarginDetail.current.key} notes={retainedMarginDetail.current.notes}
      selectedNoteId={retainedMarginDetail.current.selectedNoteId} returnFocus={marginReturnFocus.current} sourceLanguage={paper?.meta.language} colorFor={colorFor}
      onClose={() => setMarginDetail(null)} onLocate={(note) => { locate(note); articleRef.current?.focus({ preventScroll: true }); }}
      onEdit={(note, trigger) => editNote(note, trigger, null, { key: retainedMarginDetail.current.key, selectedNoteId: note.id })}
      onDelete={archiveNote} onReview={onReviewInsight ? toggleInsightReview : undefined} onCopy={copyReference} onOpenQuestion={openQuestion}
      readOnly={readerReadOnly} busy={saving} editingId={draft?.id} deleteUnavailable={managed && !onDeleteInsight} error={saveError} />}
    <AnimatePresence>{saveError && <MotionNotice key="save-error" className="reader-save-error" role="alert"><span>{saveError}</span><button aria-label="关闭保存提示" onClick={() => setSaveError("")}><X size={14} /></button></MotionNotice>}</AnimatePresence>
    <AnimatePresence>{removed && !undoHidden && !["sidebar", "modal"].includes(insights) && <MotionNotice key="reader-undo" className="reader-undo" role="status">{undoContent}<button aria-label="收起删除提示" onClick={() => setUndoHidden(true)}><X size={13} /></button></MotionNotice>}</AnimatePresence>
    <AnimatePresence>{notice && <MotionNotice key="notice" className="toast visible" role="status" aria-live="polite"><Check size={16} />{notice}</MotionNotice>}</AnimatePresence>
    {contextMenu.element}
  </div>;
}
