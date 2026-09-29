export function proximityAudioVolume(
  distance: number,
  proximityEnterDistance: number,
  proximityExitDistance: number,
  isPrivateRoom = false,
): number {
  if (isPrivateRoom) return 1;

  const near = Math.max(0, proximityEnterDistance * 0.15);
  const far = proximityExitDistance;
  if (
    !Number.isFinite(distance) ||
    !Number.isFinite(near) ||
    !Number.isFinite(far) ||
    far <= near
  ) {
    return 1;
  }

  const progress = Math.max(0, Math.min(1, (distance - near) / (far - near)));
  const eased = progress * progress * (3 - 2 * progress);
  return 1 - eased * 0.88;
}
