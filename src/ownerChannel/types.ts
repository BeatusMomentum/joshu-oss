import type { ActionGuardGateMode } from "../actionGuard/policy.js";

export type OwnerChannelProvider = "sms";

export type OwnerChannelConfig = {
  provider: OwnerChannelProvider;
  gateMode?: ActionGuardGateMode;
  updatedAt: string;
};

export type OwnerChannelStatus = {
  linked: boolean;
  provider?: OwnerChannelProvider;
  /** Masked owner phone (last 4 digits). */
  ownerPhone?: string;
  gateMode?: ActionGuardGateMode;
};
