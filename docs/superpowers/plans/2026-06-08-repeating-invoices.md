# Repeating Invoices Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add four thin-wrapper MCP tools — `list-repeating-invoices`, `get-repeating-invoice`, `create-repeating-invoice`, `update-repeating-invoice` — over the `xero-node` repeating-invoice SDK calls.

**Architecture:** Each tool maps 1:1 to a `xero-node` `accountingApi` call via a thin handler that returns the raw `RepeatingInvoice`(s). Tools mirror the existing invoice tools (`create-invoice`/`update-invoice`/`list-invoices`), adding a nested `schedule` object and template/auto-send flags. All enum mapping (type, status, schedule unit, due-date-type, currency) happens in the handler; tools expose plain string unions via Zod. Update is a full-replace POST-with-ID (`updateOrCreateRepeatingInvoices`); there is no delete endpoint, so deletion is `status="DELETED"` through update.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), `xero-node` SDK, Zod schemas, `@modelcontextprotocol/sdk`. Build `tsc` via `npm run build`, lint `npm run lint`, tests Vitest via `npm test`.

**Spec:** `docs/superpowers/specs/2026-06-08-repeating-invoices-design.md` (read on `nestegg-fork-integration` via `git show nestegg-fork-integration:docs/superpowers/specs/2026-06-08-repeating-invoices-design.md` if absent from this branch).

**Testing note:** Per the repo's verified convention (unit-test pure helpers with logic in `src/helpers/__tests__/`; **no** handler or tool tests), this feature adds **no unit tests** — it introduces no new pure helper with logic (schedule/enum handling is plain field-mapping inside handlers). Verification per task is `npm run build` + `npm run lint`; the existing `npm test` suite must stay green. Live-tenant smoke testing happens later on `nestegg-fork-integration` (out of scope for this branch).

**Branch:** all work on `feat/repeating-invoices`, cut fresh from `origin/main`. Do NOT commit any `docs/superpowers/**` files on this branch.

---

### Task 1: `list-repeating-invoices`

**Files:**
- Create: `src/handlers/list-xero-repeating-invoices.handler.ts`
- Create: `src/tools/list/list-repeating-invoices.tool.ts`
- Modify: `src/tools/list/index.ts`

- [ ] **Step 1: Create the handler**

Create `src/handlers/list-xero-repeating-invoices.handler.ts`:

```ts
import { xeroClient } from "../clients/xero-client.js";
import { XeroClientResponse } from "../types/tool-response.js";
import { formatError } from "../helpers/format-error.js";
import { RepeatingInvoice } from "xero-node";
import { getClientHeaders } from "../helpers/get-client-headers.js";

async function getRepeatingInvoices(
  where?: string,
  order?: string,
): Promise<RepeatingInvoice[]> {
  await xeroClient.authenticate();

  const response = await xeroClient.accountingApi.getRepeatingInvoices(
    xeroClient.tenantId,
    where, // where
    order, // order
    getClientHeaders(),
  );

  return response.body.repeatingInvoices ?? [];
}

/**
 * List repeating-invoice templates from Xero
 */
export async function listXeroRepeatingInvoices(
  where?: string,
  order?: string,
): Promise<XeroClientResponse<RepeatingInvoice[]>> {
  try {
    const repeatingInvoices = await getRepeatingInvoices(where, order);

    return {
      result: repeatingInvoices,
      isError: false,
      error: null,
    };
  } catch (error) {
    return {
      result: null,
      isError: true,
      error: formatError(error),
    };
  }
}
```

- [ ] **Step 2: Create the tool**

Create `src/tools/list/list-repeating-invoices.tool.ts`:

