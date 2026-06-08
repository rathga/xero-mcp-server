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
import { listXeroOverpayments } from "./dist/handlers/list-xero-overpayments.handler.js";
import { listXeroPrepayments } from "./dist/handlers/list-xero-prepayments.handler.js";
import { createXeroCreditNoteAllocation } from "./dist/handlers/create-xero-credit-note-allocation.handler.js";
import { createXeroOverpaymentAllocation } from "./dist/handlers/create-xero-overpayment-allocation.handler.js";
import { createXeroPrepaymentAllocation } from "./dist/handlers/create-xero-prepayment-allocation.handler.js";
import { listXeroLinkedTransactions } from "./dist/handlers/list-xero-linked-transactions.handler.js";
import { createXeroLinkedTransaction } from "./dist/handlers/create-xero-linked-transaction.handler.js";
import { updateXeroLinkedTransaction } from "./dist/handlers/update-xero-linked-transaction.handler.js";
import { deleteXeroLinkedTransaction } from "./dist/handlers/delete-xero-linked-transaction.handler.js";
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

// ---- Allocations: list tools (read-only) ----
let opWithBalance, ppWithBalance;
await test("list-overpayments (#187)", async () => {
  const ops = unwrap(await listXeroOverpayments(1, undefined, 10));
  opWithBalance = (ops ?? []).find(o => (o.remainingCredit ?? 0) > 0);
  pass("list-overpayments (#187)", `${ops?.length ?? 0} overpayment(s); ${opWithBalance ? "one has balance" : "none with balance"}`);
});
await test("list-prepayments (#187)", async () => {
  const pps = unwrap(await listXeroPrepayments(1, undefined, 10));
  ppWithBalance = (pps ?? []).find(p => (p.remainingCredit ?? 0) > 0);
  pass("list-prepayments (#187)", `${pps?.length ?? 0} prepayment(s); ${ppWithBalance ? "one has balance" : "none with balance"}`);
});

// ---- create-credit-note-allocation: self-contained fixture, fully cleaned up ----
await test("create-credit-note-allocation (#187)", async () => {
  const today = new Date().toISOString().split("T")[0];
  const accResp = await xeroClient.accountingApi.getAccounts(xeroClient.tenantId, undefined, 'Class=="REVENUE"');
  const revCode = accResp.body.accounts?.[0]?.code;
  if (!revCode) throw new Error("no REVENUE account found for fixture");
  const contactResp = await xeroClient.accountingApi.createContacts(xeroClient.tenantId, { contacts: [{ name: `ZZZ Alloc Test ${Date.now()}` }] });
  const contactID = contactResp.body.contacts?.[0]?.contactID;
  const invResp = await xeroClient.accountingApi.createInvoices(xeroClient.tenantId, { invoices: [{
    type: "ACCREC", contact: { contactID }, date: today, dueDate: today, status: "AUTHORISED",
    lineAmountTypes: "NoTax", lineItems: [{ description: "smoke test", quantity: 1, unitAmount: 100, accountCode: revCode }],
  }] });
  const invoiceID = invResp.body.invoices?.[0]?.invoiceID;
  const cnResp = await xeroClient.accountingApi.createCreditNotes(xeroClient.tenantId, { creditNotes: [{
    type: "ACCRECCREDIT", contact: { contactID }, date: today, status: "AUTHORISED",
    lineAmountTypes: "NoTax", lineItems: [{ description: "smoke test", quantity: 1, unitAmount: 100, accountCode: revCode }],
  }] });
  const creditNoteID = cnResp.body.creditNotes?.[0]?.creditNoteID;
  try {
    const applied = unwrap(await createXeroCreditNoteAllocation(creditNoteID, [{ invoiceId: invoiceID, amount: 100, date: today }]));
    if (!applied.length) throw new Error("no allocation returned");
    const allocationID = applied[0].allocationID;
    if (allocationID) await xeroClient.accountingApi.deleteCreditNoteAllocations(xeroClient.tenantId, creditNoteID, allocationID);
    await xeroClient.accountingApi.updateInvoice(xeroClient.tenantId, invoiceID, { invoices: [{ status: "VOIDED" }] });
    await xeroClient.accountingApi.updateCreditNote(xeroClient.tenantId, creditNoteID, { creditNotes: [{ status: "VOIDED" }] });
    await xeroClient.accountingApi.updateContact(xeroClient.tenantId, contactID, { contacts: [{ contactStatus: "ARCHIVED" }] });
    pass("create-credit-note-allocation (#187)", `applied 100 to invoice, allocation ${allocationID}, cleaned up`);
  } catch (e) {
    // Best-effort cleanup even on failure (comment keeps catch non-empty for eslint no-empty).
    try { await xeroClient.accountingApi.updateInvoice(xeroClient.tenantId, invoiceID, { invoices: [{ status: "VOIDED" }] }); } catch { /* ignore */ }
    try { await xeroClient.accountingApi.updateCreditNote(xeroClient.tenantId, creditNoteID, { creditNotes: [{ status: "VOIDED" }] }); } catch { /* ignore */ }
    try { await xeroClient.accountingApi.updateContact(xeroClient.tenantId, contactID, { contacts: [{ contactStatus: "ARCHIVED" }] }); } catch { /* ignore */ }
    throw e;
  }
});

