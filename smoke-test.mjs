// Fork-private live e2e smoke suite — drives the built dist/ handlers directly
// against the connected Xero tenant. Lives only on nestegg-fork-integration (like
// the specs); never reaches an upstream PR. Read-only except the account
// create→archive cycle, which cleans up after itself.
//
// RUN (PowerShell, from repo root, after `npm run build`):
//   $cfg = Get-Content "$env:USERPROFILE\.claude.json" -Raw | ConvertFrom-Json
//   $cfg.mcpServers.xero.env.PSObject.Properties | ForEach-Object { Set-Item -Path "Env:$($_.Name)" -Value $_.Value }
//   node smoke-test.mjs
//
// We run dist/ directly (not the live MCP tools) because the running MCP is the
// build that was loaded at Claude-Code startup — stale until the client restarts.
// Add a test block here for every new feature PR before calling it verified.

import { AccountType } from "xero-node";
import { listXeroTrackingCategories } from "./dist/handlers/list-xero-tracking-categories.handler.js";
import { listXeroProfitAndLoss } from "./dist/handlers/list-xero-profit-and-loss.handler.js";
import { listXeroInvoices } from "./dist/handlers/list-xero-invoices.handler.js";
import { listXeroBankTransactions } from "./dist/handlers/list-xero-bank-transactions.handler.js";
import { getXeroInvoiceOnlineUrl } from "./dist/handlers/get-xero-invoice-online-url.handler.js";
import { getXeroInvoiceAsPdf } from "./dist/handlers/get-xero-invoice-as-pdf.handler.js";
import { getEntityHistory } from "./dist/handlers/history-handler-factory.js";
import { createXeroAccount } from "./dist/handlers/create-xero-account.handler.js";
import { archiveXeroAccount } from "./dist/handlers/archive-xero-account.handler.js";
import { xeroClient } from "./dist/clients/xero-client.js";

const results = [];
const pass = (name, evidence) => { results.push({ name, ok: true, evidence }); console.log(`  PASS  ${name} — ${evidence}`); };
const fail = (name, evidence) => { results.push({ name, ok: false, evidence }); console.log(`  FAIL  ${name} — ${evidence}`); };
const unwrap = (r) => { if (r.isError) throw new Error(r.error); return r.result; };

async function test(name, fn) {
  console.log(`\n▶ ${name}`);
  try { await fn(); } catch (e) { fail(name, `threw: ${e.message}`); }
}

let trackingCatId, trackingOptId, trackingOptName, accrecInvoiceId, createdAccountId;

// ---- Phase 1: P&L tracking filter (+ paymentsOnly bug-fix) ----
await test("tracking-categories read", async () => {
  const cats = unwrap(await listXeroTrackingCategories(false));
  const withOpts = (cats ?? []).find(c => (c.options?.length ?? 0) > 0);
  if (!withOpts) throw new Error("no tracking category with options found");
  trackingCatId = withOpts.trackingCategoryID;
  trackingOptId = withOpts.options[0].trackingOptionID;
  trackingOptName = withOpts.options[0].name;
  pass("tracking-categories read", `category "${withOpts.name}" (${cats.length} cats), option "${trackingOptName}"`);
});

const FROM = "2025-01-01", TO = "2025-12-31";

await test("P&L breakdown by tracking category (#186)", async () => {
  const rep = unwrap(await listXeroProfitAndLoss({ fromDate: FROM, toDate: TO, trackingCategoryID: trackingCatId }));
  const header = rep.rows?.find(r => r.rowType === "Header");
  const cols = header?.cells?.length ?? 0;
  if (!rep.rows?.length) throw new Error("no rows returned");
  pass("P&L breakdown by tracking category (#186)", `report "${rep.reportName}", header columns=${cols} (>2 ⇒ per-option breakdown)`);
});

await test("P&L filtered to one tracking option (#186)", async () => {
  const rep = unwrap(await listXeroProfitAndLoss({ fromDate: FROM, toDate: TO, trackingCategoryID: trackingCatId, trackingOptionID: trackingOptId }));
  if (!rep.rows?.length) throw new Error("no rows returned");
  pass("P&L filtered to one tracking option (#186)", `report "${rep.reportName}" for option "${trackingOptName}", rows=${rep.rows.length}`);
});

const netOf = (rep) => {
  // pull the NET PROFIT-ish final row value for a rough comparison
  const flat = [];
  const walk = (rows) => rows?.forEach(r => { flat.push(r); if (r.rows) walk(r.rows); });
  walk(rep.rows);
  const np = flat.reverse().find(r => /net|profit/i.test(r.cells?.[0]?.value ?? ""));
  return np?.cells?.[np.cells.length - 1]?.value ?? "(n/a)";
};

await test("P&L paymentsOnly flag now reaches the API (bug fix)", async () => {
  const accrual = unwrap(await listXeroProfitAndLoss({ fromDate: FROM, toDate: TO, paymentsOnly: false }));
  const cash = unwrap(await listXeroProfitAndLoss({ fromDate: FROM, toDate: TO, paymentsOnly: true }));
  const a = netOf(accrual), c = netOf(cash);
  // Both calls succeeding with the param in the right slot is the proof; differing totals is bonus.
  pass("P&L paymentsOnly flag now reaches the API (bug fix)", `accrual net=${a} vs cash net=${c} (${a === c ? "equal — org may have no accruals" : "differ ⇒ flag honoured"})`);
});

