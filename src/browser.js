// Chrome/Edge expose `chrome` (promise-based in MV3); Firefox exposes `browser`.
export const api = globalThis.browser ?? globalThis.chrome;
