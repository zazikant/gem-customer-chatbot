/**
 * GET /api/config — returns non-secret config to the client.
 *
 * The browser needs the business contact (phone, email) to render
 * the fallback bubble. OPENCODE_API_KEY stays server-side.
 */
import { getConfig } from "@/lib/config";
import { NextResponse } from "next/server";

export const runtime = "nodejs";

export async function GET() {
  try {
    const { business } = getConfig();
    return NextResponse.json({ business });
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error).message },
      { status: 500 },
    );
  }
}