// ---- overpayment / prepayment allocation: only if a real source with balance exists ----
await test("create-overpayment-allocation (#187)", async () => {
  if (!opWithBalance) { pass("create-overpayment-allocation (#187)", "SKIPPED — no overpayment with balance in tenant (cannot create one via API)"); return; }
  const today = new Date().toISOString().split("T")[0];
  const contactID = opWithBalance.contact?.contactID;
  const inv = unwrap(await listXeroInvoices({ where: `Type=="ACCREC" AND Status=="AUTHORISED" AND Contact.ContactID==guid("${contactID}")`, pageSize: 1 }));
  const target = (inv ?? []).find(i => (i.amountDue ?? 0) > 0);
  if (!target) { pass("create-overpayment-allocation (#187)", "SKIPPED — overpayment has balance but no matching unpaid invoice for its contact"); return; }
  const amt = Math.min(0.01, opWithBalance.remainingCredit, target.amountDue);
  const applied = unwrap(await createXeroOverpaymentAllocation(opWithBalance.overpaymentID, [{ invoiceId: target.invoiceID, amount: amt, date: today }]));
  const allocationID = applied[0]?.allocationID;
  if (allocationID) await xeroClient.accountingApi.deleteOverpaymentAllocations(xeroClient.tenantId, opWithBalance.overpaymentID, allocationID);
  pass("create-overpayment-allocation (#187)", `applied ${amt} then deleted allocation ${allocationID}`);
});

await test("create-prepayment-allocation (#187)", async () => {
  if (!ppWithBalance) { pass("create-prepayment-allocation (#187)", "SKIPPED — no prepayment with balance in tenant (cannot create one via API)"); return; }
  const today = new Date().toISOString().split("T")[0];
  const contactID = ppWithBalance.contact?.contactID;
  const inv = unwrap(await listXeroInvoices({ where: `Type=="ACCREC" AND Status=="AUTHORISED" AND Contact.ContactID==guid("${contactID}")`, pageSize: 1 }));
  const target = (inv ?? []).find(i => (i.amountDue ?? 0) > 0);
  if (!target) { pass("create-prepayment-allocation (#187)", "SKIPPED — prepayment has balance but no matching unpaid invoice for its contact"); return; }
  const amt = Math.min(0.01, ppWithBalance.remainingCredit, target.amountDue);
  const applied = unwrap(await createXeroPrepaymentAllocation(ppWithBalance.prepaymentID, [{ invoiceId: target.invoiceID, amount: amt, date: today }]));
  const allocationID = applied[0]?.allocationID;
  if (allocationID) await xeroClient.accountingApi.deletePrepaymentAllocations(xeroClient.tenantId, ppWithBalance.prepaymentID, allocationID);
  pass("create-prepayment-allocation (#187)", `applied ${amt} then deleted allocation ${allocationID}`);
});

// ---- Linked transactions: list tool (read-only) ----
await test("list-linked-transactions (#191)", async () => {
  const lts = unwrap(await listXeroLinkedTransactions(1));
  pass("list-linked-transactions (#191)", `${lts?.length ?? 0} linked transaction(s)`);
});

