# Credit-note de-allocation + approved-CN editing — design

**Date:** 2026-06-10
**Status:** approved (Richard, in-session)
**Origin:** bookkeeping session couldn't re-date an approved+allocated credit note via MCP:
`update-credit-note` is DRAFT-only and there is no de-allocate tool. Richard wants both fixed,
ahead of the attachments cherry-pick.

## Goal

Enable the workflow: **de-allocate → edit (re-date) → re-allocate** for an approved credit note,
purely via MCP tools.

## Feature 1 — `delete-credit-note-allocation` (PR 1, branch `feat/delete-credit-note-allocation`)

- **Handler** `src/handlers/delete-xero-credit-note-allocation.handler.ts`: thin wrapper around
  `accountingApi.deleteCreditNoteAllocations(tenantId, creditNoteID, allocationID, options)`.
  Same shape as `delete-xero-linked-transaction.handler.ts`.
- **Tool** `src/tools/delete/delete-credit-note-allocation.tool.ts`: params `creditNoteId`,
  `allocationId`. Register in `src/tools/delete/index.ts`.
- **Allocation-ID discovery:** `list-credit-notes` currently doesn't show allocations. Extend its
  output with an allocations block per credit note (`allocationID`, amount, date, invoice ID/number)
  plus `remainingCredit`. The SDK `Allocation` model carries `allocationID`; live test confirms the
  list endpoint populates it.
- **Out of scope (symmetric follow-ups, SDK supports both):** `deleteOverpaymentAllocations`,
  `deletePrepaymentAllocations`. Skipped because live-verifying them needs real overpayments/
  prepayments; add later if a session actually needs them.

## Feature 2 — edit approved credit notes (PR 2, branch `feat/update-authorised-credit-note`)

- Relax the DRAFT-only guard in `src/handlers/update-xero-credit-note.handler.ts`:
  - **DRAFT/SUBMITTED:** full update as today (line items, reference, date, contact).
  - **AUTHORISED:** allow **date and reference only**. If `lineItems` or `contactId` supplied,
    return an error explaining only date/reference can change on an authorised credit note.
  - **PAID / VOIDED / DELETED:** rejected as today.
- Update tool description in `update-credit-note.tool.ts` to match.
- **Deliberate deviation from upstream:** their invoice/quote/CN update handlers are all
  DRAFT-only by design. Xero's API permits limited edits on AUTHORISED documents; the PR argues
  that case. If upstream rejects it, the change still lives on `nestegg-fork-integration`.
- **Open question the live test answers:** does Xero accept a date change on an AUTHORISED CN
  that still has allocations? If yes, de-allocation isn't needed for re-dating (still useful on
  its own). If no, the de-allocate → edit → re-allocate path is confirmed as the mechanism.

## Testing

- Repo convention: pure helpers get Vitest tests; handlers/tools don't. Feature 1 adds no new
  pure helpers → no unit tests. Feature 2 touches only a handler → no unit tests. `npm test`,
  `npm run lint`, `npm run build` must pass on both branches.
- **Live smoke test (on `nestegg-fork-integration` after merging both):** add a block to
  `smoke-test.mjs`: create throwaway ACCREC invoice + CN (ZZZ-named) → authorise both →
  allocate CN→invoice → list-credit-notes shows allocation with `allocationID` →
  attempt re-date while allocated (record outcome) → delete allocation → re-date (expect
  success) → cleanup: void CN and invoice via SDK calls in the harness.

## Sequencing

1. Spec committed on `nestegg-fork-integration` (this doc).
2. PR 1 from `origin/main`, dispatch upstream.
3. PR 2 from `origin/main`, dispatch upstream.
4. Merge both into `nestegg-fork-integration`, rebuild, run smoke test live, record results here.
