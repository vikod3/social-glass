const SCREEN_WIDTH = 393;
const SCREEN_HEIGHT = 852;
const URL_ATTRIBUTES = ["src", "href", "poster", "image"];

const shellStyles = `
  :host {
    --mobile-screen-scale: 1;
    display: block;
    overflow: hidden;
    background: #e2eae8;
    contain: layout paint style;
  }

  .screen-document {
    position: absolute !important;
    inset: 0 auto auto 0 !important;
    width: ${SCREEN_WIDTH}px !important;
    height: ${SCREEN_HEIGHT}px !important;
    min-width: ${SCREEN_WIDTH}px !important;
    min-height: ${SCREEN_HEIGHT}px !important;
    margin: 0 !important;
    overflow: hidden !important;
    transform: scale(var(--mobile-screen-scale));
    transform-origin: left top;
  }

  /* Keep Screen 3 control glyphs centered independently of glass layers. */
  .screen-document .header-button > svg,
  .screen-document .participant-status > svg,
  .screen-document .call-action > svg {
    position: absolute !important;
    z-index: 1 !important;
    top: 50% !important;
    left: 50% !important;
    display: block !important;
    margin: 0 !important;
    transform: translate(-50%, -50%) !important;
    transform-origin: center !important;
    pointer-events: none;
  }

  .load-error {
    display: grid;
    width: ${SCREEN_WIDTH}px;
    height: ${SCREEN_HEIGHT}px;
    place-items: center;
    padding: 44px;
    background: #e2eae8;
    color: #232021;
    font: 500 18px/1.4 system-ui, sans-serif;
    text-align: center;
  }
`;

class MobileScreen extends HTMLElement {
  #abortController;
  #resizeObserver;
  #loadVersion = 0;

  static get observedAttributes() {
    return ["source"];
  }

  constructor() {
    super();
    this.attachShadow({ mode: "open" });
  }