```ts
import { z } from "zod";
import { listXeroRepeatingInvoices } from "../../handlers/list-xero-repeating-invoices.handler.js";
import { CreateXeroTool } from "../../helpers/create-xero-tool.js";

const ListRepeatingInvoicesTool = CreateXeroTool(
  "list-repeating-invoices",
  `List repeating-invoice templates in Xero.
  Repeating invoices are templates Xero uses to auto-generate invoices on a schedule.
  Optionally filter with a 'where' clause or sort with 'order'.
  Common 'where' patterns: Type=="ACCREC" (sales templates), Type=="ACCPAY" (bill templates),
  Status=="AUTHORISED", Contact.Name=="ABC Ltd". Range operators: >, >=, <, <=. Logical: AND, OR.
  To read a single template in full (including line items), use the get-repeating-invoice tool.`,
  {
    where: z
      .string()
      .optional()
      .describe(
        'Filter clause, e.g. Type=="ACCREC", Status=="AUTHORISED", Contact.Name=="ABC Ltd".',
      ),
    order: z
      .string()
      .optional()
      .describe("Order by field, e.g. 'Type', 'Status'."),
  },
  async ({ where, order }) => {
    const response = await listXeroRepeatingInvoices(where, order);

    if (response.isError) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Error listing repeating invoices: ${response.error}`,
          },
        ],
      };
    }

    const repeatingInvoices = response.result;

    return {
      content: [
        {
          type: "text" as const,
          text: `Found ${repeatingInvoices?.length || 0} repeating invoices:`,
        },
        ...(repeatingInvoices?.map((ri) => ({
          type: "text" as const,
          text: [
            `Repeating Invoice ID: ${ri.repeatingInvoiceID}`,
            `Type: ${ri.type || "Unknown"}`,
            `Status: ${ri.status || "Unknown"}`,
            ri.contact
              ? `Contact: ${ri.contact.name} (${ri.contact.contactID})`
              : null,
            ri.reference ? `Reference: ${ri.reference}` : null,
            ri.schedule
              ? `Schedule: every ${ri.schedule.period} ${ri.schedule.unit}`
              : null,
            ri.schedule?.startDate ? `Start Date: ${ri.schedule.startDate}` : null,
            ri.schedule?.nextScheduledDate
              ? `Next Scheduled: ${ri.schedule.nextScheduledDate}`
              : null,
            ri.schedule?.endDate ? `End Date: ${ri.schedule.endDate}` : null,
            ri.currencyCode ? `Currency: ${ri.currencyCode}` : null,
            ri.total != null ? `Total: ${ri.total}` : null,
          ]
            .filter(Boolean)
            .join("\n"),
        })) || []),
      ],
    };
  },
);

export default ListRepeatingInvoicesTool;
```

- [ ] **Step 3: Register the tool in `src/tools/list/index.ts`**

Add the import alongside the other list imports:

```ts
import ListRepeatingInvoicesTool from "./list-repeating-invoices.tool.js";
```

Add `ListRepeatingInvoicesTool,` to the `ListTools` array (append after `ListTrackingCategoriesTool` — add a comma after the existing last entry).

- [ ] **Step 4: Build and lint**

Run: `npm run build && npm run lint`
Expected: build succeeds (no TS errors), lint passes.

- [ ] **Step 5: Commit**

```bash
git add src/handlers/list-xero-repeating-invoices.handler.ts src/tools/list/list-repeating-invoices.tool.ts src/tools/list/index.ts
git commit -m "feat: add list-repeating-invoices tool"
```

---

### Task 2: `get-repeating-invoice`

**Files:**
- Create: `src/handlers/get-xero-repeating-invoice.handler.ts`
- Create: `src/tools/get/get-repeating-invoice.tool.ts`
- Modify: `src/tools/get/index.ts`

- [ ] **Step 1: Create the handler**

Create `src/handlers/get-xero-repeating-invoice.handler.ts`:

```ts
import { xeroClient } from "../clients/xero-client.js";
import { XeroClientResponse } from "../types/tool-response.js";
import { formatError } from "../helpers/format-error.js";
import { RepeatingInvoice } from "xero-node";
import { getClientHeaders } from "../helpers/get-client-headers.js";

