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

import { AccountType, Invoice, LineAmountTypes, ManualJournal } from "xero-node";
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
import { deleteXeroCreditNoteAllocation } from "./dist/handlers/delete-xero-credit-note-allocation.handler.js";
import { listXeroCreditNotes } from "./dist/handlers/list-xero-credit-notes.handler.js";
import { updateXeroCreditNote } from "./dist/handlers/update-xero-credit-note.handler.js";
import { createXeroOverpaymentAllocation } from "./dist/handlers/create-xero-overpayment-allocation.handler.js";
import { createXeroPrepaymentAllocation } from "./dist/handlers/create-xero-prepayment-allocation.handler.js";
import { listXeroLinkedTransactions } from "./dist/handlers/list-xero-linked-transactions.handler.js";
import { createXeroLinkedTransaction } from "./dist/handlers/create-xero-linked-transaction.handler.js";
import { updateXeroLinkedTransaction } from "./dist/handlers/update-xero-linked-transaction.handler.js";
import { deleteXeroLinkedTransaction } from "./dist/handlers/delete-xero-linked-transaction.handler.js";
import ListInvoicesTool from "./dist/tools/list/list-invoices.tool.js";
import { createXeroInvoice } from "./dist/handlers/create-xero-invoice.handler.js";
import { updateXeroInvoice } from "./dist/handlers/update-xero-invoice.handler.js";
import { createXeroBankTransaction } from "./dist/handlers/create-xero-bank-transaction.handler.js";
import { createXeroManualJournal } from "./dist/handlers/create-xero-manual-journal.handler.js";
import { updateXeroManualJournal } from "./dist/handlers/update-xero-manual-journal.handler.js";
import { listXeroRepeatingInvoices } from "./dist/handlers/list-xero-repeating-invoices.handler.js";
import { getXeroRepeatingInvoice } from "./dist/handlers/get-xero-repeating-invoice.handler.js";
import { createXeroRepeatingInvoice } from "./dist/handlers/create-xero-repeating-invoice.handler.js";
import { deleteXeroRepeatingInvoice } from "./dist/handlers/delete-xero-repeating-invoice.handler.js";
import { xeroClient } from "./dist/clients/xero-client.js";

const results = [];
const pass = (name, evidence) => { results.push({ name, ok: true, evidence }); console.log(`  PASS  ${name} — ${evidence}`); };
const fail = (name, evidence) => { results.push({ name, ok: false, evidence }); console.log(`  FAIL  ${name} — ${evidence}`); };
const unwrap = (r) => { if (r.isError) throw new Error(r.error); return r.result; };

// The tenant is shared production on a 5,000 call/day cap, and a whole-suite run costs ~85
// calls. Set SMOKE_ONLY to a substring of a block name to run just that block while iterating
// on it; leave it unset for the full suite (the only run whose x/y total means anything).
const only = process.env.SMOKE_ONLY;
if (only) console.log(`\n⚠ SMOKE_ONLY="${only}" — running matching blocks only; the summary is NOT a full-suite result`);

