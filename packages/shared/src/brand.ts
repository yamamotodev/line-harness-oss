/**
 * Brand name — the single place the product's display name is defined.
 *
 * ⚠️ THE VALUE IS CONFIGURED IN TWO PLACES, NOT ONE.
 *
 *   1. Admin UI (apps/web, Next.js static export)
 *      → `NEXT_PUBLIC_BRAND_NAME`, read at BUILD time and inlined into the
 *        bundle. Changing it requires a rebuild + redeploy of the admin app.
 *
 *   2. Worker (apps/worker, Cloudflare Worker)
 *      → `BRAND_NAME` in the Worker's `[vars]`, read at RUNTIME.
 *
 * They cannot be collapsed into one because a static export inlines env vars
 * at build time while a Worker reads its bindings at runtime. If only one side
 * is changed, the admin UI and the customer-facing LINE messages will disagree.
 * If the two ever disagree, check BOTH places — and remember that (1) needs a
 * rebuild, so "I changed it but nothing happened" almost always means (1).
 *
 * Both sides fall back to DEFAULT_BRAND_NAME, so an unset variable degrades to
 * the correct name rather than to an empty string.
 *
 * Renaming away from "LINE ..." is not cosmetic: LY Corporation's branding
 * guidelines forbid product names of the form "LINE<X>" / "<X>LINE" / "LINE no
 * <X>" because users may mistake them for official LINE family services.
 */
export const DEFAULT_BRAND_NAME = 'HARK';

/**
 * Resolve the brand name from a raw env value, falling back to the default.
 * Whitespace-only values are treated as unset.
 */
export function resolveBrandName(raw?: string | null): string {
  const trimmed = raw?.trim();
  return trimmed ? trimmed : DEFAULT_BRAND_NAME;
}
