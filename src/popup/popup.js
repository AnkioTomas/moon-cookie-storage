import { api } from "../browser.js";

const [tab] = await api.tabs.query({ active: true, currentWindow: true });
const cookies = tab?.url ? await api.cookies.getAll({ url: tab.url }) : [];
document.getElementById("status").textContent = `当前页面 Cookie 数量：${cookies.length}`;