async function getRepeatingInvoice(
  repeatingInvoiceId: string,
): Promise<RepeatingInvoice | undefined> {
  await xeroClient.authenticate();

  const response = await xeroClient.accountingApi.getRepeatingInvoice(
    xeroClient.tenantId,
    repeatingInvoiceId, // repeatingInvoiceID
    getClientHeaders(),
  );

  return response.body.repeatingInvoices?.[0];
}

/**
 * Get a single repeating-invoice template (incl. line items) from Xero
 */
export async function getXeroRepeatingInvoice(
  repeatingInvoiceId: string,
): Promise<XeroClientResponse<RepeatingInvoice>> {
  try {
    const repeatingInvoice = await getRepeatingInvoice(repeatingInvoiceId);

    if (!repeatingInvoice) {
      throw new Error("Repeating invoice not found.");
    }

    return {
      result: repeatingInvoice,
      isError: false,
      error: null,
    };
  } catch (error) {
    return {
      result: null,
      isError: true,
      error: formatError(error),
    };
  }
}
```

- [ ] **Step 2: Create the tool**

Create `src/tools/get/get-repeating-invoice.tool.ts`:

```ts
import { z } from "zod";
import { CreateXeroTool } from "../../helpers/create-xero-tool.js";
import { getXeroRepeatingInvoice } from "../../handlers/get-xero-repeating-invoice.handler.js";
import { formatLineItem } from "../../helpers/format-line-item.js";