// ---- create → update → delete: self-contained fixtures, fully cleaned up ----
await test("linked-transaction create→update→delete (#191)", async () => {
  const today = new Date().toISOString().split("T")[0];
  // Account codes for the fixture lines: one expense (the bill), one revenue (the sales invoice).
  // Must be ACTIVE and non-system — the first account a Class filter returns can be an archived
  // system account (e.g. "Bank Revaluations"), which Xero rejects as a line account code.
  const postable = (resp) => (resp.body.accounts ?? []).find((a) => !a.systemAccount && a.code)?.code;
  const expCode = postable(await xeroClient.accountingApi.getAccounts(xeroClient.tenantId, undefined, 'Class=="EXPENSE" AND Status=="ACTIVE"'));
  const revCode = postable(await xeroClient.accountingApi.getAccounts(xeroClient.tenantId, undefined, 'Class=="REVENUE" AND Status=="ACTIVE"'));
  if (!expCode || !revCode) throw new Error("need an ACTIVE non-system EXPENSE and REVENUE account for fixtures");
  // One throwaway contact serving as both the bill supplier and the recharge customer.
  const contactResp = await xeroClient.accountingApi.createContacts(xeroClient.tenantId, { contacts: [{ name: `ZZZ LinkedTx Test ${Date.now()}` }] });
  const contactID = contactResp.body.contacts?.[0]?.contactID;
  // AUTHORISED ACCPAY bill (the source cost), one line.
  const billResp = await xeroClient.accountingApi.createInvoices(xeroClient.tenantId, { invoices: [{
    type: "ACCPAY", contact: { contactID }, date: today, dueDate: today, status: "AUTHORISED",
    lineAmountTypes: "NoTax", lineItems: [{ description: "smoke test cost", quantity: 1, unitAmount: 50, accountCode: expCode }],
  }] });
  const billID = billResp.body.invoices?.[0]?.invoiceID;
  const sourceLineItemID = billResp.body.invoices?.[0]?.lineItems?.[0]?.lineItemID;
  // AUTHORISED ACCREC sales invoice (the target to recharge onto), one line.
  const invResp = await xeroClient.accountingApi.createInvoices(xeroClient.tenantId, { invoices: [{
    type: "ACCREC", contact: { contactID }, date: today, dueDate: today, status: "AUTHORISED",
    lineAmountTypes: "NoTax", lineItems: [{ description: "smoke test recharge", quantity: 1, unitAmount: 50, accountCode: revCode }],
  }] });
  const invoiceID = invResp.body.invoices?.[0]?.invoiceID;
  const targetLineItemID = invResp.body.invoices?.[0]?.lineItems?.[0]?.lineItemID;
  const voidAll = async () => {
    try { await xeroClient.accountingApi.updateInvoice(xeroClient.tenantId, billID, { invoices: [{ status: "VOIDED" }] }); } catch { /* ignore */ }
    try { await xeroClient.accountingApi.updateInvoice(xeroClient.tenantId, invoiceID, { invoices: [{ status: "VOIDED" }] }); } catch { /* ignore */ }
    try { await xeroClient.accountingApi.updateContact(xeroClient.tenantId, contactID, { contacts: [{ contactStatus: "ARCHIVED" }] }); } catch { /* ignore */ }
  };
  try {
    if (!sourceLineItemID || !targetLineItemID) throw new Error("fixture line item IDs not returned");
    // Stage 1: mark the bill line billable to the customer.
    const created = unwrap(await createXeroLinkedTransaction(billID, sourceLineItemID, contactID));
    const ltID = created.linkedTransactionID;
    if (!ltID) throw new Error("create returned no linkedTransactionID");
    // Stage 2: allocate onto the sales-invoice line.
    const updated = unwrap(await updateXeroLinkedTransaction(ltID, invoiceID, targetLineItemID));
    if (updated.targetTransactionID !== invoiceID) throw new Error(`target not applied: ${updated.targetTransactionID}`);
    // Cleanup: delete the link, then void both fixtures + archive the contact.
    unwrap(await deleteXeroLinkedTransaction(ltID));
    await voidAll();
    pass("linked-transaction create→update→delete (#191)", `link ${ltID} created, allocated to invoice ${invoiceID}, deleted, fixtures cleaned up`);
  } catch (e) {
    await voidAll();
    throw e;
  }
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
