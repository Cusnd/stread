import { useEffect, useId, useMemo, useRef, useState } from "react";
import { motion } from "motion/react";
import { MotionSelection } from "./Motion.jsx";
import { InlineLabel } from "./InlineContent.jsx";
import { navigationLabel, readerNavigation } from "./reader-navigation.js";
import { readingLine } from "./reading-position.js";
import "./reader-toc.css";

function headingTree(headings) {
  const root = { level: 0, children: [] };
  const ancestors = [root];
  for (const heading of headings) {
    while (ancestors.length > 1 && ancestors.at(-1).level >= heading.level) ancestors.pop();
    const node = { ...heading, children: [] };
    ancestors.at(-1).children.push(node);
    ancestors.push(node);
  }
  return root.children;
}

export function ReaderToc({ paper, mode, targetLanguage = "zh-CN", onNavigate }) {
  const motionId = useId();
  const navigation = useMemo(() => readerNavigation(paper), [paper]);
  const headings = navigation.items;
  const tree = useMemo(() => headingTree(headings), [headings]);
  const [active, setActive] = useState(headings[0]?.id);
  const scrollRef = useRef(null);
  const pointerInside = useRef(false);
  const browsingUntil = useRef(0);

  useEffect(() => {
    const article = scrollRef.current?.closest(".reader-app")?.querySelector(".article");
    if (!article) return;
    const ids = new Set(headings.map((heading) => heading.id));
    const elements = [...article.querySelectorAll("[data-article-block]")].filter((element) => ids.has(element.id));
    const header = article.closest(".reader-app")?.querySelector(".topbar");
    let frame;
    function update() {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const visible = elements.filter((element) => element.getClientRects().length && !element.closest("details:not([open])"));
        if (!visible.length) return;
        // Match both the live header and the browser's native hash-link offset.
        const scrollPadding = parseFloat(getComputedStyle(document.documentElement).scrollPaddingTop) || 0;
        const scrollMargin = parseFloat(getComputedStyle(visible[0]).scrollMarginTop) || 0;
        const boundary = Math.max(readingLine() + 2, scrollPadding + scrollMargin + 2);
        const page = document.scrollingElement;
        const atEnd = page && page.scrollTop > 0 && page.scrollHeight - page.clientHeight - page.scrollTop <= 2;
        const current = atEnd ? visible.at(-1) : visible.filter((heading) => heading.getBoundingClientRect().top <= boundary).at(-1) || visible[0];
        setActive(current.id);
      });
    }
    update();
    window.addEventListener("scroll", update, { passive: true });
    window.addEventListener("resize", update);
    window.addEventListener("reader-ui-scale-change", update);
    const resize = new ResizeObserver(update);
    resize.observe(article);
    if (header) resize.observe(header);
    return () => {
      window.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
      window.removeEventListener("reader-ui-scale-change", update);
      resize.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [headings, mode, targetLanguage]);

  useEffect(() => {
    const scroller = scrollRef.current;
    const nav = scroller?.closest(".toc");
    if (!scroller || !nav) return;
    function revealActive() {
      // A reader browsing the outline owns its scroll position until they leave it.
      if (nav.inert || pointerInside.current || scroller.contains(document.activeElement) || Date.now() < browsingUntil.current) return;
      const link = scroller.querySelector('[aria-current="location"]');
      if (!link) return;
      const viewport = scroller.getBoundingClientRect();
      const target = link.getBoundingClientRect();
      const inset = 12;
      if (target.top < viewport.top + inset) scroller.scrollTop += target.top - viewport.top - inset;
      else if (target.bottom > viewport.bottom - inset) scroller.scrollTop += target.bottom - viewport.bottom + inset;
    }
    revealActive();
    // Reopening the same mounted outline should reveal the reading position too.
    const visibility = new MutationObserver(revealActive);
    visibility.observe(nav, { attributes: true, attributeFilter: ["inert", "data-state"] });
    return () => visibility.disconnect();
  }, [active, mode, targetLanguage]);

  function renderTree(nodes) {
    return <ul className="reader-toc-list">{nodes.map((block) => <li key={block.id}>
      <a className={"paper-toc-link" + (active === block.id ? " active" : "")} data-level={block.level} data-numbered={Boolean(block.num)} href={"#" + block.id} aria-current={active === block.id ? "location" : undefined} onClick={onNavigate}>
        {block.num && <span className="toc-number">{block.num}</span>}
        <span className="toc-label">{navigation.kind === "headings" ? <InlineLabel text={navigationLabel(block, mode, targetLanguage)} /> : navigationLabel(block, mode, targetLanguage)}</span>
        {active === block.id && <MotionSelection layoutId={motionId + "-current"} className="reader-toc-indicator" />}
      </a>
      {block.children.length > 0 && renderTree(block.children)}
    </li>)}</ul>;
  }

  return <motion.div layoutScroll ref={scrollRef} className="paper-toc-links reader-toc" data-motion-control="toc" onPointerEnter={() => { pointerInside.current = true; }} onPointerLeave={() => { pointerInside.current = false; }} onWheel={() => { browsingUntil.current = Date.now() + 1200; }} onTouchStart={() => { browsingUntil.current = Date.now() + 1200; }}>
    {renderTree(tree)}
  </motion.div>;
}
