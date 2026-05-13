export type PolicyTrustResult = {
  trusted: boolean;
  policy_hash: string;
  reasons: string[];
  key_id: string;
  policy_version: string;
};