const GetRepeatingInvoiceTool = CreateXeroTool(
  "get-repeating-invoice",
  `Get a single repeating-invoice template in Xero by ID, including its line items and schedule.
  Use this to read a template in full before updating it (update replaces the whole template).`,
  {
    repeatingInvoiceId: z
      .string()
      .describe("The Xero Repeating Invoice ID (UUID). Can be obtained from list-repeating-invoices."),
  },
  async ({ repeatingInvoiceId }) => {
    const response = await getXeroRepeatingInvoice(repeatingInvoiceId);

    if (response.isError) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Error getting repeating invoice: ${response.error}`,
          },
        ],
      };
    }

    const ri = response.result;

    return {
      content: [
        {
          type: "text" as const,
          text: [
            `Repeating Invoice ID: ${ri?.repeatingInvoiceID}`,
            `Type: ${ri?.type || "Unknown"}`,
            `Status: ${ri?.status || "Unknown"}`,
            ri?.contact
              ? `Contact: ${ri.contact.name} (${ri.contact.contactID})`
              : null,
            ri?.reference ? `Reference: ${ri.reference}` : null,
            ri?.schedule
              ? `Schedule: every ${ri.schedule.period} ${ri.schedule.unit}`
              : null,
            ri?.schedule?.startDate ? `Start Date: ${ri.schedule.startDate}` : null,
            ri?.schedule?.dueDate != null
              ? `Due Date: ${ri.schedule.dueDate} (${ri.schedule.dueDateType})`
              : null,
            ri?.schedule?.nextScheduledDate
              ? `Next Scheduled: ${ri.schedule.nextScheduledDate}`
              : null,
            ri?.schedule?.endDate ? `End Date: ${ri.schedule.endDate}` : null,
            ri?.lineAmountTypes ? `Line Amount Types: ${ri.lineAmountTypes}` : null,
            ri?.currencyCode ? `Currency: ${ri.currencyCode}` : null,
            ri?.total != null ? `Total: ${ri.total}` : null,
            ri?.lineItems?.length
              ? `Line Items:\n${ri.lineItems.map(formatLineItem).join("\n---\n")}`
              : null,
          ]
            .filter(Boolean)
            .join("\n"),
        },
      ],
    };
  },
);

export default GetRepeatingInvoiceTool;
```

- [ ] **Step 3: Register the tool in `src/tools/get/index.ts`**

Add the import:

```ts
import GetRepeatingInvoiceTool from "./get-repeating-invoice.tool.js";
```

Add `GetRepeatingInvoiceTool,` to the `GetTools` array.

- [ ] **Step 4: Build and lint**

Run: `npm run build && npm run lint`
Expected: build succeeds, lint passes.

- [ ] **Step 5: Commit**

```bash
git add src/handlers/get-xero-repeating-invoice.handler.ts src/tools/get/get-repeating-invoice.tool.ts src/tools/get/index.ts
git commit -m "feat: add get-repeating-invoice tool"
```

---

### Task 3: `create-repeating-invoice`

**Files:**
- Create: `src/handlers/create-xero-repeating-invoice.handler.ts`
- Create: `src/tools/create/create-repeating-invoice.tool.ts`
- Modify: `src/tools/create/index.ts`

- [ ] **Step 1: Create the handler**

Create `src/handlers/create-xero-repeating-invoice.handler.ts`:

```ts
import { xeroClient } from "../clients/xero-client.js";
import { XeroClientResponse } from "../types/tool-response.js";
import { formatError } from "../helpers/format-error.js";
import {
  RepeatingInvoice,
  Schedule,
  LineItemTracking,
  CurrencyCode,
} from "xero-node";
import { getClientHeaders } from "../helpers/get-client-headers.js";
import {
  mapLineAmountType,
  LineAmountTypeInput,
} from "../helpers/map-line-amount-type.js";

export interface RepeatingInvoiceLineItem {
  description: string;
  quantity: number;
  unitAmount: number;
  accountCode: string;
  taxType: string;
  itemCode?: string;
  tracking?: LineItemTracking[];
}

export interface RepeatingInvoiceScheduleInput {
  period: number;
  unit: "WEEKLY" | "MONTHLY";
  startDate: string;
  dueDate?: number;
  dueDateType?: string;
  endDate?: string;
}

export interface CreateRepeatingInvoiceInput {
  contactId: string;
  schedule: RepeatingInvoiceScheduleInput;
  lineItems: RepeatingInvoiceLineItem[];
  type?: "ACCREC" | "ACCPAY";
  status?: "DRAFT" | "AUTHORISED";
  reference?: string;
  brandingThemeId?: string;
  currencyCode?: string;
  lineAmountType?: LineAmountTypeInput;
  approvedForSending?: boolean;
  sendCopy?: boolean;
  markAsSent?: boolean;
  includePDF?: boolean;
}

export function buildSchedule(input: RepeatingInvoiceScheduleInput): Schedule {
  return {
    period: input.period,
    unit: Schedule.UnitEnum[input.unit as keyof typeof Schedule.UnitEnum],
    startDate: input.startDate,
    dueDate: input.dueDate,
    dueDateType: input.dueDateType
      ? Schedule.DueDateTypeEnum[
          input.dueDateType as keyof typeof Schedule.DueDateTypeEnum
        ]
      : undefined,
    endDate: input.endDate,
  };
}

export function buildRepeatingInvoice(
  input: CreateRepeatingInvoiceInput & { repeatingInvoiceId?: string },
): RepeatingInvoice {
  return {
    repeatingInvoiceID: input.repeatingInvoiceId,
    type:
      RepeatingInvoice.TypeEnum[
        (input.type ?? "ACCREC") as keyof typeof RepeatingInvoice.TypeEnum
      ],
    contact: { contactID: input.contactId },
    schedule: buildSchedule(input.schedule),
    lineItems: input.lineItems,
    status:
      RepeatingInvoice.StatusEnum[
        (input.status ?? "DRAFT") as keyof typeof RepeatingInvoice.StatusEnum
      ],
    reference: input.reference,
    brandingThemeID: input.brandingThemeId,
    currencyCode: input.currencyCode
      ? CurrencyCode[input.currencyCode as keyof typeof CurrencyCode]
      : undefined,
    lineAmountTypes: mapLineAmountType(input.lineAmountType),
    approvedForSending: input.approvedForSending,
    sendCopy: input.sendCopy,
    markAsSent: input.markAsSent,
    includePDF: input.includePDF,
  };
}

/**
 * Create a repeating-invoice template in Xero
 */
export async function createXeroRepeatingInvoice(
  input: CreateRepeatingInvoiceInput,
): Promise<XeroClientResponse<RepeatingInvoice>> {
  try {
    await xeroClient.authenticate();

    const repeatingInvoice = buildRepeatingInvoice(input);

    const response = await xeroClient.accountingApi.createRepeatingInvoices(
      xeroClient.tenantId,
      { repeatingInvoices: [repeatingInvoice] },
      true, // summarizeErrors
      undefined, // idempotencyKey
      getClientHeaders(),
    );

    const created = response.body.repeatingInvoices?.[0];
    if (!created) {
      throw new Error("Repeating invoice creation failed.");
    }

    return {
      result: created,
      isError: false,
      error: null,
    };
  } catch (error) {
    return {
      result: null,
      isError: true,
      error: formatError(error),
    };
  }
}
```

- [ ] **Step 2: Create the tool**

Create `src/tools/create/create-repeating-invoice.tool.ts`:

```ts
import { z } from "zod";
import { createXeroRepeatingInvoice } from "../../handlers/create-xero-repeating-invoice.handler.js";
import { CreateXeroTool } from "../../helpers/create-xero-tool.js";
import { trackingSchema } from "../../helpers/tracking-schema.js";

const lineItemSchema = z.object({
  description: z.string().describe("The description of the line item"),
  quantity: z.number().describe("The quantity of the line item"),
  unitAmount: z.number().describe("The price per unit of the line item"),
  accountCode: z.string().describe("The account code of the line item - can be obtained from the list-accounts tool"),
  taxType: z.string().describe("The tax type of the line item - can be obtained from the list-tax-rates tool"),
  itemCode: z.string().describe("The item code of the line item - can be obtained from the list-items tool \
    If the item is not listed, add without an item code and ask the user if they would like to add an item code.").optional(),
  tracking: z.array(trackingSchema).describe("Up to 2 tracking categories and options can be added to the line item. \
    Can be obtained from the list-tracking-categories tool. \
    Only use if prompted by the user.").optional(),
});

const scheduleSchema = z.object({
  period: z.number().describe("How many units between invoices, e.g. 1 (every 1) or 2 (every 2)."),
  unit: z.enum(["WEEKLY", "MONTHLY"]).describe("The repeat unit."),
  startDate: z.string().describe("Date the first invoice is generated (YYYY-MM-DD)."),
  dueDate: z.number().describe("Payment-terms value used with dueDateType, e.g. 20 or 31.").optional(),
  dueDateType: z
    .enum([
      "DAYSAFTERBILLDATE",
      "DAYSAFTERBILLMONTH",
      "DAYSAFTERINVOICEDATE",
      "DAYSAFTERINVOICEMONTH",
      "OFCURRENTMONTH",
      "OFFOLLOWINGMONTH",
    ])
    .describe("Payment-terms type used with dueDate.")
    .optional(),
  endDate: z.string().describe("Optional date the schedule ends (YYYY-MM-DD).").optional(),
});

const CreateRepeatingInvoiceTool = CreateXeroTool(
  "create-repeating-invoice",
  "Create a repeating-invoice template in Xero. The template auto-generates invoices on the \
given schedule. Defaults to a DRAFT ACCREC (sales) template unless told otherwise.",
  {
    contactId: z.string().describe("The ID of the contact for the template. Can be obtained from the list-contacts tool."),
    schedule: scheduleSchema,
    lineItems: z.array(lineItemSchema),
    type: z.enum(["ACCREC", "ACCPAY"]).describe("ACCREC for sales templates, ACCPAY for bill templates. Default ACCREC.").optional(),
    status: z.enum(["DRAFT", "AUTHORISED"]).describe("DRAFT (default) or AUTHORISED.").optional(),
    reference: z.string().describe("A reference for the generated invoices.").optional(),
    brandingThemeId: z.string().describe("Optional branding theme ID.").optional(),
    currencyCode: z.string().describe("Optional ISO currency code, e.g. GBP.").optional(),
    lineAmountType: z.enum(["EXCLUSIVE", "INCLUSIVE", "NO_TAX"]).describe("Whether line amounts are tax exclusive, inclusive, or no tax.").optional(),
    approvedForSending: z.boolean().describe("Whether Xero emails the generated invoice to the contact.").optional(),
    sendCopy: z.boolean().describe("Whether to send a copy to the sender's email.").optional(),
    markAsSent: z.boolean().describe("Whether to mark the generated invoice as sent.").optional(),
    includePDF: z.boolean().describe("Whether to attach a PDF to the emailed invoice.").optional(),
  },
  async (params) => {
    const result = await createXeroRepeatingInvoice(params);

    if (result.isError) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Error creating repeating invoice: ${result.error}`,
          },
        ],
      };
    }

    const ri = result.result;

    return {
      content: [
        {
          type: "text" as const,
          text: [
            "Repeating invoice created successfully:",
            `ID: ${ri?.repeatingInvoiceID}`,
            `Type: ${ri?.type}`,
            `Status: ${ri?.status}`,
            `Contact: ${ri?.contact?.name}`,
            ri?.schedule ? `Schedule: every ${ri.schedule.period} ${ri.schedule.unit}` : null,
            ri?.schedule?.nextScheduledDate ? `Next Scheduled: ${ri.schedule.nextScheduledDate}` : null,
            ri?.total != null ? `Total: ${ri.total}` : null,
          ]
            .filter(Boolean)
            .join("\n"),
        },
      ],
    };
  },
);

