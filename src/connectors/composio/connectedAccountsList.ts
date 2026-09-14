/**
 * Composio connected-account listing with server-side ACTIVE filter.
 * Without `statuses: ['ACTIVE']`, INITIATED/EXPIRED OAuth junk can fill page 1
 * and make live connections look disconnected.
 */
import { composioClient } from "./client.js";

export type ComposioConnectedAccountRow = {
  id: string;
  status?: string;
  toolkit?: { slug?: string };
  appName?: string;
  appUniqueId?: string;
};

export type ListActiveConnectedAccountsParams = {
  userIds: string[];
  toolkitSlugs?: string[];
};

export async function listActiveConnectedAccounts(
  params: ListActiveConnectedAccountsParams,
): Promise<ComposioConnectedAccountRow[]> {
  const composio = composioClient();
  const listFn = (
    composio.connectedAccounts as {
      list: (
        params: ListActiveConnectedAccountsParams & { statuses?: string[] },
      ) => Promise<{ items?: ComposioConnectedAccountRow[] }>;
    }
  ).list;

  const result = await listFn({ ...params, statuses: ["ACTIVE"] });
  return result.items ?? [];
}
