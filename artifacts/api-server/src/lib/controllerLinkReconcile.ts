export type ControllerLinkReadbackObservation = {
  linkId: string;
  status: number;
  ok: boolean;
  controllerEpoch?: number;
  activeControllerId?: string;
  error?: string;
};

export type ControllerLinkReconcileDecision =
  | { kind: "reconcile"; winnerLinkId: string; deleteLinkIds: string[] }
  | { kind: "ambiguous"; winnerLinkIds: string[] }
  | { kind: "unproven"; unknownLinkIds: string[] }
  | { kind: "no_verified_pair" };

/**
 * Decide duplicate cleanup from target readbacks only. HTTP/network failures
 * are deliberately unknown; only the target's explicit link-not-found error
 * proves that a discarded link is absent.
 */
export function decideControllerLinkReconcile(
  observations: ControllerLinkReadbackObservation[],
  expectedEpoch: number,
  expectedActiveControllerId: string,
): ControllerLinkReconcileDecision {
  const winners = observations.filter(item =>
    item.status === 200 &&
    item.ok &&
    item.controllerEpoch === expectedEpoch &&
    item.activeControllerId === expectedActiveControllerId,
  );
  if (winners.length === 0) return { kind: "no_verified_pair" };
  if (winners.length > 1) return { kind: "ambiguous", winnerLinkIds: winners.map(item => item.linkId) };

  const winner = winners[0];
  const unknownLinkIds = observations
    .filter(item => item.linkId !== winner.linkId &&
      !(item.status === 403 && item.error === "controller_link_not_found"))
    .map(item => item.linkId);
  if (unknownLinkIds.length) return { kind: "unproven", unknownLinkIds };

  return {
    kind: "reconcile",
    winnerLinkId: winner.linkId,
    deleteLinkIds: observations.filter(item => item.linkId !== winner.linkId).map(item => item.linkId),
  };
}