export default CreateRepeatingInvoiceTool;
```

- [ ] **Step 3: Register the tool in `src/tools/create/index.ts`**

Add the import:

```ts
import CreateRepeatingInvoiceTool from "./create-repeating-invoice.tool.js";
```

Add `CreateRepeatingInvoiceTool,` to the `CreateTools` array.

- [ ] **Step 4: Build and lint**

Run: `npm run build && npm run lint`
Expected: build succeeds, lint passes.

- [ ] **Step 5: Commit**

```bash
git add src/handlers/create-xero-repeating-invoice.handler.ts src/tools/create/create-repeating-invoice.tool.ts src/tools/create/index.ts
git commit -m "feat: add create-repeating-invoice tool"
```

---

### Task 4: `update-repeating-invoice` (full-replace; also delete via status)

**Files:**
- Create: `src/handlers/update-xero-repeating-invoice.handler.ts`
- Create: `src/tools/update/update-repeating-invoice.tool.ts`
- Modify: `src/tools/update/index.ts`

- [ ] **Step 1: Create the handler**

Create `src/handlers/update-xero-repeating-invoice.handler.ts`. It reuses the `buildRepeatingInvoice` builder and input types from the create handler (set `repeatingInvoiceId`), and calls `updateOrCreateRepeatingInvoices`. Note: `status` here also accepts `DELETED` (the delete path), so widen the status union locally.

```ts
import { xeroClient } from "../clients/xero-client.js";
import { XeroClientResponse } from "../types/tool-response.js";
import { formatError } from "../helpers/format-error.js";
import { RepeatingInvoice } from "xero-node";
import { getClientHeaders } from "../helpers/get-client-headers.js";
import {
  buildRepeatingInvoice,
  CreateRepeatingInvoiceInput,
} from "./create-xero-repeating-invoice.handler.js";

