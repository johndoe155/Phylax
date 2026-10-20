/**
 * The text of the two legal documents (pages/Legal.tsx renders it).
 *
 * TODO(legal): this is a pre-launch DRAFT. Counsel must review every clause, and the operator must confirm the retention
 * periods below match what the backend actually does, before /api/legal reports the configuration as approved.
 * Bump the version in lib/legal.ts whenever the text changes: account creation records which version a person accepted.
 *
 * The operator, contact and jurisdiction are not written into the copy. The page shows them above the text (from
 * /api/legal), and the copy refers to them as "the operator", "the contact address" and "the jurisdiction" listed there.
 */
import { PRIVACY_URL, PRIVACY_VERSION, TERMS_URL, TERMS_VERSION } from "./legal";

export type DocKind = "terms" | "privacy";

/** How long one kind of information is kept. Shown as a list, period first, so it can be scanned. */
export type Retention = { what: string; period: string };

export type Section = {
  id: string;
  title: string;
  body?: string[];
  items?: string[];
  retention?: Retention[];
  after?: string[];
};

export type LegalDoc = {
  kind: DocKind;
  path: string;
  /** The heading, split into the two lines it is set on. */
  lines: [string, string];
  description: string;
  version: string;
  sections: Section[];
};

/** Every period the privacy notice promises. Kept as data so the notice and the tests read the same numbers. */
export const RETENTION: Retention[] = [
  { what: "Account details: name and sign-in details", period: "While your account is open, then 30 days" },
  { what: "Shifts and patterns you log, and your rules", period: "Until you delete them, or 30 days after you close your account" },
  { what: "Alert records: delivery status and times", period: "90 days" },
  { what: "Security and sign-in logs, including IP addresses", period: "12 months" },
  { what: "Record of the terms and privacy versions you accepted", period: "6 years after you close your account" },
  { what: "Messages you send to the contact address", period: "24 months" },
  { what: "Backups", period: "Overwritten within 35 days" },
];

const terms: LegalDoc = {
  kind: "terms",
  path: TERMS_URL,
  lines: ["Terms of", "service"],
  description: "The rules for using Phylax: what it does, what it can’t promise, and what we expect from you.",
  version: TERMS_VERSION,
  sections: [
    {
      id: "service-and-responsibility",
      title: "Service and responsibility",
      body: [
        "Phylax checks the shifts you log across your staffing apps for time overlaps, tight travel windows and cancellation risk. It doesn’t book, change or cancel shifts, and it isn’t affiliated with or endorsed by any staffing platform.",
        "The checks run on what you enter. If a shift is missing or wrong, the result will be too. You stay responsible for the shifts you accept, the details you log and every decision you make about them. Phylax supports your judgment. It doesn’t replace it.",
      ],
    },
    {
      id: "warnings-and-assumed-cutoffs",
      title: "Warnings and assumed cutoffs",
      body: ["A warning means Phylax found a conflict in the shifts you logged. No warning doesn’t mean there is no conflict."],
      items: [
        "Cancellation notes use the window you set. Platforms write and change their own policies, so treat a note as guidance, not a guarantee, and confirm the real deadline with the platform.",
        "Travel checks use the buffer you set. Real journeys can take longer.",
        "Alerts arrive by SMS, and by web push if you turn it on. Carriers, phone settings and network gaps can delay or block them.",
      ],
    },
    {
      id: "acceptable-use-and-account-security",
      title: "Acceptable use and account security",
      body: ["Use Phylax for your own shifts. Don’t log other people’s shifts, probe or disrupt the service, scrape it, or resell it."],
      items: [
        "Don’t enter patient information. Phylax doesn’t need it and isn’t built to hold it.",
        "Keep your sign-in methods to yourself, and tell the operator promptly if you think someone else has access. You’re responsible for activity on your account.",
        "Phylax never asks for your staffing-app logins. Don’t share them with anyone who says they’re from Phylax.",
      ],
    },
    {
      id: "availability-termination-and-disputes",
      title: "Availability, termination and disputes",
      body: [
        "We work to keep Phylax available but can’t promise uninterrupted service. Features, including the free tier’s limit on active tracked shifts, can change. When these terms change, the new version and its date appear at the top of this page.",
        "You can stop using Phylax and ask us to delete your account at any time. The operator may suspend or end an account that breaks these terms, with notice where that’s practical.",
        "To the extent the law allows, the operator isn’t liable for missed shifts, lost pay or other losses that follow from relying on a warning, the absence of one, or an alert.",
        "If something goes wrong, write to the contact address first. Most issues can be settled that way. These terms are governed by the laws of the jurisdiction listed above, and its courts decide disputes we can’t settle, unless the law where you live says otherwise.",
      ],
    },
  ],
};

