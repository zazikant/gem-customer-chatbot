/**
 * GEM Customer Chatbot — configuration.
 *
 * All values come from environment variables (.env.local in dev,
 * Vercel Environment Variables in prod). `getConfig()` is a lazy
 * singleton — it reads env vars on first call and caches the result.
 *
 * Throws an aggregated error if any required var is missing.
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

let cached: RequiredConfig | null = null;

export function getConfig(): RequiredConfig {
  if (cached) return cached;

  const errors: string[] = [];
  const need = (key: string) => {
    const v = process.env[key];
    if (!v || v.trim().length === 0) errors.push(key);
    return v?.trim() ?? "";
  };

  const opencodeApiKey = need("OPENCODE_API_KEY");
  const chatBrainUrl = need("CHAT_BRAIN_URL");
  const csvChatBase = need("CSV_CHAT_BASE");
  const businessPhone = need("BUSINESS_PHONE");
  const businessPhoneRaw = need("BUSINESS_PHONE_RAW");
  const businessEmail = need("BUSINESS_EMAIL");

  if (errors.length > 0) {
    throw new Error(
      `GEM Customer Chatbot: missing required environment variables: ` +
        errors.join(", ") +
        `. Set them in .env.local (dev) or Vercel → Project → Settings → Environment Variables (prod).`,
    );
  }

  cached = {
    opencodeApiKey,
    opencodeModel: process.env.OPENCODE_MODEL?.trim() || "glm-5.1",
    chatBrainUrl,
    csvChatBase: csvChatBase.replace(/\/+$/, ""),
    business: {
      phone: businessPhone,
      phoneRaw: businessPhoneRaw,
      email: businessEmail,
    },
    inactivityMs: Number(process.env.CHAT_INACTIVITY_MS ?? 120_000),
  };
  return cached;
}