  connectedCallback() {
    this.#resizeObserver = new ResizeObserver(([entry]) => {
      const borderBox = entry?.borderBoxSize;
      const layoutWidth = borderBox?.[0]?.inlineSize ?? borderBox?.inlineSize;
      this.#updateScale(layoutWidth);
    });
    this.#resizeObserver.observe(this);
    this.#load();
  }

  disconnectedCallback() {
    this.#abortController?.abort();
    this.#resizeObserver?.disconnect();
  }

  attributeChangedCallback(name, oldValue, newValue) {
    if (name === "source" && oldValue !== newValue && this.isConnected) {
      this.#load();
    }
  }

  async #load() {
    const source = this.getAttribute("source")?.trim();

    if (!source) {
      this.#showError("This screen has no source folder configured.");
      return;
    }

    const version = ++this.#loadVersion;
    this.#abortController?.abort();
    this.#abortController = new AbortController();
    this.setAttribute("aria-busy", "true");

    try {
      const indexUrl = new URL(`${source}/index.html`, document.baseURI);
      const response = await fetch(indexUrl, {
        signal: this.#abortController.signal,
        credentials: "same-origin",
      });

      if (!response.ok) {
        throw new Error(`Screen request failed with status ${response.status}`);
      }

      const documentMarkup = await response.text();
      const parsedDocument = new DOMParser().parseFromString(documentMarkup, "text/html");
      const stylesheetLinks = [...parsedDocument.querySelectorAll('link[rel="stylesheet"]')];
      const localStylesheets = stylesheetLinks.filter((link) =>
        this.#isSameOriginResource(link.getAttribute("href"), indexUrl),
      );
      const externalStylesheets = stylesheetLinks.filter(
        (link) => !localStylesheets.includes(link),
      );

      const styles = await Promise.all(
        localStylesheets.map(async (link) => {
          const stylesheetUrl = new URL(link.getAttribute("href"), indexUrl);
          const stylesheetResponse = await fetch(stylesheetUrl, {
            signal: this.#abortController.signal,
            credentials: "same-origin",
          });

          if (!stylesheetResponse.ok) {
            throw new Error(`Stylesheet request failed with status ${stylesheetResponse.status}`);
          }

          return this.#scopeStyles(await stylesheetResponse.text(), stylesheetUrl);
        }),
      );

      if (version !== this.#loadVersion) return;

      const fragment = document.createDocumentFragment();
      const appStyle = document.createElement("style");
      appStyle.textContent = styles.join("\n");
      fragment.append(appStyle);

      for (const link of externalStylesheets) {
        const href = link.getAttribute("href");
        if (!href) continue;

        const externalLink = document.createElement("link");
        externalLink.rel = "stylesheet";
        externalLink.href = new URL(href, indexUrl).href;
        fragment.append(externalLink);
      }

      const viewport = document.createElement("div");
      viewport.className = "screen-document";

      for (const child of [...parsedDocument.body.children]) {
        if (child.tagName === "SCRIPT") continue;

        const importedChild = document.importNode(child, true);
        this.#rewriteResourceUrls(importedChild, indexUrl);
        viewport.append(importedChild);
      }

      fragment.append(viewport);

      const shellStyle = document.createElement("style");
      shellStyle.textContent = shellStyles;
      fragment.append(shellStyle);

      this.shadowRoot.replaceChildren(fragment);
      this.#initializeScreenEnhancements();
      this.#updateScale();
      this.removeAttribute("aria-busy");
      this.dispatchEvent(
        new CustomEvent("screen-ready", {
          bubbles: true,
          detail: { source },
        }),
      );
    } catch (error) {
      if (error.name === "AbortError") return;

      console.error(`Unable to load ${source}`, error);
      const message = location.protocol === "file:"
        ? "Open this project through its local web server to load the live screens."
        : "This screen could not be loaded.";
      this.#showError(message);
    }
  }

  #scopeStyles(css, stylesheetUrl) {
    return css
      .replace(/:root\b/g, ".screen-document")
      .replace(/\bhtml\s*,\s*body\b/g, ".screen-document")
      .replace(/\bbody(?=\s*\{)/g, ".screen-document")
      .replace(
        /url\(\s*(["']?)(?!data:|blob:|https?:|\/|#)([^"')]+)\1\s*\)/gi,
        (_match, _quote, resourcePath) =>
          `url("${new URL(resourcePath.trim(), stylesheetUrl).href}")`,
      );
  }

  #rewriteResourceUrls(root, indexUrl) {
    const elements = [root, ...root.querySelectorAll("*")];

    for (const element of elements) {
      for (const attribute of URL_ATTRIBUTES) {
        const value = element.getAttribute?.(attribute);
        if (!value || this.#isNonRelativeUrl(value)) continue;
        element.setAttribute(attribute, new URL(value, indexUrl).href);
      }

      const srcset = element.getAttribute?.("srcset");
      if (srcset) {
        element.setAttribute(
          "srcset",
          srcset
            .split(",")
            .map((candidate) => {
              const [url, descriptor] = candidate.trim().split(/\s+/, 2);
              if (this.#isNonRelativeUrl(url)) return candidate.trim();
              return `${new URL(url, indexUrl).href}${descriptor ? ` ${descriptor}` : ""}`;
            })
            .join(", "),
        );
      }
    }
  }

  #initializeScreenEnhancements() {
    this.shadowRoot
      .querySelectorAll(".header-button, .participant-status, .call-action--glass")
      .forEach((control) => {
        if (control.querySelector(":scope > .glass-distortion-layer")) return;

        const lens = document.createElement("span");
        lens.className = "glass-distortion-layer";
        lens.setAttribute("aria-hidden", "true");
        control.prepend(lens);
      });
  }

  #updateScale(observedWidth) {
    const computedWidth = Number.parseFloat(getComputedStyle(this).width);
    const layoutWidth = Number.isFinite(observedWidth)
      ? observedWidth
      : Number.isFinite(computedWidth)
        ? computedWidth
        : this.clientWidth;
    const scale = layoutWidth / SCREEN_WIDTH;
    if (Number.isFinite(scale) && scale > 0) {
      this.style.setProperty("--mobile-screen-scale", String(scale));
    }
  }

  #isSameOriginResource(value, baseUrl) {
    if (!value || /^(?:data:|blob:|#)/i.test(value)) return false;
    const url = new URL(value, baseUrl);
    return url.origin === location.origin;
  }

  #isNonRelativeUrl(value) {
    return /^(?:[a-z][a-z\d+.-]*:|\/|#)/i.test(value);
  }

  #showError(message) {
    const style = document.createElement("style");
    style.textContent = shellStyles;
    const error = document.createElement("div");
    error.className = "load-error";
    error.setAttribute("role", "status");
    error.textContent = message;
    this.shadowRoot.replaceChildren(style, error);
    this.#updateScale();
    this.removeAttribute("aria-busy");
  }
}

if (!customElements.get("mobile-screen")) {
  customElements.define("mobile-screen", MobileScreen);
}
