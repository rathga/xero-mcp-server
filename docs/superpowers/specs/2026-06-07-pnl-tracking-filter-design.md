# Phase 1 — Profit & Loss tracking filter

**Date:** 2026-06-07
**Feature:** Add tracking-category filtering to the `list-profit-and-loss` tool.
**Roadmap:** see `2026-06-07-xero-mcp-coverage-roadmap.md`.

## Goal

Let the agent retrieve the standard P&L scoped to a tracking option (e.g. a single property),
or broken down by a tracking category (one column per option) — matching what the Xero P&L
report endpoint natively supports. This gives the same numbers visible in the browser, filtered
to a tracking dimension, for the price of one API call.

It deliberately does **not** combine multiple tracking options into a single total. That
aggregation (e.g. "the 8 property codes that make up NRPL") is Nestegg business logic and will
live in separate business-workspace tooling that consumes the per-option breakdown this tool
returns.

## What the Xero API supports (and doesn't)

`accountingApi.getReportProfitAndLoss(tenantId, fromDate, toDate, periods, timeframe,
trackingCategoryID, trackingCategoryID2, trackingOptionID, trackingOptionID2, standardLayout,
paymentsOnly, options)`

- `trackingCategoryID` **only** → P&L with one column per option in that category (breakdown).
- `trackingCategoryID` + `trackingOptionID` → P&L filtered to that single option.
- The `*2` pair targets a **second category** (cross-tab), **not** a second value of the same
  category. There is **no** way to pass multiple options of one category — hence no in-API
  "combined NRPL" report.

Note the SDK parameter order: `categoryID, categoryID2, optionID, optionID2` (categories before
options). The current handler's placeholder comments mislabel this; the refactor must use the
correct order.

## Pre-existing bug fixed by this work

`listXeroProfitAndLoss` calls `fetchProfitAndLoss(fromDate, toDate, periods, timeframe,
paymentsOnly)` — only 5 args against a 6-arg signature `(…, standardLayout?, paymentsOnly?)`.
So `paymentsOnly` lands in the `standardLayout` slot and the real `paymentsOnly` is dropped:
**both flags are currently broken.** This is the same bug as upstream issue #138 / PR #161
(a 1-line positional fix). Our params-object refactor fixes it structurally and supersedes #161;
reference both in the PR.

## Approach (chosen: B — params object)

Mirror the sibling `list-report-balance-sheet`, which already takes a single typed params object
(`ListReportBalanceSheetParams`). Converting P&L to the same shape removes the fragile positional
arguments that caused the bug, and keeps the two report tools consistent.

(Rejected alternatives: **A** — add 4 more positional args, perpetuating the fragile style;
**C** — copy the balance sheet's option-only param shape, which can't work for P&L because the
endpoint requires `trackingCategoryID` alongside the option.)

## Changes

1. **New type** `src/types/list-profit-and-loss-params.ts` →
   `ListProfitAndLossParams { fromDate?, toDate?, periods?, timeframe?, trackingCategoryID?,
   trackingOptionID?, trackingCategoryID2?, trackingOptionID2?, standardLayout?, paymentsOnly? }`
   (mirrors `ListReportBalanceSheetParams`).
2. **`src/handlers/list-xero-profit-and-loss.handler.ts`** — change `listXeroProfitAndLoss` and
   the inner fetch to take `ListProfitAndLossParams`; pass all params to
   `getReportProfitAndLoss` in the **correct SDK order**; this fixes the standardLayout/paymentsOnly
   bug. Keep the `XeroClientResponse<ReportWithRow>` return shape and existing error handling.
3. **`src/tools/list/list-profit-and-loss.tool.ts`** — add the four tracking params as optional
   Zod fields. Descriptions instruct the agent to obtain IDs from `list-tracking-categories`, and
   explain: supply `trackingCategoryID` alone for a per-option breakdown, or with
   `trackingOptionID` to filter to one option. Pass the assembled params object to the handler.

## Layering / testing

Per repo conventions, this is infrastructure plumbing (param pass-through), not domain logic, so
it does not warrant a dedicated unit test. Verification is by build, lint, and a live call.

## Verification

- `npm run build` succeeds.
- `npm run lint` succeeds (no new warnings).
- Live check against the connected Xero org:
  - `list-tracking-categories` → obtain the property category ID + a known property option ID.
  - `list-profit-and-loss` with `trackingCategoryID` + `trackingOptionID` → confirm figures match
    that property's P&L in the browser.
  - `list-profit-and-loss` with `trackingCategoryID` only → confirm per-property column breakdown.
  - `list-profit-and-loss` with `paymentsOnly=true` → confirm cash-basis figures differ from
    default (proves the bug fix).

## Out of scope

Combining multiple options into one total (business-workspace tooling); the other three roadmap
features; custom report layouts (not API-accessible).
