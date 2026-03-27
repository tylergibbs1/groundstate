import { CdpClient, launchChrome, getPageWsUrl, sleep } from "./cdp.js";

async function main() {
  const chrome = await launchChrome(9444);
  const ws = await getPageWsUrl(9444);
  console.log("ws:", ws);
  const cdp = new CdpClient();
  await cdp.connect(ws);
  await cdp.navigate("file:///Users/tylergibbs/projects/groundstate/fixtures/invoices.html");
  const title = await cdp.evalJS("document.title");
  console.log("title:", title);
  // Test simple array first
  const simple = await cdp.evalJS("JSON.stringify([1,2,3])");
  console.log("simple:", simple);

  // Test extraction as JSON string instead
  const json = await cdp.evalJS("JSON.stringify((() => { const e = []; document.querySelectorAll('table').forEach(t => e.push({id: t.id, tag: t.tagName})); return e; })())");
  console.log("json:", json);

  const entities = await cdp.extractEntities();
  console.log("entities:", typeof entities, Array.isArray(entities) ? entities.length : entities);
  if (entities && entities.length > 0) {
    console.log("first:", JSON.stringify(entities[0]).slice(0, 200));
  }
  cdp.close();
  chrome.kill();
}
main().catch(e => { console.error(e); process.exit(1); });