export type UpdateRepeatingInvoiceInput = Omit<
  CreateRepeatingInvoiceInput,
  "status"
> & {
  repeatingInvoiceId: string;
  status?: "DRAFT" | "AUTHORISED" | "DELETED";
};

/**
 * Update a repeating-invoice template in Xero. Full replace (POST-with-ID): every field
 * is re-sent, so line items and schedule not provided are wiped. Pass status="DELETED" to
 * delete the template (there is no separate delete endpoint).
 */
export async function updateXeroRepeatingInvoice(
  input: UpdateRepeatingInvoiceInput,
): Promise<XeroClientResponse<RepeatingInvoice>> {
  try {
    await xeroClient.authenticate();

    const repeatingInvoice = buildRepeatingInvoice(
      input as CreateRepeatingInvoiceInput & { repeatingInvoiceId: string },
    );

    const response =
      await xeroClient.accountingApi.updateOrCreateRepeatingInvoices(
        xeroClient.tenantId,
        { repeatingInvoices: [repeatingInvoice] },
        true, // summarizeErrors
        undefined, // idempotencyKey
        getClientHeaders(),
      );

    const updated = response.body.repeatingInvoices?.[0];
    if (!updated) {
      throw new Error("Repeating invoice update failed.");
    }

    return {
      result: updated,
      isError: false,
      error: null,
    };
  } catch (error) {
    return {
      result: null,
      isError: true,
      error: formatError(error),
    };
  }
}
```

> Note on the `status` cast: `buildRepeatingInvoice` maps `status` through `RepeatingInvoice.StatusEnum`, which includes `DELETED`, so the wider update union maps correctly at runtime. The `as` cast satisfies the compiler since the builder's param type only lists `DRAFT`/`AUTHORISED`; `DELETED` is a valid `StatusEnum` key so the lookup is safe.

- [ ] **Step 2: Create the tool**

Create `src/tools/update/update-repeating-invoice.tool.ts`. Same schema as create plus required `repeatingInvoiceId`, `status` widened to include `DELETED`, and the full-replace warning in the description.

```ts
import { z } from "zod";
import { updateXeroRepeatingInvoice } from "../../handlers/update-xero-repeating-invoice.handler.js";
import { CreateXeroTool } from "../../helpers/create-xero-tool.js";
import { trackingSchema } from "../../helpers/tracking-schema.js";

