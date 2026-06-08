import { z } from "zod";
import { updateXeroRepeatingInvoice } from "../../handlers/update-xero-repeating-invoice.handler.js";
import { CreateXeroTool } from "../../helpers/create-xero-tool.js";

const trackingSchema = z.object({
  name: z.string().describe("The name of the tracking category. Can be obtained from the list-tracking-categories tool"),
  option: z.string().describe("The name of the tracking option. Can be obtained from the list-tracking-categories tool"),
  trackingCategoryID: z.string().describe("The ID of the tracking category. \
    Can be obtained from the list-tracking-categories tool"),
});

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
