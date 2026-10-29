const bundledDocuments = {
  doc_attention_is_all_you_need_v7: {
    sourceHash: "bdfaa68d8984f0dc02beaca527b76f207d99b666d31d1da728ee0728182df697",
    presentation: {
      publication: "NIPS 2017 · arXiv:1706.03762v7",
      source_note: "15 页原稿 · 中文为示例译文",
      translation_note: "译注：摘要与表 2 的英法 BLEU 为 41.8，第 6.1 节为 41.0；第 5.4 节称三种正则化，但仅列出两个命名小节。此处均保留原稿。表 2 的跨列训练代价置于‘原表共用值’列，其他空单元格仍为空。参考文献仅翻译题名，作者与出版信息沿用原始著录。",
    },
    downloads: [
      { path: "article.bilingual.md", label: "原始双语 Markdown" },
      { path: "article-package.zip", label: "原始文章包" },
    ],
  },
};

export function bundledDocumentInfo(document) {
  const info = bundledDocuments[document?.id];
  return info && info.sourceHash === document?.source?.sha256 ? info : {};
}

export function documentPresentation(document) {
  return document?.extensions?.["continous-reader.presentation"] || bundledDocumentInfo(document).presentation || {};
}