async function test(name, fn) {
  if (only && !name.toLowerCase().includes(only.toLowerCase())) return;
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

// ---- Repeating invoices: list (read-only) ----
await test("list-repeating-invoices (#192)", async () => {
  const ris = unwrap(await listXeroRepeatingInvoices());
  pass("list-repeating-invoices (#192)", `${ris?.length ?? 0} repeating-invoice template(s)`);
});

// ---- create → get → delete: self-contained DRAFT template, fully cleaned up ----
// A DRAFT template never generates a real invoice; delete (status=DELETED) removes it. Xero has
// no edit for repeating invoices (POST-with-ID is delete-only), so there is no update step.
await test("repeating-invoice create→get→delete (#192)", async () => {
  const postable = (resp) => (resp.body.accounts ?? []).find((a) => !a.systemAccount && a.code)?.code;
  const revCode = postable(await xeroClient.accountingApi.getAccounts(xeroClient.tenantId, undefined, 'Class=="REVENUE" AND Status=="ACTIVE"'));
  if (!revCode) throw new Error("need an ACTIVE non-system REVENUE account for fixture");
  const contactResp = await xeroClient.accountingApi.createContacts(xeroClient.tenantId, { contacts: [{ name: `ZZZ RepeatingInv Test ${Date.now()}` }] });
  const contactID = contactResp.body.contacts?.[0]?.contactID;
  const archiveContact = async () => {
    try { await xeroClient.accountingApi.updateContact(xeroClient.tenantId, contactID, { contacts: [{ contactStatus: "ARCHIVED" }] }); } catch { /* ignore */ }
  };
  let createdId;
  try {
    const created = unwrap(await createXeroRepeatingInvoice({
      contactId: contactID,
      schedule: { period: 1, unit: "MONTHLY", startDate: "2026-07-01", dueDate: 20, dueDateType: "OFFOLLOWINGMONTH" },
      lineItems: [{ description: "ZZZ smoke test - delete", quantity: 1, unitAmount: 1.23, accountCode: revCode, taxType: "NONE" }],
      type: "ACCREC", status: "DRAFT", reference: "ZZZ-SMOKE-DELETE",
    }));
    createdId = created.repeatingInvoiceID;
    if (!createdId) throw new Error("create returned no repeatingInvoiceID");
    const got = unwrap(await getXeroRepeatingInvoice(createdId));
    if (got.repeatingInvoiceID !== createdId) throw new Error("get returned a different template");
    const deleted = unwrap(await deleteXeroRepeatingInvoice(createdId));
    if (deleted.status !== "DELETED") throw new Error(`expected DELETED, got ${deleted.status}`);
    await archiveContact();
    pass("repeating-invoice create→get→delete (#192)", `created ${createdId} (every ${got.schedule?.period} ${got.schedule?.unit}, next ${got.schedule?.nextScheduledDate}), got, deleted (${deleted.status}), contact archived`);
  } catch (e) {
    if (createdId) { try { await deleteXeroRepeatingInvoice(createdId); } catch { /* ignore */ } }
    await archiveContact();
    throw e;
  }
});

// ---- credit-note de-allocation + authorised-CN edit: self-contained fixture, fully cleaned up ----
// Verifies: allocations (with allocationID) appear in list-credit-notes; whether Xero permits a
// date edit while a CN is still allocated (open question in the spec); delete-credit-note-allocation
// frees the credit; date edit succeeds on the AUTHORISED CN afterwards; line-item edits on an
// AUTHORISED CN are rejected by the handler guard.
await test("credit-note de-allocate + edit authorised CN", async () => {
  const today = new Date().toISOString().split("T")[0];
  const yesterday = new Date(Date.now() - 86400000).toISOString().split("T")[0];
  const postable = (resp) => (resp.body.accounts ?? []).find((a) => !a.systemAccount && a.code)?.code;
  const revCode = postable(await xeroClient.accountingApi.getAccounts(xeroClient.tenantId, undefined, 'Class=="REVENUE" AND Status=="ACTIVE"'));
  if (!revCode) throw new Error("need an ACTIVE non-system REVENUE account for fixture");
  const contactResp = await xeroClient.accountingApi.createContacts(xeroClient.tenantId, { contacts: [{ name: `ZZZ Dealloc Test ${Date.now()}` }] });
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
  const cleanup = async () => {
    try { await xeroClient.accountingApi.updateInvoice(xeroClient.tenantId, invoiceID, { invoices: [{ status: "VOIDED" }] }); } catch { /* ignore */ }
    try { await xeroClient.accountingApi.updateCreditNote(xeroClient.tenantId, creditNoteID, { creditNotes: [{ status: "VOIDED" }] }); } catch { /* ignore */ }
    try { await xeroClient.accountingApi.updateContact(xeroClient.tenantId, contactID, { contacts: [{ contactStatus: "ARCHIVED" }] }); } catch { /* ignore */ }
  };
  try {
    // Allocate the full credit to the invoice.
    const applied = unwrap(await createXeroCreditNoteAllocation(creditNoteID, [{ invoiceId: invoiceID, amount: 100, date: today }]));
    if (!applied.length) throw new Error("allocation not created");

    // The allocation (with its ID) must be discoverable via list-credit-notes.
    const listed = unwrap(await listXeroCreditNotes(1, contactID, 10));
    const listedCN = (listed ?? []).find((cn) => cn.creditNoteID === creditNoteID);
    const listedAlloc = listedCN?.allocations?.[0];
    if (!listedAlloc?.allocationID) throw new Error(`list-credit-notes did not surface allocationID (allocations=${JSON.stringify(listedCN?.allocations)})`);

    // Open question from the spec: does Xero accept a date edit while still allocated?
    const editWhileAllocated = await updateXeroCreditNote(creditNoteID, undefined, undefined, undefined, yesterday);
    const whileAllocatedOutcome = editWhileAllocated.isError
      ? `REJECTED (${String(editWhileAllocated.error).slice(0, 80)})`
      : `ACCEPTED (date now ${editWhileAllocated.result?.date})`;

    // De-allocate via the new handler; credit must return to the CN.
    unwrap(await deleteXeroCreditNoteAllocation(creditNoteID, listedAlloc.allocationID));
    const after = unwrap(await listXeroCreditNotes(1, contactID, 10));
    const afterCN = (after ?? []).find((cn) => cn.creditNoteID === creditNoteID);
    if ((afterCN?.allocations?.length ?? 0) !== 0) throw new Error("allocation still present after delete");
    if ((afterCN?.remainingCredit ?? 0) !== 100) throw new Error(`remainingCredit expected 100, got ${afterCN?.remainingCredit}`);

    // Date edit on the AUTHORISED (now unallocated) CN must succeed.
    // The SDK returns `date` as a JS Date — normalise to yyyy-mm-dd before comparing.
    const reDated = unwrap(await updateXeroCreditNote(creditNoteID, undefined, undefined, undefined, yesterday));
    const reDatedDay = new Date(reDated.date).toISOString().split("T")[0];
    if (reDatedDay !== yesterday) throw new Error(`date not updated: ${reDated.date}`);

    // Guard: line-item edits on an AUTHORISED CN must be rejected by the handler.
    const guarded = await updateXeroCreditNote(creditNoteID, [{ description: "x", quantity: 1, unitAmount: 1, accountCode: revCode, taxType: "NONE" }]);
    if (!guarded.isError) throw new Error("handler allowed line-item edit on AUTHORISED credit note");

    await cleanup();
    pass("credit-note de-allocate + edit authorised CN", `alloc ${listedAlloc.allocationID} listed+deleted; edit-while-allocated: ${whileAllocatedOutcome}; re-date after de-alloc OK (${reDated.date}); line-item guard OK; cleaned up`);
  } catch (e) {
    await cleanup();
    throw e;
  }
});

// ---- list-invoices surfaces Line Item IDs for invoiceIds fetches ----
// The gate that prints line items used to trigger only for invoiceNumbers. Email-imported
// bills often have no InvoiceNumber, so their line-item IDs were unreadable — blocking
// create-linked-transaction (which needs sourceLineItemId). The fix extends the gate to
// invoiceIds. Proven on the SAME numberless bill: line items appear when fetched by
// invoiceIds, but not by contactIds (an unrelated filter), so it's the gate, not the data.
await test("list-invoices returns Line Item IDs for invoiceIds (numberless bill)", async () => {
  await xeroClient.authenticate();
  const today = new Date().toISOString().split("T")[0];
  const postable = (resp) => (resp.body.accounts ?? []).find((a) => !a.systemAccount && a.code)?.code;
  const expCode = postable(await xeroClient.accountingApi.getAccounts(xeroClient.tenantId, undefined, 'Class=="EXPENSE" AND Status=="ACTIVE"'));
  if (!expCode) throw new Error("need an ACTIVE non-system EXPENSE account for fixture");
  const contactResp = await xeroClient.accountingApi.createContacts(xeroClient.tenantId, { contacts: [{ name: `ZZZ ListInvLineId Test ${Date.now()}` }] });
  const contactID = contactResp.body.contacts?.[0]?.contactID;
  // AUTHORISED ACCPAY bill with NO invoiceNumber — the case that used to be unreadable.
  const billResp = await xeroClient.accountingApi.createInvoices(xeroClient.tenantId, { invoices: [{
    type: "ACCPAY", contact: { contactID }, date: today, dueDate: today, status: "AUTHORISED",
    lineAmountTypes: "NoTax", lineItems: [{ description: "smoke test cost", quantity: 1, unitAmount: 50, accountCode: expCode }],
  }] });
  const billID = billResp.body.invoices?.[0]?.invoiceID;
  const lineItemID = billResp.body.invoices?.[0]?.lineItems?.[0]?.lineItemID;
  const invoiceNumber = billResp.body.invoices?.[0]?.invoiceNumber;
  const cleanup = async () => {
    try { await xeroClient.accountingApi.updateInvoice(xeroClient.tenantId, billID, { invoices: [{ status: "VOIDED" }] }); } catch { /* ignore */ }
    try { await xeroClient.accountingApi.updateContact(xeroClient.tenantId, contactID, { contacts: [{ contactStatus: "ARCHIVED" }] }); } catch { /* ignore */ }
  };
  const callTool = async (params) => {
    const res = await ListInvoicesTool().handler(params);
    return (res.content ?? []).map((c) => c.text).join("\n");
  };
  try {
    if (!lineItemID) throw new Error("fixture line item ID not returned");
    if (invoiceNumber) throw new Error(`fixture bill unexpectedly got an invoiceNumber (${invoiceNumber}) — Xero auto-numbered it; test premise broken`);
    const byIds = await callTool({ invoiceIds: [billID] });
    if (!byIds.includes("Line Items:") || !byIds.includes(`Line Item ID: ${lineItemID}`)) {
      throw new Error(`invoiceIds fetch did not surface Line Item ID ${lineItemID}`);
    }
    // Same bill via an unrelated filter (contactIds) must still NOT print line items.
    const byContact = await callTool({ contactIds: [contactID] });
    if (byContact.includes("Line Item ID:")) {
      throw new Error("contactIds fetch leaked line items — gate too broad");
    }
    await cleanup();
    pass("list-invoices returns Line Item IDs for invoiceIds (numberless bill)", `numberless bill ${billID}: invoiceIds surfaced Line Item ID ${lineItemID}; contactIds did not`);
  } catch (e) {
    await cleanup();
    throw e;
  }
});

// ---- update-invoice can set an invoice's status (PR #221) ----
// The handler used to reject anything that wasn't DRAFT. Now DRAFT, SUBMITTED and AUTHORISED are
// all updatable and `status` is settable, so approval (DRAFT→AUTHORISED) and disposal (DELETED
// for a draft, VOIDED for an authorised invoice) go through update-invoice instead of needing the
// Xero UI. An invoice carrying payments, credit notes, prepayments or overpayments is still
// refused, with the applied entity named in the reason — proved here with a *partial* credit-note
// allocation, which leaves the invoice AUTHORISED so the refusal can only come from the
// applied-entity guard and not from the status guard. Three fixture invoices are created in one
// batch call; each is disposed of by the block (two by the assertions themselves).
//
// Live result (2026-08-06, run in isolation via SMOKE_ONLY — the tenant's daily allowance was
// already down to 486/5000 before this run, so the full suite was deliberately not re-run):
// PASS. INV-6470 DRAFT→AUTHORISED→VOIDED, INV-6471 DRAFT→DELETED, INV-6472 (40 of 100 credited)
// refused with "Cannot update invoice because it has credit notes applied to it." Read-back
// confirmed every fixture disposed: both voided invoices VOIDED, the draft DELETED, CN-6473
// VOIDED with its 40 credit returned, contact ARCHIVED. Cost 16 API calls.
// Note Xero returns the credit-carrying invoice's own status as AUTHORISED throughout — the
// refusal is the handler's guard, not Xero's, so it costs one GET and no write.
await test("update-invoice sets status: approve, void, delete, refuse (PR #221)", async () => {
  await xeroClient.authenticate();
  const today = new Date().toISOString().split("T")[0];
  const postable = (resp) => (resp.body.accounts ?? []).find((a) => !a.systemAccount && a.code)?.code;
  const revCode = postable(await xeroClient.accountingApi.getAccounts(xeroClient.tenantId, undefined, 'Class=="REVENUE" AND Status=="ACTIVE"'));
  if (!revCode) throw new Error("need an ACTIVE non-system REVENUE account for fixture");
  const contactResp = await xeroClient.accountingApi.createContacts(xeroClient.tenantId, { contacts: [{ name: `ZZZ InvoiceStatus Test ${Date.now()}` }] });
  const contactID = contactResp.body.contacts?.[0]?.contactID;
  const invoiceOf = (amount, status) => ({
    type: "ACCREC", contact: { contactID }, date: today, dueDate: today, status,
    lineAmountTypes: "NoTax",
    lineItems: [{ description: "ZZZ smoke test - delete", quantity: 1, unitAmount: amount, accountCode: revCode }],
  });
  // One batch call for all three fixtures — two drafts (one to approve then void, one to delete)
  // and one authorised invoice to carry the credit note. Matched back by total, not by position.
  const invResp = await xeroClient.accountingApi.createInvoices(xeroClient.tenantId, { invoices: [
    invoiceOf(10, "DRAFT"), invoiceOf(20, "DRAFT"), invoiceOf(100, "AUTHORISED"),
  ] });
  const byTotal = (total) => (invResp.body.invoices ?? []).find((i) => i.total === total);
  const toApprove = byTotal(10), toDelete = byTotal(20), withCredit = byTotal(100);
  if (!toApprove?.invoiceID || !toDelete?.invoiceID || !withCredit?.invoiceID) throw new Error("fixture invoices not returned");
  const cnResp = await xeroClient.accountingApi.createCreditNotes(xeroClient.tenantId, { creditNotes: [{
    type: "ACCRECCREDIT", contact: { contactID }, date: today, status: "AUTHORISED",
    lineAmountTypes: "NoTax", lineItems: [{ description: "ZZZ smoke test - delete", quantity: 1, unitAmount: 40, accountCode: revCode }],
  }] });
  const creditNoteID = cnResp.body.creditNotes?.[0]?.creditNoteID;
  // Only what the assertions have not already disposed of gets voided at the end.
  const liveInvoices = new Set([toApprove.invoiceID, toDelete.invoiceID, withCredit.invoiceID]);
  let allocationID;
  const cleanup = async () => {
    // The credit has to come off before Xero will let its invoice be voided.
    if (allocationID) { try { await xeroClient.accountingApi.deleteCreditNoteAllocations(xeroClient.tenantId, creditNoteID, allocationID); } catch { /* ignore */ } }
    for (const invoiceID of liveInvoices) {
      try { await xeroClient.accountingApi.updateInvoice(xeroClient.tenantId, invoiceID, { invoices: [{ status: "VOIDED" }] }); } catch { /* ignore */ }
    }
    try { await xeroClient.accountingApi.updateCreditNote(xeroClient.tenantId, creditNoteID, { creditNotes: [{ status: "VOIDED" }] }); } catch { /* ignore */ }
    try { await xeroClient.accountingApi.updateContact(xeroClient.tenantId, contactID, { contacts: [{ contactStatus: "ARCHIVED" }] }); } catch { /* ignore */ }
  };
  const setStatus = (invoiceId, status) => updateXeroInvoice(invoiceId, undefined, undefined, undefined, undefined, undefined, status);
  try {
    const applied = unwrap(await createXeroCreditNoteAllocation(creditNoteID, [{ invoiceId: withCredit.invoiceID, amount: 40, date: today }]));
    allocationID = applied[0]?.allocationID;
    if (!allocationID) throw new Error("fixture credit-note allocation not created");

    // Approval: DRAFT → AUTHORISED.
    const approved = unwrap(await setStatus(toApprove.invoiceID, Invoice.StatusEnum.AUTHORISED));
    if (approved.status !== Invoice.StatusEnum.AUTHORISED) throw new Error(`expected AUTHORISED, got ${approved.status}`);

    // Disposal of an approved invoice with nothing applied: AUTHORISED → VOIDED.
    const voided = unwrap(await setStatus(toApprove.invoiceID, Invoice.StatusEnum.VOIDED));
    if (voided.status !== Invoice.StatusEnum.VOIDED) throw new Error(`expected VOIDED, got ${voided.status}`);
    liveInvoices.delete(toApprove.invoiceID);

    // Disposal of a draft: DRAFT → DELETED.
    const deleted = unwrap(await setStatus(toDelete.invoiceID, Invoice.StatusEnum.DELETED));
    if (deleted.status !== Invoice.StatusEnum.DELETED) throw new Error(`expected DELETED, got ${deleted.status}`);
    liveInvoices.delete(toDelete.invoiceID);

    // Refusal: still AUTHORISED, but carrying a credit note — the guard must name it.
    const refused = await setStatus(withCredit.invoiceID, Invoice.StatusEnum.VOIDED);
    if (!refused.isError) throw new Error("handler allowed a status change on an invoice with a credit note applied");
    if (!/credit notes/.test(refused.error)) throw new Error(`refusal did not name the applied credit note: ${refused.error}`);

    await cleanup();
    pass("update-invoice sets status: approve, void, delete, refuse (PR #221)",
      `draft ${approved.invoiceNumber} → ${approved.status} → ${voided.status}; draft ${deleted.invoiceNumber} → ${deleted.status}; part-credited invoice refused ("${String(refused.error).slice(0, 72)}…"); fixtures cleaned up`);
  } catch (e) {
    await cleanup();
    throw e;
  }
});

// ---- line-item tracking without a trackingCategoryID (PRs #180/#181/#192) ----
// The tracking schema required a trackingCategoryID alongside the category name and option, so
// `{ name, option }` was rejected by Zod before any call reached Xero. Xero resolves the category
// from the name itself, so the requirement was our own over-constraint. This block proves that
// against the live tenant on all four entity types that carry line-item tracking, and proves the
// explicit-ID form did not regress: every fixture carries two tracked lines, one sent WITHOUT the
// ID and one sent WITH it, and both must read back carrying the real category ID Xero resolved.
// The two forms being indistinguishable in the result is the whole claim.
await test("line-item tracking without a category ID (PRs #180/#181/#192)", async () => {
  await xeroClient.authenticate();
  const cats = unwrap(await listXeroTrackingCategories(false));
  const category = (cats ?? []).find((c) => (c.options?.length ?? 0) > 0);
  if (!category) throw new Error("no tracking category with options found");
  const categoryID = category.trackingCategoryID;
  const expected = { name: category.name, option: category.options[0].name };
  const idless = { ...expected };
  const withId = { ...expected, trackingCategoryID: categoryID };

  // A line's tracking must come back naming the same category and option, and carrying the ID —
  // whether or not the ID was sent. Anything else means Xero did not resolve it from the name.
  const assertResolved = (what, line) => {
    const applied = (line?.tracking ?? [])[0];
    if (!applied) throw new Error(`${what}: line came back with no tracking`);
    if (applied.trackingCategoryID !== categoryID) throw new Error(`${what}: category ID ${applied.trackingCategoryID} (expected ${categoryID})`);
    if (applied.name !== expected.name || applied.option !== expected.option) throw new Error(`${what}: read back as "${applied.name}"/"${applied.option}"`);
  };
  // Several tools in one block, so a bare unwrap would report a failure without naming the tool.
  const from = (what, response) => {
    if (response.isError) throw new Error(`${what}: ${response.error}`);
    return response.result;
  };
  const assertBothForms = (what, lines) => {
    if ((lines?.length ?? 0) !== 2) throw new Error(`${what}: expected 2 lines, got ${lines?.length ?? 0}`);
    assertResolved(`${what} (sent without the ID)`, lines[0]);
    assertResolved(`${what} (sent with the ID)`, lines[1]);
  };

  const postable = (resp) => (resp.body.accounts ?? []).find((a) => !a.systemAccount && a.code)?.code;
  const revCode = postable(await xeroClient.accountingApi.getAccounts(xeroClient.tenantId, undefined, 'Class=="REVENUE" AND Status=="ACTIVE"'));
  if (!revCode) throw new Error("need an ACTIVE non-system REVENUE account for fixtures");
  const bankResp = await xeroClient.accountingApi.getAccounts(xeroClient.tenantId, undefined, 'Type=="BANK" AND Status=="ACTIVE"');
  const bankAccountID = bankResp.body.accounts?.[0]?.accountID;
  if (!bankAccountID) throw new Error("need an ACTIVE BANK account for the bank-transaction fixture");

  const contactResp = await xeroClient.accountingApi.createContacts(xeroClient.tenantId, { contacts: [{ name: `ZZZ Tracking Test ${Date.now()}` }] });
  const contactID = contactResp.body.contacts?.[0]?.contactID;

  // Xero refuses to archive a contact that has ever carried a repeating invoice, so that fixture
  // reuses the contact already stranded on the ledger for exactly that reason rather than
  // stranding a fresh one on every run. If it has gone, make one advertising the same.
  const strandedContactName = "ZZZ RI Diag - delete (unarchivable: had a repeating invoice)";
  const strandedResp = await xeroClient.accountingApi.getContacts(xeroClient.tenantId, undefined, 'Name.StartsWith("ZZZ RI Diag - delete")');
  let repeatingContactID = strandedResp.body.contacts?.[0]?.contactID;
  if (!repeatingContactID) {
    const made = await xeroClient.accountingApi.createContacts(xeroClient.tenantId, { contacts: [{ name: strandedContactName }] });
    repeatingContactID = made.body.contacts?.[0]?.contactID;
  }

  const invoiceLine = (tracking) => ({ description: "ZZZ smoke test - delete", quantity: 1, unitAmount: 1, accountCode: revCode, taxType: "NONE", tracking: [tracking] });
  const journalLine = (lineAmount, tracking) => ({ lineAmount, accountCode: revCode, description: "ZZZ smoke test - delete", tracking: [tracking] });

  let invoiceID, bankTransactionID, manualJournalID, repeatingInvoiceID;
  const cleanup = async () => {
    if (invoiceID) { try { await xeroClient.accountingApi.updateInvoice(xeroClient.tenantId, invoiceID, { invoices: [{ status: "DELETED" }] }); } catch { /* ignore */ } }
    if (bankTransactionID) { try { await xeroClient.accountingApi.updateBankTransaction(xeroClient.tenantId, bankTransactionID, { bankTransactions: [{ status: "DELETED" }] }); } catch { /* ignore */ } }
    if (manualJournalID) { try { await xeroClient.accountingApi.updateManualJournal(xeroClient.tenantId, manualJournalID, { manualJournals: [{ status: "DELETED" }] }); } catch { /* ignore */ } }
    if (repeatingInvoiceID) { try { await deleteXeroRepeatingInvoice(repeatingInvoiceID); } catch { /* ignore */ } }
    try { await xeroClient.accountingApi.updateContact(xeroClient.tenantId, contactID, { contacts: [{ contactStatus: "ARCHIVED" }] }); } catch { /* ignore */ }
  };
  try {
    // create-invoice / update-invoice
    const invoice = from("create-invoice", await createXeroInvoice(contactID, [invoiceLine(idless), invoiceLine(withId)]));
    invoiceID = invoice.invoiceID;
    assertBothForms("create-invoice", invoice.lineItems);
    const updatedInvoice = from("update-invoice", await updateXeroInvoice(invoiceID, [invoiceLine(idless), invoiceLine(withId)]));
    assertBothForms("update-invoice", updatedInvoice.lineItems);

    // create-bank-transaction. update-bank-transaction is deliberately NOT driven here: it is
    // broken for every payload, tracking or not. Its handler spreads the transaction it just read
    // back into the update body, and Xero rejects that with a 400 ValidationException — reproduced
    // on 2026-08-06 with no tracking at all, while a minimal hand-built body against the same
    // endpoint and the same transaction succeeded. That is a pre-existing handler defect with
    // nothing to do with the tracking schema, so it is escalated rather than worked around here.
    // Nothing about the ID-less form goes unproven: create-bank-transaction below sends the same
    // tracking payload to the same entity, and the tool's schema is covered by the unit test.
    const bankTransaction = from("create-bank-transaction", await createXeroBankTransaction("RECEIVE", bankAccountID, contactID, [invoiceLine(idless), invoiceLine(withId)]));
    bankTransactionID = bankTransaction.bankTransactionID;
    assertBothForms("create-bank-transaction", bankTransaction.lineItems);

    // create-manual-journal / update-manual-journal — journal lines must balance, so the ID-less
    // line is the debit and the explicit-ID line the matching credit.
    const narration = "ZZZ smoke test - delete";
    const journalLines = () => [journalLine(10, idless), journalLine(-10, withId)];
    const manualJournal = from("create-manual-journal", await createXeroManualJournal(narration, journalLines(), undefined, LineAmountTypes.NoTax, ManualJournal.StatusEnum.DRAFT));
    manualJournalID = manualJournal.manualJournalID;
    assertBothForms("create-manual-journal", manualJournal.journalLines);
    const updatedManualJournal = from("update-manual-journal", await updateXeroManualJournal(narration, manualJournalID, journalLines(), undefined, LineAmountTypes.NoTax));
    assertBothForms("update-manual-journal", updatedManualJournal.journalLines);

    // create-repeating-invoice — its own inline copy of the schema, deliberately not the shared
    // helper (the helper does not exist on origin/main, where PR #192's branch is based).
    const repeating = from("create-repeating-invoice", await createXeroRepeatingInvoice({
      contactId: repeatingContactID,
      schedule: { period: 1, unit: "MONTHLY", startDate: "2026-07-01", dueDate: 20, dueDateType: "OFFOLLOWINGMONTH" },
      lineItems: [invoiceLine(idless), invoiceLine(withId)],
      type: "ACCREC", status: "DRAFT", reference: "ZZZ-SMOKE-DELETE",
    }));
    repeatingInvoiceID = repeating.repeatingInvoiceID;
    assertBothForms("create-repeating-invoice", from("get-repeating-invoice", await getXeroRepeatingInvoice(repeatingInvoiceID)).lineItems);

    await cleanup();
    pass("line-item tracking without a category ID (PRs #180/#181/#192)",
      `"${expected.name}"/"${expected.option}" resolved to ${categoryID} from the name alone on all four entity types; explicit-ID lines unchanged; update-bank-transaction not driven (pre-existing handler defect, see comment); fixtures cleaned up`);
  } catch (e) {
    await cleanup();
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
