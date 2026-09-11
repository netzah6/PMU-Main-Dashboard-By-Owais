// The partner agreement ("Scope of Service") as a document the dashboard can
// edit and render to PDF. The standard text was lifted verbatim from the
// team's Canva design (Scope Of Service 2026, 5 pages) on 2026-09-11 —
// including its typos, which are the team's to fix, not ours to change silently.
//
// Blocks are deliberately simple so an AI edit ("add a clause about X",
// "change the price to Y") can rewrite the JSON safely and the PDF renderer
// can lay it out without knowing anything about the content.

export type Block =
  | { type: "heading"; text: string }
  | { type: "paragraph"; text: string }
  | { type: "bullets"; items: string[] }
  | { type: "numbered"; items: string[] }
  | { type: "signature" };

export type Agreement = {
  title: string;
  footer: string;
  blocks: Block[];
};

export const STANDARD_AGREEMENT: Agreement = {
  title: "PMU Bookings On Demand Partner Program Scope Service",
  footer: "PMU Bookings On Demand Partner Scope of Service",
  blocks: [
    { type: "paragraph", text: "This scope service is made by PMU Bookings On Demand and the partner." },

    { type: "heading", text: "What is the PMU Bookings On Demand program?" },
    { type: "paragraph", text: "The program is a 90 / 150 + 60 days program where PMU Bookings On Demand will create, optimize, manage, and scale your paid traffic (Facebook & Instagram) permanent makeup campaign." },
    { type: "paragraph", text: "This program is the first step in bringing your business a consistent flow of high-quality leads which you can convert into paying customers." },

    { type: "heading", text: "This Program Includes:" },
    { type: "bullets", items: [
      "Creation, design & optimization of ads.",
      "Automated smart AI robot.",
      "Access to PMU Bookings On Demand’s CRM.",
      "Access to the Instagram Booster to increase authority and social proof.",
      "Bi-Weekly Strategy Call.",
      "Proven Resources and calling scripts.",
      "Social Media Viral kit.",
    ] },

    { type: "heading", text: "This Program Does Not Include:" },
    { type: "bullets", items: [
      "Lead follow-up (you will need to follow-up with the leads)",
      "Ad comment monitoring: We do not monitor comments on the ads connected with the Facebook page",
    ] },
    { type: "paragraph", text: "After you've signed the scope service and finish the onboarding process properly, you will be able to book your launch call. After the launch call - ads will go live." },

    { type: "heading", text: "How Does Pricing Work For This Program?" },
    { type: "paragraph", text: "The partner will pay $897 * 3 months / $2,091 upfront / $3,485 to PMU Bookings On Demand and $300-600/mo which will be allocated to the ad spend." },
    { type: "paragraph", text: "Once completed the partner will decide if they wish to renew and credit card will automatically be charged for the next month, if they wish to cancel please inform us 72 hours in advance. Please note that a mandatory 30-minute exit interview is required to process the cancellation." },
    { type: "paragraph", text: "The partner may also decide to increase their ad-spend in the future." },
    { type: "paragraph", text: "Client agrees not to initiate a chargeback during the Term. All payments made by Clients are non-refundable. Client further agrees that it will be responsible for any feesand costs incurred by PMU Bookings On Demand responding to any chargeback." },

    { type: "heading", text: "How Does The Leads Guarantee Work?" },
    { type: "paragraph", text: "PMU Bookings On Demand guarantees to provide the partner with at least 30 bookings within 90 days / 75 bookings in 7 months." },
    { type: "paragraph", text: "“Booking” definition - a person who went through the entire Facebook ad process filled the full name, email, phone number and click submit and booked an appointment, until the session is completed - if the client books a session and didn't show up it won't be counted as a booking." },
    { type: "paragraph", text: "In the unlikely event that PMU Bookings On Demand is unable to fulfill the guaranteed bookings, PMU Bookings On Demand will continue working at no additional service fee until the goal is met." },

    { type: "heading", text: "Contingencies" },
    { type: "numbered", items: [
      "Since PMU Bookings On Demand can only guarantee results by using a proven system, the partner has to use PMU Bookings On Demand’s proven system ads. The partner is not allowed to modify or change the ads. Any modifications asked or made by the partner will void both the bookings guarantee.",
      "The partner must allocate at least $300-600/month for the ad spent. If the partner disagrees to invest for the ad spend, PMU Bookings On Demand cannot guarantee results.",
      "When the partner receives a new lead in PMU Bookings On Demand’s CRM, the partner must calling the lead within 24 business hours otherwise the partner will get a strike, 5 strikes and the guarantee is voided. Not all leads answer on the first call. If a lead didn’t answer the partner’s calls, the partner must keep calling the lead at least 2 times in a row, otherwise the partner will get a strike. 5 strikes and the guarantee is voided. If PMU Bookings On Demand won’t",
      "PMU Bookings On Demand will be able to document the partner’s growth process from A-Z through videos and photos.",
      "PMU Bookings On Demand will NOT cover the cost of ad spend for advertising or any other ancillary costs to external platforms such as Facebook (Meta), Google, Youtube, Tik Tok, or any advertising platform. Client understands that this will have a separate cost that is paid directly to those platforms.",
    ] },

    { type: "heading", text: "Exclusivity" },
    { type: "paragraph", text: "All the leads generated for the partner are generated exclusively for them, and will not be shared with other partners. 100k population will be exclusive within 10-50 miles away." },

    { type: "heading", text: "Liability Waiver" },
    { type: "paragraph", text: "The partner understands that establishing a digital presence and creating a two-way flow of communication between themselves & the public can have positive & negative outcomes on their reputation." },
    { type: "paragraph", text: "Should either outcome occur, the partner understands and accept that they waive their right to hold PMU Bookings On Demand responsible for any damage/liability that may arise from the work/services PMU Bookings On Demand provides." },
    { type: "paragraph", text: "The partner understands that if at any time they disagree with an action taken by PMU Bookings On Demand, they must notify PMU Bookings On Demand via a written notice." },

    { type: "heading", text: "Setting Expectations" },
    { type: "paragraph", text: "Being a PMU artist is HARD and very COMPETITIVE. It is your responsibility to convert the leads into closings. It’s best if you use the training and script provided by PMU Bookings On Demand." },
    { type: "paragraph", text: "This scope service will be governed by the laws of the State of Wyoming." },
    { type: "paragraph", text: "By signing this document below, you hereby ratify your understanding of these terms." },

    { type: "signature" },
  ],
};

