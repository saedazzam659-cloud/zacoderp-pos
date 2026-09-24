/** Contract approval routes persist "approved"; legacy "active" is not proof of approval. */
export function isPostableVoucherContractStatus(status: string | null | undefined): boolean {
  return status === "approved";
}