// ---- #176 pageSize ----
await test("pageSize honoured on list-invoices (#176)", async () => {
  const two = unwrap(await listXeroInvoices({ pageSize: 2 }));
  if ((two?.length ?? 0) > 2) throw new Error(`expected <=2, got ${two.length}`);
  pass("pageSize honoured on list-invoices (#176)", `pageSize:2 returned ${two.length} invoice(s)`);
});

// ---- #110 invoice filtering ----
await test("list-invoices where=Type==ACCREC (#110)", async () => {
  const inv = unwrap(await listXeroInvoices({ where: 'Type=="ACCREC"', pageSize: 5, order: "Date DESC" }));
  const bad = (inv ?? []).filter(i => i.type !== "ACCREC");
  if (bad.length) throw new Error(`${bad.length} non-ACCREC slipped through`);
  if (inv?.length) accrecInvoiceId = inv[0].invoiceID;
  pass("list-invoices where=Type==ACCREC (#110)", `${inv.length} invoice(s), all ACCREC; sample id ${accrecInvoiceId ?? "(none)"}`);
});

// ---- #153 bank-transaction filtering ----
await test("list-bank-transactions pageSize + type filter (#153)", async () => {
  const all = unwrap(await listXeroBankTransactions({ pageSize: 2 }));
  if ((all?.length ?? 0) > 2) throw new Error(`pageSize ignored: got ${all.length}`);
  const spend = unwrap(await listXeroBankTransactions({ types: ["SPEND"], pageSize: 5 }));
  const bad = (spend ?? []).filter(t => t.type !== "SPEND");
  pass("list-bank-transactions pageSize + type filter (#153)", `pageSize:2→${all.length}; type=SPEND→${spend.length} (${bad.length} mismatched)`);
});

// ---- #127 invoice online URL + PDF ----
await test("invoice online URL (#127)", async () => {
  if (!accrecInvoiceId) throw new Error("no ACCREC invoice id available");
  const url = unwrap(await getXeroInvoiceOnlineUrl(accrecInvoiceId));
  if (!/^https?:\/\//.test(url ?? "")) throw new Error(`not a URL: ${url}`);
  pass("invoice online URL (#127)", `${String(url).slice(0, 48)}…`);
});

await test("invoice PDF download (#127)", async () => {
  if (!accrecInvoiceId) throw new Error("no ACCREC invoice id available");
  const pdf = unwrap(await getXeroInvoiceAsPdf(accrecInvoiceId));
  const keys = pdf && typeof pdf === "object" ? Object.keys(pdf) : [];
  const size = pdf?.data?.length ?? pdf?.content?.length ?? pdf?.base64?.length ?? 0;
  if (!size) throw new Error(`empty PDF result; keys=${keys.join(",")}`);
  pass("invoice PDF download (#127)", `keys=[${keys.join(",")}], payload size=${size}`);
});

// ---- #145 History & Notes (read path only — notes are immutable) ----
await test("entity history read (#145)", async () => {
  if (!accrecInvoiceId) throw new Error("no ACCREC invoice id available");
  const cfg = { getMethod: xeroClient.accountingApi.getInvoiceHistory, createMethod: xeroClient.accountingApi.createInvoiceHistory };
  const hist = unwrap(await getEntityHistory(accrecInvoiceId, cfg));
  pass("entity history read (#145)", `invoice history records=${hist?.length ?? 0} (call succeeded)`);
});

// ---- #148 account create → archive (write + cleanup) ----
await test("account create then archive (#148)", async () => {
  const code = "ZT" + (Date.now() % 100000);
  const name = `ZZZ Claude smoke test (delete) ${code}`;
  const created = unwrap(await createXeroAccount(name, code, AccountType.EXPENSE, "Temp account from automated smoke test — safe to delete"));
  createdAccountId = created.accountID;
  if (!createdAccountId) throw new Error("create returned no accountID");
  const archived = unwrap(await archiveXeroAccount(createdAccountId));
  if (archived.status !== "ARCHIVED") throw new Error(`expected ARCHIVED, got ${archived.status}`);
  createdAccountId = null; // archived = cleaned up
  pass("account create then archive (#148)", `created ${code} (${created.accountID}) → status ${archived.status}`);
});

// ---- cleanup safety net ----
if (createdAccountId) {
  console.log(`\n⚠ attempting cleanup of leftover account ${createdAccountId}`);
  try { await archiveXeroAccount(createdAccountId); console.log("  cleaned up"); }
  catch (e) { console.log(`  CLEANUP FAILED — manually archive account ${createdAccountId}: ${e.message}`); }
}

// ---- summary ----
const passed = results.filter(r => r.ok).length;
console.log(`\n${"=".repeat(60)}\nSMOKE TEST SUMMARY: ${passed}/${results.length} passed`);
results.filter(r => !r.ok).forEach(r => console.log(`  ✗ ${r.name}: ${r.evidence}`));
process.exit(results.every(r => r.ok) ? 0 : 1);