/** Plain-text rendering, for the AI prompt and for quick diffs. */
export function agreementToText(a: Agreement): string {
  const lines: string[] = [a.title, ""];
  for (const b of a.blocks) {
    if (b.type === "heading") lines.push("", `## ${b.text}`);
    else if (b.type === "paragraph") lines.push(b.text, "");
    else if (b.type === "bullets") { for (const i of b.items) lines.push(`• ${i}`); lines.push(""); }
    else if (b.type === "numbered") { b.items.forEach((i, n) => lines.push(`${n + 1}) ${i}`)); lines.push(""); }
    else lines.push("[signature block]", "");
  }
  return lines.join("\n");
}

/** Reject anything that is not a well-formed agreement — the AI's output goes
 *  straight into the PDF, so its shape must be trusted before it is used. */
export function parseAgreement(v: unknown): Agreement | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  if (typeof o.title !== "string" || !Array.isArray(o.blocks)) return null;
  const blocks: Block[] = [];
  for (const b of o.blocks as unknown[]) {
    if (!b || typeof b !== "object") return null;
    const x = b as Record<string, unknown>;
    if (x.type === "heading" || x.type === "paragraph") {
      if (typeof x.text !== "string") return null;
      blocks.push({ type: x.type, text: x.text });
    } else if (x.type === "bullets" || x.type === "numbered") {
      if (!Array.isArray(x.items) || !x.items.every((i) => typeof i === "string")) return null;
      blocks.push({ type: x.type, items: x.items as string[] });
    } else if (x.type === "signature") {
      blocks.push({ type: "signature" });
    } else return null;
  }
  return { title: o.title, footer: typeof o.footer === "string" ? o.footer : STANDARD_AGREEMENT.footer, blocks };
}
