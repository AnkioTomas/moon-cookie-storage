import { api } from "./browser.js";

api.runtime.onInstalled.addListener(() => {
  console.log("Moon Cookie Storage installed");
});