const lineItemSchema = z.object({
  description: z.string().describe("The description of the line item"),
  quantity: z.number().describe("The quantity of the line item"),
  unitAmount: z.number().describe("The price per unit of the line item"),
  accountCode: z.string().describe("The account code of the line item - can be obtained from the list-accounts tool"),
  taxType: z.string().describe("The tax type of the line item - can be obtained from the list-tax-rates tool"),
  itemCode: z.string().describe("The item code of the line item - can be obtained from the list-items tool \
    If the item was not populated in the original template, \
    add without an item code unless the user has told you to add an item code.").optional(),
  tracking: z.array(trackingSchema).describe("Up to 2 tracking categories and options can be added to the line item. \
    Can be obtained from the list-tracking-categories tool. \
    Only use if prompted by the user.").optional(),
});

const scheduleSchema = z.object({
  period: z.number().describe("How many units between invoices, e.g. 1 (every 1) or 2 (every 2)."),
  unit: z.enum(["WEEKLY", "MONTHLY"]).describe("The repeat unit."),
  startDate: z.string().describe("Date the first invoice is generated (YYYY-MM-DD)."),
  dueDate: z.number().describe("Payment-terms value used with dueDateType, e.g. 20 or 31.").optional(),
  dueDateType: z
    .enum([
      "DAYSAFTERBILLDATE",
      "DAYSAFTERBILLMONTH",
      "DAYSAFTERINVOICEDATE",
      "DAYSAFTERINVOICEMONTH",
      "OFCURRENTMONTH",
      "OFFOLLOWINGMONTH",
    ])
    .describe("Payment-terms type used with dueDate.")
    .optional(),
  endDate: z.string().describe("Optional date the schedule ends (YYYY-MM-DD).").optional(),
});

