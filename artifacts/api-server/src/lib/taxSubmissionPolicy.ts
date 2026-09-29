/** Only a documented provider rejection may be retried, and only by explicit request. */
export function mayRetryTaxSubmission(status: string, retryRequested: boolean): boolean {
  return retryRequested && status === "rejected";
}