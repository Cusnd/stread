import { useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import Viewer from "viewerjs";
import { FlipHorizontal2, FlipVertical2 } from "lucide-react";
import { ArrowLeft, ArrowRight, ArrowClockwise, ArrowCounterClockwise, ArrowsClockwise, CornersIn, MagnifyingGlassMinus, MagnifyingGlassPlus, X } from "./icons";
import { acquirePageScrollLock } from "./page-scroll-lock.js";
import { matchesShortcut } from "./reading-shortcuts";
import { useReducedMotionPreference } from "./useReducedMotionPreference.js";
import "./motion-system.js";
import { getImageViewerFit } from "./image-viewer-geometry.js";
import "viewerjs/dist/viewer.css";
import "./image-lightbox.css";

function fitImage(viewer) {
  if (!viewer?.viewed || viewer.hiding) return;
  const { naturalWidth: width, naturalHeight: height, rotate: rotation } = viewer.imageData;
  const fit = getImageViewerFit({ width, height, rotation, viewportWidth: window.innerWidth, viewportHeight: window.innerHeight });
  if (fit) {
    viewer.zoomTo(fit.ratio);
    // Viewer clamps zoom to 1%. Even exceptionally large images must stay
    // centered using the actual rendered size after that clamp.
    viewer.moveTo(fit.x + (width * fit.ratio - viewer.imageData.width) / 2, fit.y + (height * fit.ratio - viewer.imageData.height) / 2);
  }
}

function Button({ label, children, ...props }) {
  return <button type="button" className="reader-image-button" title={label} aria-label={label} {...props}>{children}</button>;
}

export function ImageLightbox({ image, onClose, shortcuts }) {
  const reduced = useReducedMotionPreference();
  const viewerRef = useRef(null);
  const current = useRef({ onClose, shortcuts, reduced });
  const [host, setHost] = useState(null);
  const [status, setStatus] = useState({ index: image.index, ready: false, failed: false, ratio: 1, scaleX: 1, scaleY: 1 });

  useLayoutEffect(() => { current.current = { onClose, shortcuts, reduced }; });
  useLayoutEffect(() => {
    const desktop = window.continuousReaderDesktop;
    desktop?.setTitlebarDark?.(true);
    return () => desktop?.setTitlebarDark?.(false);
  }, []);
  useLayoutEffect(() => {
    let disposed = false, closing = false, resizeFrame = 0, cancelImageError = () => {};
    const release = acquirePageScrollLock();
    const body = document.body;

    // A detached gallery preserves the exact source URLs without touching the
    // Reader's live images, source identities, selection or document revision.
    const gallery = document.createElement("div");
    for (const slide of image.slides) {
      const source = document.createElement("img");
      source.src = slide.src;
      source.alt = slide.alt || "文章图片";
      gallery.append(source);
    }
    const syncStatus = () => {
      if (disposed || closing || !viewer.viewed) return;
      const { ratio, scaleX = 1, scaleY = 1 } = viewer.imageData;
      setStatus({ index: viewer.index, ready: true, failed: false, ratio, scaleX, scaleY });
    };
    const viewer = new Viewer(gallery, {
      className: "reader-image-lightbox", initialViewIndex: image.index,
      button: false, toolbar: false, title: false, navbar: false, navigation: false,
      keyboard: false, focus: false, loop: false, tooltip: false, slideOnWheel: false, toggleOnDblclick: false,
      minZoomRatio: 0.01, maxZoomRatio: 8, zoomRatio: 0.12,
      // Viewer owns the modal and all image gestures. React supplies accessible
      // controls; transform transitions never delay native gesture completion.
      transition: { show: !current.current.reduced, hide: !current.current.reduced, view: false, move: false, rotate: false, scale: false, zoom: false },
      shown() {
        viewer.viewer.removeAttribute("aria-labelledby");
        viewer.viewer.setAttribute("aria-label", "图片大图");
        viewer.viewer.focus({ preventScroll: true });
      },
      view(event) {
        cancelImageError();
        const candidate = event.detail.image;
        setStatus({ index: event.detail.index, ready: false, failed: false, ratio: 1, scaleX: 1, scaleY: 1 });
        const failed = () => {
          if (!disposed && !closing && viewer.image === candidate) setStatus((state) => ({ ...state, ready: false, failed: true }));
        };
        candidate.addEventListener("error", failed);
        cancelImageError = () => candidate.removeEventListener("error", failed);
        queueMicrotask(() => { if (candidate.complete && !candidate.naturalWidth) failed(); });
      },
      viewed() { if (!disposed && !closing) { fitImage(viewer); syncStatus(); } },
      zoomed: syncStatus, rotated: syncStatus, scaled: syncStatus,
      hide() {
        closing = true;
        viewer.viewer.inert = true;
        viewer.viewer.dataset.closing = "true";
        // Keep the image at its current geometry while the whole modal fades.
        viewer.image?.classList.remove("viewer-transition");
      },
      hidden() { if (!disposed) current.current.onClose(); },
    });
    viewerRef.current = viewer;
    viewer.show();
    const modal = viewer.viewer;
    modal.dataset.reducedMotion = String(current.current.reduced);
    modal.setAttribute("aria-label", "图片大图");
    modal.removeAttribute("aria-labelledby");
    setHost(modal);

    const background = [...body.children].filter((element) => element !== modal).map((element) => [element, element.inert]);
    background.forEach(([element]) => { element.inert = true; });
    const controls = () => [...modal.querySelectorAll("button:not(:disabled)")].filter((item) => item.getClientRects().length);
    const keydown = (event) => {
      event.stopPropagation();
      if (closing) { event.preventDefault(); return; }
      if (matchesShortcut(event, "close", current.current.shortcuts)) { event.preventDefault(); viewer.hide(); return; }
      if (event.key === "Tab") {
        const buttons = controls(), focused = document.activeElement;
        if (!buttons.includes(focused) || (event.shiftKey ? focused === buttons[0] : focused === buttons.at(-1))) {
          event.preventDefault(); (event.shiftKey ? buttons.at(-1) : buttons[0])?.focus();
        }
        return;
      }
      if (event.ctrlKey || event.metaKey || event.altKey || event.isComposing) return;
      if (event.key === "ArrowLeft") { event.preventDefault(); viewer.prev(false); }
      else if (event.key === "ArrowRight") { event.preventDefault(); viewer.next(false); }
      else if (["+", "=", "-"].includes(event.key)) { event.preventDefault(); viewer.image?.classList.remove("reader-image-transforming"); viewer.zoom(event.key === "-" ? -0.25 : 0.25); }
      else if (event.key.toLowerCase() === "r") { event.preventDefault(); viewer.image?.classList.add("reader-image-transforming"); viewer.rotate(event.shiftKey ? -90 : 90); fitImage(viewer); }
      else if (event.key === "0") { event.preventDefault(); fitImage(viewer); }
    };
    const keepFocus = (event) => { if (!closing && !modal.contains(event.target)) modal.focus({ preventScroll: true }); };
    const outsideKeydown = (event) => { if (!modal.contains(event.target)) keydown(event); };
    const directGesture = () => viewer.image?.classList.remove("reader-image-transforming");
    const doubleClick = (event) => {
      if (event.target !== viewer.image || !viewer.viewed || closing) return;
      viewer.image.classList.add("reader-image-transforming");
      // Native toggle() uses the original unrotated fit. Refit the current
      // orientation when toggling back from actual pixels.
      if (Math.abs(viewer.imageData.ratio - 1) < 0.001) fitImage(viewer);
      else viewer.zoomTo(1);
    };
    const resize = () => {
      cancelAnimationFrame(resizeFrame);
      resizeFrame = requestAnimationFrame(() => { if (!disposed) fitImage(viewer); });
    };
    modal.addEventListener("keydown", keydown);
    modal.addEventListener("pointerdown", directGesture, true);
    modal.addEventListener("wheel", directGesture, { capture: true, passive: true });
    modal.addEventListener("dblclick", doubleClick);
    document.addEventListener("focusin", keepFocus);
    document.addEventListener("keydown", outsideKeydown, true);
    window.addEventListener("resize", resize);
    modal.focus({ preventScroll: true });
    return () => {
      disposed = true;
      cancelImageError(); cancelAnimationFrame(resizeFrame);
      modal.removeEventListener("keydown", keydown);
      modal.removeEventListener("pointerdown", directGesture, true);
      modal.removeEventListener("wheel", directGesture, true);
      modal.removeEventListener("dblclick", doubleClick);
      document.removeEventListener("focusin", keepFocus);
      document.removeEventListener("keydown", outsideKeydown, true);
      window.removeEventListener("resize", resize);
      viewer.destroy();
      viewerRef.current = null;
      background.forEach(([element, inert]) => { element.inert = inert; });
      release();
      if (image.trigger?.isConnected) image.trigger.focus({ preventScroll: true });
    };
  }, [image]);

  useLayoutEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer) return;
    // Do not rebuild the gallery when OS preferences change mid-session.
    viewer.options.transition.show = !reduced;
    viewer.options.transition.hide = !reduced;
    viewer.viewer.dataset.reducedMotion = String(reduced);
  }, [reduced]);

  useLayoutEffect(() => {
    // Reaching the first/last image can disable the focused arrow button.
    // Browsers then move focus to body without emitting focusin.
    if (host?.isConnected && !host.inert && !host.contains(document.activeElement)) host.focus({ preventScroll: true });
  }, [host, status]);

  const act = (action) => {
    const viewer = viewerRef.current;
    if (!viewer?.viewed || viewer.hiding) return;
    viewer.image.classList.add("reader-image-transforming");
    action(viewer);
    const { ratio, scaleX = 1, scaleY = 1 } = viewer.imageData;
    setStatus((state) => ({ ...state, ratio, scaleX, scaleY }));
  };
  if (!host) return null;
  return createPortal(<>
    <div className="reader-image-header">
      <span className="reader-image-counter" aria-live="polite" aria-label={`第 ${status.index + 1} 张，共 ${image.slides.length} 张`}>{status.index + 1}<span>/</span>{image.slides.length}</span>
      <Button label="关闭大图" onClick={() => viewerRef.current?.hide()}><X size={21} /></Button>
    </div>
    {image.slides.length > 1 && <div className="reader-image-navigation">
      <Button label="上一张图片" disabled={status.index === 0} onClick={() => viewerRef.current?.prev(false)}><ArrowLeft size={22} /></Button>
      <Button label="下一张图片" disabled={status.index === image.slides.length - 1} onClick={() => viewerRef.current?.next(false)}><ArrowRight size={22} /></Button>
    </div>}
    {status.failed && <div className="reader-image-error" role="alert">图片加载失败</div>}
    <div className="reader-image-toolbar" role="group" aria-label="图片操作">
      <Button label="缩小图片" disabled={!status.ready || status.ratio <= 0.01} onClick={() => act((viewer) => viewer.zoom(-0.25))}><MagnifyingGlassMinus size={21} /></Button>
      <button className="reader-image-ratio" type="button" title="原始大小 (100%)" aria-label="原始大小" disabled={!status.ready} onClick={() => act((viewer) => viewer.zoomTo(1))}>{status.ready ? `${Math.round(status.ratio * 100)}%` : "—"}</button>
      <Button label="放大图片" disabled={!status.ready || status.ratio >= 8} onClick={() => act((viewer) => viewer.zoom(0.25))}><MagnifyingGlassPlus size={21} /></Button>
      <Button label="适应窗口 (0)" disabled={!status.ready} onClick={() => act(fitImage)}><CornersIn size={21} /></Button>
      <span className="reader-image-separator" />
      <Button label="向左旋转 90° (Shift+R)" disabled={!status.ready} onClick={() => act((viewer) => { viewer.rotate(-90); fitImage(viewer); })}><ArrowCounterClockwise size={21} /></Button>
      <Button label="向右旋转 90° (R)" disabled={!status.ready} onClick={() => act((viewer) => { viewer.rotate(90); fitImage(viewer); })}><ArrowClockwise size={21} /></Button>
      <Button label="水平翻转" disabled={!status.ready} aria-pressed={status.scaleX < 0} onClick={() => act((viewer) => viewer.scaleX(-viewer.imageData.scaleX))}><FlipHorizontal2 size={20} strokeWidth={1.7} /></Button>
      <Button label="垂直翻转" disabled={!status.ready} aria-pressed={status.scaleY < 0} onClick={() => act((viewer) => viewer.scaleY(-viewer.imageData.scaleY))}><FlipVertical2 size={20} strokeWidth={1.7} /></Button>
      <span className="reader-image-separator" />
      <Button label="重置图片" disabled={!status.ready} onClick={() => act((viewer) => { viewer.reset(); fitImage(viewer); })}><ArrowsClockwise size={21} /></Button>
    </div>
  </>, host);
}