const UpdateRepeatingInvoiceTool = CreateXeroTool(
  "update-repeating-invoice",
  "Update a repeating-invoice template in Xero. This is a FULL REPLACE: all fields are re-sent. \
All line items must be provided - any line items not provided will be removed, including existing ones. \
Read the current template with get-repeating-invoice first, edit it, then resubmit the whole thing. \
Pass status=\"DELETED\" to delete the template.",
  {
    repeatingInvoiceId: z.string().describe("The ID of the repeating invoice to update. Can be obtained from list-repeating-invoices."),
    contactId: z.string().describe("The ID of the contact for the template. Can be obtained from the list-contacts tool."),
    schedule: scheduleSchema,
    lineItems: z.array(lineItemSchema).describe("All line items must be provided. Any not provided will be removed."),
    type: z.enum(["ACCREC", "ACCPAY"]).describe("ACCREC for sales templates, ACCPAY for bill templates. Default ACCREC.").optional(),
    status: z.enum(["DRAFT", "AUTHORISED", "DELETED"]).describe("DRAFT, AUTHORISED, or DELETED (to delete the template).").optional(),
    reference: z.string().describe("A reference for the generated invoices.").optional(),
    brandingThemeId: z.string().describe("Optional branding theme ID.").optional(),
    currencyCode: z.string().describe("Optional ISO currency code, e.g. GBP.").optional(),
    lineAmountType: z.enum(["EXCLUSIVE", "INCLUSIVE", "NO_TAX"]).describe("Whether line amounts are tax exclusive, inclusive, or no tax.").optional(),
    approvedForSending: z.boolean().describe("Whether Xero emails the generated invoice to the contact.").optional(),
    sendCopy: z.boolean().describe("Whether to send a copy to the sender's email.").optional(),
    markAsSent: z.boolean().describe("Whether to mark the generated invoice as sent.").optional(),
    includePDF: z.boolean().describe("Whether to attach a PDF to the emailed invoice.").optional(),
  },
  async (params) => {
    const result = await updateXeroRepeatingInvoice(params);

    if (result.isError) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Error updating repeating invoice: ${result.error}`,
          },
        ],
      };
    }

    const ri = result.result;

    return {
      content: [
        {
          type: "text" as const,
          text: [
            "Repeating invoice updated successfully:",
            `ID: ${ri?.repeatingInvoiceID}`,
            `Type: ${ri?.type}`,
            `Status: ${ri?.status}`,
            `Contact: ${ri?.contact?.name}`,
            ri?.schedule ? `Schedule: every ${ri.schedule.period} ${ri.schedule.unit}` : null,
            ri?.schedule?.nextScheduledDate ? `Next Scheduled: ${ri.schedule.nextScheduledDate}` : null,
            ri?.total != null ? `Total: ${ri.total}` : null,
          ]
            .filter(Boolean)
            .join("\n"),
        },
      ],
    };
  },
);

export default UpdateRepeatingInvoiceTool;
```

- [ ] **Step 3: Register the tool in `src/tools/update/index.ts`**

Add the import:

```ts
import UpdateRepeatingInvoiceTool from "./update-repeating-invoice.tool.js";
```

Add `UpdateRepeatingInvoiceTool,` to the `UpdateTools` array.

- [ ] **Step 4: Build and lint**

Run: `npm run build && npm run lint`
Expected: build succeeds, lint passes.

- [ ] **Step 5: Commit**

```bash
git add src/handlers/update-xero-repeating-invoice.handler.ts src/tools/update/update-repeating-invoice.tool.ts src/tools/update/index.ts
git commit -m "feat: add update-repeating-invoice tool"
```

---

### Task 5: Final verification

- [ ] **Step 1: Full build, lint, and test**

Run: `npm run build && npm run lint && npm test`
Expected: build clean, lint clean, all existing Vitest tests pass (no new tests added — see Testing note).

- [ ] **Step 2: Confirm all four tools are registered**

Verify the four new tools appear in their respective `index.ts` arrays: `ListRepeatingInvoicesTool`, `GetRepeatingInvoiceTool`, `CreateRepeatingInvoiceTool`, `UpdateRepeatingInvoiceTool`. The `tool-factory.ts` aggregates these arrays automatically — no change needed there.

- [ ] **Step 3: Report back**

Report the final `npm run build`/`lint`/`test` output and the list of commits. Do NOT open a PR or run live-tenant tests — those steps are handled afterward on `nestegg-fork-integration`.
```
