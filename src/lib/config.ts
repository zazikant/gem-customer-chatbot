/**
 * GEM Customer Chatbot — configuration.
 *
 * Business contact details (phone, email) are HARDCODED defaults —
 * not env vars — so the app works out of the box. They can still be
 * overridden via env vars if needed.
 *
 * Only the service credentials (OPENCODE_API_KEY, CHAT_BRAIN_URL,
 * CSV_CHAT_BASE) must come from env vars.
 */

export interface BusinessContact {
  phone: string; // display: "+91 7777016824"
  phoneRaw: string; // tel: link: "+917777016824"
  email: string; // display + mailto: link
}

export interface RequiredConfig {
  opencodeApiKey: string;
  opencodeModel: string;
  chatBrainUrl: string;
  csvChatBase: string;
  business: BusinessContact;
  inactivityMs: number;
}

// ─── Hardcoded business contact (not env vars) ────────────────
const DEFAULT_BUSINESS: BusinessContact = {
  phone: "+91 7777016824",
  phoneRaw: "+917777016824",
  email: "business@gemengserv.com",
};

let cached: RequiredConfig | null = null;

export function getConfig(): RequiredConfig {
  if (cached) return cached;

  const errors: string[] = [];
  const need = (key: string) => {
    const v = process.env[key];
    if (!v || v.trim().length === 0) errors.push(key);
    return v?.trim() ?? "";
  };

  // Only these three are required env vars.
  const opencodeApiKey = need("OPENCODE_API_KEY");
  const chatBrainUrl = need("CHAT_BRAIN_URL");
  const csvChatBase = need("CSV_CHAT_BASE");

  if (errors.length > 0) {
    throw new Error(
      `GEM Customer Chatbot: missing required environment variables: ` +
        errors.join(", ") +
        `. Set them in .env.local (dev) or Vercel → Project → Settings → Environment Variables (prod).`,
    );
  }

  // Business contact: hardcoded defaults, overridable via env vars.
  const business: BusinessContact = {
    phone: process.env.BUSINESS_PHONE?.trim() || DEFAULT_BUSINESS.phone,
    phoneRaw: process.env.BUSINESS_PHONE_RAW?.trim() || DEFAULT_BUSINESS.phoneRaw,
    email: process.env.BUSINESS_EMAIL?.trim() || DEFAULT_BUSINESS.email,
  };

  cached = {
    opencodeApiKey,
    opencodeModel: process.env.OPENCODE_MODEL?.trim() || "glm-5.1",
    chatBrainUrl,
    csvChatBase: csvChatBase.replace(/\/+$/, ""),
    business,
    inactivityMs: Number(process.env.CHAT_INACTIVITY_MS ?? 120_000),
  };
  return cached;
}
