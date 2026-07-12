// Proves the same .node binary loads under Electron's N-API ABI.
// zadeh ships separate electron.napi.* prebuilds; napi-rs does not need to.
const { app } = require("electron");
const { NucleoMatcher } = require("../index.js");

app.whenReady().then(() => {
  const m = new NucleoMatcher(["foo/bar", "bar/foo", "foobar"], { matchPaths: true });
  const { indices, scores } = m.matchIndexed("foo bar");
  const ok =
    JSON.stringify([...indices]) === "[0,1,2]" && JSON.stringify([...scores]) === "[168,168,140]";
  console.log(ok ? "electron: ok" : "electron: MISMATCH");
  app.exit(ok ? 0 : 1);
});
