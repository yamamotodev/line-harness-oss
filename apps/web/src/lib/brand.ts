import { resolveBrandName } from '@line-crm/shared'

/**
 * Product display name for the admin UI.
 *
 * ⚠️ This is the BUILD-TIME half of the brand name. The Worker reads
 * `BRAND_NAME` from its `[vars]` at RUNTIME instead — see
 * packages/shared/src/brand.ts for why the two cannot be collapsed into one.
 *
 * Because this app is a Next.js static export, `NEXT_PUBLIC_BRAND_NAME` is
 * inlined into the bundle at build time. Changing the variable alone does
 * nothing: the admin app must be rebuilt and redeployed. Set it in the fork's
 * Actions Variables so CI picks it up.
 *
 * `process.env.NEXT_PUBLIC_BRAND_NAME` must be written out literally here for
 * Next.js to inline it — do not build the key dynamically.
 */
export const BRAND_NAME = resolveBrandName(process.env.NEXT_PUBLIC_BRAND_NAME)
