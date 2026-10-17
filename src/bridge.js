(() => {
  if (window.top !== window || location.port !== "9528") return;
  const api = globalThis.browser ?? globalThis.chrome;
  const waitUrl = api.runtime.getURL("wait.html");
  const announce = () => {
    window.postMessage({ type: "MOON_EXTENSION_READY", version: 1, waitUrl }, location.origin);
  };

  async function open(requestId, request) {
    try {
      const result = await api.runtime.sendMessage({ type: "MOON_OPEN_LOGIN", request });
      window.postMessage({ type: "MOON_LOGIN_RESULT", requestId, ...result }, location.origin);
    } catch {
      window.postMessage({
        type: "MOON_LOGIN_RESULT", requestId, ok: false, error: "无法连接插件，请刷新远程管理页面",
      }, location.origin);
    }
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window || event.origin !== location.origin) return;
    if (event.data?.type === "MOON_EXTENSION_DISCOVER") announce();
    if (event.data?.type === "MOON_LOGIN_REQUEST") {
      void open(event.data.requestId, event.data.request);
    }
  });

  // Intercept navigation, not fetch(): fetching HTML cannot start extension logic.
  document.addEventListener("click", (event) => {
    const link = event.target instanceof Element ? event.target.closest("a[href]") : null;
    if (!link) return;
    const url = new URL(link.href);
    const extension = new URL(waitUrl);
    if (
      url.protocol !== extension.protocol || url.host !== extension.host ||
      url.pathname !== "/wait.html"
    ) return;
    event.preventDefault();
    void open(url.searchParams.get("requestId"), Object.fromEntries(url.searchParams));
  }, true);

  announce();
})();
