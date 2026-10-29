import { matchesShortcut } from "./reading-shortcuts";
import { useReaderRuntime } from "./ReaderRuntime";
import { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion, useMotionValueEvent, useSpring } from "motion/react";
import { MotionItem } from "./Motion.jsx";
import { motionTransition } from "./motion-system.js";
import { useReducedMotionPreference } from "./useReducedMotionPreference.js";
import { createPdfPageResources, preparePdfPage } from "./pdf-page-preparation.js";
import { loadPdfDocument } from "./pdf-document.js";
import { ArrowLeft, ArrowSquareOut, ArrowsClockwise, CaretLeft, CaretRight, Crosshair, Minus, Plus, X } from "./icons";
import { blockAtPage, captureReadingPosition, readingLine, regionForBlock, sourceRegions } from "./reading-position";
import { documentAssetUrl, documentPdfBytesUrl } from "./document-resource";
import { clickedArticleTarget, pointedArticleTarget, selectedArticleTargets } from "./pdf-selection";
import { PdfPanelResizeHandle } from "./PdfPanelResizeHandle";
import { paragraphRegions } from "./pdf-paragraph-regions";
import { usePdfPageView } from "./usePdfPageView";
import { clampPdfPage, preservePdfCandidateView, reconcilePdfTargets } from "./pdf-candidate-state.js";