const privacy: LegalDoc = {
  kind: "privacy",
  path: PRIVACY_URL,
  lines: ["Privacy", "notice"],
  description: "What Phylax collects, who helps deliver it, how long it’s kept, and the choices you have.",
  version: PRIVACY_VERSION,
  sections: [
    {
      id: "purpose-and-information-processed",
      title: "Purpose and information processed",
      body: ["We process information to check your shifts and to alert you. We don’t sell it or use it for advertising. Here is what we hold:"],
      items: [
        "Account: your display name and your sign-in details, such as an email address, a passkey, or the identifier Apple or Google gives us.",
        "Shifts: the platform, facility, address, date and times you log, plus your travel buffer and cancellation window.",
        "Alerts: your phone number, and a push subscription if you turn web push on.",
        "Agreement record: which terms and privacy versions you accepted, and when.",
        "Technical data: your IP address and browser details in security logs, and page-view counts.",
      ],
      after: ["We don’t collect patient information, and we never ask for your staffing-app logins."],
    },
    {
      id: "delivery-and-infrastructure-providers",
      title: "Delivery and infrastructure providers",
      body: ["A few providers help us run Phylax. Each handles only what it needs for its job, and only to serve us."],
      items: [
        "SMS delivery: your phone number and the text of each alert.",
        "Web push: your browser’s push service receives alert content when you turn push on.",
        "Email delivery: your email address and the sign-in messages we send.",
        "Hosting: Vercel serves the site and sees request data, such as your IP address.",
        "Analytics: Umami counts page views. It doesn’t track you across other sites.",
        "Sign in with Apple or Google: the provider you choose shares your name and email, under its own policy.",
      ],
    },
    {
      id: "retention-and-deletion",
      title: "Retention and deletion",
      body: ["We keep information only as long as we need it. These are the periods:"],
      retention: RETENTION,
      after: [
        "Delete a shift and it leaves your view at once and our systems within 30 days. Ask us to delete your account and we remove or anonymise the rest within 30 days, except records the law requires us to keep.",
      ],
    },
    {
      id: "your-choices-and-rights",
      title: "Your choices and rights",
      items: [
        "Stop SMS alerts at any time by replying STOP. Turn web push off in your browser settings.",
        "Ask for a copy of your information, a correction, or deletion. Write to the contact address and we’ll answer within 30 days.",
        "Depending on where you live, you may also object to or restrict processing, withdraw consent, or complain to your data protection regulator.",
        "Use your account page to see and change what you’ve logged.",
      ],
    },
    {
      id: "security-and-incidents",
      title: "Security and incidents",
      body: [
        "We encrypt information in transit and limit access to the people who need it to run the service. No system is perfectly secure, so we also keep what we hold to a minimum.",
        "If an incident puts your information at risk, we’ll investigate and contain it, then tell the people affected and the regulators the law requires, without undue delay. If you suspect a problem, write to the contact address.",
      ],
    },
  ],
};

export const LEGAL_DOCS: Record<DocKind, LegalDoc> = { terms, privacy };

/** Which document a URL path shows. Same tolerance as the router: case and a trailing slash don't matter. Anything else is the terms. */
export function docForPath(path: string): LegalDoc {
  return path.toLowerCase().replace(/\/+$/, "") === PRIVACY_URL ? privacy : terms;
}
