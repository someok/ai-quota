import { z } from "zod";

import { readBoundedJson, request } from "../http.js";
import type { DeepSeekAccount, ProviderAdapter } from "../types.js";
import { failure, fetchOptions, success } from "./helpers.js";

const responseSchema = z.object({
  is_available: z.boolean(),
  balance_infos: z.array(
    z.object({
      currency: z.enum(["CNY", "USD"]),
      total_balance: z.string(),
      granted_balance: z.string(),
      topped_up_balance: z.string(),
    }),
  ),
});

export const deepSeekAdapter: ProviderAdapter<DeepSeekAccount> = {
  id: "deepseek",
  async collect(account, context) {
    const source = "https://api.deepseek.com/user/balance";
    try {
      const payload = await request(
        source,
        {
          method: "GET",
          headers: {
            Accept: "application/json",
            Authorization: `Bearer ${account.apiKey}`,
            "User-Agent": "ai-quota/0.1",
          },
        },
        async (response) => responseSchema.parse(await readBoundedJson(response)),
        fetchOptions(account, context),
      );
      return success(source, {
        available: payload.is_available,
        balances: payload.balance_infos.map((item) => ({
          currency: item.currency,
          total: item.total_balance,
          granted: item.granted_balance,
          toppedUp: item.topped_up_balance,
        })),
      });
    } catch (error) {
      return failure(source, error, account);
    }
  },
};