export function PdfPanel({ open, onClose, paper, apiBase, follow, onFollowChange, target, articleRef, ownership, onLocate, onLocateCurrent, separatorProps }) {
  const runtime = useReaderRuntime();
  const reduced = useReducedMotionPreference();
  const [manifestRecord, setManifest] = useState(null);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [page, setPage] = useState(1);
  const [activeTargets, setActiveTargets] = useState([]);
  const [zoom, setZoom] = useState(1);
  const zoomValue = useSpring(zoom, motionTransition("layout"));
  const [renderedZoom, setRenderedZoom] = useState(zoom);
  useMotionValueEvent(zoomValue, "change", setRenderedZoom);
  useEffect(() => { if (reduced) zoomValue.jump(zoom); else zoomValue.set(zoom); }, [zoom, reduced, zoomValue]);
  const [imageFailures, setImageFailures] = useState({});
  const [preparedPage, setPreparedPage] = useState(null);
  const pageResources = useMemo(() => createPdfPageResources(), []);
  const latestImage = useRef(null);
  useEffect(() => () => pageResources.dispose(), [pageResources]);
  const scroller = useRef(null), closeButton = useRef(null), handledTarget = useRef(null), currentPage = useRef(1);
  const previousFollow = useRef(follow);
  const pointer = useRef(null);
  const activeTargetsRef = useRef(activeTargets);
  activeTargetsRef.current = activeTargets;
  const callbacks = useRef({ onLocate });
  callbacks.current = { onLocate };
  const expectedHash = paper?.source?.sha256;
  const previousSource = useRef(null), pendingTargets = useRef(null);
  const originalSourceUrl = paper?.source?.path ? documentAssetUrl(paper.assetBase || !apiBase ? paper : { ...paper, assetBase: apiBase + "/assets/" }, paper.source.path) : null;
  const sourceUrl = documentPdfBytesUrl(paper, apiBase);
  const requestKey = apiBase + ":" + paper?.revision + ":" + expectedHash + ":" + sourceUrl;
  const manifest = manifestRecord?.key === requestKey ? manifestRecord.data : null;
  const regions = useMemo(() => sourceRegions(paper), [paper]);
  const paragraphAreas = useMemo(() => paragraphRegions(regions), [regions]);
  const pageIndex = Math.max(0, manifest?.pages.findIndex((item) => item.page === page) ?? 0);
  const visiblePage = manifest?.pages[pageIndex];
  const sourceKey = expectedHash || sourceUrl + ":" + paper?.revision;
  const displayedPage = preparedPage?.sourceKey === sourceKey ? preparedPage.page : null;
  const requestedWidth = Math.round(1200 * zoom);
  const renderIdentity = open ? requestKey + ":" + visiblePage?.page + ":" + requestedWidth : null;
  const latestRender = useRef(renderIdentity);
  latestRender.current = renderIdentity;
  const preparingPage = Boolean(visiblePage && (displayedPage?.page !== visiblePage.page || displayedPage?.requestedWidth !== requestedWidth));
  const pageView = usePdfPageView(scroller, open, displayedPage, renderedZoom);
  useEffect(() => { if (!displayedPage) { latestImage.current = null; pageResources.retain(null); } }, [sourceKey, Boolean(displayedPage), pageResources]);
  useEffect(() => {
    if (!open || !visiblePage || !preparingPage || !manifest.isCurrent()) return;
    return preparePdfPage(manifest.document, visiblePage, { requestedWidth,
      onReady: (ready) => {
        if (latestRender.current !== renderIdentity || !manifest.isCurrent()) return false;
        pageResources.add(ready.imageUrl); latestImage.current = ready.imageUrl; setPreparedPage({ sourceKey, page: ready });
      },
      onError: (failed) => setImageFailures((value) => ({ ...value, [failed.page]: true })),
    });
  }, [open, visiblePage, sourceKey, preparingPage, requestedWidth, manifest, pageResources, renderIdentity]);
  const supported = paper?.source?.media_type === "application/pdf" || /\.pdf$/i.test(paper?.source?.path || "");
  useEffect(() => {
    const next = { apiBase, sourceHash: expectedHash };
    const preserve = preservePdfCandidateView(previousSource.current, next);
    previousSource.current = next;
    pendingTargets.current = preserve ? (activeTargetsRef.current.length ? activeTargetsRef.current : pendingTargets.current || []) : null;
    setError(""); setImageFailures({}); setActiveTargets([]); pointer.current = null;
    if (!preserve) { setPage(1); currentPage.current = 1; setZoom(1); }
  }, [requestKey]);
  useEffect(() => {
    if (!open || !sourceUrl || !supported) return;
    let disposed = false, loading;
    setError(""); setManifest(null); setImageFailures({});
    import("./pdf-runtime.js").then(async ({ createBrowserPdfTask }) => {
      if (disposed) return;
      loading = loadPdfDocument({ url: sourceUrl, expectedHash, createTask: createBrowserPdfTask });
      const data = await loading.promise;
      if (!disposed) {
        currentPage.current = clampPdfPage(data.pages, currentPage.current); setPage(currentPage.current);
        setManifest({ key: requestKey, data: { ...data, isCurrent: () => !disposed } });
      }
    }).catch((failure) => { if (!disposed && failure.name !== "AbortError") setError(failure.name === "PasswordException" ? "PDF 已加密，请使用解锁后的原稿。" : failure.message || "原页暂时无法读取。"); });
    return () => { disposed = true; void loading?.destroy(); };
  }, [open, expectedHash, sourceUrl, supported, attempt, requestKey]);
  useEffect(() => {
    if (!manifest || !pendingTargets.current) return;
    setActiveTargets(reconcilePdfTargets(paper, pendingTargets.current, regions));
    pendingTargets.current = null;
  }, [manifest, paper, regions]);
  useEffect(() => { if (open) closeButton.current?.focus({ preventScroll: true }); }, [open]);

  function sameTarget(a, b) { return a?.blockId === b?.blockId && a?.itemId === b?.itemId; }
  function activeRegion(region, targets = activeTargets) {
    return targets.some((source) => source.blockId === region.blockId && (!source.itemId || source.itemId === region.itemId
      || (!region.itemId && !regions.some((item) => item.blockId === source.blockId && item.itemId === source.itemId && item.box))));
  }
  function locateSource(source, selected = [source]) {
    if (!manifest || !scroller.current || !source?.blockId) return;
    const region = regionForBlock(regions, source.blockId, currentPage.current, source.itemId);
    setActiveTargets(selected);
    if (!region || !manifest.pages.some((item) => item.page === region.page)) return;
    // Same-page source changes only replace the highlight. Keep the whole page
    // fixed, including any pan position chosen by the user while magnified.
    currentPage.current = region.page; setPage(region.page);
  }
  function followPointer() {
    if (!pointer.current) return false;
    const source = pointedArticleTarget(articleRef.current, document.elementFromPoint(pointer.current.x, pointer.current.y));
    if (source && (activeTargetsRef.current.length !== 1 || !sameTarget(activeTargetsRef.current[0], source))) locateSource(source);
    // A paragraph gap still belongs to pointer-driven reading. Retain the last
    // highlight there instead of jumping to a different viewport-top anchor.
    return true;
  }
  function followPdf(explicit = false) {
    const region = regions.find((item) => item.page === currentPage.current && activeRegion(item, activeTargetsRef.current))
      || blockAtPage(regions, currentPage.current, 0);
    if (!region) { setActiveTargets([]); return; }
    setActiveTargets([region]);
    callbacks.current.onLocate(region.blockId, explicit, region.itemId);
  }
  function turnPage(delta) {
    const index = manifest?.pages.findIndex((item) => item.page === currentPage.current) ?? -1;
    const next = manifest?.pages[index + delta];
    if (!next) return;
    if (scroller.current?.querySelector(".pdf-page")?.contains(document.activeElement)) scroller.current.focus({ preventScroll: true });
    ownership.user("pdf");
    currentPage.current = next.page; setPage(next.page);
    const region = blockAtPage(regions, next.page, 0);
    if (follow) {
      setActiveTargets(region ? [region] : []);
      if (region) callbacks.current.onLocate(region.blockId, false, region.itemId);
    }
  }
  useEffect(() => {
    if (!open || !manifest || !target || handledTarget.current === target.nonce) return;
    const frame = requestAnimationFrame(() => { locateSource(target); handledTarget.current = target.nonce; });
    return () => cancelAnimationFrame(frame);
  }, [open, manifest, target, regions]);
  useEffect(() => {
    if (!open || !manifest) return;
    const root = articleRef.current;
    let frame = 0;
    const select = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const selected = selectedArticleTargets(root);
        if (selected.length) locateSource(selected[0], selected);
      });
    };
    const click = (event) => {
      if (!window.getSelection()?.isCollapsed) { select(); return; }
      const source = clickedArticleTarget(root, event.target);
      if (source) locateSource(source);
    };
    root?.addEventListener("click", click);
    document.addEventListener("selectionchange", select);
    return () => {
      cancelAnimationFrame(frame);
      root?.removeEventListener("click", click);
      document.removeEventListener("selectionchange", select);
    };
  }, [open, manifest, regions, articleRef]);
  useEffect(() => {
    if (!open || !manifest || !follow) return;
    const root = articleRef.current;
    let frame = 0;
    const clear = () => { pointer.current = null; cancelAnimationFrame(frame); };
    const move = (event) => {
      if (event.pointerType === "touch" || event.buttons) { clear(); return; }
      const source = pointedArticleTarget(root, event.target);
      pointer.current = { x: event.clientX, y: event.clientY };
      cancelAnimationFrame(frame);
      if (!source) return;
      frame = requestAnimationFrame(() => {
        ownership.user("reader");
        followPointer();
      });
    };
    const key = (event) => { if (["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(event.key)) clear(); };
    root?.addEventListener("pointermove", move, { passive: true });
    root?.addEventListener("pointerdown", clear, { passive: true });
    root?.addEventListener("pointerleave", clear, { passive: true });
    document.addEventListener("keydown", key);
    return () => {
      clear();
      root?.removeEventListener("pointermove", move);
      root?.removeEventListener("pointerdown", clear);
      root?.removeEventListener("pointerleave", clear);
      document.removeEventListener("keydown", key);
    };
  }, [open, manifest, follow, regions, articleRef, ownership]);
  useEffect(() => {
    const resumedFollowing = follow && !previousFollow.current;
    previousFollow.current = follow;
    if (!open || !manifest) return;
    let readerFrame = 0;
    const readerScroll = () => {
      if (!follow || window.innerWidth <= 850 || !ownership.drives("reader")) return;
      cancelAnimationFrame(readerFrame);
      readerFrame = requestAnimationFrame(() => {
        if (followPointer()) return;
        const selected = selectedArticleTargets(articleRef.current);
        const visible = selected.find((source) => {
          const box = document.getElementById(source.itemId || source.blockId)?.getBoundingClientRect();
          return box && box.bottom > readingLine() && box.top < window.innerHeight;
        });
        if (visible) locateSource(visible, selected);
        else locateSource(captureReadingPosition(articleRef.current));
      });
    };
    window.addEventListener("scroll", readerScroll, { passive: true });
    if (resumedFollowing && window.innerWidth > 850) {
      if (ownership.owner() === "pdf") followPdf();
      else readerScroll();
    }
    return () => { window.removeEventListener("scroll", readerScroll); cancelAnimationFrame(readerFrame); };
  }, [open, manifest, follow, regions, articleRef, ownership]);
  function userInput(event) {
    if (event.type === "keydown" && !["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "PageUp", "PageDown", "Home", "End", " "].includes(event.key)) return;
    if (event.type === "pointerdown" && event.target.closest(".pdf-heading, .pdf-controls, .pdf-footer")) return;
    ownership.user("pdf");
  }
  function keys(event) {
    if (matchesShortcut(event.nativeEvent, "close", runtime.shortcuts.getSnapshot())) { event.preventDefault(); event.stopPropagation(); onClose(); return; }
    if (!event.altKey && !event.ctrlKey && !event.metaKey && (event.key === "PageUp" || event.key === "PageDown")) {
      event.preventDefault(); event.stopPropagation(); turnPage(event.key === "PageUp" ? -1 : 1); return;
    }
    userInput(event);
  }
  function retry() { setManifest(null); setPreparedPage(null); setImageFailures({}); setAttempt((value) => value + 1); }
  const pageCount = manifest?.pages.length || 0;
  return <div className="pdf-drawer" style={{ visibility: "visible" }} data-state={open ? "open" : "closed"} inert={!open} aria-hidden={!open || undefined}>
    <motion.aside initial={false} animate={{ x: open ? 0 : "100%", opacity: open ? 1 : 0 }} transition={motionTransition("panel", reduced)} data-motion-surface="pdf" id="reader-pdf-panel" className="pdf-panel" aria-label="PDF 原页对照" onKeyDown={keys} onWheel={userInput} onTouchStart={userInput} onPointerDown={userInput}>
      <header className="pdf-heading"><div><h2>原页对照</h2><div className="pdf-page-meta"><span>{pageCount ? "第 " + (displayedPage?.page || page) + " / " + pageCount + " 页" : "所附原始文件"}</span></div></div><button ref={closeButton} className="icon-button" aria-label="关闭原页并返回正文" title="返回正文" onClick={onClose}><X size={19} /></button></header>
      <div className="pdf-controls"><button className="pdf-locate" onClick={onLocateCurrent} title="按当前正文定位原页"><Crosshair size={15} />定位原页</button><label><input type="checkbox" checked={follow} onChange={(event) => onFollowChange(event.target.checked)} />联动</label><div className="pdf-zoom"><button className="icon-button" aria-label="缩小原页" disabled={zoom <= 1} onClick={() => setZoom((value) => Math.max(1, value - .25))}><Minus size={13} /></button><output>{Math.round(zoom * 100)}%</output><button className="icon-button" aria-label="放大原页" disabled={zoom >= 3} onClick={() => setZoom((value) => Math.min(3, value + .25))}><Plus size={13} /></button></div></div>
      <div ref={scroller} className="pdf-scroll" tabIndex={0} aria-label="PDF 单页" aria-busy={preparingPage || !manifest} onScroll={pageView.captureCenter}>
        {!supported ? <div className="pdf-message"><p>这份文档的来源不是 PDF。</p>{paper?.source?.path && <a href={documentAssetUrl(paper, paper.source.path)} target="_blank" rel="noreferrer">打开所附原文 <ArrowSquareOut size={14} /></a>}</div> : error ? <div className="pdf-message" role="alert"><p>{error}</p><button onClick={retry}><ArrowsClockwise size={14} />重新读取</button></div> : !displayedPage ? <div className="pdf-message" role="status">{imageFailures[page] ? <>第 {page} 页无法加载 <button onClick={retry}>重新读取</button></> : "正在读取原页…"}</div> : <div className="pdf-pages" style={{ width: pageView.stageWidth, height: pageView.stageHeight }}><AnimatePresence initial={false} mode="popLayout" onExitComplete={() => pageResources.retain(latestImage.current)}>{[displayedPage].map((item) => <MotionItem as="figure" layout={false} key={item.imageUrl} className="pdf-page" data-pdf-page={item.page} inert={preparingPage} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} style={{ width: pageView.width, height: pageView.height }}>
          <img src={item.imageUrl} width={item.width} height={item.height} alt={"原始 PDF 第 " + item.page + " 页"} loading="lazy" decoding="async" onError={() => setImageFailures((value) => ({ ...value, [item.page]: true }))} />
          {imageFailures[item.page] ? <div className="pdf-page-failure" role="status">第 {item.page} 页无法加载 <button onClick={retry}>重新读取</button></div> : paragraphAreas.filter((region) => region.page === item.page).map((region) => <button key={region.blockId + ":" + region.regionIndex} data-source-block={region.blockId} data-source-item={region.itemId} className={"pdf-region" + (activeRegion(region) ? " is-active" : "")} style={{ left: "calc(" + region.box[0] * 100 + "% - 5px)", top: "calc(" + region.box[1] * 100 + "% - 4px)", width: "calc(" + (region.box[2] - region.box[0]) * 100 + "% + 10px)", height: "calc(" + (region.box[3] - region.box[1]) * 100 + "% + 8px)" }} aria-label={"定位正文 " + (region.itemId || region.blockId)} title="定位这处内容的正文" onClick={() => { setActiveTargets([region]); callbacks.current.onLocate(region.blockId, true, region.itemId); }} />)}
        </MotionItem>)}</AnimatePresence></div>}
        <AnimatePresence>{displayedPage && preparingPage && <MotionItem as="div" key={"preparing-" + page} layout={false} className="pdf-page-preparing" role="status" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>{imageFailures[page] ? <>第 {page} 页无法加载 <button onClick={retry}>重新读取</button></> : "正在读取第 " + page + " 页…"}</MotionItem>}</AnimatePresence>
      </div>
      <footer className="pdf-footer"><button onClick={() => followPdf(true)} disabled={!manifest || preparingPage}><ArrowLeft size={14} />定位本页正文</button><div className="pdf-pagination"><button className="icon-button" aria-label="上一页" title="上一页 · Page Up" disabled={!manifest || pageIndex <= 0} onClick={() => turnPage(-1)}><CaretLeft size={15} /></button><button className="icon-button" aria-label="下一页" title="下一页 · Page Down" disabled={!manifest || pageIndex >= pageCount - 1} onClick={() => turnPage(1)}><CaretRight size={15} /></button></div>{manifest && originalSourceUrl && <a href={originalSourceUrl} target="_blank" rel="noreferrer" title="另行打开原始文件"><ArrowSquareOut size={15} />打开原文件</a>}</footer>
    </motion.aside>
    <PdfPanelResizeHandle {...separatorProps} />
  </div>;
}
