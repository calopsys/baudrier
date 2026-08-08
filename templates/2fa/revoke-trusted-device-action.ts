"use server";

import { revokeTrustedDevice } from "~/lib/auth-2fa";

/**
 * Server Action wrapper so client components (e.g. IdleTimeout) can revoke
 * the trusted-device grant before signing out - `revokeTrustedDevice` itself
 * touches cookies()/the DB and can't be called directly from a client
 * component.
 */
export async function revokeTrustedDeviceAction(): Promise<void> {
  await revokeTrustedDevice();
}
