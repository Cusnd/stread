import { previewAccessUrl } from "./preview-access-url.js";

export function revisionResourceUrl(value, revision) {
  if (!Number.isInteger(revision) || revision < 1) return value;
  const hashAt = value.indexOf("#"), fragment = hashAt < 0 ? "" : value.slice(hashAt);
  const pathAndQuery = hashAt < 0 ? value : value.slice(0, hashAt);
  const queryAt = pathAndQuery.indexOf("?");
  const path = queryAt < 0 ? pathAndQuery : pathAndQuery.slice(0, queryAt);
  const query = new URLSearchParams(queryAt < 0 ? "" : pathAndQuery.slice(queryAt + 1));
  query.set("revision", String(revision));
  return path + "?" + query.toString() + fragment;
}

export function documentAssetUrl(paper, path) {
  const url = (paper.assetBase || "") + path;
  return /\/api\/documents\/[^/]+\/assets\//.test(paper.assetBase || "") ? revisionResourceUrl(url, paper.revision) : previewAccessUrl(url, paper.previewAccess);
}

// Reader-only byte transport avoids download extensions taking over a PDF URL.
// The separate, explicit original-file link continues to use documentAssetUrl.
export function documentPdfBytesUrl(paper, apiBase) {
  if (!paper?.source?.path) return null;
  const base = (apiBase || paper.assetBase?.replace(/\/assets\/$/, "") || "").replace(/\/$/, "");
  const hash = paper.source.sha256;
  if (/\/api\/(?:documents|authoring\/previews)\/[^/?#]+$/.test(base) && /^[a-f0-9]{64}$/i.test(hash || "")) {
    const url = base + "/assets-by-hash/" + hash.toLowerCase();
    return /\/api\/documents\//.test(base) ? revisionResourceUrl(url, paper.revision) : previewAccessUrl(url, paper.previewAccess);
  }
  return documentAssetUrl(paper.assetBase || !apiBase ? paper : { ...paper, assetBase: apiBase + "/assets/" }, paper.source.path);
}
