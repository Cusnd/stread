import MarkdownIt from "markdown-it";

// Notes are local content. Viewing one must not execute embedded HTML or fetch
// an author's image URLs. Links are followed only through an explicit click.
export function safeNoteHref(value) {
  const href = String(value || "").trim();
  if (!href || /[\u0000-\u0020\u007f\\]/.test(href)) return null;
  if (/^(?:#|\?)/.test(href) || /^\/(?!\/)/.test(href)) return href;
  try {
    const url = new URL(href);
    if (["https:", "http:", "mailto:"].includes(url.protocol)) return href;
    if (url.protocol === "reader:" && url.hostname === "app" && !url.username && !url.password) return href;
  } catch { /* Bare and malformed URLs stay plain text. */ }
  return null;
}

const markdown = new MarkdownIt({ html: false, linkify: false, typographer: false, breaks: true });
markdown.validateLink = (href) => Boolean(safeNoteHref(href));
const linkOpen = markdown.renderer.rules.link_open;
markdown.renderer.rules.link_open = (tokens, index, options, environment, renderer) => {
  const token = tokens[index];
  if (/^https?:/i.test(token.attrGet("href") || "")) {
    token.attrSet("target", "_blank");
    token.attrSet("rel", "noopener noreferrer");
    token.attrSet("referrerpolicy", "no-referrer");
  }
  return linkOpen ? linkOpen(tokens, index, options, environment, renderer) : renderer.renderToken(tokens, index, options);
};
markdown.renderer.rules.image = (tokens, index, options, environment, renderer) => {
  const token = tokens[index];
  const label = renderer.renderInlineAsText(token.children || [], options, environment) || "图片";
  const href = safeNoteHref(token.attrGet("src"));
  const text = markdown.utils.escapeHtml(label);
  if (!href) return `<span class="note-markdown-image">${text}</span>`;
  return `<a class="note-markdown-image" href="${markdown.utils.escapeHtml(href)}" target="_blank" rel="noopener noreferrer" referrerpolicy="no-referrer" title="打开图片链接">${text}</a>`;
};

export function renderNoteMarkdown(value) {
  return markdown.render(String(value || ""));
}
