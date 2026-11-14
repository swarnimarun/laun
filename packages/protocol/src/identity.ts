/** Public credential metadata; hashes and credential values never appear here. */
export interface PublicAgentKeyRecord {
  id: string;
  label: string;
  createdAt: string;
  /** Absent on legacy records; their stable owner remains key_<id>. */
  principalId?: string;
  revokedAt?: string;
}

/** The authenticated account survives rotation of individual credentials. */
export interface GatewayMe {
  principalId: string;
  admin: boolean;
  label?: string;
  keyId?: string;
}
