/** The connector may have performed an external effect before its reply was lost. */
export class BrokerOutcomeUnknownError extends Error {
  constructor(options?: ErrorOptions) {
    super("Connector tool outcome is unknown after dispatch; stop and reconcile before retry", options);
    this.name = "BrokerOutcomeUnknownError";
  }
}
