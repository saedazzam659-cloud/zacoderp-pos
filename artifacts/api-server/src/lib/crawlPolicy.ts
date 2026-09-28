// Advisory crawl policy only: never an authentication or copying boundary.
export const publicPages = [
  "/", "/index.html", "/pricing", "/compare", "/why-zacod", "/pos-system",
  "/download", "/install", "/login", "/register", "/trainee-register",
];
export const aiBots = [
  "GPTBot", "ClaudeBot", "anthropic-ai", "Google-Extended", "CCBot",
  "Bytespider", "Amazonbot", "cohere-ai", "Diffbot", "FacebookBot",
  "Omgilibot", "ImagesiftBot", "Applebot-Extended", "OAI-SearchBot",
  "ChatGPT-User", "PerplexityBot", "Perplexity-User", "Claude-Web",
  "Claude-User", "Claude-SearchBot",
];
export function crawlPath(url: string): string {
  try {
    const path = decodeURIComponent(url.split(/[?#]/, 1)[0]);
    if (!path.startsWith("/") || /[\\\u0000-\u001f]/.test(path)) return "";
    return path.replace(/\/+/g, "/").replace(/\/$/, "") || "/";
  } catch { return ""; }
}
export function robotsHeader(url: string): string {
  const path = crawlPath(url);
  return publicPages.includes(path) || /^\/blog\/[^/]+$/.test(path)
    ? "index, follow"
    : "noindex, nofollow, noarchive";
}
export function frontendSourceMap(url: string): boolean {
  // Only the main web build's asset namespace, not uploaded/integration files.
  return /^\/assets\/.*\.(?:js|css)\.map$/i.test(crawlPath(url));
}
export function robotsText(origin?: string): string {
  const allows = publicPages.flatMap(path => path === "/"
    ? ["Allow: /$", "Allow: /?"]
    : [`Allow: ${path}$`, `Allow: ${path}?`, `Allow: ${path}/$`, `Allow: ${path}/?`]);
  return [
    "# Advisory opt-out: AI training, search and user-triggered browsing.",
    ...aiBots.flatMap(bot => [`User-agent: ${bot}`, "Disallow: /", ""]),
    "User-agent: *", "Disallow: /", ...allows,
    "Allow: /blog/", "Allow: /assets/", "Allow: /favicon",
    "Allow: /icons/", "Allow: /images/", "Allow: /manifest",
    "Allow: /icon-", "Allow: /apple-touch-icon.png$", "Allow: /opengraph.jpg$",
    "Allow: /robots.txt$", "Allow: /sitemap.xml$",
    "Allow: /ai-overview.json$", "", ...(origin ? [`Sitemap: ${origin}/sitemap.xml`, ""] : []),
  ].join("\n");
}

// Included in both initial agent install and generated update Caddyfiles.
// Capture the original URL before SPA fallback rewriting.
export function caddyCrawlPolicy(): string {
  const pages = publicPages.flatMap(p => p === "/" ? [p] : [p, `${p}/`]).join(" ");
  return `
  @crawlPublic path ${pages}
  @crawlArticle path_regexp crawlArticle ^/blog/[^/]+/?$
  @frontendMap {
    method GET HEAD
    path_regexp frontendMap (?i)^/assets/.*[.](js|css)[.]map$
  }
  route {
    header X-Robots-Tag "noindex, nofollow, noarchive"
    header @crawlPublic X-Robots-Tag "index, follow"
    header @crawlArticle X-Robots-Tag "index, follow"
    respond @frontendMap 404
  }
`;
}